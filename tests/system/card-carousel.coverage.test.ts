/** @vitest-environment happy-dom */
// Pulsar L2 template — cardCarousel behavioral coverage.
//
// templates.test.ts smoke-tests the minimal path; templates-options.test.ts
// flips the eyebrow branch. Neither drives the async card-cycling loop
// (`play`, src/system/templates/card-carousel.ts:90-124) nor asserts the
// per-card DOM the carousel actually renders. This file does:
//
//   * create()  — eyebrow branch on/off + the persistent `cc__stage`.
//   * timeline() — the `play` callback fires the FIRST card synchronously
//     (it runs up to the first `await aSleep`), and the authored beat
//     label `cc-in` plus the activation marker flip are asserted on the
//     real timeline / real DOM.
//   * play()    — every per-card content branch (headline always; `sub`
//     and `src` only when present), the single-card-at-a-time invariant
//     (`stage.innerHTML = ''`), and advancement after the dwell.
//   * abort     — both the onDeactivate (timeline completion) and cleanup
//     paths set the abort flag so the loop stops mutating the stage; the
//     cleanup path also removes the scene root.
//
// All assertions run against the real happy-dom document — no fakes.

import { gsap } from 'gsap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSceneModule } from '../../src/runtime/scene';
import { cardCarousel } from '../../src/system/templates';

const makeStage = (): HTMLElement => document.createElement('div');
const ctx = (stage: HTMLElement): unknown => ({ stage, mode: 'present', gsap });

const requireEl = (node: Element | null, message: string): HTMLElement => {
  if (node === null) throw new Error(message);
  return node as HTMLElement;
};

const rootIn = (stage: HTMLElement, id: string): HTMLElement =>
  requireEl(
    stage.querySelector(`[data-pulsar-template="${id}"]`),
    `expected card-carousel root ${id}`,
  );

const stageEl = (root: HTMLElement): HTMLElement =>
  requireEl(root.querySelector('[data-cc-stage]'), 'expected cc__stage');

