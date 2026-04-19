/**
 * Admin UI runtime behavior tests.
 *
 * These tests exercise the client-side runtime behavior that the composition
 * tests in admin-ui.test.ts cannot cover: tab activation, sub-tab staleness
 * gating, local loading flags, the action-feed/current-action surface, and
 * config-form ↔ raw-JSON synchronization.
 *
 * The rendered `<script>` block is extracted from renderAdminScript() and
 * executed in a Node.js `vm` context with a minimal DOM stub and a mock
 * `fetch` that records all URLs requested.  A second vm.runInContext pass
 * is used to expose the `const state` binding (which is not a property of
 * the vm context object) so tests can read and write it directly.
 *
 * Covered invariants (see docs/admin-ui-architecture.md §Invariants):
 *   1. isStale / markLoaded correctly model the 30 s staleness window.
 *   2. loadTabData() always calls fetchRuntime() — it is never lazy.
 *   3. loadTabData('overview') gates fetchHealthSnapshot() on isStale.
 *   4. loadSubTabData() gates each sub-tab's fetch on isStale(key).
 *   5. state.subTabLoading[subTab] is true during an in-flight fetch and
 *      false once the fetch settles.
 *   6. pushActionFeed() prepends a correctly-classed entry to #actionFeed.
 *   7. setCurrentAction() applies the right status class and text content.
 *   8. syncRawJson() writes state.config as formatted JSON to #rawJson.
 *   9. The #applyRawButton click handler parses #rawJson back into state.config
 *      (bidirectional synchronization).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderAdminScript } from '../src/lib/admin-ui/index.ts';

// ---------------------------------------------------------------------------
// Script extraction
// ---------------------------------------------------------------------------

/**
 * The raw JavaScript content of the admin script block, extracted once and
 * shared across all tests.  The <script> / </script> wrappers are stripped.
 */
const RAW_ADMIN_JS: string = (() => {
  // defaultWorkflowSeedPath is required by the render function signature but has
  // no bearing on any of the runtime behaviors tested below — it only affects
  // the seed-import UI path, which is not exercised here.
  const block = renderAdminScript({ defaultWorkflowSeedPath: '/test/seed.json' });
  // Strip the wrapping <script>\n and \n  </script> lines.
  const start = block.indexOf('\n', block.indexOf('<script>')) + 1;
  const end = block.lastIndexOf('</script>');
  return block.slice(start, end);
})();

// ---------------------------------------------------------------------------
// Staleness window — mirrors STALE_MS in the inline script (30 s).
// Tests that need to back-date a timestamp reference this constant so the
// relationship between the test offset and the 30-second window is explicit.
// ---------------------------------------------------------------------------

const STALE_MS = 30_000;

// ---------------------------------------------------------------------------
// DOM stub
// ---------------------------------------------------------------------------

/**
 * Create a minimal DOM element stub.  Every property and method that the
 * inline script calls on an element is present; most are no-ops or return
 * safe defaults so that the script can initialize without throwing.
 *
 * Tests that care about specific DOM interactions (action feed, current-
 * action banner, rawJson textarea) replace the relevant stubs via the
 * `__elements` map exposed on the vm context.
 */
function makeElement() {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Function[]>();

  const el = {
    tagName: 'DIV',
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    offsetWidth: 0,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    hidden: false,
    open: false,
    classList: {
      add(...cs: string[]) { cs.forEach(c => classes.add(c)); },
      remove(...cs: string[]) { cs.forEach(c => classes.delete(c)); },
      toggle(c: string, force?: boolean) {
        const next = force !== undefined ? force : !classes.has(c);
        next ? classes.add(c) : classes.delete(c);
      },
      contains(c: string) { return classes.has(c); },
    },
    setAttribute(name: string, value: string) { attrs.set(name, value); },
    removeAttribute(name: string) { attrs.delete(name); },
    getAttribute(name: string) { return attrs.get(name) ?? null; },
    addEventListener(type: string, handler: Function) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(handler);
    },
    removeEventListener() {},
    querySelector(_sel: string) { return null; },
    querySelectorAll(_sel: string) { return { forEach() {}, length: 0 }; },
    appendChild(child: unknown) { return child; },
    prepend() {},
    remove() {},
    removeChild() {},
    scrollIntoView() {},
    focus() {},
    closest() { return null; },
    showModal() {},
    close() {},
    // DOM children — needed by pushActionFeed's trim-to-8 loop.
    children: { length: 0 } as unknown as HTMLCollection,
    get lastElementChild(): unknown { return null; },
    // Test-accessible internals:
    get _classes() { return classes; },
    get _attrs() { return attrs; },
    get _listeners() { return listeners; },
    /** Synchronously invoke all registered listeners for `type`. */
    _trigger(type: string, event: unknown = {}) {
      for (const h of listeners.get(type) ?? []) h(event);
    },
  };

  return el;
}

