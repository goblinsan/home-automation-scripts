/**
 * Admin UI — monitoring fetch + render browser-runtime module.
 * Extracted from script.ts.
 */

export const MONITORING_SCRIPT = `    // ── Monitoring: fetch + render ──

    function renderCoachDiagnostics() {
      const output = document.getElementById('coachDiagnosticsOutput');
      if (!output) return;
      if (!state.coachDiagnostics) {
        output.textContent = 'No diagnostics run yet.';
        return;
      }
      output.textContent = JSON.stringify(state.coachDiagnostics, null, 2);
    }

    function summarizeFailingTargets(targets) {
      const failing = (Array.isArray(targets) ? targets : []).filter(function(t) {
        return t && t.status !== 'healthy';
      });
      if (failing.length === 0) {
        return 'All clear.';
      }
      const ordered = failing.sort(function(a, b) {
        const weight = function(status) {
          return status === 'down' ? 0 : status === 'degraded' ? 1 : 2;
        };
        return weight(a.status) - weight(b.status);
      });
      const names = ordered.slice(0, 3).map(function(t) {
        return t.label || t.id || 'unknown';
      });
      const extra = ordered.length > 3 ? ' +' + (ordered.length - 3) + ' more' : '';
      return names.join(', ') + extra;
    }

    function renderMonitoringBackends() {
      const container = document.getElementById('monitoringBackendsContainer');
      if (!container) return;
      const mon = state.config && state.config.monitoring;
      if (!mon || !mon.enabled) {
        container.innerHTML = '';
        return;
      }

      const targets = (state.healthSnapshot && Array.isArray(state.healthSnapshot.targets)) ? state.healthSnapshot.targets : [];
      const postgresTarget = targets.find(function(t) { return t.kind === 'monitoring-datastore' && t.id === 'postgres'; });
      const redisTarget = targets.find(function(t) { return t.kind === 'monitoring-datastore' && t.id === 'redis'; });

      function backendCard(name, endpoint, target) {
        const status = target ? target.status : 'unknown';
        const latency = target && target.responseTimeMs !== null ? target.responseTimeMs + 'ms' : '—';
        const checked = target && target.lastChecked ? new Date(target.lastChecked).toLocaleString() : 'not checked yet';
        const border = status === 'healthy'
          ? 'var(--color-success)'
          : status === 'degraded'
            ? 'var(--color-warning)'
            : status === 'down'
              ? 'var(--color-error)'
              : 'var(--color-muted)';
        return '<div class="card" style="border-left:3px solid ' + border + '">' +
          '<div class="split-actions">' +
            '<div>' +
              statusBadge(status) +
              '<strong>' + escapeHtml(name) + '</strong> ' +
              '<span class="pill">monitoring-datastore</span>' +
            '</div>' +
            '<div style="font-size:.85rem;color:var(--color-muted)">⏱ ' + escapeHtml(String(latency)) + ' · 🕐 ' + escapeHtml(checked) + '</div>' +
          '</div>' +
          '<div class="meta-list" style="margin-top:.5rem">' +
            '<div><strong>Endpoint:</strong> ' + escapeHtml(endpoint) + '</div>' +
            (target && target.details
              ? '<div><strong>Details:</strong> ' + escapeHtml(JSON.stringify(target.details)) + '</div>'
              : '<div><strong>Details:</strong> waiting for snapshot</div>') +
          '</div>' +
        '</div>';
      }

      container.innerHTML =
        '<div class="card card-quiet">' +
          '<span class="pill">Infrastructure Services</span>' +
          '<h3>Monitoring Backends</h3>' +
          '<p>Postgres and Redis endpoints used by the control-plane monitoring stack.</p>' +
        '</div>' +
        backendCard('Postgres', mon.postgres.host + ':' + mon.postgres.port + ' / ' + mon.postgres.database, postgresTarget) +
        backendCard('Redis', mon.redis.host + ':' + mon.redis.port, redisTarget);
    }

    async function fetchHealthSnapshot() {
      try {
        const data = await requestJson('GET', '/api/monitoring/health', null, 15000);
        state.healthSnapshot = data;
        renderHealthTargets();
        renderOverview();
      } catch (err) {
        state.healthSnapshot = null;
        renderHealthTargets();
        renderOverview();
      }
    }

    async function fetchProjectTrackingOverview() {
      try {
        const data = await requestJson('GET', '/api/project-tracking/overview', null, 15000);
        state.projectTrackingOverview = data;
        renderOverview();
      } catch (err) {
        state.projectTrackingOverview = {
          projects: [],
          generatedAt: new Date().toISOString(),
          totals: {
            activeProjects: 0,
            atRiskProjects: 0,
            staleProjects: 0,
            dueSoonMilestones: 0,
          },
          clipboardSummary: 'Project tracking summary unavailable.',
        };
        renderOverview();
      }
    }

    async function fetchBenchmarkRuns() {
      try {
        const data = await requestJson('GET', '/api/monitoring/benchmarks', null, 15000);
        state.benchmarkRuns = data.runs || [];
        renderBenchmarkRuns();
      } catch (err) {
        state.benchmarkRuns = [];
        renderBenchmarkRuns();
      }
    }

    async function fetchHealthHistory(kind, id) {
      try {
        const data = await requestJson('GET', '/api/monitoring/health/history?kind=' + encodeURIComponent(kind) + '&id=' + encodeURIComponent(id), null, 15000);
        renderHealthHistory(data.rows || [], kind, id);
      } catch (err) {
        renderHealthHistory([], kind, id);
      }
    }

    function renderMonitoringSettings() {
      if (!state.config) return;
      const mon = state.config.monitoring || { enabled: false, postgres: { host: '', port: 5432, database: '', user: '', password: '' }, redis: { host: '', port: 6379 }, healthCheckIntervalSeconds: 60 };
      document.getElementById('monEnabled').checked = mon.enabled;
      document.getElementById('monPgHost').value = mon.postgres.host;
      document.getElementById('monPgPort').value = String(mon.postgres.port);
      document.getElementById('monPgDatabase').value = mon.postgres.database;
      document.getElementById('monPgUser').value = mon.postgres.user;
      document.getElementById('monPgPassword').value = mon.postgres.password;
      document.getElementById('monRedisHost').value = mon.redis.host;
      document.getElementById('monRedisPort').value = String(mon.redis.port);
      document.getElementById('monHealthInterval').value = String(mon.healthCheckIntervalSeconds);
    }

    function readMonitoringSettings() {
      if (!state.config) return;
      state.config.monitoring = {
        enabled: document.getElementById('monEnabled').checked,
        postgres: {
          host: document.getElementById('monPgHost').value,
          port: parseInt(document.getElementById('monPgPort').value) || 5432,
          database: document.getElementById('monPgDatabase').value,
          user: document.getElementById('monPgUser').value,
          password: document.getElementById('monPgPassword').value,
        },
        redis: {
          host: document.getElementById('monRedisHost').value,
          port: parseInt(document.getElementById('monRedisPort').value) || 6379,
        },
        healthCheckIntervalSeconds: parseInt(document.getElementById('monHealthInterval').value) || 60,
      };
    }

    function statusBadge(status) {
      const colors = { healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-error)', unknown: 'var(--color-muted)' };
      const color = colors[status] || colors.unknown;
      return '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + color + ';margin-right:6px" title="' + escapeHtml(status) + '"></span>';
    }

    function renderMonitorDashboard() {
      const grid = document.getElementById('monitorDashboardGrid');
      if (!grid) return;
      const snapshot = state.healthSnapshot;
      const targets = snapshot && Array.isArray(snapshot.targets) ? snapshot.targets : [];
      const counts = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
      let latestChecked = null;
      targets.forEach(function(t) {
        const key = t.status === 'healthy' ? 'healthy' : t.status === 'degraded' ? 'degraded' : t.status === 'down' ? 'down' : 'unknown';
        counts[key] += 1;
        if (t.lastChecked) {
          const ts = new Date(t.lastChecked).getTime();
          if (!latestChecked || ts > latestChecked) latestChecked = ts;
        }
      });
      const actionCount = counts.degraded + counts.down + counts.unknown;

      function set(kind, value, detail) {
        const c = grid.querySelector('[data-monitor-count="' + kind + '"]');
        const d = grid.querySelector('[data-monitor-detail="' + kind + '"]');
        if (c) c.textContent = String(value);
        if (d) d.textContent = detail;
      }
      if (targets.length === 0) {
        set('healthy', 0, 'No snapshot yet — run a check.');
        set('degraded', 0, 'No snapshot yet — run a check.');
        set('action', 0, 'No targets reporting.');
        set('lastChecked', '—', 'No snapshot yet.');
        return;
      }
      set('healthy', counts.healthy, counts.healthy === 1 ? '1 target healthy.' : counts.healthy + ' targets healthy.');
      set('degraded', counts.degraded, counts.degraded === 0 ? 'Nothing degraded.' : counts.degraded + ' running degraded.');
      set('action', actionCount, actionCount === 0
        ? 'All clear.'
        : counts.down + ' down, ' + counts.degraded + ' degraded, ' + counts.unknown + ' unknown · ' + summarizeFailingTargets(targets));
      if (latestChecked) {
        const date = new Date(latestChecked);
        const ageMs = Date.now() - latestChecked;
        const ageMin = Math.floor(ageMs / 60000);
        const ageLabel = ageMin <= 0 ? 'just now' : ageMin + ' min ago';
        set('lastChecked', date.toLocaleTimeString(), 'Most recent target check · ' + ageLabel);
      } else {
        set('lastChecked', '—', 'Awaiting first snapshot.');
      }
    }

    function renderHealthTargets() {
      renderMonitorDashboard();
      renderMonitoringBackends();
      renderCoachDiagnostics();
      const container = document.getElementById('healthTargetsContainer');
      const banner = document.getElementById('monitoringDisabledBanner');
      if (!container) return;

      const mon = state.config && state.config.monitoring;
      if (!mon || !mon.enabled) {
        banner.style.display = '';
        container.innerHTML = '';
        return;
      }
      banner.style.display = 'none';

      if (!state.healthSnapshot || !state.healthSnapshot.targets || state.healthSnapshot.targets.length === 0) {
        container.innerHTML = '<div class="card card-quiet"><p>No health data yet. Click <strong>Run Check Now</strong> to collect the first snapshot.</p></div>';
        return;
      }

      const targets = state.healthSnapshot.targets;
      container.innerHTML = targets.map(function(t) {
        const uptime = t.uptimePercent24h !== null ? t.uptimePercent24h.toFixed(1) + '%' : '—';
        const latency = t.responseTimeMs !== null ? t.responseTimeMs + 'ms' : '—';
        const lastCheck = t.lastChecked ? new Date(t.lastChecked).toLocaleString() : 'never';
        return '<div class="card" style="border-left:3px solid ' + (t.status === 'healthy' ? 'var(--color-success)' : t.status === 'degraded' ? 'var(--color-warning)' : t.status === 'down' ? 'var(--color-error)' : 'var(--color-muted)') + '">' +
          '<div class="split-actions">' +
            '<div>' +
              statusBadge(t.status) +
              '<strong>' + escapeHtml(t.label) + '</strong>' +
              ' <span class="pill">' + escapeHtml(t.kind) + '</span>' +
              ' <span class="pill">' + escapeHtml(t.id) + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:1rem;align-items:center;font-size:.85rem">' +
              '<span title="24h uptime">⬆ ' + uptime + '</span>' +
              '<span title="Response time">⏱ ' + latency + '</span>' +
              '<span title="Last checked">🕐 ' + escapeHtml(lastCheck) + '</span>' +
              '<button class="health-history-btn" data-kind="' + escapeHtml(t.kind) + '" data-id="' + escapeHtml(t.id) + '" style="font-size:.8rem">History</button>' +
            '</div>' +
          '</div>' +
          (t.details ? '<pre style="margin:.5rem 0 0;font-size:.75rem;max-height:6rem;overflow-y:auto;background:var(--color-card);padding:.4rem;border-radius:4px">' + escapeHtml(JSON.stringify(t.details, null, 2)) + '</pre>' : '') +
        '</div>';
      }).join('');

      container.querySelectorAll('.health-history-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          fetchHealthHistory(btn.dataset.kind, btn.dataset.id);
        });
      });
    }

    function renderHealthHistory(rows, kind, id) {
      const section = document.getElementById('healthHistorySection');
      const container = document.getElementById('healthHistoryContainer');
      if (!section || !container) return;
      section.style.display = '';
      section.open = true;

      if (rows.length === 0) {
        container.innerHTML = '<p>No history for ' + escapeHtml(kind) + '/' + escapeHtml(id) + '</p>';
        return;
      }

      container.innerHTML =
        '<table style="width:100%;font-size:.8rem;border-collapse:collapse">' +
        '<thead><tr><th style="text-align:left;padding:.3rem">Time</th><th>Status</th><th>Latency</th><th>Details</th></tr></thead>' +
        '<tbody>' +
        rows.map(function(r) {
          return '<tr style="border-top:1px solid var(--color-border)">' +
            '<td style="padding:.3rem">' + escapeHtml(new Date(r.checked_at).toLocaleString()) + '</td>' +
            '<td style="padding:.3rem">' + statusBadge(r.status) + escapeHtml(r.status) + '</td>' +
            '<td style="padding:.3rem">' + (r.response_time_ms != null ? r.response_time_ms + 'ms' : '—') + '</td>' +
            '<td style="padding:.3rem;max-width:20rem;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(r.details || '') + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';
    }

    function renderBenchmarkRuns() {
      const container = document.getElementById('benchmarkRunsContainer');
      if (!container) return;

      if (!state.benchmarkRuns || state.benchmarkRuns.length === 0) {
        container.innerHTML = '<div class="card card-quiet"><p>No benchmark runs recorded yet. Click <strong>New Run</strong> to record a benchmark.</p></div>';
        return;
      }

      container.innerHTML = state.benchmarkRuns.map(function(run) {
        const status = run.finished_at ? 'completed' : 'running';
        const duration = run.finished_at ? ((new Date(run.finished_at) - new Date(run.started_at)) / 1000).toFixed(1) + 's' : 'in progress';
        const resultsHtml = run.results && run.results.length > 0
          ? '<table style="width:100%;font-size:.78rem;border-collapse:collapse;margin-top:.5rem">' +
            '<thead><tr><th style="text-align:left;padding:.25rem">Test</th><th>Metric</th><th>Value</th><th>Unit</th></tr></thead>' +
            '<tbody>' + run.results.map(function(r) {
              return '<tr style="border-top:1px solid var(--color-border)">' +
                '<td style="padding:.25rem">' + escapeHtml(r.test_name) + '</td>' +
                '<td style="padding:.25rem">' + escapeHtml(r.metric) + '</td>' +
                '<td style="padding:.25rem"><strong>' + r.value + '</strong></td>' +
                '<td style="padding:.25rem">' + escapeHtml(r.unit) + '</td>' +
              '</tr>';
            }).join('') + '</tbody></table>'
          : '<p style="font-size:.8rem;color:var(--color-muted)">No results recorded</p>';

        return '<details class="card section-card">' +
          '<summary>' +
            '<div class="section-summary-copy">' +
              '<span class="pill">' + escapeHtml(run.engine) + '</span>' +
              '<span class="pill">' + escapeHtml(run.suite_id) + '</span>' +
              ' <strong>' + escapeHtml(run.name) + '</strong>' +
              ' <span style="font-size:.8rem;color:var(--color-muted)">' + escapeHtml(duration) + ' — ' + escapeHtml(run.hardware || '?') + '</span>' +
            '</div>' +
          '</summary>' +
          '<div class="section-body">' +
            '<div class="row" style="font-size:.82rem">' +
              '<div><strong>Engine:</strong> ' + escapeHtml(run.engine) + '</div>' +
              '<div><strong>Hardware:</strong> ' + escapeHtml(run.hardware) + '</div>' +
              '<div><strong>Started:</strong> ' + escapeHtml(new Date(run.started_at).toLocaleString()) + '</div>' +
              (run.finished_at ? '<div><strong>Finished:</strong> ' + escapeHtml(new Date(run.finished_at).toLocaleString()) + '</div>' : '') +
            '</div>' +
            (run.notes ? '<p style="font-size:.82rem;margin-top:.5rem"><em>' + escapeHtml(run.notes) + '</em></p>' : '') +
            '<pre style="font-size:.72rem;max-height:8rem;overflow-y:auto;background:var(--color-card);padding:.4rem;border-radius:4px;margin-top:.5rem">' + escapeHtml(JSON.stringify(run.config, null, 2)) + '</pre>' +
            resultsHtml +
            '<div style="margin-top:.5rem;display:flex;gap:.5rem">' +
              '<button class="delete-benchmark-btn" data-run-id="' + run.id + '" style="font-size:.78rem;color:var(--color-error)">Delete Run</button>' +
            '</div>' +
          '</div>' +
        '</details>';
      }).join('');

      container.querySelectorAll('.delete-benchmark-btn').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          if (!confirm('Delete benchmark run #' + btn.dataset.runId + '?')) return;
          try {
            await requestJson('DELETE', '/api/monitoring/benchmarks/' + btn.dataset.runId, null, 10000);
            setStatus('Deleted benchmark run');
            state.dataLoaded.benchmarkRuns = 0;
            fetchBenchmarkRuns();
          } catch (err) {
            setStatus(err.message, 'error');
          }
        });
      });
    }

    function renderRuntime() {
      const runtimeSummary = document.getElementById('runtimeSummary');
      const runtimeMeta = document.getElementById('runtimeMeta');
      if (!state.runtime) {
        runtimeSummary.innerHTML = '';
        runtimeMeta.innerHTML = '<div>Runtime data not loaded</div>';
        return;
      }

      const runtime = state.runtime;
      runtimeSummary.innerHTML = [
        ['Enabled Apps', \`\${runtime.enabledApps}/\${runtime.totalApps}\`],
        ['Enabled Jobs', \`\${runtime.enabledJobs}/\${runtime.totalJobs}\`],
        ['Enabled Features', \`\${runtime.enabledFeatures}/\${runtime.totalFeatures}\`],
        ['Uptime (s)', String(runtime.uptimeSeconds)]
      ].map(([label, value]) => \`<div class="metric"><strong>\${value}</strong><span>\${label}</span></div>\`).join('');

      runtimeMeta.innerHTML = [
        \`<div><strong>Started:</strong> \${runtime.startedAt}</div>\`,
        \`<div><strong>Config:</strong> \${runtime.configPath}</div>\`,
        \`<div><strong>Build Dir:</strong> \${runtime.buildOutDir}</div>\`,
        \`<div><strong>Gateway Route:</strong> \${runtime.adminRoutePath}</div>\`,
        \`<div><strong>Build Output Present:</strong> \${runtime.generated.buildDirectoryExists ? 'yes' : 'no'}</div>\`,
        \`<div><strong>nginx Site Generated:</strong> \${runtime.generated.nginxSiteExists ? 'yes' : 'no'}</div>\`,
        \`<div><strong>Control-Plane Unit Generated:</strong> \${runtime.generated.controlPlaneUnitExists ? 'yes' : 'no'}</div>\`
      ].join('');
      renderOverview();
    }

`;
