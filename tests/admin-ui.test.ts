import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderAdminPage, renderAdminHead, ADMIN_MARKUP, renderAdminScript } from '../src/lib/admin-ui/index.ts';

const BASE = '/admin/';
const FAVICON = 'data:image/svg+xml;utf8,TEST';
const SEED_PATH = '/test/workflow-seed.json';

// Inputs used to produce the committed golden file (tests/admin-ui.golden.html).
// These three values are intentionally different from BASE/FAVICON/SEED_PATH so
// the golden test exercises actual interpolation rather than incidentally matching.
const GOLDEN_BASE = '/admin/';
const GOLDEN_FAVICON = 'data:image/svg+xml;utf8,TEST-FAVICON';
const GOLDEN_SEED = '/test/workflow-seed.json';

function page(): string {
  return renderAdminPage({
    basePath: BASE,
    faviconDataUri: FAVICON,
    defaultWorkflowSeedPath: SEED_PATH,
  });
}

test('renderAdminHead interpolates basePath and favicon', () => {
  const head = renderAdminHead(BASE, FAVICON);
  assert.match(head, /^<!doctype html>/);
  assert.ok(head.includes(`<meta name="gateway-base-path" content="${BASE}" />`));
  assert.ok(head.includes(FAVICON));
  assert.ok(head.trimEnd().endsWith('</head>'), 'head ends with </head>');
  assert.ok(head.includes('</style>'), 'head contains the inline stylesheet');
});

test('ADMIN_MARKUP exposes the tab shell and shared action surface', () => {
  // The shell renderer in script.ts drives navigation off these stable hooks;
  // removing them would silently break lazy-load activation.
  assert.ok(ADMIN_MARKUP.startsWith('<body>'), 'markup starts with <body>');
  assert.ok(ADMIN_MARKUP.includes('data-tab="overview"'), 'overview tab button present');
  assert.ok(ADMIN_MARKUP.includes('data-tab="workloads"'), 'workloads tab button present');
  assert.ok(ADMIN_MARKUP.includes('data-tab="secrets"'), 'secrets tab button present');
  assert.ok(ADMIN_MARKUP.includes('data-tab="infra"'), 'infrastructure tab button present');
  assert.ok(ADMIN_MARKUP.includes('data-tab="monitoring"'), 'monitoring tab button present');
  assert.ok(ADMIN_MARKUP.includes('id="actionFeed"'), 'shared action feed surface present');
  assert.ok(ADMIN_MARKUP.includes('id="currentAction"'), 'current action surface present');
  assert.ok(ADMIN_MARKUP.includes('id="overviewProjectList"'), 'overview project tracking list present');
  assert.ok(ADMIN_MARKUP.includes('id="overviewProjectSummaryText"'), 'overview project summary surface present');
});

test('ADMIN_MARKUP exposes accessibility hooks for keyboard + screen reader operators', () => {
  // Skip-link target main-content, with focusable main landmark.
  assert.ok(ADMIN_MARKUP.includes('class="skip-link" href="#main-content"'), 'skip-link present');
  assert.ok(ADMIN_MARKUP.includes('id="main-content"'), 'main landmark id present');
  // Initially-active top-tab and sub-tab buttons advertise current state.
  assert.ok(
    ADMIN_MARKUP.includes('class="tab-button active" aria-current="page" data-nav-id="overview"'),
    'initial top-tab marks aria-current=page',
  );
  assert.ok(
    ADMIN_MARKUP.includes('aria-current="page" data-sub-tab="infra-gateway"'),
    'initial infra sub-tab marks aria-current=page',
  );
  // Icon-only header buttons get accessible names.
  assert.ok(ADMIN_MARKUP.includes('aria-label="Edit raw config JSON"'), 'gear button has aria-label');
  assert.ok(ADMIN_MARKUP.includes('aria-label="Restart control-plane container"'), 'restart button has aria-label');
  // Sub-tab nav landmarks are individually labeled.
  for (const label of ['Infrastructure sub-sections', 'Services sub-sections', 'Monitoring sub-sections', 'Workloads sub-sections']) {
    assert.ok(ADMIN_MARKUP.includes('aria-label="' + label + '"'), 'sub-tab nav labeled: ' + label);
  }
  // Header action toolbars carry role + label.
  assert.ok(ADMIN_MARKUP.includes('role="toolbar" aria-label="Global actions"'), 'global toolbar labeled');
});

