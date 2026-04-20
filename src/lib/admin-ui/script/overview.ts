/**
 * Admin UI — overview renderer browser-runtime module.
 * Extracted from script.ts.
 */

export const OVERVIEW_SCRIPT = `    // Default landing tab — kept in sync with state.activeTab initial value.
    const DEFAULT_TAB = 'overview';
    // Shared empty-state copy for the Overview surface.
    const OVERVIEW_NO_HEALTH_DATA = 'No health data yet.';

    function projectStatusBadge(status) {
      const colors = {
        'on-track': 'var(--color-success)',
        'at-risk': 'var(--color-warning)',
        blocked: 'var(--color-error)',
        done: 'var(--color-success)',
        idea: 'var(--color-muted)',
      };
      const color = colors[status] || 'var(--color-muted)';
      return '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + color + ';margin-right:6px" title="' + escapeHtml(status || 'unknown') + '"></span>';
    }

    function projectPriorityPill(priority) {
      const normalized = (priority || 'medium').toLowerCase();
      const className = normalized === 'critical' ? ' is-critical' : normalized === 'high' ? ' is-high' : '';
      return '<span class="overview-priority-pill' + className + '">' + escapeHtml(normalized) + '</span>';
    }

    function renderOverview() {
      // health-first landing: uses live state.healthSnapshot + state.runtime
      const runtimeMetrics = document.getElementById('overviewRuntimeMetrics');
      if (runtimeMetrics) {
        if (!state.runtime) {
          runtimeMetrics.innerHTML = '<div class="overview-empty">Runtime data not loaded.</div>';
        } else {
          const runtime = state.runtime;
          runtimeMetrics.innerHTML = [
            ['Enabled Apps', \`\${runtime.enabledApps}/\${runtime.totalApps}\`],
            ['Enabled Jobs', \`\${runtime.enabledJobs}/\${runtime.totalJobs}\`],
            ['Enabled Features', \`\${runtime.enabledFeatures}/\${runtime.totalFeatures}\`],
            ['Uptime (s)', String(runtime.uptimeSeconds)]
          ].map(function(pair) {
            return '<div class="metric"><strong>' + escapeHtml(pair[1]) + '</strong><span>' + escapeHtml(pair[0]) + '</span></div>';
          }).join('');
        }
      }

      const snapshot = state.healthSnapshot;
      const targets = snapshot && Array.isArray(snapshot.targets) ? snapshot.targets : [];
      const projectOverview = state.projectTrackingOverview;
      const projects = projectOverview && Array.isArray(projectOverview.projects) ? projectOverview.projects : [];

      const counts = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
      targets.forEach(function(t) {
        const key = t.status === 'healthy' ? 'healthy'
          : t.status === 'degraded' ? 'degraded'
          : t.status === 'down' ? 'down'
          : 'unknown';
        counts[key] += 1;
      });
      const actionCount = counts.degraded + counts.down + counts.unknown;

      function setCount(kind, value, detail) {
        const countEl = document.querySelector('[data-overview-count="' + kind + '"]');
        const detailEl = document.querySelector('[data-overview-detail="' + kind + '"]');
        if (countEl) countEl.textContent = String(value);
        if (detailEl) detailEl.textContent = detail;
      }
      if (targets.length === 0) {
        setCount('healthy', 0, OVERVIEW_NO_HEALTH_DATA);
        setCount('degraded', 0, OVERVIEW_NO_HEALTH_DATA);
        setCount('action', 0, 'Run a health check to populate this view.');
      } else {
        setCount('healthy', counts.healthy, counts.healthy === 1 ? '1 target reporting healthy.' : counts.healthy + ' targets reporting healthy.');
        setCount('degraded', counts.degraded, counts.degraded === 0 ? 'Nothing degraded.' : counts.degraded + ' target' + (counts.degraded === 1 ? '' : 's') + ' running in degraded mode.');
        const actionDetail = actionCount === 0
          ? 'All clear — nothing requires attention.'
          : (counts.down + ' down, ' + counts.degraded + ' degraded, ' + counts.unknown + ' unknown.');
        setCount('action', actionCount, actionDetail);
      }

      function targetRow(t) {
        const uptime = t.uptimePercent24h !== null && t.uptimePercent24h !== undefined ? t.uptimePercent24h.toFixed(1) + '%' : '—';
        const latency = t.responseTimeMs !== null && t.responseTimeMs !== undefined ? t.responseTimeMs + 'ms' : '—';
        const statusClass = t.status === 'healthy' ? 'is-healthy' : t.status === 'degraded' ? 'is-degraded' : t.status === 'down' ? 'is-down' : '';
        return '<div class="overview-target ' + statusClass + '">' +
          '<div>' +
            statusBadge(t.status) +
            '<strong>' + escapeHtml(t.label || t.id || '') + '</strong>' +
            ' <span class="pill">' + escapeHtml(t.kind || '') + '</span>' +
          '</div>' +
          '<div class="overview-target-meta">' +
            '<span title="24h uptime">⬆ ' + uptime + '</span>' +
            '<span title="Response time">⏱ ' + latency + '</span>' +
          '</div>' +
        '</div>';
      }

      const actionList = document.getElementById('overviewActionList');
      if (actionList) {
        const actionTargets = targets.filter(function(t) {
          return t.status === 'degraded' || t.status === 'down' || t.status === 'unknown';
        });
        if (targets.length === 0) {
          actionList.innerHTML = '<div class="overview-empty">' + OVERVIEW_NO_HEALTH_DATA + ' Click <strong>Run Health Check</strong> to collect the first snapshot.</div>';
        } else if (actionTargets.length === 0) {
          actionList.innerHTML = '<div class="overview-empty">All monitored targets are healthy.</div>';
        } else {
          actionList.innerHTML = actionTargets.map(targetRow).join('');
        }
      }

      const targetList = document.getElementById('overviewTargetList');
      if (targetList) {
        if (targets.length === 0) {
          targetList.innerHTML = '<div class="overview-empty">No monitored targets configured, or monitoring is disabled.</div>';
        } else {
          targetList.innerHTML = targets.map(targetRow).join('');
        }
      }

      function setProjectCount(kind, value, detail) {
        const countEl = document.querySelector('[data-project-overview-count="' + kind + '"]');
        const detailEl = document.querySelector('[data-project-overview-detail="' + kind + '"]');
        if (countEl) countEl.textContent = String(value);
        if (detailEl) detailEl.textContent = detail;
      }

      if (!projectOverview) {
        setProjectCount('active', 0, 'Loading tracked projects…');
        setProjectCount('risk', 0, 'Loading tracked projects…');
        setProjectCount('stale', 0, 'Loading tracked projects…');
      } else {
        setProjectCount(
          'active',
          projectOverview.totals.activeProjects || 0,
          (projectOverview.totals.dueSoonMilestones || 0) > 0
            ? String(projectOverview.totals.dueSoonMilestones) + ' milestone' + (projectOverview.totals.dueSoonMilestones === 1 ? '' : 's') + ' due soon.'
            : 'No near-term milestone pressure.'
        );
        setProjectCount(
          'risk',
          projectOverview.totals.atRiskProjects || 0,
          (projectOverview.totals.atRiskProjects || 0) === 0
            ? 'Nothing flagged at risk.'
            : 'Blocked, at-risk, or overdue work.'
        );
        setProjectCount(
          'stale',
          projectOverview.totals.staleProjects || 0,
          (projectOverview.totals.staleProjects || 0) === 0
            ? 'Recent updates are flowing.'
            : 'Projects that need a fresh check-in.'
        );
      }

      const projectList = document.getElementById('overviewProjectList');
      if (projectList) {
        if (!projectOverview) {
          projectList.innerHTML = '<div class="overview-empty">Loading tracked projects…</div>';
        } else if (projects.length === 0) {
          projectList.innerHTML = '<div class="overview-empty">No tracked projects yet. POST updates to <code>/api/project-tracking/projects</code> to populate this view.</div>';
        } else {
          projectList.innerHTML = projects.map(function(project) {
            const statusClass = project.status === 'blocked'
              ? 'is-down'
              : project.status === 'at-risk' || project.overdueMilestones > 0
                ? 'is-degraded'
                : project.isStale
                  ? 'is-stale'
                  : 'is-healthy';
            const milestoneCopy = project.totalMilestones > 0
              ? project.completedMilestones + '/' + project.totalMilestones + ' milestones complete'
              : 'No milestones recorded';
            const riskBits = [];
            if (project.overdueMilestones > 0) riskBits.push(project.overdueMilestones + ' overdue');
            if (project.dueSoonMilestones > 0) riskBits.push(project.dueSoonMilestones + ' due soon');
            if (project.isStale) riskBits.push('needs check-in');
            return '<div class="overview-target ' + statusClass + '">' +
              '<div>' +
                '<div class="overview-project-name">' +
                  projectStatusBadge(project.status) +
                  '<strong>' + escapeHtml(project.name || project.projectId || '') + '</strong>' +
                  projectPriorityPill(project.priority) +
                  '<span class="pill">' + escapeHtml(project.status || 'unknown') + '</span>' +
                '</div>' +
                (project.summary ? '<div class="overview-project-copy">' + escapeHtml(project.summary) + '</div>' : '') +
                (project.nextAction ? '<div class="overview-project-copy"><strong>Next:</strong> ' + escapeHtml(project.nextAction) + '</div>' : '') +
              '</div>' +
              '<div class="overview-target-meta">' +
                '<span title="Milestone progress">' + escapeHtml(milestoneCopy) + '</span>' +
                (riskBits.length > 0 ? '<span title="Attention">' + escapeHtml(riskBits.join(' · ')) + '</span>' : '') +
                '<span title="Last update">' + escapeHtml(project.latestUpdateAt || project.lastCheckInAt || project.updatedAt || '—') + '</span>' +
              '</div>' +
            '</div>';
          }).join('');
        }
      }

      const projectSummary = document.getElementById('overviewProjectSummaryText');
      if (projectSummary) {
        projectSummary.textContent = projectOverview && projectOverview.clipboardSummary
          ? projectOverview.clipboardSummary
          : 'No tracked projects yet.';
      }
    }

    function renderApps() {
      const container = document.getElementById('appsContainer');
      container.innerHTML = '';
      state.config.apps.forEach((app, index) => {
        const activeSlot = state.appSlots?.[app.id] || '…';
        const slotColor = activeSlot === 'blue' ? '#4a9eff' : activeSlot === 'green' ? '#2ecc71' : '#888';
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div>
              <strong>\${app.id || 'new-app'}</strong>
              <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:4px;font-size:0.8em;background:\${slotColor};color:#fff;">\${activeSlot}</span>
            </div>
            <div class="toolbar">
              <button data-action="deploy">Deploy</button>
              <button data-action="remove" class="danger">Remove</button>
            </div>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${app.enabled ? 'checked' : ''} /> Enabled</label>
            <label>App Id<input data-field="id" value="\${app.id}" /></label>
            <label>Repo URL<input data-field="repoUrl" value="\${app.repoUrl}" /></label>
            <label>Default Revision<input data-field="defaultRevision" value="\${app.defaultRevision}" /></label>
            <label>Deploy Root<input data-field="deployRoot" value="\${app.deployRoot}" /></label>
            <label>Hostnames (comma separated)<input data-field="hostnames" value="\${(app.hostnames || []).join(', ')}" /></label>
            <label>Route Path<input data-field="routePath" value="\${app.routePath}" /></label>
            <label class="check"><input type="checkbox" data-field="stripRoutePrefix" \${app.stripRoutePrefix ? 'checked' : ''} /> Strip Route Prefix</label>
            <label>Health Path<input data-field="healthPath" value="\${app.healthPath}" /></label>
            <label>Upstream Conf Path<input data-field="upstreamConfPath" value="\${app.upstreamConfPath}" /></label>
            <label>Blue Port<input type="number" data-slot="blue" data-field="port" value="\${app.slots.blue.port}" /></label>
            <label>Blue Start Command<input data-slot="blue" data-field="startCommand" value="\${app.slots.blue.startCommand}" /></label>
            <label>Blue Stop Command<input data-slot="blue" data-field="stopCommand" value="\${app.slots.blue.stopCommand}" /></label>
            <label>Green Port<input type="number" data-slot="green" data-field="port" value="\${app.slots.green.port}" /></label>
            <label>Green Start Command<input data-slot="green" data-field="startCommand" value="\${app.slots.green.startCommand}" /></label>
            <label>Green Stop Command<input data-slot="green" data-field="stopCommand" value="\${app.slots.green.stopCommand}" /></label>
          </div>
          <div class="row">
            <label>Deploy Revision<input data-control="deployRevision" placeholder="optional sha/tag" /></label>
          </div>
          <label>Build Commands (one per line)<textarea data-field="buildCommands">\${app.buildCommands.join('\\n')}</textarea></label>
        \`;

        element.querySelector('[data-action="remove"]').addEventListener('click', () => {
          state.config.apps.splice(index, 1);
          render();
        });

        element.querySelector('[data-action="deploy"]').addEventListener('click', async () => {
          const deployButton = element.querySelector('[data-action="deploy"]');
          await withBusyButton(deployButton, 'Deploying…', async () => {
            const appId = app.id;
            try {
              const revision = element.querySelector('[data-control="deployRevision"]').value.trim();
              await persistConfigState({ renderAfterSave: false });
              const result = await requestJson('POST', \`/api/apps/\${encodeURIComponent(appId)}/deploy\`, revision ? { revision } : {}, 300000);
              setStatus(\`Triggered deploy workflow for managed app \${appId}\`, 'ok');
              if (result.deployLog) {
                try {
                  showDeployTelemetryModal(appId, result.deployLog, result.durationMs, true);
                } catch (uiError) {
                  const detail = logClientError('show deploy telemetry for managed app ' + appId, uiError);
                  setStatus(\`Triggered deploy workflow for managed app \${appId}, but the telemetry viewer failed to open: \${detail}\`, 'error');
                }
              }
            } catch (error) {
              setStatus(describeClientError(error), 'error');
              if (error.deployLog) {
                try {
                  showDeployTelemetryModal(appId, error.deployLog, error.durationMs, false);
                } catch (uiError) {
                  logClientError('show failed deploy telemetry for managed app ' + appId, uiError);
                }
              }
            }
          });
        });

        element.querySelectorAll('input, textarea').forEach((input) => {
          input.addEventListener('input', () => {
            const slot = input.dataset.slot;
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            if (slot) {
              state.config.apps[index].slots[slot][field] = field === 'port' ? Number(input.value) : input.value;
            } else if (field === 'enabled') {
              state.config.apps[index].enabled = input.checked;
            } else if (field === 'stripRoutePrefix') {
              state.config.apps[index].stripRoutePrefix = input.checked;
            } else if (field === 'hostnames') {
              state.config.apps[index].hostnames = input.value.split(',').map((item) => item.trim()).filter(Boolean);
            } else if (field === 'buildCommands') {
              state.config.apps[index].buildCommands = input.value.split('\\n').map((item) => item.trim()).filter(Boolean);
            } else {
              state.config.apps[index][field] = input.value;
            }
            syncRawJson();
          });
          if (input.type === 'checkbox') {
            input.addEventListener('change', () => {
              if (input.dataset.field === 'stripRoutePrefix') {
                state.config.apps[index].stripRoutePrefix = input.checked;
              } else {
                state.config.apps[index].enabled = input.checked;
              }
              syncRawJson();
            });
          }
        });

        container.appendChild(element);
      });
    }

    function renderJobs() {
      const container = document.getElementById('jobsContainer');
      container.innerHTML = '';
      state.config.scheduledJobs.forEach((job, index) => {
        const appOptions = state.config.apps.map((app) => \`<option value="\${app.id}" \${app.id === job.appId ? 'selected' : ''}>\${app.id}</option>\`).join('');
        const element = document.createElement('div');
        element.className = 'card';
        element.innerHTML = \`
          <div class="split-actions">
            <div><strong>\${job.id || 'new-job'}</strong></div>
            <button class="danger">Remove</button>
          </div>
          <div class="row">
            <label class="check"><input type="checkbox" data-field="enabled" \${job.enabled ? 'checked' : ''} /> Enabled</label>
            <label>Job Id<input data-field="id" value="\${job.id}" /></label>
            <label>App<select data-field="appId">\${appOptions}</select></label>
            <label>Schedule<input data-field="schedule" value="\${job.schedule}" /></label>
            <label>User<input data-field="user" value="\${job.user}" /></label>
            <label>Group<input data-field="group" value="\${job.group || ''}" /></label>
            <label>Environment File<input data-field="environmentFile" value="\${job.environmentFile || ''}" /></label>
          </div>
          <label>Description<input data-field="description" value="\${job.description}" /></label>
          <label>Working Directory<input data-field="workingDirectory" value="\${job.workingDirectory}" /></label>
          <label>ExecStart<input data-field="execStart" value="\${job.execStart}" /></label>
        \`;

        element.querySelector('.danger').addEventListener('click', () => {
          state.config.scheduledJobs.splice(index, 1);
          render();
        });

        element.querySelectorAll('input, select').forEach((input) => {
          const isCheckbox = input.type === 'checkbox';
          const eventName = isCheckbox ? 'change' : 'input';
          input.addEventListener(eventName, () => {
            const field = input.dataset.field;
            if (!field) {
              return;
            }
            state.config.scheduledJobs[index][field] = isCheckbox ? input.checked : input.value;
            if (field === 'group' || field === 'environmentFile') {
              if (!input.value) {
                delete state.config.scheduledJobs[index][field];
              }
            }
            syncRawJson();
          });
        });

        container.appendChild(element);
      });
    }

`;