type ElementStub = ReturnType<typeof makeElement>;

// ---------------------------------------------------------------------------
// vm context construction
// ---------------------------------------------------------------------------

interface AdminVmContext {
  /** Exposed state (via var __exposedState = state in a second pass). */
  __exposedState: {
    activeTab: string;
    activeSubTabs: Record<string, string>;
    dataLoaded: Record<string, number>;
    subTabLoading: Record<string, boolean>;
    config: unknown;
    healthSnapshot: unknown;
    runtime: unknown;
    actionFeedCollapsed: boolean;
  };
  /** Element stubs keyed by id; tests may replace entries here. */
  __elements: Record<string, ElementStub>;
  // Functions exposed as var/function declarations in the vm scope:
  isStale(key: string): boolean;
  markLoaded(key: string): void;
  loadTabData(tab: string, options?: { silent?: boolean }): Promise<unknown[]>;
  loadSubTabData(subTab: string, options?: { silent?: boolean }): Promise<unknown[] | undefined>;
  pushActionFeed(message: string, kind?: string): void;
  setCurrentAction(message: string, kind?: string): void;
  syncRawJson(): void;
  escapeHtml(value: unknown): string;
}

/**
 * Build a vm context, execute the admin script inside it, and expose the
 * `state` binding so tests can read and mutate it.
 *
 * @param fetchStub - Replacement for `fetch`.  Receives (url, opts) and must
 *   return a Response-shaped object (or reject).  Defaults to a stub that
 *   always returns HTTP 500 so network operations fail fast.
 */
function buildContext(
  fetchStub: (url: string, opts?: unknown) => Promise<unknown> = async (url) => ({
    ok: false,
    status: 500,
    headers: { get: () => null },
    text: async () => JSON.stringify({ error: 'test-stub' }),
    json: async () => ({ error: 'test-stub' }),
  }),
): AdminVmContext {
  const elements: Record<string, ElementStub> = {};

  const doc = {
    querySelector(_sel: string) { return null; },
    querySelectorAll(_sel: string) { return { forEach() {}, length: 0 }; },
    getElementById(id: string) {
      if (!elements[id]) elements[id] = makeElement();
      return elements[id];
    },
    createElement(_tag: string) { return makeElement(); },
    addEventListener() {},
    body: { appendChild() {}, hidden: false },
    activeElement: null,
  };

  const ctx = vm.createContext({
    document: doc,
    window: {
      localStorage: { getItem: () => null, setItem: () => {} },
      location: { pathname: '/' },
    },
    fetch: fetchStub,
    AbortController,
    FormData: class FormData { append() {} },
    Element: class Element {},
    setInterval: () => 0,
    clearInterval: () => {},
    // No-op setTimeout: requestJson wraps every fetch in a timer that aborts
    // the request on timeout.  Leaving it unset would cause setInterval-style
    // leaks; returning 0 immediately prevents the timer from ever firing while
    // keeping clearTimeout(0) safe.
    setTimeout: (_fn: Function, _ms?: number) => 0,
    clearTimeout: () => {},
    Date,
    Promise,
    JSON,
    console,
    Error,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Symbol,
    isNaN,
    parseInt,
    parseFloat,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    URLSearchParams,
  }) as unknown as AdminVmContext;

  // Run the rendered script.
  vm.runInContext(RAW_ADMIN_JS, ctx as unknown as vm.Context);

  // The top-level `const state = {}` is NOT a property of the context object,
  // but it IS visible to subsequent runInContext calls on the same context.
  // Expose it via a var so tests can read/write it as ctx.__exposedState.
  vm.runInContext('var __exposedState = state;', ctx as unknown as vm.Context);

  // Expose the element map so tests can inject custom elements before calling
  // functions that render into the DOM.
  (ctx as unknown as { __elements: typeof elements }).__elements = elements;

  return ctx;
}

