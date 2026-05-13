import { expect, test } from '@playwright/test';

// PUL-Q002 / ADR-030 — browser-support smoke spec.
//
// The spec runs in every Playwright project declared in
// `playwright.config.ts`. For each engine, it boots the runtime via
// the workbench's production build (`pnpm preview`) and asserts the
// canonical DOM observables the runtime already publishes:
//
//   - `#stage` mounts (workbench root element exists).
//   - `data-pulsar-validation-failed` is absent (PUL-F028 boot
//     validation succeeded — every scene has cleanup, no dangling
//     assets, no duplicate ids, no malformed compositions).
//   - `data-pulsar-navigation-error` is absent (the URL grammar
//     parser accepted the default workbench URL).
//   - `data-pulsar-scene-lifecycle="timeline"` is eventually set on
//     `#stage` (the placeholder scene's `create(ctx)` and
//     `timeline(ctx)` both ran end-to-end — proves the GSAP timeline
//     engine, the scene loader, the composition resolver, and the
//     audio service constructed without throwing in this engine).
//
// The spec deliberately reuses existing DOM markers rather than
// adding new test-only instrumentation; ADR-007 already requires
// these markers to be present in present-mode boots.

test.describe('PUL-Q002 — workbench boots on every supported engine', () => {
  test('the workbench shell boots and reaches the timeline phase under mode=paused', async ({
    page,
  }) => {
    // Step 1 of the gate: shell coverage. Address the placeholder
    // scene under `mode=paused` (ADR-019) so the lifecycle runs
    // through `create` and `timeline` and holds at first frame.
    // Holding gives a durable `data-pulsar-scene-lifecycle="timeline"`
    // marker without racing the resolver's natural-completion path.
    // This step proves URL parsing, boot validation, scene loading,
    // and ctx wiring all function in the current engine.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/?scene=placeholder&mode=paused');

    const stage = page.locator('#stage');
    await expect(stage, 'the workbench stage element must mount').toBeAttached();

    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);

    await expect(
      stage,
      'the URL grammar parser must accept ?scene=placeholder&mode=paused (no data-pulsar-navigation-error)',
    ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);

    await expect(
      stage,
      "the placeholder scene's create and timeline hooks must run end-to-end",
    ).toHaveAttribute('data-pulsar-scene-lifecycle', 'timeline');

    expect(errors, 'no uncaught exceptions or console errors during boot').toEqual([]);
  });

  test('a real GSAP timeline runs end-to-end under mode=loop', async ({ page }) => {
    // Step 2 of the gate: runtime-behavior coverage. The placeholder
    // scene declares an empty timeline (`timeline(ctx)` returns
    // null), so step 1 above proves the *shell* mounts but not that
    // the GSAP timeline engine (ADR-003) actually runs a tween to
    // completion in this engine. A WebKit-only regression in the
    // GSAP runtime, the composition resolver's mount path, or the
    // scene loader's ctx wiring could ship undetected without this
    // step (codex pre-push review, cycle 1).
    //
    // The fixture scene (`src/scenes/browser-support-fixture.ts`)
    // mounts a `<div data-pulsar-fixture-target>` with state
    // `"mounted"` and runs a real GSAP timeline through `ctx.gsap`
    // that advances the same element's `data-pulsar-fixture-state`
    // to `"ran"` at the timeline's end. We address it under
    // `mode=loop` (ADR-018) so the master timeline restarts on
    // completion: the `set` + `to` + `call` sequence reruns each
    // cycle, the state stays `"ran"` after the first iteration, and
    // the fixture element is durably observable by Playwright
    // without racing the cleanup path. Cleanup itself is exercised
    // by the placeholder + fixture unit tests; the gate's job here
    // is to prove the GSAP timeline engine + resolver mount paths
    // function in every engine.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/?scene=browser-support-fixture&mode=loop');

    const stage = page.locator('#stage');
    await expect(stage, 'the workbench stage element must mount').toBeAttached();

    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);

    await expect(
      stage,
      'the URL grammar parser must accept ?scene=browser-support-fixture&mode=loop (no data-pulsar-navigation-error)',
    ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);

    const fixture = page.locator('[data-pulsar-fixture-target]');
    // The fixture's GSAP timeline calls `setAttribute(state, 'ran')`
    // at the end of a ~100ms tween. Reaching `"ran"` proves
    // `ctx.gsap.timeline()` constructed a real timeline, the
    // composition resolver mounted the scene, and the master
    // timeline ran the tween to completion in this engine. Under
    // `mode=loop` the state stays `"ran"` durably (the `set`/`to`
    // operations have no effect on the attribute), so the assertion
    // is race-free.
    await expect(
      fixture,
      "the fixture's GSAP timeline must advance the state attribute to 'ran'",
    ).toHaveAttribute('data-pulsar-fixture-state', 'ran');

    // The loader's scene-target attribute reports the addressed
    // scene id. A non-matching value would mean the resolver
    // mounted the wrong scene — an engine-specific URL-parsing
    // failure would surface here.
    await expect(stage, 'the resolver must have mounted the fixture scene').toHaveAttribute(
      'data-pulsar-scene-target',
      'browser-support-fixture',
    );

    expect(errors, 'no uncaught exceptions or console errors during boot').toEqual([]);
  });
});
