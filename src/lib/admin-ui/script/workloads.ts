/**
 * Admin UI — workloads/nodes renderers browser-runtime module.
 * Extracted from script.ts.
 */

export const WORKLOADS_SCRIPT = `    function workerNodeOptions(selectedNodeId) {
      if (state.config.workerNodes.length === 0) {
        return '<option value="">No worker nodes configured</option>';
      }
      return state.config.workerNodes
        .map((node) => \`<option value="\${node.id}" \${node.id === selectedNodeId ? 'selected' : ''}>\${node.id || '(unset node id)'}</option>\`)
        .join('');
    }

    function firstWorkerNodeId() {
      const namedNode = state.config.workerNodes.find((node) => typeof node.id === 'string' && node.id.trim().length > 0);
      return namedNode ? namedNode.id : '';
    }

    function firstGpuWorkerNodeId() {
      const gpuNode = state.config.workerNodes.find((node) => {
        const haystack = [node.id, node.description, node.host]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes('gpu') || haystack.includes('cuda') || haystack.includes('tags-node');
      });
      return gpuNode?.id || firstWorkerNodeId();
    }

    function nextWorkerNodeId() {
      if (!state.config.workerNodes.some((node) => node.id === 'core-node')) {
        return 'core-node';
      }
      let index = 1;
      while (state.config.workerNodes.some((node) => node.id === \`worker-node-\${index}\`)) {
        index += 1;
      }
      return \`worker-node-\${index}\`;
    }

    function nextAvailableSpecificNodeId(baseId) {
      const normalized = slugifyIdentifier(baseId) || nextWorkerNodeId();
      if (!state.config.workerNodes.some((node) => node.id === normalized)) {
        return normalized;
      }
      let index = 2;
      while (state.config.workerNodes.some((node) => node.id === \`\${normalized}-\${index}\`)) {
        index += 1;
      }
      return \`\${normalized}-\${index}\`;
    }

    function ensureRemoteWorkloadNodeId(workload) {
      if (typeof workload.nodeId === 'string' && workload.nodeId.trim().length > 0) {
        return workload.nodeId;
      }
      const fallbackNodeId = firstWorkerNodeId();
      if (!fallbackNodeId) {
        throw new Error('Add a worker node in Nodes first. Give it a Node Id and host, then come back to Minecraft.');
      }
      workload.nodeId = fallbackNodeId;
      return fallbackNodeId;
    }

    function normalizeRemoteWorkloadNodeIds() {
      state.config.remoteWorkloads.forEach((workload) => {
        if (!workload.nodeId) {
          const fallbackNodeId = firstWorkerNodeId();
          if (fallbackNodeId) {
            workload.nodeId = fallbackNodeId;
          }
        }
      });
    }

    function createDefaultMinecraftPack() {
      return {
        id: '',
        sourcePath: '',
        manifestUuid: '',
        manifestVersion: [1, 0, 0]
      };
    }

    function createDefaultMinecraftConfig() {
      return {
        image: 'itzg/minecraft-bedrock-server:latest',
        networkMode: 'host',
        serverName: '',
        worldName: '',
        gameMode: 'survival',
        difficulty: 'normal',
        worldCopyMode: 'if-missing',
        allowCheats: false,
        onlineMode: true,
        maxPlayers: 10,
        serverPort: 19132,
        autoStart: true,
        autoUpdateEnabled: true,
        autoUpdateSchedule: '*-*-* 04:00:00',
        texturepackRequired: false,
        behaviorPacks: [],
        resourcePacks: []
      };
    }

    function createDefaultBedrockWorkload() {
      return {
        id: '',
        enabled: true,
        nodeId: firstWorkerNodeId(),
        description: '',
        kind: 'minecraft-bedrock-server',
        minecraft: createDefaultMinecraftConfig()
      };
    }

    function createDefaultRemoteJobWorkload() {
      return {
        id: '',
        enabled: true,
        nodeId: firstWorkerNodeId(),
        description: '',
        kind: 'scheduled-container-job',
        job: {
          schedule: '*-*-* 03:00:00',
          timezone: 'America/New_York',
          build: {
            strategy: 'generated-node',
            repoUrl: '',
            defaultRevision: 'main',
            contextPath: '.',
            packageRoot: '.',
            nodeVersion: '24',
            installCommand: 'npm ci --omit=dev'
          },
          runCommand: '',
          environment: [],
          volumeMounts: [],
          jsonFiles: []
        }
      };
    }

    function createDefaultContainerServiceWorkload() {
      return {
        id: '',
        enabled: true,
        nodeId: firstWorkerNodeId(),
        description: '',
        kind: 'container-service',
        service: {
          image: '',
          networkMode: 'bridge',
          restartPolicy: 'unless-stopped',
          autoStart: true,
          runtimeClass: 'default',
          command: '',
          environment: [],
          volumeMounts: [],
          jsonFiles: [],
          ports: [],
          healthCheck: {
            protocol: 'http',
            port: 8000,
            path: '/health',
            expectedStatus: 200
          }
        }
      };
    }

    function createWorkerNodePreset(kind) {
      if (kind === 'gpu') {
        return {
          id: nextAvailableSpecificNodeId('gpu-node'),
          enabled: true,
          description: 'GPU compute worker',
          host: '',
          sshUser: 'deploy',
          sshPort: 22,
          buildRoot: '/data/docker/builds',
          stackRoot: '/data/docker/stacks',
          volumeRoot: '/data/docker/volumes',
          workerPollIntervalSeconds: 15,
          nodeCommand: '/usr/bin/node',
          systemdUnitDirectory: '/etc/systemd/system',
          systemdReloadCommand: 'sudo systemctl daemon-reload',
          systemdEnableTimerCommand: 'sudo systemctl enable --now',
          dockerCommand: 'docker',
          dockerComposeCommand: 'docker compose'
        };
      }

      if (kind === 'pi') {
        return {
          id: nextAvailableSpecificNodeId('pi-node'),
          enabled: true,
          description: 'Raspberry Pi edge worker',
          host: '',
          sshUser: 'deploy',
          sshPort: 22,
          buildRoot: '/opt/builds',
          stackRoot: '/opt/stacks',
          volumeRoot: '/opt/volumes',
          workerPollIntervalSeconds: 30,
          nodeCommand: '/usr/bin/node',
          systemdUnitDirectory: '/etc/systemd/system',
          systemdReloadCommand: 'sudo systemctl daemon-reload',
          systemdEnableTimerCommand: 'sudo systemctl enable --now',
          dockerCommand: 'docker',
          dockerComposeCommand: 'docker compose'
        };
      }

      return {
        id: nextWorkerNodeId(),
        enabled: true,
        description: 'Remote worker node',
        host: '',
        sshUser: 'deploy',
        sshPort: 22,
        buildRoot: '/srv/builds',
        stackRoot: '/srv/stacks',
        volumeRoot: '/srv/volumes',
        workerPollIntervalSeconds: 15,
        nodeCommand: '/usr/bin/node',
        systemdUnitDirectory: '/etc/systemd/system',
        systemdReloadCommand: 'sudo systemctl daemon-reload',
        systemdEnableTimerCommand: 'sudo systemctl enable --now',
        dockerCommand: 'docker',
        dockerComposeCommand: 'docker compose'
      };
    }

    function appendWorkerNode(node) {
      state.config.workerNodes.push(node);
      normalizeRemoteWorkloadNodeIds();
      renderWorkerNodes();
      renderRemoteWorkloads();
      renderBedrockServers();
      renderPiProxyProfile();
      syncRawJson();
    }

    function createSttTranscriptWorkload() {
      return {
        id: 'stt-transcript',
        enabled: true,
        nodeId: firstWorkerNodeId(),
        description: 'GPU-backed transcript API using Insanely Fast Whisper',
        kind: 'container-service',
        service: {
          image: 'yoeven/insanely-fast-whisper-api:latest',
          networkMode: 'bridge',
          restartPolicy: 'unless-stopped',
          autoStart: true,
          runtimeClass: 'nvidia',
          environment: [
            {
              key: 'ADMIN_KEY',
              value: '',
              secret: true,
              description: 'Optional admin token for the API'
            }
          ],
          volumeMounts: [],
          jsonFiles: [],
          ports: [
            { published: 9001, target: 9000, protocol: 'tcp' }
          ],
          healthCheck: {
            protocol: 'tcp',
            port: 9001
          }
        }
      };
    }

    function createSttDiarizationWorkload() {
      return {
        id: 'stt-diarization',
        enabled: true,
        nodeId: firstWorkerNodeId(),
        description: 'GPU-backed transcript + speaker diarization API using Insanely Fast Whisper',
        kind: 'container-service',
        service: {
          image: 'yoeven/insanely-fast-whisper-api:latest',
          networkMode: 'bridge',
          restartPolicy: 'unless-stopped',
          autoStart: true,
          runtimeClass: 'nvidia',
          environment: [
            {
              key: 'HF_TOKEN',
              value: '',
              secret: true,
              description: 'Required for pyannote diarization models'
            },
            {
              key: 'ADMIN_KEY',
              value: '',
              secret: true,
              description: 'Optional admin token for the API'
            }
          ],
          volumeMounts: [],
          jsonFiles: [],
          ports: [
            { published: 9002, target: 9000, protocol: 'tcp' }
          ],
          healthCheck: {
            protocol: 'tcp',
            port: 9002
          }
        }
      };
    }

    function parsePackVersion(value) {
      const trimmed = value.trim();
      if (!trimmed) {
        return [1, 0, 0];
      }
      return trimmed.split('.').map((part) => Number(part.trim())).filter((part) => Number.isInteger(part) && part >= 0);
    }

    function slugifyIdentifier(value) {
      return String(value || '')
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '-')
        .replaceAll(/^-+|-+$/g, '');
    }

    function deriveBedrockWorkloadId(minecraft) {
      const base = slugifyIdentifier(minecraft.worldName || minecraft.serverName || 'server');
      return \`bedrock-\${base || 'server'}\`;
    }

    function deriveBedrockDescription(minecraft) {
      const label = minecraft.serverName || minecraft.worldName || 'server';
      return \`Minecraft Bedrock server: \${label}\`;
    }

    function applyBedrockIdentityDefaults(workload, previousMinecraft, nextMinecraft) {
      const previousId = deriveBedrockWorkloadId(previousMinecraft || {});
      const nextId = deriveBedrockWorkloadId(nextMinecraft || {});
      if (!workload.id || workload.id === previousId) {
        workload.id = nextId;
      }

      const previousDescription = deriveBedrockDescription(previousMinecraft || {});
      const nextDescription = deriveBedrockDescription(nextMinecraft || {});
      if (!workload.description || workload.description === previousDescription) {
        workload.description = nextDescription;
      }
    }

    function renderNodesInventorySummary() {
      const grid = document.getElementById('nodesInventoryGrid');
      if (!grid) {
        return;
      }
      const nodes = (state.config && Array.isArray(state.config.workerNodes)) ? state.config.workerNodes : [];
      const workloads = (state.config && Array.isArray(state.config.remoteWorkloads)) ? state.config.remoteWorkloads : [];
      const enabled = nodes.filter(function(n) { return n.enabled; }).length;
      const disabled = nodes.length - enabled;
      const hostsSeen = new Set();
      nodes.forEach(function(n) { if (n.host) hostsSeen.add(n.host); });
      const workloadsEnabled = workloads.filter(function(w) { return w.enabled; }).length;

      function set(kind, value, detail) {
        const c = grid.querySelector('[data-nodes-inventory="' + kind + '"]');
        const d = grid.querySelector('[data-nodes-inventory-detail="' + kind + '"]');
        if (c) c.textContent = String(value);
        if (d) d.textContent = detail;
      }
      set('total', nodes.length, nodes.length === 0
        ? 'No worker nodes configured yet.'
        : hostsSeen.size + ' distinct host' + (hostsSeen.size === 1 ? '' : 's') + ' · SSH targets registered.');
      set('enabled', enabled, disabled === 0
        ? (enabled === 0 ? 'No nodes enabled.' : 'All configured nodes accept deploys.')
        : disabled + ' disabled, ' + enabled + ' accept deploys.');
      set('workloads', workloads.length, workloads.length === 0
        ? 'No remote workloads bound to a node.'
        : workloadsEnabled + ' enabled of ' + workloads.length + ' defined.');
    }

    function renderWorkerNodes() {
      const container = document.getElementById('workerNodesContainer');
      container.innerHTML = '';
      renderNodesInventorySummary();
      if (state.config.workerNodes.length === 0) {
        container.innerHTML = '<p>No worker nodes configured yet.</p>';
        return;
      }

      state.config.workerNodes.forEach((node, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${node.id || 'new-worker-node'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${node.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Node Id<input data-field="id" value="\${node.id}" /></label>
            <label>Description<input data-field="description" value="\${node.description || ''}" /></label>
            <label>Host<input data-field="host" value="\${node.host}" /></label>
            <label>SSH User<input data-field="sshUser" value="\${node.sshUser}" /></label>
            <label>SSH Port<input type="number" data-field="sshPort" value="\${node.sshPort}" /></label>
          </div>
          <div class="row">
            <label>Build Root<input data-field="buildRoot" value="\${node.buildRoot}" /></label>
            <label>Stack Root<input data-field="stackRoot" value="\${node.stackRoot}" /></label>
            <label>Volume Root<input data-field="volumeRoot" value="\${node.volumeRoot}" /></label>
            <label>Worker Poll Seconds<input type="number" data-field="workerPollIntervalSeconds" value="\${node.workerPollIntervalSeconds || 15}" /></label>
          </div>
          <div class="row">
            <label>Node Command<input data-field="nodeCommand" value="\${node.nodeCommand || 'node'}" /></label>
            <label>systemd Unit Directory<input data-field="systemdUnitDirectory" value="\${node.systemdUnitDirectory || ''}" placeholder="/etc/systemd/system" /></label>
            <label>systemd Reload Command<input data-field="systemdReloadCommand" value="\${node.systemdReloadCommand || ''}" placeholder="sudo systemctl daemon-reload" /></label>
            <label>systemd Enable Timer Command<input data-field="systemdEnableTimerCommand" value="\${node.systemdEnableTimerCommand || ''}" placeholder="sudo systemctl enable --now" /></label>
          </div>
          <div class="row">
            <label>Docker Command<input data-field="dockerCommand" value="\${node.dockerCommand}" /></label>
            <label>Docker Compose Command<input data-field="dockerComposeCommand" value="\${node.dockerComposeCommand}" /></label>
          </div>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          state.config.workerNodes.splice(index, 1);
          renderWorkerNodes();
          renderRemoteWorkloads();
          renderBedrockServers();
          renderPiProxyProfile();
          syncRawJson();
        });

        element.querySelectorAll('input').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          input.addEventListener(isCheckbox ? 'change' : 'input', () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            node[field] = isCheckbox ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
            if (
              (field === 'systemdUnitDirectory' || field === 'systemdReloadCommand' || field === 'systemdEnableTimerCommand') &&
              !input.value.trim()
            ) {
              delete node[field];
            }
            if (isCheckbox) {
              renderRemoteWorkloads();
              renderBedrockServers();
            }
            renderPiProxyProfile();
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderRemoteWorkloads() {
      renderRemoteServicesOverview();
      const container = document.getElementById('remoteWorkloadsContainer');
      container.innerHTML = '';
      if (state.config.remoteWorkloads.length === 0) {
        container.innerHTML = '<p>No remote workloads configured yet.</p>';
        return;
      }

      state.config.remoteWorkloads.forEach((workload, index) => {
        const isJob = workload.kind === 'scheduled-container-job';
        const isService = workload.kind === 'container-service';
        const isMinecraft = workload.kind === 'minecraft-bedrock-server';
        const job = workload.job || {
          schedule: '*-*-* 03:00:00',
          timezone: 'America/New_York',
          build: {
            strategy: 'generated-node',
            repoUrl: '',
            defaultRevision: 'main',
            contextPath: '.',
            packageRoot: '.',
            nodeVersion: '24',
            installCommand: 'npm ci --omit=dev'
          },
          runCommand: '',
          environment: [],
          volumeMounts: [],
          jsonFiles: []
        };
        const service = workload.service || createDefaultContainerServiceWorkload().service;
        const minecraft = workload.minecraft || {
          image: 'itzg/minecraft-bedrock-server:latest',
          serverName: '',
          worldName: '',
          gameMode: 'survival',
          difficulty: 'normal',
          worldCopyMode: 'if-missing',
          allowCheats: false,
          onlineMode: true,
          maxPlayers: 10,
          serverPort: 19132,
          autoStart: true,
          autoUpdateEnabled: true,
          autoUpdateSchedule: '*-*-* 04:00:00',
          texturepackRequired: false,
          behaviorPacks: [],
          resourcePacks: []
        };
        const serviceStatus = workload.id ? state.remoteServiceStatuses[workload.id] : null;
        const serviceSummary = describeContainerStatus(serviceStatus?.service);
        const serviceHealthSummary = describeServiceHealthCheck(serviceStatus?.healthCheck);
        const servicePortSummary = serviceStatus
          ? (formatPortMappings(serviceStatus.service?.ports, serviceStatus.service?.networkMode) !== 'none'
            ? formatPortMappings(serviceStatus.service?.ports, serviceStatus.service?.networkMode)
            : service.ports && service.ports.length > 0
              ? service.ports.map(p => p.published + ':' + p.target + '/' + p.protocol).join(', ') + ' (from config)'
              : 'none')
          : 'not checked yet';
        const serviceConfiguredImage = serviceStatus?.service?.configuredImage || service.image || 'build-only workload';
        const serviceImageId = serviceStatus?.service?.imageId || 'not checked yet';
        const serviceCreatedLine = serviceStatus?.service?.createdAt
          ? '<p><strong>Created:</strong> ' + formatTimestamp(serviceStatus.service.createdAt) + '</p>'
          : '';
        const serviceStartedLine = serviceStatus?.service?.startedAt
          ? '<p><strong>Started:</strong> ' + formatTimestamp(serviceStatus.service.startedAt) + '</p>'
          : '';
        const serviceErrorLine = serviceStatus?.service?.error
          ? '<p><strong>Service Error:</strong> ' + escapeHtml(serviceStatus.service.error) + '</p>'
          : '';
        const containerLines = serviceStatus?.containers && serviceStatus.containers.length > 0
          ? '<div style="margin-top:.5rem"><strong>Containers:</strong><table class="mini-table"><thead><tr><th>Service</th><th>Name</th><th>State</th><th>Status</th></tr></thead><tbody>'
            + serviceStatus.containers.map(c => {
              const cls = c.state === 'running' ? 'ok' : c.state === 'exited' ? 'error' : '';
              return '<tr><td>' + escapeHtml(c.service) + '</td><td><code>' + escapeHtml(c.name) + '</code></td><td class="' + cls + '">' + escapeHtml(c.state) + '</td><td>' + escapeHtml(c.status) + '</td></tr>';
            }).join('')
            + '</tbody></table></div>'
          : '';
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div>
              <strong>\${workload.id || 'new-remote-workload'}</strong>
              <p>\${workload.description || 'Remote containerized workload'}</p>
            </div>
            <div class="toolbar">
              <button data-action="deploy">Deploy</button>
              <button data-action="remove" class="danger">Remove</button>
            </div>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${workload.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Workload Id<input data-field="id" value="\${workload.id}" /></label>
            <label>Description<input data-field="description" value="\${workload.description || ''}" /></label>
            <label>Node<select data-field="nodeId">\${workerNodeOptions(workload.nodeId)}</select></label>
            <label>Kind
              <select data-field="kind">
                <option value="scheduled-container-job" \${isJob ? 'selected' : ''}>scheduled-container-job</option>
                <option value="container-service" \${isService ? 'selected' : ''}>container-service</option>
                <option value="minecraft-bedrock-server" \${isMinecraft ? 'selected' : ''}>minecraft-bedrock-server</option>
              </select>
            </label>
            <label>Deploy Revision<input data-control="deployRevision" placeholder="optional sha/tag" /></label>
          </div>
          \${isJob ? \`
            <div class="card">
              <span class="pill">Container Job</span>
              <div class="row">
                <label>Schedule<input data-job-field="schedule" value="\${job.schedule}" /></label>
                <label>Timezone<input data-job-field="timezone" value="\${job.timezone}" /></label>
                <label>Build Strategy
                  <select data-job-build-field="strategy">
                    <option value="generated-node" \${job.build.strategy === 'generated-node' ? 'selected' : ''}>generated-node</option>
                    <option value="repo-dockerfile" \${job.build.strategy === 'repo-dockerfile' ? 'selected' : ''}>repo-dockerfile</option>
                  </select>
                </label>
                <label>Repo URL<input data-job-build-field="repoUrl" value="\${job.build.repoUrl}" /></label>
                <label>Default Revision<input data-job-build-field="defaultRevision" value="\${job.build.defaultRevision}" /></label>
                <label>Context Path<input data-job-build-field="contextPath" value="\${job.build.contextPath}" /></label>
              </div>
              <div class="row">
                <label>Dockerfile Path<input data-job-build-field="dockerfilePath" value="\${job.build.dockerfilePath || ''}" /></label>
                <label>Package Root<input data-job-build-field="packageRoot" value="\${job.build.packageRoot || ''}" /></label>
                <label>Node Version<input data-job-build-field="nodeVersion" value="\${job.build.nodeVersion || ''}" /></label>
                <label>Install Command<input data-job-build-field="installCommand" value="\${job.build.installCommand || ''}" /></label>
              </div>
              <label>Run Command<input data-job-field="runCommand" value="\${job.runCommand}" /></label>
              <label>Environment JSON<textarea data-job-json="environment">\${JSON.stringify(job.environment || [], null, 2)}</textarea></label>
              <label>Volume Mounts JSON<textarea data-job-json="volumeMounts">\${JSON.stringify(job.volumeMounts || [], null, 2)}</textarea></label>
              <label>Runtime JSON Files<textarea data-job-json="jsonFiles">\${JSON.stringify(job.jsonFiles || [], null, 2)}</textarea></label>
            </div>
          \` : isService ? \`
            <div class="card">
              <div class="split-actions">
                <div>
                  <span class="pill">Container Service</span>
                  <p><strong>Status:</strong> \${serviceSummary}</p>
                  <p><strong>Network Mode:</strong> \${serviceStatus?.service?.networkMode || service.networkMode}</p>
                  <p><strong>Ports:</strong> \${servicePortSummary}</p>
                  <p><strong>Image:</strong> \${formatInlineValue(serviceConfiguredImage)}</p>
                  <p><strong>Image ID:</strong> \${formatInlineValue(serviceImageId)}</p>
                  <p><strong>Health:</strong> \${escapeHtml(serviceHealthSummary)}</p>
                  \${serviceCreatedLine}
                  \${serviceStartedLine}
                  \${serviceErrorLine}
                  \${containerLines}
                </div>
                <div class="toolbar">
                  <button data-action="service-refresh-status">Refresh Status</button>
                  <button data-action="service-deploy-log">View Deploy</button>
                  <button data-action="service-logs">View Logs</button>
                  <button data-action="service-start">Start</button>
                  <button data-action="service-stop">Stop</button>
                  <button data-action="service-restart">Restart</button>
                </div>
              </div>
              <div data-panel="service-logs" hidden>
                <div class="toolbar" style="margin-bottom:.5rem">
                  <select data-control="logsService">
                    <option value="">All services</option>
                    \${(serviceStatus?.containers || []).map(c => '<option value="' + escapeHtml(c.service) + '">' + escapeHtml(c.service) + '</option>').join('')}
                  </select>
                  <button data-action="service-logs-refresh">Refresh</button>
                  <button data-action="service-logs-close">Close</button>
                </div>
                <pre class="wizard-log" data-output="service-logs" style="max-height:24rem;overflow:auto;font-size:.78rem"></pre>
              </div>
              </div>
              <div class="row">
                <label>Image<input data-service-field="image" value="\${service.image || ''}" placeholder="ghcr.io/example/service:latest" /></label>
                <label>Network Mode
                  <select data-service-field="networkMode">
                    <option value="bridge" \${service.networkMode === 'bridge' ? 'selected' : ''}>bridge</option>
                    <option value="host" \${service.networkMode === 'host' ? 'selected' : ''}>host</option>
                  </select>
                </label>
                <label>Restart Policy
                  <select data-service-field="restartPolicy">
                    <option value="unless-stopped" \${service.restartPolicy === 'unless-stopped' ? 'selected' : ''}>unless-stopped</option>
                    <option value="always" \${service.restartPolicy === 'always' ? 'selected' : ''}>always</option>
                    <option value="no" \${service.restartPolicy === 'no' ? 'selected' : ''}>no</option>
                  </select>
                </label>
                <label>Runtime Class
                  <select data-service-field="runtimeClass">
                    <option value="default" \${service.runtimeClass === 'default' ? 'selected' : ''}>default</option>
                    <option value="nvidia" \${service.runtimeClass === 'nvidia' ? 'selected' : ''}>nvidia</option>
                  </select>
                </label>
              </div>
              <div class="row">
                <label class="check"><input type="checkbox" data-service-field="autoStart" \${service.autoStart ? 'checked' : ''} /> Auto Start On Deploy</label>
                <label>Command<input data-service-field="command" value="\${service.command || ''}" placeholder="python app.py --host 0.0.0.0 --port 8000" /></label>
              </div>
              <label>Build JSON<textarea data-service-json="build">\${service.build ? JSON.stringify(service.build, null, 2) : ''}</textarea></label>
              <label>Environment JSON<textarea data-service-json="environment">\${JSON.stringify(service.environment || [], null, 2)}</textarea></label>
              <label>Volume Mounts JSON<textarea data-service-json="volumeMounts">\${JSON.stringify(service.volumeMounts || [], null, 2)}</textarea></label>
              <label>Runtime JSON Files<textarea data-service-json="jsonFiles">\${JSON.stringify(service.jsonFiles || [], null, 2)}</textarea></label>
              <label>Ports JSON<textarea data-service-json="ports">\${JSON.stringify(service.ports || [], null, 2)}</textarea></label>
              <label>Health Check JSON<textarea data-service-json="healthCheck">\${service.healthCheck ? JSON.stringify(service.healthCheck, null, 2) : ''}</textarea></label>
            </div>
          \` : \`
            <div class="card">
              <span class="pill">Bedrock</span>
              <p>Use the Bedrock tab for the streamlined server controls and pack management workflow.</p>
              <div class="row">
                <label>Image<input data-mc-field="image" value="\${minecraft.image}" /></label>
                <label>Server Name<input data-mc-field="serverName" value="\${minecraft.serverName}" /></label>
                <label>World Name<input data-mc-field="worldName" value="\${minecraft.worldName}" /></label>
                <label>Game Mode
                  <select data-mc-field="gameMode">
                    <option value="survival" \${minecraft.gameMode === 'survival' ? 'selected' : ''}>survival</option>
                    <option value="creative" \${minecraft.gameMode === 'creative' ? 'selected' : ''}>creative</option>
                    <option value="adventure" \${minecraft.gameMode === 'adventure' ? 'selected' : ''}>adventure</option>
                  </select>
                </label>
                <label>Difficulty
                  <select data-mc-field="difficulty">
                    <option value="peaceful" \${minecraft.difficulty === 'peaceful' ? 'selected' : ''}>peaceful</option>
                    <option value="easy" \${minecraft.difficulty === 'easy' ? 'selected' : ''}>easy</option>
                    <option value="normal" \${minecraft.difficulty === 'normal' ? 'selected' : ''}>normal</option>
                    <option value="hard" \${minecraft.difficulty === 'hard' ? 'selected' : ''}>hard</option>
                  </select>
                </label>
                <label>Seed<input data-mc-field="levelSeed" value="\${minecraft.levelSeed || ''}" /></label>
                <label>World Source Path<input data-mc-field="worldSourcePath" value="\${minecraft.worldSourcePath || ''}" placeholder="/mnt/storage/docker/shared/worlds/existing-world or .mcworld" /></label>
              </div>
              <div class="row">
                <label>World Copy Mode
                  <select data-mc-field="worldCopyMode">
                    <option value="if-missing" \${minecraft.worldCopyMode === 'if-missing' ? 'selected' : ''}>if-missing</option>
                    <option value="always" \${minecraft.worldCopyMode === 'always' ? 'selected' : ''}>always</option>
                  </select>
                </label>
                <label>Max Players<input type="number" data-mc-field="maxPlayers" value="\${minecraft.maxPlayers}" /></label>
                <label>Server Port<input type="number" data-mc-field="serverPort" value="\${minecraft.serverPort}" /></label>
                <label>Auto Update Schedule<input data-mc-field="autoUpdateSchedule" value="\${minecraft.autoUpdateSchedule}" /></label>
              </div>
              <div class="row">
                <label class="check"><input type="checkbox" data-mc-field="allowCheats" \${minecraft.allowCheats ? 'checked' : ''} /> Allow Cheats</label>
                <label class="check"><input type="checkbox" data-mc-field="onlineMode" \${minecraft.onlineMode ? 'checked' : ''} /> Online Mode</label>
                <label class="check"><input type="checkbox" data-mc-field="autoStart" \${minecraft.autoStart ? 'checked' : ''} /> Auto Start</label>
                <label class="check"><input type="checkbox" data-mc-field="autoUpdateEnabled" \${minecraft.autoUpdateEnabled ? 'checked' : ''} /> Auto Update</label>
                <label class="check"><input type="checkbox" data-mc-field="texturepackRequired" \${minecraft.texturepackRequired ? 'checked' : ''} /> Require Resource Packs</label>
              </div>
              <label>Behavior Packs JSON<textarea data-mc-json="behaviorPacks">\${JSON.stringify(minecraft.behaviorPacks || [], null, 2)}</textarea></label>
              <label>Resource Packs JSON<textarea data-mc-json="resourcePacks">\${JSON.stringify(minecraft.resourcePacks || [], null, 2)}</textarea></label>
              <div class="row">
                <label>Broadcast Message<input data-control="broadcastMessage" placeholder="Server message" /></label>
                <label>Player<input data-control="player" placeholder="player name" /></label>
                <label>Reason<input data-control="reason" placeholder="optional reason" /></label>
              </div>
              <div class="toolbar">
                <button data-action="mc-start">Start</button>
                <button data-action="mc-stop">Stop</button>
                <button data-action="mc-restart">Restart</button>
                <button data-action="mc-update">Update If Empty</button>
                <button data-action="mc-broadcast">Broadcast</button>
                <button data-action="mc-kick">Kick</button>
                <button data-action="mc-ban">Ban</button>
              </div>
            </div>
          \`}
        \`;

        element.querySelector('[data-action="remove"]').addEventListener('click', () => {
          state.config.remoteWorkloads.splice(index, 1);
          delete state.remoteServiceStatuses[workload.id];
          delete state.minecraftStatuses[workload.id];
          renderRemoteWorkloads();
          renderBedrockServers();
          syncRawJson();
        });

        element.querySelector('[data-action="deploy"]').addEventListener('click', async () => {
          const deployButton = element.querySelector('[data-action="deploy"]');
          await withBusyButton(deployButton, 'Deploying…', async () => {
            try {
              ensureRemoteWorkloadNodeId(workload);
              const workloadId = workload.id;
              const revision = element.querySelector('[data-control="deployRevision"]').value.trim();
              await persistConfigState({ renderAfterSave: false });
              const queued = await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workloadId)}/deploy\`, revision ? { revision } : {}, 30000);
              rememberRemoteDeployJobId(workloadId, queued.jobId);
              setStatus(
                (queued.message || \`Queued deploy for remote workload \${workloadId}\`) + (queued.jobId ? \` (\${queued.jobId})\` : ''),
                'progress'
              );
              const result = await waitForRemoteDeployJob(workloadId, queued.jobId);
              clearRememberedRemoteDeployJobId(workloadId);
              if (workload.kind === 'container-service') {
                try {
                  await refreshContainerServiceStatus(workloadId, { silent: true });
                  renderRemoteWorkloads();
                  setStatus(\`Deployed remote workload \${workloadId}\`);
                } catch (uiError) {
                  const detail = logClientError('refresh deployed remote workload ' + workloadId, uiError);
                  setStatus(\`Deployed remote workload \${workloadId}, but status refresh failed: \${detail}\`, 'error');
                }
              }
              if (workload.kind !== 'container-service') {
                setStatus(\`Deployed remote workload \${workloadId}\`);
              }
              if (result.deployLog) {
                try {
                  showDeployTelemetryModal(workloadId, result.deployLog, result.durationMs, true);
                } catch (uiError) {
                  const detail = logClientError('show deploy telemetry for remote workload ' + workloadId, uiError);
                  setStatus(\`Deployed remote workload \${workloadId}, but the telemetry viewer failed to open: \${detail}\`, 'error');
                }
              }
            } catch (error) {
              setStatus(describeClientError(error), 'error');
              if (error.deployLog) {
                try {
                  showDeployTelemetryModal(workload.id, error.deployLog, error.durationMs, false);
                } catch (uiError) {
                  logClientError('show failed deploy telemetry for remote workload ' + workload.id, uiError);
                }
              }
            }
          });
        });

        element.querySelectorAll('input[data-field], select[data-field]').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.field;
            if (!field) return;
            workload[field] = isCheckbox ? input.checked : input.value;
            if (field === 'kind') {
              if (input.value === 'scheduled-container-job') {
                workload.job = job;
                delete workload.service;
                delete workload.minecraft;
              } else if (input.value === 'container-service') {
                workload.service = service;
                delete workload.job;
                delete workload.minecraft;
              } else {
                workload.minecraft = minecraft;
                delete workload.job;
                delete workload.service;
              }
              renderRemoteWorkloads();
              renderBedrockServers();
            } else if (workload.kind === 'minecraft-bedrock-server') {
              renderBedrockServers();
            }
            syncRawJson();
          });
        });

        element.querySelectorAll('input[data-job-field], select[data-job-build-field], input[data-job-build-field]').forEach((input) => {
          input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
            workload.job = workload.job || job;
            if (input.dataset.jobField) {
              workload.job[input.dataset.jobField] = input.value;
            }
            if (input.dataset.jobBuildField) {
              workload.job.build[input.dataset.jobBuildField] = input.value;
            }
            syncRawJson();
          });
        });

        element.querySelectorAll('textarea[data-job-json]').forEach((textarea) => {
          textarea.addEventListener('change', () => {
            try {
              workload.job = workload.job || job;
              workload.job[textarea.dataset.jobJson] = parseJsonField(textarea.value, []);
              syncRawJson();
            } catch (error) {
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelectorAll('input[data-service-field], select[data-service-field]').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            workload.service = workload.service || createDefaultContainerServiceWorkload().service;
            const field = input.dataset.serviceField;
            if (!field) return;
            if (isCheckbox) {
              workload.service[field] = input.checked;
            } else {
              workload.service[field] = input.value || undefined;
              if (!input.value) delete workload.service[field];
            }
            syncRawJson();
          });
        });

        element.querySelectorAll('textarea[data-service-json]').forEach((textarea) => {
          textarea.addEventListener('change', () => {
            try {
              workload.service = workload.service || createDefaultContainerServiceWorkload().service;
              const field = textarea.dataset.serviceJson;
              if (!field) return;
              if (field === 'build' || field === 'healthCheck') {
                const parsed = parseOptionalJsonText(textarea.value);
                if (parsed === undefined) {
                  delete workload.service[field];
                } else {
                  workload.service[field] = parsed;
                }
              } else {
                workload.service[field] = parseJsonField(textarea.value, []);
              }
              syncRawJson();
            } catch (error) {
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelectorAll('input[data-mc-field], select[data-mc-field]').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            workload.minecraft = workload.minecraft || minecraft;
            const field = input.dataset.mcField;
            if (!field) return;
            if (isCheckbox) {
              workload.minecraft[field] = input.checked;
            } else if (input.type === 'number') {
              workload.minecraft[field] = Number(input.value);
            } else {
              workload.minecraft[field] = input.value || undefined;
              if (!input.value) delete workload.minecraft[field];
            }
            renderBedrockServers();
            syncRawJson();
          });
        });

        element.querySelectorAll('textarea[data-mc-json]').forEach((textarea) => {
          textarea.addEventListener('change', () => {
            try {
              workload.minecraft = workload.minecraft || minecraft;
              workload.minecraft[textarea.dataset.mcJson] = parseJsonField(textarea.value, []);
              renderBedrockServers();
              syncRawJson();
            } catch (error) {
              setStatus(error.message, 'error');
            }
          });
        });

        if (workload.kind === 'container-service') {
          const controlServiceAction = async (action) => {
            await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/service/\${action}\`, {});
            return await refreshContainerServiceStatus(workload.id);
          };

          [
            ['service-start', 'start'],
            ['service-stop', 'stop'],
            ['service-restart', 'restart']
          ].forEach(([buttonAction, action]) => {
            element.querySelector(\`[data-action="\${buttonAction}"]\`).addEventListener('click', async () => {
              try {
                await controlServiceAction(action);
                setStatus(\`Container service action completed: \${action}\`);
              } catch (error) {
                setStatus(error.message, 'error');
              }
            });
          });

          element.querySelector('[data-action="service-refresh-status"]').addEventListener('click', async () => {
            try {
              const refreshed = await refreshContainerServiceStatus(workload.id);
              setStatus('Container service status refreshed: ' + describeContainerStatus(refreshed.service));
            } catch (error) {
              setStatus(error.message, 'error');
            }
          });

          element.querySelector('[data-action="service-deploy-log"]')?.addEventListener('click', async () => {
            try {
              const knownJobId = state.remoteDeployJobIds[workload.id];
              let result = null;
              if (knownJobId) {
                try {
                  result = await requestJson(
                    'GET',
                    '/api/remote-workloads/' + encodeURIComponent(workload.id) + '/deploy-jobs/' + encodeURIComponent(knownJobId),
                    undefined,
                    20000
                  );
                } catch (jobError) {
                  const detail = describeClientError(jobError);
                  if (!detail.includes('not found')) {
                    throw jobError;
                  }
                }
              }
              if (!result) {
                result = await requestJson(
                  'GET',
                  '/api/remote-workloads/' + encodeURIComponent(workload.id) + '/deploy-jobs/latest',
                  undefined,
                  20000
                );
              }
              if (!result?.deployLog || result.deployLog.length === 0) {
                throw new Error('No deploy telemetry is available yet for ' + workload.id);
              }
              if (result?.jobId) {
                rememberRemoteDeployJobId(workload.id, result.jobId);
              }
              showDeployTelemetryModal(
                workload.id,
                result.deployLog,
                result.durationMs,
                result.status === 'success'
              );
            } catch (error) {
              setStatus(describeClientError(error), 'error');
            }
          });

          const logsPanel = element.querySelector('[data-panel="service-logs"]');
          const logsOutput = element.querySelector('[data-output="service-logs"]');
          const logsServiceSelect = element.querySelector('[data-control="logsService"]');

          async function fetchAndShowLogs() {
            const svc = logsServiceSelect?.value || '';
            const qs = svc ? '?service=' + encodeURIComponent(svc) + '&tail=200' : '?tail=200';
            try {
              logsOutput.textContent = 'Loading logs…';
              const result = await requestJson('GET', '/api/remote-workloads/' + encodeURIComponent(workload.id) + '/service-logs' + qs, undefined, 120000);
              logsOutput.textContent = (result.lines || []).join('\\n') || '(no output)';
              logsOutput.scrollTop = logsOutput.scrollHeight;
            } catch (error) {
              logsOutput.textContent = 'Error: ' + (error.message || error);
            }
          }

          element.querySelector('[data-action="service-logs"]').addEventListener('click', async () => {
            logsPanel.hidden = !logsPanel.hidden;
            if (!logsPanel.hidden) {
              await fetchAndShowLogs();
            }
          });
          element.querySelector('[data-action="service-logs-refresh"]')?.addEventListener('click', fetchAndShowLogs);
          element.querySelector('[data-action="service-logs-close"]')?.addEventListener('click', () => {
            logsPanel.hidden = true;
          });
        }

        if (workload.kind === 'minecraft-bedrock-server') {
          const controlAction = async (action) => {
            const message = element.querySelector('[data-control="broadcastMessage"]').value.trim();
            const player = element.querySelector('[data-control="player"]').value.trim();
            const reason = element.querySelector('[data-control="reason"]').value.trim();
            const body = {
              ...(message ? { message } : {}),
              ...(player ? { player } : {}),
              ...(reason ? { reason } : {})
            };
            await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/\${action}\`, body);
          };

          [
            ['mc-start', 'start'],
            ['mc-stop', 'stop'],
            ['mc-restart', 'restart'],
            ['mc-update', 'update-if-empty'],
            ['mc-broadcast', 'broadcast'],
            ['mc-kick', 'kick'],
            ['mc-ban', 'ban']
          ].forEach(([buttonAction, action]) => {
            element.querySelector(\`[data-action="\${buttonAction}"]\`).addEventListener('click', async () => {
              try {
                await controlAction(action);
                setStatus(\`Minecraft action completed: \${action}\`);
              } catch (error) {
                setStatus(error.message, 'error');
              }
            });
          });
        }

        container.appendChild(element);
      });
    }

    function renderRemoteServicesOverview() {
      const container = document.getElementById('remoteServicesOverview');
      if (!container) return;
      const services = state.config.remoteWorkloads.filter(w => w.kind === 'container-service');
      if (services.length === 0) {
        container.innerHTML = '<p class="wizard-hint" style="padding:.75rem">No container services deployed yet. Click <strong>Deploy a Service</strong> above to get started.</p>';
        return;
      }
      container.innerHTML = '';
      services.forEach(svc => {
        const status = state.remoteServiceStatuses[svc.id];
        const statusLabel = status
          ? (status.service?.running
            ? (status.containers && status.containers.length > 0 ? status.containers.filter(c => c.state === 'running').length + '/' + status.containers.length + ' running' : 'Running')
            : status.service?.status || 'Stopped')
          : 'Unknown';
        const statusCls = status ? (status.service?.running ? 'success' : 'error') : '';
        const healthLabel = status?.healthCheck ? (status.healthCheck.status === 'ok' ? ' \u2714' : ' \u274c ' + status.healthCheck.detail) : '';
        const node = state.config.workerNodes.find(n => n.id === svc.nodeId);
        const nodeLabel = node ? svc.nodeId + ' (' + node.host + ')' : svc.nodeId || 'unassigned';
        const ports = (svc.service && svc.service.ports || []).map(p => p.published + ':' + p.target).join(', ') || 'none';
        const card = document.createElement('div');
        card.className = 'card card-quiet';
        card.innerHTML = '<div class="split-actions"><div>' +
          '<strong>' + svc.id + '</strong>' +
          (svc.description ? ' &mdash; ' + svc.description : '') +
          '<br><small>Node: ' + nodeLabel + ' &bull; Ports: ' + ports + ' &bull; Status: <span class="' + statusCls + '">' + statusLabel + '</span>' + healthLabel + '</small>' +
          '</div></div>';
        container.appendChild(card);
      });
    }

    function renderBedrockServers() {
      const container = document.getElementById('bedrockServersContainer');
      container.innerHTML = '';
      if (!firstWorkerNodeId()) {
        container.innerHTML = '<div class="card"><strong>Worker Node Required</strong><p>Add a worker node in the <strong>Nodes</strong> tab first. Set a Node Id and host, then come back here to create a Bedrock server.</p></div>';
        return;
      }
      const workloads = state.config.remoteWorkloads.filter((workload) => workload.kind === 'minecraft-bedrock-server');
      if (workloads.length === 0) {
        container.innerHTML = '<p>No Bedrock servers configured yet.</p>';
        return;
      }

      workloads.forEach((workload) => {
        const minecraft = workload.minecraft || createDefaultMinecraftConfig();
        const minecraftStatus = state.minecraftStatuses[workload.id];
        const autoUpdate = minecraftStatus?.autoUpdate;
        const autoUpdateStatus = describeAutoUpdateStatus(autoUpdate);
        const manualUpdate = minecraftStatus?.manualUpdate;
        const lastManualUpdateResult = minecraftStatus?.lastManualUpdateResult;
        const workerSummary = describeContainerStatus(minecraftStatus?.worker);
        const serverSummary = describeContainerStatus(minecraftStatus?.server);
        const portSummary = minecraftStatus
          ? formatPortMappings(minecraftStatus.server?.ports, minecraftStatus.server?.networkMode)
          : 'not checked yet';
        const configuredImageSummary = minecraftStatus?.server?.configuredImage || minecraft.image;
        const imageIdSummary = minecraftStatus?.server?.imageId || 'not checked yet';
        const bedrockVersionSummary = minecraftStatus?.serverRuntime?.bedrockVersion || 'not detected yet';
        const downloadedVersionSummary = minecraftStatus?.serverRuntime?.downloadedVersion || null;
        const createdLine = minecraftStatus?.server?.createdAt
          ? '<p><strong>Created:</strong> ' + formatTimestamp(minecraftStatus.server.createdAt) + '</p>'
          : '';
        const startedLine = minecraftStatus?.server?.startedAt
          ? '<p><strong>Started:</strong> ' + formatTimestamp(minecraftStatus.server.startedAt) + '</p>'
          : '';
        const workerErrorLine = minecraftStatus?.worker?.error
          ? '<p><strong>Worker Error:</strong> ' + minecraftStatus.worker.error + '</p>'
          : '';
        const serverErrorLine = minecraftStatus?.server?.error
          ? '<p><strong>Server Error:</strong> ' + minecraftStatus.server.error + '</p>'
          : '';
        const autoUpdateWorkerConfigErrorLine = autoUpdate?.workerConfigError
          ? '<p><strong>Worker Config Error:</strong> ' + autoUpdate.workerConfigError + '</p>'
          : '';
        const autoUpdateWorkerStateErrorLine = autoUpdate?.workerStateError
          ? '<p><strong>Worker State Error:</strong> ' + autoUpdate.workerStateError + '</p>'
          : '';
        const downloadedVersionLine = downloadedVersionSummary
          ? '<p><strong>Last Downloaded Version:</strong> ' + escapeHtml(downloadedVersionSummary) + '</p>'
          : '';
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div>
              <strong>\${minecraft.serverName || workload.id || 'new-bedrock-server'}</strong>
              <p>\${workload.description || 'Minecraft Bedrock server on a worker node'}</p>
              <p>For a new server, fill out the basic fields below and click <strong>Apply Server</strong>. That saves the config and updates the node in one step.</p>
            </div>
            <div class="toolbar">
              <button data-action="apply" class="primary">Apply Server</button>
            </div>
          </div>
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">Live Status</span>
                <p><strong>Worker:</strong> \${workerSummary}</p>
                <p><strong>Server:</strong> \${serverSummary}</p>
                <p><strong>Network Mode:</strong> \${minecraftStatus?.server?.networkMode || minecraft.networkMode}</p>
                <p><strong>Configured Port:</strong> \${minecraftStatus?.configuredServerPort || minecraft.serverPort}</p>
                <p><strong>Docker Port Mapping:</strong> \${portSummary}</p>
                <p><strong>Configured Image:</strong> \${formatInlineValue(minecraft.image)}</p>
                <p><strong>Container Image:</strong> \${formatInlineValue(configuredImageSummary)}</p>
                <p><strong>Image ID:</strong> \${formatInlineValue(imageIdSummary)}</p>
                <p><strong>Bedrock Version:</strong> \${formatInlineValue(bedrockVersionSummary)}</p>
                \${downloadedVersionLine}
                \${createdLine}
                \${startedLine}
                \${workerErrorLine}
                \${serverErrorLine}
              </div>
              <div class="toolbar">
                <button data-action="refresh-status">Refresh Status</button>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">Auto Update</span>
                <p><strong>Status:</strong> \${autoUpdateStatus.label}</p>
                <p>\${autoUpdateStatus.detail}</p>
                <p><strong>Configured Schedule:</strong> \${minecraft.autoUpdateEnabled ? (minecraft.autoUpdateSchedule || 'missing') : 'disabled'}</p>
                <p><strong>Worker Schedule:</strong> \${autoUpdate?.workerSchedule || 'not deployed'}</p>
                <p><strong>Worker Timezone:</strong> \${autoUpdate?.workerTimeZone || 'unknown'}</p>
                <p><strong>Worker Poll Interval:</strong> \${autoUpdate?.workerPollIntervalSeconds ? autoUpdate.workerPollIntervalSeconds + 's' : 'unknown'}</p>
                <p><strong>Last Scheduled Check:</strong> \${formatTimestamp(autoUpdate?.lastRunAt)}</p>
                <p><strong>Next Scheduled Check:</strong> \${formatTimestamp(autoUpdate?.nextRunAt)}</p>
                \${renderMinecraftActionResult(autoUpdate?.lastResult, 'No scheduled update result recorded yet.')}
                \${autoUpdateWorkerConfigErrorLine}
                \${autoUpdateWorkerStateErrorLine}
              </div>
            </div>
          </div>
          <div class="row">
            <label>Server Name<input data-mc-field="serverName" value="\${minecraft.serverName}" placeholder="Gateway Bedrock" /></label>
            <label>World Name<input data-mc-field="worldName" value="\${minecraft.worldName}" placeholder="gateway-main" /></label>
            <label>Game Mode
              <select data-mc-field="gameMode">
                <option value="survival" \${minecraft.gameMode === 'survival' ? 'selected' : ''}>survival</option>
                <option value="creative" \${minecraft.gameMode === 'creative' ? 'selected' : ''}>creative</option>
                <option value="adventure" \${minecraft.gameMode === 'adventure' ? 'selected' : ''}>adventure</option>
              </select>
            </label>
            <label>Difficulty
              <select data-mc-field="difficulty">
                <option value="peaceful" \${minecraft.difficulty === 'peaceful' ? 'selected' : ''}>peaceful</option>
                <option value="easy" \${minecraft.difficulty === 'easy' ? 'selected' : ''}>easy</option>
                <option value="normal" \${minecraft.difficulty === 'normal' ? 'selected' : ''}>normal</option>
                <option value="hard" \${minecraft.difficulty === 'hard' ? 'selected' : ''}>hard</option>
              </select>
            </label>
          </div>
          <details class="card disclosure-card">
            <summary><strong>Advanced Options</strong></summary>
            <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${workload.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Workload Id<input data-field="id" value="\${workload.id}" /></label>
            <label>Description<input data-field="description" value="\${workload.description || ''}" /></label>
            <label>Node<select data-field="nodeId">\${workerNodeOptions(workload.nodeId)}</select></label>
            <label>Image<input data-mc-field="image" value="\${minecraft.image}" /></label>
            <label>Deploy Revision<input data-control="deployRevision" placeholder="optional sha/tag" /></label>
            </div>
            <div class="row">
              <label>Seed<input data-mc-field="levelSeed" value="\${minecraft.levelSeed || ''}" /></label>
            <label>World Source Path<input data-mc-field="worldSourcePath" value="\${minecraft.worldSourcePath || ''}" placeholder="/mnt/storage/docker/shared/worlds/existing-world or .mcworld" /></label>
            <label>Network Mode
              <select data-mc-field="networkMode">
                <option value="host" \${minecraft.networkMode === 'host' ? 'selected' : ''}>host (recommended for Xbox LAN)</option>
                <option value="bridge" \${minecraft.networkMode === 'bridge' ? 'selected' : ''}>bridge</option>
              </select>
            </label>
            <label>World Copy Mode
              <select data-mc-field="worldCopyMode">
                <option value="if-missing" \${minecraft.worldCopyMode === 'if-missing' ? 'selected' : ''}>if-missing</option>
                <option value="always" \${minecraft.worldCopyMode === 'always' ? 'selected' : ''}>always</option>
              </select>
            </label>
            <label>Max Players<input type="number" data-mc-field="maxPlayers" value="\${minecraft.maxPlayers}" /></label>
            <label>Server Port<input type="number" data-mc-field="serverPort" value="\${minecraft.serverPort}" /></label>
            <label>Auto Update Schedule<input data-mc-field="autoUpdateSchedule" value="\${minecraft.autoUpdateSchedule}" /></label>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-mc-field="allowCheats" \${minecraft.allowCheats ? 'checked' : ''} /> Allow Cheats</label>
            <label class="check"><input type="checkbox" data-mc-field="onlineMode" \${minecraft.onlineMode ? 'checked' : ''} /> Online Mode</label>
            <label class="check"><input type="checkbox" data-mc-field="autoStart" \${minecraft.autoStart ? 'checked' : ''} /> Auto Start</label>
            <label class="check"><input type="checkbox" data-mc-field="autoUpdateEnabled" \${minecraft.autoUpdateEnabled ? 'checked' : ''} /> Auto Update</label>
            <label class="check"><input type="checkbox" data-mc-field="texturepackRequired" \${minecraft.texturepackRequired ? 'checked' : ''} /> Require Resource Packs</label>
          </div>
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">Behavior Packs</span>
                <p>Bedrock behavior packs or add-on logic packages.</p>
              </div>
              <button data-action="add-behavior-pack">Add Behavior Pack</button>
            </div>
            <div data-pack-container="behavior"></div>
          </div>
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">Resource Packs</span>
                <p>Textures, sounds, and client-side content packs.</p>
              </div>
              <button data-action="add-resource-pack">Add Resource Pack</button>
            </div>
            <div data-pack-container="resource"></div>
          </div>
          <div class="toolbar">
            <button data-action="remove" class="danger">Remove Server</button>
          </div>
          </details>
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">Server Controls</span>
                <p>Use these after the server has been applied at least once.</p>
              </div>
            </div>
            <div class="toolbar">
              <button data-action="start">Start</button>
              <button data-action="stop">Stop</button>
              <button data-action="restart">Restart</button>
              <button data-action="redeploy">Redeploy</button>
            </div>
            <div class="row">
              <label>Broadcast Message<input data-control="broadcastMessage" placeholder="Server message" /></label>
              <label>Player<input data-control="player" placeholder="player name" /></label>
              <label>Reason<input data-control="reason" placeholder="optional reason" /></label>
            </div>
            <div class="toolbar">
              <button data-action="broadcast">Broadcast</button>
              <button data-action="kick">Kick</button>
              <button data-action="ban">Ban</button>
            </div>
          </div>
          <div class="inline-action-output" data-action-output>
            <strong>Action Output</strong>
            <div>No recent action output for this server.</div>
          </div>
          <div class="card">
            <div class="split-actions">
              <div>
                <span class="pill">Manual Update</span>
                <p>Manual updates use the safe <code>update-if-empty</code> path and will skip if players are online.</p>
                <p><strong>Override:</strong> <code>Force Update</code> bypasses the player-count safety gate.</p>
                <p><strong>Current Queue State:</strong> \${describeManualUpdate(manualUpdate)}</p>
                \${renderMinecraftActionResult(lastManualUpdateResult, 'No manual update result recorded yet.')}
              </div>
            </div>
            <div class="toolbar">
              <button data-action="update-now">Update Now</button>
              <button data-action="force-update-now" class="danger">Force Update</button>
              <button data-action="cancel-scheduled-update" \${manualUpdate?.status === 'pending' ? '' : 'disabled'}>Cancel Pending Update</button>
            </div>
            <div class="row">
              <label>Update In Minutes<input type="number" min="0" step="1" data-control="updateDelayMinutes" value="\${manualUpdate?.status === 'pending' && manualUpdate.mode === 'minutes' && manualUpdate.delayMinutes !== null ? manualUpdate.delayMinutes : 15}" /></label>
              <label>Update At Time<input type="datetime-local" data-control="updateAt" value="\${formatDateTimeLocalValue(manualUpdate?.status === 'pending' && manualUpdate.mode === 'at' ? manualUpdate.runAt : undefined)}" /></label>
            </div>
            <div class="toolbar">
              <button data-action="schedule-update-delay">Schedule In Minutes</button>
              <button data-action="schedule-update-at">Schedule At Time</button>
            </div>
          </div>
          <details class="card disclosure-card">
            <summary><strong>Server Log Tail</strong></summary>
            <p>Use this to confirm the Bedrock version the container actually announced and to inspect recent startup or handshake errors.</p>
            \${renderMinecraftLogTail(minecraftStatus?.serverRuntime?.logs)}
          </details>
        \`;

        const packSpecs = [
          ['behavior', minecraft.behaviorPacks || []],
          ['resource', minecraft.resourcePacks || []]
        ];
        packSpecs.forEach(([packType, packs]) => {
          const packContainer = element.querySelector(\`[data-pack-container="\${packType}"]\`);
          if (packs.length === 0) {
            packContainer.innerHTML = '<p>No packs configured.</p>';
            return;
          }
          packs.forEach((pack, packIndex) => {
            const packCard = document.createElement('div');
            packCard.className = 'card';
            packCard.innerHTML = \`
              <div class="split-actions">
                <div><strong>\${pack.id || 'new-pack'}</strong></div>
                <button class="danger" data-action="remove-pack" data-pack-type="\${packType}" data-pack-index="\${packIndex}">Remove</button>
              </div>
              <div class="row">
                <label>Pack Id<input data-pack-type="\${packType}" data-pack-index="\${packIndex}" data-pack-field="id" value="\${pack.id || ''}" /></label>
                <label>Source Path<input data-pack-type="\${packType}" data-pack-index="\${packIndex}" data-pack-field="sourcePath" value="\${pack.sourcePath || ''}" placeholder="/mnt/storage/docker/shared/bedrock-packs/example" /></label>
                <label>Manifest UUID<input data-pack-type="\${packType}" data-pack-index="\${packIndex}" data-pack-field="manifestUuid" value="\${pack.manifestUuid || ''}" /></label>
                <label>Manifest Version<input data-pack-type="\${packType}" data-pack-index="\${packIndex}" data-pack-field="manifestVersion" value="\${(pack.manifestVersion || [1, 0, 0]).join('.')}" /></label>
              </div>
            \`;
            packContainer.appendChild(packCard);
          });
        });

        const remoteIndex = state.config.remoteWorkloads.findIndex((candidate) => candidate === workload);
        const actionOutput = element.querySelector('[data-action-output]');
        setLocalActionOutput(
          actionOutput,
          summarizeMinecraftActionResult(
            lastManualUpdateResult || autoUpdate?.lastResult,
            'No recent action output for this server.'
          )
        );
        const updateMinecraftField = (field, value, removeWhenEmpty = false, shouldRerender = false) => {
          const targetWorkload = state.config.remoteWorkloads[remoteIndex];
          targetWorkload.minecraft = targetWorkload.minecraft || createDefaultMinecraftConfig();
          const previousMinecraft = { ...targetWorkload.minecraft };
          targetWorkload.minecraft[field] = value;
          if (removeWhenEmpty && (value === '' || value === undefined)) {
            delete targetWorkload.minecraft[field];
          }
          if (field === 'serverName' || field === 'worldName') {
            applyBedrockIdentityDefaults(targetWorkload, previousMinecraft, targetWorkload.minecraft);
          }
          if (shouldRerender) {
            renderRemoteWorkloads();
          }
          syncRawJson();
        };

        element.querySelector('[data-action="remove"]').addEventListener('click', () => {
          state.config.remoteWorkloads.splice(remoteIndex, 1);
          delete state.minecraftStatuses[workload.id];
          renderRemoteWorkloads();
          renderBedrockServers();
          syncRawJson();
        });

        const deployBedrockWorkload = async () => {
          const targetWorkload = state.config.remoteWorkloads[remoteIndex];
          targetWorkload.minecraft = targetWorkload.minecraft || createDefaultMinecraftConfig();
          applyBedrockIdentityDefaults(targetWorkload, targetWorkload.minecraft, targetWorkload.minecraft);
          ensureRemoteWorkloadNodeId(targetWorkload);
          renderRemoteWorkloads();
          renderBedrockServers();
          syncRawJson();
          const workloadId = targetWorkload.id;
          await persistConfigState({ renderAfterSave: false });
          const revision = element.querySelector('[data-control="deployRevision"]').value.trim();
          const queued = await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workloadId)}/deploy\`, revision ? { revision } : {}, 30000);
          await waitForRemoteDeployJob(workloadId, queued.jobId);
          await refreshMinecraftStatus(workloadId);
          return workloadId;
        };

        element.querySelector('[data-action="apply"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="apply"]');
          await withBusyButton(button, 'Applying…', async () => {
            try {
              setLocalActionOutput(actionOutput, 'Applying Bedrock server configuration to the worker node…', 'progress');
              const workloadId = await deployBedrockWorkload();
              setLocalActionOutput(actionOutput, 'Applied Bedrock server ' + workloadId + '.', 'ok');
              setStatus(\`Applied Bedrock server \${workloadId}\`);
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelector('[data-action="redeploy"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="redeploy"]');
          await withBusyButton(button, 'Redeploying…', async () => {
            try {
              setLocalActionOutput(actionOutput, 'Redeploying Bedrock server and remote gateway-worker…', 'progress');
              const workloadId = await deployBedrockWorkload();
              setLocalActionOutput(actionOutput, 'Redeployed Bedrock server ' + workloadId + '.', 'ok');
              setStatus(\`Redeployed Bedrock server \${workloadId}\`);
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelector('[data-action="refresh-status"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="refresh-status"]');
          await withBusyButton(button, 'Refreshing…', async () => {
            try {
              setLocalActionOutput(actionOutput, 'Refreshing Bedrock runtime details…', 'progress');
              const refreshed = await refreshMinecraftStatus(workload.id);
              setLocalActionOutput(
                actionOutput,
                'Refreshed Bedrock status. Version: '
                  + (refreshed.serverRuntime?.bedrockVersion || 'unknown')
                  + '. Image: '
                  + (refreshed.server?.configuredImage || minecraft.image)
                  + '.',
                'ok'
              );
              setStatus('Refreshed Bedrock status for ' + workload.id);
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        [
          ['start', 'start'],
          ['stop', 'stop'],
          ['restart', 'restart']
        ].forEach(([buttonAction, action]) => {
          element.querySelector(\`[data-action="\${buttonAction}"]\`).addEventListener('click', async () => {
            const button = element.querySelector(\`[data-action="\${buttonAction}"]\`);
            await withBusyButton(button, 'Working…', async () => {
              try {
                setLocalActionOutput(actionOutput, 'Running ' + action + '…', 'progress');
                await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/\${action}\`, {});
                const refreshed = await refreshMinecraftStatus(workload.id);
                setLocalActionOutput(actionOutput, 'Bedrock action completed: ' + action + '. Worker: ' + describeContainerStatus(refreshed.worker) + '. Server: ' + describeContainerStatus(refreshed.server) + '.', 'ok');
                setStatus(\`Bedrock action completed: \${action}\`);
              } catch (error) {
                setLocalActionOutput(actionOutput, error.message, 'error');
                setStatus(error.message, 'error');
              }
            });
          });
        });

        element.querySelector('[data-action="update-now"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="update-now"]');
          await withBusyButton(button, 'Updating…', async () => {
            try {
              setLocalActionOutput(actionOutput, 'Running safe Bedrock update…', 'progress');
              await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/update-request\`, {
                mode: 'now'
              });
              const refreshed = await refreshMinecraftStatus(workload.id);
              setLocalActionOutput(actionOutput, summarizeMinecraftActionResult(refreshed.lastManualUpdateResult, 'Safe Bedrock update finished.'), 'ok');
              setStatus('Queued Bedrock update now');
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelector('[data-action="force-update-now"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="force-update-now"]');
          await withBusyButton(button, 'Forcing…', async () => {
            try {
              setLocalActionOutput(actionOutput, 'Running forced Bedrock update…', 'progress');
              await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/force-update\`, {});
              const refreshed = await refreshMinecraftStatus(workload.id);
              setLocalActionOutput(actionOutput, summarizeMinecraftActionResult(refreshed.lastManualUpdateResult, 'Forced Bedrock update finished.'), 'ok');
              setStatus('Forced Bedrock update completed');
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelector('[data-action="schedule-update-delay"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="schedule-update-delay"]');
          await withBusyButton(button, 'Scheduling…', async () => {
            try {
              const delayMinutes = Number(element.querySelector('[data-control="updateDelayMinutes"]').value);
              if (!Number.isFinite(delayMinutes) || delayMinutes < 0) {
                throw new Error('Update delay must be a non-negative number of minutes');
              }
              setLocalActionOutput(actionOutput, 'Scheduling Bedrock update in ' + delayMinutes + ' minute(s)…', 'progress');
              await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/update-request\`, {
                mode: 'minutes',
                delayMinutes
              });
              const refreshed = await refreshMinecraftStatus(workload.id);
              setLocalActionOutput(actionOutput, describeManualUpdate(refreshed.manualUpdate), 'ok');
              setStatus(\`Queued Bedrock update in \${delayMinutes} minute(s)\`);
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelector('[data-action="schedule-update-at"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="schedule-update-at"]');
          await withBusyButton(button, 'Scheduling…', async () => {
            try {
              const rawValue = element.querySelector('[data-control="updateAt"]').value;
              if (!rawValue) {
                throw new Error('Pick a date and time first');
              }
              const runAt = new Date(rawValue);
              if (Number.isNaN(runAt.getTime())) {
                throw new Error(\`Invalid update time: \${rawValue}\`);
              }
              setLocalActionOutput(actionOutput, 'Scheduling Bedrock update for ' + runAt.toLocaleString() + '…', 'progress');
              await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/update-request\`, {
                mode: 'at',
                runAt: runAt.toISOString()
              });
              const refreshed = await refreshMinecraftStatus(workload.id);
              setLocalActionOutput(actionOutput, describeManualUpdate(refreshed.manualUpdate), 'ok');
              setStatus(\`Queued Bedrock update for \${runAt.toLocaleString()}\`);
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        element.querySelector('[data-action="cancel-scheduled-update"]').addEventListener('click', async () => {
          const button = element.querySelector('[data-action="cancel-scheduled-update"]');
          await withBusyButton(button, 'Cancelling…', async () => {
            try {
              setLocalActionOutput(actionOutput, 'Cancelling pending Bedrock update…', 'progress');
              await requestJson('DELETE', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/update-request\`);
              const refreshed = await refreshMinecraftStatus(workload.id);
              setLocalActionOutput(actionOutput, describeManualUpdate(refreshed.manualUpdate), 'ok');
              setStatus('Cancelled pending Bedrock update');
            } catch (error) {
              setLocalActionOutput(actionOutput, error.message, 'error');
              setStatus(error.message, 'error');
            }
          });
        });

        ['broadcast', 'kick', 'ban'].forEach((action) => {
          element.querySelector(\`[data-action="\${action}"]\`).addEventListener('click', async () => {
            const button = element.querySelector(\`[data-action="\${action}"]\`);
            await withBusyButton(button, 'Working…', async () => {
              try {
                const message = element.querySelector('[data-control="broadcastMessage"]').value.trim();
                const player = element.querySelector('[data-control="player"]').value.trim();
                const reason = element.querySelector('[data-control="reason"]').value.trim();
                setLocalActionOutput(actionOutput, 'Running ' + action + '…', 'progress');
                await requestJson('POST', \`/api/remote-workloads/\${encodeURIComponent(workload.id)}/minecraft/\${action}\`, {
                  ...(message ? { message } : {}),
                  ...(player ? { player } : {}),
                  ...(reason ? { reason } : {})
                });
                await refreshMinecraftStatus(workload.id);
                setLocalActionOutput(actionOutput, 'Bedrock action completed: ' + action + '.', 'ok');
                setStatus(\`Bedrock action completed: \${action}\`);
              } catch (error) {
                setLocalActionOutput(actionOutput, error.message, 'error');
                setStatus(error.message, 'error');
              }
            });
          });
        });

        element.querySelectorAll('input[data-field], select[data-field]').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            state.config.remoteWorkloads[remoteIndex][field] = isCheckbox ? input.checked : input.value;
            if (isCheckbox || input.tagName === 'SELECT') {
              renderRemoteWorkloads();
            }
            syncRawJson();
          });
        });

        element.querySelectorAll('input[data-mc-field], select[data-mc-field]').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.mcField;
            if (!field) {
              return;
            }
            if (isCheckbox) {
              updateMinecraftField(field, input.checked, false, true);
              return;
            }
            if (input.type === 'number') {
              updateMinecraftField(field, Number(input.value));
              return;
            }
            updateMinecraftField(field, input.value || undefined, true, input.tagName === 'SELECT');
          });
        });

        element.querySelector('[data-action="add-behavior-pack"]').addEventListener('click', () => {
          state.config.remoteWorkloads[remoteIndex].minecraft = state.config.remoteWorkloads[remoteIndex].minecraft || createDefaultMinecraftConfig();
          state.config.remoteWorkloads[remoteIndex].minecraft.behaviorPacks.push(createDefaultMinecraftPack());
          renderRemoteWorkloads();
          renderBedrockServers();
          syncRawJson();
        });
        element.querySelector('[data-action="add-resource-pack"]').addEventListener('click', () => {
          state.config.remoteWorkloads[remoteIndex].minecraft = state.config.remoteWorkloads[remoteIndex].minecraft || createDefaultMinecraftConfig();
          state.config.remoteWorkloads[remoteIndex].minecraft.resourcePacks.push(createDefaultMinecraftPack());
          renderRemoteWorkloads();
          renderBedrockServers();
          syncRawJson();
        });

        element.querySelectorAll('[data-pack-field]').forEach((input) => {
          const eventName = input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const packType = input.dataset.packType;
            const packIndex = Number(input.dataset.packIndex);
            const field = input.dataset.packField;
            if (!packType || !field || !Number.isInteger(packIndex)) {
              return;
            }
            const key = packType === 'behavior' ? 'behaviorPacks' : 'resourcePacks';
            const targetPack = state.config.remoteWorkloads[remoteIndex].minecraft[key][packIndex];
            if (field === 'manifestVersion') {
              targetPack.manifestVersion = parsePackVersion(input.value);
            } else {
              targetPack[field] = input.value;
            }
            syncRawJson();
          });
        });

        element.querySelectorAll('[data-action="remove-pack"]').forEach((button) => {
          button.addEventListener('click', () => {
            const packType = button.dataset.packType;
            const packIndex = Number(button.dataset.packIndex);
            if (!packType || !Number.isInteger(packIndex)) {
              return;
            }
            const key = packType === 'behavior' ? 'behaviorPacks' : 'resourcePacks';
            state.config.remoteWorkloads[remoteIndex].minecraft[key].splice(packIndex, 1);
            renderRemoteWorkloads();
            renderBedrockServers();
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

`;
