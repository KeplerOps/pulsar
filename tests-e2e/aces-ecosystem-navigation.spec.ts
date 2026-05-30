import { expect, test } from '@playwright/test';

const DECK_ROOT = '/?composition=aces-ecosystem-intro&mode=present';

const activeTemplates = async (page: import('@playwright/test').Page): Promise<string[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#stage [data-pulsar-template-active="true"]'))
      .map((el) => el.getAttribute('data-pulsar-template'))
      .filter((id): id is string => id !== null),
  );

const expectActiveScene = async (
  page: import('@playwright/test').Page,
  expected: string,
): Promise<void> => {
  await expect
    .poll(() => activeTemplates(page), {
      message: `exactly ${expected} must be the active ACES scene`,
    })
    .toEqual([expected]);
  await expect(page.locator('#stage')).toHaveAttribute('data-pulsar-scene-target', expected);
};

test.describe('ACES ecosystem deck presenter navigation', () => {
  test('arrow keys move exactly one scene and never leave the stage blank', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(DECK_ROOT);

    await expect(page.locator('#stage')).toHaveAttribute(
      'data-pulsar-composition-target',
      'aces-ecosystem-intro',
    );
    await expectActiveScene(page, 'aces-cover');

    for (const expected of ['aces-non-claim', 'aces-toc', 'aces-1']) {
      await page.keyboard.press('ArrowRight');
      await expectActiveScene(page, expected);
    }

    for (const expected of ['aces-toc', 'aces-non-claim', 'aces-cover']) {
      await page.keyboard.press('ArrowLeft');
      await expectActiveScene(page, expected);
    }

    expect(errors, 'no uncaught exceptions or console errors during presenter navigation').toEqual(
      [],
    );
  });
});
