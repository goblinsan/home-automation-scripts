/**
 * Admin UI — state initialization browser-runtime module.
 * Extracted from script.ts.
 */

export function renderScriptState(defaultWorkflowSeedPath: string): string {
  const DEFAULT_WORKFLOW_SEED_PATH = defaultWorkflowSeedPath;
  return `    const state = {
      config: null,
      runtime: null,
      workflows: [],
      jobsCatalog: [],
      minecraftStatuses: {},
      remoteServiceStatuses: {},
      remoteDeployJobIds: {},
      chatProviders: [],
      providerModels: {},
      ttsStatus: null,
      ttsVoices: [],
      piProxyRegistry: null,
      piProxyStatus: null,
      kulrsActivityStatus: null,
      coachDiagnostics: null,
      healthSnapshot: null,
      projectTrackingOverview: null,
      benchmarkRuns: [],
      appSlots: {},
      actionFeedCollapsed: false,
      agentRun: {
        agentId: '',
        prompt: 'Give me a short readiness check in character, then confirm the local model route is working.',
        contextJson: '{}',
        deliveryJson: '{}',
        workflowSeedPath: '${DEFAULT_WORKFLOW_SEED_PATH}',
        result: null
      },
      activeTab: 'overview',
      activeSubTabs: {
        infra: 'infra-gateway',
        services: 'svc-agents',
        monitoring: 'mon-health',
        workloads: 'wl-remote',
      },
      dataLoaded: {},
      subTabLoading: {}
    };

    const REMOTE_DEPLOY_JOB_IDS_STORAGE_KEY = 'gateway-admin-remote-deploy-job-ids';

    function loadStoredRemoteDeployJobIds() {
      try {
        const raw = window.localStorage.getItem(REMOTE_DEPLOY_JOB_IDS_STORAGE_KEY);
        if (!raw) {
          return {};
        }
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function persistRemoteDeployJobIds() {
      try {
        window.localStorage.setItem(
          REMOTE_DEPLOY_JOB_IDS_STORAGE_KEY,
          JSON.stringify(state.remoteDeployJobIds || {})
        );
      } catch {
        // ignore storage failures
      }
    }

    function rememberRemoteDeployJobId(workloadId, jobId) {
      if (!workloadId || !jobId) {
        return;
      }
      state.remoteDeployJobIds[workloadId] = jobId;
      persistRemoteDeployJobIds();
    }

    function clearRememberedRemoteDeployJobId(workloadId) {
      if (!workloadId || !state.remoteDeployJobIds[workloadId]) {
        return;
      }
      delete state.remoteDeployJobIds[workloadId];
      persistRemoteDeployJobIds();
    }

`;
}
