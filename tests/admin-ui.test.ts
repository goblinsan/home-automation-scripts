import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAdminPage, renderAdminHead, ADMIN_MARKUP, renderAdminScript } from '../src/lib/admin-ui/index.ts';

const BASE = '/admin/';
const FAVICON = 'data:image/svg+xml;utf8,TEST';
const SEED_PATH = '/test/workflow-seed.json';

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
  assert.ok(head.trimEnd().endsWith('</style>'));
});

test('ADMIN_MARKUP exposes the tab shell and shared action surface', () => {
  // The shell renderer in script.ts drives navigation off these stable hooks;
  // removing them would silently break lazy-load activation.
  assert.ok(ADMIN_MARKUP.startsWith('</head>\n<body>'), 'markup starts with </head><body>');
  assert.ok(ADMIN_MARKUP.includes('data-tab="overview"'), 'overview tab button present');
  assert.ok(ADMIN_MARKUP.includes('data-tab="workloads"'), 'workloads tab button present');
  assert.ok(ADMIN_MARKUP.includes('data-tab="secrets"'), 'secrets tab button present');
  assert.ok(ADMIN_MARKUP.includes('data-tab="infra"'), 'infrastructure tab button present');
  assert.ok(ADMIN_MARKUP.includes('data-tab="monitoring"'), 'monitoring tab button present');
  assert.ok(ADMIN_MARKUP.includes('id="actionFeed"'), 'shared action feed surface present');
  assert.ok(ADMIN_MARKUP.includes('id="currentAction"'), 'current action surface present');
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

  // Server-side seed path is injected rather than hard-coded.
  assert.ok(
    script.includes(`workflowSeedPath: '${SEED_PATH}'`),
    'defaultWorkflowSeedPath is interpolated into state defaults',
  );
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
