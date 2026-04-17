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
- `state.dataLoaded` — timestamp map used by `isStale(key)` (stale after 30 s).
- `state.subTabLoading` — per-sub-tab "fetch in flight" flags that drive
  local spinners.

### `loadTabData(tab)` — called on every tab activation

`loadTabData()` is **not** fully lazy: it calls `fetchRuntime()` unconditionally
on every tab switch. In addition:

- If the active tab is `overview` **and** `isStale('healthSnapshot')`, it also
  issues `fetchHealthSnapshot()`.
- It then delegates to `loadSubTabData(activeSubTab)` for the current sub-tab.

### `loadSubTabData(subTab)` — staleness-gated per-sub-tab fetches

Each sub-tab fetch is individually gated behind `isStale(key)`. A fetch only
fires if the key has not been loaded yet, or the last load was more than 30 s
ago. The guarded fetches are:

| Sub-tab | Guarded fetches |
|---|---|
| `wl-remote`, `infra-nodes`, `svc-deploys` | `remoteServiceStatuses`; `appSlots` (deploys only) |
| `infra-minecraft` | `minecraftStatuses` |
| `infra-gateway` | `piProxyStatus` |
| `svc-profiles` | `kulrsActivityStatus`, `ttsVoices`, `chatProviders` |
| `svc-agents` | `ttsVoices`, `chatProviders`, `workflows`, `jobsCatalog` |
| `svc-workflows` | `workflows`, `jobsCatalog` |
| `mon-health` | `healthSnapshot` |
| `mon-benchmarks` | `benchmarkRuns` |

When fetches are in-flight, `state.subTabLoading[subTab]` is `true`; page
renderers check this to show local spinners. `markLoaded(key)` stores a
timestamp in `state.dataLoaded` so subsequent `isStale()` checks are accurate.

Background refresh intervals are gated on the active tab and sub-tab so
inactive pages do not issue network requests.

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
3. `fetchRuntime()` is called on every tab activation — it is not lazy.
   Page-specific staleness-gated fetches in `loadSubTabData()` each fire only
   when `isStale(key)` is true (key absent or older than 30 s).
4. `state.dataLoaded` and `state.subTabLoading` — remain the single source
   of truth for staleness tracking and local spinners. `dataLoaded` stores
   load timestamps, not booleans; do not collapse them to flags.
5. Runtime summary, health snapshot, remote service / minecraft status,
   chat provider, TTS, and KULRS status refresh cadences and guards.
6. Form-to-config and raw JSON editor synchronization must remain
   bidirectional.
7. Backend routes and data contracts proxied by `admin-ui.ts` remain stable
   unless a coordinated change lands in `gateway-api` or
   `gateway-chat-platform`.

## Composition invariants

`renderAdminPage()` concatenates the three module outputs and appends
`ADMIN_DOCUMENT_FOOTER` (`</body>\n</html>`). The regression suite in
`tests/admin-ui.test.ts` enforces these guarantees:

1. **Golden-output comparison** — `tests/admin-ui.golden.html` is a
   committed snapshot of the full document rendered immediately after the
   modularization (407,325 bytes). The "golden" test compares future renders
   byte-for-byte against this file. Any change to `head.ts`, `markup.ts`,
   `script.ts`, or `index.ts` that alters the output will fail the golden
   test and require a deliberate fixture update (instructions are in the test
   file).
2. **Structural-tag uniqueness** — `<!doctype html>`, `<html>`, `<head>`,
   `</head>`, `<body>`, `</body>`, and `</html>` must each appear exactly once.
3. **Per-module hooks** — the tests also verify head interpolation, tab-shell
   presence, and client state invariants independently of the golden so
   targeted failures point at the right module.

To regenerate the golden after a deliberate content change, run the one-liner
in the golden test's comment block and commit the updated file.

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
