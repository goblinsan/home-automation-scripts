/**
 * Admin UI — body markup module.
 *
 * Holds the static HTML body scaffolding for the admin SPA: tab navigation,
 * page containers (Overview, Services, Infrastructure, Monitoring, Secrets,
 * Workloads, Bootstrap, etc.), and the shared action-output surface.
 *
 * The markup is intentionally a pure string constant. All dynamic content
 * is injected at runtime by the client script (`./script.ts`) which hydrates
 * the named page containers. Keeping this file free of template
 * interpolation makes markup changes cheap to review and easy to diff.
 *
 * Invariants that must be preserved:
 *   - Top-level tab buttons keep their `data-tab` attributes; the shell
 *     renderer uses them to drive `state.activeTab` and the lazy-load
 *     fetch-on-activation behavior.
 *   - Page container element ids are stable; page-scoped renderers in
 *     `./script.ts` look them up by id.
 *   - The action-output surface at the bottom of the body is shared by
 *     every page and must remain in the document so long-running actions
 *     can stream progress into it.
 */
export const ADMIN_MARKUP: string = `<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header>
    <div class="header-shell">
      <div class="header-row">
        <div>
          <h1>Gateway Control Plane</h1>
          <p>Operations-first console — Workloads, Secrets, Nodes, and Monitoring as composed pages.</p>
        </div>
        <div class="header-actions" role="toolbar" aria-label="Global actions">
          <button id="refreshButton">Refresh</button>
          <button id="restartButton" title="Restart control-plane container" aria-label="Restart control-plane container">⟳ Restart</button>
          <button id="rawJsonButton" title="Edit raw config JSON" aria-label="Edit raw config JSON">⚙</button>
          <button id="saveButton" class="primary">Save</button>
        </div>
      </div>
      <nav class="top-tab-nav" aria-label="Sections">
        <button class="tab-button active" aria-current="page" data-nav-id="overview" data-tab="overview">Overview</button>
        <button class="tab-button" data-nav-id="bootstrap" data-tab="infra" data-sub-tab="infra-gateway">Bootstrap</button>
        <button class="tab-button" data-nav-id="nodes" data-tab="infra" data-sub-tab="infra-nodes">Nodes</button>
        <button class="tab-button" data-nav-id="workloads" data-tab="workloads" data-sub-tab="wl-remote">Workloads</button>
        <button class="tab-button" data-nav-id="monitor" data-tab="monitoring" data-sub-tab="mon-health">Monitor</button>
        <button class="tab-button" data-nav-id="secrets" data-tab="secrets">Secrets</button>
      </nav>
    </div>
  </header>
  <main id="main-content" tabindex="-1">
    <section class="panel editor-panel">
      <div class="split-actions">
        <div>
          <h2>Config Workspace</h2>
        </div>
      </div>

      <!-- ═══ OVERVIEW TAB (health-first landing) ═══ -->
      <div class="tab-panel overview-panel" data-tab-panel="overview">
        <div class="overview-header">
          <div>
            <h2>Overview</h2>
            <p>What's healthy, what's degraded, and what needs action — from live runtime and monitoring data.</p>
          </div>
          <div class="header-actions" role="toolbar" aria-label="Overview actions">
            <button id="overviewRefreshButton">Refresh</button>
            <button id="overviewRunCheckButton" class="overview-link-btn">Run Health Check</button>
          </div>
        </div>

        <div class="overview-grid" id="overviewSummaryCards">
          <div class="overview-card is-healthy">
            <div class="overview-count" data-overview-count="healthy">—</div>
            <div class="overview-label">Healthy</div>
            <div class="overview-detail" data-overview-detail="healthy">Loading health snapshot…</div>
          </div>
          <div class="overview-card is-degraded">
            <div class="overview-count" data-overview-count="degraded">—</div>
            <div class="overview-label">Degraded</div>
            <div class="overview-detail" data-overview-detail="degraded">Loading health snapshot…</div>
          </div>
          <div class="overview-card is-action">
            <div class="overview-count" data-overview-count="action">—</div>
            <div class="overview-label">Needs Action</div>
            <div class="overview-detail" data-overview-detail="action">Loading health snapshot…</div>
          </div>
        </div>

        <div class="overview-section-title">Runtime Snapshot</div>
        <div class="overview-runtime" id="overviewRuntimeMetrics"></div>

        <div class="overview-section-title">Project Tracking</div>
        <div class="overview-grid" id="overviewProjectSummaryCards">
          <div class="overview-card is-healthy">
            <div class="overview-count" data-project-overview-count="active">—</div>
            <div class="overview-label">Active Projects</div>
            <div class="overview-detail" data-project-overview-detail="active">Loading project snapshot…</div>
          </div>
          <div class="overview-card is-degraded">
            <div class="overview-count" data-project-overview-count="risk">—</div>
            <div class="overview-label">At Risk</div>
            <div class="overview-detail" data-project-overview-detail="risk">Loading project snapshot…</div>
          </div>
          <div class="overview-card is-action">
            <div class="overview-count" data-project-overview-count="stale">—</div>
            <div class="overview-label">Needs Update</div>
            <div class="overview-detail" data-project-overview-detail="stale">Loading project snapshot…</div>
          </div>
        </div>

        <div class="overview-target-list" id="overviewProjectList">
          <div class="overview-empty">No tracked projects yet.</div>
        </div>

        <div class="overview-project-summary-card">
          <div class="split-actions" style="margin:0 0 .75rem">
            <div>
              <strong>Shareable Summary</strong>
              <p class="section-note">Copy a compact project digest for external planning help.</p>
            </div>
            <div class="toolbar" style="margin-top:0">
              <button id="overviewCopyProjectSummaryButton" type="button">Copy Summary</button>
            </div>
          </div>
          <pre id="overviewProjectSummaryText" class="overview-project-summary-text">No tracked projects yet.</pre>
        </div>

        <div class="overview-section-title">Needs Action</div>
        <div class="overview-target-list" id="overviewActionList">
          <div class="overview-empty">No health data yet. Click <strong>Run Health Check</strong> to collect the first snapshot.</div>
        </div>

        <div class="overview-section-title">All Monitored Targets</div>
        <div class="overview-target-list" id="overviewTargetList"></div>
      </div>

      <!-- ═══ INFRASTRUCTURE TAB ═══ -->
      <div class="tab-panel" data-tab-panel="infra" hidden>
      <nav class="sub-tab-nav" data-sub-group="infra" aria-label="Infrastructure sub-sections">
        <button class="sub-tab-button active" aria-current="page" data-sub-tab="infra-gateway">Gateway</button>
        <button class="sub-tab-button" data-sub-tab="infra-nodes">Nodes</button>
      </nav>

      <div class="sub-tab-panel active" data-sub-tab-panel="infra-gateway">
      <div class="section-list">
        <div class="card card-quiet">
          <div>
            <span class="pill">Bootstrap</span>
            <h3>Gateway and Control-Plane Bring-Up</h3>
            <p>Bring a fresh gateway host online by walking these setup tasks in order. Most fields only need to be set once per environment.</p>
          </div>
          <ul class="bootstrap-task-list" id="bootstrapTaskList">
            <li data-task="gateway"><span class="bootstrap-task-num">1</span><div><strong>Configure gateway host</strong><span>Server names, nginx paths, and the reload commands the control plane calls on deploy.</span></div></li>
            <li data-task="adminUi"><span class="bootstrap-task-num">2</span><div><strong>Bind the admin UI service</strong><span>Host, port, and systemd details for the control-plane web app itself.</span></div></li>
          </ul>
        </div>
      </div>
      <details class="card section-card" id="bootstrapTaskGateway" open>
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Task 1 · Gateway</span>
            <h3>Gateway Server Settings</h3>
            <p>Core host-level control-plane paths and reload commands.</p>
          </div>
        </summary>
        <div class="section-body">
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
      </details>

      <details class="card section-card" id="bootstrapTaskAdminUi">
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Task 2 · Admin UI</span>
            <h3>Control-Plane Web App</h3>
            <p>Bind settings and service details for the admin interface itself.</p>
          </div>
        </summary>
        <div class="section-body">
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
      </details>
      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="infra-nodes">
      <div class="section-list">
        <div class="card card-quiet">
          <div>
            <span class="pill">Nodes</span>
            <h3>Worker Node Inventory</h3>
            <p>Machine inventory, provisioning actions, and SSH/docker reachability for everything the control plane deploys to. Use this tab to define remote nodes like your core-node and the container workloads hosted on them. Minecraft has its own dedicated tab.</p>
          </div>
          <div class="nodes-inventory-grid" id="nodesInventoryGrid">
            <div class="nodes-inventory-card"><div class="nodes-inventory-count" data-nodes-inventory="total">—</div><div class="nodes-inventory-label">Nodes</div><div class="nodes-inventory-detail" data-nodes-inventory-detail="total">No nodes configured.</div></div>
            <div class="nodes-inventory-card"><div class="nodes-inventory-count" data-nodes-inventory="enabled">—</div><div class="nodes-inventory-label">Enabled</div><div class="nodes-inventory-detail" data-nodes-inventory-detail="enabled">Enabled nodes accept deploys.</div></div>
            <div class="nodes-inventory-card"><div class="nodes-inventory-count" data-nodes-inventory="workloads">—</div><div class="nodes-inventory-label">Workloads</div><div class="nodes-inventory-detail" data-nodes-inventory-detail="workloads">Remote workloads targeting a node.</div></div>
          </div>
        </div>
        <details class="card section-card" open>
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Node Setup</span>
              <h3>Add New Node</h3>
              <p>Walk through the guided wizard to provision a new remote machine and register it with the control plane.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="toolbar">
              <button id="openNodeSetupWizardButton" class="primary-action">Setup New Node</button>
            </div>
          </div>
        </details>
        <details class="card section-card" open>
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Nodes</span>
              <h3>Worker Nodes</h3>
              <p>SSH targets and runtime settings for remote workload execution.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <button id="addWorkerNodeButton">Add Worker Node</button>
            </div>
            <div id="workerNodesContainer" class="section-list"></div>
          </div>
        </details>
        <details class="card section-card" id="remoteWorkloadsSection">
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Remote Workloads</span>
              <h3>Container Jobs + Services + Bedrock Servers</h3>
              <p>Generic remote workloads. Use services for long-running APIs, jobs for scheduled runs, and the Bedrock tab for Minecraft-specific controls.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <div class="toolbar">
                <button id="openServiceDeployWizardButton" class="primary-action">Deploy a Service</button>
                <button id="addRemoteWorkloadButton">Add Container Job</button>
                <button id="addContainerServiceWorkloadButton">Add Container Service</button>
                <button id="addBedrockWorkloadButton">Add Bedrock Server</button>
              </div>
            </div>
            <div id="remoteWorkloadsContainer" class="section-list"></div>
          </div>
        </details>
      </div>
      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="infra-minecraft">
      <details class="card section-card" open>
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Bedrock</span>
            <h3>Minecraft Bedrock Servers</h3>
            <p>Launch, configure, update, and administer Bedrock servers on worker nodes.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div>
              <p>Use <strong>Apply Server</strong> to save the config and push the latest server bundle to the node.</p>
            </div>
            <div class="toolbar">
              <button id="addBedrockServerButton">Add Bedrock Server</button>
            </div>
          </div>
          <div id="bedrockServersContainer" class="section-list"></div>
        </div>
      </details>
      </div>

      </div>

      <!-- ═══ SERVICES TAB ═══ -->
      <div class="tab-panel" data-tab-panel="services" hidden>
      <nav class="sub-tab-nav" data-sub-group="services" aria-label="Services sub-sections">
        <button class="sub-tab-button active" aria-current="page" data-sub-tab="svc-agents">Agents</button>
        <button class="sub-tab-button" data-sub-tab="svc-workflows">Workflows</button>
        <button class="sub-tab-button" data-sub-tab="svc-deploys">Deploys</button>
        <button class="sub-tab-button" data-sub-tab="svc-profiles">Profiles</button>
        <button class="sub-tab-button" data-sub-tab="svc-features">Features</button>
      </nav>

      <div class="sub-tab-panel active" data-sub-tab-panel="svc-agents">
      <details class="card section-card" open>
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Agents</span>
            <h3>Configured Chat Agents</h3>
            <p>Only these agents are synced into <code>gateway-chat-platform</code>.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div></div>
            <div class="toolbar">
              <button id="addGatewayChatAgentButton">Add Agent</button>
              <button id="syncGatewayChatAgentsButtonSecondary">Sync Agents</button>
            </div>
          </div>
          <div id="gatewayChatAgentsContainer" class="section-list"></div>
        </div>
      </details>
      <details class="card section-card">
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Tools</span>
            <h3>Agent Test Runner</h3>
            <p>Quick agent test runs and workflow seed imports.</p>
          </div>
        </summary>
        <div class="section-body">
        <div class="split-actions">
          <div></div>
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
      </details>
      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="svc-workflows">
      <details class="card section-card">
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Catalog</span>
            <h3>Automation Job Catalog</h3>
            <p>Available refs for <code>target.type = gateway-jobs.run</code>.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div></div>
            <button id="reloadJobsButton">Reload Jobs</button>
          </div>
          <div id="jobsCatalogContainer" class="section-list"></div>
        </div>
      </details>
      <details class="card section-card" open>
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Automations</span>
            <h3>Scheduled Workflows</h3>
            <p>API-level automations stored and executed by <code>gateway-api</code>.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div></div>
            <div class="toolbar">
              <button id="reloadWorkflowsButton">Reload Workflows</button>
              <button id="addWorkflowButton">Add Workflow</button>
            </div>
          </div>
          <div id="workflowsContainer" class="section-list"></div>
        </div>
      </details>
      <details class="card section-card" open>
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Jobs</span>
            <h3>Host Scheduled Jobs</h3>
            <p>Host-level scheduled commands tied to an app deployment.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div></div>
            <button id="addJobButton">Add Job</button>
          </div>
          <div id="jobsContainer" class="section-list"></div>
        </div>
      </details>
      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="svc-deploys">
        <div class="card card-quiet">
          <div class="split-actions">
            <div>
              <span class="pill">Deploy</span>
              <h3>Remote Container Services</h3>
              <p>Deploy and manage containerised services on your worker nodes. The wizard walks you through picking a service, configuring it, and deploying — all in one step.</p>
            </div>
            <div class="toolbar">
              <button id="openServiceDeployWizardButtonSvc" class="primary-action">Deploy a Service</button>
            </div>
          </div>
        </div>
        <div id="remoteServicesOverview" class="section-list"></div>
        <details class="card section-card" open>
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Apps</span>
              <h3>Managed Apps</h3>
              <p>Git-based services deployed by the control-plane.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <button id="addAppButton">Add App</button>
            </div>
            <div id="appsContainer" class="section-list"></div>
          </div>
        </details>
      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="svc-profiles">
      <details class="card section-card" open>
        <summary>
          <div class="section-summary-copy">
            <span class="pill">gateway-api</span>
            <h3>Runtime Profile</h3>
            <p>Env files, job channels, and KULRS runtime wiring for <code>gateway-api</code>.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div></div>
            <div class="toolbar">
              <button id="addGatewayApiEnvButton">Add Env Var</button>
              <button id="addGatewayApiChannelButton">Add Channel</button>
              <button id="addKulrsBotButton">Add KULRS Bot</button>
            </div>
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
          <details class="card section-card">
            <summary>
              <div class="section-summary-copy">
                <span class="pill">Jobs</span>
                <h3>Job Runtime Channels</h3>
                <p>Named delivery channels for <code>gateway-jobs.run</code>.</p>
              </div>
            </summary>
            <div class="section-body">
              <div class="row">
                <label>Channels File Path
                  <input id="gatewayApiJobChannelsFilePath" />
                </label>
              </div>
              <div id="gatewayApiJobChannelsContainer" class="section-list"></div>
            </div>
          </details>
          <details class="card section-card">
            <summary>
              <div class="section-summary-copy">
                <span class="pill">KULRS</span>
                <h3>Activity Job</h3>
                <p>Generated job files, credentials, schedule, and runtime details for KULRS.</p>
              </div>
            </summary>
            <div class="section-body">
              <div class="row">
                <label class="check"><input id="kulrsEnabled" type="checkbox" /> Enabled</label>
                <label>Schedule
                  <input id="kulrsSchedule" />
                </label>
                <label>User
                  <input id="kulrsUser" />
                </label>
                <label>Group
                  <input id="kulrsGroup" />
                </label>
                <label>Timezone
                  <input id="kulrsTimezone" />
                </label>
              </div>
              <div class="row">
                <label>Env File Path
                  <input id="kulrsEnvFilePath" />
                </label>
                <label>Credentials File Path
                  <input id="kulrsCredentialsFilePath" />
                </label>
                <label>Workspace Dir
                  <input id="kulrsWorkspaceDir" />
                </label>
              </div>
              <div class="row">
                <label>Working Directory
                  <input id="kulrsWorkingDirectory" />
                </label>
                <label>ExecStart
                  <input id="kulrsExecStart" />
                </label>
                <label>Create Mode
                  <select id="kulrsCreateMode">
                    <option value="llm">llm</option>
                    <option value="image">image</option>
                  </select>
                </label>
              </div>
              <div class="row">
                <label>LLM Base URL
                  <input id="kulrsLlmBaseUrl" />
                </label>
                <label>LLM Model
                  <input id="kulrsLlmModel" />
                </label>
                <label>LLM API Key
                  <input id="kulrsLlmApiKey" type="password" />
                </label>
              </div>
              <div class="row">
                <label>LLM Timeout (ms)
                  <input id="kulrsLlmTimeoutMs" type="number" min="1000" step="1000" />
                </label>
                <label>LLM Temperature
                  <input id="kulrsLlmTemperature" type="number" min="0" max="2" step="0.05" />
                </label>
                <label>Cron Log Path
                  <input id="kulrsCronLogPath" />
                </label>
              </div>
              <div class="row">
                <label>Log Retention (days)
                  <input id="kulrsCronLogRetentionDays" type="number" min="1" max="7" step="1" />
                </label>
                <label>Log Max Lines
                  <input id="kulrsCronLogMaxLines" type="number" min="50" max="5000" step="50" />
                </label>
              </div>
              <label>Description
                <input id="kulrsDescription" />
              </label>
              <div id="kulrsStatus" class="meta-list"></div>
              <div class="button-row">
                <button id="kulrsViewLogs" type="button">View Logs</button>
                <button id="kulrsRefreshLogs" type="button">Refresh Logs</button>
              </div>
              <pre id="kulrsLogsOutput" class="wizard-log" style="max-height:20rem;overflow:auto;font-size:.78rem"></pre>
              <div class="row">
                <label>Firebase API Key
                  <input id="kulrsFirebaseApiKey" type="password" />
                </label>
                <label>Unsplash Access Key
                  <input id="kulrsUnsplashAccessKey" type="password" />
                </label>
              </div>
              <div id="kulrsBotsContainer" class="section-list"></div>
            </div>
          </details>
        </div>
      </details>

      <details class="card section-card">
        <summary>
          <div class="section-summary-copy">
            <span class="pill">gateway-chat-platform</span>
            <h3>Runtime Profile</h3>
            <p>Chat API env wiring, provider sync, and local TTS settings.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div></div>
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
            <div class="card card-quiet">
              <p>Environment</p>
              <div id="gatewayChatEnvContainer" class="section-list"></div>
            </div>
            <div class="card card-quiet">
              <p>Chat Inbox / Redis</p>
              <div class="row">
                <label>Redis URL
                  <input id="gatewayChatRedisUrl" placeholder="redis://198.51.100.200:6379" />
                </label>
                <label>Default User Id
                  <input id="gatewayChatDefaultUserId" placeholder="me" />
                </label>
                <label>Default Channel Id
                  <input id="gatewayChatDefaultChannelId" placeholder="coach" />
                </label>
              </div>
              <p class="section-note">Scheduled prompts use these defaults unless a workflow overrides its own inbox scope.</p>
            </div>
            <details class="card section-card">
              <summary>
                <div class="section-summary-copy">
                  <span class="pill">TTS</span>
                  <h3>Local TTS Service</h3>
                  <p>Voice generation settings, health checks, and managed voice entries.</p>
                </div>
              </summary>
              <div class="section-body">
                <div class="split-actions">
                  <div></div>
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
            </details>
          </div>
        </div>
      </details>

      <details class="card section-card">
        <summary>
          <div class="section-summary-copy">
            <span class="pill">pi-proxy</span>
            <h3>Bedrock LAN Proxy</h3>
            <p>External Raspberry Pi proxy contract for Xbox LAN discovery and Bedrock server transfer targets.</p>
          </div>
        </summary>
        <div class="section-body">
          <div class="split-actions">
            <div>
              <p class="section-note">This profile manages the Pi-hosted <code>bedrock-lan-proxy.service</code> over SSH and keeps its advertised worlds aligned with the live Bedrock registry.</p>
            </div>
            <div class="toolbar">
              <button id="refreshPiProxyStatusButton">Check Service</button>
              <button id="deployPiProxyButton" class="primary">Deploy Proxy</button>
              <button id="restartPiProxyButton">Restart Proxy</button>
              <button id="refreshPiProxyRegistryButton">Refresh Registry</button>
            </div>
          </div>
          <div class="row">
            <label class="check"><input id="piProxyEnabled" type="checkbox" /> Enabled</label>
            <label>Managed Node
              <select id="piProxyNodeId"></select>
            </label>
            <label>Description
              <input id="piProxyDescription" />
            </label>
            <label>Install Root
              <input id="piProxyInstallRoot" />
            </label>
            <label>Systemd Unit
              <input id="piProxySystemdUnitName" />
            </label>
            <label>Registry Base URL
              <input id="piProxyRegistryBaseUrl" />
            </label>
          </div>
          <div class="row">
            <label>Listen Host
              <input id="piProxyListenHost" />
            </label>
            <label>Listen Port
              <input id="piProxyListenPort" type="number" min="1" />
            </label>
            <label>Service User
              <input id="piProxyServiceUser" />
            </label>
            <label>Service Group
              <input id="piProxyServiceGroup" />
            </label>
          </div>
          <div class="row">
            <label>Registry Path
              <input id="piProxyRegistryPath" />
            </label>
            <label>Poll Interval Seconds
              <input id="piProxyPollIntervalSeconds" type="number" min="1" />
            </label>
            <label>Registry URL
              <input id="piProxyRegistryUrlPreview" readonly />
            </label>
          </div>
          <div id="piProxyServiceMeta" class="meta-list"></div>
          <div id="piProxyRegistryMeta" class="meta-list"></div>
          <div id="piProxyActionOutput" class="inline-action-output"><strong>Action Output</strong><div>No Pi proxy actions yet.</div></div>
          <div id="piProxyRegistryContainer" class="section-list"></div>
        </div>
      </details>

      <details class="card section-card" id="secretsSection">
        <summary>
          <div class="section-summary-copy">
            <span class="pill">Secrets</span>
            <h3>Credentials &amp; Secret Env Vars</h3>
            <p>API keys, bot tokens, passwords, and other sensitive values for all services.</p>
          </div>
        </summary>
        <div class="section-body">
          <h4>gateway-api Secrets</h4>
          <div class="split-actions">
            <div></div>
            <button id="addGatewayApiSecretButton">Add Secret Env Var</button>
          </div>
          <div id="gatewayApiSecretsContainer" class="section-list"></div>

          <h4 style="margin-top:1rem">Delivery Channel Credentials</h4>
          <div class="split-actions">
            <div></div>
            <button id="addGatewayApiSecretChannelButton">Add Channel</button>
          </div>
          <div id="gatewayApiSecretChannelsContainer" class="section-list"></div>

          <h4 style="margin-top:1rem">KULRS Credentials</h4>
          <div class="split-actions">
            <div></div>
            <button id="addKulrsSecretBotButton">Add KULRS Bot</button>
          </div>
          <div class="row">
            <label>Firebase API Key
              <input id="kulrsFirebaseApiKeySecrets" type="password" />
            </label>
            <label>Unsplash Access Key
              <input id="kulrsUnsplashAccessKeySecrets" type="password" />
            </label>
          </div>
          <div id="kulrsSecretBotsContainer" class="section-list"></div>

          <h4 style="margin-top:1rem">gateway-chat-platform Secrets</h4>
          <div class="split-actions">
            <div></div>
            <button id="addGatewayChatSecretButton">Add Secret Env Var</button>
          </div>
          <div id="gatewayChatSecretsContainer" class="section-list"></div>
        </div>
      </details>

      </div>

      <div class="sub-tab-panel" data-sub-tab-panel="svc-features">
        <details class="card section-card" open>
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Features</span>
              <h3>Feature Flags</h3>
              <p>Optional deployment toggles and feature switches.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="split-actions">
              <div></div>
              <button id="addFeatureButton">Add Feature</button>
            </div>
            <div id="featuresContainer" class="section-list"></div>
          </div>
        </details>
      </div>

      </div>

      <!-- ═══ MONITORING TAB ═══ -->
      <div class="tab-panel" data-tab-panel="monitoring" hidden>
      <nav class="sub-tab-nav" data-sub-group="monitoring" aria-label="Monitoring sub-sections">
        <button class="sub-tab-button active" aria-current="page" data-sub-tab="mon-health">Health</button>
        <button class="sub-tab-button" data-sub-tab="mon-benchmarks">Benchmarks</button>
        <button class="sub-tab-button" data-sub-tab="mon-settings">Monitoring Settings</button>
      </nav>

      <!-- Health sub-tab -->
      <div class="sub-tab-panel active" data-sub-tab-panel="mon-health">
      <div class="section-list">
        <div class="card card-quiet">
          <div class="split-actions">
            <div>
              <span class="pill">Health Monitor</span>
              <h3>System Health Overview</h3>
              <p>Live status of all nodes, apps, and services. Health checks run on a configurable interval and store time-series metrics in Postgres.</p>
            </div>
            <div>
              <button id="refreshHealthButton">Refresh</button>
              <button id="runHealthCheckButton" class="primary">Run Check Now</button>
            </div>
          </div>
          <div class="monitor-dashboard-grid" id="monitorDashboardGrid">
            <div class="monitor-dashboard-card is-healthy"><div class="monitor-dashboard-count" data-monitor-count="healthy">—</div><div class="monitor-dashboard-label">Healthy</div><div class="monitor-dashboard-detail" data-monitor-detail="healthy">Loading snapshot…</div></div>
            <div class="monitor-dashboard-card is-degraded"><div class="monitor-dashboard-count" data-monitor-count="degraded">—</div><div class="monitor-dashboard-label">Degraded</div><div class="monitor-dashboard-detail" data-monitor-detail="degraded">Loading snapshot…</div></div>
            <div class="monitor-dashboard-card is-action"><div class="monitor-dashboard-count" data-monitor-count="action">—</div><div class="monitor-dashboard-label">Needs Action</div><div class="monitor-dashboard-detail" data-monitor-detail="action">Loading snapshot…</div></div>
            <div class="monitor-dashboard-card"><div class="monitor-dashboard-count" data-monitor-count="lastChecked">—</div><div class="monitor-dashboard-label">Last Check</div><div class="monitor-dashboard-detail" data-monitor-detail="lastChecked">No snapshot yet.</div></div>
          </div>
        </div>
        <div id="monitoringDisabledBanner" class="card" style="border-left:3px solid var(--color-warning);display:none">
          <p><strong>Monitoring is not enabled.</strong> Configure Postgres and Redis in the Monitoring Settings sub-tab, then enable monitoring to start collecting health data.</p>
        </div>
        <div id="healthTargetsContainer" class="section-list"></div>
        <details class="card section-card" id="healthHistorySection" style="display:none">
          <summary>
            <div class="section-summary-copy">
              <span class="pill">History</span>
              <h3>Health Check History</h3>
              <p>Recent check results for the selected target</p>
            </div>
          </summary>
          <div class="section-body">
            <div id="healthHistoryContainer"></div>
          </div>
        </details>
      </div>
      </div>

      <!-- Benchmarks sub-tab -->
      <div class="sub-tab-panel" data-sub-tab-panel="mon-benchmarks">
      <div class="section-list">
        <div class="card card-quiet">
          <div class="split-actions">
            <div>
              <span class="pill">Benchmarks</span>
              <h3>Service Benchmarks</h3>
              <p>Record, compare, and track performance metrics across service configurations. Use this to find the optimal engine and settings for your hardware.</p>
            </div>
            <div>
              <button id="refreshBenchmarksButton">Refresh</button>
              <button id="newBenchmarkRunButton" class="primary">New Run</button>
            </div>
          </div>
        </div>
        <div id="benchmarkRunsContainer" class="section-list"></div>
        <div id="benchmarkCompareContainer" style="display:none"></div>
      </div>
      </div>

      <!-- Monitoring Settings sub-tab -->
      <div class="sub-tab-panel" data-sub-tab-panel="mon-settings">
      <div class="section-list">
        <details class="card section-card" open>
          <summary>
            <div class="section-summary-copy">
              <span class="pill">Connection</span>
              <h3>Monitoring Data Stores</h3>
              <p>Configure the Postgres and Redis connections used for health metrics and benchmark results.</p>
            </div>
          </summary>
          <div class="section-body">
            <div class="row">
              <label class="check"><input id="monEnabled" type="checkbox" /> Monitoring Enabled</label>
            </div>
            <h4 style="margin-top:.75rem">Postgres</h4>
            <div class="row">
              <label>Host <input id="monPgHost" /></label>
              <label>Port <input id="monPgPort" type="number" /></label>
              <label>Database <input id="monPgDatabase" /></label>
              <label>User <input id="monPgUser" /></label>
              <label>Password <input id="monPgPassword" type="password" /></label>
            </div>
            <h4 style="margin-top:.75rem">Redis</h4>
            <div class="row">
              <label>Host <input id="monRedisHost" /></label>
              <label>Port <input id="monRedisPort" type="number" /></label>
            </div>
            <h4 style="margin-top:.75rem">Collection</h4>
            <div class="row">
              <label>Health Check Interval (seconds) <input id="monHealthInterval" type="number" /></label>
            </div>
          </div>
        </details>
      </div>
      </div>

      </div><!-- /monitoring tab -->

      <!-- ═══ WORKLOADS TAB (composed page — remote workloads, bedrock, managed apps, workflows, agents, profiles, features) ═══ -->
      <div class="tab-panel" data-tab-panel="workloads" hidden>
        <nav class="sub-tab-nav" data-sub-group="workloads" aria-label="Workloads sub-sections">
          <button class="sub-tab-button active" aria-current="page" data-sub-tab="wl-remote">Remote Workloads</button>
          <button class="sub-tab-button" data-sub-tab="infra-minecraft">Bedrock</button>
          <button class="sub-tab-button" data-sub-tab="svc-deploys">Managed Apps</button>
          <button class="sub-tab-button" data-sub-tab="svc-workflows">Workflows &amp; Jobs</button>
          <button class="sub-tab-button" data-sub-tab="svc-agents">Agents</button>
          <button class="sub-tab-button" data-sub-tab="svc-profiles">Runtime Profiles</button>
          <button class="sub-tab-button" data-sub-tab="svc-features">Feature Flags</button>
        </nav>
        <div class="sub-tab-panel active" data-sub-tab-panel="wl-remote">
          <div class="section-list">
            <div class="card card-quiet">
              <div>
                <span class="pill">Workloads</span>
                <h3>Remote Container Workloads</h3>
                <p>Generic remote workloads deployed to your worker nodes. Use the Bedrock sub-tab for Minecraft-specific admin and Managed Apps for git-based services handled by the control-plane deploy system.</p>
              </div>
            </div>
            <div id="workloadsRemoteHost" class="section-list"></div>
          </div>
        </div>
      </div>

      <!-- ═══ SECRETS TAB (composed page — secret env vars, credentials, secret-bearing runtime fields) ═══ -->
      <div class="tab-panel" data-tab-panel="secrets" hidden>
        <div class="section-list">
          <div class="card card-quiet secrets-intro" data-secrets-guard>
            <div class="split-actions">
              <div>
                <span class="pill">Secrets</span>
                <h3>🔒 Credentials &amp; Secret Runtime Fields</h3>
                <p>Isolated surface for API keys, bot tokens, passwords, and other sensitive values across all services. Non-secret runtime configuration lives on the Workloads page under Runtime Profiles.</p>
                <p class="secrets-guard-note">Values are masked by default. Use <strong>Reveal values</strong> only when you need to read or edit a secret, and hide them again as soon as you are done.</p>
              </div>
              <div class="secrets-guard-actions">
                <button id="secretsRevealToggle" class="secrets-reveal-btn" type="button" aria-pressed="false">Reveal values</button>
              </div>
            </div>
          </div>
          <div id="secretsHost" class="section-list"></div>
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
          <button id="refreshRuntimeButtonSecondary">Refresh</button>
        </div>
        <div id="runtimeSummary" class="metric-grid"></div>
        <div id="runtimeMeta" class="meta-list"></div>
      </section>
      <details class="panel" open>
        <summary><strong>Definitions</strong></summary>
        <div class="hint-list" style="margin-top: 14px;">
          <p><strong>Workloads</strong> is the composed operational page for remote workloads, bedrock servers, managed apps, workflows and jobs, agents, runtime profiles, and feature flags.</p>
          <p><strong>Secrets</strong> isolates credentials, secret env vars, and secret-bearing runtime fields.</p>
          <p><strong>Nodes</strong> are remote worker machines and their host-level setup. Workloads that run on a node are configured under the Workloads page.</p>
          <p><strong>Bootstrap</strong> covers gateway server, admin UI, and nginx/systemd plumbing.</p>
          <p><strong>Monitor</strong> holds health, benchmarks, and monitoring settings.</p>
        </div>
      </details>
    </aside>
  </main>

  <dialog id="rawJsonDialog" class="wizard-dialog">
    <div class="wizard-content">
      <div class="wizard-header">
        <h2>Raw Config JSON</h2>
        <button id="closeRawJsonDialogButton" class="wizard-close">&times;</button>
      </div>
      <p>Exact config file representation. Use this only when the guided tabs are not enough.</p>
      <textarea id="rawJson" spellcheck="false" style="width: 100%; min-height: 500px; font-family: monospace; font-size: 13px;"></textarea>
      <div class="toolbar" style="margin-top:.75rem">
        <button id="applyRawButton" class="primary">Apply Raw JSON</button>
      </div>
    </div>
  </dialog>

  <dialog id="nodeSetupWizard" class="wizard-dialog">
    <div class="wizard-content">
      <div class="wizard-header">
        <h2>Setup New Node</h2>
        <button id="closeNodeSetupWizardButton" class="wizard-close">&times;</button>
      </div>

      <div id="wizardStepPreset" class="wizard-step">
        <p class="wizard-desc">What kind of node are you setting up?</p>
        <div class="wizard-preset-grid">
          <button class="wizard-preset-card" data-preset="general">
            <strong>General Linux Node</strong>
            <small>Standard Docker worker with <code>/srv/builds</code>, <code>/srv/stacks</code>, <code>/srv/volumes</code> roots.</small>
          </button>
          <button class="wizard-preset-card" data-preset="gpu">
            <strong>GPU Compute Node</strong>
            <small>Docker + NVIDIA runtime for LLM, STT, and CV APIs.</small>
          </button>
          <button class="wizard-preset-card" data-preset="pi">
            <strong>Raspberry Pi Edge</strong>
            <small>Lighter edge node for proxy-style services.</small>
          </button>
          <button class="wizard-preset-card" data-preset="custom">
            <strong>Custom</strong>
            <small>Set all paths and options manually.</small>
          </button>
        </div>
        <div class="wizard-actions">
          <button id="wizPresetCancelButton" class="wizard-btn-secondary">Cancel</button>
          <button id="wizPresetNextButton" class="wizard-btn-primary" disabled>Next</button>
        </div>
      </div>

      <div id="wizardStepForm" class="wizard-step" hidden>
        <p class="wizard-desc">Enter the connection details and verify the directory paths for this node.</p>
        <div class="wizard-form-grid">
          <label class="wizard-field">
            <span>Node ID <small>(short name)</small></span>
            <input id="wizNodeId" placeholder="e.g. gpu-01, edge-pi" />
          </label>
          <label class="wizard-field">
            <span>Host <small>(IP or hostname)</small></span>
            <input id="wizHost" placeholder="e.g. 192.168.1.50" />
          </label>
          <label class="wizard-field">
            <span>SSH Port</span>
            <input id="wizSshPort" type="number" value="22" />
          </label>
          <label class="wizard-field">
            <span>Your SSH username on target</span>
            <input id="wizAdminUser" placeholder="e.g. jim" />
          </label>
          <label class="wizard-field">
            <span>Password <small>(for initial SSH — not stored)</small></span>
            <input id="wizAdminPassword" type="password" placeholder="leave blank if key auth works" />
          </label>
          <label class="wizard-field">
            <span>Description</span>
            <input id="wizDescription" placeholder="e.g. Main Docker worker" />
          </label>
          <label class="wizard-field">
            <span>Poll Interval <small>(seconds)</small></span>
            <input id="wizPollInterval" type="number" value="15" />
          </label>
          <label class="wizard-field">
            <span>Build Root</span>
            <input id="wizBuildRoot" value="/srv/builds" />
          </label>
          <label class="wizard-field">
            <span>Stack Root</span>
            <input id="wizStackRoot" value="/srv/stacks" />
          </label>
          <label class="wizard-field">
            <span>Volume Root</span>
            <input id="wizVolumeRoot" value="/srv/volumes" />
          </label>
        </div>
        <div class="wizard-actions">
          <button id="wizFormBackButton" class="wizard-btn-secondary">Back</button>
          <button id="wizStartSetupButton" class="wizard-btn-primary">Start Setup</button>
        </div>
      </div>

      <div id="wizardStepProgress" class="wizard-step" hidden>
        <div id="wizProgressLog" class="wizard-log"></div>
        <div id="wizardStepActions" class="wizard-actions" hidden>
          <button id="wizAddToConfigButton" class="wizard-btn-primary" hidden>Add Node to Config</button>
          <button id="wizCloseFinishedButton" class="wizard-btn-secondary" hidden>Close</button>
        </div>
      </div>
    </div>
  </dialog>

  <dialog id="serviceDeployWizard" class="wizard-dialog">
    <div class="wizard-content">
      <div class="wizard-header">
        <h2>Deploy a Service</h2>
        <button id="closeSvcWizardButton" class="wizard-close">&times;</button>
      </div>

      <div id="svcStepCatalog" class="wizard-step">
        <p class="wizard-desc">Choose a service to deploy to one of your worker nodes.</p>
        <div class="wizard-preset-grid">
          <button class="svc-catalog-card" data-svc="stt-service">
            <strong>Speech to Text</strong>
            <small>Guided install for <code>stt-service</code> with faster-whisper, optional pyannote diarization, and GPU-friendly defaults.</small>
          </button>
          <button class="svc-catalog-card" data-svc="llm-service">
            <strong>Local LLM Service</strong>
            <small>Guided install for <code>llm-service</code> with llama.cpp, model-management API, and shared-GPU guardrails.</small>
          </button>
          <button class="svc-catalog-card" data-svc="cv-sam-service">
            <strong>CV / SAM Service</strong>
            <small>Guided install for <code>cv-sam-service</code> with Segment Anything, image analysis endpoints, and workflow-ready defaults.</small>
          </button>
          <button class="svc-catalog-card" data-svc="container-service">
            <strong>Custom Container Service</strong>
            <small>Deploy any Docker image as a long-running service with health checks, ports, and volume mounts.</small>
          </button>
          <button class="svc-catalog-card" data-svc="container-job">
            <strong>Scheduled Container Job</strong>
            <small>Build and run a containerised task on a cron schedule (e.g. data pipelines, backups).</small>
          </button>
        </div>
        <div class="wizard-actions">
          <button id="svcCatalogCancelBtn" class="wizard-btn-secondary">Cancel</button>
          <button id="svcCatalogNextBtn" class="wizard-btn-primary" disabled>Next</button>
        </div>
      </div>

      <div id="svcStepConfig" class="wizard-step" hidden>
        <p class="wizard-desc" id="svcConfigDesc">Configure the service for your node.</p>
        <div id="svcConfigFields" class="wizard-form-grid"></div>
        <div class="wizard-actions">
          <button id="svcConfigBackBtn" class="wizard-btn-secondary">Back</button>
          <button id="svcConfigDeployBtn" class="wizard-btn-primary">Save &amp; Deploy</button>
        </div>
      </div>

      <div id="svcStepDeploy" class="wizard-step" hidden>
        <div id="svcDeployLog" class="wizard-log"></div>
        <div id="svcDeployActions" class="wizard-actions" hidden>
          <button id="svcDeployCloseBtn" class="wizard-btn-secondary">Close</button>
        </div>
      </div>
    </div>
  </dialog>

  <dialog id="managedAppWizard" class="wizard-dialog">
    <div class="wizard-content">
      <div class="wizard-header">
        <h2>Add Managed App</h2>
        <button id="closeManagedAppWizardButton" class="wizard-close">&times;</button>
      </div>

      <div id="managedAppStepCatalog" class="wizard-step">
        <p class="wizard-desc">Choose a managed gateway app preset, then review the generated blue/green deploy settings before it is added to config.</p>
        <div class="wizard-preset-grid">
          <button class="svc-catalog-card" data-managed-app="gateway-tools-platform">
            <strong>Gateway Tools Platform</strong>
            <small>Blue/green public tools UI behind Cloudflare Access. Preconfigures ports <code>3000/3001</code>, <code>/api/health</code>, and the dedicated upstream slot wiring.</small>
          </button>
          <button class="svc-catalog-card" data-managed-app="blank">
            <strong>Blank Managed App</strong>
            <small>Start from an empty blue/green app definition and fill in repo, ports, routing, and start/stop commands yourself.</small>
          </button>
        </div>
        <div class="wizard-actions">
          <button id="managedAppCatalogCancelBtn" class="wizard-btn-secondary">Cancel</button>
          <button id="managedAppCatalogNextBtn" class="wizard-btn-primary" disabled>Next</button>
        </div>
      </div>

      <div id="managedAppStepConfig" class="wizard-step" hidden>
        <p class="wizard-desc" id="managedAppConfigDesc">Review the generated app configuration.</p>
        <div id="managedAppConfigFields" class="wizard-form-grid"></div>
        <div class="wizard-actions">
          <button id="managedAppConfigBackBtn" class="wizard-btn-secondary">Back</button>
          <button id="managedAppConfigAddBtn" class="wizard-btn-primary">Add App</button>
        </div>
      </div>
    </div>
  </dialog>

  <div class="action-dock">
    <div class="action-dock-header">
      <span class="action-dock-title">Actions</span>
      <button id="toggleActionFeedButton" class="action-dock-toggle">Hide History</button>
    </div>
    <div id="status" class="status-ok">Current</div>
    <div id="currentAction" class="current-action is-idle" aria-live="polite">
      <div class="current-action-label">Current Action</div>
      <div class="current-action-message" id="currentActionMessage">Nothing running. Triggered actions appear here.</div>
      <div class="current-action-time" id="currentActionTime"></div>
    </div>
    <div id="actionFeed" class="action-feed">
      <p class="action-feed-empty">No recent actions.</p>
    </div>
  </div>
`;
