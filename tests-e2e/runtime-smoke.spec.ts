import { expect, test } from '@playwright/test';

// Issue 97 — browser-level runtime smoke/e2e coverage.
//
// This spec runs in every Playwright project declared in
// `playwright.config.ts` (chromium / firefox / webkit — same matrix
// as the ADR-030 / PUL-Q002 browser-support gate) and extends the
// existing `tests-e2e/browser-support.spec.ts` and
// `tests-e2e/dom-css-accessibility.spec.ts` coverage with three
// scenarios issue 97 names but the prior specs do not cover:
//
//   A. Default route (`/`) — no `scene`, no `composition`, no `mode`.
//      The locator parses to `kind: 'none'` (ADR-013), so no scene
//      mounts. The test proves the workbench shell still boots
//      cleanly and captures + inspects an element-level stage
//      screenshot.
//
//   B. Composition route (`?composition=default&mode=paused`) — the
//      default composition resolves to its first scene (ADR-014).
//      The test proves the composition path runs and captures an
//      element-level stage screenshot at the held timeline frame.
//
//   C. Mode-specific route + screenshot blank-stage check
//      (`?scene=browser-support-fixture&mode=loop`) — the fixture
//      scene mounts a `<div data-pulsar-fixture-target>` and runs a
//      real GSAP timeline that flips its
//      `data-pulsar-fixture-state` to `"ran"`. The test asserts the
//      fixture mounts as a descendant of `#stage`, reaches the
//      `"ran"` state, has a non-zero bounding rect, AND its
//      element-level `#stage` screenshot differs byte-for-byte from
//      the default-route's stage screenshot taken in the same
//      engine. The byte comparison is the mechanical blank-stage
//      regression guard: two screenshots produced by the SAME engine
//      with identical viewport/encoder settings can only differ when
//      the fixture rendered visible content the default route did
//      not. A regression that quietly stopped mounting the fixture
//      element OR stopped applying its state attribute would collapse
//      the two captures into byte-identical output and fail the
//      assertion.
//
// CSS injection: the production build ships no CSS yet (no
// `index.html` `<link>`, no `import './*.css'` in `src/main.ts`).
// Element screenshots and bounding-box checks need positive layout
// dimensions, so each test injects a small test-only stylesheet via
// `page.addStyleTag({ content: SMOKE_TEST_CSS })` AFTER the
// runtime has finished bootstrapping (`page.goto` resolves on the
// `load` event, after `type="module"` evaluation completes). The
// styling is harness instrumentation only — it does not exist in
// `src/*`, does not depend on or alter any runtime contract, and is
// strictly visual so the smoke layer has real pixels to inspect.
// Per `docs/design/issue-097-browser-runtime-smoke-preflight.md`,
// this is not baseline snapshot management (no committed baseline
// images; comparison is between two same-engine captures from the
// same test run).
//
// Scope per `docs/design/issue-097-browser-runtime-smoke-preflight.md`:
// reuse the existing observables, the existing Playwright project
// matrix, the existing `pnpm test:browsers` command, and the
// existing `browser-support` CI job. Do not add baseline visual
// regression, new runtime attributes, a parallel runner, or any
// scene/composition/registry change.

const DEFAULT_ROUTE = '/';
const COMPOSITION_ROUTE = '/?composition=default&mode=paused';
const FIXTURE_ROUTE = '/?scene=browser-support-fixture&mode=loop';

// Test-only viewport styling injected via `page.addStyleTag()`. The
// production runtime ships no CSS; this stylesheet exists solely so
// `#stage` has positive layout dimensions and the fixture's mount
// element has a visible box. Both numbers are intentionally fixed
// (200×200 red on a 100vh white stage) so a same-engine byte
// comparison between the default route (empty white stage) and the
// fixture route (white stage with a 200×200 red box at top-left)
// has a deterministic visible delta.
const SMOKE_TEST_CSS = `
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body { min-height: 100vh; }
  #stage {
    display: block;
    width: 100%;
    height: 100vh;
    background: #ffffff;
  }
  [data-pulsar-fixture-target] {
    display: block;
    width: 200px;
    height: 200px;
    background: #ff0000;
  }
`;

