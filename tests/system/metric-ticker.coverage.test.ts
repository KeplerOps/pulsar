/** @vitest-environment happy-dom */
// Pulsar L2 — metricTicker behavioral coverage.
//
// Exercises the metric-ticker template's whole intended surface against
// a real (happy-dom) document:
//   - metric row rendering in `create` (eyebrow branch, heading, ticker
//     container, per-metric <article> w/ direction class + delay style,
//     label/value/direction children, initial formatted value);
//   - `applyTickerFrame` — the per-tick DOM mutation driven by the
//     interval callback (up/down direction, prefix/suffix formatting,
//     the Math.max(0,…) clamp, rounding, the `data-metric`-indexed read,
//     and the undefined-metric skip branch);
//   - the authored timeline (named `ticker-in` label, segment duration
//     scaling with metric count, activation marker flipping on play and
//     back off on the trailing tween);
//   - cleanup removing the scene root AND stopping the interval.
//
// Ticks are driven with fake timers so the interval callback fires
// deterministically and the resulting textContent is exactly assertable.

import { gsap } from 'gsap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSceneModule } from '../../src/runtime/scene';
import { metricTicker } from '../../src/system/templates';

const makeStage = (): HTMLElement => document.createElement('div');
const ctx = (stage: HTMLElement): unknown => ({ stage, mode: 'present', gsap });

const requireNode = <T extends Element>(node: T | null, message: string): T => {
  if (node === null) throw new Error(message);
  return node;
};

const getRoot = (stage: HTMLElement, id: string): HTMLElement =>
  requireNode(
    stage.querySelector<HTMLElement>(`[data-pulsar-template="${id}"]`),
    `expected ${id} root`,
  );

/** Read the current displayed value of every [data-metric] cell, in DOM order. */
const metricValues = (root: HTMLElement): string[] =>
  [...root.querySelectorAll<HTMLElement>('[data-metric]')].map((n) => n.textContent ?? '');

