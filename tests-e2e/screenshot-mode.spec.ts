import { type Page, expect, test } from '@playwright/test';

// PUL-F018 / ADR-021 — screenshot-mode deterministic-seed spec.
//
// PUL-F018: "In `mode=screenshot`, the runtime SHALL render the
// addressed scene ... with ... any randomness sourced from a
// deterministic seed." The seed is derived per navigation from the
// addressed URL (`deriveNavigationSeed` in `src/runtime/scene-loader.ts`)
// and exposed as a seeded generator on `WorkbenchSceneCtx.rng`
// (`createSeededRng` in `src/runtime/rng.ts`).
//
// This spec uses the dedicated screenshot RNG fixture
// (`src/scenes/screenshot-rng-fixture.ts`), whose `create(ctx)` draws a
// fixed sequence from `ctx.rng` and projects it onto
// `data-pulsar-screenshot-rng`. It boots the fixture under
// `mode=screenshot`, records the attribute, reloads the same URL, and
// asserts the recorded sequence is byte-identical — proving the seeded
// generator replays the same randomness across reloads in a real
// browser engine, which is what makes a screenshot-mode capture
// reproducible.
//
// It runs in every Playwright project declared in
// `playwright.config.ts` (chromium / firefox / webkit) and is the
// PUL-F018 screenshot acceptance gate, separate from the PUL-F015 loop,
// PUL-F016 paused, and PUL-F017 scrub gates.

const URL = '/?scene=screenshot-rng-fixture&mode=screenshot';
const RNG_TARGET = '[data-pulsar-screenshot-rng-target]';

const readRngSequence = async (page: Page): Promise<string | null> =>
  page.locator(RNG_TARGET).getAttribute('data-pulsar-screenshot-rng');

const expectCleanScreenshotMount = async (page: Page): Promise<void> => {
  const stage = page.locator('#stage');
  await expect(stage, 'the workbench stage element must mount').toBeAttached();
  await expect(
    stage,
    'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
  ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);
  await expect(
    stage,
    'the URL grammar parser must accept ?scene=screenshot-rng-fixture&mode=screenshot',
  ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);
  await expect(
    stage,
    'the resolver must have mounted the screenshot RNG fixture scene',
  ).toHaveAttribute('data-pulsar-scene-target', 'screenshot-rng-fixture');
  await expect(page.locator(RNG_TARGET), 'the fixture element must mount').toBeAttached();
};

test.describe('PUL-F018 — mode=screenshot sources randomness from a deterministic seed', () => {
  test('two loads of the same screenshot URL replay a byte-identical random sequence', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    // First capture.
    await page.goto(URL);
    await expectCleanScreenshotMount(page);
    const first = await readRngSequence(page);
    expect(first, 'the fixture must project a seeded draw sequence').not.toBeNull();
    expect(
      (first ?? '').split(',').length,
      'the fixture projects more than one draw, so the comparison covers a sequence',
    ).toBeGreaterThan(1);

    // Second capture — a fresh load of the exact same URL.
    await page.goto(URL);
    await expectCleanScreenshotMount(page);
    const second = await readRngSequence(page);

    // PUL-F018: the same workbench URL under `mode=screenshot` derives
    // the same seed and so replays the same random sequence — the
    // determinism a reproducible capture depends on.
    expect(second, 'a reload of the same screenshot URL must replay the same seeded draws').toBe(
      first,
    );

    expect(errors, 'no uncaught exceptions or console errors during screenshot capture').toEqual(
      [],
    );
  });
});
