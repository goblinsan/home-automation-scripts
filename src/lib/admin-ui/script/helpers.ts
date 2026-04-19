/**
 * Admin UI — shared utilities browser-runtime module.
 * Extracted from script.ts.
 */

export const HELPERS_SCRIPT = `    state.remoteDeployJobIds = loadStoredRemoteDeployJobIds();

    const STALE_MS = 30000;
    function isStale(key) {
      return !state.dataLoaded[key] || (Date.now() - state.dataLoaded[key] > STALE_MS);
    }
    function markLoaded(key) {
      state.dataLoaded[key] = Date.now();
    }

    function normalizeClientBasePath(pathValue) {
      if (!pathValue || pathValue === '/') {
        return '/';
      }
      if (pathValue.endsWith('/')) {
        return pathValue;
      }
      const lastSlash = pathValue.lastIndexOf('/');
      if (lastSlash <= 0) {
        return pathValue + '/';
      }
      const tail = pathValue.slice(lastSlash + 1);
      return tail.includes('.') ? pathValue.slice(0, lastSlash + 1) : pathValue + '/';
    }

    function resolveClientBasePath() {
      const metaBasePath = document.querySelector('meta[name="gateway-base-path"]')?.content || '/';
      if (metaBasePath && metaBasePath !== '/') {
        return normalizeClientBasePath(metaBasePath);
      }
      return normalizeClientBasePath(window.location.pathname || '/');
    }

    const basePath = resolveClientBasePath();
    let actionFeedCollapseTimer = null;

    function applyActionFeedVisibility() {
      const feed = document.getElementById('actionFeed');
      const toggle = document.getElementById('toggleActionFeedButton');
      if (!feed || !toggle) {
        return;
      }
      feed.classList.toggle('is-collapsed', state.actionFeedCollapsed);
      toggle.textContent = state.actionFeedCollapsed ? 'Show History' : 'Hide History';
    }

    function scheduleActionFeedAutoCollapse() {
      if (actionFeedCollapseTimer) {
        clearTimeout(actionFeedCollapseTimer);
      }
      actionFeedCollapseTimer = setTimeout(() => {
        state.actionFeedCollapsed = true;
        applyActionFeedVisibility();
      }, 5000);
    }

    function pushActionFeed(message, kind = 'ok') {
      const feed = document.getElementById('actionFeed');
      if (!feed) {
        return;
      }
      state.actionFeedCollapsed = false;
      applyActionFeedVisibility();
      const empty = feed.querySelector('.action-feed-empty');
      if (empty) {
        empty.remove();
      }
      const entry = document.createElement('div');
      entry.className = 'action-entry ' + (kind === 'error' ? 'error' : kind === 'progress' ? 'progress' : 'ok');
      const title = document.createElement('strong');
      title.textContent = message;
      const time = document.createElement('time');
      time.textContent = new Date().toLocaleTimeString();
      entry.appendChild(title);
      entry.appendChild(time);
      feed.prepend(entry);
      while (feed.children.length > 8) {
        feed.removeChild(feed.lastElementChild);
      }
    }

    function setCurrentAction(message, kind = 'ok') {
      const host = document.getElementById('currentAction');
      const msg = document.getElementById('currentActionMessage');
      const time = document.getElementById('currentActionTime');
      if (!host || !msg || !time) {
        return;
      }
      host.classList.remove('is-idle', 'is-progress', 'is-ok', 'is-error');
      const stateClass = kind === 'error' ? 'is-error'
        : kind === 'progress' ? 'is-progress'
        : kind === 'idle' ? 'is-idle'
        : 'is-ok';
      host.classList.add(stateClass);
      msg.textContent = message;
      if (kind === 'idle') {
        time.textContent = '';
      } else {
        const prefix = kind === 'progress' ? 'Started '
          : kind === 'error' ? 'Failed '
          : 'Completed ';
        time.textContent = prefix + new Date().toLocaleTimeString();
      }
    }

    function setStatus(message, kind = 'ok', options = {}) {
      const status = document.getElementById('status');
      status.textContent = message;
      status.title = message;
      status.className = kind === 'error' ? 'status-error' : kind === 'progress' ? 'status-progress' : 'status-ok';
      if (message !== 'Current') {
        setCurrentAction(message, kind);
      }
      if (kind === 'progress' || kind === 'error') {
        if (actionFeedCollapseTimer) {
          clearTimeout(actionFeedCollapseTimer);
        }
        state.actionFeedCollapsed = false;
        applyActionFeedVisibility();
      } else {
        scheduleActionFeedAutoCollapse();
      }
      if (options.log !== false) {
        pushActionFeed(message, kind);
      }
    }

    function describeClientError(error) {
      if (error instanceof Error) {
        return error.message || error.name;
      }
      if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        return error.message;
      }
      return String(error);
    }

    function logClientError(context, error) {
      const detail = describeClientError(error);
      console.error('[admin-ui] ' + context + ': ' + detail, error);
      return detail;
    }

    async function withBusyButton(button, pendingLabel, task) {
      if (!button) {
        return await task();
      }
      const originalLabel = button.dataset.originalLabel || button.textContent || '';
      button.dataset.originalLabel = originalLabel;
      const lockedWidth = button.offsetWidth;
      if (lockedWidth > 0) {
        button.style.width = lockedWidth + 'px';
      }
      button.disabled = true;
      button.classList.add('is-busy');
      button.setAttribute('aria-busy', 'true');
      if (pendingLabel) {
        button.textContent = pendingLabel;
      }
      try {
        return await task();
      } finally {
        button.disabled = false;
        button.classList.remove('is-busy');
        button.removeAttribute('aria-busy');
        button.textContent = originalLabel;
        button.style.removeProperty('width');
      }
    }

    function setLocalActionOutput(container, message, kind = 'ok') {
      if (!container) {
        return;
      }
      container.className = 'inline-action-output' + (kind === 'error' ? ' is-error' : kind === 'progress' ? ' is-progress' : '');
      container.innerHTML = '<strong>Action Output</strong><div>' + escapeHtml(message) + '</div><div>' + escapeHtml(new Date().toLocaleString()) + '</div>';
    }

    function formatTelemetryLine(entry) {
      const secs = (entry.ts / 1000).toFixed(1) + 's';
      const msg = entry.msg || '';
      const isCommand = msg.startsWith('$ ');
      const isFail = msg.startsWith('FAILED');
      if (isCommand) return '<span style="color:var(--color-accent)">[' + secs + ']</span> <span style="color:#8bb9fe">' + escapeHtml(msg) + '</span>';
      if (isFail) return '<span style="color:var(--color-accent)">[' + secs + ']</span> <span style="color:var(--color-error)">' + escapeHtml(msg) + '</span>';
      return '<span style="color:var(--color-accent)">[' + secs + ']</span> ' + escapeHtml(msg);
    }

    function renderDeployTelemetry(deployLog, durationMs, container) {
      if (!deployLog || !container) return;
      const totalSecs = durationMs ? (durationMs / 1000).toFixed(1) + 's' : '?';
      const details = document.createElement('details');
      details.className = 'deploy-telemetry';
      details.open = true;
      details.innerHTML = '<summary style="cursor:pointer;font-weight:600;margin:.5rem 0">Deploy Telemetry (' + totalSecs + ' total, ' + deployLog.length + ' steps)</summary>' +
        '<pre class="wizard-log" style="max-height:30rem;overflow-y:auto;font-size:.78rem;line-height:1.5;white-space:pre-wrap;word-break:break-all;margin:0;padding:.5rem;background:var(--color-card);border-radius:6px">' +
        deployLog.map(formatTelemetryLine).join('\\n') +
        '</pre>';
      container.appendChild(details);
      details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function showDeployTelemetryModal(workloadId, deployLog, durationMs, success) {
      let modal = document.getElementById('deployTelemetryModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'deployTelemetryModal';
        modal.className = 'wizard-dialog';
        modal.hidden = true;
        modal.style.position = 'fixed';
        modal.style.inset = '0';
        modal.style.padding = '4vh 0';
        modal.style.background = 'rgba(0,0,0,.5)';
        modal.style.zIndex = '9999';
        modal.style.overflowY = 'auto';
        modal.innerHTML =
          '<div class="wizard-content" role="dialog" aria-modal="true" style="max-width:56rem;width:90vw;margin:0 auto">' +
            '<div class="wizard-header">' +
              '<h2 id="deployTelemetryTitle" style="font-size:1rem"></h2>' +
              '<div style="display:flex;gap:.5rem;align-items:center">' +
                '<button id="copyTelemetryBtn" type="button" style="font-size:.8rem">Copy</button>' +
                '<button id="closeTelemetryBtn" type="button" class="wizard-close" aria-label="Close deploy telemetry">×</button>' +
              '</div>' +
            '</div>' +
            '<div style="padding:1rem 1.25rem;border-bottom:1px solid var(--line);font-size:.9rem;color:var(--text)">' +
              '<span id="deployTelemetryStatus"></span>' +
            '</div>' +
            '<pre id="telemetryContent" class="wizard-log" style="flex:1;overflow-y:auto;margin:0;padding:1rem 1.25rem;font-size:.78rem;line-height:1.5;white-space:pre-wrap;word-break:break-all;background:#f6f6f2;color:var(--text)"></pre>' +
          '</div>';
        modal.addEventListener('click', (event) => {
          if (event.target === modal) {
            modal.hidden = true;
          }
        });
        document.body.appendChild(modal);
      }
      const totalSecs = durationMs ? (durationMs / 1000).toFixed(1) + 's' : '?';
      const title = modal.querySelector('#deployTelemetryTitle');
      const status = modal.querySelector('#deployTelemetryStatus');
      const content = modal.querySelector('#telemetryContent');
      const closeButton = modal.querySelector('#closeTelemetryBtn');
      const copyButton = modal.querySelector('#copyTelemetryBtn');
      title.textContent = 'Deploy Telemetry: ' + workloadId;
      status.innerHTML = (success ? '<span class="success">✔ Deployed</span>' : '<span class="error">✘ Failed</span>') + ' — ' + escapeHtml(totalSecs);
      content.innerHTML = deployLog.map(formatTelemetryLine).join('\\n');
      closeButton.onclick = () => { modal.hidden = true; };
      copyButton.onclick = () => {
        const plain = deployLog.map(function(entry) {
          return '[' + (entry.ts / 1000).toFixed(1) + 's] ' + (entry.msg || '');
        }).join('\\n');
        navigator.clipboard.writeText(plain).then(() => {
          copyButton.textContent = 'Copied!';
          setTimeout(() => { copyButton.textContent = 'Copy'; }, 2000);
        });
      };
      modal.hidden = false;
    }

    function joinBase(path) {
      const needsAdminPrefix = basePath !== '/' && path.startsWith('/api/');
      const normalizedPath = needsAdminPrefix ? '/__admin' + path : path;
      if (basePath === '/') {
        return normalizedPath.startsWith('/') ? normalizedPath : \`/\${normalizedPath}\`;
      }
      const normalizedBase = basePath.endsWith('/') ? basePath : \`\${basePath}/\`;
      const relativePath = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath;
      return \`\${normalizedBase}\${relativePath}\`;
    }

    function syncRawJson() {
      document.getElementById('rawJson').value = JSON.stringify(state.config, null, 2);
    }

`;
