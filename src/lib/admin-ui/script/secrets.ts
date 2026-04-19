/**
 * Admin UI — secrets renderer browser-runtime module.
 * Extracted from script.ts.
 */

export const SECRETS_SCRIPT = `    function renderPiProxyProfile() {
      const profile = state.config.serviceProfiles.piProxy;
      document.getElementById('piProxyNodeId').innerHTML = workerNodeOptions(profile.nodeId);
      document.getElementById('piProxyEnabled').checked = profile.enabled;
      document.getElementById('piProxyDescription').value = profile.description;
      document.getElementById('piProxyInstallRoot').value = profile.installRoot;
      document.getElementById('piProxySystemdUnitName').value = profile.systemdUnitName;
      document.getElementById('piProxyRegistryBaseUrl').value = profile.registryBaseUrl;
      document.getElementById('piProxyListenHost').value = profile.listenHost;
      document.getElementById('piProxyListenPort').value = String(profile.listenPort);
      document.getElementById('piProxyServiceUser').value = profile.serviceUser || '';
      document.getElementById('piProxyServiceGroup').value = profile.serviceGroup || '';
      document.getElementById('piProxyRegistryPath').value = profile.registryPath;
      document.getElementById('piProxyPollIntervalSeconds').value = String(profile.pollIntervalSeconds);
      const normalizedBaseUrl = profile.registryBaseUrl.endsWith('/') ? profile.registryBaseUrl.slice(0, -1) : profile.registryBaseUrl;
      document.getElementById('piProxyRegistryUrlPreview').value = normalizedBaseUrl + (profile.registryPath.startsWith('/') ? profile.registryPath : '/' + profile.registryPath);

      const serviceMeta = document.getElementById('piProxyServiceMeta');
      const meta = document.getElementById('piProxyRegistryMeta');
      const container = document.getElementById('piProxyRegistryContainer');
      const actionOutput = document.getElementById('piProxyActionOutput');

      if (!state.piProxyStatus) {
        serviceMeta.innerHTML = '<div><strong>Service:</strong> status not checked yet</div>';
      } else if (state.piProxyStatus.error) {
        serviceMeta.innerHTML = [
          '<div><strong>Service:</strong> error</div>',
          '<div><strong>Detail:</strong> ' + escapeHtml(state.piProxyStatus.error) + '</div>'
        ].join('');
      } else {
        const runtimeServers = Array.isArray(state.piProxyStatus.runtimeState?.servers)
          ? state.piProxyStatus.runtimeState.servers.length
          : 0;
        serviceMeta.innerHTML = [
          '<div><strong>Node:</strong> ' + escapeHtml(state.piProxyStatus.nodeId || profile.nodeId || 'unset') + '</div>',
          '<div><strong>Service State:</strong> ' + escapeHtml(state.piProxyStatus.activeState + '/' + state.piProxyStatus.subState) + '</div>',
          '<div><strong>Installed:</strong> ' + escapeHtml(state.piProxyStatus.serviceInstalled ? 'yes' : 'no') + '</div>',
          '<div><strong>Advertised Locally:</strong> ' + escapeHtml(String(runtimeServers)) + '</div>',
          '<div><strong>Summary:</strong> ' + escapeHtml(state.piProxyStatus.summary || 'unknown') + '</div>'
        ].join('');
      }

      if (!profile.enabled) {
        meta.innerHTML = '<div><strong>Status:</strong> disabled</div>';
        serviceMeta.innerHTML = '<div><strong>Service:</strong> disabled</div>';
        container.innerHTML = '<div class="card card-quiet">Enable the Pi proxy profile to expose the Bedrock registry endpoint.</div>';
        return;
      }

      if (!state.piProxyRegistry) {
        meta.innerHTML = '<div><strong>Status:</strong> registry not loaded yet</div>';
        container.innerHTML = '<div class="card card-quiet">Use <strong>Refresh Registry</strong> to inspect the live Bedrock registry.</div>';
        return;
      }

      if (state.piProxyRegistry.error) {
        meta.innerHTML = '<div><strong>Status:</strong> error</div>';
        container.innerHTML = '<div class="card card-quiet">' + escapeHtml(state.piProxyRegistry.error) + '</div>';
        return;
      }

      const generatedAt = formatTimestamp(state.piProxyRegistry.generatedAt);
      const servers = Array.isArray(state.piProxyRegistry.servers) ? state.piProxyRegistry.servers : [];
      meta.innerHTML = [
        '<div><strong>Generated:</strong> ' + escapeHtml(generatedAt) + '</div>',
        '<div><strong>Available Worlds:</strong> ' + escapeHtml(String(servers.length)) + '</div>',
        '<div><strong>Proxy Unit:</strong> ' + escapeHtml(profile.systemdUnitName) + '</div>'
      ].join('');

      if (servers.length === 0) {
        container.innerHTML = '<div class="card card-quiet">No running Bedrock worlds are currently available for LAN advertisement.</div>';
        return;
      }

      container.innerHTML = '';
      servers.forEach((server) => {
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = [
          '<div class="split-actions">',
          '<div><strong>' + escapeHtml(server.serverName || server.workloadId) + '</strong></div>',
          '<div class="pill">' + escapeHtml(server.worldName || 'world') + '</div>',
          '</div>',
          '<div class="meta-list">',
          '<div><strong>MOTD:</strong> ' + escapeHtml(server.motd || server.serverName || '') + '</div>',
          '<div><strong>Level Name:</strong> ' + escapeHtml(server.levelName || server.worldName || '') + '</div>',
          '<div><strong>Relay Target:</strong> ' + escapeHtml(server.targetHost + ':' + String(server.targetPort || 'unknown')) + '</div>',
          '<div><strong>Node:</strong> ' + escapeHtml(server.nodeId) + '</div>',
          '<div><strong>Network Mode:</strong> ' + escapeHtml(server.networkMode || 'unknown') + '</div>',
          '<div><strong>Started:</strong> ' + escapeHtml(formatTimestamp(server.startedAt)) + '</div>',
          '</div>'
        ].join('');
        container.appendChild(element);
      });
    }

    function renderSecrets() {
      renderSecretEnvironmentList(
        'gatewayApiSecretsContainer',
        state.config.serviceProfiles.gatewayApi.environment,
        () => undefined,
        renderGatewayApiProfile
      );
      renderGatewayApiSecretsChannels();
      renderKulrsSecrets();
      renderSecretEnvironmentList(
        'gatewayChatSecretsContainer',
        state.config.serviceProfiles.gatewayChatPlatform.environment,
        () => undefined,
        renderGatewayChatPlatformProfile
      );
      applySecretsRevealState();
    }

    function applySecretsRevealState() {
      const secretsPanel = document.querySelector('[data-tab-panel="secrets"]');
      if (!secretsPanel) return;
      const revealed = document.body.classList.contains('is-secrets-revealed');
      secretsPanel.querySelectorAll('input[type="password"], input[data-secret-input="1"]').forEach((input) => {
        if (revealed) {
          if (input.type === 'password') {
            input.dataset.secretInput = '1';
            input.type = 'text';
          }
        } else if (input.dataset.secretInput === '1') {
          input.type = 'password';
        }
      });
    }

    function renderGatewayApiSecretsChannels() {
      const runtime = state.config.serviceProfiles.gatewayApi.jobRuntime;
      const container = document.getElementById('gatewayApiSecretChannelsContainer');
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
          </div>
          <div class="row">
            <label>Telegram Bot Token<input type="password" data-field="botToken" value="\${channel.botToken || ''}" /></label>
            <label>Telegram Chat Id<input data-field="chatId" value="\${channel.chatId || ''}" /></label>
            <label>Webhook URL<input type="password" data-field="webhookUrl" value="\${channel.webhookUrl || ''}" /></label>
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
          const eventName = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            if (field === 'enabled') {
              channel.enabled = input.checked;
            } else {
              channel[field] = input.value;
              if ((field === 'botToken' || field === 'chatId' || field === 'webhookUrl') && !input.value) {
                delete channel[field];
              }
            }
            if (isCheckbox || input.tagName === 'SELECT') {
              renderGatewayApiJobRuntimeProfile();
              renderSecrets();
            }
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

    function renderKulrsSecrets() {
      const kulrs = state.config.serviceProfiles.gatewayApi.kulrsActivity;
      document.getElementById('kulrsFirebaseApiKeySecrets').value = kulrs.firebaseApiKey;
      document.getElementById('kulrsUnsplashAccessKeySecrets').value = kulrs.unsplashAccessKey;

      const container = document.getElementById('kulrsSecretBotsContainer');
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

`;
