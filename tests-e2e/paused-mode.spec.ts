import { expect, test } from '@playwright/test';

// PUL-F016 / ADR-019 — paused-mode hold-at-first-frame spec.
//
// PUL-F016: "In `mode=paused`, the runtime SHALL mount the addressed
// scene and hold it at its first frame without advancing the
// timeline." The hold mechanic is `positionMaster()` in
// `src/runtime/timeline.ts` handling `headHold === 'first-frame'` with
// `master.seek(0)` + `master.pause()`. The PUL-Q002 browser-support
// spec boots `mode=paused` too, but against the placeholder scene,
// whose timeline is empty — that proves the shell boots, not that a
// real GSAP tween is genuinely held still.
//
// This spec uses the dedicated paused fixture
// (`src/scenes/paused-fixture.ts`), whose timeline tweens a numeric
// progress object 0 -> 100 and projects the current value onto
// `data-pulsar-paused-progress`. Under a held master the tween never
// advances, so the attribute stays `"0"`; under a running master it
// climbs. The first test asserts the held behavior under `mode=paused`;
// the second is a control — under `mode=loop` the same fixture's tween
// must climb, proving the paused test's "stayed 0" is a genuine hold,
// not a dead fixture.
//
// The spec runs in every Playwright project declared in
// `playwright.config.ts` (chromium / firefox / webkit). It is
// deliberately separate from `browser-support.spec.ts` (the PUL-Q002
// engine smoke gate) and `loop-mode.spec.ts` (the PUL-F015 loop gate):
// this one is the PUL-F016 paused acceptance gate.

test.describe('PUL-F016 — mode=paused holds the timeline at its first frame', () => {
  test('the paused fixture timeline mounts and does not advance', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/?scene=paused-fixture&mode=paused');

    const stage = page.locator('#stage');
    await expect(stage, 'the workbench stage element must mount').toBeAttached();

    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);

    await expect(
      stage,
      'the URL grammar parser must accept ?scene=paused-fixture&mode=paused (no data-pulsar-navigation-error)',
    ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);

    await expect(stage, 'the resolver must have mounted the paused fixture scene').toHaveAttribute(
      'data-pulsar-scene-target',
      'paused-fixture',
    );

    const fixture = page.locator('[data-pulsar-paused-target]');
    await expect(fixture, 'the paused fixture element must mount').toBeAttached();

    // The fixture's GSAP tween would move `data-pulsar-paused-progress`
    // from "0" toward "100" over a ~100ms tween. Under `mode=paused`
    // the master is `seek(0)` + `pause()`, so the playhead never
    // advances and the attribute stays "0".
    await expect(
      fixture,
      'mode=paused must render the timeline at its first frame (progress 0)',
    ).toHaveAttribute('data-pulsar-paused-progress', '0');

    // Wait well past the tween's natural duration, then re-assert. A
    // runner that briefly played, or one whose pause leaked, would have
    // let the GSAP ticker advance the attribute by now.
    await page.waitForTimeout(500);
    await expect(
      fixture,
      'mode=paused must keep holding the first frame — progress must not advance over time',
    ).toHaveAttribute('data-pulsar-paused-progress', '0');

    expect(errors, 'no uncaught exceptions or console errors while holding').toEqual([]);
  });

  test('control: the same fixture timeline does climb when the master runs (mode=loop)', async ({
    page,
  }) => {
    // This control proves the paused test above is meaningful: the
    // fixture's tween genuinely animates `data-pulsar-paused-progress`,
    // so the paused test's pinned "0" is a real hold rather than a
    // fixture whose tween does nothing. `mode=loop` keeps the element
    // durably mounted (the master never completes, so cleanup never
    // runs) — the same race-free observation technique
    // `browser-support.spec.ts` uses.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/?scene=paused-fixture&mode=loop');

    const stage = page.locator('#stage');
    await expect(stage, 'the workbench stage element must mount').toBeAttached();

    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);

    await expect(
      stage,
      'the URL grammar parser must accept ?scene=paused-fixture&mode=loop (no data-pulsar-navigation-error)',
    ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);

    const fixture = page.locator('[data-pulsar-paused-target]');
    await expect(fixture, 'the paused fixture element must mount').toBeAttached();

    // Under a running (looping) master the tween advances, so the
    // projected progress climbs above 0. Reaching a positive value
    // proves the tween is a real, moving animation.
    await expect
      .poll(
        async () => {
          const raw = await fixture.getAttribute('data-pulsar-paused-progress');
          return raw === null ? 0 : Number.parseInt(raw, 10);
        },
        {
          message: 'a running master must let the paused fixture tween advance past 0',
        },
      )
      .toBeGreaterThan(0);

    expect(errors, 'no uncaught exceptions or console errors while running').toEqual([]);
  });
});
