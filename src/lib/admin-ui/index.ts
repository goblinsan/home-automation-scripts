/**
 * Admin UI — page composition entry point.
 *
 * This module is the single seam where the admin SPA is assembled from its
 * page/domain modules. It replaces the prior monolithic `htmlPage()` helper
 * that lived inline inside `../admin-ui.ts`.
 *
 * Module boundary map:
 *
 *   ./head.ts    — `<!doctype html>` + `<head>` + stylesheet
 *   ./markup.ts  — static `<body>` scaffolding (tabs, page containers,
 *                  action-output surface)
 *   ./script.ts  — client-side `<script>` block (state, navigation,
 *                  lazy loading, page/domain renderers)
 *
 * Adding a new page should follow this pattern: extend `markup.ts` with the
 * page container, extend `script.ts` with the page renderer and its lazy-load
 * entry in `state.dataLoaded`, and keep this file untouched. Contributors
 * **must not** reintroduce page-specific HTML or JavaScript into the parent
 * `admin-ui.ts` server module — that module is reserved for HTTP handlers
 * and server-side orchestration.
 */
import { renderAdminHead } from './head.ts';
import { ADMIN_MARKUP } from './markup.ts';
import { renderAdminScript } from './script.ts';

export interface RenderAdminPageOptions {
  /** Base path the admin UI is mounted under (e.g. `/admin/`). */
  readonly basePath: string;
  /** Inline favicon data URI, rendered into the document head. */
  readonly faviconDataUri: string;
  /** Default workflow seed path baked into the client state defaults. */
  readonly defaultWorkflowSeedPath: string;
}

/**
 * Compose the full admin SPA document. The string returned here is shipped
 * verbatim as the `text/html` response for the admin UI shell route.
 */
export function renderAdminPage(options: RenderAdminPageOptions): string {
  const head = renderAdminHead(options.basePath, options.faviconDataUri);
  const script = renderAdminScript({
    defaultWorkflowSeedPath: options.defaultWorkflowSeedPath,
  });
  // Each extracted block preserves its original leading/trailing whitespace
  // so the composed document is byte-identical to the previous monolithic
  // template. Do NOT insert additional separators here.
  return head + ADMIN_MARKUP + script + '</body>\n</html>';
}

export { renderAdminHead, ADMIN_MARKUP, renderAdminScript };