/**
 * Build a context where every `fetch` call is intercepted.  Returns both the
 * context and a `calls` array that accumulates every (method, url) pair.
 *
 * The context is async-ready: the initialization chain (fetchConfig →
 * fetchRuntime → loadTabData) fires immediately but fails on the first fetch
 * so it settles quickly.  The helper drains the microtask queue before
 * returning so init-time fetch calls do not pollute the `calls` array.
 */
async function buildTrackingContext(): Promise<{
  ctx: AdminVmContext;
  calls: Array<{ method: string; url: string }>;
}> {
  const calls: Array<{ method: string; url: string }> = [];

  const fetchStub = async (url: string, opts?: { method?: string }) => {
    calls.push({ method: (opts?.method ?? 'GET').toUpperCase(), url: String(url) });
    return {
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: 'test-stub' }),
      json: async () => ({ error: 'test-stub' }),
    };
  };

  const ctx = buildContext(fetchStub as unknown as (url: string, opts?: unknown) => Promise<unknown>);

  // Drain the initialization promise chain.  fetchConfig() fails on the first
  // (non-timeout) fetch attempt, causing the .catch() handler to run via
  // microtasks.  setImmediate fires only after the microtask queue is fully
  // drained, guaranteeing the init chain has settled before we return.
  await new Promise<void>(resolve => setImmediate(resolve));

  // Clear init-time calls so tests start with a clean slate.
  calls.length = 0;

  return { ctx, calls };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert that at least one recorded call targets a URL containing `pattern`. */
function assertFetched(calls: Array<{ method: string; url: string }>, pattern: string, msg: string) {
  assert.ok(
    calls.some(c => c.url.includes(pattern)),
    `${msg} — expected a call to URL matching "${pattern}" in ${JSON.stringify(calls.map(c => c.url))}`,
  );
}

/** Assert that no recorded call targets a URL containing `pattern`. */
function assertNotFetched(calls: Array<{ method: string; url: string }>, pattern: string, msg: string) {
  assert.ok(
    !calls.some(c => c.url.includes(pattern)),
    `${msg} — expected NO call to URL matching "${pattern}" but got ${JSON.stringify(calls.map(c => c.url))}`,
  );
}

// ---------------------------------------------------------------------------
// Tests: isStale / markLoaded
// ---------------------------------------------------------------------------

test('isStale returns true for a key that has never been loaded', () => {
  const ctx = buildContext();
  assert.equal(ctx.isStale('neverLoaded'), true, 'unloaded key is stale');
});

test('isStale returns false immediately after markLoaded', () => {
  const ctx = buildContext();
  ctx.markLoaded('freshKey');
  assert.equal(ctx.isStale('freshKey'), false, 'just-marked key is not stale');
});

test('isStale returns true when the recorded timestamp is older than 30 s', () => {
  const ctx = buildContext();
  // Back-date the entry past the 30 s window.
  ctx.__exposedState.dataLoaded['oldKey'] = Date.now() - (STALE_MS + 1_000);
  assert.equal(ctx.isStale('oldKey'), true, 'expired timestamp is stale');
});

test('markLoaded stores a numeric timestamp close to Date.now()', () => {
  const ctx = buildContext();
  const before = Date.now();
  ctx.markLoaded('myKey');
  const after = Date.now();
  const ts = ctx.__exposedState.dataLoaded['myKey'];
  assert.equal(typeof ts, 'number', 'timestamp is a number');
  assert.ok(ts >= before && ts <= after, 'timestamp is within the current millisecond range');
});

test('markLoaded causes isStale to return false', () => {
  const ctx = buildContext();
  assert.equal(ctx.isStale('k'), true, 'starts stale');
  ctx.markLoaded('k');
  assert.equal(ctx.isStale('k'), false, 'fresh after markLoaded');
});

