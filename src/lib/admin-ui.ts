import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { buildArtifacts } from './build.ts';
import { loadGatewayConfig, parseGatewayConfig, saveGatewayConfig, type GatewayConfig } from './config.ts';

export interface AdminServerOptions {
  configPath: string;
  host: string;
  port: number;
  buildOutDir: string;
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

function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
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
      grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.9fr);
      gap: 18px;
      padding: 20px 24px 28px;
      align-items: start;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 16px 40px rgba(71, 44, 18, 0.08);
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
            <h2>Raw JSON</h2>
            <p>Exact config file representation.</p>
          </div>
          <button id="applyRawButton">Apply Raw JSON</button>
        </div>
        <textarea id="rawJson" spellcheck="false"></textarea>
      </section>
      <section class="panel">
        <h2>Notes</h2>
        <p>Disabled apps are ignored by generated nginx and deploy/build output.</p>
        <p>Disabled jobs are omitted from generated systemd units.</p>
        <p>Feature flags are for control-plane and app integration points that need simple runtime toggles.</p>
      </section>
    </aside>
  </main>
  <script>
    const state = { config: null };

    function setStatus(message, kind = 'ok') {
      const status = document.getElementById('status');
      status.textContent = message;
      status.className = kind === 'error' ? 'status-error' : 'status-ok';
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function syncRawJson() {
      document.getElementById('rawJson').value = JSON.stringify(state.config, null, 2);
    }

    function updateGatewayField(key, value) {
      state.config.gateway[key] = value;
      syncRawJson();
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
    }

    function render() {
      renderGateway();
      renderApps();
      renderJobs();
      renderFeatures();
      syncRawJson();
    }

    async function fetchConfig() {
      const response = await fetch('/api/config');
      if (!response.ok) {
        throw new Error(await response.text());
      }
      state.config = await response.json();
      render();
      setStatus('Config loaded');
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
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

    document.getElementById('reloadButton').addEventListener('click', async () => {
      try {
        await fetchConfig();
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
        setStatus(result.message || 'Saved and built');
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

    fetchConfig().catch((error) => setStatus(error.message, 'error'));
  </script>
</body>
</html>`;
}

async function loadRequestConfig(request: IncomingMessage): Promise<GatewayConfig> {
  const body = await readBody(request);
  return parseGatewayConfig(JSON.parse(body) as unknown);
}

export async function startAdminServer(options: AdminServerOptions): Promise<void> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/') {
        sendHtml(response, htmlPage());
        return;
      }

      if (request.method === 'GET' && request.url === '/api/config') {
        const config = await loadGatewayConfig(options.configPath);
        sendJson(response, 200, config);
        return;
      }

      if (request.method === 'POST' && request.url === '/api/validate') {
        const config = await loadRequestConfig(request);
        sendJson(response, 200, { message: 'Config is valid', config });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/config') {
        const config = await loadRequestConfig(request);
        await saveGatewayConfig(options.configPath, config);
        sendJson(response, 200, { message: `Saved ${options.configPath}`, config });
        return;
      }

      if (request.method === 'POST' && request.url === '/api/build') {
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