/** Microtask drain so the async `play` loop progresses after a timer tick. */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('cardCarousel — behavioral coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a valid scene module and authors one caption per card pinned to card-<i>', () => {
    const scene = cardCarousel('cc-captions', {
      cards: [{ headline: 'First' }, { headline: 'Second' }, { headline: 'Third' }],
    });
    expect(() => assertSceneModule(scene)).not.toThrow();
    expect(scene.title).toBe('Card carousel');
    // One caption per card, anchored to a card-<index> beat, text = headline.
    expect(scene.captions.map((c) => c.at)).toEqual(['card-0', 'card-1', 'card-2']);
    expect(scene.captions.map((c) => c.text)).toEqual(['First', 'Second', 'Third']);
  });

  it('create renders the eyebrow + the persistent stage; root starts inactive', () => {
    const stage = makeStage();
    const scene = cardCarousel('cc-eyebrow', {
      eyebrow: 'BREAKING',
      cards: [{ headline: 'A' }],
    });
    scene.create(ctx(stage));
    const root = rootIn(stage, 'cc-eyebrow');

    // Template-kind class is applied (CSS hook).
    expect(root.className).toContain('pulsar-template--card-carousel');
    // Mount starts inactive; the timeline flips it on activation.
    expect(root.dataset.pulsarTemplateActive).toBe('false');

    const eyebrow = requireEl(root.querySelector('.cc__eyebrow'), 'expected eyebrow');
    expect(eyebrow.tagName).toBe('P');
    expect(eyebrow.textContent).toBe('BREAKING');

    const cardStage = stageEl(root);
    expect(cardStage.tagName).toBe('DIV');
    expect(cardStage.classList.contains('cc__stage')).toBe(true);
    // Stage is empty until the timeline's play() callback fires.
    expect(cardStage.children).toHaveLength(0);

    scene.cleanup(ctx(stage));
  });

  it('create omits the eyebrow element entirely when eyebrow is not supplied', () => {
    const stage = makeStage();
    const scene = cardCarousel('cc-no-eyebrow', {
      cards: [{ headline: 'A' }],
    });
    scene.create(ctx(stage));
    const root = rootIn(stage, 'cc-no-eyebrow');
    expect(root.querySelector('.cc__eyebrow')).toBeNull();
    // The stage still mounts.
    expect(root.querySelector('[data-cc-stage]')).not.toBeNull();
    scene.cleanup(ctx(stage));
  });

  it('timeline authors the cc-in beat at 0 and activates the root on play', () => {
    const stage = makeStage();
    const scene = cardCarousel('cc-tl', {
      dwellMs: 200,
      cards: [{ headline: 'A' }, { headline: 'B' }],
    });
    scene.create(ctx(stage));
    const root = rootIn(stage, 'cc-tl');
    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    expect(tl).not.toBeNull();

    // Authored beat label is present at position 0.
    expect(tl.labels['cc-in']).toBe(0);
    // Activation marker has not flipped before the timeline plays.
    expect(root.dataset.pulsarTemplateActive).toBe('false');

    // Drive the timeline to its first frame: the leading activation call
    // and the `play` callback both fire at position 0.
    tl.progress(0.001);
    expect(root.dataset.pulsarTemplateActive).toBe('true');

    tl.kill();
    scene.cleanup(ctx(stage));
  });

  it('play renders the full first-card DOM: headline + optional sub + optional src', () => {
    const stage = makeStage();
    const scene = cardCarousel('cc-card-dom', {
      dwellMs: 1000,
      cards: [
        { headline: 'Markets tumble', sub: 'Worst day in a year', src: 'wire.example' },
        { headline: 'B' },
      ],
    });
    scene.create(ctx(stage));
    const root = rootIn(stage, 'cc-card-dom');
    const cardStage = stageEl(root);
    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    // Fire the play callback (renders the first card synchronously, up to
    // the first `await aSleep`).
    tl.progress(0.001);

    const card = requireEl(cardStage.querySelector('.cc__card'), 'expected card article');
    expect(card.tagName).toBe('ARTICLE');
    // Enter-animation hook class is applied on render.
    expect(card.classList.contains('cc__card--enter')).toBe(true);

    const headline = requireEl(card.querySelector('.cc__headline'), 'expected headline');
    expect(headline.tagName).toBe('H2');
    expect(headline.textContent).toBe('Markets tumble');

    const sub = requireEl(card.querySelector('.cc__sub'), 'expected sub');
    expect(sub.tagName).toBe('P');
    expect(sub.textContent).toBe('Worst day in a year');

    const src = requireEl(card.querySelector('.cc__src'), 'expected src');
    expect(src.tagName).toBe('P');
    expect(src.textContent).toBe('wire.example');

    // Exactly one card on stage at a time.
    expect(cardStage.querySelectorAll('.cc__card')).toHaveLength(1);

    tl.kill();
    scene.cleanup(ctx(stage));
  });

  it('play omits sub and src when a card supplies only a headline', () => {
    const stage = makeStage();
    const scene = cardCarousel('cc-bare-card', {
      dwellMs: 1000,
      cards: [{ headline: 'Bare' }],
    });
    scene.create(ctx(stage));
    const root = rootIn(stage, 'cc-bare-card');
    const cardStage = stageEl(root);
    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    tl.progress(0.001);

    const card = requireEl(cardStage.querySelector('.cc__card'), 'expected card');
    expect(requireEl(card.querySelector('.cc__headline'), 'headline').textContent).toBe('Bare');
    // Optional branches did not render.
    expect(card.querySelector('.cc__sub')).toBeNull();
    expect(card.querySelector('.cc__src')).toBeNull();
    // The article contains only the headline child.
    expect(card.children).toHaveLength(1);

    tl.kill();
    scene.cleanup(ctx(stage));
  });

  it('play advances to the next card after the dwell and keeps one card on stage', async () => {
    const stage = makeStage();
    const scene = cardCarousel('cc-advance', {
      dwellMs: 80,
      cards: [
        { headline: 'Card-One', sub: 'one-sub' },
        { headline: 'Card-Two', src: 'two-src' },
      ],
    });
    scene.create(ctx(stage));
    const root = rootIn(stage, 'cc-advance');
    const cardStage = stageEl(root);
    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    tl.progress(0.001);

    // First card rendered synchronously.
    expect(requireEl(cardStage.querySelector('.cc__headline'), 'h1').textContent).toBe('Card-One');
    expect(cardStage.querySelector('.cc__sub')?.textContent).toBe('one-sub');
    expect(cardStage.querySelector('.cc__src')).toBeNull();

    // Elapse the per-card dwell — the loop resolves and renders card two.
    await vi.advanceTimersByTimeAsync(90);
    await flushMicrotasks();

    expect(requireEl(cardStage.querySelector('.cc__headline'), 'h2').textContent).toBe('Card-Two');
    expect(cardStage.querySelector('.cc__src')?.textContent).toBe('two-src');
    // Card two has no sub; previous card's DOM was cleared (innerHTML = '').
    expect(cardStage.querySelector('.cc__sub')).toBeNull();
    // Single-card invariant holds across the advance.
    expect(cardStage.querySelectorAll('.cc__card')).toHaveLength(1);

    tl.kill();
    scene.cleanup(ctx(stage));
  });

  it('honors per-card dwell overrides over the carousel-level dwell', async () => {
    const stage = makeStage();
    const scene = cardCarousel('cc-percard', {
      dwellMs: 5000, // long carousel default
      cards: [
        { headline: 'Quick', dwellMs: 40 }, // short per-card override
        { headline: 'Next' },
      ],
    });
    scene.create(ctx(stage));
    const root = rootIn(stage, 'cc-percard');
    const cardStage = stageEl(root);
    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    tl.progress(0.001);

    expect(requireEl(cardStage.querySelector('.cc__headline'), 'first').textContent).toBe('Quick');

    // 50ms < 5000ms default, but > 40ms override — so we DO advance, proving
    // the per-card dwellMs took precedence.
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    expect(requireEl(cardStage.querySelector('.cc__headline'), 'second').textContent).toBe('Next');

    tl.kill();
    scene.cleanup(ctx(stage));
  });

  it('the dwell sum drives the timeline segment length (longer dwell => longer timeline)', () => {
    const stageShort = makeStage();
    const short = cardCarousel('cc-dur-short', {
      dwellMs: 1000,
      cards: [{ headline: 'A' }, { headline: 'B' }],
    });
    short.create(ctx(stageShort));
    const shortTl = short.timeline(ctx(stageShort)) as gsap.core.Timeline;

    const stageLong = makeStage();
    const long = cardCarousel('cc-dur-long', {
      dwellMs: 9000,
      cards: [{ headline: 'A' }, { headline: 'B' }],
    });
    long.create(ctx(stageLong));
    const longTl = long.timeline(ctx(stageLong)) as gsap.core.Timeline;

    // Total dwell: short = 2x1000ms = 2s; long = 2x9000ms = 18s. The carousel
    // segment runs for max(1, totalMs/1000) seconds, so the longer config has
    // a strictly longer timeline.
    expect(longTl.duration()).toBeGreaterThan(shortTl.duration());
    expect(longTl.duration() - shortTl.duration()).toBeCloseTo(16, 1);

    shortTl.kill();
    longTl.kill();
    short.cleanup(ctx(stageShort));
    long.cleanup(ctx(stageLong));
  });

  it('cleanup aborts the card loop so it stops advancing (ADR-032 teardown in cleanup)', async () => {
    const stage = makeStage();
    const scene = cardCarousel('cc-deactivate', {
      dwellMs: 60,
      cards: [{ headline: 'Alpha' }, { headline: 'Bravo' }, { headline: 'Charlie' }],
    });
    scene.create(ctx(stage));
    const root = rootIn(stage, 'cc-deactivate');
    const cardStage = stageEl(root);
    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    tl.progress(0.001);
    expect(requireEl(cardStage.querySelector('.cc__headline'), 'first').textContent).toBe('Alpha');

    // Reaching the natural end no longer deactivates the root — the run-loop
    // holds for advance; the root stays active.
    tl.progress(1, false);
    expect(root.dataset.pulsarTemplateActive).toBe('true');
    tl.kill();

    // The run-loop calls cleanup on scene exit; that sets the abort flag.
    scene.cleanup(ctx(stage));

    // Even though the dwell elapses, the aborted loop must NOT advance, and
    // the root was removed by cleanup.
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    expect(stage.querySelector('[data-pulsar-template="cc-deactivate"]')).toBeNull();
  });

  it('cleanup aborts the loop and removes the scene root', async () => {
    const stage = makeStage();
    const scene = cardCarousel('cc-cleanup', {
      dwellMs: 50,
      cards: [{ headline: 'One' }, { headline: 'Two' }, { headline: 'Three' }],
    });
    scene.create(ctx(stage));
    const root = rootIn(stage, 'cc-cleanup');
    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    tl.progress(0.001);
    expect(stageEl(root).querySelector('.cc__headline')?.textContent).toBe('One');

    tl.kill();
    scene.cleanup(ctx(stage));

    // Root removed immediately.
    expect(stage.querySelector('[data-pulsar-template="cc-cleanup"]')).toBeNull();

    // The detached stage must not be mutated by a still-pending dwell: the
    // abort flag stopped the loop, so no further card renders into it.
    const detached = stageEl(root);
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    expect(detached.querySelector('.cc__headline')?.textContent).toBe('One');
    // Root stays removed.
    expect(stage.querySelector('[data-pulsar-template="cc-cleanup"]')).toBeNull();
  });

  it('falls back to the 5000ms default dwell when no dwell is configured', async () => {
    const stage = makeStage();
    const scene = cardCarousel('cc-default-dwell', {
      // No carousel dwellMs and no per-card dwellMs — exercises the
      // `?? 5000` fallback in both the timeline sum and the play loop.
      cards: [{ headline: 'Slow-A' }, { headline: 'Slow-B' }],
    });
    scene.create(ctx(stage));
    const root = rootIn(stage, 'cc-default-dwell');
    const cardStage = stageEl(root);
    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;

    // Two cards x 5000ms default = 10s => max(1, 10) = 10s carousel segment,
    // which dominates the timeline duration.
    expect(tl.duration()).toBeGreaterThanOrEqual(10);

    tl.progress(0.001);
    expect(requireEl(cardStage.querySelector('.cc__headline'), 'first').textContent).toBe('Slow-A');

    // Well under the 5000ms default — the loop must NOT have advanced yet.
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(requireEl(cardStage.querySelector('.cc__headline'), 'still-first').textContent).toBe(
      'Slow-A',
    );

    tl.kill();
    scene.cleanup(ctx(stage));
  });

  it('returns null timeline + no-throw cleanup when the runtime has no stage (off-DOM)', () => {
    const scene = cardCarousel('cc-no-stage', { cards: [{ headline: 'A' }] });
    const offDom = { stage: null, mode: 'present', gsap };
    expect(() => scene.create(offDom)).not.toThrow();
    expect(scene.timeline(offDom)).toBeNull();
    expect(() => scene.cleanup(offDom)).not.toThrow();
  });
});
