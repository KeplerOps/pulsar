import { expect, test } from '@playwright/test';

// PUL-F017 / ADR-020 — scrub-mode timeline controls spec.
//
// PUL-F017: "In `mode=scrub`, the runtime SHALL display timeline
// controls allowing the user to scrub forward, backward, and to named
// beats." The scrub run mode is `positionMaster()` in
// `src/runtime/timeline.ts` leaving the master held and live under
// `headCueGate`; the controls are `createScrubControls()` in
// `src/system/chrome/scrub.ts`, wired in `src/main.ts` via the timeline
// adapter's `onMaster` hook.
//
// This spec uses the dedicated scrub fixture
// (`src/scenes/scrub-fixture.ts`), whose timeline tweens a numeric
// progress object 0 -> 100 onto `data-pulsar-scrub-progress` and
// carries one named beat (`midpoint`). It boots the fixture under
// `mode=scrub`, asserts the transport bar appears, and drives play /
// reverse / named-beat-jump — proving the controls drive a real GSAP
// master in a real browser engine.
//
// It runs in every Playwright project declared in
// `playwright.config.ts` (chromium / firefox / webkit) and is the
// PUL-F017 scrub acceptance gate, separate from the PUL-F015 loop and
// PUL-F016 paused gates.

const SCRUB = '[data-pulsar-scrub="controls"]';
const PROGRESS = '[data-pulsar-scrub-target]';

const readProgress = async (page: import('@playwright/test').Page): Promise<number> => {
  const raw = await page.locator(PROGRESS).getAttribute('data-pulsar-scrub-progress');
  return raw === null ? Number.NaN : Number.parseInt(raw, 10);
};

test.describe('PUL-F017 — mode=scrub displays timeline controls that drive the master', () => {
  test('the scrub controls appear, hold at frame 0, and play / reverse drive the timeline', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/?scene=scrub-fixture&mode=scrub');

    const stage = page.locator('#stage');
    await expect(stage, 'the workbench stage element must mount').toBeAttached();
    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);
    await expect(
      stage,
      'the URL grammar parser must accept ?scene=scrub-fixture&mode=scrub',
    ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);
    await expect(stage, 'the resolver must have mounted the scrub fixture scene').toHaveAttribute(
      'data-pulsar-scene-target',
      'scrub-fixture',
    );

    // PUL-F017 clause 1: the timeline controls are displayed under
    // `mode=scrub`.
    const controls = page.locator(SCRUB);
    await expect(controls, 'the scrub controls surface must appear under mode=scrub').toBeVisible();

    // The scrub master is held — the fixture progress stays at 0 until
    // the user drives the transport.
    await expect(page.locator(PROGRESS), 'the scrub fixture element must mount').toBeAttached();
    await page.waitForTimeout(400);
    expect(await readProgress(page), 'a held scrub master must not advance on its own').toBe(0);

    // PUL-F017 clause 1 (forward): pressing play advances the timeline.
    await controls.locator('.pulsar-scrub__play').click();
    await expect
      .poll(() => readProgress(page), {
        message: 'pressing play must advance the scrub timeline',
      })
      .toBeGreaterThan(10);
    await controls.locator('.pulsar-scrub__play').click(); // pause
    const paused = await readProgress(page);

    // PUL-F017 clause 1 (backward): reverse playback walks it back down.
    await controls.locator('.pulsar-scrub__reverse').click();
    await expect
      .poll(() => readProgress(page), {
        message: 'pressing reverse must walk the scrub timeline backward',
      })
      .toBeLessThan(paused);

    expect(errors, 'no uncaught exceptions or console errors while scrubbing').toEqual([]);
  });

  test('a named-beat jump button seeks the master to the authored beat', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/?scene=scrub-fixture&mode=scrub');
    await expect(page.locator('#stage')).toHaveAttribute(
      'data-pulsar-scene-target',
      'scrub-fixture',
    );

    const controls = page.locator(SCRUB);
    await expect(controls).toBeVisible();

    // The fixture authors one beat (`midpoint`) at the timeline's
    // half-way point, so the controls render exactly one jump button.
    const beat = controls.locator('.pulsar-scrub__beat');
    await expect(beat, 'a named-beat jump button must be rendered').toHaveCount(1);
    await expect(beat).toHaveText('midpoint');

    // Jumping to the midpoint beat seeks the master there — the fixture
    // progress lands near 50 (a direct seek, so no audio cue fires).
    await beat.click();
    await expect
      .poll(() => readProgress(page), {
        message: 'jumping to the midpoint beat must seek the master to ~50% progress',
      })
      .toBeGreaterThanOrEqual(40);
    expect(await readProgress(page), 'the midpoint jump must not overshoot').toBeLessThanOrEqual(
      60,
    );

    expect(errors, 'no uncaught exceptions or console errors while jumping to a beat').toEqual([]);
  });
});
