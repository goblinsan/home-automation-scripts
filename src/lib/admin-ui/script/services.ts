/**
 * Admin UI — services/profiles renderers browser-runtime module.
 * Extracted from script.ts.
 */

export const SERVICES_SCRIPT = `    function renderGatewayApiProfile() {
      const profile = state.config.serviceProfiles.gatewayApi;
      document.getElementById('gatewayApiProfileEnabled').checked = profile.enabled;
      document.getElementById('gatewayApiProfileAppId').innerHTML = appOptions(profile.appId);
      document.getElementById('gatewayApiProfileApiBaseUrl').value = profile.apiBaseUrl;
      document.getElementById('gatewayApiProfileEnvFilePath').value = profile.envFilePath;
      renderEnvironmentList('gatewayApiEnvContainer', profile.environment, (index) => {
        profile.environment.splice(index, 1);
        renderGatewayApiProfile();
        renderSecrets();
        syncRawJson();
      });
    }

    function renderGatewayApiJobRuntimeProfile() {
      const runtime = state.config.serviceProfiles.gatewayApi.jobRuntime;
      document.getElementById('gatewayApiJobChannelsFilePath').value = runtime.channelsFilePath;

      const container = document.getElementById('gatewayApiJobChannelsContainer');
      container.innerHTML = '';
      if (runtime.channels.length === 0) {
        container.innerHTML = '<div>No delivery channels configured yet.</div>';
        return;
      }

      runtime.channels.forEach((channel, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${channel.id || 'new-channel'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${channel.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Channel Id<input data-field="id" value="\${channel.id}" /></label>
            <label>Type
              <select data-field="type">
                <option value="telegram" \${channel.type === 'telegram' ? 'selected' : ''}>telegram</option>
                <option value="webhook" \${channel.type === 'webhook' ? 'selected' : ''}>webhook</option>
              </select>
            </label>
            <label>Description<input data-field="description" value="\${channel.description || ''}" /></label>
          </div>
          <div class="row">
            <label>Telegram Bot Token<input type="password" data-field="botToken" value="\${channel.botToken || ''}" /></label>
            <label>Telegram Chat Id<input data-field="chatId" value="\${channel.chatId || ''}" /></label>
            <label>Parse Mode<input data-field="parseMode" value="\${channel.parseMode || ''}" /></label>
            <label>Thread Id<input type="number" data-field="messageThreadId" value="\${channel.messageThreadId ?? ''}" /></label>
          </div>
          <div class="row">
            <label>Webhook URL<input data-field="webhookUrl" value="\${channel.webhookUrl || ''}" /></label>
          </div>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          runtime.channels.splice(index, 1);
          renderGatewayApiJobRuntimeProfile();
          renderSecrets();
          syncRawJson();
        });

        element.querySelectorAll('input, select').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const isSelect = input.tagName === 'SELECT';
          const eventName = isCheckbox || isSelect ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            if (field === 'enabled') {
              channel.enabled = input.checked;
            } else if (field === 'messageThreadId') {
              channel.messageThreadId = input.value ? Number(input.value) : undefined;
              if (!input.value) {
                delete channel.messageThreadId;
              }
            } else {
              channel[field] = input.value;
              if ((field === 'description' || field === 'botToken' || field === 'chatId' || field === 'parseMode' || field === 'webhookUrl') && !input.value) {
                delete channel[field];
              }
            }
            if (isCheckbox || isSelect || field === 'type') {
              renderSecrets();
            }
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderKulrsActivityProfile() {
      const kulrs = state.config.serviceProfiles.gatewayApi.kulrsActivity;
      document.getElementById('kulrsEnabled').checked = kulrs.enabled;
      document.getElementById('kulrsSchedule').value = kulrs.schedule;
      document.getElementById('kulrsUser').value = kulrs.user;
      document.getElementById('kulrsGroup').value = kulrs.group || '';
      document.getElementById('kulrsTimezone').value = kulrs.timezone;
      document.getElementById('kulrsEnvFilePath').value = kulrs.envFilePath;
      document.getElementById('kulrsCredentialsFilePath').value = kulrs.credentialsFilePath;
      document.getElementById('kulrsWorkspaceDir').value = kulrs.workspaceDir;
      document.getElementById('kulrsWorkingDirectory').value = kulrs.workingDirectory;
      document.getElementById('kulrsExecStart').value = kulrs.execStart;
      document.getElementById('kulrsCreateMode').value = kulrs.createMode;
      document.getElementById('kulrsLlmBaseUrl').value = kulrs.llmBaseUrl;
      document.getElementById('kulrsLlmModel').value = kulrs.llmModel;
      document.getElementById('kulrsLlmApiKey').value = kulrs.llmApiKey;
      document.getElementById('kulrsLlmTimeoutMs').value = String(kulrs.llmTimeoutMs);
      document.getElementById('kulrsLlmTemperature').value = String(kulrs.llmTemperature);
      document.getElementById('kulrsCronLogPath').value = kulrs.cronLogPath;
      document.getElementById('kulrsCronLogRetentionDays').value = String(kulrs.cronLogRetentionDays);
      document.getElementById('kulrsCronLogMaxLines').value = String(kulrs.cronLogMaxLines);
      document.getElementById('kulrsDescription').value = kulrs.description;
      document.getElementById('kulrsFirebaseApiKey').value = kulrs.firebaseApiKey;
      document.getElementById('kulrsUnsplashAccessKey').value = kulrs.unsplashAccessKey;
      const statusMeta = document.getElementById('kulrsStatus');
      if (!state.kulrsActivityStatus) {
        statusMeta.innerHTML = '<div><strong>Runtime Status:</strong> not checked yet</div>';
      } else if (state.kulrsActivityStatus.error) {
        statusMeta.innerHTML = [
          '<div><strong>Runtime Status:</strong> error</div>',
          '<div><strong>Detail:</strong> ' + escapeHtml(state.kulrsActivityStatus.error) + '</div>'
        ].join('');
      } else {
        statusMeta.innerHTML = [
          '<div><strong>Config Enabled:</strong> ' + escapeHtml(state.kulrsActivityStatus.configuredEnabled ? 'yes' : 'no') + '</div>',
          '<div><strong>Timer State:</strong> ' + escapeHtml(state.kulrsActivityStatus.timerActiveState + '/' + state.kulrsActivityStatus.timerSubState) + '</div>',
          '<div><strong>Timer Installed:</strong> ' + escapeHtml(state.kulrsActivityStatus.timerInstalled ? 'yes' : 'no') + '</div>',
          '<div><strong>Timer Unit File:</strong> ' + escapeHtml(state.kulrsActivityStatus.timerUnitFileState || 'unknown') + '</div>',
          '<div><strong>Last Run:</strong> ' + escapeHtml(formatTimestamp(state.kulrsActivityStatus.lastRunAt)) + '</div>',
          '<div><strong>Next Run:</strong> ' + escapeHtml(formatTimestamp(state.kulrsActivityStatus.nextRunAt)) + '</div>',
          '<div><strong>Log Path:</strong> ' + escapeHtml(state.kulrsActivityStatus.logPath || 'unknown') + '</div>',
          '<div><strong>Drift:</strong> ' + escapeHtml(state.kulrsActivityStatus.driftDetected ? 'yes' : 'no') + '</div>',
          '<div><strong>Summary:</strong> ' + escapeHtml(state.kulrsActivityStatus.summary || 'unknown') + '</div>'
        ].join('');
      }

      const container = document.getElementById('kulrsBotsContainer');
      container.innerHTML = '';
      if (kulrs.bots.length === 0) {
        container.innerHTML = '<div>No KULRS bot credentials configured yet.</div>';
        return;
      }

      kulrs.bots.forEach((bot, index) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${bot.id || 'new-kulrs-bot'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label>Bot Id<input data-field="id" value="\${bot.id}" /></label>
            <label>Email<input data-field="email" value="\${bot.email}" /></label>
            <label>Password<input type="password" data-field="password" value="\${bot.password}" /></label>
          </div>
          <label>Description<input data-field="description" value="\${bot.description || ''}" /></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          kulrs.bots.splice(index, 1);
          renderKulrsActivityProfile();
          renderSecrets();
          syncRawJson();
        });

        element.querySelectorAll('input').forEach((input) => {
          input.addEventListener('input', () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            bot[field] = input.value;
            if (field === 'description' && !input.value) {
              delete bot.description;
            }
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderGatewayChatPlatformProfile() {
      const profile = state.config.serviceProfiles.gatewayChatPlatform;
      document.getElementById('gatewayChatProfileEnabled').checked = profile.enabled;
      document.getElementById('gatewayChatProfileAppId').innerHTML = appOptions(profile.appId);
      document.getElementById('gatewayChatProfileApiBaseUrl').value = profile.apiBaseUrl;
      document.getElementById('gatewayChatProfileEnvFilePath').value = profile.apiEnvFilePath;
      document.getElementById('gatewayChatRedisUrl').value = getEnvironmentValue(profile.environment, 'REDIS_URL');
      document.getElementById('gatewayChatDefaultUserId').value = getEnvironmentValue(profile.environment, 'CHAT_DEFAULT_USER_ID', 'me');
      document.getElementById('gatewayChatDefaultChannelId').value = getEnvironmentValue(profile.environment, 'CHAT_DEFAULT_CHANNEL_ID', 'coach');
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
        renderSecrets();
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
        ensureAgentProviderAndModel(agent);
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
              agent.model = firstAvailableModelId(agent.providerName);
              renderGatewayChatPlatformProfile();
            } else {
              agent[field] = input.value;
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

    function renderJobCatalog() {
      const container = document.getElementById('jobsCatalogContainer');
      container.innerHTML = '';

      if (!state.config || !state.config.serviceProfiles.gatewayApi.enabled) {
        container.innerHTML = '<p>gateway-api service profile is disabled.</p>';
        return;
      }

      if (state.jobsCatalog.length === 0) {
        container.innerHTML = '<p>No catalog jobs reported by gateway-api.</p>';
        return;
      }

      state.jobsCatalog.forEach((job) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div>
              <strong>\${job.name || job.id}</strong>
              <p>\${job.description || 'No description provided.'}</p>
            </div>
          </div>
          <div class="meta-list">
            <div><strong>Job Id:</strong> \${job.id}</div>
            <div><strong>Target Type:</strong> gateway-jobs.run</div>
            <div><strong>Target Ref:</strong> \${job.id}</div>
          </div>
        \`;
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

`;
