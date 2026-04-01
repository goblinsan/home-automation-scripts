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
    type: 'module',
    dependencies: {
      'bedrock-protocol': 'latest'
    }
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
  return `import bedrock from 'bedrock-protocol';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const configPath = process.argv[2] || './proxy-config.json';
const activeServers = new Map();
let runtimeConfig = null;

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
  if (!record?.server) {
    return;
  }
  if (typeof record.server.close === 'function') {
    try {
      record.server.close();
    } catch (error) {
      console.error('[pi-proxy] failed to close server', error);
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

function formatClientAddress(client) {
  const address = client?.socket?.address;
  if (typeof address !== 'function') {
    return 'unknown';
  }
  try {
    const value = address.call(client.socket);
    if (value && typeof value === 'object' && 'address' in value && 'port' in value) {
      return String(value.address) + ':' + String(value.port);
    }
  } catch (error) {
    return 'unavailable (' + formatError(error) + ')';
  }
  return 'unknown';
}

function attachClientDebugLogging(client, spec) {
  let packetLogCount = 0;
  const maxPacketLogs = 12;

  client.on('packet', (_packet, metadata) => {
    if (packetLogCount >= maxPacketLogs) {
      return;
    }
    const packetName = metadata && typeof metadata === 'object' && 'name' in metadata
      ? String(metadata.name)
      : 'unknown';
    packetLogCount += 1;
    console.log('[pi-proxy] packet ' + packetName + ' for ' + spec.workloadId + ' from ' + formatClientAddress(client));
  });

  client.on('join', () => {
    console.log('[pi-proxy] join event for ' + spec.workloadId + '; transferring to ' + spec.targetHost + ':' + spec.targetPort);
    client.transfer({
      host: spec.targetHost,
      port: spec.targetPort
    });
    console.log('[pi-proxy] transfer requested for ' + spec.workloadId + ' to ' + spec.targetHost + ':' + spec.targetPort);
  });

  client.on('disconnect', (reason) => {
    console.log('[pi-proxy] disconnect event for ' + spec.workloadId + ': ' + formatError(reason));
  });

  client.on('close', (reason) => {
    console.log('[pi-proxy] client close for ' + spec.workloadId + ': ' + formatError(reason));
  });

  client.on('error', (error) => {
    console.error('[pi-proxy] client error for ' + spec.workloadId + ': ' + formatError(error));
  });
}

function createProxyServer(spec) {
  const server = bedrock.createServer({
    host: runtimeConfig.listenHost,
    port: spec.localPort,
    offline: true,
    raknetBackend: 'jsp-raknet',
    motd: {
      motd: spec.motd,
      levelName: spec.levelName
    }
  });

  server.on('listening', () => {
    console.log('[pi-proxy] listening on ' + runtimeConfig.listenHost + ':' + spec.localPort + ' for ' + spec.workloadId + ' -> ' + spec.targetHost + ':' + spec.targetPort);
  });

  server.on('connect', (client) => {
    console.log('[pi-proxy] player connected to ' + spec.workloadId + ' via ' + spec.localPort + ' from ' + formatClientAddress(client));
    attachClientDebugLogging(client, spec);
  });

  server.on('session', () => {
    console.log('[pi-proxy] session event for ' + spec.workloadId + ' on ' + spec.localPort);
  });

  server.on('close', () => {
    console.log('[pi-proxy] server closed for ' + spec.workloadId + ' on ' + spec.localPort);
  });

  server.on('error', (error) => {
    console.error('[pi-proxy] server error for ' + spec.workloadId + ': ' + formatError(error));
  });

  return server;
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

  await writeState({
    updatedAt: new Date().toISOString(),
    registryUrl: runtimeConfig.registryUrl,
    lastError: null,
    servers: nextSpecs.map((spec) => ({
      workloadId: spec.workloadId,
      serverName: spec.serverName,
      worldName: spec.worldName,
      motd: spec.motd,
      levelName: spec.levelName,
      targetHost: spec.targetHost,
      targetPort: spec.targetPort,
      localPort: spec.localPort
    }))
  });
  console.log('[pi-proxy] wrote state for ' + nextSpecs.length + ' world(s)');

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
      activeServers.set(spec.key, {
        spec,
        server: createProxyServer(spec)
      });
    }
  }
}

async function main() {
  await loadConfig();

  const loop = async () => {
    try {
      await reconcile();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[pi-proxy] reconcile failed', error);
      await writeState({
        updatedAt: new Date().toISOString(),
        registryUrl: runtimeConfig.registryUrl,
        lastError: message,
        servers: Array.from(activeServers.values()).map((record) => ({
          workloadId: record.spec.workloadId,
          serverName: record.spec.serverName,
          worldName: record.spec.worldName,
          motd: record.spec.motd,
          levelName: record.spec.levelName,
          targetHost: record.spec.targetHost,
          targetPort: record.spec.targetPort,
          localPort: record.spec.localPort
        }))
      });
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