describe('metricTicker — behavioral coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the full metric-row DOM on create (eyebrow, heading, ticker, per-metric article)', () => {
    const scene = metricTicker('mt-render', {
      eyebrow: 'Live numbers',
      title: 'Throughput',
      metrics: [
        { label: 'Requests', direction: 'up', start: 10, step: 5 },
        { label: 'Errors', direction: 'down', start: 100, step: 3, prefix: '$', suffix: 'k' },
      ],
    });
    expect(() => assertSceneModule(scene)).not.toThrow();
    expect(scene.title).toBe('Metric ticker — Throughput');

    const stage = makeStage();
    scene.create(ctx(stage));
    const root = getRoot(stage, 'mt-render');

    // Root carries the template kind class.
    expect(root.classList.contains('pulsar-template--metric-ticker')).toBe(true);
    expect(root.dataset.pulsarTemplateActive).toBe('false');

    // Eyebrow branch rendered.
    const eyebrow = requireNode(root.querySelector('.eyebrow'), 'expected eyebrow');
    expect(eyebrow.textContent).toBe('Live numbers');

    // Heading.
    const heading = requireNode(root.querySelector('h2.heading'), 'expected heading');
    expect(heading.tagName).toBe('H2');
    expect(heading.textContent).toBe('Throughput');

    // Ticker container holds one <article> per metric.
    const ticker = requireNode(root.querySelector('.ticker'), 'expected ticker');
    const articles = [...ticker.querySelectorAll<HTMLElement>('article')];
    expect(articles).toHaveLength(2);

    // First metric: direction class 'up', staggered delay, label/value/direction.
    const [up, down] = articles;
    if (up === undefined || down === undefined) throw new Error('expected two articles');
    expect(up.classList.contains('up')).toBe(true);
    expect(up.getAttribute('style')).toBe('--metric-delay: 400ms');
    expect(requireNode(up.querySelector('.label'), 'label').textContent).toBe('Requests');
    const upVal = requireNode(up.querySelector('.value'), 'value');
    expect(upVal.tagName).toBe('SPAN');
    expect(upVal.getAttribute('data-metric')).toBe('0');
    expect(upVal.textContent).toBe('10');
    expect(requireNode(up.querySelector('.direction'), 'direction').textContent).toBe('Increasing');

    // Second metric: direction class 'down', delay offset by 160ms, prefix/suffix on the value.
    expect(down.classList.contains('down')).toBe(true);
    expect(down.getAttribute('style')).toBe('--metric-delay: 560ms');
    const downVal = requireNode(down.querySelector('.value'), 'value');
    expect(downVal.getAttribute('data-metric')).toBe('1');
    expect(downVal.textContent).toBe('$100k');
    expect(requireNode(down.querySelector('.direction'), 'direction').textContent).toBe(
      'Decreasing',
    );
  });

  it('omits the eyebrow node when no eyebrow is supplied', () => {
    const scene = metricTicker('mt-no-eb', {
      title: 'Bare',
      metrics: [{ label: 'A', direction: 'up', start: 0, step: 1 }],
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = getRoot(stage, 'mt-no-eb');
    expect(root.querySelector('.eyebrow')).toBeNull();
    // Heading is the first child when no eyebrow precedes it.
    expect(root.firstElementChild?.classList.contains('heading')).toBe(true);
  });

  it('applyTickerFrame advances each metric per interval tick (up increments, down decrements w/ prefix+suffix)', () => {
    const scene = metricTicker('mt-tick', {
      title: 'Counters',
      metrics: [
        { label: 'Up', direction: 'up', start: 10, step: 5 },
        { label: 'Down', direction: 'down', start: 100, step: 3, prefix: '$', suffix: 'k' },
      ],
      tickMs: 100,
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = getRoot(stage, 'mt-tick');

    // Initial frame (rendered by create, before any tick).
    expect(metricValues(root)).toEqual(['10', '$100k']);

    // One tick: up = 10 + 5*1 = 15; down = 100 - 3*1 = 97.
    vi.advanceTimersByTime(100);
    expect(metricValues(root)).toEqual(['15', '$97k']);

    // Three ticks total: up = 10 + 5*3 = 25; down = 100 - 3*3 = 91.
    vi.advanceTimersByTime(200);
    expect(metricValues(root)).toEqual(['25', '$91k']);

    scene.cleanup(ctx(stage));
  });

  it('clamps decreasing metrics at zero (Math.max) and rounds fractional steps', () => {
    const scene = metricTicker('mt-clamp', {
      title: 'Edge',
      metrics: [
        // Decreasing past zero must clamp to 0, never go negative.
        { label: 'Drain', direction: 'down', start: 5, step: 4 },
        // Fractional step exercises Math.round on the displayed value.
        { label: 'Frac', direction: 'up', start: 0, step: 0.5 },
      ],
      tickMs: 50,
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = getRoot(stage, 'mt-clamp');

    expect(metricValues(root)).toEqual(['5', '0']);

    // tick 1: drain = 5 - 4 = 1; frac = round(0.5) = 1 (round-half-up).
    vi.advanceTimersByTime(50);
    expect(metricValues(root)).toEqual(['1', '1']);

    // tick 2: drain = 5 - 8 = -3 -> clamp 0; frac = round(1.0) = 1.
    vi.advanceTimersByTime(50);
    expect(metricValues(root)).toEqual(['0', '1']);

    // tick 3: drain stays clamped at 0; frac = round(1.5) = 2.
    vi.advanceTimersByTime(50);
    expect(metricValues(root)).toEqual(['0', '2']);

    scene.cleanup(ctx(stage));
  });

  it('applyTickerFrame reads the data-metric index, not DOM order, to pick its spec', () => {
    const scene = metricTicker('mt-index', {
      title: 'Indexed',
      metrics: [
        { label: 'M0', direction: 'up', start: 0, step: 1 },
        { label: 'M1', direction: 'up', start: 1000, step: 10 },
      ],
      tickMs: 25,
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = getRoot(stage, 'mt-index');

    // Swap the rendered data-metric indices: the first cell now claims to
    // be metric 1, the second claims metric 0. applyTickerFrame must use
    // the attribute (Number(idx)) to choose the spec, so the values follow
    // the attribute, not the DOM position.
    const cells = [...root.querySelectorAll<HTMLElement>('[data-metric]')];
    const [first, second] = cells;
    if (first === undefined || second === undefined) throw new Error('expected two cells');
    first.setAttribute('data-metric', '1');
    second.setAttribute('data-metric', '0');

    // tick 1: first cell -> metric[1] = 1000 + 10 = 1010; second -> metric[0] = 0 + 1 = 1.
    vi.advanceTimersByTime(25);
    expect(first.textContent).toBe('1010');
    expect(second.textContent).toBe('1');

    scene.cleanup(ctx(stage));
  });

  it('applyTickerFrame skips cells whose data-metric index has no matching spec', () => {
    const scene = metricTicker('mt-skip', {
      title: 'Skip',
      metrics: [{ label: 'Only', direction: 'up', start: 5, step: 2 }],
      tickMs: 30,
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = getRoot(stage, 'mt-skip');

    // Inject an extra cell pointing at an out-of-range index (no spec at 9).
    const ticker = requireNode(root.querySelector('.ticker'), 'ticker');
    const orphan = document.createElement('span');
    orphan.className = 'value';
    orphan.setAttribute('data-metric', '9');
    orphan.textContent = 'UNTOUCHED';
    ticker.appendChild(orphan);

    vi.advanceTimersByTime(30);

    // The real metric advanced; the orphan (undefined spec) was skipped.
    expect(requireNode(root.querySelector('[data-metric="0"]'), 'm0').textContent).toBe('7');
    expect(orphan.textContent).toBe('UNTOUCHED');

    scene.cleanup(ctx(stage));
  });

  it('builds a timeline with the ticker-in label and a metric-count-scaled segment', () => {
    const metrics = [
      { label: 'A', direction: 'up' as const, start: 0, step: 1 },
      { label: 'B', direction: 'up' as const, start: 0, step: 1 },
      { label: 'C', direction: 'up' as const, start: 0, step: 1 },
    ];
    const scene = metricTicker('mt-tl', { title: 'TL', metrics });
    expect(scene.captions).toEqual([{ at: 'ticker-in', text: 'TL' }]);

    const stage = makeStage();
    scene.create(ctx(stage));
    const root = getRoot(stage, 'mt-tl');
    expect(root.dataset.pulsarTemplateActive).toBe('false');

    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    expect(tl).not.toBeNull();

    // Named beat the deck/caption track references.
    expect(tl.labels['ticker-in']).toBe(0.5);

    // Activation marker flips true once the leading tl.call has run.
    tl.progress(0.2);
    expect(root.dataset.pulsarTemplateActive).toBe('true');

    // ADR-032: reaching the natural end no longer deactivates the root —
    // the run-loop holds for advance; teardown is the scene's cleanup job.
    tl.progress(1);
    expect(root.dataset.pulsarTemplateActive).toBe('true');

    // Segment body duration scales with metric count: 1 + 3*0.16 = 1.48,
    // plus the leading activation and the 2s suffix. Assert the body segment
    // is reflected by the total exceeding the count-scaled minimum and that
    // more metrics => longer body.
    const longer = metricTicker('mt-tl2', {
      title: 'TL2',
      metrics: [...metrics, { label: 'D', direction: 'up' as const, start: 0, step: 1 }],
    });
    longer.create(ctx(stage));
    const tl2 = longer.timeline(ctx(stage)) as gsap.core.Timeline;
    expect(tl2.duration()).toBeGreaterThan(tl.duration());
    expect(tl2.duration() - tl.duration()).toBeCloseTo(0.16, 5);

    tl.kill();
    tl2.kill();
  });

  it('cleanup removes the scene root and stops the interval so no further ticks land', () => {
    const scene = metricTicker('mt-clean', {
      title: 'Stop',
      metrics: [{ label: 'A', direction: 'up', start: 0, step: 1 }],
      tickMs: 40,
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = getRoot(stage, 'mt-clean');

    vi.advanceTimersByTime(40);
    expect(root.textContent).toContain('1');

    // Cleanup tears down the root and the interval.
    scene.cleanup(ctx(stage));
    expect(stage.querySelector('[data-pulsar-template="mt-clean"]')).toBeNull();

    // Advancing time after cleanup must NOT throw or re-tick: the detached
    // root would otherwise be mutated. The interval was stopped, so the
    // pending timers count is zero.
    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });

  it('uses the default 860ms tick cadence when tickMs is omitted', () => {
    const scene = metricTicker('mt-default', {
      title: 'Default',
      metrics: [{ label: 'A', direction: 'up', start: 0, step: 7 }],
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = getRoot(stage, 'mt-default');

    // Just before the default interval elapses: still initial value.
    vi.advanceTimersByTime(859);
    expect(requireNode(root.querySelector('[data-metric="0"]'), 'm0').textContent).toBe('0');

    // At 860ms the first tick lands: 0 + 7*1 = 7.
    vi.advanceTimersByTime(1);
    expect(requireNode(root.querySelector('[data-metric="0"]'), 'm0').textContent).toBe('7');

    scene.cleanup(ctx(stage));
  });

  it('off-DOM ctx (null stage) renders nothing and create starts no interval', () => {
    const scene = metricTicker('mt-null', {
      title: 'NoStage',
      metrics: [{ label: 'A', direction: 'up', start: 0, step: 1 }],
    });
    const nullCtx = { stage: null, mode: 'present', gsap };
    expect(() => scene.create(nullCtx)).not.toThrow();
    // mountTemplateRoot returned null, so the interval was never started.
    expect(vi.getTimerCount()).toBe(0);
    expect(scene.timeline(nullCtx)).toBeNull();
    expect(() => scene.cleanup(nullCtx)).not.toThrow();
  });
});