const STAGE_SCREENSHOT_TIMEOUT_MS = 5_000;

test.describe('issue 97 — browser runtime smoke coverage', () => {
  test('default route boots the workbench shell with no addressed scene', async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(DEFAULT_ROUTE);
    await page.addStyleTag({ content: SMOKE_TEST_CSS });

    const stage = page.locator('#stage');
    await expect(stage, 'the workbench stage element must mount').toBeAttached();

    // `src/main.ts` sets `data-pulsar="placeholder"` synchronously
    // during bootstrap (before navigation parsing). Its presence
    // proves the entry module evaluated end-to-end on this engine —
    // if Vite preview served the build but the JS failed to execute,
    // this attribute would be absent and the test would fail loud.
    await expect(
      stage,
      'src/main.ts must have evaluated and tagged #stage with data-pulsar="placeholder"',
    ).toHaveAttribute('data-pulsar', 'placeholder');

    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);

    await expect(
      stage,
      'the URL grammar parser must accept the empty search string (no data-pulsar-navigation-error)',
    ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);

    // ADR-013 / `resolveSceneNavigation`: a `kind: 'none'` locator
    // never enters the scene-mount path. The loader returns before
    // writing `data-pulsar-scene-target`, so the default route is
    // observably "shell only" — the assertion proves the default
    // route did NOT silently mount a scene the URL did not address.
    await expect(
      stage,
      'kind: "none" locator must not mount a scene on the default route',
    ).not.toHaveAttribute('data-pulsar-scene-target', /.*/);
    await expect(
      stage,
      'kind: "none" locator must not advance the scene lifecycle on the default route',
    ).not.toHaveAttribute('data-pulsar-scene-lifecycle', /.*/);
    await expect(
      stage,
      'kind: "none" locator must not write a composition target on the default route',
    ).not.toHaveAttribute('data-pulsar-composition-target', /.*/);

    // PUL-F031 / ADR-031: the chrome surface is mounted at workbench
    // bootstrap (before `bootstrapNavigation`) and persists across
    // every navigation. Effective mode on the default route is
    // `present` (ADR-007 default), and `chromeVisibilityFor('present')`
    // maps to `'visible'` — assert both the marker element AND its
    // visibility attribute so a regression that mounts an empty
    // chrome root or fails to apply the mode is caught.
    const chrome = page.locator('[data-pulsar-chrome="surface"]');
    await expect(chrome, 'PUL-F031 chrome surface must mount').toBeAttached();
    await expect(
      chrome,
      'effective mode `present` must map to chrome visibility `visible`',
    ).toHaveAttribute('data-pulsar-chrome-visibility', 'visible');

    expect(errors, 'no uncaught exceptions or console errors during the run').toEqual([]);

    // Capture + attach an element-level stage screenshot for
    // diagnostic review. The same capture is used by the fixture
    // test (case C) as the baseline for byte-comparison; the
    // injected CSS guarantees the stage has positive dimensions so
    // the screenshot operation always succeeds.
    const stagePng = await stage.screenshot({ timeout: STAGE_SCREENSHOT_TIMEOUT_MS });
    await testInfo.attach('stage-default-route.png', {
      body: stagePng,
      contentType: 'image/png',
    });
  });

  test('?composition=default route resolves the default composition', async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(COMPOSITION_ROUTE);
    await page.addStyleTag({ content: SMOKE_TEST_CSS });

    const stage = page.locator('#stage');
    await expect(stage, 'the workbench stage element must mount').toBeAttached();
    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);
    await expect(
      stage,
      'the URL grammar parser must accept ?composition=default&mode=paused (no data-pulsar-navigation-error)',
    ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);

    // ADR-014 + `composition-resolver`: a `kind: 'composition'`
    // locator resolves through the composition registry to its first
    // scene. The default composition (`src/compositions/default.ts`)
    // is `['placeholder']`, so the loader writes BOTH the composition
    // and scene target attributes on `#stage`. A regression that
    // dropped the composition target write (e.g. an early return in
    // the loader) would surface here.
    await expect(
      stage,
      'the loader must write data-pulsar-composition-target for the resolved composition',
    ).toHaveAttribute('data-pulsar-composition-target', 'default');
    await expect(
      stage,
      "the resolver must mount the composition's first scene (placeholder)",
    ).toHaveAttribute('data-pulsar-scene-target', 'placeholder');

    // The placeholder scene runs `create(ctx)` then `timeline(ctx)`
    // (its empty timeline still flips the lifecycle marker). Under
    // `mode=paused` the master timeline holds at first frame, so the
    // lifecycle marker stays at `timeline` durably — same pattern
    // the existing browser-support shell-coverage assertion uses.
    await expect(
      stage,
      "the placeholder scene's create and timeline hooks must run end-to-end under the composition path",
    ).toHaveAttribute('data-pulsar-scene-lifecycle', 'timeline');

    // Chrome stays visible under `mode=paused` (preflight policy:
    // only `standalone` and `screenshot` suppress chrome). Assert
    // the marker so a regression that flipped paused into a
    // chrome-suppressing mode is caught here, not just in the unit
    // tests.
    const chrome = page.locator('[data-pulsar-chrome="surface"]');
    await expect(chrome, 'PUL-F031 chrome surface must mount').toBeAttached();
    await expect(chrome, 'mode=paused must keep chrome visible').toHaveAttribute(
      'data-pulsar-chrome-visibility',
      'visible',
    );

    expect(errors, 'no uncaught exceptions or console errors during the run').toEqual([]);

    const stagePng = await stage.screenshot({ timeout: STAGE_SCREENSHOT_TIMEOUT_MS });
    await testInfo.attach('stage-composition-route.png', {
      body: stagePng,
      contentType: 'image/png',
    });
  });

  test('fixture route renders non-blank stage and stage screenshot differs from default route', async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    // Capture the default-route stage first — it's the baseline for
    // the byte-comparison below. The two captures run inside the
    // same `page` so the engine, viewport, encoder settings, and
    // injected CSS are identical; the only legitimate variable is
    // which route was rendered. Engine-specific PNG encoder bias
    // cannot bias the comparison because it would bias both
    // captures identically.
    await page.goto(DEFAULT_ROUTE);
    await page.addStyleTag({ content: SMOKE_TEST_CSS });
    const stage = page.locator('#stage');
    await expect(
      stage,
      'the workbench stage element must mount on the default route',
    ).toBeAttached();
    await expect(
      stage,
      'PUL-F028 boot validation must succeed on the default route (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);
    const defaultPng = await stage.screenshot({ timeout: STAGE_SCREENSHOT_TIMEOUT_MS });
    await testInfo.attach('stage-default-baseline.png', {
      body: defaultPng,
      contentType: 'image/png',
    });

    // Now navigate to the fixture route — the GSAP-running fixture.
    // Re-inject the harness stylesheet (a `page.goto` to a new URL
    // tears down the previous document, taking the previously
    // injected style tag with it).
    await page.goto(FIXTURE_ROUTE);
    await page.addStyleTag({ content: SMOKE_TEST_CSS });
    await expect(
      stage,
      'the workbench stage element must mount on the fixture route',
    ).toBeAttached();
    await expect(
      stage,
      'PUL-F028 boot validation must succeed on the fixture route (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);
    await expect(
      stage,
      'the URL grammar parser must accept ?scene=browser-support-fixture&mode=loop (no data-pulsar-navigation-error)',
    ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);
    await expect(stage, 'the resolver must have mounted the fixture scene').toHaveAttribute(
      'data-pulsar-scene-target',
      'browser-support-fixture',
    );

    // Fixture-mount assertion: the scene's `create(ctx)` appended a
    // `<div data-pulsar-fixture-target>` AS A CHILD of `#stage`.
    // Asserting the descendant relationship — not just attachment
    // somewhere in the document — is the topology guard: a
    // regression that mounted the fixture outside the stage subtree
    // (or skipped the mount entirely) surfaces here.
    const fixture = stage.locator('[data-pulsar-fixture-target]');
    await expect(
      fixture,
      'the fixture element must be a descendant of #stage (blank-stage regression: fixture failed to mount under the stage)',
    ).toBeAttached();

    // Layout guard: under the injected harness CSS the fixture is
    // styled `200×200`, so a bounding rect that came back zero would
    // mean either the fixture element is `display: none`, was moved
    // outside the layout tree, or the runtime stopped appending it.
    // `boundingBox()` returns null for off-layout elements; assert
    // non-null first so the failure message is actionable.
    const box = await fixture.boundingBox();
    expect(box, 'the fixture element must have a non-null bounding box').not.toBeNull();
    if (box === null) return;
    expect(
      box.width,
      'fixture bounding box width must be > 0 (blank-stage layout guard)',
    ).toBeGreaterThan(0);
    expect(
      box.height,
      'fixture bounding box height must be > 0 (blank-stage layout guard)',
    ).toBeGreaterThan(0);

    // The GSAP timeline's terminal `.call(...)` advances the fixture
    // state attribute to `"ran"`. Under `mode=loop` (ADR-018) the
    // master timeline restarts on natural completion, so the
    // attribute stays `"ran"` durably — same race-free pattern the
    // existing `browser-support.spec.ts` second test uses.
    await expect(
      fixture,
      'the fixture GSAP timeline must advance the state attribute to "ran"',
    ).toHaveAttribute('data-pulsar-fixture-state', 'ran');

    // PUL-F031 / ADR-031 symmetry with cases A and B: `mode=loop`
    // maps to `chromeVisibilityFor` → `'visible'`. Asserting the
    // chrome marker AND its visibility attribute here gives the e2e
    // matrix end-to-end coverage of chrome under `mode=loop` —
    // unit tests cover the pure function, but a regression in the
    // `loop` switch arm (accidentally returning `'hidden'`, dropping
    // the `loop` arm entirely) would otherwise only fail at the unit
    // level, not at the full browser bootstrap level the smoke suite
    // exercises.
    const chrome = page.locator('[data-pulsar-chrome="surface"]');
    await expect(chrome, 'PUL-F031 chrome surface must mount on the fixture route').toBeAttached();
    await expect(chrome, 'mode=loop must keep chrome visible').toHaveAttribute(
      'data-pulsar-chrome-visibility',
      'visible',
    );

    const fixturePng = await stage.screenshot({ timeout: STAGE_SCREENSHOT_TIMEOUT_MS });
    await testInfo.attach('stage-fixture-route.png', {
      body: fixturePng,
      contentType: 'image/png',
    });

    // Mechanical blank-stage guard: two `#stage` screenshots taken
    // from the same engine + viewport + injected CSS can only differ
    // when the rendered DOM differs. The default route paints the
    // stage white; the fixture route paints the same white stage
    // PLUS a 200×200 red fixture box at top-left. Byte-identical
    // captures would mean the fixture rendered nothing inside the
    // stage subtree — the issue 97 acceptance criterion 5
    // blank-stage regression mode. This is NOT a baseline snapshot;
    // the comparison is intra-run between two captures taken
    // moments apart in the same engine, so no checked-in baseline
    // image and no committed `*-snapshots/` directory is required.
    expect(
      Buffer.from(fixturePng).equals(Buffer.from(defaultPng)),
      'fixture-route stage screenshot must differ from default-route stage screenshot (blank-stage regression guard)',
    ).toBe(false);

    expect(errors, 'no uncaught exceptions or console errors during the run').toEqual([]);
  });
});