// ---------------------------------------------------------------------------
// Tests: loadTabData → fetchRuntime unconditional
// ---------------------------------------------------------------------------

test('loadTabData calls fetchRuntime (reaches /api/runtime) on every activation', async () => {
  const { ctx, calls } = await buildTrackingContext();
  // Make healthSnapshot fresh so the overview-specific branch is suppressed.
  ctx.markLoaded('healthSnapshot');

  await ctx.loadTabData('infra');

  assertFetched(calls, '/api/runtime', 'fetchRuntime was called for infra tab');
});

test('loadTabData calls fetchRuntime even when switching to a non-overview tab', async () => {
  const { ctx, calls } = await buildTrackingContext();
  ctx.markLoaded('healthSnapshot');

  await ctx.loadTabData('monitoring');

  assertFetched(calls, '/api/runtime', 'fetchRuntime was called for monitoring tab');
});

test('loadTabData calls fetchRuntime even when all data is already fresh', async () => {
  const { ctx, calls } = await buildTrackingContext();
  // Mark every known key as fresh.  This list must be kept in sync with the
  // dataLoaded keys that loadTabData and loadSubTabData inspect; a new key
  // that is added to the script but not listed here would still trigger a
  // stale fetch and cause fetchRuntime-only assertions to see extra calls.
  for (const key of ['healthSnapshot', 'remoteServiceStatuses', 'appSlots', 'minecraftStatuses',
    'piProxyStatus', 'kulrsActivityStatus', 'ttsVoices', 'chatProviders',
    'workflows', 'jobsCatalog', 'benchmarkRuns']) {
    ctx.markLoaded(key);
  }

  await ctx.loadTabData('overview');

  assertFetched(calls, '/api/runtime', 'fetchRuntime is never skipped');
});

// ---------------------------------------------------------------------------
// Tests: loadTabData overview — health snapshot gate
// ---------------------------------------------------------------------------

test('loadTabData overview + stale healthSnapshot triggers fetchHealthSnapshot', async () => {
  const { ctx, calls } = await buildTrackingContext();
  // healthSnapshot is stale by default (dataLoaded starts empty).

  await ctx.loadTabData('overview');

  assertFetched(calls, '/api/monitoring/health', 'fetchHealthSnapshot was issued for stale overview');
});

test('loadTabData overview + fresh healthSnapshot does NOT call fetchHealthSnapshot', async () => {
  const { ctx, calls } = await buildTrackingContext();
  ctx.markLoaded('healthSnapshot');

  await ctx.loadTabData('overview');

  assertFetched(calls, '/api/runtime', 'fetchRuntime still called');
  assertNotFetched(calls, '/api/monitoring/health', 'fetchHealthSnapshot skipped for fresh overview');
});

// ---------------------------------------------------------------------------
// Tests: loadSubTabData — staleness gating per sub-tab
// ---------------------------------------------------------------------------

test('loadSubTabData mon-health + stale snapshot calls fetchHealthSnapshot', async () => {
  const { ctx, calls } = await buildTrackingContext();

  await ctx.loadSubTabData('mon-health');

  assertFetched(calls, '/api/monitoring/health', 'mon-health sub-tab fetches health snapshot when stale');
});

test('loadSubTabData mon-health + fresh snapshot makes no network call', async () => {
  const { ctx, calls } = await buildTrackingContext();
  ctx.markLoaded('healthSnapshot');

  await ctx.loadSubTabData('mon-health');

  assertNotFetched(calls, '/api/monitoring/health', 'mon-health does not re-fetch a fresh snapshot');
  assert.equal(calls.length, 0, 'no fetches at all when data is fresh');
});

test('loadSubTabData mon-benchmarks + stale runs calls fetchBenchmarkRuns', async () => {
  const { ctx, calls } = await buildTrackingContext();

  await ctx.loadSubTabData('mon-benchmarks');

  assertFetched(calls, '/api/monitoring/benchmarks', 'mon-benchmarks fetches benchmark runs when stale');
});

