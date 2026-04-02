import { type GatewayConfig, getWorkerNode } from './config.ts';

export interface ManagedPiProxyFile {
  relativePath: string;
  contents: string;
}

function jsonStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildRegistryUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function renderPiProxyPackageJson(): string {
  return jsonStringify({
    name: 'gateway-bedrock-lan-proxy',
    version: '0.1.0',
    private: true,
    type: 'module'
  });
}

function renderPiProxyRuntimeConfig(config: GatewayConfig): string {
  const profile = config.serviceProfiles.piProxy;
  return jsonStringify({
    listenHost: profile.listenHost,
    listenPort: profile.listenPort,
    pollIntervalSeconds: profile.pollIntervalSeconds,
    registryUrl: buildRegistryUrl(profile.registryBaseUrl, profile.registryPath),
    stateFilePath: `${profile.installRoot}/proxy-state.json`
  });
}

function renderPiProxySystemdUnit(config: GatewayConfig): string {
  const profile = config.serviceProfiles.piProxy;
  const node = getWorkerNode(config, profile.nodeId);
  const userLine = profile.serviceUser ? `User=${profile.serviceUser}\n` : '';
  const groupLine = profile.serviceGroup ? `Group=${profile.serviceGroup}\n` : '';

  return [
    '[Unit]',
    `Description=${profile.description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    userLine.trimEnd(),
    groupLine.trimEnd(),
    `WorkingDirectory=${profile.installRoot}`,
    `ExecStart=${node.nodeCommand} ${profile.installRoot}/proxy.mjs ${profile.installRoot}/proxy-config.json`,
    'Restart=always',
    'RestartSec=5',
    'Environment=NODE_ENV=production',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    ''
  ].filter((line) => line.length > 0).join('\n') + '\n';
}

function renderPiProxyScript(): string {
  return `import dgram from 'node:dgram';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const configPath = process.argv[2] || './proxy-config.json';
const activeServers = new Map();
let runtimeConfig = null;
const SESSION_IDLE_MS = 120000;
const SESSION_PRUNE_INTERVAL_MS = 30000;

async function loadConfig() {
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.registryUrl || !parsed.listenHost || !parsed.listenPort) {
    throw new Error('proxy-config.json is missing required fields');
  }
  runtimeConfig = parsed;
  return parsed;
}

async function writeState(state) {
  if (!runtimeConfig?.stateFilePath) {
    return;
  }
  await mkdir(dirname(runtimeConfig.stateFilePath), { recursive: true });
  await writeFile(runtimeConfig.stateFilePath, JSON.stringify(state, null, 2) + '\\n', 'utf8');
}

function normalizeEntry(entry, index) {
  return {
    key: entry.workloadId || entry.serverName || 'server-' + index,
    workloadId: entry.workloadId || 'server-' + index,
    serverName: entry.serverName || 'Bedrock Server',
    worldName: entry.worldName || 'LAN Gateway',
    motd: entry.motd || entry.serverName || 'Bedrock Server',
    levelName: entry.levelName || entry.worldName || 'LAN Gateway',
    targetHost: entry.targetHost,
    targetPort: Number(entry.targetPort),
    localPort: Number(runtimeConfig.listenPort) + index
  };
}

function specsDiffer(left, right) {
  return !left || !right || [
    'serverName',
    'worldName',
    'motd',
    'levelName',
    'targetHost',
    'targetPort',
    'localPort'
  ].some((field) => left[field] !== right[field]);
}

function closeProxyServer(record) {
  if (!record) {
    return;
  }
  if (record.pruneTimer) {
    try {
      clearInterval(record.pruneTimer);
    } catch (error) {
      console.error('[pi-proxy] failed to clear prune timer', error);
    }
  }
  for (const session of record.sessions?.values?.() || []) {
    if (session.upstreamSocket && typeof session.upstreamSocket.close === 'function') {
      try {
        session.upstreamSocket.close();
      } catch (error) {
        console.error('[pi-proxy] failed to close upstream socket', error);
      }
    }
  }
  if (record.serverSocket && typeof record.serverSocket.close === 'function') {
    try {
      record.serverSocket.close();
    } catch (error) {
      console.error('[pi-proxy] failed to close relay socket', error);
    }
  }
}

function formatError(error) {
  if (!error) {
    return 'unknown error';
  }
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  if (typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

function formatEndpoint(host, port) {
  return String(host) + ':' + String(port);
}

function createSessionKey(host, port) {
  return formatEndpoint(host, port);
}

function summarizeSession(session) {
  return {
    client: formatEndpoint(session.clientAddress, session.clientPort),
    upstreamLocalPort: session.upstreamLocalPort,
    createdAt: session.createdAt,
    lastClientPacketAt: session.lastClientPacketAt,
    lastTargetPacketAt: session.lastTargetPacketAt,
    clientPackets: session.clientPackets,
    targetPackets: session.targetPackets,
    clientBytes: session.clientBytes,
    targetBytes: session.targetBytes
  };
}

function writeRuntimeStateFromRecords(lastError = null) {
  return writeState({
    updatedAt: new Date().toISOString(),
    registryUrl: runtimeConfig.registryUrl,
    mode: 'udp-relay',
    lastError,
    servers: Array.from(activeServers.values()).map((record) => ({
      workloadId: record.spec.workloadId,
      serverName: record.spec.serverName,
      worldName: record.spec.worldName,
      motd: record.spec.motd,
      levelName: record.spec.levelName,
      targetHost: record.spec.targetHost,
      targetPort: record.spec.targetPort,
      localPort: record.spec.localPort,
      sessionCount: record.sessions.size,
      sessions: Array.from(record.sessions.values()).map((session) => summarizeSession(session))
    }))
  });
}

function pruneIdleSessions(record) {
  const now = Date.now();
  for (const [key, session] of record.sessions.entries()) {
    if (now - session.lastActivityMs < SESSION_IDLE_MS) {
      continue;
    }
    console.log('[pi-proxy] pruning idle session ' + key + ' for ' + record.spec.workloadId);
    try {
      session.upstreamSocket.close();
    } catch (error) {
      console.error('[pi-proxy] failed to close idle session ' + key + ': ' + formatError(error));
    }
    record.sessions.delete(key);
  }
  void writeRuntimeStateFromRecords(null);
}

function createRelaySession(record, clientAddress, clientPort) {
  const key = createSessionKey(clientAddress, clientPort);
  const upstreamSocket = dgram.createSocket('udp4');
  const session = {
    key,
    clientAddress,
    clientPort,
    upstreamSocket,
    upstreamLocalPort: null,
    createdAt: new Date().toISOString(),
    lastClientPacketAt: null,
    lastTargetPacketAt: null,
    lastActivityMs: Date.now(),
    clientPackets: 0,
    targetPackets: 0,
    clientBytes: 0,
    targetBytes: 0
  };

  upstreamSocket.on('listening', () => {
    const address = upstreamSocket.address();
    session.upstreamLocalPort = address && typeof address === 'object' && 'port' in address ? Number(address.port) : null;
    console.log('[pi-proxy] relay upstream listening for ' + record.spec.workloadId + ' client ' + key + ' on local port ' + String(session.upstreamLocalPort));
  });

  upstreamSocket.on('message', (message, remote) => {
    session.lastTargetPacketAt = new Date().toISOString();
    session.lastActivityMs = Date.now();
    session.targetPackets += 1;
    session.targetBytes += message.length;
    record.serverSocket.send(message, session.clientPort, session.clientAddress, (error) => {
      if (error) {
        console.error('[pi-proxy] failed to relay upstream response to ' + key + ': ' + formatError(error));
      }
    });
  });

  upstreamSocket.on('error', (error) => {
    console.error('[pi-proxy] upstream socket error for ' + record.spec.workloadId + ' client ' + key + ': ' + formatError(error));
  });

  upstreamSocket.on('close', () => {
    console.log('[pi-proxy] upstream socket closed for ' + record.spec.workloadId + ' client ' + key);
  });

  upstreamSocket.bind(0);
  record.sessions.set(key, session);
  console.log('[pi-proxy] created relay session for ' + record.spec.workloadId + ' client ' + key + ' -> ' + formatEndpoint(record.spec.targetHost, record.spec.targetPort));
  void writeRuntimeStateFromRecords(null);
  return session;
}

function createProxyServer(spec) {
  const serverSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const record = {
    spec,
    serverSocket,
    sessions: new Map(),
    pruneTimer: null
  };

  serverSocket.on('listening', () => {
    serverSocket.setBroadcast(true);
    const address = serverSocket.address();
    const label = address && typeof address === 'object'
      ? formatEndpoint(address.address, address.port)
      : formatEndpoint(runtimeConfig.listenHost, spec.localPort);
    console.log('[pi-proxy] listening on ' + label + ' for ' + spec.workloadId + ' -> ' + formatEndpoint(spec.targetHost, spec.targetPort));
  });

  serverSocket.on('message', (message, remote) => {
    const key = createSessionKey(remote.address, remote.port);
    let session = record.sessions.get(key);
    if (!session) {
      session = createRelaySession(record, remote.address, remote.port);
    }

    session.lastClientPacketAt = new Date().toISOString();
    session.lastActivityMs = Date.now();
    session.clientPackets += 1;
    session.clientBytes += message.length;
    session.upstreamSocket.send(message, spec.targetPort, spec.targetHost, (error) => {
      if (error) {
        console.error('[pi-proxy] failed to relay client packet for ' + spec.workloadId + ' client ' + key + ': ' + formatError(error));
      }
    });
  });

  serverSocket.on('error', (error) => {
    console.error('[pi-proxy] relay socket error for ' + spec.workloadId + ': ' + formatError(error));
  });

  serverSocket.on('close', () => {
    console.log('[pi-proxy] relay socket closed for ' + spec.workloadId + ' on ' + spec.localPort);
  });

  serverSocket.bind(spec.localPort, runtimeConfig.listenHost);
  record.pruneTimer = setInterval(() => {
    pruneIdleSessions(record);
  }, SESSION_PRUNE_INTERVAL_MS);
  return record;
}

async function fetchRegistryServers() {
  const response = await fetch(runtimeConfig.registryUrl, {
    headers: {
      accept: 'application/json'
    }
  });
  if (!response.ok) {
    throw new Error('Registry request failed: ' + response.status + ' ' + response.statusText);
  }
  const payload = await response.json();
  const servers = Array.isArray(payload.servers) ? payload.servers : [];
  return servers
    .filter((entry) => entry && entry.targetHost && entry.targetPort)
    .sort((left, right) => String(left.workloadId || '').localeCompare(String(right.workloadId || '')));
}

async function reconcile() {
  const registryServers = await fetchRegistryServers();
  const nextSpecs = registryServers.map((entry, index) => normalizeEntry(entry, index));
  const nextKeys = new Set(nextSpecs.map((entry) => entry.key));

  for (const [key, record] of activeServers.entries()) {
    if (!nextKeys.has(key)) {
      console.log('[pi-proxy] removing proxy ' + key);
      closeProxyServer(record);
      activeServers.delete(key);
    }
  }

  for (const spec of nextSpecs) {
    const current = activeServers.get(spec.key);
    if (!current || specsDiffer(current.spec, spec)) {
      if (current) {
        console.log('[pi-proxy] reloading proxy ' + spec.key);
        closeProxyServer(current);
      } else {
        console.log('[pi-proxy] creating proxy ' + spec.key);
      }
      activeServers.set(spec.key, createProxyServer(spec));
    }
  }

  await writeRuntimeStateFromRecords(null);
}

async function main() {
  await loadConfig();

  const loop = async () => {
    try {
      await reconcile();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[pi-proxy] reconcile failed', error);
      await writeRuntimeStateFromRecords(message);
    }
  };

  await loop();
  setInterval(() => {
    void loop();
  }, Math.max(5, Number(runtimeConfig.pollIntervalSeconds) || 30) * 1000);
}

main().catch((error) => {
  console.error('[pi-proxy] fatal error', error);
  process.exitCode = 1;
});
`;
}

export function renderManagedPiProxyFiles(config: GatewayConfig): ManagedPiProxyFile[] {
  return [
    {
      relativePath: 'package.json',
      contents: renderPiProxyPackageJson()
    },
    {
      relativePath: 'proxy-config.json',
      contents: renderPiProxyRuntimeConfig(config)
    },
    {
      relativePath: 'proxy.mjs',
      contents: renderPiProxyScript()
    },
    {
      relativePath: `systemd/${config.serviceProfiles.piProxy.systemdUnitName}`,
      contents: renderPiProxySystemdUnit(config)
    }
  ];
}
