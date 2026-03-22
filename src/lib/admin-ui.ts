import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { buildArtifacts } from './build.ts';
import { loadGatewayConfig, parseGatewayConfig, saveGatewayConfig, type GatewayConfig } from './config.ts';

export interface AdminServerOptions {
  configPath: string;
  host: string;
  port: number;
  buildOutDir: string;
}

interface RuntimeSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  host: string;
  port: number;
  configPath: string;
  buildOutDir: string;
  adminRoutePath: string;
  totalApps: number;
  enabledApps: number;
  totalJobs: number;
  enabledJobs: number;
  totalFeatures: number;
  enabledFeatures: number;
  generated: {
    buildDirectoryExists: boolean;
    nginxSiteExists: boolean;
    controlPlaneUnitExists: boolean;
  };
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(html);
}

function sendText(response: ServerResponse, statusCode: number, text: string): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('Request body too large'));
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function normalizeBasePath(pathValue: string | undefined): string {
  if (!pathValue || pathValue === '/') {
    return '/';
  }
  const withLeadingSlash = pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function getForwardedBasePath(request: IncomingMessage): string {
  const headerValue = request.headers['x-forwarded-prefix'];
  return normalizeBasePath(typeof headerValue === 'string' ? headerValue : undefined);
}

function createRuntimeSnapshot(
  config: GatewayConfig,
  options: AdminServerOptions,
  startedAtMs: number
): RuntimeSnapshot {
  const startedAt = new Date(startedAtMs).toISOString();
  const uptimeSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  const controlPlaneServicePath = join(
    options.buildOutDir,
    'systemd',
    'control-plane',
    config.gateway.adminUi.serviceName
  );

  return {
    startedAt,
    uptimeSeconds,
    host: options.host,
    port: options.port,
    configPath: options.configPath,
    buildOutDir: options.buildOutDir,
    adminRoutePath: config.gateway.adminUi.routePath,
    totalApps: config.apps.length,
    enabledApps: config.apps.filter((app) => app.enabled).length,
    totalJobs: config.scheduledJobs.length,
    enabledJobs: config.scheduledJobs.filter((job) => job.enabled).length,
    totalFeatures: config.features.length,
    enabledFeatures: config.features.filter((feature) => feature.enabled).length,
    generated: {
      buildDirectoryExists: existsSync(options.buildOutDir),
      nginxSiteExists: existsSync(join(options.buildOutDir, 'nginx', 'gateway-site.conf')),
      controlPlaneUnitExists: config.gateway.adminUi.enabled && existsSync(controlPlaneServicePath)
    }
  };
}

function htmlPage(basePath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="gateway-base-path" content="${basePath}" />
  <title>Gateway Config Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f3efe6;
      --panel: #fffdf9;
      --line: #d2c7b8;
      --text: #1f1b16;
      --muted: #6b6257;
      --accent: #9d4b22;
      --accent-soft: #f2d7c9;
      --danger: #8f2d2d;
      --ok: #1f6b43;
      --shadow: rgba(71, 44, 18, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      background: linear-gradient(180deg, #efe5d6 0%, var(--bg) 100%);
      color: var(--text);
    }
    header {
      padding: 24px 28px 12px;
      border-bottom: 1px solid rgba(31, 27, 22, 0.08);
    }
    h1, h2, h3 { margin: 0 0 10px; font-weight: 600; }
    p { margin: 0 0 10px; color: var(--muted); }
    main {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(330px, 0.9fr);
      gap: 18px;
      padding: 20px 24px 28px;
      align-items: start;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 16px 40px var(--shadow);
    }
    .toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    button {
      border: 1px solid var(--text);
      background: var(--panel);
      color: var(--text);
      border-radius: 999px;
      padding: 10px 14px;
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff8f1;
    }
    button.danger {
      border-color: var(--danger);
      color: var(--danger);
    }
    .section-list {
      display: grid;
      gap: 14px;
      margin-top: 16px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      background: #fffaf3;
    }
    .row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 14px;
      color: var(--muted);
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 12px;
      font: inherit;
      background: white;
      color: var(--text);
    }
    textarea {
      min-height: 96px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text);
    }
    .check input {
      width: auto;
    }
    .pill {
      display: inline-block;
      border-radius: 999px;
      padding: 4px 10px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      margin-bottom: 8px;
    }
    #status {
      min-height: 24px;
      font-size: 14px;
      margin-top: 12px;
    }
    .status-ok { color: var(--ok); }
    .status-error { color: var(--danger); }
    .aside-stack {
      display: grid;
      gap: 18px;
      position: sticky;
      top: 18px;
    }
    .split-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      background: #fffbf4;
    }
    .metric strong {
      display: block;
      font-size: 22px;
      margin-bottom: 4px;
    }
    .meta-list {
      display: grid;
      gap: 8px;
      margin-top: 12px;
      font-size: 14px;
      color: var(--muted);
      word-break: break-word;
    }
    .hint-list {
      display: grid;
      gap: 6px;
      color: var(--muted);
    }
    @media (max-width: 980px) {
      main { grid-template-columns: 1fr; }
      .aside-stack { position: static; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Gateway Config Admin</h1>
    <p>Edit the control-plane config, scheduled job timings, and feature flags. Save writes the JSON file used by deployment automation.</p>
    <div class="toolbar">
      <button id="reloadButton">Reload</button>
      <button id="validateButton">Validate</button>
      <button id="saveButton" class="primary">Save</button>
      <button id="buildButton">Save + Build</button>
      <button id="refreshRuntimeButton">Refresh Runtime</button>
    </div>
    <div id="status"></div>
  </header>
  <main>
    <section class="panel">
      <div class="split-actions">
        <div>
          <h2>Structured Editor</h2>
          <p>Updates are kept in-memory until you save.</p>
        </div>
      </div>

      <div class="card">
        <span class="pill">Gateway</span>
        <div class="row">
          <label>Server Names (comma separated)
            <input id="gatewayServerNames" />
          </label>
          <label>nginx Site Output
            <input id="nginxSiteOutputPath" />
          </label>
          <label>Upstream Directory
            <input id="upstreamDirectory" />
          </label>
          <label>nginx Reload Command
            <input id="nginxReloadCommand" />
          </label>
          <label>systemd Unit Directory
            <input id="systemdUnitDirectory" />
          </label>
          <label>systemd Reload Command
            <input id="systemdReloadCommand" />
          </label>
          <label>Enable Timer Command
            <input id="systemdEnableTimerCommand" />
          </label>
        </div>
      </div>

      <div class="card">
        <span class="pill">Admin UI</span>
        <div class="row">
          <label class="check"><input id="adminUiEnabled" type="checkbox" /> Enabled</label>
          <label>Bind Host
            <input id="adminUiHost" />
          </label>
          <label>Bind Port
            <input id="adminUiPort" type="number" />
          </label>
          <label>Gateway Route Path
            <input id="adminUiRoutePath" />
          </label>
          <label>Service Name
            <input id="adminUiServiceName" />
          </label>
          <label>Working Directory
            <input id="adminUiWorkingDirectory" />
          </label>
          <label>Config Path
            <input id="adminUiConfigPath" />
          </label>
          <label>Build Output Directory
            <input id="adminUiBuildOutDir" />
          </label>
          <label>Node Executable
            <input id="adminUiNodeExecutable" />
          </label>
          <label>User
            <input id="adminUiUser" />
          </label>
          <label>Group
            <input id="adminUiGroup" />
          </label>
        </div>
      </div>

      <div class="card">
        <div class="split-actions">
          <div>
            <span class="pill">gateway-api</span>
            <h3>Service Config</h3>
          </div>
          <button id="addGatewayApiEnvButton">Add Env Var</button>
        </div>
        <div class="row">
          <label class="check"><input id="gatewayApiProfileEnabled" type="checkbox" /> Enabled</label>
          <label>Managed App
            <select id="gatewayApiProfileAppId"></select>
          </label>
          <label>Env File Path
            <input id="gatewayApiProfileEnvFilePath" />
          </label>
        </div>
        <div id="gatewayApiEnvContainer" class="section-list"></div>
      </div>

      <div class="card">
        <div class="split-actions">
          <div>
            <span class="pill">gateway-chat-platform</span>
            <h3>Service Config</h3>
          </div>
          <div class="toolbar">
            <button id="addGatewayChatEnvButton">Add Env Var</button>
            <button id="addGatewayChatAgentButton">Add Agent</button>
          </div>
        </div>
        <div class="row">
          <label class="check"><input id="gatewayChatProfileEnabled" type="checkbox" /> Enabled</label>
          <label>Managed App
            <select id="gatewayChatProfileAppId"></select>
          </label>
          <label>Chat API Base URL
            <input id="gatewayChatProfileApiBaseUrl" />
          </label>
          <label>API Env File Path
            <input id="gatewayChatProfileEnvFilePath" />
          </label>
        </div>
        <div class="section-list">
          <div>
            <p>Environment</p>
            <div id="gatewayChatEnvContainer" class="section-list"></div>
          </div>
          <div>
            <p>Agents</p>
            <div id="gatewayChatAgentsContainer" class="section-list"></div>
          </div>
        </div>
      </div>

      <div class="section-list">
        <div class="card">
          <div class="split-actions">
            <div>
              <span class="pill">Apps</span>
              <h3>Managed Apps</h3>
            </div>
            <button id="addAppButton">Add App</button>
          </div>
          <div id="appsContainer" class="section-list"></div>
        </div>

        <div class="card">
          <div class="split-actions">
            <div>
              <span class="pill">Jobs</span>
              <h3>Scheduled Jobs</h3>
            </div>
            <button id="addJobButton">Add Job</button>
          </div>
          <div id="jobsContainer" class="section-list"></div>
        </div>

        <div class="card">
          <div class="split-actions">
            <div>
              <span class="pill">Features</span>
              <h3>Feature Flags</h3>
            </div>
            <button id="addFeatureButton">Add Feature</button>
          </div>
          <div id="featuresContainer" class="section-list"></div>
        </div>
      </div>
    </section>

    <aside class="aside-stack">
      <section class="panel">
        <div class="split-actions">
          <div>
            <h2>Runtime</h2>
            <p>Health and control-plane state from the live server process.</p>
          </div>
        </div>
        <div id="runtimeSummary" class="metric-grid"></div>
        <div id="runtimeMeta" class="meta-list"></div>
      </section>
      <section class="panel">
        <div class="split-actions">
          <div>
            <h2>Raw JSON</h2>
            <p>Exact config file representation.</p>
          </div>
          <button id="applyRawButton">Apply Raw JSON</button>
        </div>
        <textarea id="rawJson" spellcheck="false"></textarea>
      </section>
      <section class="panel">
        <h2>Notes</h2>
        <div class="hint-list">
          <p>Disabled apps are ignored by generated nginx and deploy/build output.</p>
          <p>Disabled jobs are omitted from generated systemd units.</p>
          <p>The admin UI route is rendered into nginx when Admin UI is enabled.</p>
          <p>The control-plane systemd unit is generated into <code>generated/systemd/control-plane/</code>.</p>
          <p>Service profiles generate env files and chat-agent sync payloads for the real gateway-managed apps.</p>
        </div>
      </section>
    </aside>
  </main>
  <script>
    const state = { config: null, runtime: null };
    const basePath = document.querySelector('meta[name="gateway-base-path"]').content || '/';

    function setStatus(message, kind = 'ok') {
      const status = document.getElementById('status');
      status.textContent = message;
      status.className = kind === 'error' ? 'status-error' : 'status-ok';
    }

    function joinBase(path) {
      if (basePath === '/') {
        return path.startsWith('/') ? path : \`/\${path}\`;
      }
      const normalizedBase = basePath.endsWith('/') ? basePath : \`\${basePath}/\`;
      const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
      return \`\${normalizedBase}\${normalizedPath}\`;
    }

    function syncRawJson() {
      document.getElementById('rawJson').value = JSON.stringify(state.config, null, 2);
    }

    function updateGatewayField(key, value) {
      state.config.gateway[key] = value;
      syncRawJson();
    }

    function updateAdminUiField(key, value) {
      state.config.gateway.adminUi[key] = value;
      syncRawJson();
    }

    function appOptions(selectedAppId) {
      return state.config.apps.map((app) => \`<option value="\${app.id}" \${app.id === selectedAppId ? 'selected' : ''}>\${app.id || '(unset app id)'}</option>\`).join('');
    }

    function renderEnvironmentList(containerId, environment, onRemove) {
      const container = document.getElementById(containerId);
      container.innerHTML = '';
      environment.forEach((entry, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${entry.key || 'new-env-var'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label>Key<input data-field="key" value="\${entry.key}" /></label>
            <label>Value<input data-field="value" value="\${entry.value}" /></label>
            <label class="check"><input type="checkbox" data-field="secret" \${entry.secret ? 'checked' : ''} /> Secret</label>
          </div>
          <label>Description<input data-field="description" value="\${entry.description || ''}" /></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => onRemove(index));
        element.querySelectorAll('input').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          input.addEventListener(isCheckbox ? 'change' : 'input', () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            entry[field] = isCheckbox ? input.checked : input.value;
            if (field === 'description' && !input.value) {
              delete entry.description;
            }
            syncRawJson();
          });
        });
        container.appendChild(element);
      });
    }

    function parseJsonField(value, fallback) {
      if (!value.trim()) {
        return fallback;
      }
      return JSON.parse(value);
    }

    function renderGatewayApiProfile() {
      const profile = state.config.serviceProfiles.gatewayApi;
      document.getElementById('gatewayApiProfileEnabled').checked = profile.enabled;
      document.getElementById('gatewayApiProfileAppId').innerHTML = appOptions(profile.appId);
      document.getElementById('gatewayApiProfileEnvFilePath').value = profile.envFilePath;
      renderEnvironmentList('gatewayApiEnvContainer', profile.environment, (index) => {
        profile.environment.splice(index, 1);
        renderGatewayApiProfile();
        syncRawJson();
      });
    }

    function renderGatewayChatPlatformProfile() {
      const profile = state.config.serviceProfiles.gatewayChatPlatform;
      document.getElementById('gatewayChatProfileEnabled').checked = profile.enabled;
      document.getElementById('gatewayChatProfileAppId').innerHTML = appOptions(profile.appId);
      document.getElementById('gatewayChatProfileApiBaseUrl').value = profile.apiBaseUrl;
      document.getElementById('gatewayChatProfileEnvFilePath').value = profile.apiEnvFilePath;
      renderEnvironmentList('gatewayChatEnvContainer', profile.environment, (index) => {
        profile.environment.splice(index, 1);
        renderGatewayChatPlatformProfile();
        syncRawJson();
      });

      const agentsContainer = document.getElementById('gatewayChatAgentsContainer');
      agentsContainer.innerHTML = '';
      profile.agents.forEach((agent, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${agent.name || agent.id || 'new-agent'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${agent.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Agent Id<input data-field="id" value="\${agent.id}" /></label>
            <label>Name<input data-field="name" value="\${agent.name}" /></label>
            <label>Icon<input data-field="icon" value="\${agent.icon}" /></label>
            <label>Color<input data-field="color" value="\${agent.color}" /></label>
            <label>Provider<input data-field="providerName" value="\${agent.providerName}" /></label>
            <label>Model<input data-field="model" value="\${agent.model}" /></label>
            <label>Cost Class
              <select data-field="costClass">
                <option value="free" \${agent.costClass === 'free' ? 'selected' : ''}>free</option>
                <option value="cheap" \${agent.costClass === 'cheap' ? 'selected' : ''}>cheap</option>
                <option value="premium" \${agent.costClass === 'premium' ? 'selected' : ''}>premium</option>
              </select>
            </label>
            <label>Temperature<input type="number" step="0.1" data-field="temperature" value="\${agent.temperature ?? ''}" /></label>
            <label>Max Tokens<input type="number" data-field="maxTokens" value="\${agent.maxTokens ?? ''}" /></label>
            <label class="check"><input type="checkbox" data-field="enableReasoning" \${agent.enableReasoning ? 'checked' : ''} /> Reasoning</label>
          </div>
          <label>System Prompt<textarea data-field="systemPrompt">\${agent.systemPrompt || ''}</textarea></label>
          <label>Feature Flags JSON<textarea data-field="featureFlags">\${JSON.stringify(agent.featureFlags || {}, null, 2)}</textarea></label>
          <label>Routing Policy JSON<textarea data-field="routingPolicy">\${JSON.stringify(agent.routingPolicy || {}, null, 2)}</textarea></label>
          <label>Endpoint Config JSON<textarea data-field="endpointConfig">\${JSON.stringify(agent.endpointConfig || {}, null, 2)}</textarea></label>
          <label>Context Sources JSON<textarea data-field="contextSources">\${JSON.stringify(agent.contextSources || [], null, 2)}</textarea></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          profile.agents.splice(index, 1);
          renderGatewayChatPlatformProfile();
          syncRawJson();
        });

        element.querySelectorAll('input, select, textarea').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            if (field === 'enabled' || field === 'enableReasoning') {
              agent[field] = input.checked;
            } else if (field === 'temperature' || field === 'maxTokens') {
              agent[field] = input.value ? Number(input.value) : undefined;
              if (!input.value) {
                delete agent[field];
              }
            } else if (field === 'featureFlags') {
              agent.featureFlags = parseJsonField(input.value, {});
            } else if (field === 'routingPolicy') {
              const value = parseJsonField(input.value, {});
              agent.routingPolicy = Object.keys(value).length > 0 ? value : undefined;
              if (!agent.routingPolicy) delete agent.routingPolicy;
            } else if (field === 'endpointConfig') {
              const value = parseJsonField(input.value, {});
              agent.endpointConfig = Object.keys(value).length > 0 ? value : undefined;
              if (!agent.endpointConfig) delete agent.endpointConfig;
            } else if (field === 'contextSources') {
              agent.contextSources = parseJsonField(input.value, []);
            } else if (field === 'systemPrompt') {
              agent.systemPrompt = input.value || undefined;
              if (!input.value) delete agent.systemPrompt;
            } else {
              agent[field] = input.value;
            }
            syncRawJson();
          });
        });

        agentsContainer.appendChild(element);
      });
    }

    function renderRuntime() {
      const runtimeSummary = document.getElementById('runtimeSummary');
      const runtimeMeta = document.getElementById('runtimeMeta');
      if (!state.runtime) {
        runtimeSummary.innerHTML = '';
        runtimeMeta.innerHTML = '<div>Runtime data not loaded</div>';
        return;
      }

      const runtime = state.runtime;
      runtimeSummary.innerHTML = [
        ['Enabled Apps', \`\${runtime.enabledApps}/\${runtime.totalApps}\`],
        ['Enabled Jobs', \`\${runtime.enabledJobs}/\${runtime.totalJobs}\`],
        ['Enabled Features', \`\${runtime.enabledFeatures}/\${runtime.totalFeatures}\`],
        ['Uptime (s)', String(runtime.uptimeSeconds)]
      ].map(([label, value]) => \`<div class="metric"><strong>\${value}</strong><span>\${label}</span></div>\`).join('');

      runtimeMeta.innerHTML = [
        \`<div><strong>Started:</strong> \${runtime.startedAt}</div>\`,
        \`<div><strong>Config:</strong> \${runtime.configPath}</div>\`,
        \`<div><strong>Build Dir:</strong> \${runtime.buildOutDir}</div>\`,
        \`<div><strong>Gateway Route:</strong> \${runtime.adminRoutePath}</div>\`,
        \`<div><strong>Build Output Present:</strong> \${runtime.generated.buildDirectoryExists ? 'yes' : 'no'}</div>\`,
        \`<div><strong>nginx Site Generated:</strong> \${runtime.generated.nginxSiteExists ? 'yes' : 'no'}</div>\`,
        \`<div><strong>Control-Plane Unit Generated:</strong> \${runtime.generated.controlPlaneUnitExists ? 'yes' : 'no'}</div>\`
      ].join('');
    }

    function renderApps() {
      const container = document.getElementById('appsContainer');
      container.innerHTML = '';
      state.config.apps.forEach((app, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div>
              <strong>\${app.id || 'new-app'}</strong>
            </div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${app.enabled ? 'checked' : ''} /> Enabled</label>
            <label>App Id<input data-field="id" value="\${app.id}" /></label>
            <label>Repo URL<input data-field="repoUrl" value="\${app.repoUrl}" /></label>
            <label>Default Revision<input data-field="defaultRevision" value="\${app.defaultRevision}" /></label>
            <label>Deploy Root<input data-field="deployRoot" value="\${app.deployRoot}" /></label>
            <label>Route Path<input data-field="routePath" value="\${app.routePath}" /></label>
            <label>Health Path<input data-field="healthPath" value="\${app.healthPath}" /></label>
            <label>Upstream Conf Path<input data-field="upstreamConfPath" value="\${app.upstreamConfPath}" /></label>
            <label>Blue Port<input type="number" data-slot="blue" data-field="port" value="\${app.slots.blue.port}" /></label>
            <label>Blue Start Command<input data-slot="blue" data-field="startCommand" value="\${app.slots.blue.startCommand}" /></label>
            <label>Blue Stop Command<input data-slot="blue" data-field="stopCommand" value="\${app.slots.blue.stopCommand}" /></label>
            <label>Green Port<input type="number" data-slot="green" data-field="port" value="\${app.slots.green.port}" /></label>
            <label>Green Start Command<input data-slot="green" data-field="startCommand" value="\${app.slots.green.startCommand}" /></label>
            <label>Green Stop Command<input data-slot="green" data-field="stopCommand" value="\${app.slots.green.stopCommand}" /></label>
          </div>
          <label>Build Commands (one per line)<textarea data-field="buildCommands">\${app.buildCommands.join('\\n')}</textarea></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          state.config.apps.splice(index, 1);
          render();
        });

        element.querySelectorAll('input, textarea').forEach((input) => {
          input.addEventListener('input', () => {
            const slot = input.dataset.slot;
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            if (slot) {
              state.config.apps[index].slots[slot][field] = field === 'port' ? Number(input.value) : input.value;
            } else if (field === 'enabled') {
              state.config.apps[index].enabled = input.checked;
            } else if (field === 'buildCommands') {
              state.config.apps[index].buildCommands = input.value.split('\\n').map((item) => item.trim()).filter(Boolean);
            } else {
              state.config.apps[index][field] = input.value;
            }
            syncRawJson();
          });
          if (input.type === 'checkbox') {
            input.addEventListener('change', () => {
              state.config.apps[index].enabled = input.checked;
              syncRawJson();
            });
          }
        });

        container.appendChild(element);
      });
    }

    function renderJobs() {
      const container = document.getElementById('jobsContainer');
      container.innerHTML = '';
      state.config.scheduledJobs.forEach((job, index) => {
        const appOptions = state.config.apps.map((app) => \`<option value="\${app.id}" \${app.id === job.appId ? 'selected' : ''}>\${app.id}</option>\`).join('');
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${job.id || 'new-job'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${job.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Job Id<input data-field="id" value="\${job.id}" /></label>
            <label>App<select data-field="appId">\${appOptions}</select></label>
            <label>Schedule<input data-field="schedule" value="\${job.schedule}" /></label>
            <label>User<input data-field="user" value="\${job.user}" /></label>
            <label>Group<input data-field="group" value="\${job.group || ''}" /></label>
            <label>Environment File<input data-field="environmentFile" value="\${job.environmentFile || ''}" /></label>
          </div>
          <label>Description<input data-field="description" value="\${job.description}" /></label>
          <label>Working Directory<input data-field="workingDirectory" value="\${job.workingDirectory}" /></label>
          <label>ExecStart<input data-field="execStart" value="\${job.execStart}" /></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          state.config.scheduledJobs.splice(index, 1);
          render();
        });

        element.querySelectorAll('input, select').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            state.config.scheduledJobs[index][field] = isCheckbox ? input.checked : input.value;
            if (field === 'group' || field === 'environmentFile') {
              if (!input.value) {
                delete state.config.scheduledJobs[index][field];
              }
            }
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderFeatures() {
      const container = document.getElementById('featuresContainer');
      container.innerHTML = '';
      state.config.features.forEach((feature, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${feature.id || 'new-feature'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${feature.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Feature Id<input data-field="id" value="\${feature.id}" /></label>
          </div>
          <label>Description<input data-field="description" value="\${feature.description}" /></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          state.config.features.splice(index, 1);
          render();
        });

        element.querySelectorAll('input').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          input.addEventListener(isCheckbox ? 'change' : 'input', () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            state.config.features[index][field] = isCheckbox ? input.checked : input.value;
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderGateway() {
      document.getElementById('gatewayServerNames').value = state.config.gateway.serverNames.join(', ');
      document.getElementById('nginxSiteOutputPath').value = state.config.gateway.nginxSiteOutputPath;
      document.getElementById('upstreamDirectory').value = state.config.gateway.upstreamDirectory;
      document.getElementById('nginxReloadCommand').value = state.config.gateway.nginxReloadCommand;
      document.getElementById('systemdUnitDirectory').value = state.config.gateway.systemdUnitDirectory;
      document.getElementById('systemdReloadCommand').value = state.config.gateway.systemdReloadCommand;
      document.getElementById('systemdEnableTimerCommand').value = state.config.gateway.systemdEnableTimerCommand;
      document.getElementById('adminUiEnabled').checked = state.config.gateway.adminUi.enabled;
      document.getElementById('adminUiHost').value = state.config.gateway.adminUi.host;
      document.getElementById('adminUiPort').value = String(state.config.gateway.adminUi.port);
      document.getElementById('adminUiRoutePath').value = state.config.gateway.adminUi.routePath;
      document.getElementById('adminUiServiceName').value = state.config.gateway.adminUi.serviceName;
      document.getElementById('adminUiWorkingDirectory').value = state.config.gateway.adminUi.workingDirectory;
      document.getElementById('adminUiConfigPath').value = state.config.gateway.adminUi.configPath;
      document.getElementById('adminUiBuildOutDir').value = state.config.gateway.adminUi.buildOutDir;
      document.getElementById('adminUiNodeExecutable').value = state.config.gateway.adminUi.nodeExecutable;
      document.getElementById('adminUiUser').value = state.config.gateway.adminUi.user;
      document.getElementById('adminUiGroup').value = state.config.gateway.adminUi.group || '';
    }

    function render() {
      renderGateway();
      renderGatewayApiProfile();
      renderGatewayChatPlatformProfile();
      renderApps();
      renderJobs();
      renderFeatures();
      renderRuntime();
      syncRawJson();
    }

    async function fetchConfig() {
      const response = await fetch(joinBase('/api/config'));
      if (!response.ok) {
        throw new Error(await response.text());
      }
      state.config = await response.json();
      render();
      setStatus('Config loaded');
    }

    async function fetchRuntime() {
      const response = await fetch(joinBase('/api/runtime'));
      if (!response.ok) {
        throw new Error(await response.text());
      }
      state.runtime = await response.json();
      renderRuntime();
    }

    async function postJson(url, body) {
      const response = await fetch(joinBase(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Request failed');
      }
      return data;
    }

    document.getElementById('gatewayServerNames').addEventListener('input', (event) => {
      updateGatewayField('serverNames', event.target.value.split(',').map((item) => item.trim()).filter(Boolean));
    });
    ['nginxSiteOutputPath', 'upstreamDirectory', 'nginxReloadCommand', 'systemdUnitDirectory', 'systemdReloadCommand', 'systemdEnableTimerCommand'].forEach((id) => {
      document.getElementById(id).addEventListener('input', (event) => updateGatewayField(id, event.target.value));
    });
    [
      ['adminUiEnabled', 'enabled', 'checkbox'],
      ['adminUiHost', 'host'],
      ['adminUiPort', 'port', 'number'],
      ['adminUiRoutePath', 'routePath'],
      ['adminUiServiceName', 'serviceName'],
      ['adminUiWorkingDirectory', 'workingDirectory'],
      ['adminUiConfigPath', 'configPath'],
      ['adminUiBuildOutDir', 'buildOutDir'],
      ['adminUiNodeExecutable', 'nodeExecutable'],
      ['adminUiUser', 'user'],
      ['adminUiGroup', 'group']
    ].forEach(([id, key, kind]) => {
      const element = document.getElementById(id);
      element.addEventListener(kind === 'checkbox' ? 'change' : 'input', (event) => {
        const target = event.target;
        if (kind === 'checkbox') {
          updateAdminUiField(key, target.checked);
          return;
        }
        if (kind === 'number') {
          updateAdminUiField(key, Number(target.value));
          return;
        }
        updateAdminUiField(key, target.value);
        if (key === 'group' && !target.value) {
          delete state.config.gateway.adminUi.group;
          syncRawJson();
        }
      });
    });
    [
      ['gatewayApiProfileEnabled', 'enabled', 'checkbox'],
      ['gatewayApiProfileAppId', 'appId'],
      ['gatewayApiProfileEnvFilePath', 'envFilePath'],
    ].forEach(([id, key, kind]) => {
      const element = document.getElementById(id);
      element.addEventListener(kind === 'checkbox' ? 'change' : 'input', (event) => {
        const target = event.target;
        state.config.serviceProfiles.gatewayApi[key] = kind === 'checkbox' ? target.checked : target.value;
        syncRawJson();
      });
    });
    [
      ['gatewayChatProfileEnabled', 'enabled', 'checkbox'],
      ['gatewayChatProfileAppId', 'appId'],
      ['gatewayChatProfileApiBaseUrl', 'apiBaseUrl'],
      ['gatewayChatProfileEnvFilePath', 'apiEnvFilePath'],
    ].forEach(([id, key, kind]) => {
      const element = document.getElementById(id);
      element.addEventListener(kind === 'checkbox' ? 'change' : 'input', (event) => {
        const target = event.target;
        state.config.serviceProfiles.gatewayChatPlatform[key] = kind === 'checkbox' ? target.checked : target.value;
        syncRawJson();
      });
    });

    document.getElementById('reloadButton').addEventListener('click', async () => {
      try {
        await fetchConfig();
        await fetchRuntime();
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    document.getElementById('validateButton').addEventListener('click', async () => {
      try {
        const result = await postJson('/api/validate', state.config);
        setStatus(result.message || 'Config is valid');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    document.getElementById('saveButton').addEventListener('click', async () => {
      try {
        const result = await postJson('/api/config', state.config);
        state.config = result.config;
        render();
        await fetchRuntime();
        setStatus(result.message || 'Saved');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    document.getElementById('buildButton').addEventListener('click', async () => {
      try {
        const result = await postJson('/api/build', state.config);
        state.config = result.config;
        render();
        await fetchRuntime();
        setStatus(result.message || 'Saved and built');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    document.getElementById('refreshRuntimeButton').addEventListener('click', async () => {
      try {
        await fetchRuntime();
        setStatus('Runtime refreshed');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    document.getElementById('applyRawButton').addEventListener('click', () => {
      try {
        state.config = JSON.parse(document.getElementById('rawJson').value);
        render();
        setStatus('Raw JSON applied');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    document.getElementById('addAppButton').addEventListener('click', () => {
      state.config.apps.push({
        id: '',
        enabled: true,
        repoUrl: '',
        defaultRevision: 'main',
        deployRoot: '',
        routePath: '/',
        healthPath: '/health',
        upstreamConfPath: '',
        buildCommands: [],
        slots: {
          blue: { port: 3001, startCommand: '', stopCommand: '' },
          green: { port: 3002, startCommand: '', stopCommand: '' }
        }
      });
      render();
    });

    document.getElementById('addJobButton').addEventListener('click', () => {
      state.config.scheduledJobs.push({
        id: '',
        appId: state.config.apps[0]?.id || '',
        enabled: true,
        description: '',
        schedule: '*:0/15',
        workingDirectory: '__CURRENT__',
        execStart: '',
        user: 'deploy'
      });
      render();
    });

    document.getElementById('addFeatureButton').addEventListener('click', () => {
      state.config.features.push({
        id: '',
        enabled: true,
        description: ''
      });
      render();
    });
    document.getElementById('addGatewayApiEnvButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.environment.push({
        key: '',
        value: '',
        secret: false
      });
      renderGatewayApiProfile();
      syncRawJson();
    });
    document.getElementById('addGatewayChatEnvButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayChatPlatform.environment.push({
        key: '',
        value: '',
        secret: false
      });
      renderGatewayChatPlatformProfile();
      syncRawJson();
    });
    document.getElementById('addGatewayChatAgentButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayChatPlatform.agents.push({
        id: '',
        name: '',
        icon: '🤖',
        color: '#6366f1',
        providerName: '',
        model: '',
        costClass: 'free',
        enabled: true,
        featureFlags: {},
        contextSources: []
      });
      renderGatewayChatPlatformProfile();
      syncRawJson();
    });

    Promise.all([fetchConfig(), fetchRuntime()])
      .catch((error) => setStatus(error.message, 'error'));
    setInterval(() => {
      fetchRuntime().catch(() => undefined);
    }, 15000);
  </script>
</body>
</html>`;
}

async function loadRequestConfig(request: IncomingMessage): Promise<GatewayConfig> {
  const body = await readBody(request);
  return parseGatewayConfig(JSON.parse(body) as unknown);
}

function getRequestPath(request: IncomingMessage): string {
  const requestUrl = request.url ?? '/';
  return requestUrl.split('?')[0] ?? '/';
}

export async function startAdminServer(options: AdminServerOptions): Promise<void> {
  const startedAtMs = Date.now();
  const server = createServer(async (request, response) => {
    try {
      const path = getRequestPath(request);
      const basePath = getForwardedBasePath(request);

      if (request.method === 'GET' && path === '/') {
        sendHtml(response, htmlPage(basePath));
        return;
      }

      if (request.method === 'GET' && path === '/healthz') {
        sendText(response, 200, 'ok\n');
        return;
      }

      if (request.method === 'GET' && path === '/api/config') {
        const config = await loadGatewayConfig(options.configPath);
        sendJson(response, 200, config);
        return;
      }

      if (request.method === 'GET' && path === '/api/runtime') {
        const config = await loadGatewayConfig(options.configPath);
        sendJson(response, 200, createRuntimeSnapshot(config, options, startedAtMs));
        return;
      }

      if (request.method === 'POST' && path === '/api/validate') {
        const config = await loadRequestConfig(request);
        sendJson(response, 200, { message: 'Config is valid', config });
        return;
      }

      if (request.method === 'POST' && path === '/api/config') {
        const config = await loadRequestConfig(request);
        await saveGatewayConfig(options.configPath, config);
        sendJson(response, 200, { message: `Saved ${options.configPath}`, config });
        return;
      }

      if (request.method === 'POST' && path === '/api/build') {
        const config = await loadRequestConfig(request);
        await saveGatewayConfig(options.configPath, config);
        await buildArtifacts(config, options.buildOutDir);
        sendJson(response, 200, {
          message: `Saved ${options.configPath} and rendered artifacts into ${options.buildOutDir}`,
          config
        });
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, () => {
      console.log(`Gateway admin UI listening on http://${options.host}:${options.port}`);
      resolve();
    });
  });
}
