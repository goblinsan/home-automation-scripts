/**
 * Admin UI — client-side script compositor.
 *
 * Holds the inline `<script>` block executed in the browser: the shared
 * `state` object, the navigation / lazy-loading runtime, and all page and
 * domain renderers (Overview, Bootstrap, Nodes, Workloads, Monitoring,
 * Secrets, Services, action/output surfaces, chat/TTS/KULRS status, etc.).
 *
 * Behavioral invariants that must survive every refactor here:
 *   - `state` initialization defaults remain stable.
 *   - `state.activeTab` and `state.activeSubTabs` drive navigation and
 *     fetch-on-activation; their shape must not change.
 *   - `state.dataLoaded` and `state.subTabLoading` remain the source of
 *     truth for lazy loading and local spinners.
 *   - Runtime summary, health snapshot, remote service / minecraft status,
 *     chat provider, TTS, and KULRS status fetches keep their current
 *     refresh cadences and guard conditions.
 *   - Form-to-config synchronization and raw JSON editor synchronization
 *     remain bidirectional.
 *
 * Only one value is injected from the server here:
 *   - `defaultWorkflowSeedPath` — the path used to seed workflow imports
 *     when the operator leaves the field blank.
 */

import { renderScriptState } from './script/state.ts';
import { HELPERS_SCRIPT } from './script/helpers.ts';
import { SHELL_SCRIPT } from './script/shell.ts';
import { CONFIG_FORM_SCRIPT } from './script/config-form.ts';
import { SERVICES_SCRIPT } from './script/services.ts';
import { MONITORING_SCRIPT } from './script/monitoring.ts';
import { OVERVIEW_SCRIPT } from './script/overview.ts';
import { SECRETS_SCRIPT } from './script/secrets.ts';
import { WORKLOADS_SCRIPT } from './script/workloads.ts';
import { BOOTSTRAP_SCRIPT } from './script/bootstrap.ts';
import { DATA_SCRIPT } from './script/data.ts';
import { INIT_SCRIPT } from './script/init.ts';

export interface AdminScriptOptions {
  /** Default workflow seed path baked into the client state defaults. */
  readonly defaultWorkflowSeedPath: string;
}

export function renderAdminScript(options: AdminScriptOptions): string {
  return `  <script>\n` +
    renderScriptState(options.defaultWorkflowSeedPath) +
    HELPERS_SCRIPT +
    SHELL_SCRIPT +
    CONFIG_FORM_SCRIPT +
    SERVICES_SCRIPT +
    MONITORING_SCRIPT +
    OVERVIEW_SCRIPT +
    SECRETS_SCRIPT +
    WORKLOADS_SCRIPT +
    BOOTSTRAP_SCRIPT +
    DATA_SCRIPT +
    INIT_SCRIPT +
    `  </script>\n`;
}
