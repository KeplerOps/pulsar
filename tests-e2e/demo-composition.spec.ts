import { expect, test } from '@playwright/test';

// Issue 98 — demo composition browser/e2e coverage.
//
// This spec runs in every Playwright project declared in
// `playwright.config.ts` (chromium / firefox / webkit — same matrix
// as the PUL-Q002 / ADR-030 browser-support gate and the issue 97
// runtime-smoke suite). It boots the demo composition through the
// existing workbench URL grammar (`?composition=demo&mode=paused`)
// against the production build (`pnpm preview`) and verifies:
//
//   1. The URL resolves: `data-pulsar-composition-target="demo"` and
//      `data-pulsar-scene-target="demo-title"` appear on `#stage`,
//      validation/navigation error attributes do NOT, and the scene
//      lifecycle reaches the `timeline` phase.
//
//   2. The demo composition's declared static asset is actually
//      served by the production build. The codex preflight at
//      `docs/design/issue-098-vertical-slice-demo-preflight.md` is
//      explicit that bare root-relative asset paths bypass the
//      preloader's scheme validation, so a browser/e2e check or
//      fetch-backed runtime test is the only way to prove
//      "the committed path is actually served" — without this
//      assertion a future deletion of `public/assets/demo/` would
//      ship silently because the static validation pass cannot
//      catch it. We HEAD the asset URL via `page.request` (no DOM
//      involvement) and check the response is 200 with an SVG
//      content type.
//
//   3. The feature scene's `<img>` element loads the declared asset:
//      under `?composition=demo&scene=demo-feature&mode=paused` the
//      slice mounts the feature scene, its `<img data-pulsar-demo-
//      feature-img>` is attached as a descendant of `#stage` with
//      the documented `src`, and its `naturalWidth` is non-zero
//      (proves the browser actually loaded the resource, not just
//      that the element exists). The PUL-F031 chrome surface is
//      asserted visible under `mode=paused` per the existing chrome
//      visibility map.
//
// CSS injection: the production build ships no CSS yet, so
// `#stage` and the demo `<img>` need positive layout dimensions for
// the bounding-box check to be meaningful. We inject the same
// minimal harness stylesheet pattern `tests-e2e/runtime-smoke.spec.ts`
// uses (page-local, via `page.addStyleTag()`, no committed
// baselines, no production CSS changed).
//
// Scope per the preflight: reuse the existing observables and
// browser project matrix; do not add baseline snapshots, new
// runtime attributes, or scene/composition/registry surfaces beyond
// what issue 98 wires.

const COMPOSITION_PAUSED = '/?composition=demo&mode=paused';
const FEATURE_SCENE_PAUSED = '/?composition=demo&scene=demo-feature&mode=paused';
const ASSET_PATH = '/assets/demo/pulsar-mark.svg';

const DEMO_TEST_CSS = `
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body { min-height: 100vh; }
  #stage {
    display: block;
    width: 100%;
    height: 100vh;
    background: #ffffff;
  }
  [data-pulsar-demo-feature-img] {
    display: block;
    width: 200px;
    height: 200px;
  }
`;

