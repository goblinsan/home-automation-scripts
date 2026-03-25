import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { buildArtifacts } from './build.ts';
import { loadGatewayConfig, parseGatewayConfig, saveGatewayConfig, type GatewayConfig } from './config.ts';
import { runServiceProfileAgent, syncServiceProfileRuntime, type AgentRunPayload, type AgentRunResult } from './deploy.ts';
import { DEFAULT_WORKFLOW_SEED_PATH, importWorkflowSeed } from './workflows.ts';

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

interface WorkflowTarget {
  type: string;
  ref: string;
}

interface WorkflowRetryPolicy {
  maxAttempts?: number;
  backoffSeconds?: number;
}

interface WorkflowRecord {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  sleepUntil: string | null;
  target: WorkflowTarget;
  input?: Record<string, unknown>;
  secrets?: string[];
  timeoutSeconds?: number;
  retryPolicy?: WorkflowRetryPolicy;
  lastRunAt: string | null;
  lastStatus: 'idle' | 'running' | 'success' | 'failed' | 'sleeping';
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentRunUiState {
  agentId: string;
  prompt: string;
  contextJson: string;
  deliveryJson: string;
  workflowSeedPath: string;
  result: AgentRunResult | null;
}

interface TtsStatusSnapshot {
  healthStatus: number | null;
  voices: unknown;
}

interface TtsVoiceRecord {
  id: string;
  name?: string;
  description?: string;
  source?: string;
}

interface ChatProviderStatusRecord {
  name: string;
  status: 'ok' | 'error' | 'unconfigured';
  latencyMs?: number;
  error?: string;
}

interface ChatProviderModelRecord {
  id: string;
  name?: string;
  description?: string;
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

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
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

function readBodyBuffer(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 25_000_000) {
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
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
      --bg: #edf2f2;
      --panel: #ffffff;
      --line: #d8e2e3;
      --text: #1e2740;
      --muted: #6b7890;
      --accent: #0c788e;
      --accent-soft: rgba(12, 120, 142, 0.12);
      --sidebar: #25544b;
      --sidebar-soft: rgba(255, 255, 255, 0.14);
      --highlight: #f5b100;
      --danger: #9b3131;
      --ok: #1f6b43;
      --shadow: rgba(30, 39, 64, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      background: linear-gradient(180deg, #f4f6f7 0%, var(--bg) 100%);
      color: var(--text);
    }
    header {
      padding: 24px 28px 12px;
      border-bottom: 1px solid rgba(30, 39, 64, 0.08);
      background: rgba(255, 255, 255, 0.72);
      backdrop-filter: blur(10px);
    }
    h1, h2, h3 { margin: 0 0 10px; font-weight: 600; }
    p { margin: 0 0 10px; color: var(--muted); }
    main {
      display: grid;
      grid-template-columns: 290px minmax(0, 1fr);
      gap: 20px;
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
    .editor-panel {
      order: 2;
    }
    .toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    button {
      border: 1px solid rgba(30, 39, 64, 0.12);
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
      color: #fff;
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
      background: #fbfdfd;
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
      order: 1;
      display: grid;
      gap: 18px;
      position: sticky;
      top: 18px;
    }
    .nav-card {
      background: linear-gradient(180deg, var(--sidebar) 0%, #214c44 100%);
      color: #f3f7f5;
      border-color: rgba(255, 255, 255, 0.08);
      min-height: 320px;
    }
    .nav-card p,
    .nav-card h2 {
      color: inherit;
    }
    .nav-card p {
      opacity: 0.76;
    }
    .tab-nav {
      display: grid;
      gap: 10px;
      margin-top: 22px;
    }
    .tab-button {
      width: 100%;
      text-align: left;
      border: 0;
      background: transparent;
      color: rgba(255, 255, 255, 0.82);
      border-radius: 16px;
      padding: 14px 16px;
      font: inherit;
      font-size: 16px;
    }
    .tab-button:hover,
    .tab-button.active {
      background: var(--sidebar-soft);
      color: white;
    }
    .tab-panel[hidden] {
      display: none !important;
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
      background: white;
      position: relative;
      overflow: hidden;
    }
    .metric::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 5px;
      background: linear-gradient(90deg, #1f5f56 0%, var(--accent) 100%);
    }
    .metric:nth-child(3n)::before {
      background: linear-gradient(90deg, var(--highlight) 0%, #ffce45 100%);
    }
    .metric strong {
      display: block;
      font-size: 30px;
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
      .editor-panel { order: 2; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Gateway Config Admin</h1>
    <p>Configure gateway services, agents, workflows, and deployment state from one control surface.</p>
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
    <section class="panel editor-panel">
      <div class="split-actions">
        <div>
          <h2>Config Workspace</h2>
          <p>Use the left navigation to focus one config area at a time. Changes stay in memory until you save.</p>
        </div>
      </div>

      <div class="tab-panel" data-tab-panel="gateway">
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

      </div>

      <div class="tab-panel" data-tab-panel="services" hidden>
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
          <label>Workflow API Base URL
            <input id="gatewayApiProfileApiBaseUrl" />
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
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">TTS</span>
                <h4>Local TTS Service</h4>
              </div>
              <div class="toolbar">
                <button id="checkTtsButton">Check TTS</button>
                <button id="reloadTtsVoicesButton">Reload Voices</button>
              </div>
            </div>
            <div class="row">
              <label class="check"><input id="gatewayChatTtsEnabled" type="checkbox" /> Enabled</label>
              <label>TTS Base URL
                <input id="gatewayChatTtsBaseUrl" />
              </label>
              <label>Default Voice
                <input id="gatewayChatTtsDefaultVoice" />
              </label>
              <label>Generate Path
                <input id="gatewayChatTtsGeneratePath" />
              </label>
              <label>Stream Path
                <input id="gatewayChatTtsStreamPath" />
              </label>
              <label>Voices Path
                <input id="gatewayChatTtsVoicesPath" />
              </label>
              <label>Health Path
                <input id="gatewayChatTtsHealthPath" />
              </label>
            </div>
            <div id="ttsStatus" class="meta-list"></div>
            <div class="split-actions">
              <div>
                <p>Voices</p>
              </div>
            </div>
            <div id="ttsVoicesContainer" class="section-list"></div>
            <div class="card">
              <div class="split-actions">
                <div>
                  <span class="pill">Create Voice</span>
                  <h4>New Voice</h4>
                </div>
                <button id="createTtsVoiceButton" class="primary">Create Voice</button>
              </div>
              <div class="row">
                <label>Name
                  <input id="ttsCreateVoiceName" />
                </label>
                <label>Description
                  <input id="ttsCreateVoiceDescription" />
                </label>
                <label>Source
                  <input id="ttsCreateVoiceSource" value="recorded" />
                </label>
                <label>Reference Audio
                  <input id="ttsCreateVoiceFile" type="file" accept="audio/*,.wav,.mp3,.m4a" />
                </label>
              </div>
              <label>Transcript
                <textarea id="ttsCreateVoiceTranscript" placeholder="Required by local-tts-service for voice creation. Provide the spoken text from the reference audio."></textarea>
              </label>
            </div>
          </div>
        </div>
      </div>

      </div>

      <div class="tab-panel" data-tab-panel="agents" hidden>
      <div class="card">
        <div class="split-actions">
          <div>
            <span class="pill">Agents</span>
            <h3>Configured Chat Agents</h3>
            <p>Only these agents are synced into <code>gateway-chat-platform</code>.</p>
          </div>
          <div class="toolbar">
            <button id="addGatewayChatAgentButton">Add Agent</button>
            <button id="syncGatewayChatAgentsButtonSecondary">Sync Agents</button>
          </div>
        </div>
        <div id="gatewayChatAgentsContainer" class="section-list"></div>
      </div>
      </div>

      <div class="tab-panel" data-tab-panel="workflows" hidden>
      <div class="card">
        <div class="split-actions">
          <div>
            <span class="pill">Workflows</span>
            <h3>gateway-api Scheduled Workflows</h3>
          </div>
          <div class="toolbar">
            <button id="reloadWorkflowsButton">Reload Workflows</button>
            <button id="addWorkflowButton">Add Workflow</button>
          </div>
        </div>
        <div id="workflowsContainer" class="section-list"></div>
      </div>
      </div>

      <div class="tab-panel" data-tab-panel="overview">
      <div class="card">
        <div class="split-actions">
          <div>
            <span class="pill">Automation</span>
            <h3>Bruvie-D + Workflow Migration</h3>
          </div>
          <div class="toolbar">
            <button id="syncGatewayChatAgentsButton">Sync Agents</button>
            <button id="importWorkflowSeedButton">Import Workflow Seed</button>
          </div>
        </div>
        <div class="row">
          <label>Workflow Seed File
            <input id="workflowSeedPath" />
          </label>
          <label>Agent
            <select id="agentRunAgentId"></select>
          </label>
        </div>
        <label>Prompt
          <textarea id="agentRunPrompt">Give me a short readiness check in character, then confirm the local model route is working.</textarea>
        </label>
        <div class="row">
          <label>Context JSON
            <textarea id="agentRunContext">{}</textarea>
          </label>
          <label>Delivery JSON
            <textarea id="agentRunDelivery">{}</textarea>
          </label>
        </div>
        <div class="toolbar">
          <button id="runAgentButton" class="primary">Run Agent</button>
        </div>
        <div id="agentRunResult" class="meta-list"></div>
      </div>
      </div>

      <div class="tab-panel" data-tab-panel="apps" hidden>
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
      </div>
    </section>

    <aside class="aside-stack">
      <section class="panel nav-card">
        <h2>Dashboard</h2>
        <p>Focus each part of the gateway config without scrolling through everything at once.</p>
        <div class="tab-nav">
          <button class="tab-button active" data-tab="overview">Overview</button>
          <button class="tab-button" data-tab="gateway">Gateway</button>
          <button class="tab-button" data-tab="services">Services</button>
          <button class="tab-button" data-tab="agents">Agents</button>
          <button class="tab-button" data-tab="workflows">Workflows</button>
          <button class="tab-button" data-tab="apps">Apps & Jobs</button>
          <button class="tab-button" data-tab="raw">Raw Config</button>
        </div>
      </section>
      <section class="panel">
        <div class="split-actions">
          <div>
            <h2>Runtime</h2>
            <p>Health and control-plane state from the live server process.</p>
          </div>
          <button id="refreshRuntimeButtonSecondary">Refresh</button>
        </div>
        <div id="runtimeSummary" class="metric-grid"></div>
        <div id="runtimeMeta" class="meta-list"></div>
      </section>
      <section class="panel tab-panel" data-tab-panel="raw" hidden>
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
          <p>Workflow CRUD in this UI is backed by the live <code>gateway-api</code> workflow endpoints, not the local config file.</p>
          <p>The Automation panel can import the OpenClaw workflow seed, sync live chat agents, and run Bruvie-D through <code>gateway-chat-platform</code>.</p>
          <p>The TTS section configures the external <code>local-tts-service</code> and can probe its health and available voices.</p>
        </div>
      </section>
    </aside>
  </main>
  <script>
    const state = {
      config: null,
      runtime: null,
      workflows: [],
      chatProviders: [],
      providerModels: {},
      ttsStatus: null,
      ttsVoices: [],
      agentRun: {
        agentId: '',
        prompt: 'Give me a short readiness check in character, then confirm the local model route is working.',
        contextJson: '{}',
        deliveryJson: '{}',
        workflowSeedPath: '${DEFAULT_WORKFLOW_SEED_PATH}',
        result: null
      },
      activeTab: 'overview'
    };
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

    function renderActiveTab() {
      document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.tabPanel !== state.activeTab;
      });
      document.querySelectorAll('.tab-button').forEach((button) => {
        button.classList.toggle('active', button.dataset.tab === state.activeTab);
      });
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

    function createWorkflowDraft() {
      return {
        id: '',
        name: '',
        enabled: true,
        schedule: '*/15 * * * *',
        sleepUntil: null,
        target: { type: 'shell', ref: '' },
        input: {},
        secrets: [],
        timeoutSeconds: undefined,
        retryPolicy: {},
        lastRunAt: null,
        lastStatus: 'idle',
        lastError: null,
        createdAt: '',
        updatedAt: '',
        __draft: true
      };
    }

    function parseOptionalJsonText(value) {
      const trimmed = value.trim();
      if (!trimmed || trimmed === '{}' || trimmed === 'null') {
        return undefined;
      }
      return JSON.parse(trimmed);
    }

    function configuredAgents() {
      if (!state.config) {
        return [];
      }
      return state.config.serviceProfiles.gatewayChatPlatform.agents || [];
    }

    function normalizeTtsVoice(voice) {
      if (typeof voice === 'string') {
        return { id: voice };
      }

      if (voice && typeof voice === 'object') {
        const id = typeof voice.id === 'string'
          ? voice.id
          : typeof voice.voice === 'string'
            ? voice.voice
            : typeof voice.name === 'string'
              ? voice.name
              : JSON.stringify(voice);
        return {
          id,
          name: typeof voice.name === 'string' ? voice.name : undefined,
          description: typeof voice.description === 'string' ? voice.description : undefined,
          source: typeof voice.source === 'string' ? voice.source : undefined
        };
      }

      return { id: String(voice) };
    }

    function normalizedTtsVoices() {
      return Array.isArray(state.ttsVoices) ? state.ttsVoices.map((voice) => normalizeTtsVoice(voice)) : [];
    }

    function normalizedChatProviders() {
      return Array.isArray(state.chatProviders) ? state.chatProviders.filter((provider) => provider.status !== 'unconfigured') : [];
    }

    function providerOptions(currentProviderName) {
      const providers = normalizedChatProviders();
      const knownProviders = [...providers];
      if (currentProviderName && !knownProviders.some((provider) => provider.name === currentProviderName)) {
        knownProviders.unshift({ name: currentProviderName, status: 'ok' });
      }
      return knownProviders
        .map((provider) => \`<option value="\${provider.name}" \${provider.name === currentProviderName ? 'selected' : ''}>\${provider.name}</option>\`)
        .join('');
    }

    function normalizeModel(model) {
      if (!model || typeof model !== 'object') {
        return { id: String(model || '') };
      }
      return {
        id: typeof model.id === 'string' ? model.id : typeof model.name === 'string' ? model.name : JSON.stringify(model),
        name: typeof model.name === 'string' ? model.name : undefined
      };
    }

    function modelOptions(providerName, currentModel) {
      const rawModels = Array.isArray(state.providerModels?.[providerName]) ? state.providerModels[providerName] : [];
      const knownModels = rawModels.map((model) => normalizeModel(model));
      if (currentModel && !knownModels.some((model) => model.id === currentModel)) {
        knownModels.unshift({ id: currentModel, name: currentModel });
      }
      return knownModels
        .map((model) => \`<option value="\${model.id}" \${model.id === currentModel ? 'selected' : ''}>\${model.name || model.id}</option>\`)
        .join('');
    }

    function getAgentChatTemplate(agent) {
      return agent.endpointConfig?.modelParams?.chatTemplate || '';
    }

    function setAgentChatTemplate(agent, chatTemplate) {
      if (!chatTemplate) {
        if (agent.endpointConfig?.modelParams && typeof agent.endpointConfig.modelParams === 'object') {
          delete agent.endpointConfig.modelParams.chatTemplate;
          if (Object.keys(agent.endpointConfig.modelParams).length === 0) {
            delete agent.endpointConfig.modelParams;
          }
        }
        if (agent.endpointConfig && Object.keys(agent.endpointConfig).length === 0) {
          delete agent.endpointConfig;
        }
        return;
      }

      agent.endpointConfig = agent.endpointConfig || {};
      agent.endpointConfig.modelParams = agent.endpointConfig.modelParams || {};
      agent.endpointConfig.modelParams.chatTemplate = chatTemplate;
    }

    function ensureAgentRunDefaults() {
      const agents = configuredAgents();
      if (agents.length === 0) {
        state.agentRun.agentId = '';
        return;
      }
      if (!agents.some((agent) => agent.id === state.agentRun.agentId)) {
        state.agentRun.agentId = (agents.find((agent) => agent.enabled) || agents[0]).id;
      }
    }

    function getAgentVoiceId(agent) {
      return agent.endpointConfig?.modelParams?.ttsVoiceId || state.config.serviceProfiles.gatewayChatPlatform.tts.defaultVoice || '';
    }

    function setAgentVoiceId(agent, voiceId) {
      if (!voiceId) {
        if (agent.endpointConfig?.modelParams && typeof agent.endpointConfig.modelParams === 'object') {
          delete agent.endpointConfig.modelParams.ttsVoiceId;
          if (Object.keys(agent.endpointConfig.modelParams).length === 0) {
            delete agent.endpointConfig.modelParams;
          }
        }
        if (agent.endpointConfig && Object.keys(agent.endpointConfig).length === 0) {
          delete agent.endpointConfig;
        }
        return;
      }

      agent.endpointConfig = agent.endpointConfig || {};
      agent.endpointConfig.modelParams = agent.endpointConfig.modelParams || {};
      agent.endpointConfig.modelParams.ttsVoiceId = voiceId;
    }

    function renderGatewayApiProfile() {
      const profile = state.config.serviceProfiles.gatewayApi;
      document.getElementById('gatewayApiProfileEnabled').checked = profile.enabled;
      document.getElementById('gatewayApiProfileAppId').innerHTML = appOptions(profile.appId);
      document.getElementById('gatewayApiProfileApiBaseUrl').value = profile.apiBaseUrl;
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
      document.getElementById('gatewayChatTtsEnabled').checked = profile.tts.enabled;
      document.getElementById('gatewayChatTtsBaseUrl').value = profile.tts.baseUrl;
      document.getElementById('gatewayChatTtsDefaultVoice').value = profile.tts.defaultVoice;
      document.getElementById('gatewayChatTtsGeneratePath').value = profile.tts.generatePath;
      document.getElementById('gatewayChatTtsStreamPath').value = profile.tts.streamPath;
      document.getElementById('gatewayChatTtsVoicesPath').value = profile.tts.voicesPath;
      document.getElementById('gatewayChatTtsHealthPath').value = profile.tts.healthPath;
      renderEnvironmentList('gatewayChatEnvContainer', profile.environment, (index) => {
        profile.environment.splice(index, 1);
        renderGatewayChatPlatformProfile();
        syncRawJson();
      });

      const ttsStatus = document.getElementById('ttsStatus');
      if (!state.ttsStatus) {
        ttsStatus.innerHTML = '<div>TTS status not checked yet.</div>';
      } else {
        const voices = Array.isArray(state.ttsStatus.voices)
          ? state.ttsStatus.voices.map((voice) => {
              if (typeof voice === 'string') {
                return voice;
              }
              if (voice && typeof voice === 'object' && 'id' in voice) {
                return String(voice.id);
              }
              return JSON.stringify(voice);
            }).join(', ')
          : JSON.stringify(state.ttsStatus.voices);
        ttsStatus.innerHTML = [
          \`<div><strong>Health:</strong> \${state.ttsStatus.healthStatus === null ? 'disabled' : state.ttsStatus.healthStatus}</div>\`,
          \`<div><strong>Voices:</strong> \${voices || 'none reported'}</div>\`
        ].join('');
      }

      const ttsVoicesContainer = document.getElementById('ttsVoicesContainer');
      const voices = normalizedTtsVoices();
      if (voices.length === 0) {
        ttsVoicesContainer.innerHTML = '<div>No voices loaded yet.</div>';
      } else {
        ttsVoicesContainer.innerHTML = '';
        voices.forEach((voice) => {
          const element = document.createElement('div');
          element.className = 'card';
          element.innerHTML = \`
            <div class="split-actions">
              <div><strong>\${voice.name || voice.id}</strong></div>
              <button class="danger" data-action="delete-voice">Delete</button>
            </div>
            <div class="meta-list">
              <div><strong>ID:</strong> \${voice.id}</div>
              <div><strong>Description:</strong> \${voice.description || 'none'}</div>
              <div><strong>Source:</strong> \${voice.source || 'unknown'}</div>
            </div>
          \`;
          element.querySelector('[data-action="delete-voice"]').addEventListener('click', async () => {
            try {
              await requestJson('DELETE', \`/api/tts/voices/\${encodeURIComponent(voice.id)}\`);
              await fetchTtsVoices();
              setStatus(\`Deleted voice \${voice.id}\`);
            } catch (error) {
              setStatus(error.message, 'error');
            }
          });
          ttsVoicesContainer.appendChild(element);
        });
      }

      const agentsContainer = document.getElementById('gatewayChatAgentsContainer');
      agentsContainer.innerHTML = '';
      const voiceOptions = normalizedTtsVoices();
      profile.agents.forEach((agent, index) => {
        const currentVoiceId = getAgentVoiceId(agent);
        const currentChatTemplate = getAgentChatTemplate(agent);
        const knownVoices = [...voiceOptions];
        if (currentVoiceId && !knownVoices.some((voice) => voice.id === currentVoiceId)) {
          knownVoices.unshift({ id: currentVoiceId, name: currentVoiceId });
        }
        const voiceSelectOptions = knownVoices
          .map((voice) => \`<option value="\${voice.id}" \${voice.id === currentVoiceId ? 'selected' : ''}>\${voice.name || voice.id}</option>\`)
          .join('');
        const providerSelectOptions = providerOptions(agent.providerName);
        const modelSelectOptions = modelOptions(agent.providerName, agent.model);
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
            <label>Provider
              <select data-field="providerName">
                \${providerSelectOptions}
              </select>
            </label>
            <label>Model
              <select data-field="model">
                \${modelSelectOptions}
              </select>
            </label>
            <label>Chat Template
              <select data-field="chatTemplate">
                <option value="" \${!currentChatTemplate ? 'selected' : ''}>(provider default)</option>
                <option value="llama3" \${currentChatTemplate === 'llama3' ? 'selected' : ''}>llama3</option>
              </select>
            </label>
            <label>Voice
              <select data-field="ttsVoiceId">
                <option value="">(use default)</option>
                \${voiceSelectOptions}
              </select>
            </label>
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
          const isSelect = input.tagName === 'SELECT';
          const eventName = isCheckbox || isSelect ? 'change' : 'input';
          input.addEventListener(eventName, async () => {
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
            } else if (field === 'ttsVoiceId') {
              setAgentVoiceId(agent, input.value);
            } else if (field === 'chatTemplate') {
              setAgentChatTemplate(agent, input.value);
              renderGatewayChatPlatformProfile();
            } else if (field === 'systemPrompt') {
              agent.systemPrompt = input.value || undefined;
              if (!input.value) delete agent.systemPrompt;
            } else if (field === 'providerName') {
              agent.providerName = input.value;
              await fetchChatProviderModels(agent.providerName);
              renderGatewayChatPlatformProfile();
            } else {
              agent[field] = input.value;
            }
            if (field === 'endpointConfig') {
              renderGatewayChatPlatformProfile();
            }
            syncRawJson();
          });
        });

        agentsContainer.appendChild(element);
      });
    }

    function renderWorkflows() {
      const container = document.getElementById('workflowsContainer');
      container.innerHTML = '';
      if (state.workflows.length === 0) {
        container.innerHTML = '<p>No workflows yet.</p>';
        return;
      }

      state.workflows.forEach((workflow, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div>
              <strong>\${workflow.name || 'new-workflow'}</strong>
              <p>Status: \${workflow.lastStatus || 'idle'} | Enabled: \${workflow.enabled ? 'yes' : 'no'}</p>
            </div>
            <div class="toolbar">
              <button data-action="save" class="primary">\${workflow.__draft ? 'Create' : 'Save'}</button>
              <button data-action="run">Run</button>
              <button data-action="toggle">\${workflow.enabled ? 'Disable' : 'Enable'}</button>
              <button data-action="sleep">Sleep</button>
              <button data-action="resume">Resume</button>
              <button data-action="delete" class="danger">Delete</button>
            </div>
          </div>
          <div class="row">
            <label>Name<input data-field="name" value="\${workflow.name || ''}" /></label>
            <label>Schedule<input data-field="schedule" value="\${workflow.schedule || ''}" /></label>
            <label>Target Type<input data-field="target.type" value="\${workflow.target?.type || ''}" /></label>
            <label>Target Ref<input data-field="target.ref" value="\${workflow.target?.ref || ''}" /></label>
            <label>Timeout Seconds<input type="number" data-field="timeoutSeconds" value="\${workflow.timeoutSeconds ?? ''}" /></label>
            <label>Sleep Until<input data-field="sleepUntil" value="\${workflow.sleepUntil || ''}" placeholder="2026-04-01T00:00:00Z" /></label>
          </div>
          <label>Secrets (comma separated)<input data-field="secrets" value="\${(workflow.secrets || []).join(', ')}" /></label>
          <label>Input JSON<textarea data-field="input">\${JSON.stringify(workflow.input || {}, null, 2)}</textarea></label>
          <label>Retry Policy JSON<textarea data-field="retryPolicy">\${JSON.stringify(workflow.retryPolicy || {}, null, 2)}</textarea></label>
          <div class="meta-list">
            <div><strong>ID:</strong> \${workflow.id || 'not created yet'}</div>
            <div><strong>Last Run:</strong> \${workflow.lastRunAt || 'never'}</div>
            <div><strong>Last Error:</strong> \${workflow.lastError || 'none'}</div>
            <div><strong>Updated:</strong> \${workflow.updatedAt || 'not saved yet'}</div>
          </div>
        \`;

        element.querySelectorAll('input, textarea').forEach((input) => {
          input.addEventListener('input', () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            if (field === 'target.type') {
              workflow.target.type = input.value;
            } else if (field === 'target.ref') {
              workflow.target.ref = input.value;
            } else if (field === 'timeoutSeconds') {
              workflow.timeoutSeconds = input.value ? Number(input.value) : undefined;
              if (!input.value) {
                delete workflow.timeoutSeconds;
              }
            } else if (field === 'secrets') {
              workflow.secrets = input.value.split(',').map((item) => item.trim()).filter(Boolean);
            } else if (field === 'input') {
              workflow.input = parseJsonField(input.value, {});
            } else if (field === 'retryPolicy') {
              const value = parseJsonField(input.value, {});
              workflow.retryPolicy = Object.keys(value).length > 0 ? value : undefined;
              if (!workflow.retryPolicy) {
                delete workflow.retryPolicy;
              }
            } else if (field === 'sleepUntil') {
              workflow.sleepUntil = input.value || null;
            } else {
              workflow[field] = input.value;
            }
          });
        });

        element.querySelector('[data-action="save"]').addEventListener('click', async () => {
          try {
            const body = {
              name: workflow.name,
              schedule: workflow.schedule,
              target: workflow.target,
              enabled: workflow.enabled,
              input: workflow.input,
              secrets: workflow.secrets,
              timeoutSeconds: workflow.timeoutSeconds,
              retryPolicy: workflow.retryPolicy
            };
            if (workflow.__draft) {
              await requestJson('POST', '/api/workflows', body);
            } else {
              await requestJson('PUT', \`/api/workflows/\${workflow.id}\`, body);
            }
            await fetchWorkflows();
            setStatus(\`Workflow \${workflow.__draft ? 'created' : 'saved'}\`);
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        element.querySelector('[data-action="run"]').addEventListener('click', async () => {
          if (!workflow.id) {
            setStatus('Create the workflow before running it', 'error');
            return;
          }
          try {
            await requestJson('POST', \`/api/workflows/\${workflow.id}/run\`);
            await fetchWorkflows();
            setStatus('Workflow run triggered');
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        element.querySelector('[data-action="toggle"]').addEventListener('click', async () => {
          if (!workflow.id) {
            workflow.enabled = !workflow.enabled;
            renderWorkflows();
            return;
          }
          try {
            await requestJson('POST', \`/api/workflows/\${workflow.id}/\${workflow.enabled ? 'disable' : 'enable'}\`);
            await fetchWorkflows();
            setStatus(\`Workflow \${workflow.enabled ? 'disabled' : 'enabled'}\`);
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        element.querySelector('[data-action="sleep"]').addEventListener('click', async () => {
          if (!workflow.sleepUntil) {
            setStatus('Set a future Sleep Until timestamp first', 'error');
            return;
          }
          if (!workflow.id) {
            setStatus('Create the workflow before sleeping it', 'error');
            return;
          }
          try {
            await requestJson('POST', \`/api/workflows/\${workflow.id}/sleep\`, { until: workflow.sleepUntil });
            await fetchWorkflows();
            setStatus('Workflow sleep updated');
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        element.querySelector('[data-action="resume"]').addEventListener('click', async () => {
          if (!workflow.id) {
            workflow.sleepUntil = null;
            workflow.lastStatus = 'idle';
            renderWorkflows();
            return;
          }
          try {
            await requestJson('POST', \`/api/workflows/\${workflow.id}/resume\`);
            await fetchWorkflows();
            setStatus('Workflow resumed');
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        element.querySelector('[data-action="delete"]').addEventListener('click', async () => {
          try {
            if (workflow.__draft) {
              state.workflows.splice(index, 1);
              renderWorkflows();
              return;
            }
            await requestJson('DELETE', \`/api/workflows/\${workflow.id}\`);
            await fetchWorkflows();
            setStatus('Workflow deleted');
          } catch (error) {
            setStatus(error.message, 'error');
          }
        });

        container.appendChild(element);
      });
    }

    function renderAutomation() {
      ensureAgentRunDefaults();
      const agentOptions = configuredAgents()
        .map((agent) => \`<option value="\${agent.id}" \${agent.id === state.agentRun.agentId ? 'selected' : ''}>\${agent.name || agent.id}</option>\`)
        .join('');
      document.getElementById('workflowSeedPath').value = state.agentRun.workflowSeedPath;
      document.getElementById('agentRunAgentId').innerHTML = agentOptions || '<option value="">No agents configured</option>';
      document.getElementById('agentRunPrompt').value = state.agentRun.prompt;
      document.getElementById('agentRunContext').value = state.agentRun.contextJson;
      document.getElementById('agentRunDelivery').value = state.agentRun.deliveryJson;

      const resultContainer = document.getElementById('agentRunResult');
      if (!state.agentRun.result) {
        resultContainer.innerHTML = '<div>No agent run yet.</div>';
        return;
      }

      const result = state.agentRun.result;
      resultContainer.innerHTML = [
        \`<div><strong>Agent:</strong> \${result.agentId}</div>\`,
        \`<div><strong>Provider:</strong> \${result.usedProvider}</div>\`,
        \`<div><strong>Model:</strong> \${result.model}</div>\`,
        \`<div><strong>Latency:</strong> \${result.latencyMs}ms</div>\`,
        result.usage
          ? \`<div><strong>Tokens:</strong> \${result.usage.promptTokens} prompt / \${result.usage.completionTokens} completion / \${result.usage.totalTokens} total</div>\`
          : '<div><strong>Tokens:</strong> not reported</div>',
        \`<div><strong>Content:</strong><br />\${result.content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div>\`
      ].join('');
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
            <label>Hostnames (comma separated)<input data-field="hostnames" value="\${(app.hostnames || []).join(', ')}" /></label>
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
            } else if (field === 'hostnames') {
              state.config.apps[index].hostnames = input.value.split(',').map((item) => item.trim()).filter(Boolean);
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
      renderWorkflows();
      renderAutomation();
      renderApps();
      renderJobs();
      renderFeatures();
      renderRuntime();
      syncRawJson();
      renderActiveTab();
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

    async function fetchWorkflows() {
      if (state.config && !state.config.serviceProfiles.gatewayApi.enabled) {
        state.workflows = [];
        renderWorkflows();
        return;
      }
      const response = await fetch(joinBase('/api/workflows'));
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load workflows');
      }
      state.workflows = Array.isArray(data) ? data : [];
      renderWorkflows();
    }

    async function fetchTtsVoices() {
      if (!state.config || !state.config.serviceProfiles.gatewayChatPlatform.tts.enabled) {
        state.ttsVoices = [];
        renderGatewayChatPlatformProfile();
        return;
      }
      const data = await requestJson('GET', '/api/tts/voices');
      state.ttsVoices = Array.isArray(data?.voices) ? data.voices : [];
      renderGatewayChatPlatformProfile();
    }

    async function fetchChatProviderModels(providerName) {
      if (!providerName || !state.config || !state.config.serviceProfiles.gatewayChatPlatform.enabled) {
        return;
      }
      const data = await requestJson('GET', \`/api/chat-platform/providers/\${encodeURIComponent(providerName)}/models\`);
      state.providerModels[providerName] = Array.isArray(data?.models) ? data.models : [];
    }

    async function fetchChatProviders() {
      if (!state.config || !state.config.serviceProfiles.gatewayChatPlatform.enabled) {
        state.chatProviders = [];
        state.providerModels = {};
        renderGatewayChatPlatformProfile();
        return;
      }
      const data = await requestJson('GET', '/api/chat-platform/providers/status');
      state.chatProviders = Array.isArray(data?.providers) ? data.providers : [];
      state.providerModels = {};
      await Promise.all(
        normalizedChatProviders().map((provider) =>
          fetchChatProviderModels(provider.name).catch(() => {
            state.providerModels[provider.name] = [];
          })
        )
      );
      renderGatewayChatPlatformProfile();
    }

    async function requestJson(method, url, body) {
      const response = await fetch(joinBase(url), {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const data = response.status === 204 ? null : await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Request failed');
      }
      return data;
    }

    async function syncConfiguredAgents() {
      await requestJson('POST', '/api/service-profiles/gateway-chat-platform/sync');
      setStatus('Chat agents synced to gateway-chat-platform');
    }

    document.querySelectorAll('.tab-button').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeTab = button.dataset.tab || 'overview';
        renderActiveTab();
      });
    });

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
      ['gatewayApiProfileApiBaseUrl', 'apiBaseUrl'],
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
    [
      ['gatewayChatTtsEnabled', 'enabled', 'checkbox'],
      ['gatewayChatTtsBaseUrl', 'baseUrl'],
      ['gatewayChatTtsDefaultVoice', 'defaultVoice'],
      ['gatewayChatTtsGeneratePath', 'generatePath'],
      ['gatewayChatTtsStreamPath', 'streamPath'],
      ['gatewayChatTtsVoicesPath', 'voicesPath'],
      ['gatewayChatTtsHealthPath', 'healthPath'],
    ].forEach(([id, key, kind]) => {
      const element = document.getElementById(id);
      element.addEventListener(kind === 'checkbox' ? 'change' : 'input', (event) => {
        const target = event.target;
        state.config.serviceProfiles.gatewayChatPlatform.tts[key] = kind === 'checkbox' ? target.checked : target.value;
        syncRawJson();
      });
    });

    document.getElementById('reloadButton').addEventListener('click', async () => {
      try {
        await fetchConfig();
        await fetchWorkflows();
        await fetchRuntime();
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    document.getElementById('validateButton').addEventListener('click', async () => {
      try {
        const result = await requestJson('POST', '/api/validate', state.config);
        setStatus(result.message || 'Config is valid');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    document.getElementById('saveButton').addEventListener('click', async () => {
      try {
        const result = await requestJson('POST', '/api/config', state.config);
        state.config = result.config;
        render();
        await fetchWorkflows();
        await fetchRuntime();
        setStatus(result.message || 'Saved');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    document.getElementById('buildButton').addEventListener('click', async () => {
      try {
        const result = await requestJson('POST', '/api/build', state.config);
        state.config = result.config;
        render();
        await fetchWorkflows();
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
    document.getElementById('refreshRuntimeButtonSecondary').addEventListener('click', async () => {
      try {
        await fetchRuntime();
        setStatus('Runtime refreshed');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('reloadWorkflowsButton').addEventListener('click', async () => {
      try {
        await fetchWorkflows();
        setStatus('Workflows reloaded');
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
        hostnames: [],
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
      state.activeTab = 'agents';
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
      renderActiveTab();
      syncRawJson();
    });
    document.getElementById('addWorkflowButton').addEventListener('click', () => {
      state.workflows.unshift(createWorkflowDraft());
      renderWorkflows();
    });
    document.getElementById('workflowSeedPath').addEventListener('input', (event) => {
      state.agentRun.workflowSeedPath = event.target.value;
    });
    document.getElementById('agentRunAgentId').addEventListener('input', (event) => {
      state.agentRun.agentId = event.target.value;
    });
    document.getElementById('agentRunPrompt').addEventListener('input', (event) => {
      state.agentRun.prompt = event.target.value;
    });
    document.getElementById('agentRunContext').addEventListener('input', (event) => {
      state.agentRun.contextJson = event.target.value;
    });
    document.getElementById('agentRunDelivery').addEventListener('input', (event) => {
      state.agentRun.deliveryJson = event.target.value;
    });
    document.getElementById('syncGatewayChatAgentsButton').addEventListener('click', async () => {
      try {
        await syncConfiguredAgents();
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('syncGatewayChatAgentsButtonSecondary').addEventListener('click', async () => {
      try {
        await syncConfiguredAgents();
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('checkTtsButton').addEventListener('click', async () => {
      try {
        state.ttsStatus = await requestJson('GET', '/api/tts/status');
        await fetchTtsVoices();
        renderGatewayChatPlatformProfile();
        setStatus('TTS status refreshed');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('reloadTtsVoicesButton').addEventListener('click', async () => {
      try {
        await fetchTtsVoices();
        setStatus('TTS voices reloaded');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('createTtsVoiceButton').addEventListener('click', async () => {
      try {
        const fileInput = document.getElementById('ttsCreateVoiceFile');
        const file = fileInput.files && fileInput.files[0];
        if (!file) {
          throw new Error('Choose a reference audio file first');
        }
        const transcript = document.getElementById('ttsCreateVoiceTranscript').value.trim();
        if (!transcript) {
          throw new Error('Provide the spoken transcript for the reference audio');
        }

        const formData = new FormData();
        formData.append('reference_audio', file);
        formData.append('name', document.getElementById('ttsCreateVoiceName').value);
        formData.append('description', document.getElementById('ttsCreateVoiceDescription').value);
        formData.append('source', document.getElementById('ttsCreateVoiceSource').value || 'recorded');
        formData.append('transcript', transcript);

        const response = await fetch(joinBase('/api/tts/voices'), {
          method: 'POST',
          body: formData
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result?.error || 'Failed to create voice');
        }
        document.getElementById('ttsCreateVoiceName').value = '';
        document.getElementById('ttsCreateVoiceDescription').value = '';
        document.getElementById('ttsCreateVoiceSource').value = 'recorded';
        document.getElementById('ttsCreateVoiceTranscript').value = '';
        fileInput.value = '';
        await fetchTtsVoices();
        setStatus(result.message || 'Voice created');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('importWorkflowSeedButton').addEventListener('click', async () => {
      try {
        const result = await requestJson('POST', '/api/workflow-seeds/import', {
          filePath: state.agentRun.workflowSeedPath
        });
        await fetchWorkflows();
        setStatus(result.message || 'Workflow seed imported');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('runAgentButton').addEventListener('click', async () => {
      try {
        if (!state.agentRun.agentId) {
          throw new Error('Choose an agent first');
        }
        const context = parseOptionalJsonText(state.agentRun.contextJson);
        const delivery = parseOptionalJsonText(state.agentRun.deliveryJson);
        state.agentRun.result = await requestJson('POST', \`/api/chat-platform/agents/\${encodeURIComponent(state.agentRun.agentId)}/run\`, {
          prompt: state.agentRun.prompt,
          ...(context ? { context } : {}),
          ...(delivery ? { delivery } : {})
        });
        renderAutomation();
        setStatus(\`Agent run completed for \${state.agentRun.agentId}\`);
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });

    fetchConfig()
      .then(() => Promise.all([fetchWorkflows(), fetchRuntime(), fetchTtsVoices(), fetchChatProviders()]))
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

async function proxyWorkflowRequest(
  config: GatewayConfig,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown
): Promise<{ status: number; payload: unknown }> {
  if (!config.serviceProfiles.gatewayApi.enabled) {
    throw new Error('gatewayApi service profile is disabled');
  }

  const workflowBaseUrl = normalizeBaseUrl(config.serviceProfiles.gatewayApi.apiBaseUrl);
  return requestJsonUrl(`${workflowBaseUrl}${path}`, method, body);
}

async function proxyChatPlatformRequest(
  config: GatewayConfig,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown
): Promise<{ status: number; payload: unknown }> {
  if (!config.serviceProfiles.gatewayChatPlatform.enabled) {
    throw new Error('gatewayChatPlatform service profile is disabled');
  }

  const chatPlatformBaseUrl = normalizeBaseUrl(config.serviceProfiles.gatewayChatPlatform.apiBaseUrl);
  return requestJsonUrl(`${chatPlatformBaseUrl}${path}`, method, body);
}

async function listChatProviders(config: GatewayConfig): Promise<ChatProviderStatusRecord[]> {
  const result = await proxyChatPlatformRequest(config, '/api/providers/status', 'GET');
  const rawProviders =
    result.payload && typeof result.payload === 'object' && Array.isArray((result.payload as { providers?: unknown[] }).providers)
      ? (result.payload as { providers: unknown[] }).providers
      : [];

  return rawProviders
    .filter((provider): provider is Record<string, unknown> => provider !== null && typeof provider === 'object')
    .map((provider) => ({
      name: typeof provider.name === 'string' ? provider.name : 'unknown',
      status:
        provider.status === 'ok' || provider.status === 'error' || provider.status === 'unconfigured'
          ? provider.status
          : 'error',
      latencyMs: typeof provider.latencyMs === 'number' ? provider.latencyMs : undefined,
      error: typeof provider.error === 'string' ? provider.error : undefined
    }));
}

async function listChatProviderModels(config: GatewayConfig, providerName: string): Promise<ChatProviderModelRecord[]> {
  const result = await proxyChatPlatformRequest(config, `/api/providers/${encodeURIComponent(providerName)}/models`, 'GET');
  const rawModels =
    result.payload && typeof result.payload === 'object' && Array.isArray((result.payload as { models?: unknown[] }).models)
      ? (result.payload as { models: unknown[] }).models
      : [];

  return rawModels
    .filter((model): model is Record<string, unknown> => model !== null && typeof model === 'object')
    .map((model) => ({
      id: typeof model.id === 'string' ? model.id : typeof model.name === 'string' ? model.name : JSON.stringify(model),
      name: typeof model.name === 'string' ? model.name : undefined,
      description: typeof model.description === 'string' ? model.description : undefined
    }));
}

async function requestJsonUrl(
  requestUrl: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown
): Promise<{ status: number; payload: unknown }> {
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const requestImpl = requestUrl.startsWith('https://') ? (await import('node:https')).request : (await import('node:http')).request;

  return new Promise((resolve, reject) => {
    const request = requestImpl(
      requestUrl,
      {
        method,
        timeout: 10_000,
        headers: requestBody
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(requestBody)
            }
          : undefined
      },
      (apiResponse) => {
        const chunks: Buffer[] = [];
        apiResponse.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        });
        apiResponse.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf8');
          const payload = responseText.length > 0 ? JSON.parse(responseText) as unknown : null;
          resolve({
            status: apiResponse.statusCode ?? 0,
            payload
          });
        });
      }
    );

    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error(`Timed out: ${requestUrl}`)));
    if (requestBody) {
      request.write(requestBody);
    }
    request.end();
  });
}

async function requestBinaryUrl(
  requestUrl: string,
  method: 'POST' | 'DELETE',
  headers: Record<string, string | number | undefined>,
  body?: Buffer
): Promise<{ status: number; payload: unknown }> {
  const requestImpl = requestUrl.startsWith('https://') ? (await import('node:https')).request : (await import('node:http')).request;

  return new Promise((resolve, reject) => {
    const request = requestImpl(
      requestUrl,
      {
        method,
        timeout: 20_000,
        headers
      },
      (apiResponse) => {
        const chunks: Buffer[] = [];
        apiResponse.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        });
        apiResponse.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf8');
          let payload: unknown = null;
          if (responseText.length > 0) {
            try {
              payload = JSON.parse(responseText) as unknown;
            } catch {
              payload = responseText;
            }
          }
          resolve({
            status: apiResponse.statusCode ?? 0,
            payload
          });
        });
      }
    );

    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error(`Timed out: ${requestUrl}`)));
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function normalizeTtsVoice(value: unknown): TtsVoiceRecord {
  if (typeof value === 'string') {
    return { id: value };
  }

  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    const id = typeof candidate.id === 'string'
      ? candidate.id
      : typeof candidate.voice === 'string'
        ? candidate.voice
        : typeof candidate.name === 'string'
          ? candidate.name
          : JSON.stringify(candidate);
    return {
      id,
      name: typeof candidate.name === 'string' ? candidate.name : undefined,
      description: typeof candidate.description === 'string' ? candidate.description : undefined,
      source: typeof candidate.source === 'string' ? candidate.source : undefined
    };
  }

  return { id: String(value) };
}

async function probeTtsRuntime(config: GatewayConfig): Promise<TtsStatusSnapshot> {
  const tts = config.serviceProfiles.gatewayChatPlatform.tts;
  if (!tts.enabled) {
    return {
      healthStatus: null,
      voices: []
    };
  }

  const baseUrl = normalizeBaseUrl(tts.baseUrl);
  const healthResponse = await requestJsonUrl(`${baseUrl}${tts.healthPath}`, 'GET');
  const voicesResponse = await requestJsonUrl(`${baseUrl}${tts.voicesPath}`, 'GET');

  return {
    healthStatus: healthResponse.status,
    voices: voicesResponse.payload
  };
}

async function listTtsVoices(config: GatewayConfig): Promise<TtsVoiceRecord[]> {
  const tts = config.serviceProfiles.gatewayChatPlatform.tts;
  if (!tts.enabled) {
    return [];
  }

  const baseUrl = normalizeBaseUrl(tts.baseUrl);
  const voicesResponse = await requestJsonUrl(`${baseUrl}${tts.voicesPath}`, 'GET');
  if (voicesResponse.status < 200 || voicesResponse.status >= 300) {
    throw new Error(`TTS voices request failed: ${voicesResponse.status}`);
  }

  const rawVoices = Array.isArray(voicesResponse.payload)
    ? voicesResponse.payload
    : Array.isArray((voicesResponse.payload as { voices?: unknown[] } | null)?.voices)
      ? (voicesResponse.payload as { voices: unknown[] }).voices
      : [];
  return rawVoices.map((voice) => normalizeTtsVoice(voice));
}

async function createTtsVoice(
  config: GatewayConfig,
  request: IncomingMessage
): Promise<{ status: number; payload: unknown }> {
  const tts = config.serviceProfiles.gatewayChatPlatform.tts;
  if (!tts.enabled) {
    throw new Error('TTS service is disabled');
  }

  const body = await readBodyBuffer(request);
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.includes('multipart/form-data')) {
    throw new Error('Expected multipart/form-data for voice creation');
  }

  const baseUrl = normalizeBaseUrl(tts.baseUrl);
  return requestBinaryUrl(`${baseUrl}${tts.voicesPath}`, 'POST', {
    'Content-Type': contentType,
    'Content-Length': body.length
  }, body);
}

async function deleteTtsVoice(config: GatewayConfig, voiceId: string): Promise<{ status: number; payload: unknown }> {
  const tts = config.serviceProfiles.gatewayChatPlatform.tts;
  if (!tts.enabled) {
    throw new Error('TTS service is disabled');
  }

  const baseUrl = normalizeBaseUrl(tts.baseUrl);
  return requestBinaryUrl(`${baseUrl}${tts.voicesPath}/${encodeURIComponent(voiceId)}`, 'DELETE', {});
}

export async function startAdminServer(options: AdminServerOptions): Promise<void> {
  const startedAtMs = Date.now();
  const server = createServer(async (request, response) => {
    try {
      const path = getRequestPath(request);
      const basePath = getForwardedBasePath(request);
      const workflowIdMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
      const workflowActionMatch = path.match(/^\/api\/workflows\/([^/]+)\/(enable|disable|sleep|resume|run)$/);
      const agentRunMatch = path.match(/^\/api\/chat-platform\/agents\/([^/]+)\/run$/);

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

      if (request.method === 'GET' && path === '/api/chat-platform/providers/status') {
        const config = await loadGatewayConfig(options.configPath);
        const providers = await listChatProviders(config);
        sendJson(response, 200, { providers });
        return;
      }

      const providerModelsMatch = path.match(/^\/api\/chat-platform\/providers\/([^/]+)\/models$/);
      if (providerModelsMatch && request.method === 'GET') {
        const config = await loadGatewayConfig(options.configPath);
        const providerName = decodeURIComponent(providerModelsMatch[1]);
        const models = await listChatProviderModels(config, providerName);
        sendJson(response, 200, { provider: providerName, models });
        return;
      }

      if (request.method === 'GET' && path === '/api/tts/status') {
        const config = await loadGatewayConfig(options.configPath);
        const status = await probeTtsRuntime(config);
        sendJson(response, 200, status);
        return;
      }

      if (request.method === 'GET' && path === '/api/tts/voices') {
        const config = await loadGatewayConfig(options.configPath);
        const voices = await listTtsVoices(config);
        sendJson(response, 200, { voices });
        return;
      }

      if (request.method === 'POST' && path === '/api/tts/voices') {
        const config = await loadGatewayConfig(options.configPath);
        const result = await createTtsVoice(config, request);
        sendJson(response, result.status, {
          message: 'Created TTS voice',
          result: result.payload
        });
        return;
      }

      const ttsVoiceDeleteMatch = path.match(/^\/api\/tts\/voices\/([^/]+)$/);
      if (ttsVoiceDeleteMatch && request.method === 'DELETE') {
        const config = await loadGatewayConfig(options.configPath);
        const result = await deleteTtsVoice(config, decodeURIComponent(ttsVoiceDeleteMatch[1]));
        if (result.status === 204 || result.payload === null) {
          response.statusCode = result.status;
          response.end();
          return;
        }
        sendJson(response, result.status, result.payload);
        return;
      }

      if (request.method === 'GET' && path === '/api/workflows') {
        const config = await loadGatewayConfig(options.configPath);
        const result = await proxyWorkflowRequest(config, '/api/workflows', 'GET');
        sendJson(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && path === '/api/workflows') {
        const config = await loadGatewayConfig(options.configPath);
        const body = JSON.parse(await readBody(request)) as unknown;
        const result = await proxyWorkflowRequest(config, '/api/workflows', 'POST', body);
        sendJson(response, result.status, result.payload);
        return;
      }

      if (workflowIdMatch && request.method === 'GET') {
        const config = await loadGatewayConfig(options.configPath);
        const result = await proxyWorkflowRequest(config, path, 'GET');
        sendJson(response, result.status, result.payload);
        return;
      }

      if (workflowIdMatch && request.method === 'PUT') {
        const config = await loadGatewayConfig(options.configPath);
        const body = JSON.parse(await readBody(request)) as unknown;
        const result = await proxyWorkflowRequest(config, path, 'PUT', body);
        sendJson(response, result.status, result.payload);
        return;
      }

      if (workflowIdMatch && request.method === 'DELETE') {
        const config = await loadGatewayConfig(options.configPath);
        const result = await proxyWorkflowRequest(config, path, 'DELETE');
        if (result.payload === null) {
          response.statusCode = result.status;
          response.end();
          return;
        }
        sendJson(response, result.status, result.payload);
        return;
      }

      if (workflowActionMatch && request.method === 'POST') {
        const config = await loadGatewayConfig(options.configPath);
        const body = workflowActionMatch[2] === 'sleep'
          ? JSON.parse(await readBody(request)) as unknown
          : undefined;
        const result = await proxyWorkflowRequest(config, path, 'POST', body);
        sendJson(response, result.status, result.payload);
        return;
      }

      if (request.method === 'POST' && path === '/api/service-profiles/gateway-chat-platform/sync') {
        const config = await loadGatewayConfig(options.configPath);
        await syncServiceProfileRuntime(
          config,
          config.serviceProfiles.gatewayChatPlatform.appId,
          { dryRun: false, log: () => undefined },
          config.serviceProfiles.gatewayChatPlatform.apiBaseUrl
        );
        sendJson(response, 200, { message: 'Synced gateway-chat-platform agents' });
        return;
      }

      if (agentRunMatch && request.method === 'POST') {
        const config = await loadGatewayConfig(options.configPath);
        const body = JSON.parse(await readBody(request)) as AgentRunPayload;
        const result = await runServiceProfileAgent(
          config,
          config.serviceProfiles.gatewayChatPlatform.appId,
          decodeURIComponent(agentRunMatch[1]),
          body,
          { dryRun: false, log: () => undefined },
          config.serviceProfiles.gatewayChatPlatform.apiBaseUrl
        );
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && path === '/api/workflow-seeds/import') {
        const config = await loadGatewayConfig(options.configPath);
        const body = JSON.parse(await readBody(request)) as { filePath?: string };
        const result = await importWorkflowSeed(
          config.serviceProfiles.gatewayApi.apiBaseUrl,
          body.filePath || DEFAULT_WORKFLOW_SEED_PATH,
          { dryRun: false, log: () => undefined }
        );
        sendJson(response, 200, {
          message: `Imported ${result.operations.length} workflow seed entries from ${result.filePath}`,
          operations: result.operations
        });
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
