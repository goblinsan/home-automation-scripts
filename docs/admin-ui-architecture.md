# Admin UI Architecture

The admin UI is the single-page operator console served by the control-plane.
It previously lived as one ~11k line file, `src/lib/admin-ui.ts`, that mixed
HTTP handlers with an inline HTML/CSS/JS template. This document captures the
module boundaries, navigation model, and invariants contributors must preserve
when extending or refactoring the UI.

## Module boundary map

```
src/lib/
  admin-ui.ts              # HTTP server, routing, proxies, orchestration
  admin-ui/
    index.ts               # renderAdminPage() — composes the SPA document
    head.ts                # <!doctype html>, <head>, inline stylesheet
    markup.ts              # static <body> scaffolding (tabs, page containers)
    script.ts              # inline <script> block (state + renderers)
```

- **`admin-ui.ts`** owns the Node HTTP server, admin API endpoints, config
  read/write, managed-app proxy paths, remote-deploy scheduling, and the
  small composition seam (`htmlPage(basePath)`) that returns the shell HTML.
  It **must not** contain page-specific HTML or client-side JavaScript.
- **`admin-ui/index.ts`** is the composition entry point. It accepts a
  `basePath`, a favicon data URI, and a default workflow-seed path, and
  returns the full HTML document.
- **`admin-ui/head.ts`** owns document metadata and the stylesheet. Visual
  changes (palette tweaks, responsive breakpoints, layout rules) live here.
  Two values are interpolated: the gateway base path (for the
  `<meta name="gateway-base-path">` hint) and the inline favicon data URI.
- **`admin-ui/markup.ts`** owns the static body scaffolding: the top-level
  tab bar (Overview, Workloads, Infra, Monitoring, Secrets, …), the per-tab
  page containers, and the shared action-output surface at the bottom of the
  page. The markup is a plain string constant with zero template
  interpolation — dynamic content is injected at runtime by the script
  module.
- **`admin-ui/script.ts`** owns the client-side runtime: the shared `state`
  object, the navigation/lazy-loading shell, and all page/domain renderers
  (Overview, Bootstrap, Nodes, Workloads, Monitoring, Secrets, chat/TTS/KULRS
  status, Minecraft status, action feed, etc.). The only value injected from
  the server is `defaultWorkflowSeedPath`.

## Ownership of each page/domain renderer

Every page container in `markup.ts` has a corresponding renderer in
`script.ts` that hydrates it from `state`. New pages should:

1. Add a tab button (with `data-tab="…"`) and a `<section>` container in
   `markup.ts`.
2. Add the page renderer, its lazy-load key in `state.dataLoaded`, and its
   fetch-on-activation entry in `script.ts`.
3. Add the backend endpoint and proxy (if any) in `admin-ui.ts`.

Contributors **must not** reintroduce page-specific HTML or JS into
`admin-ui.ts` — that would undo the seam this refactor established.

## Navigation and lazy loading

Navigation is driven by three pieces of shared state:

- `state.activeTab` — currently selected top-level tab.
- `state.activeSubTabs[tab]` — currently selected sub-tab per top-level tab.
- `state.dataLoaded` — per-page "we have fetched at least once" flags.
- `state.subTabLoading` — per-sub-tab "fetch in flight" flags that drive
  local spinners.

When a tab or sub-tab becomes active, the shell invokes its
fetch-on-activation handler only if `dataLoaded` does not yet include that
page. That handler sets `subTabLoading` while it runs, renders into the
page's section on success, and calls `markLoaded(key)` to record completion.
Background refresh intervals (runtime summary, health snapshot, remote
service / minecraft status, chat provider, TTS, KULRS) are all gated on
`state.activeTab` / `state.activeSubTabs[state.activeTab]` so inactive pages
do not issue network requests.

## Long-running actions and the output surface

Long-running operator actions (deploys, rollbacks, smoke tests, remote
workload rollouts, manual minecraft updates, …) stream progress into the
shared action-output surface rendered by `markup.ts`:

- `#currentAction` — the active action banner (title + message + timestamp).
- `#actionFeed` — the rolling history of recent actions.

Renderers append structured entries via the shared action helpers in
`script.ts`. New actions should reuse those helpers rather than inventing
their own DOM surfaces so that operators see a consistent log across pages.

## Invariants new contributors must preserve

The issue that introduced this module split called out a short list of
behaviors that must survive every future refactor. They are repeated here so
they are discoverable at review time:

1. `state` initialization defaults — do not drop or rename existing keys.
2. `state.activeTab` and `state.activeSubTabs` — shape and semantics stable.
3. Page-specific fetch-on-activation — each page still fetches only when it
   first becomes active.
4. `state.dataLoaded` and `state.subTabLoading` — remain the single source
   of truth for lazy loading and local spinners.
5. Runtime summary, health snapshot, remote service / minecraft status,
   chat provider, TTS, and KULRS status refresh cadences and guards.
6. Form-to-config and raw JSON editor synchronization must remain
   bidirectional.
7. Backend routes and data contracts proxied by `admin-ui.ts` remain stable
   unless a coordinated change lands in `gateway-api` or
   `gateway-chat-platform`.

## Composition invariants

`renderAdminPage()` concatenates the three module outputs with no extra
separators and appends `</body></html>`. The composed document must remain
byte-identical to what the previous inline template produced for the same
inputs. The regression test in `tests/admin-ui.test.ts` enforces that each
structural tag (`<!doctype html>`, `<html>`, `<head>`, `<body>`, …) appears
exactly once and that the per-module invariants above hold.

## Testing

Page/domain extractions can be validated without spinning up the admin
server:

```ts
import { renderAdminPage } from '../src/lib/admin-ui/index.ts';

const html = renderAdminPage({
  basePath: '/admin/',
  faviconDataUri: 'data:image/svg+xml;utf8,…',
  defaultWorkflowSeedPath: '/seed.json',
});
```

See `tests/admin-ui.test.ts` for the current regression coverage: document
head interpolation, body tab shell, script state invariants, full-page
composition, and the "no duplicate structural tags" assertion.

## Why this split, and what's next

The first modularization pass establishes stable seams — head, markup, and
script — without changing behavior. Follow-up passes can safely:

- Split `markup.ts` into per-page fragments (overview, bootstrap, nodes,
  workloads, monitoring, secrets, …) that are concatenated by `index.ts`.
- Split `script.ts` by page/domain module using the same pattern, with
  shared helpers (action surface, data loading, form/state sync) extracted
  first and the page renderers layered on top.
- Replace broad global render passes with page-scoped renderers that read
  only their slice of `state`.

Future contributors should prefer extending the module structure over
growing any one file. If you find yourself tempted to add a large block of
HTML or JS back into `admin-ui.ts`, stop and add a module under
`src/lib/admin-ui/` instead.