test.describe('issue 98 — demo composition reachable and served', () => {
  test('boots ?composition=demo&mode=paused and resolves the demo slice head', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(COMPOSITION_PAUSED);
    await page.addStyleTag({ content: DEMO_TEST_CSS });

    const stage = page.locator('#stage');
    await expect(stage, 'the workbench stage element must mount').toBeAttached();
    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);
    await expect(
      stage,
      'the URL grammar parser must accept ?composition=demo&mode=paused (no data-pulsar-navigation-error)',
    ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);
    await expect(
      stage,
      'the loader must write data-pulsar-composition-target for the resolved demo composition',
    ).toHaveAttribute('data-pulsar-composition-target', 'demo');
    await expect(
      stage,
      "the resolver must mount the demo composition's first scene (demo-title)",
    ).toHaveAttribute('data-pulsar-scene-target', 'demo-title');

    // The demo scenes intentionally do NOT write `data-pulsar-scene-
    // lifecycle` — that marker is a per-scene authoring convention the
    // placeholder / dom-css-accessibility-fixture scenes happen to use,
    // not a runtime guarantee. The loader-emitted `data-pulsar-scene-
    // target` (asserted above) proves the resolver mounted the right
    // scene; the scene-root locator below proves `create(ctx)` ran
    // end-to-end and produced the expected DOM. Asserting only what
    // each scene actually emits keeps this spec honest if a future
    // demo scene picks different private DOM markers.
    const root = page.locator('[data-pulsar-demo-scene="demo-title"]');
    await expect(
      root,
      'the demo-title scene root must mount as a descendant of #stage',
    ).toBeAttached();
    await expect(
      root.locator('[data-pulsar-demo-title]'),
      'the demo-title heading must mount inside the scene root',
    ).toBeAttached();

    const chrome = page.locator('[data-pulsar-chrome="surface"]');
    await expect(chrome, 'PUL-F031 chrome surface must mount').toBeAttached();
    await expect(chrome, 'mode=paused must keep chrome visible').toHaveAttribute(
      'data-pulsar-chrome-visibility',
      'visible',
    );

    expect(errors, 'no uncaught exceptions or console errors during boot').toEqual([]);
  });

  test('the declared static asset path is served by the production build', async ({ page }) => {
    // HEAD the asset directly through Playwright's request context.
    // The production build (Vite preview, port 4173) serves
    // `public/assets/demo/pulsar-mark.svg` at the root path
    // `/assets/demo/pulsar-mark.svg`. Without this check, a future
    // deletion of `public/assets/demo/` would ship silently because
    // the workbench-graph validator pass accepts bare root-relative
    // paths without contacting any server.
    const response = await page.request.get(ASSET_PATH);
    expect(response.status(), 'static asset must be served by the production build').toBe(200);
    const contentType = response.headers()['content-type'] ?? '';
    expect(contentType, 'static asset must be served with an SVG content type').toMatch(
      /image\/svg\+xml/,
    );
    const body = await response.body();
    expect(body.byteLength, 'static asset must have non-zero body').toBeGreaterThan(0);
  });

  test('demo-feature scene mounts its <img> element pointing at the served asset', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(FEATURE_SCENE_PAUSED);
    await page.addStyleTag({ content: DEMO_TEST_CSS });

    const stage = page.locator('#stage');
    await expect(stage).toBeAttached();
    await expect(stage).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);
    await expect(stage).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);
    await expect(
      stage,
      'addressing a member scene must mount it as the slice head',
    ).toHaveAttribute('data-pulsar-scene-target', 'demo-feature');

    const root = stage.locator('[data-pulsar-demo-scene="demo-feature"]');
    await expect(
      root,
      'the demo-feature scene root must mount as a descendant of #stage',
    ).toBeAttached();

    const img = root.locator('[data-pulsar-demo-feature-img]');
    await expect(
      img,
      'the feature image must mount as a descendant of the scene root',
    ).toBeAttached();
    await expect(img, 'the feature image must point at the declared asset URL').toHaveAttribute(
      'src',
      ASSET_PATH,
    );

    // `naturalWidth > 0` proves the browser actually decoded the
    // resource: a 404 (silent regression on the public asset
    // pipeline) would surface as `naturalWidth === 0` while every
    // DOM-attribute assertion above still passed.
    const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(
      naturalWidth,
      'the demo asset must load (non-zero naturalWidth proves the browser fetched and decoded it)',
    ).toBeGreaterThan(0);

    expect(errors, 'no uncaught exceptions or console errors during boot').toEqual([]);
  });

  test('present-mode boots the demo composition and starts master playback', async ({ page }) => {
    // `?composition=demo` (default mode = present per ADR-007) drives
    // the full slice through the production GSAP master timeline.
    // `mode=paused` intentionally truncates a composition slice to
    // the addressed head scene (`src/runtime/scene-navigation.ts`
    // `truncateToHead`), so the paused-mode test above only proves
    // demo-title can mount. THIS test covers the seam codex flagged
    // as missing from the prior pass (cycle 1): under the production
    // composition path EVERY demo scene mounts before adapter
    // playback (PUL-F004 mount-then-play, ADR-025), and the head
    // scene's own timeline activates its root when the master starts
    // playing.
    //
    // The runtime-boundary unit test
    // (`tests/runtime/demo-composition.test.ts` — "runs the full
    // slice end-to-end through the production GSAP timeline
    // adapter") drives `createGsapCompositionTimeline` across the
    // whole slice and waits for `loadSceneNavigationTarget` to
    // resolve. That `await` only completes when the master fires
    // `onComplete` and the resolver finishes the cleanup phase, so
    // sequential playback + reverse cleanup is already pinned there.
    // This browser test stays focused on what a polling browser
    // assertion can prove without racing GSAP's tween-boundary
    // behavior across engines: every scene root is present (mount-
    // then-play) and master playback has actually started (head
    // activation).
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/?composition=demo');
    await page.addStyleTag({ content: DEMO_TEST_CSS });

    const stage = page.locator('#stage');
    await expect(stage).toBeAttached();
    await expect(stage).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);
    await expect(stage).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);
    await expect(stage).toHaveAttribute('data-pulsar-composition-target', 'demo');

    // Mount-then-play: the resolver runs `create(ctx)` on every scene
    // in the slice before the adapter starts playing, so all three
    // scene roots are observable as descendants of `#stage`. This is
    // race-free — the assertion is about whether mount fired for
    // every scene, not about timing within the master timeline.
    for (const sceneId of ['demo-title', 'demo-feature', 'demo-outro'] as const) {
      await expect(
        page.locator(`[data-pulsar-demo-scene="${sceneId}"]`),
        `${sceneId} scene root must mount as a descendant of #stage under mode=present`,
      ).toBeAttached({ timeout: 10_000 });
    }

    // Head-scene activation: under `mode=present` the master begins
    // playing immediately; the head scene's own `tl.call` at segment
    // start flips `data-pulsar-demo-active` to `"true"`. Under
    // `mode=paused` (the truncation path above) it would stay
    // `"false"`. The contrast distinguishes the production
    // composition-playback path from paused-truncation.
    await expect(
      page.locator('[data-pulsar-demo-scene="demo-title"]'),
      'the head scene must become active under present-mode playback',
    ).toHaveAttribute('data-pulsar-demo-active', 'true', { timeout: 10_000 });

    expect(errors, 'no uncaught exceptions or console errors during boot').toEqual([]);
  });
});
