import { expect, test } from '@playwright/test';

// PUL-F015 / ADR-018 — loop-mode restart-on-completion spec.
//
// PUL-F015: "In `mode=loop`, the runtime SHALL run the addressed
// scene's timeline and restart it on completion." The restart
// mechanic is `positionMaster()` in `src/runtime/timeline.ts` setting
// `master.repeat(-1)` for `headRepeat === 'until-aborted'`. The
// PUL-Q002 browser-support spec boots `mode=loop` too, but asserts a
// sticky `data-pulsar-fixture-state="ran"` attribute — that proves
// one timeline completion, not restart-on-completion: a runner that
// played the timeline exactly once would be indistinguishable from a
// genuinely looping one through that attribute.
//
// This spec uses the dedicated loop fixture
// (`src/scenes/loop-fixture.ts`), whose timeline ends with a
// `.call()` that increments a per-navigation counter into
// `data-pulsar-loop-iteration`. Under a looping master the nested
// scene timeline replays each cycle, so the attribute strictly
// increases. Observing it reach `2` proves the timeline completed
// once and then *restarted* and completed again — the actual
// PUL-F015 contract, in a real browser engine.
//
// The spec runs in every Playwright project declared in
// `playwright.config.ts` (chromium / firefox / webkit). It is
// deliberately separate from `browser-support.spec.ts`: that spec is
// the PUL-Q002 engine smoke gate; this one is the PUL-F015 loop
// acceptance gate. Mixing the two would overload one fixture with two
// unrelated gate responsibilities.

test.describe('PUL-F015 — mode=loop restarts the timeline on completion', () => {
  test('the loop fixture timeline restarts and completes at least twice', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/?scene=loop-fixture&mode=loop');

    const stage = page.locator('#stage');
    await expect(stage, 'the workbench stage element must mount').toBeAttached();

    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);

    await expect(
      stage,
      'the URL grammar parser must accept ?scene=loop-fixture&mode=loop (no data-pulsar-navigation-error)',
    ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);

    await expect(stage, 'the resolver must have mounted the loop fixture scene').toHaveAttribute(
      'data-pulsar-scene-target',
      'loop-fixture',
    );

    const fixture = page.locator('[data-pulsar-loop-target]');
    await expect(fixture, 'the loop fixture element must mount').toBeAttached();

    // The fixture's GSAP timeline increments `data-pulsar-loop-iteration`
    // at the end of each ~100ms cycle. Reaching `>= 2` proves the
    // master timeline ran the scene timeline to completion, then
    // restarted it under `repeat(-1)` and ran it to completion again
    // — the restart-on-completion clause of PUL-F015. A runner that
    // honored the hint as a no-op (played once, parked) would stall
    // at `1` and this poll would time out.
    await expect
      .poll(
        async () => {
          const raw = await fixture.getAttribute('data-pulsar-loop-iteration');
          return raw === null ? 0 : Number.parseInt(raw, 10);
        },
        {
          message: 'mode=loop must restart the timeline so the iteration counter reaches >= 2',
        },
      )
      .toBeGreaterThanOrEqual(2);

    expect(errors, 'no uncaught exceptions or console errors during the loop').toEqual([]);
  });
});