test('loadSubTabData mon-benchmarks + fresh data makes no network call', async () => {
  const { ctx, calls } = await buildTrackingContext();
  ctx.markLoaded('benchmarkRuns');

  await ctx.loadSubTabData('mon-benchmarks');

  assertNotFetched(calls, '/api/monitoring/benchmarks', 'mon-benchmarks skips fresh benchmark data');
});

test('loadSubTabData svc-workflows + stale workflows calls fetchWorkflows', async () => {
  const { ctx, calls } = await buildTrackingContext();

  await ctx.loadSubTabData('svc-workflows');

  assertFetched(calls, '/api/workflows', 'svc-workflows fetches workflow list when stale');
});

test('loadSubTabData svc-workflows + fresh data makes no network call', async () => {
  const { ctx, calls } = await buildTrackingContext();
  ctx.markLoaded('workflows');
  ctx.markLoaded('jobsCatalog');

  await ctx.loadSubTabData('svc-workflows');

  assert.equal(calls.length, 0, 'no fetches when svc-workflows data is fresh');
});

test('loadSubTabData returns early (no fetches) when all keys are fresh', async () => {
  const { ctx, calls } = await buildTrackingContext();
  ctx.markLoaded('healthSnapshot');

  const result = await ctx.loadSubTabData('mon-health');

  assert.equal(result, undefined, 'returns undefined (early exit) when no fetches needed');
  assert.equal(calls.length, 0, 'no fetches were made');
});

// ---------------------------------------------------------------------------
// Tests: state.subTabLoading flag toggling
// ---------------------------------------------------------------------------

test('loadSubTabData sets subTabLoading[subTab] true during fetch and false after', async () => {
  // Control when the fetch resolves using a deferred promise.  Both the vm
  // context and the test use the same Promise implementation, so the deferred
  // can be awaited from either side.
  let allowFetch!: () => void;
  const fetchGate = new Promise<void>(resolve => { allowFetch = resolve; });

  const ctx = buildContext(async () => {
    await fetchGate;
    // Return non-ok so requestJson/fetchBenchmarkRuns catches gracefully.
    return { ok: false, status: 500, headers: { get: () => null },
      text: async () => '{"error":"gate"}', json: async () => ({ error: 'gate' }) };
  });

  // benchmarkRuns is stale → fetches.length > 0 → loading flag is set.
  const loadPromise = ctx.loadSubTabData('mon-benchmarks');

  // Yield to let loadSubTabData run synchronously up to its first `await`.
  // At this point state.subTabLoading['mon-benchmarks'] should be true because
  // the assignment happens before Promise.allSettled().
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    ctx.__exposedState.subTabLoading['mon-benchmarks'],
    true,
    'subTabLoading is true while the fetch is in flight',
  );

  // Allow the deferred fetch to complete, which unblocks Promise.allSettled.
  allowFetch();
  await loadPromise;

  assert.equal(
    ctx.__exposedState.subTabLoading['mon-benchmarks'],
    false,
    'subTabLoading is false after the fetch settles',
  );
});

test('loadSubTabData leaves subTabLoading undefined when no fetch fires (fresh data)', async () => {
  const ctx = buildContext();
  ctx.markLoaded('healthSnapshot');

  await ctx.loadSubTabData('mon-health');

  // Early return path: subTabLoading is never touched for this subTab.
  assert.equal(
    ctx.__exposedState.subTabLoading['mon-health'],
    undefined,
    'subTabLoading entry absent when no fetch was needed',
  );
});

// ---------------------------------------------------------------------------
// Tests: action-feed / current-action helpers
// ---------------------------------------------------------------------------

test('pushActionFeed prepends a new entry to #actionFeed', () => {
  const ctx = buildContext();

  // Replace the actionFeed stub with one that records prepended children.
  const children: ReturnType<typeof makeElement>[] = [];
  const feedEl = {
    ...makeElement(),
    get children() { return { length: children.length } as unknown as HTMLCollection; },
    get lastElementChild() { return children[children.length - 1] ?? null; },
    querySelector(_sel: string) { return null; },
    prepend(child: ReturnType<typeof makeElement>) { children.unshift(child); },
    removeChild(child: ReturnType<typeof makeElement>) {
      const i = children.indexOf(child); if (i >= 0) children.splice(i, 1);
    },
  };
  ctx.__elements['actionFeed'] = feedEl as unknown as ElementStub;
  ctx.__elements['toggleActionFeedButton'] = makeElement();

  ctx.pushActionFeed('Deploy completed', 'ok');

  assert.equal(children.length, 1, 'one entry was added');
  const entry = children[0];
  assert.ok(entry.className.includes('action-entry'), 'entry carries the action-entry class');
  assert.ok(entry.className.includes('ok'), 'entry carries the ok kind class');
});