test('renderAdminHead provides visible focus + responsive narrow-viewport rules', () => {
  const head = renderAdminHead(BASE, FAVICON);
  // Visible focus ring on interactive controls.
  assert.ok(head.includes(':focus-visible'), 'focus-visible rule present');
  assert.ok(head.includes('.skip-link'), 'skip-link styles present');
  // Active state alias for aria-current.
  assert.ok(head.includes('.top-tab-nav .tab-button[aria-current="page"]'), 'top-tab aria-current style');
  assert.ok(head.includes('.sub-tab-nav .sub-tab-button[aria-current="page"]'), 'sub-tab aria-current style');
  // Narrow-viewport responsive rules exist beyond the existing 980px breakpoint.
  assert.ok(head.includes('@media (max-width: 640px)'), 'narrow-viewport media query present');
});

test('renderAdminScript preserves critical state invariants', () => {
  const script = renderAdminScript({ defaultWorkflowSeedPath: SEED_PATH });
  assert.ok(script.trimStart().startsWith('<script>'));
  assert.ok(script.trimEnd().endsWith('</script>'));

  // Issue hardening guardrails: these invariants must survive modularization.
  assert.ok(script.includes('const state = {'), 'shared state object declared');
  assert.ok(script.includes('activeTab'), 'activeTab key present');
  assert.ok(script.includes('activeSubTabs'), 'activeSubTabs key present');
  assert.ok(script.includes('dataLoaded'), 'dataLoaded key present');
  assert.ok(script.includes('subTabLoading'), 'subTabLoading key present');
  assert.ok(script.includes('projectTrackingOverview'), 'project tracking overview state key present');

  // Server-side seed path is injected rather than hard-coded.
  assert.ok(
    script.includes(`workflowSeedPath: '${SEED_PATH}'`),
    'defaultWorkflowSeedPath is interpolated into state defaults',
  );

  // fetchRuntime() is called unconditionally on every tab activation; isStale()
  // guards apply only to health snapshot (via overview) and per-sub-tab data.
  assert.ok(script.includes('fetchRuntime()'), 'fetchRuntime unconditional call present');
  assert.ok(script.includes('isStale('), 'isStale staleness guard present for sub-tab data');
  assert.ok(script.includes('/api/project-tracking/overview'), 'project tracking overview fetch present');
});

test('renderAdminPage composes head + markup + script into a full document', () => {
  const html = page();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.endsWith('</body>\n</html>'));
  // The composed document must contain each page-level module output.
  assert.ok(html.includes(FAVICON));
  assert.ok(html.includes('data-tab="overview"'));
  assert.ok(html.includes('const state = {'));
});

test('composition does not double-emit structural tags', () => {
  const html = page();
  // These singletons should appear exactly once each.
  for (const tag of ['<!doctype html>', '<html lang="en">', '<head>', '</head>', '<body>', '</body>', '</html>']) {
    const count = html.split(tag).length - 1;
    assert.equal(count, 1, `expected exactly one ${tag}, got ${count}`);
  }
});

test('renderAdminPage output matches committed golden fixture', async () => {
  // This is the authoritative composition regression test. The golden file was
  // generated from the extracted modules immediately after the modularization
  // and committed alongside them. Any change to head.ts, markup.ts, script.ts,
  // or index.ts that alters the rendered output will fail here.
  //
  // To intentionally update the golden after a deliberate content change, run:
  //   node --experimental-strip-types -e "
  //     import { renderAdminPage } from './src/lib/admin-ui/index.ts';
  //     import { writeFile } from 'node:fs/promises';
  //     const html = renderAdminPage({
  //       basePath: '/admin/',
  //       faviconDataUri: 'data:image/svg+xml;utf8,TEST-FAVICON',
  //       defaultWorkflowSeedPath: '/test/workflow-seed.json',
  //     });
  //     await writeFile('tests/admin-ui.golden.html', html);
  //   "
  const goldenPath = join(dirname(fileURLToPath(import.meta.url)), 'admin-ui.golden.html');
  const expected = await readFile(goldenPath, 'utf8');
  const actual = renderAdminPage({
    basePath: GOLDEN_BASE,
    faviconDataUri: GOLDEN_FAVICON,
    defaultWorkflowSeedPath: GOLDEN_SEED,
  });
  assert.equal(actual.length, expected.length, 'golden: rendered length differs');
  assert.equal(actual, expected, 'golden: rendered content differs from committed fixture');
});
