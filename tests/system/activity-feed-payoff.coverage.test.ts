/** @vitest-environment happy-dom */
// Pulsar L2 template — activityFeedPayoff behavioral coverage.
//
// templates-options.test.ts exercises the SYNCHRONOUS structural surface
// of this template (eyebrow / headline / payoff-title presence, the
// feed/payoff markers). This file covers the parts that only run when the
// scene's timeline plays: the `play(...)` streaming loop (lines 117-150)
// that types each feed entry into an `<li class="afp__entry--<type>">`,
// then fills the payoff `<dl>` row by row with `[[glow]]` markup; plus the
// abort surface (`onDeactivate` line 102-105 and `cleanup` line 107-114)
// that stops the loop and removes the root.
//
// The `play` loop is kicked off by the timeline's leading `.call(...)`.
// We drive that callback deterministically with `tl.seek(0.001, false)`
// (suppressEvents=false fires the time-0 callbacks WITHOUT the trailing
// `onComplete` that would deactivate/abort), then drain the loop's
// `setTimeout`-based typing/dwell with bounded fake timers. We never let
// the gsap ticker auto-run (the timeline stays paused), so the only timers
// that advance are the template's own. Assertions run against the real
// happy-dom document — no fakes, no casts.

import { gsap } from 'gsap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSceneModule } from '../../src/runtime/scene';
import {
  type ActivityFeedPayoffContent,
  activityFeedPayoff,
} from '../../src/system/templates/activity-feed-payoff';

const makeStage = (): HTMLElement => document.createElement('div');
const ctxOf = (stage: HTMLElement): unknown => ({ stage, mode: 'present', gsap });

const requireRoot = (stage: HTMLElement, id: string): HTMLElement => {
  const root = stage.querySelector<HTMLElement>(`[data-pulsar-template="${id}"]`);
  expect(root).not.toBeNull();
  if (root === null) throw new Error(`expected ${id} root`);
  return root;
};

/**
 * Mount the scene, build its timeline, and fire the leading activation +
 * `play(...)` callbacks via `seek(0.001, false)` — without firing the
 * trailing `onComplete` that deactivates/aborts. Then drain the play
 * loop's own setTimeout-driven typing + dwells under fake timers.
 *
 * Returns the live root + the (still-paused) timeline so callers can drive
 * deactivation (`progress(1)`) or cleanup afterwards.
 */
const mountAndPlay = async (
  id: string,
  content: ActivityFeedPayoffContent,
): Promise<{
  stage: HTMLElement;
  ctx: unknown;
  scene: ReturnType<typeof activityFeedPayoff>;
  root: HTMLElement;
  tl: gsap.core.Timeline;
  drain: (ms?: number) => Promise<void>;
}> => {
  const stage = makeStage();
  const ctx = ctxOf(stage);
  const scene = activityFeedPayoff(id, content);
  scene.create(ctx);
  const root = requireRoot(stage, id);
  const tl = scene.timeline(ctx) as gsap.core.Timeline;
  tl.pause();
  tl.seek(0.001, false); // fire activate + play, NOT the trailing deactivate
  const drain = async (ms = 8000): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  await drain();
  return { stage, ctx, scene, root, tl, drain };
};

