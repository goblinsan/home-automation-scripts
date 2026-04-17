/**
 * Admin UI — document head + stylesheet module.
 *
 * Owns `<!doctype html>`, `<head>` metadata, and the inlined stylesheet for
 * the control-plane admin SPA. Kept separate from the body markup
 * (`./markup.ts`) and the client-side script (`./script.ts`) so that visual
 * updates can be reviewed in isolation from behavior changes.
 *
 * Runtime values interpolated here:
 *   - `basePath`       — prefix mounted by the reverse proxy. Exposed via the
 *                        `<meta name="gateway-base-path">` tag consumed by
 *                        the client bootstrap.
 *   - `faviconDataUri` — inline favicon data URI (avoids a separate asset
 *                        route through the admin server).
 */
export function renderAdminHead(basePath: string, faviconDataUri: string): string {
  // The original monolithic admin-ui called `adminFaviconDataUri()` inside
  // this template. We preserve that exact shape by wrapping the injected
  // value in a local closure so the block below remains a verbatim copy of
  // the previous content.
  const adminFaviconDataUri = (): string => faviconDataUri;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="gateway-base-path" content="${basePath}" />
  <title>Gateway Control Plane</title>
  <link rel="icon" type="image/svg+xml" href="${adminFaviconDataUri()}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Passion+One:wght@400;700;900&family=Karla:wght@400;500;700&family=Fira+Sans:wght@400;500;600;700&display=swap" />
  <style>
    :root {
      color-scheme: light;
      /* ── Operations-first palette (explicit hex tones) ────────────────────
         Structural dark:   #2F3E46, #354F52
         Primary accent:    #52796F
         Support accent:    #84A98C
         Light surface:     #CAD2C5
         Severity amber/red are outside the palette but kept for semaphore
         clarity on health status. */
      --p26-bg-base: #eef2ec;       /* tinted derivative of #CAD2C5 */
      --p26-surface: #ffffff;
      --p26-surface-raised: #f6f8f4;
      --p26-border: #CAD2C5;        /* light surface */
      --p26-border-strong: #84A98C; /* support accent */
      --p26-text: #2F3E46;          /* structural dark 1 */
      --p26-text-muted: #354F52;    /* structural dark 2 */
      --p26-accent: #52796F;        /* primary accent */
      --p26-accent-strong: #2F3E46; /* structural dark 1 */
      --p26-accent-soft: rgba(82, 121, 111, 0.14);
      --p26-shell: linear-gradient(90deg, #2F3E46 0%, #354F52 55%, #52796F 100%);
      --p26-healthy: #52796F;       /* primary accent = healthy */
      --p26-healthy-soft: #84A98C;  /* support accent, used for badges */
      --p26-degraded: #b8860b;      /* amber (outside named palette, severity) */
      --p26-down: #a63838;          /* red (outside named palette, severity) */
      --p26-unknown: #6b7a7d;
      --p26-info: #354F52;
      /* spacing scale */
      --p26-space-1: 4px;
      --p26-space-2: 8px;
      --p26-space-3: 12px;
      --p26-space-4: 16px;
      --p26-space-5: 20px;
      --p26-space-6: 24px;
      --p26-space-8: 32px;
      /* radii + shadow */
      --p26-radius: 4px;
      --p26-shadow: 0 10px 28px rgba(47, 62, 70, 0.10);
      /* typography */
      --p26-font-display: "Passion One", "Fira Sans", system-ui, sans-serif;
      --p26-font-body: "Karla", system-ui, "Helvetica Neue", sans-serif;
      --p26-font-ui: "Fira Sans", "Karla", system-ui, sans-serif;
      /* ── legacy aliases (preserved so existing panels keep rendering) ── */
      --bg: var(--p26-bg-base);
      --panel: var(--p26-surface);
      --line: var(--p26-border);
      --text: var(--p26-text);
      --muted: var(--p26-text-muted);
      --accent: var(--p26-accent);
      --accent-soft: var(--p26-accent-soft);
      --accent-strong: var(--p26-accent-strong);
      --sidebar: var(--p26-accent);
      --sidebar-soft: rgba(255, 255, 255, 0.14);
      --highlight: var(--p26-info);
      --danger: var(--p26-down);
      --ok: var(--p26-healthy);
      --shadow: rgba(47, 62, 70, 0.10);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--p26-font-body);
      background:
        linear-gradient(180deg, #f3f6f5 0%, var(--bg) 100%);
      color: var(--text);
    }
    header {
      padding: 20px 28px 16px;
      border-bottom: 1px solid rgba(16, 50, 53, 0.12);
      background: var(--p26-shell);
      color: #f5fbfa;
      font-family: var(--p26-font-ui);
    }
    h1 {
      margin: 0 0 10px;
      font-family: var(--p26-font-display);
      font-weight: 700;
      letter-spacing: 0.02em;
      font-size: 2.1rem;
    }
    h2, h3 {
      margin: 0 0 10px;
      font-family: var(--p26-font-ui);
      font-weight: 600;
    }
    p { margin: 0 0 10px; color: var(--muted); }
    .section-note { margin-top: 10px; font-size: 0.92rem; }
    main {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 18px;
      padding: 28px;
      align-items: start;
      max-width: 1460px;
      margin: 0 auto;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 2px;
      padding: 24px;
      box-shadow: 0 12px 32px var(--shadow);
    }
    .editor-panel { order: 1; }
    .toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    button {
      border: 1px solid rgba(16, 50, 53, 0.42);
      background: var(--panel);
      color: var(--text);
      border-radius: 0;
      padding: 11px 16px;
      font: inherit;
      cursor: pointer;
      transition: opacity 120ms ease, transform 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    button.button-tapped,
    button:active {
      transform: translateY(1px);
      opacity: 0.82;
    }
    button:disabled,
    button.is-busy {
      cursor: progress;
      opacity: 0.52;
      filter: grayscale(0.3);
      background: #e7eceb;
      border-color: rgba(16, 50, 53, 0.16);
      color: rgba(22, 51, 54, 0.72);
    }
    button.primary {
      background: var(--accent-strong);
      border-color: var(--accent-strong);
      color: #fff;
    }
    button.primary:hover:not(:disabled) {
      background: #184247;
      border-color: #184247;
    }
    button.danger {
      border-color: var(--danger);
      color: var(--danger);
    }
    .section-list {
      display: grid;
      gap: 16px;
      margin-top: 18px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 0;
      padding: 18px;
      background: #fff;
    }
    .row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 14px;
      color: var(--muted);
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 0;
      padding: 10px 12px;
      font: inherit;
      background: white;
      color: var(--text);
    }
    textarea {
      min-height: 96px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text);
    }
    .check input {
      width: auto;
    }
    .pill {
      display: inline-block;
      border-radius: 0;
      padding: 3px 8px;
      background: rgba(108, 152, 148, 0.14);
      color: #27555a;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 10px;
    }
    #status {
      min-height: 0;
      font-size: 13px;
      color: #163336;
      border: 1px solid rgba(16, 50, 53, 0.18);
      background: rgba(255, 255, 255, 0.96);
      padding: 10px 12px;
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status-ok {
      color: #163336;
      border-color: rgba(16, 50, 53, 0.18);
    }
    .status-error {
      color: #7c1f1f;
      border-color: rgba(143, 48, 48, 0.65);
      background: rgba(255, 235, 235, 0.96);
    }
    .status-progress {
      color: #6c4a00;
      border-color: rgba(183, 128, 0, 0.45);
      background: rgba(255, 246, 220, 0.98);
    }
    .action-dock {
      position: fixed;
      right: 18px;
      bottom: 18px;
      width: min(420px, calc(100vw - 36px));
      display: grid;
      gap: 10px;
      z-index: 999;
      pointer-events: none;
    }
    .action-dock > * {
      pointer-events: auto;
    }
    .action-dock-header {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 8px;
    }
    .action-dock-toggle {
      padding: 6px 10px;
      font-size: 12px;
      background: rgba(255, 255, 255, 0.96);
    }
    .action-feed {
      border: 1px solid rgba(16, 50, 53, 0.18);
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 12px 28px rgba(17, 30, 38, 0.16);
      max-height: 220px;
      overflow: auto;
    }
    .action-feed.is-collapsed {
      display: none;
    }
    .action-feed-empty {
      margin: 0;
      padding: 12px;
      font-size: 13px;
      color: var(--muted);
    }
    .action-entry {
      padding: 10px 12px;
      border-top: 1px solid rgba(16, 50, 53, 0.08);
      background: rgba(255, 255, 255, 0.96);
    }
    .action-entry:first-child {
      border-top: 0;
    }
    .action-entry strong {
      display: block;
      margin-bottom: 4px;
      font-size: 13px;
    }
    .action-entry time {
      display: block;
      font-size: 11px;
      color: var(--muted);
    }
    .action-entry.error strong {
      color: #7c1f1f;
    }
    .action-entry.progress strong {
      color: #8b5d00;
    }
    .inline-action-output {
      border: 1px solid var(--line);
      background: #fcfcfa;
      padding: 12px;
      font-size: 14px;
    }
    .inline-action-output.is-error {
      border-color: rgba(143, 48, 48, 0.45);
      background: #fff3f3;
    }
    .inline-action-output.is-progress {
      border-color: rgba(183, 128, 0, 0.35);
      background: #fff8e6;
    }
    .inline-action-output strong {
      display: block;
      margin-bottom: 6px;
    }
    .action-dock-title {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-right: auto;
      padding-left: 4px;
    }
    .current-action {
      border: 1px solid rgba(16, 50, 53, 0.18);
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 12px 28px rgba(17, 30, 38, 0.16);
      padding: 12px 14px;
      border-left: 4px solid rgba(16, 50, 53, 0.28);
      display: grid;
      gap: 4px;
    }
    .current-action.is-progress {
      border-left-color: rgba(183, 128, 0, 0.75);
      background: rgba(255, 246, 220, 0.98);
    }
    .current-action.is-ok {
      border-left-color: rgba(32, 120, 80, 0.75);
    }
    .current-action.is-error {
      border-left-color: rgba(143, 48, 48, 0.75);
      background: rgba(255, 235, 235, 0.96);
    }
    .current-action-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .current-action-message {
      font-size: 13px;
      font-weight: 600;
      color: #163336;
      line-height: 1.35;
    }
    .current-action.is-error .current-action-message {
      color: #7c1f1f;
    }
    .current-action.is-progress .current-action-message {
      color: #8b5d00;
    }
    .current-action-time {
      font-size: 11px;
      color: var(--muted);
    }
    .bootstrap-task-list {
      list-style: none;
      margin: 12px 0 0;
      padding: 0;
      display: grid;
      gap: 8px;
    }
    .bootstrap-task-list li {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      padding: 10px 12px;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 4px;
    }
    .bootstrap-task-list li > div {
      display: grid;
      gap: 2px;
    }
    .bootstrap-task-list li strong {
      font-size: 14px;
    }
    .bootstrap-task-list li span:not(.bootstrap-task-num) {
      font-size: 12px;
      color: var(--muted);
    }
    .bootstrap-task-num {
      flex: 0 0 auto;
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: var(--accent-strong);
      color: #fff;
      font-weight: 700;
      font-size: 13px;
    }
    .nodes-inventory-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .nodes-inventory-card {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 4px;
      padding: 12px 14px;
      border-left: 3px solid var(--accent-strong);
    }
    .nodes-inventory-count {
      font-size: 1.8rem;
      font-weight: 700;
      line-height: 1.1;
      color: #163336;
    }
    .nodes-inventory-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-top: 2px;
    }
    .nodes-inventory-detail {
      margin-top: 6px;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.35;
    }
    .monitor-dashboard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .monitor-dashboard-card {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 4px;
      padding: 12px 14px;
      border-left: 3px solid var(--muted);
    }
    .monitor-dashboard-card.is-healthy { border-left-color: var(--color-success, #2ecc71); }
    .monitor-dashboard-card.is-degraded { border-left-color: var(--color-warning, #e6a419); }
    .monitor-dashboard-card.is-action { border-left-color: var(--color-error, #c0392b); }
    .monitor-dashboard-count {
      font-size: 1.8rem;
      font-weight: 700;
      line-height: 1.1;
      color: #163336;
    }
    .monitor-dashboard-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-top: 2px;
    }
    .monitor-dashboard-detail {
      margin-top: 6px;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.35;
    }
    .secrets-intro {
      border-left: 4px solid rgba(183, 128, 0, 0.6);
    }
    .secrets-guard-note {
      margin-top: 6px;
      font-size: 12px;
      color: #6c4a00;
    }
    .secrets-guard-actions {
      display: flex;
      align-items: flex-start;
    }
    .secrets-reveal-btn[aria-pressed="true"] {
      background: rgba(183, 128, 0, 0.12);
      border-color: rgba(183, 128, 0, 0.65);
      color: #6c4a00;
    }
    body.is-secrets-revealed .secrets-reveal-btn::before {
      content: "👁 ";
    }
    .log-output {
      margin: 12px 0 0;
      padding: 12px;
      border: 1px solid var(--line);
      background: #f7faf8;
      font-family: "SFMono-Regular", ui-monospace, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 320px;
      overflow: auto;
    }
    .aside-stack {
      order: 2;
      display: grid;
      gap: 18px;
    }
    .header-shell {
      display: grid;
      gap: 18px;
    }
    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      flex-wrap: wrap;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .header-row h1,
    .header-row p {
      color: inherit;
    }
    .header-row p {
      color: rgba(245, 251, 250, 0.78);
      max-width: 760px;
    }
    .top-tab-nav {
      display: grid;
      grid-template-columns: repeat(6, minmax(110px, 1fr));
      gap: 8px;
      padding-bottom: 2px;
      width: min(1380px, 100%);
      margin: 0 auto;
      font-family: var(--p26-font-ui);
    }
    .top-tab-nav .tab-button {
      width: 100%;
      min-width: 0;
      text-align: center;
      border: 1px solid transparent;
      background: transparent;
      color: rgba(245, 251, 250, 0.88);
      padding: 12px 18px;
      font-size: 15px;
      white-space: nowrap;
    }
    .top-tab-nav .tab-button:hover,
    .top-tab-nav .tab-button.active {
      background: #ffffff;
      color: var(--accent-strong);
      border-color: #ffffff;
    }
    .sub-tab-nav {
      display: flex;
      gap: 6px;
      margin-bottom: 18px;
      border-bottom: 2px solid var(--border);
      padding-bottom: 0;
    }
    .sub-tab-nav .sub-tab-button {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--muted);
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      margin-bottom: -2px;
      white-space: nowrap;
    }
    .sub-tab-nav .sub-tab-button:hover {
      color: var(--fg);
    }
    .sub-tab-nav .sub-tab-button.active {
      color: var(--accent-strong);
      border-bottom-color: var(--accent-strong);
    }
    .sub-tab-panel { display: none; }
    .sub-tab-panel.active { display: block; }
    .nav-card {
      background: linear-gradient(180deg, var(--sidebar) 0%, #214c44 100%);
      color: #f3f7f5;
      border-color: rgba(255, 255, 255, 0.08);
      min-height: 320px;
    }
    .nav-card p,
    .nav-card h2 {
      color: inherit;
    }
    .nav-card p {
      opacity: 0.76;
    }
    .tab-nav {
      display: grid;
      gap: 10px;
      margin-top: 22px;
    }
    .tab-button {
      width: 100%;
      text-align: left;
      border: 0;
      background: transparent;
      color: rgba(255, 255, 255, 0.82);
      border-radius: 0;
      padding: 14px 16px;
      font: inherit;
      font-size: 16px;
    }
    .tab-button:hover,
    .tab-button.active {
      background: var(--sidebar-soft);
      color: white;
    }
    .tab-panel[hidden] {
      display: none !important;
    }
    .split-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 0;
      padding: 12px;
      background: white;
      position: relative;
      overflow: hidden;
    }
    .metric::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 5px;
      background: linear-gradient(90deg, #1f5f56 0%, var(--accent) 100%);
    }
    .metric:nth-child(3n)::before {
      background: linear-gradient(90deg, var(--highlight) 0%, #ffce45 100%);
    }
    .metric strong {
      display: block;
      font-size: 30px;
      margin-bottom: 4px;
    }
    .meta-list {
      display: grid;
      gap: 8px;
      margin-top: 12px;
      font-size: 14px;
      color: var(--muted);
      word-break: break-word;
    }
    .hint-list {
      display: grid;
      gap: 6px;
      color: var(--muted);
    }
    .section-card {
      padding: 0;
      overflow: hidden;
    }
    .section-card summary {
      list-style: none;
      cursor: pointer;
      padding: 18px;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }
    .section-card summary::-webkit-details-marker {
      display: none;
    }
    .section-card summary::after {
      content: "+";
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 20px;
      line-height: 1;
      margin-top: 2px;
    }
    .section-card[open] summary::after {
      content: "−";
    }
    .section-card summary p {
      margin-bottom: 0;
    }
    .section-card .section-body {
      border-top: 1px solid var(--line);
      padding: 18px;
      background: #fcfcfa;
    }
    .section-card .section-body > :first-child {
      margin-top: 0;
    }
    .section-card .section-body .card {
      background: #fff;
    }
    .section-summary-copy {
      display: grid;
      gap: 6px;
    }
    .section-summary-copy h3 {
      margin-bottom: 0;
    }
    .section-summary-copy p {
      font-size: 14px;
    }
    .card-quiet {
      background: #fcfcfa;
    }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      grid-auto-rows: 1fr;
      gap: 16px;
      margin-top: 18px;
    }
    .overview-card {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 180px;
    }
    .overview-card strong {
      font-size: 20px;
      font-weight: 600;
    }
    .overview-card p {
      flex: 1 1 auto;
    }
    .overview-card button {
      width: 100%;
      margin-top: auto;
    }
    .disclosure-card > summary {
      display: block;
      padding-bottom: 12px;
      margin-bottom: 14px;
      border-bottom: 1px solid var(--line);
    }
    .disclosure-card {
      margin-top: 20px;
    }
    .disclosure-card .row:first-of-type {
      margin-top: 16px;
    }
    details:not(.section-card) > summary {
      list-style: none;
      cursor: pointer;
      user-select: none;
    }
    details:not(.section-card) > summary::-webkit-details-marker {
      display: none;
    }
    details:not(.section-card) > summary::before {
      content: "+";
      display: inline-block;
      width: 16px;
      margin-right: 8px;
      color: var(--muted);
    }
    details[open]:not(.section-card) > summary::before {
      content: "−";
    }
    .aside-stack > details.panel {
      padding: 18px 20px;
    }
    @media (max-width: 980px) {
      .action-dock {
        left: 12px;
        right: 12px;
        bottom: 12px;
        width: auto;
      }
      main { grid-template-columns: 1fr; }
      .editor-panel { order: 1; }
      .aside-stack { order: 2; }
      .header-row { align-items: stretch; }
      .top-tab-nav {
        display: flex;
        overflow-x: auto;
        width: 100%;
      }
      .top-tab-nav .tab-button {
        min-width: max-content;
      }
      .overview-grid {
        grid-template-columns: 1fr;
      }
    }

    .wizard-dialog {
      border: none;
      border-radius: 10px;
      padding: 0;
      max-width: 640px;
      width: 90vw;
      max-height: 85vh;
      box-shadow: 0 8px 32px var(--shadow);
      background: #fff;
      color: var(--text);
    }
    .wizard-dialog::backdrop {
      background: rgba(16, 50, 53, .45);
    }
    .wizard-content {
      display: flex;
      flex-direction: column;
      max-height: 85vh;
    }
    .wizard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--line);
      background: #fff;
    }
    .wizard-header h2 {
      margin: 0;
      font-size: 1.15rem;
      color: var(--text);
    }
    .wizard-close {
      background: none;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      color: var(--muted);
      padding: 0 .25rem;
      line-height: 1;
    }
    .wizard-close:hover {
      color: var(--text);
    }
    .wizard-step {
      padding: 1.25rem;
      overflow-y: auto;
      background: #fff;
    }
    .wizard-desc {
      margin: 0 0 1rem;
      color: var(--muted);
    }
    .wizard-form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: .75rem;
    }
    .wizard-field {
      display: flex;
      flex-direction: column;
      gap: .25rem;
    }
    .wizard-field span {
      font-size: .85rem;
      font-weight: 600;
      color: var(--text);
    }
    .wizard-field small {
      font-weight: 400;
      color: var(--muted);
    }
    .wizard-field input,
    .wizard-field select {
      padding: .4rem .5rem;
      border: 1px solid var(--line);
      border-radius: 0;
      background: white;
      color: var(--text);
      font-size: .9rem;
    }
    .wizard-field input:focus,
    .wizard-field select:focus {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }
    .wizard-actions {
      display: flex;
      justify-content: flex-end;
      gap: .5rem;
      padding-top: 1rem;
    }
    .wizard-btn-primary,
    .wizard-btn-secondary {
      padding: .5rem 1.25rem;
      border-radius: 0;
      border: 1px solid var(--line);
      cursor: pointer;
      font-size: .9rem;
    }
    .wizard-btn-primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
      font-weight: 600;
    }
    .wizard-btn-primary:disabled {
      opacity: .5;
      cursor: not-allowed;
    }
    .wizard-btn-secondary {
      background: #fff;
      color: var(--text);
    }
    .wizard-btn-secondary:hover {
      background: var(--bg);
    }
    .wizard-preset-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: .75rem;
      margin-bottom: 1rem;
    }
    .wizard-preset-card {
      border: 2px solid var(--line);
      border-radius: 0;
      padding: 1rem;
      cursor: pointer;
      background: #fff;
      text-align: left;
      transition: border-color .15s;
    }
    .wizard-preset-card:hover {
      border-color: var(--accent);
    }
    .wizard-preset-card.selected {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .wizard-preset-card strong {
      display: block;
      color: var(--text);
      margin-bottom: .25rem;
    }
    .wizard-preset-card small {
      color: var(--muted);
      font-size: .8rem;
    }
    .svc-catalog-card {
      border: 2px solid var(--line);
      border-radius: 0;
      padding: 1rem;
      cursor: pointer;
      background: #fff;
      text-align: left;
      transition: border-color .15s;
    }
    .svc-catalog-card:hover {
      border-color: var(--accent);
    }
    .svc-catalog-card.selected {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .svc-catalog-card strong {
      display: block;
      color: var(--text);
      margin-bottom: .25rem;
    }
    .svc-catalog-card small {
      color: var(--muted);
      font-size: .8rem;
    }
    .wizard-form-grid {
      display: flex;
      flex-direction: column;
      gap: .75rem;
      max-height: 55vh;
      overflow-y: auto;
      padding-right: .5rem;
    }
    .wizard-field {
      display: flex;
      flex-direction: column;
      gap: .2rem;
    }
    .wizard-label {
      font-weight: 600;
      font-size: .85rem;
      color: var(--text);
    }
    .wizard-field input,
    .wizard-field select {
      padding: .45rem .6rem;
      border: 1px solid var(--line);
      font-size: .85rem;
      font-family: inherit;
      background: #fff;
      color: var(--text);
    }
    .wizard-field input:focus,
    .wizard-field select:focus {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }
    .wizard-hint {
      font-size: .75rem;
      color: var(--muted);
    }
    .mini-table { width: 100%; border-collapse: collapse; font-size: .82rem; margin-top: .25rem; }
    .mini-table th, .mini-table td { text-align: left; padding: .2rem .5rem; border-bottom: 1px solid var(--line); }
    .mini-table th { font-weight: 600; color: var(--muted); }
    .mini-table td code { font-size: .78rem; }
    .mini-table td.ok { color: #1a7a4c; }
    .mini-table td.error { color: #c0392b; }
    .wizard-log-line.success { color: #1a7a4c; }
    .wizard-log-line.error { color: #c0392b; }
    .wizard-log-line.info { color: var(--muted); }
    .wizard-log {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: .82rem;
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 0;
      padding: .75rem 1rem;
      min-height: 200px;
      max-height: 50vh;
      overflow-y: auto;
      line-height: 1.6;
      color: var(--text);
    }
    .wizard-log-entry {
      display: flex;
      align-items: flex-start;
      gap: .5rem;
      padding: .15rem 0;
      color: var(--text);
    }
    .wizard-log-icon {
      flex-shrink: 0;
      width: 1.2em;
      text-align: center;
    }
    .wiz-running .wizard-log-icon { color: var(--highlight); }
    .wiz-ok .wizard-log-icon { color: var(--ok); }
    .wiz-warn .wizard-log-icon { color: #b8860b; }
    .wiz-error .wizard-log-icon { color: var(--danger); }
    .wiz-complete .wizard-log-icon { color: var(--ok); }
    button.primary-action {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
      font-weight: 600;
    }

    /* ── Overview (health-first landing) ── */
    .overview-panel { font-family: var(--p26-font-body); }
    .overview-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: var(--p26-space-4);
      margin-bottom: var(--p26-space-5);
    }
    .overview-header h2 {
      font-family: var(--p26-font-display);
      font-weight: 700;
      letter-spacing: 0.02em;
      font-size: 1.8rem;
      margin: 0;
      color: var(--p26-accent-strong);
    }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--p26-space-4);
      margin-bottom: var(--p26-space-6);
    }
    .overview-card {
      border: 1px solid var(--p26-border);
      background: var(--p26-surface);
      border-radius: var(--p26-radius);
      padding: var(--p26-space-5);
      box-shadow: var(--p26-shadow);
      border-left: 4px solid var(--p26-unknown);
    }
    .overview-card.is-healthy { border-left-color: var(--p26-healthy); }
    .overview-card.is-degraded { border-left-color: var(--p26-degraded); }
    .overview-card.is-down { border-left-color: var(--p26-down); }
    .overview-card.is-action { border-left-color: var(--p26-down); }
    .overview-card .overview-count {
      font-family: var(--p26-font-display);
      font-size: 2.6rem;
      font-weight: 700;
      line-height: 1;
      color: var(--p26-accent-strong);
    }
    .overview-card .overview-label {
      font-family: var(--p26-font-ui);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 0.82rem;
      color: var(--p26-text-muted);
      margin-top: var(--p26-space-2);
    }
    .overview-card .overview-detail {
      margin-top: var(--p26-space-3);
      font-size: 0.9rem;
      color: var(--p26-text-muted);
      line-height: 1.4;
    }
    .overview-section-title {
      font-family: var(--p26-font-ui);
      font-weight: 600;
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--p26-text-muted);
      margin: var(--p26-space-6) 0 var(--p26-space-3);
    }
    .overview-runtime {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: var(--p26-space-3);
      margin-bottom: var(--p26-space-5);
    }
    .overview-runtime .metric {
      margin-top: 0;
    }
    .overview-target-list {
      display: grid;
      gap: var(--p26-space-2);
    }
    .overview-target {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--p26-space-3);
      padding: var(--p26-space-3) var(--p26-space-4);
      border: 1px solid var(--p26-border);
      background: var(--p26-surface);
      border-left: 3px solid var(--p26-unknown);
      border-radius: var(--p26-radius);
    }
    .overview-target.is-healthy { border-left-color: var(--p26-healthy); }
    .overview-target.is-degraded { border-left-color: var(--p26-degraded); }
    .overview-target.is-down { border-left-color: var(--p26-down); }
    .overview-target-meta {
      color: var(--p26-text-muted);
      font-size: 0.85rem;
      display: flex;
      gap: var(--p26-space-3);
      flex-wrap: wrap;
    }
    .overview-empty {
      padding: var(--p26-space-5);
      border: 1px dashed var(--p26-border);
      border-radius: var(--p26-radius);
      color: var(--p26-text-muted);
      text-align: center;
    }
    .overview-link-btn {
      background: var(--p26-accent);
      color: #fff;
      border-color: var(--p26-accent);
      font-family: var(--p26-font-ui);
      font-weight: 600;
    }
    .overview-link-btn:hover:not(:disabled) {
      background: var(--p26-accent-strong);
      border-color: var(--p26-accent-strong);
    }
  </style>
`;
}
