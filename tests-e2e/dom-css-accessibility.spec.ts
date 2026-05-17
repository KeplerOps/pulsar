import { expect, test } from '@playwright/test';
import { SELECTABLE_PHRASE } from '../src/scenes/dom-css-accessibility-fixture';

// PUL-Q008 / ADR-005 — DOM/CSS accessibility browser gate.
//
// The spec runs in every Playwright project declared in
// `playwright.config.ts` (chromium / firefox / webkit — same matrix
// as the PUL-Q002 browser-support gate). For each engine it boots the
// DOM/CSS accessibility fixture under `mode=paused` and asserts the
// three PUL-Q008 clauses survive the scene-mount round-trip:
//
//   C1 (text remains selectable): triple-click the fixture's
//   `<p data-pulsar-q008-text>` and read `window.getSelection()` —
//   must equal the fixture's deterministic phrase.
//
//   C2 (focus order follows DOM order): focus the first button via
//   keyboard and confirm `document.activeElement` advances in DOM
//   order. Two `<button>` elements appear in the fixture's authored
//   sequence with stable `data-pulsar-q008-button="alpha"` / `"beta"`
//   markers and no positive `tabindex`.
//
//   C3 (ARIA attributes are not stripped by the runtime): assert the
//   fixture's `aria-label`, `aria-describedby`, `aria-labelledby`,
//   and `role` attributes are still present after mount, and that
//   the accessibility snapshot exposes the labelled region by its
//   `aria-label` and the alpha button by its `aria-label`.

// Both the unit test and this spec import the SAME source of truth
// for the selectable phrase so the C1 selection round-trip and the
// unit test exact-text assertion stay in lockstep (test-quality
// review, cycle 1).
const FIXTURE_PHRASE = SELECTABLE_PHRASE;
const FIXTURE_URL = '/?scene=dom-css-accessibility-fixture&mode=paused';

test.describe('PUL-Q008 — DOM/CSS accessibility preserved across engines', () => {
  test('selectable text survives the scene-mount round-trip (clause C1)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(FIXTURE_URL);

    const stage = page.locator('#stage');
    await expect(stage, 'workbench stage must mount').toBeAttached();
    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);
    await expect(
      stage,
      'URL parser must accept the fixture URL (no data-pulsar-navigation-error)',
    ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);
    await expect(stage, 'the loader must have mounted the fixture scene').toHaveAttribute(
      'data-pulsar-scene-target',
      'dom-css-accessibility-fixture',
    );

    const paragraph = page.locator('[data-pulsar-q008-text]');
    await expect(paragraph).toBeAttached();
    await expect(paragraph).toHaveText(FIXTURE_PHRASE);

    // Triple-click selects the paragraph's full text content in every
    // major engine. `window.getSelection().toString()` reads the
    // selected text via the DOM Selection API — if the runtime had
    // applied `user-select: none` (forbidden by the PUL-Q008
    // source-policy gate) the read would return the empty string.
    await paragraph.click({ clickCount: 3 });
    const selection = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    expect(selection.trim(), 'fixture text must be selectable in this engine').toBe(FIXTURE_PHRASE);

    expect(errors, 'no uncaught exceptions or console errors during the run').toEqual([]);
  });

  test('focus order follows DOM order (clause C2)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(FIXTURE_URL);

    const stage = page.locator('#stage');
    await expect(stage).toBeAttached();
    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);

    const sentinel = page.locator('[data-pulsar-q008-sentinel]');
    const alpha = page.locator('[data-pulsar-q008-button="alpha"]');
    const beta = page.locator('[data-pulsar-q008-button="beta"]');
    await expect(sentinel).toBeAttached();
    await expect(alpha).toBeAttached();
    await expect(beta).toBeAttached();

    // Anchor the Tab sequence on the focus sentinel (first focusable
    // in DOM order inside the fixture root). Pressing Tab from there
    // proves the *first* keyboard focus advancement reaches alpha —
    // a regression that skipped alpha entirely on Tab (e.g. a hidden
    // sentinel or a positive `tabindex` reordering) would fail here,
    // not just on the alpha→beta hop (codex pre-push review, cycle
    // 1).
    await sentinel.focus();
    const sentinelFocused = await page.evaluate(
      () =>
        (document.activeElement as HTMLElement | null)?.getAttribute('data-pulsar-q008-sentinel') ??
        null,
    );
    expect(sentinelFocused, 'sentinel must take focus when focused directly').toBe('');

    await page.keyboard.press('Tab');
    const firstTab = await page.evaluate(
      () =>
        (document.activeElement as HTMLElement | null)?.getAttribute('data-pulsar-q008-button') ??
        null,
    );
    expect(firstTab, 'first Tab from the sentinel must land on alpha').toBe('alpha');

    await page.keyboard.press('Tab');
    const secondTab = await page.evaluate(
      () =>
        (document.activeElement as HTMLElement | null)?.getAttribute('data-pulsar-q008-button') ??
        null,
    );
    expect(secondTab, 'second Tab from the sentinel must land on beta').toBe('beta');

    expect(errors, 'no uncaught exceptions or console errors during the run').toEqual([]);
  });

  test('ARIA attributes survive the scene-mount round-trip (clause C3)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(FIXTURE_URL);

    const stage = page.locator('#stage');
    await expect(stage).toBeAttached();
    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);

    const alpha = page.locator('[data-pulsar-q008-button="alpha"]');
    const beta = page.locator('[data-pulsar-q008-button="beta"]');
    const description = page.locator('#pul-q008-desc');
    const region = page.locator('[data-pulsar-q008-region]');
    const betaLabel = page.locator('#pul-q008-beta-label');

    await expect(alpha, 'aria-label must survive scene mount').toHaveAttribute(
      'aria-label',
      'alpha button',
    );
    await expect(beta, 'aria-describedby must survive scene mount').toHaveAttribute(
      'aria-describedby',
      'pul-q008-desc',
    );
    await expect(beta, 'aria-labelledby must survive scene mount').toHaveAttribute(
      'aria-labelledby',
      'pul-q008-beta-label',
    );
    await expect(description, 'role must survive scene mount').toHaveAttribute('role', 'note');
    await expect(region, 'role="region" must survive scene mount').toHaveAttribute(
      'role',
      'region',
    );
    await expect(region, 'aria-label on the region must survive scene mount').toHaveAttribute(
      'aria-label',
      'accessibility fixture surface',
    );
    await expect(betaLabel, 'aria-labelledby target must be attached').toBeAttached();

    // The raw `toHaveAttribute` assertions above prove the runtime
    // did not STRIP the ARIA attributes the scene authored. The
    // `toHaveAccessibleName` / `toHaveRole` assertions below prove
    // the browser's COMPUTED accessibility tree honours those
    // attributes in every engine — alpha's `aria-label` becomes its
    // accessible name, beta's `aria-labelledby` resolves to the
    // referenced span, and the region's `role="region"` is exposed
    // as the `region` ARIA role. These are the cross-engine
    // equivalents of `page.accessibility.snapshot()` (chromium-only)
    // and work uniformly under chromium / firefox / webkit.
    await expect(alpha).toHaveAccessibleName('alpha button');
    await expect(alpha).toHaveRole('button');
    await expect(beta).toHaveAccessibleName('beta button');
    await expect(beta).toHaveRole('button');
    await expect(region).toHaveAccessibleName('accessibility fixture surface');
    await expect(region).toHaveRole('region');

    expect(errors, 'no uncaught exceptions or console errors during the run').toEqual([]);
  });
});
