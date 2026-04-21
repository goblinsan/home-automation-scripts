/**
 * Admin UI — navigation shell browser-runtime module.
 * Extracted from script.ts.
 */

export const SHELL_SCRIPT = `    // Nav ownership map.  Each top-nav button owns a set of (tab, subTab) pairs
    // so the top-nav stays correctly highlighted when the operator drills into a
    // sub-tab that this nav item logically contains.
    //
    // The Workloads and Secrets top-nav items now own their own composed
    // tab-panels (data-tab-panel workloads / data-tab-panel secrets) rather
    // than being transitional remaps onto legacy infra/services sub-tabs.  The
    // composition pulls together remote workloads, bedrock, managed apps,
    // workflows/jobs, agents, runtime profiles, and feature flags for Workloads;
    // and isolates credential/secret-bearing surfaces under Secrets.  The legacy
    // services tab-panel is no longer reachable from the top nav; its former
    // sub-panels are reparented into the Workloads page at init.
    const NAV_OWNERSHIP = {
      overview:  [['overview',   null]],
      bootstrap: [['infra',      'infra-gateway']],
      nodes:     [['infra',      'infra-nodes']],
      workloads: [['workloads',  null]],
      monitor:   [
        ['monitoring', 'mon-health'],
        ['monitoring', 'mon-benchmarks'],
        ['monitoring', 'mon-settings']
      ],
      secrets:   [['secrets',    null]]
    };

    // Compose the new Workloads and Secrets top-level pages from the existing
    // sub-surface DOM.  This keeps all existing element IDs, event handlers,
    // render functions, and lazy-loading behavior intact — we only relocate
    // the sub-panels into the composed parent tab-panels so that top-nav
    // activation no longer depends on the legacy infra/services grouping.
    (function composeWorkloadsAndSecretsPages() {
      const workloadsTab = document.querySelector('[data-tab-panel="workloads"]');
      const secretsTab   = document.querySelector('[data-tab-panel="secrets"]');
      if (!workloadsTab || !secretsTab) {
        return;
      }

      // Move the Remote Workloads details card from the Nodes sub-panel into
      // the Workloads > Remote Workloads sub-panel so remote workloads are
      // primarily owned by the Workloads page, not by Nodes.
      const remoteWorkloadsSection = document.getElementById('remoteWorkloadsSection');
      const workloadsRemoteHost    = document.getElementById('workloadsRemoteHost');
      if (remoteWorkloadsSection && workloadsRemoteHost) {
        workloadsRemoteHost.appendChild(remoteWorkloadsSection);
        remoteWorkloadsSection.open = true;
      }

      // Move the Secrets details card out of the svc-profiles sub-panel and
      // into the dedicated Secrets tab-panel.  This splits svc-profiles into
      // runtime configuration (which stays on the Workloads > Runtime Profiles
      // sub-tab) and secrets/credentials (which move here).
      const secretsSection = document.getElementById('secretsSection');
      const secretsHost    = document.getElementById('secretsHost');
      if (secretsSection && secretsHost) {
        secretsHost.appendChild(secretsSection);
        secretsSection.open = true;
      }

      // Reparent each composed sub-tab panel out of its legacy host tab-panel
      // into the Workloads tab-panel so applySubTabDom (which selects sub-tab
      // panels under the nav group's parent) finds them here.  The wl-remote
      // panel already lives under Workloads and renders the relocated Remote
      // Workloads card above.
      ['infra-minecraft', 'svc-deploys', 'svc-workflows', 'svc-agents', 'svc-profiles', 'svc-features']
        .forEach((subTabId) => {
          const panel = document.querySelector('[data-sub-tab-panel="' + subTabId + '"]');
          if (panel) {
            panel.classList.remove('active');
            workloadsTab.appendChild(panel);
          }
        });

      // Ensure the default Workloads sub-tab shows wl-remote on first entry.
      const wlRemotePanel = workloadsTab.querySelector('[data-sub-tab-panel="wl-remote"]');
      if (wlRemotePanel) {
        wlRemotePanel.classList.add('active');
      }
    })();

    function findActiveNavId() {
      const tab = state.activeTab;
      const subTab = state.activeSubTabs[tab] || null;
      for (const [navId, owned] of Object.entries(NAV_OWNERSHIP)) {
        for (const [ownTab, ownSub] of owned) {
          if (ownTab === tab && (ownSub === null || ownSub === subTab)) {
            return navId;
          }
        }
      }
      return null;
    }

    function renderActiveTab() {
      document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.tabPanel !== state.activeTab;
      });
      const activeNavId = findActiveNavId();
      document.querySelectorAll('.top-tab-nav .tab-button').forEach((button) => {
        const isActive = button.dataset.navId === activeNavId;
        button.classList.toggle('active', isActive);
        if (isActive) {
          button.setAttribute('aria-current', 'page');
        } else {
          button.removeAttribute('aria-current');
        }
      });
    }

    // Applies the sub-tab DOM state (panel visibility + tab-button active class)
    // without triggering a data fetch.  Callers that also need data should run
    // loadSubTabData separately (or rely on loadTabData to do it once).
    function applySubTabDom(groupName, subTabId) {
      const group = document.querySelector('[data-sub-group="' + groupName + '"]');
      if (!group) return;
      const parent = group.parentElement;
      parent.querySelectorAll('.sub-tab-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.subTabPanel === subTabId);
      });
      group.querySelectorAll('.sub-tab-button').forEach((btn) => {
        const isActive = btn.dataset.subTab === subTabId;
        btn.classList.toggle('active', isActive);
        if (isActive) {
          btn.setAttribute('aria-current', 'page');
        } else {
          btn.removeAttribute('aria-current');
        }
      });
      state.activeSubTabs[groupName] = subTabId;
    }

    function switchSubTab(groupName, subTabId) {
      applySubTabDom(groupName, subTabId);
      // Keep the top-nav highlight in sync as the operator moves between
      // legacy sub-tabs that belong to the same operations-first nav item
      // (e.g. Workloads stays active across Agents / Workflows / Deploys).
      renderActiveTab();
      loadSubTabData(subTabId, { silent: true });
    }

`;