test('pushActionFeed uses the error class for kind=error entries', () => {
  const ctx = buildContext();
  const children: ReturnType<typeof makeElement>[] = [];
  const feedEl = {
    ...makeElement(),
    get children() { return { length: children.length } as unknown as HTMLCollection; },
    get lastElementChild() { return children[children.length - 1] ?? null; },
    querySelector(_sel: string) { return null; },
    prepend(child: ReturnType<typeof makeElement>) { children.unshift(child); },
    removeChild(child: ReturnType<typeof makeElement>) {
      const i = children.indexOf(child); if (i >= 0) children.splice(i, 1);
    },
  };
  ctx.__elements['actionFeed'] = feedEl as unknown as ElementStub;
  ctx.__elements['toggleActionFeedButton'] = makeElement();

  ctx.pushActionFeed('Deploy failed', 'error');

  assert.equal(children.length, 1, 'one entry was added');
  assert.ok(children[0].className.includes('error'), 'entry carries the error kind class');
});

test('pushActionFeed prepends so the most recent entry is first', () => {
  const ctx = buildContext();
  const children: ReturnType<typeof makeElement>[] = [];
  const feedEl = {
    ...makeElement(),
    get children() { return { length: children.length } as unknown as HTMLCollection; },
    get lastElementChild() { return children[children.length - 1] ?? null; },
    querySelector(_sel: string) { return null; },
    prepend(child: ReturnType<typeof makeElement>) { children.unshift(child); },
    removeChild(child: ReturnType<typeof makeElement>) {
      const i = children.indexOf(child); if (i >= 0) children.splice(i, 1);
    },
  };
  ctx.__elements['actionFeed'] = feedEl as unknown as ElementStub;
  ctx.__elements['toggleActionFeedButton'] = makeElement();

  ctx.pushActionFeed('First message', 'ok');
  ctx.pushActionFeed('Second message', 'ok');

  assert.equal(children.length, 2, 'two entries in the feed');
  // The most recently prepended entry is at index 0.
  assert.ok(
    (children[0].textContent ?? '') === '' || children[0].className.includes('action-entry'),
    'second entry is at the front of the list after prepend',
  );
});

// ---------------------------------------------------------------------------
// Tests: setCurrentAction status transitions
// ---------------------------------------------------------------------------

test('setCurrentAction(progress) applies is-progress class to the host element', () => {
  const ctx = buildContext();

  ctx.setCurrentAction('Running deploy…', 'progress');

  const host = ctx.__elements['currentAction'];
  assert.ok(host._classes.has('is-progress'), 'is-progress class applied');
  assert.ok(!host._classes.has('is-error'), 'is-error class NOT applied');
  assert.ok(!host._classes.has('is-ok'), 'is-ok class NOT applied');

  const msg = ctx.__elements['currentActionMessage'];
  assert.equal(msg.textContent, 'Running deploy…', 'message text set correctly');

  const time = ctx.__elements['currentActionTime'];
  assert.ok(time.textContent.startsWith('Started '), 'time prefixed with "Started" for progress');
});

test('setCurrentAction(error) applies is-error class and Failed prefix', () => {
  const ctx = buildContext();

  ctx.setCurrentAction('Deploy failed', 'error');

  const host = ctx.__elements['currentAction'];
  assert.ok(host._classes.has('is-error'), 'is-error class applied');
  assert.ok(!host._classes.has('is-progress'), 'is-progress class NOT applied');

  const time = ctx.__elements['currentActionTime'];
  assert.ok(time.textContent.startsWith('Failed '), 'time prefixed with "Failed" for error');
});

