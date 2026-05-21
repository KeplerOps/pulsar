import { expect, test } from '@playwright/test';

// Pulsar L2 — reference deck (pulsar-intro) browser smoke spec.
//
// Boots the deck across the chromium / firefox / webkit Playwright
// matrix and verifies:
//
//   1. The workbench mounts: #stage attached, no validation /
//      navigation error markers, chrome surface visible, transition
//      overlay parented to body.
//   2. The L2 chrome slots are present (vignette, grain, scanlines,
//      bars, title, brand, center, lower-third, tag, act-frame,
//      flash) — proves mountChromeSlots ran at bootstrap.
//   3. The composition resolves: data-pulsar-composition-target =
//      "pulsar-intro" and data-pulsar-scene-target = "pi-title"
//      (the manifest's head).
//   4. Mount-then-play: every scene's template root is attached as a
//      descendant of #stage (the resolver mounts the whole slice
//      before the master plays).
//   5. Head-scene activation: the head template's
//      data-pulsar-template-active flips to "true" once the master
//      starts playing (present mode default).
//   6. Keyboard advance: ArrowRight fires an advance command (the
//      key reaches the keyboard source). We don't assert what the
//      master does in response — that's a per-template concern
//      tested separately — only that the key reaches the runtime
//      without throwing.

const DECK_ROOT = '/?composition=pulsar-intro';

test.describe('Pulsar L2 reference deck — pulsar-intro', () => {
  test('boots and mounts every scene root + L2 chrome slots', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(DECK_ROOT);

    const stage = page.locator('#stage');
    await expect(stage, 'workbench stage must mount').toBeAttached();
    await expect(
      stage,
      'PUL-F028 boot validation must succeed (no data-pulsar-validation-failed)',
    ).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);
    await expect(
      stage,
      'the URL grammar parser must accept ?composition=pulsar-intro',
    ).not.toHaveAttribute('data-pulsar-navigation-error', /.*/);
    await expect(stage, "the loader must resolve the deck's composition target").toHaveAttribute(
      'data-pulsar-composition-target',
      'pulsar-intro',
    );
    await expect(stage, 'the resolver must mount the head scene (pi-title)').toHaveAttribute(
      'data-pulsar-scene-target',
      'pi-title',
    );

    // L2 chrome surface + slot DOM mounted by mountChromeSlots.
    const chromeSurface = page.locator('[data-pulsar-chrome="surface"]');
    await expect(chromeSurface, 'L2 chrome surface must be present').toBeAttached();
    await expect(chromeSurface).toHaveClass(/pulsar-stage/);
    for (const cls of [
      'pulsar-vignette',
      'pulsar-scanlines',
      'pulsar-grain',
      'pulsar-bars',
      'pulsar-flash',
      'pulsar-title',
      'pulsar-brand',
      'pulsar-center',
      'pulsar-lower-third',
      'pulsar-tag',
      'pulsar-act',
    ]) {
      await expect(
        chromeSurface.locator(`.${cls}`),
        `L2 chrome slot .${cls} must mount inside the chrome surface`,
      ).toBeAttached();
    }

    // Inter-scene transition overlay mounted on document.body.
    const overlay = page.locator('[data-pulsar-transition="overlay"]');
    await expect(overlay, 'inter-scene transition overlay must be parented to body').toBeAttached();

    // Mount-then-play: every template root mounts as a descendant of
    // #stage before the master runs. Sample a representative subset
    // (asserting all 17 here would couple the test to manifest order
    // changes; the existence of a few representative templates proves
    // the resolver mounted the slice).
    for (const sceneId of ['pi-title', 'pi-stat-bespoke', 'pi-quote-thesis', 'pi-outro']) {
      await expect(
        stage.locator(`[data-pulsar-template="${sceneId}"]`),
        `${sceneId} template root must mount as a descendant of #stage`,
      ).toBeAttached({ timeout: 10_000 });
    }

    // Present-mode activates the head: pi-title's
    // data-pulsar-template-active flips to "true" once the master
    // tween's leading tl.call fires.
    await expect(
      page.locator('[data-pulsar-template="pi-title"]'),
      'head scene must become active under present-mode playback',
    ).toHaveAttribute('data-pulsar-template-active', 'true', { timeout: 10_000 });

    // Keyboard advance lands on the runtime without crashing.
    await page.keyboard.press('ArrowRight');

    expect(errors, 'no uncaught exceptions or console errors during boot').toEqual([]);
  });

  test('paused mode holds the master at frame 0', async ({ page }) => {
    // mode=paused truncates the slice to the head and pauses the
    // master at frame 0. PUL-F016 contract: no animation progresses.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(`${DECK_ROOT}&mode=paused`);

    const stage = page.locator('#stage');
    await expect(stage).toBeAttached();
    await expect(stage).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);
    await expect(stage).toHaveAttribute('data-pulsar-composition-target', 'pulsar-intro');
    await expect(stage).toHaveAttribute('data-pulsar-scene-target', 'pi-title');

    // Under paused mode the master is held at frame 0; the head
    // template's leading tl.call (which would set active="true")
    // does not fire. The mount-time data-pulsar-template-active=
    // "false" should persist.
    await expect(
      page.locator('[data-pulsar-template="pi-title"]'),
      'head scene must stay inactive under mode=paused (master held at frame 0)',
    ).toHaveAttribute('data-pulsar-template-active', 'false');

    expect(errors, 'no uncaught exceptions or console errors').toEqual([]);
  });

  test('loop mode visibly enters the master playback loop', async ({ page }) => {
    // mode=loop also truncates the slice to head, but the master
    // plays with master.repeat(-1) — the leading tl.call runs at
    // the start of each iteration, so activation flips to true.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(`${DECK_ROOT}&mode=loop`);

    const stage = page.locator('#stage');
    await expect(stage).toBeAttached();
    await expect(stage).not.toHaveAttribute('data-pulsar-validation-failed', /.*/);
    await expect(stage).toHaveAttribute('data-pulsar-composition-target', 'pulsar-intro');

    await expect(
      page.locator('[data-pulsar-template="pi-title"]'),
      'loop-mode master playback must activate the head scene',
    ).toHaveAttribute('data-pulsar-template-active', 'true', { timeout: 10_000 });

    expect(errors, 'no uncaught exceptions or console errors').toEqual([]);
  });
});
