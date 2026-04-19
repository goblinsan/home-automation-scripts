/**
 * Admin UI — gateway renderer + global render browser-runtime module.
 * Extracted from script.ts.
 */

export const BOOTSTRAP_SCRIPT = `    function renderGateway() {
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
      renderGatewayApiJobRuntimeProfile();
      renderKulrsActivityProfile();
      renderGatewayChatPlatformProfile();
      renderPiProxyProfile();
      renderSecrets();
      renderJobCatalog();
      renderWorkflows();
      renderWorkerNodes();
      renderRemoteWorkloads();
      renderBedrockServers();
      renderAutomation();
      renderApps();
      renderJobs();
      renderFeatures();
      renderRuntime();
      renderMonitoringSettings();
      syncRawJson();
      renderActiveTab();
    }

    async function fetchConfig() {
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          state.config = await requestJson('GET', '/api/config', undefined, attempt === 1 ? 30000 : 60000);
          render();
          setStatus('Current', 'ok', { log: false });
          return;
        } catch (error) {
          lastError = error;
          const detail = describeClientError(error);
          const timedOut = detail === 'Request timed out: /api/config' || detail === 'Config load timed out';
          if (!timedOut || attempt === 2) {
            throw new Error(timedOut ? 'Config load timed out' : detail);
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      throw new Error(describeClientError(lastError));
    }

`;