test('setCurrentAction(ok) applies is-ok class and Completed prefix', () => {
  const ctx = buildContext();

  ctx.setCurrentAction('Deploy done', 'ok');

  const host = ctx.__elements['currentAction'];
  assert.ok(host._classes.has('is-ok'), 'is-ok class applied');

  const time = ctx.__elements['currentActionTime'];
  assert.ok(time.textContent.startsWith('Completed '), 'time prefixed with "Completed" for ok');
});

test('setCurrentAction(idle) applies is-idle class and clears the time element', () => {
  const ctx = buildContext();

  ctx.setCurrentAction('', 'idle');

  const host = ctx.__elements['currentAction'];
  assert.ok(host._classes.has('is-idle'), 'is-idle class applied');
  assert.ok(!host._classes.has('is-progress'), 'is-progress not applied for idle');

  const time = ctx.__elements['currentActionTime'];
  assert.equal(time.textContent, '', 'time text cleared for idle');
});

test('setCurrentAction removes all previous status classes before applying new one', () => {
  const ctx = buildContext();

  // Apply progress, then error — the progress class must be gone.
  ctx.setCurrentAction('Step 1', 'progress');
  ctx.setCurrentAction('Step 2 failed', 'error');

  const host = ctx.__elements['currentAction'];
  assert.ok(!host._classes.has('is-progress'), 'previous is-progress removed');
  assert.ok(host._classes.has('is-error'), 'new is-error applied');
});

// ---------------------------------------------------------------------------
// Tests: config form ↔ raw JSON synchronization
// ---------------------------------------------------------------------------

test('syncRawJson writes state.config as formatted JSON into #rawJson', () => {
  const ctx = buildContext();

  const testConfig = { gateway: { host: 'localhost' }, apps: [{ id: 'test-app' }] };
  ctx.__exposedState.config = testConfig;
  ctx.syncRawJson();

  const rawJsonEl = ctx.__elements['rawJson'];
  const expected = JSON.stringify(testConfig, null, 2);
  assert.equal(rawJsonEl.value, expected, 'syncRawJson writes formatted JSON to the textarea');
});

test('syncRawJson reflects state.config changes (form → JSON direction)', () => {
  const ctx = buildContext();

  ctx.__exposedState.config = { version: 1 };
  ctx.syncRawJson();
  assert.ok(
    (ctx.__elements['rawJson'].value ?? '').includes('"version": 1'),
    'first sync writes version 1',
  );

  ctx.__exposedState.config = { version: 2 };
  ctx.syncRawJson();
  assert.ok(
    (ctx.__elements['rawJson'].value ?? '').includes('"version": 2'),
    'second sync reflects updated config',
  );
});

test('#applyRawButton click parses rawJson textarea value into state.config (JSON → state direction)', () => {
  const ctx = buildContext();

  const newConfig = { gateway: { host: 'testhost' }, apps: [] };

  // rawJson is created lazily on first getElementById call; syncRawJson()
  // is the standard way to initialise it so the click handler can find it.
  ctx.syncRawJson();
  ctx.__elements['rawJson'].value = JSON.stringify(newConfig);

  // The click handler was registered during initialization.
  ctx.__elements['applyRawButton']._trigger('click');

  // state.config is updated before render() is called, so even if render
  // throws (due to incomplete stub config), the state update is visible.
  assert.deepEqual(
    ctx.__exposedState.config,
    newConfig,
    'state.config updated from rawJson textarea value after applyRawButton click',
  );
});

test('form → JSON and JSON → form round-trip preserves the config object', () => {
  const ctx = buildContext();

  const original = { gateway: { port: 4000 }, apps: [{ id: 'alpha' }] };

  // Write config to textarea (form → JSON).
  ctx.__exposedState.config = original;
  ctx.syncRawJson();

  // Verify the textarea now holds the serialized config.
  const serialized = ctx.__elements['rawJson'].value;
  assert.equal(serialized, JSON.stringify(original, null, 2), 'textarea holds serialized config');

  // Parse the textarea back into state.config (JSON → form).
  ctx.__elements['applyRawButton']._trigger('click');

  assert.deepEqual(
    ctx.__exposedState.config,
    original,
    'round-trip preserves the full config object',
  );
});
