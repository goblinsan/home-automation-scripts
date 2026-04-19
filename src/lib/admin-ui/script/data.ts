/**
 * Admin UI — data fetch/load orchestration browser-runtime module.
 * Extracted from script.ts.
 */

export const DATA_SCRIPT = `    async function loadTabData(tab, options = {}) {
      const extraFetches = [fetchRuntime()];
      if (tab === 'overview' && isStale('healthSnapshot')) {
        extraFetches.push(fetchHealthSnapshot().then(() => markLoaded('healthSnapshot')));
      }
      const settled = await Promise.allSettled(extraFetches);

      if (tab === 'overview') {
        renderOverview();
      }

      const subTab = state.activeSubTabs[tab];
      if (subTab) {
        loadSubTabData(subTab, { silent: options.silent !== false });
      }

      if (!options.silent) {
        const failures = settled
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
        if (failures.length > 0) {
          setStatus(failures[0], 'error');
        }
      }
      return settled;
    }

    async function loadSubTabData(subTab, options = {}) {
      const fetches = [];
      switch (subTab) {
        case 'wl-remote':
        case 'infra-nodes':
        case 'svc-deploys':
          if (isStale('remoteServiceStatuses')) {
            fetches.push(refreshAllRemoteServiceStatuses({ silent: true }).then(() => markLoaded('remoteServiceStatuses')));
          }
          if (subTab === 'svc-deploys' && isStale('appSlots')) {
            fetches.push(requestJson('GET', '/api/app-slots').then(data => { state.appSlots = data; markLoaded('appSlots'); renderApps(); }).catch(() => {}));
          }
          break;
        case 'infra-minecraft':
          if (isStale('minecraftStatuses')) {
            fetches.push(refreshAllMinecraftStatuses({ silent: true, skipRegistry: true }).then(() => markLoaded('minecraftStatuses')));
          }
          break;
        case 'infra-gateway':
          if (isStale('piProxyStatus')) {
            fetches.push(fetchPiProxyStatus({ silent: true }).then(() => markLoaded('piProxyStatus')));
          }
          break;
        case 'svc-profiles':
          if (isStale('kulrsActivityStatus')) {
            fetches.push(fetchKulrsActivityStatus().then(() => markLoaded('kulrsActivityStatus')));
          }
          if (isStale('ttsVoices')) {
            fetches.push(fetchTtsVoices().then(() => markLoaded('ttsVoices')));
          }
          if (isStale('chatProviders')) {
            fetches.push(fetchChatProviders().then(() => markLoaded('chatProviders')));
          }
          break;
        case 'svc-agents':
          if (isStale('ttsVoices')) {
            fetches.push(fetchTtsVoices().then(() => markLoaded('ttsVoices')));
          }
          if (isStale('chatProviders')) {
            fetches.push(fetchChatProviders().then(() => markLoaded('chatProviders')));
          }
          if (isStale('workflows')) {
            fetches.push(fetchWorkflows().then(() => markLoaded('workflows')));
          }
          if (isStale('jobsCatalog')) {
            fetches.push(fetchJobsCatalog().then(() => markLoaded('jobsCatalog')));
          }
          break;
        case 'svc-workflows':
          if (isStale('workflows')) {
            fetches.push(fetchWorkflows().then(() => markLoaded('workflows')));
          }
          if (isStale('jobsCatalog')) {
            fetches.push(fetchJobsCatalog().then(() => markLoaded('jobsCatalog')));
          }
          break;
        case 'mon-health':
          if (isStale('healthSnapshot')) {
            fetches.push(fetchHealthSnapshot().then(() => markLoaded('healthSnapshot')));
          }
          break;
        case 'mon-benchmarks':
          if (isStale('benchmarkRuns')) {
            fetches.push(fetchBenchmarkRuns().then(() => markLoaded('benchmarkRuns')));
          }
          break;
      }
      if (fetches.length === 0) return;

      state.subTabLoading[subTab] = true;
      const settled = await Promise.allSettled(fetches);
      state.subTabLoading[subTab] = false;

      if (!options.silent) {
        const failures = settled
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
        if (failures.length > 0) {
          setStatus(failures[0], 'error');
        }
      }
      return settled;
    }

    async function fetchRuntime() {
      const response = await fetch(joinBase('/api/runtime'));
      if (!response.ok) {
        throw new Error(await response.text());
      }
      state.runtime = await response.json();
      renderRuntime();
    }

    async function fetchKulrsActivityStatus() {
      if (!state.config) {
        state.kulrsActivityStatus = null;
        renderKulrsActivityProfile();
        return null;
      }
      try {
        state.kulrsActivityStatus = await requestJson('GET', '/api/service-profiles/kulrs-activity/status');
      } catch (error) {
        state.kulrsActivityStatus = { error: error.message };
      }
      renderKulrsActivityProfile();
      return state.kulrsActivityStatus;
    }

    async function fetchKulrsActivityLogs() {
      const output = document.getElementById('kulrsLogsOutput');
      output.textContent = 'Loading…';
      try {
        const result = await requestJson('GET', '/api/service-profiles/kulrs-activity/logs?tail=200', undefined, 60000);
        output.textContent = result.exists
          ? (result.log || '(log file is empty)')
          : 'Log file not found at ' + result.path;
      } catch (error) {
        output.textContent = 'Failed to load logs: ' + error.message;
      }
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

    async function fetchJobsCatalog() {
      if (!state.config || !state.config.serviceProfiles.gatewayApi.enabled) {
        state.jobsCatalog = [];
        renderJobCatalog();
        return;
      }

      const data = await requestJson('GET', '/api/jobs');
      state.jobsCatalog = Array.isArray(data?.jobs) ? data.jobs : [];
      renderJobCatalog();
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

    async function requestJson(method, url, body, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
      try {
        const response = await fetch(joinBase(url), {
          method,
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal
        });
        const data = response.status === 204 ? null : await response.json();
        if (!response.ok) {
          const err = new Error(data?.error || 'Request failed');
          if (data) { Object.assign(err, data); }
          throw err;
        }
        return data;
      } catch (err) {
        if (err.name === 'AbortError') { throw new Error('Request timed out: ' + url); }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    async function waitForRemoteDeployJob(workloadId, jobId, options = {}) {
      const timeoutMs = options.timeoutMs || 2 * 60 * 60 * 1000;
      const pollIntervalMs = options.pollIntervalMs || 5000;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const result = await requestJson(
            'GET',
            '/api/remote-workloads/' + encodeURIComponent(workloadId) + '/deploy-jobs/' + encodeURIComponent(jobId),
            undefined,
            60000
          );
          if (result.status === 'success') {
            return result;
          }
          if (result.status === 'error') {
            const err = new Error(result.error || ('Deploy failed for ' + workloadId));
            Object.assign(err, result);
            throw err;
          }
        } catch (error) {
          const detail = describeClientError(error);
          const transient = detail.startsWith('Request timed out:')
            || detail.includes('502')
            || detail.includes('503')
            || detail.includes('504');
          if (!transient) {
            throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      throw new Error('Deploy polling timed out for ' + workloadId);
    }

    function describeContainerStatus(container) {
      if (!container) {
        return 'unknown';
      }
      if (container.error) {
        return 'error';
      }
      if (!container.exists) {
        return 'missing';
      }
      if (container.running) {
        return 'running';
      }
      return container.status || 'stopped';
    }

    function formatTimestamp(value) {
      if (!value) {
        return 'not yet';
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return value;
      }
      return date.toLocaleString();
    }

    function formatDateTimeLocalValue(value) {
      const date = value ? new Date(value) : new Date();
      if (Number.isNaN(date.getTime())) {
        return '';
      }
      const pad = (input) => String(input).padStart(2, '0');
      return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
      ].join('-') + 'T' + [pad(date.getHours()), pad(date.getMinutes())].join(':');
    }

    function describeAutoUpdateStatus(autoUpdate) {
      if (!autoUpdate) {
        return {
          label: 'unknown',
          detail: 'Auto-update status has not been checked yet.'
        };
      }

      switch (autoUpdate.status) {
        case 'running':
          return {
            label: 'running',
            detail: 'The update schedule is deployed to gateway-worker and the worker container is running.'
          };
        case 'disabled':
          return {
            label: 'disabled',
            detail: 'Auto-update is disabled in config.'
          };
        case 'not-deployed':
          return {
            label: 'not deployed',
            detail: 'This Bedrock workload is not present in the deployed gateway-worker config yet. Apply or redeploy the server.'
          };
        case 'worker-stopped':
          return {
            label: 'worker stopped',
            detail: 'The gateway-worker container is not running, so no schedule is being evaluated.'
          };
        case 'misconfigured':
          return {
            label: 'misconfigured',
            detail: 'The worker config for this Bedrock server is missing the auto-update schedule.'
          };
        default:
          return {
            label: autoUpdate.status || 'unknown',
            detail: autoUpdate.summary || 'Unknown auto-update state.'
          };
      }
    }

    function describeManualUpdate(record) {
      if (!record) {
        return 'No manual update queued.';
      }
      if (record.status === 'pending') {
        return 'Queued for ' + formatTimestamp(record.runAt) + '.';
      }
      if (record.status === 'running') {
        return 'Running now.';
      }
      if (record.status === 'completed') {
        return 'Last manual update ran at ' + formatTimestamp(record.completedAt || record.startedAt || record.runAt) + '.';
      }
      if (record.status === 'cancelled') {
        return 'Last queued manual update was cancelled.';
      }
      return 'Last manual update failed: ' + (record.error || 'unknown error');
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function formatInlineValue(value, empty = 'not yet') {
      if (value === null || value === undefined || value === '') {
        return empty;
      }
      return escapeHtml(String(value));
    }

    function renderMinecraftLogTail(logs) {
      if (!logs) {
        return '<p>Log tail has not been checked yet.</p>';
      }
      const lineCount = Number.isFinite(logs.requestedLines) ? logs.requestedLines : 100;
      const fetchedLine = logs.fetchedAt
        ? '<p><strong>Fetched:</strong> ' + escapeHtml(formatTimestamp(logs.fetchedAt)) + '</p>'
        : '';
      const errorLine = logs.error
        ? '<p><strong>Log Error:</strong> ' + escapeHtml(logs.error) + '</p>'
        : '';
      const lines = Array.isArray(logs.lines) ? logs.lines : [];
      const body = lines.length > 0
        ? '<pre class="log-output">' + escapeHtml(lines.join('\\n')) + '</pre>'
        : '<p>No server log lines were returned.</p>';
      return [
        '<p><strong>Window:</strong> last ' + escapeHtml(String(lineCount)) + ' lines</p>',
        fetchedLine,
        errorLine,
        body
      ].join('');
    }

    function renderMinecraftActionResult(result, emptyMessage) {
      if (!result) {
        return '<p>' + emptyMessage + '</p>';
      }
      const detailLine = result.detail
        ? '<p><strong>Detail:</strong> ' + escapeHtml(result.detail) + '</p>'
        : '';
      const stdoutBlock = result.stdout
        ? '<details><summary>Command Output</summary><pre>' + escapeHtml(result.stdout) + '</pre></details>'
        : '';
      const stderrBlock = result.stderr
        ? '<details><summary>Command Errors</summary><pre>' + escapeHtml(result.stderr) + '</pre></details>'
        : '';
      return [
        '<p><strong>Status:</strong> ' + escapeHtml(result.status || 'unknown') + '</p>',
        '<p><strong>Summary:</strong> ' + escapeHtml(result.summary || 'No summary') + '</p>',
        '<p><strong>Recorded:</strong> ' + escapeHtml(formatTimestamp(result.recordedAt)) + '</p>',
        detailLine,
        stdoutBlock,
        stderrBlock
      ].join('');
    }

    function summarizeMinecraftActionResult(result, fallback) {
      if (!result) {
        return fallback;
      }
      const parts = [result.summary || fallback];
      if (result.detail && result.detail !== result.summary) {
        parts.push(result.detail);
      }
      if (result.recordedAt) {
        parts.push('Recorded ' + formatTimestamp(result.recordedAt));
      }
      return parts.join(' | ');
    }

    function formatPortMappings(ports, networkMode) {
      if (networkMode === 'host') {
        return 'host network';
      }
      if (!ports || typeof ports !== 'object') {
        return 'none';
      }
      const entries = Object.entries(ports);
      if (entries.length === 0) {
        return 'none';
      }
      return entries.map(([containerPort, bindings]) => {
        if (!Array.isArray(bindings) || bindings.length === 0) {
          return containerPort + ' unpublished';
        }
        const mapped = bindings
          .map((binding) => binding && typeof binding === 'object'
            ? [binding.HostIp || '0.0.0.0', binding.HostPort || '?'].join(':')
            : '?')
          .join(', ');
        return containerPort + ' -> ' + mapped;
      }).join('; ');
    }

    function describeServiceHealthCheck(healthCheck) {
      if (!healthCheck) {
        return 'not configured';
      }
      const target = healthCheck.target || 'unknown target';
      const detail = healthCheck.detail || 'no detail';
      if (healthCheck.status === 'ok') {
        return 'ok | ' + target + ' | ' + detail;
      }
      if (healthCheck.status === 'error') {
        return 'error | ' + target + ' | ' + detail;
      }
      return 'unknown | ' + target + ' | ' + detail;
    }

    async function refreshContainerServiceStatus(workloadId, options = {}) {
      const status = await requestJson('GET', '/api/remote-workloads/' + encodeURIComponent(workloadId) + '/service-status', undefined, 60000);
      state.remoteServiceStatuses[workloadId] = status;
      if (!options.silent) {
        renderRemoteWorkloads();
      }
      return status;
    }

    async function refreshAllRemoteServiceStatuses(options = {}) {
      const workloads = state.config
        ? state.config.remoteWorkloads.filter((workload) => workload.kind === 'container-service' && workload.id)
        : [];
      await Promise.all(workloads.map(async (workload) => {
        try {
          await refreshContainerServiceStatus(workload.id, { silent: true });
        } catch (error) {
          const message = error && typeof error === 'object' && 'message' in error ? error.message : String(error);
          state.remoteServiceStatuses[workload.id] = {
            workloadId: workload.id,
            nodeId: workload.nodeId,
            service: {
              containerName: workload.id + '-service',
              exists: false,
              status: 'error',
              running: false,
              error: message
            }
          };
        }
      }));
      if (!options.silent) {
        renderRemoteWorkloads();
      }
    }

    async function refreshMinecraftStatus(workloadId, options = {}) {
      const status = await requestJson('GET', '/api/remote-workloads/' + encodeURIComponent(workloadId) + '/status');
      state.minecraftStatuses[workloadId] = status;
      if (!options.silent) {
        renderBedrockServers();
        renderPiProxyProfile();
      }
      return status;
    }

    async function fetchPiProxyRegistry(options = {}) {
      if (!state.config || !state.config.serviceProfiles.piProxy.enabled) {
        state.piProxyRegistry = null;
        renderPiProxyProfile();
        return null;
      }

      try {
        state.piProxyRegistry = await requestJson('GET', state.config.serviceProfiles.piProxy.registryPath);
        renderPiProxyProfile();
        if (!options.silent) {
          const serverCount = Array.isArray(state.piProxyRegistry.servers) ? state.piProxyRegistry.servers.length : 0;
          setStatus('Loaded Pi proxy registry (' + serverCount + ' worlds)');
        }
        return state.piProxyRegistry;
      } catch (error) {
        state.piProxyRegistry = {
          error: error.message
        };
        renderPiProxyProfile();
        if (!options.silent) {
          setStatus(error.message, 'error');
        }
        return null;
      }
    }

    async function fetchPiProxyStatus(options = {}) {
      if (!state.config || !state.config.serviceProfiles.piProxy.enabled) {
        state.piProxyStatus = null;
        renderPiProxyProfile();
        return null;
      }

      try {
        state.piProxyStatus = await requestJson('GET', '/api/service-profiles/pi-proxy/status');
        renderPiProxyProfile();
        if (!options.silent) {
          setStatus(state.piProxyStatus.summary || 'Loaded Pi proxy status');
        }
        return state.piProxyStatus;
      } catch (error) {
        state.piProxyStatus = { error: error.message };
        renderPiProxyProfile();
        if (!options.silent) {
          setStatus(error.message, 'error');
        }
        return null;
      }
    }

    async function refreshAllMinecraftStatuses(options = {}) {
      const workloads = state.config
        ? state.config.remoteWorkloads.filter((workload) => workload.kind === 'minecraft-bedrock-server' && workload.id)
        : [];
      await Promise.all(workloads.map(async (workload) => {
        try {
          await refreshMinecraftStatus(workload.id, { silent: true, skipRegistry: true });
        } catch (error) {
          const message = error && typeof error === 'object' && 'message' in error ? error.message : String(error);
          state.minecraftStatuses[workload.id] = {
            workloadId: workload.id,
            nodeId: workload.nodeId,
            configuredServerPort: workload.minecraft?.serverPort || null,
            worker: { containerName: 'gateway-worker', exists: false, status: 'error', running: false, error: message },
            server: { containerName: workload.id + '-server', exists: false, status: 'error', running: false, error: message }
          };
        }
      }));
      if (!options.silent) {
        renderBedrockServers();
        renderPiProxyProfile();
      }
    }

    async function persistConfigState(options = {}) {
      normalizeRemoteWorkloadNodeIds();
      const result = await requestJson('POST', '/api/config', state.config);
      state.config = result.config;
      if (options.renderAfterSave !== false) {
        render();
      }
      return result;
    }

    async function syncConfiguredAgents() {
      await requestJson('POST', '/api/service-profiles/gateway-chat-platform/sync');
      setStatus('Chat agents synced to gateway-chat-platform');
    }

    document.querySelectorAll('.top-tab-nav .tab-button').forEach((button) => {
      button.addEventListener('click', async () => {
        const tab = button.dataset.tab || DEFAULT_TAB;
        state.activeTab = tab;
        const presetSubTab = button.dataset.subTab;
        if (presetSubTab && state.activeSubTabs[tab] !== undefined) {
          // Apply the preset's sub-tab DOM state directly. Do NOT call
          // switchSubTab here — it calls loadSubTabData, and loadTabData below
          // already dispatches a single load for the active sub-tab. Calling
          // both would double-fetch (e.g. remoteServiceStatuses for Nodes).
          applySubTabDom(tab, presetSubTab);
        }
        render();
        await loadTabData(state.activeTab);
      });
    });

`;