describe('activityFeedPayoff — streaming + payoff + abort behavior', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a valid scene module with feed-indexed captions and template metadata', () => {
    const scene = activityFeedPayoff('afp-meta', {
      feed: [
        { type: 'search', text: 'who is X' },
        { type: 'read', text: 'wiki' },
        { type: 'think', text: 'synthesize' },
      ],
      payoff: { rows: [{ label: 'name', value: 'X' }] },
    });
    expect(() => assertSceneModule(scene)).not.toThrow();
    expect(scene.id).toBe('afp-meta');
    expect(scene.title).toBe('Activity feed → payoff');
    expect(scene.tags).toEqual(['template']);
    // One caption per feed entry, keyed `feed-<i>` with the entry text (line 45).
    expect(scene.captions).toEqual([
      { at: 'feed-0', text: 'who is X' },
      { at: 'feed-1', text: 'wiki' },
      { at: 'feed-2', text: 'synthesize' },
    ]);
  });

  it('mounts the two-pane scaffold: ol[data-afp-feed] + dl[data-afp-payoff] inside the grid', () => {
    const scene = activityFeedPayoff('afp-scaffold', {
      feed: [{ type: 'search', text: 'q' }],
      payoff: { rows: [{ label: 'k', value: 'v' }] },
    });
    const stage = makeStage();
    scene.create(ctxOf(stage));
    const root = requireRoot(stage, 'afp-scaffold');

    expect(root.tagName).toBe('SECTION');
    expect(root.getAttribute('class')).toBe(
      'pulsar-template pulsar-template--activity-feed-payoff',
    );

    const grid = root.querySelector<HTMLElement>('.afp__grid');
    expect(grid).not.toBeNull();

    const feed = root.querySelector<HTMLElement>('[data-afp-feed]');
    expect(feed).not.toBeNull();
    expect(feed?.tagName).toBe('OL');
    expect(feed?.getAttribute('class')).toBe('afp__feed');
    expect(feed?.parentElement).toBe(grid);

    const payoffTable = root.querySelector<HTMLElement>('[data-afp-payoff]');
    expect(payoffTable).not.toBeNull();
    expect(payoffTable?.tagName).toBe('DL');
    expect(payoffTable?.getAttribute('class')).toBe('afp__payoff-table');
    // Payoff table lives in the `.afp__payoff` column, which is in the grid.
    expect(payoffTable?.closest('.afp__payoff')?.parentElement).toBe(grid);
  });

  it('omits the header and payoff title when eyebrow/headline/title are absent', () => {
    const scene = activityFeedPayoff('afp-minimal', {
      feed: [{ type: 'search', text: 'q' }],
      payoff: { rows: [{ label: 'k', value: 'v' }] },
    });
    const stage = makeStage();
    scene.create(ctxOf(stage));
    const root = requireRoot(stage, 'afp-minimal');
    // No header element, no eyebrow/headline/payoff-title (lines 52-68, 77-82).
    expect(root.querySelector('.afp__head')).toBeNull();
    expect(root.querySelector('.afp__eyebrow')).toBeNull();
    expect(root.querySelector('.afp__headline')).toBeNull();
    expect(root.querySelector('.afp__payoff-title')).toBeNull();
  });

  it('renders only the eyebrow (no headline) when headline is absent', () => {
    const scene = activityFeedPayoff('afp-eyebrow-only', {
      eyebrow: 'RECON',
      feed: [{ type: 'search', text: 'q' }],
      payoff: { rows: [{ label: 'k', value: 'v' }] },
    });
    const stage = makeStage();
    scene.create(ctxOf(stage));
    const root = requireRoot(stage, 'afp-eyebrow-only');
    const head = root.querySelector<HTMLElement>('.afp__head');
    expect(head).not.toBeNull();
    expect(head?.tagName).toBe('HEADER');
    const eyebrow = root.querySelector<HTMLElement>('.afp__eyebrow');
    expect(eyebrow?.tagName).toBe('P');
    expect(eyebrow?.textContent).toBe('RECON');
    expect(root.querySelector('.afp__headline')).toBeNull();
  });

  it('renders only the headline (no eyebrow) when eyebrow is absent', () => {
    const scene = activityFeedPayoff('afp-headline-only', {
      headline: 'OSINT',
      feed: [{ type: 'search', text: 'q' }],
      payoff: { rows: [{ label: 'k', value: 'v' }] },
    });
    const stage = makeStage();
    scene.create(ctxOf(stage));
    const root = requireRoot(stage, 'afp-headline-only');
    expect(root.querySelector('.afp__head')).not.toBeNull();
    expect(root.querySelector('.afp__eyebrow')).toBeNull();
    const headline = root.querySelector<HTMLElement>('.afp__headline');
    expect(headline?.tagName).toBe('H2');
    expect(headline?.textContent).toBe('OSINT');
  });

  it('renders the payoff title as an <h3> when supplied', () => {
    const scene = activityFeedPayoff('afp-ptitle', {
      feed: [{ type: 'search', text: 'q' }],
      payoff: { title: 'Dossier', rows: [{ label: 'k', value: 'v' }] },
    });
    const stage = makeStage();
    scene.create(ctxOf(stage));
    const root = requireRoot(stage, 'afp-ptitle');
    const pt = root.querySelector<HTMLElement>('.afp__payoff-title');
    expect(pt?.tagName).toBe('H3');
    expect(pt?.textContent).toBe('Dossier');
  });

  it('exposes the afp-in label and authors no advance gate on the timeline (ADR-032)', () => {
    const scene = activityFeedPayoff('afp-labels', {
      feed: [{ type: 'search', text: 'q' }],
      payoff: { rows: [{ label: 'k', value: 'v' }] },
    });
    const stage = makeStage();
    scene.create(ctxOf(stage));
    const tl = scene.timeline(ctxOf(stage)) as gsap.core.Timeline;
    try {
      expect(Object.keys(tl.labels)).toContain('afp-in');
      // The run-loop holds for advance; no `_advance-gate*` master pause.
      expect(Object.keys(tl.labels).filter((n) => n.startsWith('_advance'))).toEqual([]);
      expect(tl.duration()).toBeGreaterThan(0);
    } finally {
      tl.kill();
    }
  });

  it('streams every feed entry: one <li> per entry, correct --type class + typed text', async () => {
    vi.useFakeTimers();
    const { root, tl } = await mountAndPlay('afp-stream', {
      feed: [
        { type: 'search', text: 'who is X' },
        { type: 'read', text: 'profile page', afterMs: 10 },
        { type: 'think', text: 'synthesize' },
      ],
      payoff: { rows: [{ label: 'k', value: 'v' }] },
      typeBaseMs: 1,
    });
    try {
      const entries = [...root.querySelectorAll<HTMLElement>('.afp__entry')];
      expect(entries).toHaveLength(3);
      expect(entries.map((li) => li.tagName)).toEqual(['LI', 'LI', 'LI']);
      // Each entry keys its kind into `afp__entry--<type>` (line 131).
      expect(entries.map((li) => li.className)).toEqual([
        'afp__entry afp__entry--search',
        'afp__entry afp__entry--read',
        'afp__entry afp__entry--think',
      ]);
      // typeNode reveals the text char-by-char; textContent is the full line.
      expect(entries.map((li) => li.textContent)).toEqual([
        'who is X',
        'profile page',
        'synthesize',
      ]);
      // typeNode renders chars as `.ph-char` spans inside the <li>.
      expect(entries[0]?.querySelectorAll('.ph-char').length).toBe('who is X'.length);
    } finally {
      tl.kill();
    }
  });

  it('fills the payoff table row by row after the feed, with dt/dd and [[glow]] markup', async () => {
    vi.useFakeTimers();
    const { root, tl } = await mountAndPlay('afp-payoff', {
      feed: [{ type: 'search', text: 'q' }],
      payoff: {
        title: 'Dossier',
        rows: [
          { label: 'name', value: 'Jane Doe' },
          { label: 'role', value: '[[CEO]] of Acme' },
          { label: 'note', value: 'a & b < c > "d"' },
        ],
      },
      typeBaseMs: 1,
    });
    try {
      const keys = [...root.querySelectorAll<HTMLElement>('.afp__payoff-key')];
      const values = [...root.querySelectorAll<HTMLElement>('.afp__payoff-value')];
      expect(keys.map((k) => k.tagName)).toEqual(['DT', 'DT', 'DT']);
      expect(values.map((v) => v.tagName)).toEqual(['DD', 'DD', 'DD']);
      expect(keys.map((k) => k.textContent)).toEqual(['name', 'role', 'note']);

      // Plain value: no markup.
      expect(values[0]?.innerHTML).toBe('Jane Doe');
      // `[[CEO]]` becomes a `.glow` span via markedTextHtml (line 144).
      expect(values[1]?.innerHTML).toBe('<span class="glow">CEO</span> of Acme');
      const glow = values[1]?.querySelector<HTMLElement>('.glow');
      expect(glow?.textContent).toBe('CEO');
      // markedTextHtml escapes HTML-special chars, so no injected nodes appear.
      expect(values[2]?.innerHTML).toBe('a &amp; b &lt; c &gt; "d"');
      expect(values[2]?.children).toHaveLength(0);
      expect(values[2]?.textContent).toBe('a & b < c > "d"');
    } finally {
      tl.kill();
    }
  });

  it('does not populate the payoff until the entire feed has streamed', async () => {
    vi.useFakeTimers();
    const stage = makeStage();
    const ctx = ctxOf(stage);
    const scene = activityFeedPayoff('afp-order', {
      feed: [
        { type: 'search', text: 'a' },
        { type: 'read', text: 'b' },
        { type: 'think', text: 'c' },
      ],
      payoff: { rows: [{ label: 'k', value: 'v' }] },
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const root = requireRoot(stage, 'afp-order');
    const tl = scene.timeline(ctx) as gsap.core.Timeline;
    tl.pause();
    tl.seek(0.001, false);
    try {
      // Advance just enough for the first entry's type + dwell (~255ms),
      // well short of the full feed. Payoff must still be empty.
      await vi.advanceTimersByTimeAsync(260);
      expect(root.querySelectorAll('.afp__entry').length).toBeGreaterThanOrEqual(1);
      expect(root.querySelectorAll('.afp__entry').length).toBeLessThan(3);
      expect(root.querySelectorAll('.afp__payoff-key')).toHaveLength(0);

      // Drain to completion: now the full feed and the payoff are present.
      await vi.advanceTimersByTimeAsync(8000);
      expect(root.querySelectorAll('.afp__entry')).toHaveLength(3);
      expect(root.querySelectorAll('.afp__payoff-key')).toHaveLength(1);
    } finally {
      tl.kill();
    }
  });

  it('flips the activation marker on at start and keeps it active through the natural end (ADR-032)', async () => {
    vi.useFakeTimers();
    const stage = makeStage();
    const ctx = ctxOf(stage);
    const scene = activityFeedPayoff('afp-active', {
      feed: [{ type: 'search', text: 'q' }],
      payoff: { rows: [{ label: 'k', value: 'v' }] },
    });
    scene.create(ctx);
    const root = requireRoot(stage, 'afp-active');
    // Mounts inactive (mountTemplateRoot sets the initial marker).
    expect(root.dataset.pulsarTemplateActive).toBe('false');

    const tl = scene.timeline(ctx) as gsap.core.Timeline;
    tl.pause();
    tl.seek(0.001, false); // leading .call flips it active
    expect(root.dataset.pulsarTemplateActive).toBe('true');

    // No deactivate-on-complete tween: the root stays active at the
    // timeline's natural end. The run-loop holds for advance; teardown is
    // the scene's `cleanup(ctx)` job, which removes the root entirely.
    tl.progress(1);
    expect(root.dataset.pulsarTemplateActive).toBe('true');
    tl.kill();

    scene.cleanup(ctx);
    expect(stage.querySelector('[data-pulsar-template="afp-active"]')).toBeNull();
  });

  it('cleanup aborts the streaming loop so no further entries/rows append (ADR-032 teardown in cleanup)', async () => {
    vi.useFakeTimers();
    const stage = makeStage();
    const ctx = ctxOf(stage);
    const scene = activityFeedPayoff('afp-deactivate', {
      feed: [
        { type: 'search', text: 'a' },
        { type: 'read', text: 'b' },
        { type: 'think', text: 'c' },
      ],
      payoff: { rows: [{ label: 'k', value: 'v' }] },
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const root = requireRoot(stage, 'afp-deactivate');
    const tl = scene.timeline(ctx) as gsap.core.Timeline;
    tl.pause();
    tl.seek(0.001, false);
    // Let the loop append its first entry, then mid-stream tear down via
    // the scene's cleanup hook (the run-loop calls it on scene exit).
    await vi.advanceTimersByTimeAsync(260);
    const entriesAtAbort = root.querySelectorAll('.afp__entry').length;
    expect(entriesAtAbort).toBeGreaterThanOrEqual(1);
    expect(entriesAtAbort).toBeLessThan(3);

    tl.kill();
    scene.cleanup(ctx); // sets abortedFlag.aborted = true and removes the root

    // Drain remaining timers: the loop checks the abort flag at the top of
    // every iteration, so it must not add more entries or any payoff rows.
    await vi.advanceTimersByTimeAsync(8000);
    expect(root.querySelectorAll('.afp__entry').length).toBe(entriesAtAbort);
    expect(root.querySelectorAll('.afp__payoff-key')).toHaveLength(0);
  });

  it('cleanup aborts the loop AND removes the scene root from the stage', async () => {
    vi.useFakeTimers();
    const stage = makeStage();
    const ctx = ctxOf(stage);
    const scene = activityFeedPayoff('afp-cleanup', {
      feed: [
        { type: 'search', text: 'a' },
        { type: 'read', text: 'b' },
        { type: 'think', text: 'c' },
      ],
      payoff: { rows: [{ label: 'k', value: 'v' }] },
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const root = requireRoot(stage, 'afp-cleanup');
    const tl = scene.timeline(ctx) as gsap.core.Timeline;
    tl.pause();
    tl.seek(0.001, false);
    await vi.advanceTimersByTimeAsync(260);
    const entriesAtCleanup = root.querySelectorAll('.afp__entry').length;
    expect(entriesAtCleanup).toBeGreaterThanOrEqual(1);

    tl.kill();
    scene.cleanup(ctx); // aborts session + removes root (lines 107-114)

    // Root is gone from the stage.
    expect(stage.querySelector('[data-pulsar-template="afp-cleanup"]')).toBeNull();
    expect(stage.children).toHaveLength(0);

    // The aborted loop must not keep appending to the now-detached root.
    await vi.advanceTimersByTimeAsync(8000);
    expect(root.querySelectorAll('.afp__entry').length).toBe(entriesAtCleanup);
    expect(root.querySelectorAll('.afp__payoff-key')).toHaveLength(0);
  });

  it('cleanup before the timeline plays still removes the mounted root (no session)', () => {
    const stage = makeStage();
    const ctx = ctxOf(stage);
    const scene = activityFeedPayoff('afp-early-cleanup', {
      feed: [{ type: 'search', text: 'q' }],
      payoff: { rows: [{ label: 'k', value: 'v' }] },
    });
    scene.create(ctx);
    expect(stage.querySelector('[data-pulsar-template="afp-early-cleanup"]')).not.toBeNull();
    // No timeline() / play() was ever invoked, so no session exists; cleanup
    // must still detach the root without throwing (lines 108-113).
    expect(() => scene.cleanup(ctx)).not.toThrow();
    expect(stage.querySelector('[data-pulsar-template="afp-early-cleanup"]')).toBeNull();
  });
});
