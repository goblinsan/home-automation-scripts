/**
 * Admin UI — keyboard nav + event wiring + initialization browser-runtime module.
 * Extracted from script.ts.
 */

export const INIT_SCRIPT = `    // Keyboard nav across top-tab and sub-tab buttons: ArrowLeft/ArrowRight
    // move focus, Home/End jump to ends. Activation is left to Enter/Space
    // (the buttons' native behavior).
    function wireRovingTablistKeys(selector) {
      document.querySelectorAll(selector).forEach((nav) => {
        nav.addEventListener('keydown', (event) => {
          const key = event.key;
          if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') {
            return;
          }
          const buttons = Array.from(nav.querySelectorAll('button')).filter((b) => !b.disabled);
          if (buttons.length === 0) return;
          const currentIndex = buttons.indexOf(document.activeElement);
          let nextIndex = currentIndex;
          if (key === 'ArrowLeft') nextIndex = currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1;
          else if (key === 'ArrowRight') nextIndex = currentIndex === -1 || currentIndex === buttons.length - 1 ? 0 : currentIndex + 1;
          else if (key === 'Home') nextIndex = 0;
          else if (key === 'End') nextIndex = buttons.length - 1;
          if (nextIndex !== currentIndex) {
            event.preventDefault();
            buttons[nextIndex].focus();
          }
        });
      });
    }
    wireRovingTablistKeys('.top-tab-nav');
    wireRovingTablistKeys('.sub-tab-nav');

    document.querySelectorAll('.sub-tab-nav .sub-tab-button').forEach((button) => {
      button.addEventListener('click', () => {
        const group = button.closest('.sub-tab-nav').dataset.subGroup;
        switchSubTab(group, button.dataset.subTab);
      });
    });

    document.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) {
        return;
      }
      button.classList.add('button-tapped');
      setTimeout(() => button.classList.remove('button-tapped'), 180);
    }, true);

    document.getElementById('toggleActionFeedButton').addEventListener('click', () => {
      state.actionFeedCollapsed = !state.actionFeedCollapsed;
      if (actionFeedCollapseTimer) {
        clearTimeout(actionFeedCollapseTimer);
        actionFeedCollapseTimer = null;
      }
      applyActionFeedVisibility();
    });

    const secretsRevealToggle = document.getElementById('secretsRevealToggle');
    if (secretsRevealToggle) {
      secretsRevealToggle.addEventListener('click', () => {
        const revealed = document.body.classList.toggle('is-secrets-revealed');
        secretsRevealToggle.setAttribute('aria-pressed', revealed ? 'true' : 'false');
        secretsRevealToggle.textContent = revealed ? 'Hide values' : 'Reveal values';
        applySecretsRevealState();
        setStatus(revealed ? 'Secret values revealed' : 'Secret values masked', 'ok');
      });
    }

    document.querySelectorAll('[data-open-tab]').forEach((button) => {
      button.addEventListener('click', async () => {
        state.activeTab = button.dataset.openTab || 'services';
        render();
        await loadTabData(state.activeTab);
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
        renderSecrets();
        syncRawJson();
      });
    });
    [
      ['gatewayApiJobChannelsFilePath', 'channelsFilePath']
    ].forEach(([id, key]) => {
      const element = document.getElementById(id);
      element.addEventListener('input', (event) => {
        state.config.serviceProfiles.gatewayApi.jobRuntime[key] = event.target.value;
        renderSecrets();
        syncRawJson();
      });
    });
    [
      ['kulrsEnabled', 'enabled', 'checkbox'],
      ['kulrsSchedule', 'schedule'],
      ['kulrsUser', 'user'],
      ['kulrsGroup', 'group'],
      ['kulrsTimezone', 'timezone'],
      ['kulrsEnvFilePath', 'envFilePath'],
      ['kulrsCredentialsFilePath', 'credentialsFilePath'],
      ['kulrsWorkspaceDir', 'workspaceDir'],
      ['kulrsWorkingDirectory', 'workingDirectory'],
      ['kulrsExecStart', 'execStart'],
      ['kulrsCreateMode', 'createMode'],
      ['kulrsLlmBaseUrl', 'llmBaseUrl'],
      ['kulrsLlmModel', 'llmModel'],
      ['kulrsLlmApiKey', 'llmApiKey'],
      ['kulrsLlmTimeoutMs', 'llmTimeoutMs'],
      ['kulrsLlmTemperature', 'llmTemperature'],
      ['kulrsCronLogPath', 'cronLogPath'],
      ['kulrsCronLogRetentionDays', 'cronLogRetentionDays'],
      ['kulrsCronLogMaxLines', 'cronLogMaxLines'],
      ['kulrsDescription', 'description'],
      ['kulrsFirebaseApiKey', 'firebaseApiKey'],
      ['kulrsUnsplashAccessKey', 'unsplashAccessKey'],
    ].forEach(([id, key, kind]) => {
      const element = document.getElementById(id);
      element.addEventListener(kind === 'checkbox' ? 'change' : 'input', (event) => {
        const target = event.target;
        state.config.serviceProfiles.gatewayApi.kulrsActivity[key] = kind === 'checkbox' ? target.checked : target.value;
        if (key === 'group' && !target.value) {
          delete state.config.serviceProfiles.gatewayApi.kulrsActivity.group;
        }
        renderSecrets();
        syncRawJson();
      });
    });
    document.getElementById('kulrsViewLogs').addEventListener('click', fetchKulrsActivityLogs);
    document.getElementById('kulrsRefreshLogs').addEventListener('click', fetchKulrsActivityLogs);
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
        renderSecrets();
        syncRawJson();
      });
    });
    [
      ['gatewayChatRedisUrl', 'REDIS_URL', 'Redis backing store for scheduled chat inbox messages'],
      ['gatewayChatDefaultUserId', 'CHAT_DEFAULT_USER_ID', 'Default user scope for scheduled chat inbox messages'],
      ['gatewayChatDefaultChannelId', 'CHAT_DEFAULT_CHANNEL_ID', 'Default inbox channel for scheduled chat inbox messages'],
    ].forEach(([id, key, description]) => {
      const element = document.getElementById(id);
      element.addEventListener('input', (event) => {
        upsertEnvironmentEntry(
          state.config.serviceProfiles.gatewayChatPlatform.environment,
          key,
          event.target.value.trim(),
          description,
          false
        );
        renderSecrets();
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
    [
      ['piProxyEnabled', 'enabled', 'checkbox'],
      ['piProxyNodeId', 'nodeId'],
      ['piProxyDescription', 'description'],
      ['piProxyInstallRoot', 'installRoot'],
      ['piProxySystemdUnitName', 'systemdUnitName'],
      ['piProxyRegistryBaseUrl', 'registryBaseUrl'],
      ['piProxyListenHost', 'listenHost'],
      ['piProxyListenPort', 'listenPort', 'number'],
      ['piProxyServiceUser', 'serviceUser'],
      ['piProxyServiceGroup', 'serviceGroup'],
      ['piProxyRegistryPath', 'registryPath'],
      ['piProxyPollIntervalSeconds', 'pollIntervalSeconds', 'number'],
    ].forEach(([id, key, kind]) => {
      const element = document.getElementById(id);
      const eventName = kind === 'checkbox' || element.tagName === 'SELECT' ? 'change' : 'input';
      element.addEventListener(eventName, (event) => {
        const target = event.target;
        if (kind === 'checkbox') {
          state.config.serviceProfiles.piProxy[key] = target.checked;
        } else if (kind === 'number') {
          state.config.serviceProfiles.piProxy[key] = Number(target.value);
        } else if (key === 'registryPath') {
          state.config.serviceProfiles.piProxy[key] = target.value.startsWith('/') ? target.value : '/' + target.value;
        } else if ((key === 'serviceUser' || key === 'serviceGroup') && !target.value.trim()) {
          delete state.config.serviceProfiles.piProxy[key];
        } else {
          state.config.serviceProfiles.piProxy[key] = target.value;
        }
        renderPiProxyProfile();
        syncRawJson();
      });
    });

    document.getElementById('refreshPiProxyStatusButton').addEventListener('click', async () => {
      const button = document.getElementById('refreshPiProxyStatusButton');
      const actionOutput = document.getElementById('piProxyActionOutput');
      await withBusyButton(button, 'Checking…', async () => {
        try {
          setLocalActionOutput(actionOutput, 'Checking Pi proxy service status…', 'progress');
          const status = await fetchPiProxyStatus();
          setLocalActionOutput(actionOutput, status?.summary || 'Loaded Pi proxy status.', 'ok');
        } catch (error) {
          setLocalActionOutput(actionOutput, error.message, 'error');
        }
      });
    });

    document.getElementById('deployPiProxyButton').addEventListener('click', async () => {
      const button = document.getElementById('deployPiProxyButton');
      const actionOutput = document.getElementById('piProxyActionOutput');
      await withBusyButton(button, 'Deploying…', async () => {
        try {
          setLocalActionOutput(actionOutput, 'Saving config and deploying the managed Pi proxy…', 'progress');
          await persistConfigState();
          const result = await requestJson('POST', '/api/service-profiles/pi-proxy/deploy');
          await Promise.all([fetchPiProxyStatus({ silent: true }), fetchPiProxyRegistry({ silent: true })]);
          renderPiProxyProfile();
          setLocalActionOutput(actionOutput, result.message || 'Pi proxy deployed.', 'ok');
          setStatus(result.message || 'Pi proxy deployed');
        } catch (error) {
          setLocalActionOutput(actionOutput, error.message, 'error');
          setStatus(error.message, 'error');
        }
      });
    });

    document.getElementById('restartPiProxyButton').addEventListener('click', async () => {
      const button = document.getElementById('restartPiProxyButton');
      const actionOutput = document.getElementById('piProxyActionOutput');
      await withBusyButton(button, 'Restarting…', async () => {
        try {
          setLocalActionOutput(actionOutput, 'Restarting Pi proxy service…', 'progress');
          const result = await requestJson('POST', '/api/service-profiles/pi-proxy/restart');
          await fetchPiProxyStatus({ silent: true });
          renderPiProxyProfile();
          setLocalActionOutput(actionOutput, result.message || 'Pi proxy restarted.', 'ok');
          setStatus(result.message || 'Pi proxy restarted');
        } catch (error) {
          setLocalActionOutput(actionOutput, error.message, 'error');
          setStatus(error.message, 'error');
        }
      });
    });

    document.getElementById('refreshPiProxyRegistryButton').addEventListener('click', async () => {
      const button = document.getElementById('refreshPiProxyRegistryButton');
      const actionOutput = document.getElementById('piProxyActionOutput');
      await withBusyButton(button, 'Refreshing…', async () => {
        try {
          setLocalActionOutput(actionOutput, 'Refreshing Bedrock registry for the Pi proxy…', 'progress');
          const payload = await fetchPiProxyRegistry();
          const serverCount = Array.isArray(payload?.servers) ? payload.servers.length : 0;
          setLocalActionOutput(actionOutput, 'Loaded Pi proxy registry with ' + serverCount + ' world(s).', 'ok');
        } catch (error) {
          setLocalActionOutput(actionOutput, error.message, 'error');
        }
      });
    });

    document.getElementById('saveButton').addEventListener('click', async () => {
      const button = document.getElementById('saveButton');
      await withBusyButton(button, 'Saving…', async () => {
        try {
          const result = await requestJson('POST', '/api/build', state.config);
          state.config = result.config;
          render();
          setStatus(result.message || 'Saved');
        } catch (error) {
          setStatus(error.message, 'error');
        }
      });
    });

    document.getElementById('refreshButton').addEventListener('click', async () => {
      const button = document.getElementById('refreshButton');
      await withBusyButton(button, 'Refreshing…', async () => {
        try {
          await fetchConfig();
          state.dataLoaded = {};
          await loadTabData(state.activeTab, { silent: true });
          setStatus('Current', 'ok', { log: false });
        } catch (error) {
          setStatus(error.message, 'error');
        }
      });
    });
    document.getElementById('restartButton').addEventListener('click', async () => {
      if (!confirm('Restart the control-plane container? The UI will be unavailable for a few seconds.')) return;
      const button = document.getElementById('restartButton');
      await withBusyButton(button, 'Restarting…', async () => {
        try {
          await requestJson('POST', '/api/restart');
          setStatus('Restart signal sent — reloading in 5s…');
          setTimeout(() => location.reload(), 5000);
        } catch (error) {
          setStatus(error.message, 'error');
        }
      });
    });
    document.getElementById('rawJsonButton').addEventListener('click', () => {
      syncRawJson();
      document.getElementById('rawJsonDialog').showModal();
    });
    document.getElementById('closeRawJsonDialogButton').addEventListener('click', () => {
      document.getElementById('rawJsonDialog').close();
    });
    document.getElementById('refreshRuntimeButtonSecondary').addEventListener('click', async () => {
      const button = document.getElementById('refreshRuntimeButtonSecondary');
      await withBusyButton(button, 'Refreshing…', async () => {
        try {
          await fetchRuntime();
          setStatus('Runtime refreshed');
        } catch (error) {
          setStatus(error.message, 'error');
        }
      });
    });
    // ── Monitoring button handlers ──
    document.getElementById('refreshHealthButton').addEventListener('click', async () => {
      const btn = document.getElementById('refreshHealthButton');
      await withBusyButton(btn, 'Refreshing…', async () => {
        state.dataLoaded.healthSnapshot = 0;
        await fetchHealthSnapshot();
        setStatus('Health snapshot refreshed');
      });
    });
    // ── Overview button handlers ──
    const overviewRefreshBtn = document.getElementById('overviewRefreshButton');
    if (overviewRefreshBtn) {
      overviewRefreshBtn.addEventListener('click', async () => {
        await withBusyButton(overviewRefreshBtn, 'Refreshing…', async () => {
          state.dataLoaded.healthSnapshot = 0;
          state.dataLoaded.projectTrackingOverview = 0;
          const settled = await Promise.allSettled([fetchRuntime(), fetchHealthSnapshot(), fetchProjectTrackingOverview()]);
          const failures = settled.filter((result) => result.status === 'rejected');
          if (failures.length === 0) {
            // Only mark the snapshot fresh when both required fetches actually
            // succeeded — otherwise the 30s stale guard would suppress the
            // next retry and operators would keep looking at partial data.
            markLoaded('healthSnapshot');
            markLoaded('projectTrackingOverview');
            setStatus('Overview refreshed');
          } else {
            const reason = failures[0].reason;
            let message;
            if (reason && typeof reason.message === 'string' && reason.message) {
              message = reason.message;
            } else if (typeof reason === 'string' && reason) {
              message = reason;
            } else {
              message = 'Overview refresh failed: unknown error';
            }
            setStatus(message, 'error');
          }
        });
      });
    }
    const overviewCopyProjectSummaryButton = document.getElementById('overviewCopyProjectSummaryButton');
    if (overviewCopyProjectSummaryButton) {
      overviewCopyProjectSummaryButton.addEventListener('click', async () => {
        const summary = state.projectTrackingOverview && state.projectTrackingOverview.clipboardSummary
          ? state.projectTrackingOverview.clipboardSummary
          : 'No tracked projects yet.';
        try {
          await navigator.clipboard.writeText(summary);
          overviewCopyProjectSummaryButton.textContent = 'Copied!';
          setStatus('Project summary copied');
          setTimeout(() => { overviewCopyProjectSummaryButton.textContent = 'Copy Summary'; }, 2000);
        } catch (error) {
          setStatus('Clipboard copy failed', 'error');
        }
      });
    }
    const overviewRunCheckBtn = document.getElementById('overviewRunCheckButton');
    if (overviewRunCheckBtn) {
      overviewRunCheckBtn.addEventListener('click', async () => {
        await withBusyButton(overviewRunCheckBtn, 'Checking…', async () => {
          try {
            const snapshot = await requestJson('POST', '/api/monitoring/health/check', {}, 30000);
            state.healthSnapshot = snapshot;
            state.dataLoaded.healthSnapshot = Date.now();
            renderHealthTargets();
            renderOverview();
            setStatus('Health check completed');
          } catch (err) {
            setStatus(err.message, 'error');
          }
        });
      });
    }
    document.getElementById('runHealthCheckButton').addEventListener('click', async () => {
      const btn = document.getElementById('runHealthCheckButton');
      await withBusyButton(btn, 'Checking…', async () => {
        try {
          const snapshot = await requestJson('POST', '/api/monitoring/health/check', {}, 30000);
          state.healthSnapshot = snapshot;
          state.dataLoaded.healthSnapshot = Date.now();
          renderHealthTargets();
          renderOverview();
          setStatus('Health check completed');
        } catch (err) { setStatus(err.message, 'error'); }
      });
    });
    document.getElementById('refreshBenchmarksButton').addEventListener('click', async () => {
      const btn = document.getElementById('refreshBenchmarksButton');
      await withBusyButton(btn, 'Refreshing…', async () => {
        state.dataLoaded.benchmarkRuns = 0;
        await fetchBenchmarkRuns();
        setStatus('Benchmarks refreshed');
      });
    });
    document.getElementById('newBenchmarkRunButton').addEventListener('click', () => {
      showNewBenchmarkModal();
    });
    // Monitoring settings auto-read
    ['monEnabled', 'monPgHost', 'monPgPort', 'monPgDatabase', 'monPgUser', 'monPgPassword', 'monRedisHost', 'monRedisPort', 'monHealthInterval'].forEach(function(id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', readMonitoringSettings);
      if (el && el.type !== 'checkbox') el.addEventListener('input', readMonitoringSettings);
    });

    function showNewBenchmarkModal() {
      let modal = document.getElementById('newBenchmarkModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'newBenchmarkModal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';
        document.body.appendChild(modal);
      }
      modal.innerHTML =
        '<div style="background:var(--color-bg);border:1px solid var(--color-border);border-radius:8px;max-width:36rem;width:90vw;padding:1.25rem;box-shadow:0 8px 32px rgba(0,0,0,.4)">' +
          '<h3 style="margin:0 0 .75rem">New Benchmark Run</h3>' +
          '<div class="row">' +
            '<label>Suite ID <input id="bmSuiteId" value="stt-transcription" /></label>' +
            '<label>Run Name <input id="bmName" placeholder="e.g. faster-whisper large-v3 float16" /></label>' +
          '</div>' +
          '<div class="row">' +
            '<label>Engine <input id="bmEngine" placeholder="e.g. faster-whisper" /></label>' +
            '<label>Hardware <input id="bmHardware" placeholder="e.g. RTX 4060 8GB" /></label>' +
          '</div>' +
          '<div class="row">' +
            '<label style="grid-column:1/-1">Config JSON <textarea id="bmConfig" rows="3" style="font-family:monospace;font-size:.82rem">{}</textarea></label>' +
          '</div>' +
          '<div class="row">' +
            '<label style="grid-column:1/-1">Notes <textarea id="bmNotes" rows="2"></textarea></label>' +
          '</div>' +
          '<div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:.75rem">' +
            '<button id="bmCancel">Cancel</button>' +
            '<button id="bmCreate" class="primary">Create Run</button>' +
          '</div>' +
        '</div>';
      modal.hidden = false;
      modal.addEventListener('click', function(e) { if (e.target === modal) modal.hidden = true; });
      modal.querySelector('#bmCancel').addEventListener('click', function() { modal.hidden = true; });
      modal.querySelector('#bmCreate').addEventListener('click', async function() {
        try {
          let config = {};
          try { config = JSON.parse(document.getElementById('bmConfig').value); } catch {}
          await requestJson('POST', '/api/monitoring/benchmarks', {
            suiteId: document.getElementById('bmSuiteId').value,
            name: document.getElementById('bmName').value,
            engine: document.getElementById('bmEngine').value,
            hardware: document.getElementById('bmHardware').value,
            config: config,
            notes: document.getElementById('bmNotes').value,
          }, 10000);
          modal.hidden = true;
          setStatus('Benchmark run created');
          state.dataLoaded.benchmarkRuns = 0;
          fetchBenchmarkRuns();
        } catch (err) { setStatus(err.message, 'error'); }
      });
    }

    document.getElementById('reloadWorkflowsButton').addEventListener('click', async () => {
      try {
        await fetchWorkflows();
        setStatus('Workflows reloaded');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    document.getElementById('reloadJobsButton').addEventListener('click', async () => {
      try {
        await fetchJobsCatalog();
        setStatus('Job catalog reloaded');
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
    document.getElementById('addWorkerNodeButton').addEventListener('click', () => {
      appendWorkerNode(createWorkerNodePreset('general'));
    });

    // ─── Node Setup Wizard ────────────────────────────────────────────
    (function initNodeSetupWizard() {
      const dialog = document.getElementById('nodeSetupWizard');
      const presetStep = document.getElementById('wizardStepPreset');
      const formStep = document.getElementById('wizardStepForm');
      const progressStep = document.getElementById('wizardStepProgress');
      const progressLog = document.getElementById('wizProgressLog');
      const actionsRow = document.getElementById('wizardStepActions');
      const addToConfigBtn = document.getElementById('wizAddToConfigButton');
      const closeFinishedBtn = document.getElementById('wizCloseFinishedButton');

      const fields = {
        nodeId: document.getElementById('wizNodeId'),
        host: document.getElementById('wizHost'),
        sshPort: document.getElementById('wizSshPort'),
        adminUser: document.getElementById('wizAdminUser'),
        adminPassword: document.getElementById('wizAdminPassword'),
        description: document.getElementById('wizDescription'),
        buildRoot: document.getElementById('wizBuildRoot'),
        stackRoot: document.getElementById('wizStackRoot'),
        volumeRoot: document.getElementById('wizVolumeRoot'),
        pollInterval: document.getElementById('wizPollInterval')
      };

      const presetCards = document.querySelectorAll('.wizard-preset-card');
      const presetNextBtn = document.getElementById('wizPresetNextButton');

      const presets = {
        general: {
          buildRoot: '/srv/builds',
          stackRoot: '/srv/stacks',
          volumeRoot: '/srv/volumes',
          description: 'Standard Docker worker node',
          pollInterval: 15
        },
        gpu: {
          buildRoot: '/data/docker/builds',
          stackRoot: '/data/docker/stacks',
          volumeRoot: '/data/docker/volumes',
          description: 'Docker + NVIDIA GPU worker for LLM/STT/CV APIs',
          pollInterval: 15
        },
        pi: {
          buildRoot: '/opt/builds',
          stackRoot: '/opt/stacks',
          volumeRoot: '/opt/volumes',
          description: 'Raspberry Pi edge node',
          pollInterval: 30
        },
        custom: {
          buildRoot: '',
          stackRoot: '',
          volumeRoot: '',
          description: '',
          pollInterval: 15
        }
      };

      let selectedPreset = null;
      let pendingNodeConfig = null;

      presetCards.forEach(card => {
        card.addEventListener('click', () => {
          presetCards.forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          selectedPreset = card.dataset.preset;
          presetNextBtn.disabled = false;
        });
      });

      function applyPreset(presetName) {
        const preset = presets[presetName] || presets.custom;
        fields.buildRoot.value = preset.buildRoot;
        fields.stackRoot.value = preset.stackRoot;
        fields.volumeRoot.value = preset.volumeRoot;
        fields.description.value = preset.description;
        fields.pollInterval.value = preset.pollInterval;
      }

      function showStep(step) {
        presetStep.hidden = step !== 'preset';
        formStep.hidden = step !== 'form';
        progressStep.hidden = step !== 'progress';
        actionsRow.hidden = true;
        addToConfigBtn.hidden = true;
        closeFinishedBtn.hidden = true;
      }

      function openWizard() {
        selectedPreset = null;
        presetCards.forEach(c => c.classList.remove('selected'));
        presetNextBtn.disabled = true;
        progressLog.innerHTML = '';
        pendingNodeConfig = null;
        showStep('preset');
        dialog.showModal();
      }

      function closeWizard() {
        dialog.close();
      }

      const statusIcons = {
        running: '&#9679;',
        ok: '&#10003;',
        warn: '&#9888;',
        error: '&#10007;',
        complete: '&#10003;'
      };

      function appendLogEntry(data) {
        const entry = document.createElement('div');
        entry.className = 'wizard-log-entry wiz-' + (data.status || 'running');
        const icon = document.createElement('span');
        icon.className = 'wizard-log-icon';
        icon.innerHTML = statusIcons[data.status] || statusIcons.running;
        const msg = document.createElement('span');
        msg.textContent = data.message || '';
        entry.appendChild(icon);
        entry.appendChild(msg);
        progressLog.appendChild(entry);
        progressLog.scrollTop = progressLog.scrollHeight;
      }

      async function startSetup() {
        const nodeId = fields.nodeId.value.trim();
        const host = fields.host.value.trim();
        const adminUser = fields.adminUser.value.trim();
        if (!nodeId || !host || !adminUser) {
          setStatus('Node ID, Host, and Admin User are required', 'error');
          return;
        }

        formStep.hidden = true;
        showStep('progress');
        progressLog.innerHTML = '';

        const payload = {
          nodeId: nodeId,
          host: host,
          sshPort: Number(fields.sshPort.value) || 22,
          adminUser: adminUser,
          adminPassword: fields.adminPassword.value || '',
          nodeType: selectedPreset || 'general',
          description: fields.description.value.trim(),
          buildRoot: fields.buildRoot.value.trim(),
          stackRoot: fields.stackRoot.value.trim(),
          volumeRoot: fields.volumeRoot.value.trim(),
          workerPollIntervalSeconds: Number(fields.pollInterval.value) || 15
        };

        setStatus('Setting up node ' + nodeId + '...', 'progress');
        pushActionFeed('Node setup started for ' + nodeId, 'progress');

        try {
          const response = await fetch(joinBase('/api/nodes/setup'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  appendLogEntry(data);
                  if (data.status === 'complete' && data.nodeConfig) {
                    pendingNodeConfig = data.nodeConfig;
                  }
                  if (data.status === 'error') {
                    pushActionFeed('Node setup failed: ' + data.message, 'error');
                  }
                } catch (e) {
                  // skip malformed events
                }
              }
            }
          }
        } catch (err) {
          appendLogEntry({ status: 'error', message: 'Connection error: ' + err.message });
          pushActionFeed('Node setup connection error', 'error');
        }

        actionsRow.hidden = false;
        closeFinishedBtn.hidden = false;
        if (pendingNodeConfig) {
          addToConfigBtn.hidden = false;
          setStatus('Node ' + nodeId + ' setup complete', 'ok');
          pushActionFeed('Node ' + nodeId + ' setup complete');
        } else {
          // Collect errors from the wizard log and surface them in the action feed
          const errorEntries = progressLog.querySelectorAll('.wiz-error');
          const errorMessages = [];
          errorEntries.forEach(entry => {
            const text = entry.textContent.replace(/^[^\s]\s*/, '').trim();
            if (text) errorMessages.push(text);
          });
          if (errorMessages.length > 0) {
            errorMessages.forEach(msg => pushActionFeed('Node setup: ' + msg, 'error'));
            setStatus('Node setup failed — ' + errorMessages.length + ' error(s) shown in activity feed below', 'error');
          } else {
            pushActionFeed('Node setup failed — no node config was returned', 'error');
            setStatus('Node setup had issues — see activity feed below', 'error');
          }
        }
      }

      document.getElementById('openNodeSetupWizardButton').addEventListener('click', openWizard);
      document.getElementById('closeNodeSetupWizardButton').addEventListener('click', closeWizard);
      document.getElementById('wizPresetCancelButton').addEventListener('click', closeWizard);
      document.getElementById('wizPresetNextButton').addEventListener('click', () => {
        if (!selectedPreset) return;
        applyPreset(selectedPreset);
        showStep('form');
      });
      document.getElementById('wizFormBackButton').addEventListener('click', () => {
        showStep('preset');
      });
      document.getElementById('wizStartSetupButton').addEventListener('click', startSetup);
      document.getElementById('wizCloseFinishedButton').addEventListener('click', closeWizard);
      document.getElementById('wizAddToConfigButton').addEventListener('click', () => {
        if (!pendingNodeConfig) return;
        const existing = state.config.workerNodes.findIndex(n => n.id === pendingNodeConfig.id);
        if (existing >= 0) {
          state.config.workerNodes[existing] = pendingNodeConfig;
        } else {
          state.config.workerNodes.push(pendingNodeConfig);
        }
        normalizeRemoteWorkloadNodeIds();
        renderWorkerNodes();
        renderRemoteWorkloads();
        renderBedrockServers();
        renderPiProxyProfile();
        syncRawJson();
        closeWizard();
        setStatus('Saving node ' + pendingNodeConfig.id + '…');
        persistConfigState().then(() => {
          setStatus('Node ' + pendingNodeConfig.id + ' saved', 'ok');
          pushActionFeed('Node ' + pendingNodeConfig.id + ' added and saved');
        }).catch(() => {
          setStatus('Node added to config but save failed — click Save to retry', 'error');
        });
      });

      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) closeWizard();
      });
    })();
    // ─── End Node Setup Wizard ────────────────────────────────────────

    // ─── Managed App Wizard ───────────────────────────────────────────
    (function initManagedAppWizard() {
      const dialog = document.getElementById('managedAppWizard');
      let selectedManagedApp = '';

      function defaultManagedAppConfig() {
        return {
          id: '',
          enabled: true,
          repoUrl: '',
          defaultRevision: 'main',
          deployRoot: '',
          hostnames: [],
          routePath: '/',
          stripRoutePrefix: false,
          healthPath: '/health',
          upstreamConfPath: '',
          buildCommands: [],
          slots: {
            blue: { port: 3001, startCommand: '', stopCommand: '' },
            green: { port: 3002, startCommand: '', stopCommand: '' }
          }
        };
      }

      function createManagedAppPreset(presetId) {
        if (presetId === 'gateway-tools-platform') {
          return {
            id: 'gateway-tools-platform',
            enabled: true,
            repoUrl: 'https://github.com/goblinsan/gateway-tools-platform.git',
            defaultRevision: 'main',
            deployRoot: '/srv/apps/gateway-tools-platform',
            hostnames: ['tools.gateway.example.test'],
            routePath: '/',
            stripRoutePrefix: false,
            healthPath: '/api/health',
            upstreamConfPath: '/etc/nginx/conf.d/upstreams/gateway-tools-platform-active.conf',
            buildCommands: createGatewayToolsEnvBuildCommands({
              sttServiceUrl: 'http://192.168.0.63:5101',
              cvServiceUrl: 'http://192.168.0.63:5201',
              objectStoreBucket: '',
              objectStoreRegion: 'auto',
              objectStoreEndpoint: '',
              objectStoreAccessKeyId: '',
              objectStoreSecretAccessKey: '',
              objectStoreForcePathStyle: false
            }),
            slots: {
              blue: {
                port: 3000,
                startCommand: 'HOST_PORT=__SLOT_PORT__ APP_ENV_FILE=__SHARED__/.env.local DATA_ROOT_HOST=__SHARED__/data docker compose --profile __SLOT__ --project-name gateway-tools-platform-__SLOT__ -f docker-compose.yml up -d --build --remove-orphans __SLOT__',
                stopCommand: 'docker compose --profile __SLOT__ --project-name gateway-tools-platform-__SLOT__ -f docker-compose.yml down --remove-orphans'
              },
              green: {
                port: 3001,
                startCommand: 'HOST_PORT=__SLOT_PORT__ APP_ENV_FILE=__SHARED__/.env.local DATA_ROOT_HOST=__SHARED__/data docker compose --profile __SLOT__ --project-name gateway-tools-platform-__SLOT__ -f docker-compose.yml up -d --build --remove-orphans __SLOT__',
                stopCommand: 'docker compose --profile __SLOT__ --project-name gateway-tools-platform-__SLOT__ -f docker-compose.yml down --remove-orphans'
              }
            }
          };
        }
        return defaultManagedAppConfig();
      }

      function openManagedAppWizard() {
        selectedManagedApp = '';
        document.getElementById('managedAppCatalogNextBtn').disabled = true;
        dialog.querySelectorAll('[data-managed-app]').forEach((card) => card.classList.remove('selected'));
        showManagedAppStep('catalog');
        dialog.showModal();
      }

      function closeManagedAppWizard() {
        dialog.close();
      }

      function showManagedAppStep(step) {
        document.getElementById('managedAppStepCatalog').hidden = step !== 'catalog';
        document.getElementById('managedAppStepConfig').hidden = step !== 'config';
      }

      function buildManagedAppForm() {
        const config = createManagedAppPreset(selectedManagedApp);
        const container = document.getElementById('managedAppConfigFields');
        const description = document.getElementById('managedAppConfigDesc');
        description.textContent = selectedManagedApp === 'gateway-tools-platform'
          ? 'Review the generated gateway-tools-platform app config. This preset assumes a dedicated hostname, an object-store-backed STT upload flow, and the repo deploy-on-merge workflow running on your existing gateway self-hosted runner.'
          : 'Fill in the managed app config before adding it.';

        container.innerHTML = \`
          <label class="wizard-field">
            <span class="wizard-label">App ID</span>
            <input id="managedAppFieldId" type="text" value="\${escapeHtml(config.id)}" />
            <span class="wizard-hint">Unique managed app identifier used by deploy-app.sh and GitHub Actions.</span>
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Git Repo URL</span>
            <input id="managedAppFieldRepoUrl" type="text" value="\${escapeHtml(config.repoUrl)}" />
            <span class="wizard-hint">Repository that owns the app and its deploy-on-merge workflow.</span>
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Default Revision</span>
            <input id="managedAppFieldRevision" type="text" value="\${escapeHtml(config.defaultRevision)}" />
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Deploy Root</span>
            <input id="managedAppFieldDeployRoot" type="text" value="\${escapeHtml(config.deployRoot)}" />
            <span class="wizard-hint">Blue/green slot root on the gateway host.</span>
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Hostnames</span>
            <input id="managedAppFieldHostnames" type="text" value="\${escapeHtml(config.hostnames.join(', '))}" />
            <span class="wizard-hint">Dedicated hostname is recommended for browser-facing apps like gateway-tools-platform.</span>
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Route Path</span>
            <input id="managedAppFieldRoutePath" type="text" value="\${escapeHtml(config.routePath)}" />
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Health Path</span>
            <input id="managedAppFieldHealthPath" type="text" value="\${escapeHtml(config.healthPath)}" />
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Upstream Conf Path</span>
            <input id="managedAppFieldUpstreamConfPath" type="text" value="\${escapeHtml(config.upstreamConfPath)}" />
          </label>
          \${selectedManagedApp === 'gateway-tools-platform' ? \`
          <label class="wizard-field">
            <span class="wizard-label">STT Service URL</span>
            <input id="managedAppFieldSttServiceUrl" type="text" value="http://192.168.0.63:5101" />
            <span class="wizard-hint">Internal URL used by the tools app to reach stt-service from the gateway host.</span>
          </label>
          <label class="wizard-field">
            <span class="wizard-label">CV/SAM Service URL</span>
            <input id="managedAppFieldCvServiceUrl" type="text" value="http://192.168.0.63:5201" />
            <span class="wizard-hint">Internal URL used by the tools app to reach cv-sam-service from the gateway host.</span>
          </label>
          <label class="wizard-field">
            <span class="wizard-label">R2 / S3 Bucket</span>
            <input id="managedAppFieldObjectStoreBucket" type="text" value="" placeholder="tools-audio" />
            <span class="wizard-hint">Bucket that will receive direct browser uploads for large STT files.</span>
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Object Store Region</span>
            <input id="managedAppFieldObjectStoreRegion" type="text" value="auto" />
            <span class="wizard-hint">Use <code>auto</code> for Cloudflare R2.</span>
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Object Store Endpoint</span>
            <input id="managedAppFieldObjectStoreEndpoint" type="text" value="" placeholder="https://&lt;accountid&gt;.r2.cloudflarestorage.com" />
            <span class="wizard-hint">S3 API endpoint for R2 or your S3-compatible object store.</span>
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Object Store Access Key</span>
            <input id="managedAppFieldObjectStoreAccessKeyId" type="password" value="" />
            <span class="wizard-hint">Stored into the shared app env file on the gateway host.</span>
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Object Store Secret</span>
            <input id="managedAppFieldObjectStoreSecretAccessKey" type="password" value="" />
            <span class="wizard-hint">Stored into the shared app env file on the gateway host.</span>
          </label>
          <label class="wizard-field check">
            <span class="wizard-label">Object Store Options</span>
            <label class="check"><input id="managedAppFieldObjectStoreForcePathStyle" type="checkbox" /> Force Path Style</label>
            <span class="wizard-hint">Leave unchecked for Cloudflare R2. Enable it only for S3-compatible stores that require path-style requests.</span>
          </label>
          \` : ''}
          <label class="wizard-field check">
            <span class="wizard-label">Options</span>
            <label class="check"><input id="managedAppFieldEnabled" type="checkbox" \${config.enabled ? 'checked' : ''} /> Enabled</label>
            <label class="check"><input id="managedAppFieldStripRoutePrefix" type="checkbox" \${config.stripRoutePrefix ? 'checked' : ''} /> Strip Route Prefix</label>
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Blue Port</span>
            <input id="managedAppFieldBluePort" type="number" value="\${config.slots.blue.port}" />
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Blue Start Command</span>
            <input id="managedAppFieldBlueStart" type="text" value="\${escapeHtml(config.slots.blue.startCommand)}" />
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Blue Stop Command</span>
            <input id="managedAppFieldBlueStop" type="text" value="\${escapeHtml(config.slots.blue.stopCommand)}" />
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Green Port</span>
            <input id="managedAppFieldGreenPort" type="number" value="\${config.slots.green.port}" />
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Green Start Command</span>
            <input id="managedAppFieldGreenStart" type="text" value="\${escapeHtml(config.slots.green.startCommand)}" />
          </label>
          <label class="wizard-field">
            <span class="wizard-label">Green Stop Command</span>
            <input id="managedAppFieldGreenStop" type="text" value="\${escapeHtml(config.slots.green.stopCommand)}" />
          </label>
          <label class="wizard-field" style="grid-column: 1 / -1;">
            <span class="wizard-label">Build Commands</span>
            <textarea id="managedAppFieldBuildCommands" rows="4">\${escapeHtml(config.buildCommands.join('\\n'))}</textarea>
            <span class="wizard-hint">Leave empty when the repo start command already builds with docker compose.</span>
          </label>
          <div class="card card-quiet" style="grid-column: 1 / -1;">
            <p><strong>Auto-deploy</strong></p>
            <p>This preset assumes the repo has a <code>.github/workflows/deploy-on-merge.yml</code> workflow targeting <code>runs-on: [self-hosted, gateway]</code>. The control-plane app entry and the repo workflow together are what make push-to-main auto-deploy work.</p>
          </div>
        \`;
      }

      function readManagedAppForm() {
        const app = {
          id: (document.getElementById('managedAppFieldId').value || '').trim(),
          enabled: document.getElementById('managedAppFieldEnabled').checked,
          repoUrl: (document.getElementById('managedAppFieldRepoUrl').value || '').trim(),
          defaultRevision: (document.getElementById('managedAppFieldRevision').value || 'main').trim() || 'main',
          deployRoot: (document.getElementById('managedAppFieldDeployRoot').value || '').trim(),
          hostnames: (document.getElementById('managedAppFieldHostnames').value || '').split(',').map((item) => item.trim()).filter(Boolean),
          routePath: (document.getElementById('managedAppFieldRoutePath').value || '/').trim() || '/',
          stripRoutePrefix: document.getElementById('managedAppFieldStripRoutePrefix').checked,
          healthPath: (document.getElementById('managedAppFieldHealthPath').value || '').trim(),
          upstreamConfPath: (document.getElementById('managedAppFieldUpstreamConfPath').value || '').trim(),
          buildCommands: (document.getElementById('managedAppFieldBuildCommands').value || '').split('\\n').map((item) => item.trim()).filter(Boolean),
          slots: {
            blue: {
              port: Number(document.getElementById('managedAppFieldBluePort').value || 0),
              startCommand: (document.getElementById('managedAppFieldBlueStart').value || '').trim(),
              stopCommand: (document.getElementById('managedAppFieldBlueStop').value || '').trim()
            },
            green: {
              port: Number(document.getElementById('managedAppFieldGreenPort').value || 0),
              startCommand: (document.getElementById('managedAppFieldGreenStart').value || '').trim(),
              stopCommand: (document.getElementById('managedAppFieldGreenStop').value || '').trim()
            }
          }
        };
        if (selectedManagedApp === 'gateway-tools-platform') {
          const generatedCommands = createGatewayToolsEnvBuildCommands({
            sttServiceUrl: document.getElementById('managedAppFieldSttServiceUrl').value,
            cvServiceUrl: document.getElementById('managedAppFieldCvServiceUrl').value,
            objectStoreBucket: document.getElementById('managedAppFieldObjectStoreBucket').value,
            objectStoreRegion: document.getElementById('managedAppFieldObjectStoreRegion').value,
            objectStoreEndpoint: document.getElementById('managedAppFieldObjectStoreEndpoint').value,
            objectStoreAccessKeyId: document.getElementById('managedAppFieldObjectStoreAccessKeyId').value,
            objectStoreSecretAccessKey: document.getElementById('managedAppFieldObjectStoreSecretAccessKey').value,
            objectStoreForcePathStyle: document.getElementById('managedAppFieldObjectStoreForcePathStyle').checked
          });
          app.buildCommands = generatedCommands;
        }
        return app;
      }

      function addManagedApp() {
        const app = readManagedAppForm();
        if (!app.id) {
          setStatus('App ID is required', 'error');
          return;
        }
        if (!app.repoUrl || !app.deployRoot || !app.healthPath || !app.upstreamConfPath) {
          setStatus('Repo URL, deploy root, health path, and upstream conf path are required', 'error');
          return;
        }
        if (!app.slots.blue.port || !app.slots.green.port || !app.slots.blue.startCommand || !app.slots.green.startCommand) {
          setStatus('Both blue and green slot ports and start commands are required', 'error');
          return;
        }
        if (selectedManagedApp === 'gateway-tools-platform') {
          const requiredFields = [
            ['managedAppFieldSttServiceUrl', 'STT service URL'],
            ['managedAppFieldCvServiceUrl', 'CV/SAM service URL'],
            ['managedAppFieldObjectStoreBucket', 'object-store bucket'],
            ['managedAppFieldObjectStoreEndpoint', 'object-store endpoint'],
            ['managedAppFieldObjectStoreAccessKeyId', 'object-store access key'],
            ['managedAppFieldObjectStoreSecretAccessKey', 'object-store secret']
          ];
          const missing = requiredFields
            .filter(([fieldId]) => !normalizeSingleLineInput(document.getElementById(fieldId).value))
            .map(([, label]) => label);
          if (missing.length) {
            setStatus('Gateway Tools Platform requires: ' + missing.join(', '), 'error');
            return;
          }
        }
        if (state.config.apps.some((existing) => existing.id === app.id)) {
          setStatus('A managed app with ID "' + app.id + '" already exists', 'error');
          return;
        }
        state.config.apps.push(app);
        render();
        syncRawJson();
        closeManagedAppWizard();
        setStatus('Added managed app "' + app.id + '". Save config to persist it. Pushes to main will auto-deploy once the repo workflow is present on the gateway runner.', 'ok');
      }

      dialog.querySelectorAll('[data-managed-app]').forEach((card) => {
        card.addEventListener('click', () => {
          dialog.querySelectorAll('[data-managed-app]').forEach((item) => item.classList.remove('selected'));
          card.classList.add('selected');
          selectedManagedApp = card.dataset.managedApp || '';
          document.getElementById('managedAppCatalogNextBtn').disabled = !selectedManagedApp;
        });
      });

      document.getElementById('addAppButton').addEventListener('click', openManagedAppWizard);
      document.getElementById('closeManagedAppWizardButton').addEventListener('click', closeManagedAppWizard);
      document.getElementById('managedAppCatalogCancelBtn').addEventListener('click', closeManagedAppWizard);
      document.getElementById('managedAppCatalogNextBtn').addEventListener('click', () => {
        if (!selectedManagedApp) return;
        buildManagedAppForm();
        showManagedAppStep('config');
      });
      document.getElementById('managedAppConfigBackBtn').addEventListener('click', () => {
        showManagedAppStep('catalog');
      });
      document.getElementById('managedAppConfigAddBtn').addEventListener('click', addManagedApp);
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) closeManagedAppWizard();
      });
    })();
    // ─── End Managed App Wizard ──────────────────────────────────────

    document.getElementById('addRemoteWorkloadButton').addEventListener('click', () => {
      state.config.remoteWorkloads.push(createDefaultRemoteJobWorkload());
      renderRemoteWorkloads();
      renderBedrockServers();
      syncRawJson();
    });
    document.getElementById('addContainerServiceWorkloadButton').addEventListener('click', () => {
      state.config.remoteWorkloads.push(createDefaultContainerServiceWorkload());
      renderRemoteWorkloads();
      renderBedrockServers();
      syncRawJson();
    });
    // ─── Service Deploy Wizard ──────────────────────────────────────
    (function initServiceDeployWizard() {
      const dialog = document.getElementById('serviceDeployWizard');
      let selectedSvc = '';
      let createdWorkloadId = '';

      function openSvcWizard() {
        if (!firstWorkerNodeId()) {
          state.activeTab = 'infra';
          render();
          switchSubTab('infra', 'infra-nodes');
          setStatus('Add a worker node first in Nodes, then come back here to deploy a service.', 'error');
          return;
        }
        selectedSvc = '';
        createdWorkloadId = '';
        document.getElementById('svcCatalogNextBtn').disabled = true;
        dialog.querySelectorAll('.svc-catalog-card').forEach(c => c.classList.remove('selected'));
        showSvcStep('catalog');
        dialog.showModal();
      }

      function closeSvcWizard() {
        dialog.close();
      }

      function showSvcStep(step) {
        document.getElementById('svcStepCatalog').hidden = step !== 'catalog';
        document.getElementById('svcStepConfig').hidden = step !== 'config';
        document.getElementById('svcStepDeploy').hidden = step !== 'deploy';
      }

      // ── Catalog step ──
      dialog.querySelectorAll('.svc-catalog-card').forEach(card => {
        card.addEventListener('click', () => {
          dialog.querySelectorAll('.svc-catalog-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          selectedSvc = card.dataset.svc;
          document.getElementById('svcCatalogNextBtn').disabled = false;
        });
      });

      // ── Config step – builds form dynamically based on selection ──
      function buildConfigForm() {
        const container = document.getElementById('svcConfigFields');
        container.innerHTML = '';

        const nodes = state.config.workerNodes;
        const defaultNode = firstWorkerNodeId();
        const defaultGpuNode = firstGpuWorkerNodeId();

        if (selectedSvc === 'stt-service') {
          document.getElementById('svcConfigDesc').textContent = 'Configure stt-service for your GPU node. The wizard will save a repo-compose workload, inject the environment settings, and deploy it immediately.';
          container.innerHTML = \`
            <label class="wizard-field">
              <span class="wizard-label">Target Node</span>
              <select id="svcFieldNode">\${nodes.map(n => '<option value="' + n.id + '"' + (n.id === defaultGpuNode ? ' selected' : '') + '>' + n.id + ' (' + n.host + ')' + '</option>').join('')}</select>
              <span class="wizard-hint">The worker node where this service will be deployed.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Workload ID</span>
              <input id="svcFieldId" type="text" value="stt-service" />
              <span class="wizard-hint">Unique identifier for this workload. Keep it short and lowercase.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Git Repo URL</span>
              <input id="svcFieldRepo" type="text" value="https://github.com/goblinsan/stt-service.git" />
              <span class="wizard-hint">The repo will be cloned and built on the node. Uses docker-compose to bring up the stack.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Published Port</span>
              <input id="svcFieldPort" type="number" value="5101" />
              <span class="wizard-hint">Exposed port for the STT API + UI (nginx entry point).</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Model Cache Directory</span>
              <input id="svcFieldDataDir" type="text" value="/data/models/stt-service" />
              <span class="wizard-hint">Host path for cached Whisper and pyannote models.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Whisper Model Size</span>
              <select id="svcFieldModel">
                <option value="tiny">tiny – fastest, lowest accuracy</option>
                <option value="base">base – fast, decent accuracy</option>
                <option value="small">small – good balance</option>
                <option value="medium" selected>medium – recommended for RTX 4060</option>
                <option value="large-v3">large-v3 – best accuracy, needs 6+ GB VRAM</option>
              </select>
              <span class="wizard-hint">Larger models are more accurate but use more GPU memory.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Enable Diarization</span>
              <select id="svcFieldEnableDiarization">
                <option value="yes" selected>Yes</option>
                <option value="no">No</option>
              </select>
              <span class="wizard-hint">Adds pyannote environment settings and prompts you for the HuggingFace token.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">HF Token</span>
              <input id="svcFieldHfToken" type="password" value="" placeholder="hf_xxx" />
              <span class="wizard-hint">Required for pyannote speaker diarization. Stored as a secret env var in the workload config.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Diarization Whisper Model</span>
              <select id="svcFieldDiarizeModel">
                <option value="">Use main model</option>
                <option value="small" selected>small – lower VRAM, good diarization pairing</option>
                <option value="medium">medium – balanced</option>
              </select>
              <span class="wizard-hint">When diarization is enabled, use a smaller Whisper model to stay within an 8 GB VRAM budget.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Pyannote Idle Timeout (sec)</span>
              <input id="svcFieldPyannoteIdle" type="number" value="300" />
              <span class="wizard-hint">Automatically unload pyannote after inactivity to free VRAM for other services.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Warm Up Pyannote at Startup</span>
              <select id="svcFieldPyannoteWarmup">
                <option value="true">Yes</option>
                <option value="false" selected>No, lazy load on first diarize request</option>
              </select>
              <span class="wizard-hint">Disable warmup if you want faster initial deploys and lower idle VRAM usage.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Remote Source Allowed Hosts</span>
              <input id="svcFieldRemoteSourceHosts" type="text" value="" placeholder="&lt;accountid&gt;.r2.cloudflarestorage.com" />
              <span class="wizard-hint">Comma-separated host allowlist for presigned object URLs fetched by <code>/api/transcribe-from-url</code>. Required for gateway-tools-platform large uploads.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Remote Source Timeout (sec)</span>
              <input id="svcFieldRemoteSourceTimeout" type="number" value="600" />
              <span class="wizard-hint">How long the API will wait while downloading a presigned object before transcription starts.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Description</span>
              <input id="svcFieldDesc" type="text" value="Speech-to-text API + UI with optional speaker diarization" />
            </label>
          \`;
        } else if (selectedSvc === 'llm-service') {
          document.getElementById('svcConfigDesc').textContent = 'Configure llm-service for your GPU node. The wizard will register the repo-compose workload, set the model/runtime paths, and deploy the wrapper plus llama.cpp stack.';
          container.innerHTML = \`
            <label class="wizard-field">
              <span class="wizard-label">Target Node</span>
              <select id="svcFieldNode">\${nodes.map(n => '<option value="' + n.id + '"' + (n.id === defaultGpuNode ? ' selected' : '') + '>' + n.id + ' (' + n.host + ')' + '</option>').join('')}</select>
              <span class="wizard-hint">The worker node where this service will be deployed.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Workload ID</span>
              <input id="svcFieldId" type="text" value="llm-service" />
              <span class="wizard-hint">Unique identifier for this workload.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Git Repo URL</span>
              <input id="svcFieldRepo" type="text" value="https://github.com/goblinsan/llm-service.git" />
              <span class="wizard-hint">The repo is cloned and built on the worker node using its docker-compose stack.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Published Port</span>
              <input id="svcFieldPort" type="number" value="5301" />
              <span class="wizard-hint">Exposed port for the wrapper API and OpenAI-compatible endpoints.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Models Host Directory</span>
              <input id="svcFieldModelsHostDir" type="text" value="/data/models" />
              <span class="wizard-hint">Host path mounted to <code>/data/models</code> inside the container.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Runtime State Directory</span>
              <input id="svcFieldStateDir" type="text" value="/data/llm" />
              <span class="wizard-hint">Host path mounted to <code>/data/llm</code> for wrapper state, logs, and downloads.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Model Directory in Container</span>
              <input id="svcFieldModelsDir" type="text" value="/data/models/llm" />
              <span class="wizard-hint">Directory scanned by the wrapper for GGUF models.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Default Model Path</span>
              <input id="svcFieldModelPath" type="text" value="/data/models/llm/model.gguf" />
              <span class="wizard-hint">Initial GGUF file to load when the service starts. If it is not there yet, the wrapper will come up in no-model mode so you can download or load one later.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Context Size</span>
              <input id="svcFieldCtxSize" type="number" value="4096" />
              <span class="wizard-hint">Higher values improve long-context prompts but consume more VRAM.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">CUDA Architectures</span>
              <input id="svcFieldCudaArch" type="text" value="89" />
              <span class="wizard-hint">CMake CUDA arch list for the llama.cpp build. Use <code>89</code> for RTX 4060-class Ada GPUs, <code>86</code> for many RTX 30xx cards, or another explicit arch list for a different node.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Max Concurrent Requests</span>
              <input id="svcFieldMaxConcurrent" type="number" value="1" min="1" />
              <span class="wizard-hint">Keep this at 1 on a shared 8 GB GPU to avoid LLM/STT contention.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Admin Token</span>
              <input id="svcFieldAdminToken" type="password" value="" placeholder="optional" />
              <span class="wizard-hint">Used for model-management endpoints such as download and load.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Description</span>
              <input id="svcFieldDesc" type="text" value="Local llama.cpp wrapper with model management API" />
            </label>
          \`;
        } else if (selectedSvc === 'cv-sam-service') {
          document.getElementById('svcConfigDesc').textContent = 'Configure cv-sam-service for your GPU node. The wizard will save the repo-compose workload, pin the SAM model variant, and deploy the API stack.';
          container.innerHTML = \`
            <label class="wizard-field">
              <span class="wizard-label">Target Node</span>
              <select id="svcFieldNode">\${nodes.map(n => '<option value="' + n.id + '"' + (n.id === defaultGpuNode ? ' selected' : '') + '>' + n.id + ' (' + n.host + ')' + '</option>').join('')}</select>
              <span class="wizard-hint">The worker node where this service will be deployed.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Workload ID</span>
              <input id="svcFieldId" type="text" value="cv-sam-service" />
              <span class="wizard-hint">Unique identifier for this workload.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Git Repo URL</span>
              <input id="svcFieldRepo" type="text" value="https://github.com/goblinsan/cv-sam-service.git" />
              <span class="wizard-hint">The repo is cloned and built on the worker node using its docker-compose stack.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Published Port</span>
              <input id="svcFieldPort" type="number" value="5201" />
              <span class="wizard-hint">Exposed port for the segmentation and image-analysis API.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Models Host Directory</span>
              <input id="svcFieldModelsHostDir" type="text" value="/data/models" />
              <span class="wizard-hint">Host path mounted to <code>/data/models</code> inside the container.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">SAM Model Directory</span>
              <input id="svcFieldModelDir" type="text" value="/data/models/sam" />
              <span class="wizard-hint">Location inside the container where SAM checkpoints are cached.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">SAM Variant</span>
              <select id="svcFieldSamVariant">
                <option value="vit_b" selected>vit_b – recommended on shared 8 GB GPUs</option>
                <option value="vit_l">vit_l – larger, higher VRAM</option>
                <option value="vit_h">vit_h – largest, highest VRAM</option>
              </select>
              <span class="wizard-hint">Prefer <code>vit_b</code> when STT or LLM workloads share the GPU.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Description</span>
              <input id="svcFieldDesc" type="text" value="Segment Anything + CV utility API" />
            </label>
          \`;
        } else if (selectedSvc === 'container-service') {
          document.getElementById('svcConfigDesc').textContent = 'Configure a custom container service.';
          container.innerHTML = \`
            <label class="wizard-field">
              <span class="wizard-label">Target Node</span>
              <select id="svcFieldNode">\${nodes.map(n => '<option value="' + n.id + '"' + (n.id === defaultNode ? ' selected' : '') + '>' + n.id + ' (' + n.host + ')' + '</option>').join('')}</select>
              <span class="wizard-hint">The worker node where this service will run.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Workload ID</span>
              <input id="svcFieldId" type="text" value="" placeholder="my-service" />
              <span class="wizard-hint">Unique name for this workload (lowercase, hyphens ok).</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Docker Image</span>
              <input id="svcFieldImage" type="text" value="" placeholder="nginx:latest" />
              <span class="wizard-hint">The Docker image to pull and run.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Published Port</span>
              <input id="svcFieldPort" type="number" value="8080" />
              <span class="wizard-hint">Host port to expose.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Container Port</span>
              <input id="svcFieldTargetPort" type="number" value="80" />
              <span class="wizard-hint">Port inside the container to forward to.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">GPU Required</span>
              <select id="svcFieldGpu">
                <option value="no" selected>No</option>
                <option value="yes">Yes (NVIDIA runtime)</option>
              </select>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Description</span>
              <input id="svcFieldDesc" type="text" value="" placeholder="Describe the service" />
            </label>
          \`;
        } else if (selectedSvc === 'container-job') {
          document.getElementById('svcConfigDesc').textContent = 'Configure a scheduled container job.';
          container.innerHTML = \`
            <label class="wizard-field">
              <span class="wizard-label">Target Node</span>
              <select id="svcFieldNode">\${nodes.map(n => '<option value="' + n.id + '"' + (n.id === defaultNode ? ' selected' : '') + '>' + n.id + ' (' + n.host + ')' + '</option>').join('')}</select>
              <span class="wizard-hint">The worker node where this job will execute.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Workload ID</span>
              <input id="svcFieldId" type="text" value="" placeholder="my-job" />
              <span class="wizard-hint">Unique name for this workload.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Docker Image</span>
              <input id="svcFieldImage" type="text" value="" placeholder="alpine:latest" />
              <span class="wizard-hint">The Docker image used for each run.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Command</span>
              <input id="svcFieldCommand" type="text" value="" placeholder="echo hello" />
              <span class="wizard-hint">Command to execute inside the container.</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Schedule (cron)</span>
              <input id="svcFieldCron" type="text" value="0 * * * *" />
              <span class="wizard-hint">Cron expression for how often to run (default: every hour).</span>
            </label>
            <label class="wizard-field">
              <span class="wizard-label">Description</span>
              <input id="svcFieldDesc" type="text" value="" placeholder="Describe the job" />
            </label>
          \`;
        }
      }

      // ── Save & Deploy – constructs the workload config and triggers deploy ──
      async function saveAndDeploy() {
        const nodeId = document.getElementById('svcFieldNode').value;
        const workloadId = (document.getElementById('svcFieldId').value || '').trim();
        const desc = (document.getElementById('svcFieldDesc') || {}).value || '';

        if (!workloadId) {
          setStatus('Workload ID is required', 'error');
          return;
        }
        if (state.config.remoteWorkloads.some(w => w.id === workloadId)) {
          setStatus('A workload with ID "' + workloadId + '" already exists', 'error');
          return;
        }

        let workload;

        if (selectedSvc === 'stt-service') {
          const port = parseInt(document.getElementById('svcFieldPort').value, 10) || 5101;
          const dataDir = document.getElementById('svcFieldDataDir').value || '/data/stt-service';
          const model = document.getElementById('svcFieldModel').value || 'medium';
          const repo = document.getElementById('svcFieldRepo').value || '';
          const enableDiarization = document.getElementById('svcFieldEnableDiarization').value === 'yes';
          const hfToken = (document.getElementById('svcFieldHfToken').value || '').trim();
          const diarizeModel = (document.getElementById('svcFieldDiarizeModel').value || '').trim();
          const pyannoteIdle = parseInt(document.getElementById('svcFieldPyannoteIdle').value, 10) || 300;
          const pyannoteWarmup = (document.getElementById('svcFieldPyannoteWarmup').value || 'false').trim();
          const remoteSourceHosts = (document.getElementById('svcFieldRemoteSourceHosts').value || '').trim();
          const remoteSourceTimeout = parseInt(document.getElementById('svcFieldRemoteSourceTimeout').value, 10) || 600;
          const environment = [
            { key: 'STT_MODEL_SIZE', value: model, secret: false, description: 'faster-whisper model size' },
            { key: 'HOST_PORT', value: String(port), secret: false, description: 'Published port for nginx entry point' },
            { key: 'STT_MODEL_DIR', value: dataDir, secret: false, description: 'Host path for cached whisper and pyannote models' },
            { key: 'STT_REMOTE_SOURCE_TIMEOUT_SEC', value: String(remoteSourceTimeout), secret: false, description: 'Timeout for presigned remote-source downloads' }
          ];
          if (remoteSourceHosts) {
            environment.push({ key: 'STT_REMOTE_SOURCE_ALLOWED_HOSTS', value: remoteSourceHosts, secret: false, description: 'Comma-separated allowlist for remote-source object URLs' });
          }
          if (enableDiarization) {
            environment.push(
              { key: 'STT_HF_TOKEN', value: hfToken, secret: true, description: 'HuggingFace token for pyannote diarization models' },
              { key: 'STT_PYANNOTE_IDLE_TIMEOUT_SEC', value: String(pyannoteIdle), secret: false, description: 'Idle timeout before unloading pyannote' },
              { key: 'STT_WARMUP_PYANNOTE', value: pyannoteWarmup, secret: false, description: 'Warm pyannote at startup' }
            );
            if (diarizeModel) {
              environment.push({ key: 'STT_DIARIZE_WHISPER_MODEL', value: diarizeModel, secret: false, description: 'Smaller Whisper model for diarized requests' });
            }
          }

          workload = {
            id: workloadId,
            enabled: true,
            nodeId: nodeId,
            description: desc,
            kind: 'container-service',
            service: {
              build: {
                strategy: 'repo-compose',
                repoUrl: repo,
                defaultRevision: 'main',
                contextPath: '.',
              },
              networkMode: 'bridge',
              restartPolicy: 'unless-stopped',
              autoStart: true,
              runtimeClass: 'nvidia',
              command: '',
              environment,
              volumeMounts: [],
              jsonFiles: [],
              ports: [
                { published: port, target: 80, protocol: 'tcp' }
              ],
              healthCheck: {
                protocol: 'http',
                port: port,
                path: '/api/health',
                expectedStatus: 200
              }
            }
          };
        } else if (selectedSvc === 'llm-service') {
          const port = parseInt(document.getElementById('svcFieldPort').value, 10) || 5301;
          const repo = (document.getElementById('svcFieldRepo').value || '').trim();
          const modelsHostDir = (document.getElementById('svcFieldModelsHostDir').value || '/data/models').trim();
          const stateDir = (document.getElementById('svcFieldStateDir').value || '/data/llm').trim();
          const modelsDir = (document.getElementById('svcFieldModelsDir').value || '/data/models/llm').trim();
          const modelPath = (document.getElementById('svcFieldModelPath').value || '/data/models/llm/model.gguf').trim();
          const ctxSize = parseInt(document.getElementById('svcFieldCtxSize').value, 10) || 4096;
          const cudaArch = (document.getElementById('svcFieldCudaArch').value || '89').trim() || '89';
          const maxConcurrent = parseInt(document.getElementById('svcFieldMaxConcurrent').value, 10) || 1;
          const adminToken = (document.getElementById('svcFieldAdminToken').value || '').trim();

          workload = {
            id: workloadId,
            enabled: true,
            nodeId: nodeId,
            description: desc,
            kind: 'container-service',
            service: {
              build: {
                strategy: 'repo-compose',
                repoUrl: repo,
                defaultRevision: 'main',
                contextPath: '.',
              },
              networkMode: 'bridge',
              restartPolicy: 'unless-stopped',
              autoStart: true,
              runtimeClass: 'nvidia',
              command: '',
              environment: [
                { key: 'HOST_PORT', value: String(port), secret: false, description: 'Published port for the wrapper API' },
                { key: 'MODELS_HOST_DIR', value: modelsHostDir, secret: false, description: 'Host path mounted to /data/models' },
                { key: 'LLM_STATE_DIR', value: stateDir, secret: false, description: 'Host path mounted to /data/llm' },
                { key: 'MODELS_DIR', value: modelsDir, secret: false, description: 'Directory scanned for GGUF models' },
                { key: 'MODEL_PATH', value: modelPath, secret: false, description: 'Initial GGUF file loaded at startup' },
                { key: 'CTX_SIZE', value: String(ctxSize), secret: false, description: 'llama.cpp context size' },
                { key: 'LLAMA_CUDA_ARCHITECTURES', value: cudaArch, secret: false, description: 'CUDA architectures used when building llama.cpp' },
                { key: 'MAX_CONCURRENT_REQUESTS', value: String(maxConcurrent), secret: false, description: 'Concurrent inference request limit' },
                { key: 'ADMIN_TOKEN', value: adminToken, secret: true, description: 'Admin token for model management endpoints' }
              ],
              volumeMounts: [],
              jsonFiles: [],
              ports: [
                { published: port, target: 8080, protocol: 'tcp' }
              ],
              healthCheck: {
                protocol: 'http',
                port: port,
                path: '/health',
                expectedStatus: 200
              }
            }
          };
        } else if (selectedSvc === 'cv-sam-service') {
          const port = parseInt(document.getElementById('svcFieldPort').value, 10) || 5201;
          const repo = (document.getElementById('svcFieldRepo').value || '').trim();
          const modelsHostDir = (document.getElementById('svcFieldModelsHostDir').value || '/data/models').trim();
          const modelDir = (document.getElementById('svcFieldModelDir').value || '/data/models/sam').trim();
          const samVariant = (document.getElementById('svcFieldSamVariant').value || 'vit_b').trim();

          workload = {
            id: workloadId,
            enabled: true,
            nodeId: nodeId,
            description: desc,
            kind: 'container-service',
            service: {
              build: {
                strategy: 'repo-compose',
                repoUrl: repo,
                defaultRevision: 'main',
                contextPath: '.',
              },
              networkMode: 'bridge',
              restartPolicy: 'unless-stopped',
              autoStart: true,
              runtimeClass: 'nvidia',
              command: '',
              environment: [
                { key: 'HOST_PORT', value: String(port), secret: false, description: 'Published port for the CV API' },
                { key: 'MODELS_HOST_DIR', value: modelsHostDir, secret: false, description: 'Host path mounted to /data/models' },
                { key: 'MODEL_DIR', value: modelDir, secret: false, description: 'Checkpoint cache directory inside the container' },
                { key: 'CV_SAM_VARIANT', value: samVariant, secret: false, description: 'Segment Anything model variant' }
              ],
              volumeMounts: [],
              jsonFiles: [],
              ports: [
                { published: port, target: 5201, protocol: 'tcp' }
              ],
              healthCheck: {
                protocol: 'http',
                port: port,
                path: '/api/health',
                expectedStatus: 200
              }
            }
          };
        } else if (selectedSvc === 'container-service') {
          const port = parseInt(document.getElementById('svcFieldPort').value, 10) || 8080;
          const targetPort = parseInt(document.getElementById('svcFieldTargetPort').value, 10) || 80;
          const image = document.getElementById('svcFieldImage').value || '';
          const gpu = document.getElementById('svcFieldGpu').value === 'yes';

          if (!image) {
            setStatus('Docker image is required', 'error');
            return;
          }

          workload = {
            id: workloadId,
            enabled: true,
            nodeId: nodeId,
            description: desc,
            kind: 'container-service',
            service: {
              image: image,
              networkMode: 'bridge',
              restartPolicy: 'unless-stopped',
              autoStart: true,
              runtimeClass: gpu ? 'nvidia' : 'default',
              command: '',
              environment: [],
              volumeMounts: [],
              jsonFiles: [],
              ports: [
                { published: port, target: targetPort, protocol: 'tcp' }
              ],
              healthCheck: null
            }
          };
        } else if (selectedSvc === 'container-job') {
          const image = document.getElementById('svcFieldImage').value || '';
          const command = document.getElementById('svcFieldCommand').value || '';
          const cron = document.getElementById('svcFieldCron').value || '0 * * * *';

          workload = {
            id: workloadId,
            enabled: true,
            nodeId: nodeId,
            description: desc,
            kind: 'scheduled-container-job',
            job: {
              schedule: cron,
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
              runCommand: command,
              environment: [],
              volumeMounts: [],
              jsonFiles: []
            }
          };
        }

        if (!workload) return;

        // show deploy step
        showSvcStep('deploy');
        const log = document.getElementById('svcDeployLog');
        const actions = document.getElementById('svcDeployActions');
        log.innerHTML = '';
        actions.hidden = true;
        createdWorkloadId = workloadId;

        function appendLog(text, cls) {
          const line = document.createElement('div');
          line.className = 'wizard-log-line' + (cls ? ' ' + cls : '');
          line.textContent = text;
          log.appendChild(line);
          log.scrollTop = log.scrollHeight;
        }

        appendLog('Adding workload to config…');
        state.config.remoteWorkloads.push(workload);
        renderRemoteWorkloads();
        renderBedrockServers();
        syncRawJson();

        try {
          appendLog('Saving configuration…');
          await persistConfigState({ renderAfterSave: false });
          appendLog('Configuration saved ✓', 'success');

          appendLog('Starting deploy of ' + workloadId + '…');
          const queued = await requestJson('POST', '/api/remote-workloads/' + encodeURIComponent(workloadId) + '/deploy', {}, 30000);
          appendLog(queued.message || ('Queued deploy for ' + workloadId), 'success');
          appendLog('Polling deploy status…');
          const result = await waitForRemoteDeployJob(workloadId, queued.jobId);
          appendLog(result.message || 'Deploy completed ✓', 'success');
          if (result.deployLog) {
            renderDeployTelemetry(result.deployLog, result.durationMs, log);
          }
          appendLog('');
          appendLog('Service deployed successfully!', 'success');
          pushActionFeed('Deployed service ' + workloadId);
        } catch (err) {
          const detail = err.failedStep ? ' [step: ' + err.failedStep + ']' : '';
          const errorType = err.errorType ? ' (' + err.errorType + ')' : '';
          appendLog('Deploy failed: ' + (err.message || err) + detail + errorType, 'error');
          if (err.deployLog) {
            renderDeployTelemetry(err.deployLog, err.durationMs, log);
          }
          appendLog('');
          appendLog('The workload config has been saved. You can retry the deploy from the workload card.', 'info');
        }

        actions.hidden = false;
      }

      // ── Wire events ──
      document.getElementById('openServiceDeployWizardButton').addEventListener('click', openSvcWizard);
      document.getElementById('openServiceDeployWizardButtonSvc').addEventListener('click', openSvcWizard);
      document.getElementById('closeSvcWizardButton').addEventListener('click', closeSvcWizard);
      document.getElementById('svcCatalogCancelBtn').addEventListener('click', closeSvcWizard);
      document.getElementById('svcCatalogNextBtn').addEventListener('click', () => {
        if (!selectedSvc) return;
        buildConfigForm();
        showSvcStep('config');
      });
      document.getElementById('svcConfigBackBtn').addEventListener('click', () => showSvcStep('catalog'));
      document.getElementById('svcConfigDeployBtn').addEventListener('click', saveAndDeploy);
      document.getElementById('svcDeployCloseBtn').addEventListener('click', () => {
        closeSvcWizard();
        if (createdWorkloadId) {
          refreshContainerServiceStatus(createdWorkloadId).catch(() => {});
        }
      });
      dialog.addEventListener('cancel', closeSvcWizard);
    })();
    // ─── End Service Deploy Wizard ────────────────────────────────────

    const addBedrockServerWorkload = () => {
      if (!firstWorkerNodeId()) {
        state.activeTab = 'infra';
        render();
        switchSubTab('infra', 'infra-nodes');
        setStatus('Add a worker node first. Set a Node Id and host in Nodes, then come back to Minecraft.', 'error');
        return;
      }
      state.config.remoteWorkloads.push(createDefaultBedrockWorkload());
      renderRemoteWorkloads();
      renderBedrockServers();
      syncRawJson();
    };
    document.getElementById('addBedrockWorkloadButton').addEventListener('click', addBedrockServerWorkload);
    document.getElementById('addBedrockServerButton').addEventListener('click', addBedrockServerWorkload);
    document.getElementById('addGatewayApiEnvButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.environment.push({
        key: '',
        value: '',
        secret: false
      });
      renderGatewayApiProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addGatewayApiChannelButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.jobRuntime.channels.push({
        id: '',
        type: 'telegram',
        enabled: true
      });
      renderGatewayApiJobRuntimeProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addKulrsBotButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.kulrsActivity.bots.push({
        id: '',
        email: '',
        password: ''
      });
      renderKulrsActivityProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addGatewayChatEnvButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayChatPlatform.environment.push({
        key: '',
        value: '',
        secret: false
      });
      renderGatewayChatPlatformProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addGatewayApiSecretButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.environment.push({
        key: '',
        value: '',
        secret: true
      });
      renderGatewayApiProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addGatewayApiSecretChannelButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.jobRuntime.channels.push({
        id: '',
        type: 'telegram',
        enabled: true
      });
      renderGatewayApiJobRuntimeProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addKulrsSecretBotButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayApi.kulrsActivity.bots.push({
        id: '',
        email: '',
        password: ''
      });
      renderKulrsActivityProfile();
      renderSecrets();
      syncRawJson();
    });
    document.getElementById('addGatewayChatSecretButton').addEventListener('click', () => {
      state.config.serviceProfiles.gatewayChatPlatform.environment.push({
        key: '',
        value: '',
        secret: true
      });
      renderGatewayChatPlatformProfile();
      renderSecrets();
      syncRawJson();
    });
    ['kulrsFirebaseApiKeySecrets', 'kulrsUnsplashAccessKeySecrets'].forEach((id) => {
      document.getElementById(id).addEventListener('input', (event) => {
        const target = event.target;
        const key = id === 'kulrsFirebaseApiKeySecrets' ? 'firebaseApiKey' : 'unsplashAccessKey';
        state.config.serviceProfiles.gatewayApi.kulrsActivity[key] = target.value;
        renderKulrsActivityProfile();
        renderSecrets();
        syncRawJson();
      });
    });
    document.getElementById('addGatewayChatAgentButton').addEventListener('click', () => {
      state.activeTab = 'agents';
      const providerName = firstAvailableProviderName();
      state.config.serviceProfiles.gatewayChatPlatform.agents.push({
        id: '',
        name: '',
        icon: '🤖',
        color: '#6366f1',
        providerName,
        model: firstAvailableModelId(providerName),
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

    document.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button || button.disabled || button.dataset.tab || button.dataset.openTab) {
        return;
      }
      const label = (button.textContent || '').trim();
      if (!label) {
        return;
      }
      setStatus('Working: ' + label, 'progress', { log: true });
    }, true);

    fetchConfig()
      .then(() => fetchRuntime())
      .then(() => loadTabData(state.activeTab, { silent: true }))
      .catch((error) => setStatus(error.message, 'error'));
    applyActionFeedVisibility();
    setInterval(() => {
      fetchRuntime().catch(() => undefined);
    }, 15000);
    setInterval(() => {
      const sub = state.activeSubTabs[state.activeTab];
      if (sub === 'wl-remote' || sub === 'infra-nodes' || sub === 'svc-deploys') {
        refreshAllRemoteServiceStatuses({ silent: true }).then(() => markLoaded('remoteServiceStatuses')).catch(() => undefined);
      }
    }, 30000);
    setInterval(() => {
      if (state.activeSubTabs[state.activeTab] === 'infra-minecraft') {
        refreshAllMinecraftStatuses({ silent: true, skipRegistry: true }).then(() => markLoaded('minecraftStatuses')).catch(() => undefined);
      }
    }, 60000);
`;
