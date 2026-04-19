/**
 * Admin UI — config form helpers browser-runtime module.
 * Extracted from script.ts.
 */

export const CONFIG_FORM_SCRIPT = `    function updateGatewayField(key, value) {
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

    function findEnvironmentEntry(environment, key) {
      return environment.find((entry) => entry.key === key);
    }

    function getEnvironmentValue(environment, key, fallback = '') {
      return findEnvironmentEntry(environment, key)?.value || fallback;
    }

    function normalizeSingleLineInput(value) {
      return String(value || '').replace(/\\r?\\n/g, '').trim();
    }

    function createGatewayToolsEnvBuildCommands(values) {
      const envLines = [
        'STT_SERVICE_URL=' + normalizeSingleLineInput(values.sttServiceUrl),
        'CV_SERVICE_URL=' + normalizeSingleLineInput(values.cvServiceUrl),
        'DATA_ROOT=/data',
        'DATA_ROOT_HOST=__SHARED__/data',
        'OBJECT_STORE_BUCKET=' + normalizeSingleLineInput(values.objectStoreBucket),
        'OBJECT_STORE_REGION=' + normalizeSingleLineInput(values.objectStoreRegion || 'auto'),
        'OBJECT_STORE_ENDPOINT=' + normalizeSingleLineInput(values.objectStoreEndpoint),
        'OBJECT_STORE_ACCESS_KEY_ID=' + normalizeSingleLineInput(values.objectStoreAccessKeyId),
        'OBJECT_STORE_SECRET_ACCESS_KEY=' + normalizeSingleLineInput(values.objectStoreSecretAccessKey),
        'OBJECT_STORE_FORCE_PATH_STYLE=' + (values.objectStoreForcePathStyle ? 'true' : 'false')
      ];
      return [
        'mkdir -p __SHARED__/data',
        "cat > __SHARED__/.env.local <<'EOF'\\n" + envLines.join('\\n') + '\\nEOF'
      ];
    }

    function upsertEnvironmentEntry(environment, key, value, description, secret = false) {
      const existing = findEnvironmentEntry(environment, key);
      if (!value) {
        const index = environment.findIndex((entry) => entry.key === key);
        if (index >= 0) {
          environment.splice(index, 1);
        }
        return;
      }
      if (existing) {
        existing.value = value;
        existing.secret = secret;
        existing.description = description;
        return;
      }
      environment.push({ key, value, secret, description });
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
            if (isCheckbox) {
              renderSecrets();
            }
            syncRawJson();
          });
        });
        container.appendChild(element);
      });
    }

    function renderSecretEnvironmentList(containerId, environment, onAddSecret, onRenderFullProfile) {
      const container = document.getElementById(containerId);
      container.innerHTML = '';
      const secrets = environment
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.secret);

      if (secrets.length === 0) {
        container.innerHTML = '<div>No secret env vars configured yet.</div>';
        return;
      }

      secrets.forEach(({ entry, index }) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${entry.key || 'new-secret-env-var'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label>Key<input data-field="key" value="\${entry.key}" /></label>
            <label>Value<input type="password" data-field="value" value="\${entry.value}" /></label>
            <label class="check"><input type="checkbox" data-field="secret" \${entry.secret ? 'checked' : ''} /> Secret</label>
          </div>
          <label>Description<input data-field="description" value="\${entry.description || ''}" /></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          environment.splice(index, 1);
          onRenderFullProfile();
          renderSecrets();
          syncRawJson();
        });

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
            if (isCheckbox) {
              onRenderFullProfile();
              renderSecrets();
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

    function firstAvailableProviderName() {
      const providers = normalizedChatProviders();
      return providers[0]?.name || '';
    }

    function providerOptions(currentProviderName) {
      const providers = normalizedChatProviders();
      const knownProviders = [...providers];
      if (currentProviderName && !knownProviders.some((provider) => provider.name === currentProviderName)) {
        knownProviders.unshift({ name: currentProviderName, status: 'ok' });
      }
      const options = [];
      if (!currentProviderName) {
        options.push('<option value="" selected disabled>Select provider</option>');
      }
      return options.concat(
        knownProviders
          .map((provider) => \`<option value="\${provider.name}" \${provider.name === currentProviderName ? 'selected' : ''}>\${provider.name}</option>\`)
      ).join('');
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
      const options = [];
      if (!currentModel) {
        options.push(\`<option value="" selected \${providerName ? '' : 'disabled'}>\${providerName ? 'Select model' : 'Choose provider first'}</option>\`);
      }
      return options.concat(
        knownModels
          .map((model) => \`<option value="\${model.id}" \${model.id === currentModel ? 'selected' : ''}>\${model.name || model.id}</option>\`)
      ).join('');
    }

    function firstAvailableModelId(providerName) {
      const rawModels = Array.isArray(state.providerModels?.[providerName]) ? state.providerModels[providerName] : [];
      const knownModels = rawModels.map((model) => normalizeModel(model)).filter((model) => model.id);
      return knownModels[0]?.id || '';
    }

    function ensureAgentProviderAndModel(agent) {
      if (!agent.providerName) {
        agent.providerName = firstAvailableProviderName();
      }
      if (!agent.model && agent.providerName) {
        agent.model = firstAvailableModelId(agent.providerName);
      }
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

`;
