// Pulsar L2 — transitions registry + composer wiring tests.
//
// Verifies:
//   1. Each shipped transition reports the expected name + default
//      duration and consumes the expected master-time.
//   2. composeMasterTimeline (when given a registry + overlay)
//      inserts a transition tween before scene N when the manifest
//      entry declares `behavior.transition: { name }`.
//   3. The composer ignores transition declarations without a
//      registered name (graceful degradation, not a throw).
//   4. The composer is unchanged when no registry is supplied
//      (backward compat — existing tests still green).
//
// Uses the real `gsap` engine — tests rely on actual nested-timeline
// composition behavior, not a fake.

import { gsap } from 'gsap';
import { describe, expect, it } from 'vitest';
import { composeMasterTimeline, createTimelineEngine } from '../../src/runtime/timeline';
import {
  ALL_TRANSITIONS,
  cut,
  defaultTransitions,
  dissolve,
  hardSlam,
  holdOnBlack,
  push,
} from '../../src/system/transitions';

const tinyTimeline = (): gsap.core.Timeline => {
  const tl = gsap.timeline({ paused: true });
  tl.to({}, { duration: 0.1 });
  return tl;
};

describe('shipped transitions', () => {
  it('cut consumes zero master-time', () => {
    expect(cut.name).toBe('cut');
    expect(cut.defaultDurationMs).toBe(0);
  });

  it('dissolve / hard-slam / hold-on-black / push declare positive default durations', () => {
    for (const t of [dissolve, hardSlam, holdOnBlack, push]) {
      expect(t.defaultDurationMs).toBeGreaterThan(0);
    }
  });

  it('every transition is registered in defaultTransitions()', () => {
    const reg = defaultTransitions();
    for (const t of ALL_TRANSITIONS) {
      expect(reg.get(t.name)).toBe(t);
    }
  });
});

describe('composeMasterTimeline + transitions registry', () => {
  it('inserts dissolve duration into master-time between scenes when behavior.transition is declared', () => {
    const engine = createTimelineEngine();
    const overlay = { value: 0 } as unknown as HTMLElement;
    const segments = [
      { id: 'a', timeline: tinyTimeline() },
      {
        id: 'b',
        timeline: tinyTimeline(),
        behavior: { transition: { name: 'dissolve', durationMs: 400 } },
      },
    ];
    const master = composeMasterTimeline(engine, segments, {
      transitions: defaultTransitions(),
      transitionOverlay: overlay,
    });
    // First scene: 0.1s. Dissolve: 0.4s. Second scene: 0.1s.
    expect(master.duration()).toBeCloseTo(0.6, 1);
    master.kill();
  });

  it('uses the transition default duration when behavior.transition.durationMs is absent', () => {
    const engine = createTimelineEngine();
    const overlay = { value: 0 } as unknown as HTMLElement;
    const segments = [
      { id: 'a', timeline: tinyTimeline() },
      { id: 'b', timeline: tinyTimeline(), behavior: { transition: { name: 'dissolve' } } },
    ];
    const master = composeMasterTimeline(engine, segments, {
      transitions: defaultTransitions(),
      transitionOverlay: overlay,
    });
    // First 0.1s + dissolve default 0.5s + 0.1s = 0.7s.
    expect(master.duration()).toBeCloseTo(0.7, 1);
    master.kill();
  });

  it('ignores transition declarations whose name is not registered', () => {
    const engine = createTimelineEngine();
    const overlay = { value: 0 } as unknown as HTMLElement;
    const segments = [
      { id: 'a', timeline: tinyTimeline() },
      { id: 'b', timeline: tinyTimeline(), behavior: { transition: { name: 'nonsense' } } },
    ];
    const master = composeMasterTimeline(engine, segments, {
      transitions: defaultTransitions(),
      transitionOverlay: overlay,
    });
    // No transition inserted: total ≈ 0.2s.
    expect(master.duration()).toBeCloseTo(0.2, 1);
    master.kill();
  });

  it('skips transition insertion when no registry is supplied (backward compat)', () => {
    const engine = createTimelineEngine();
    const segments = [
      { id: 'a', timeline: tinyTimeline() },
      { id: 'b', timeline: tinyTimeline(), behavior: { transition: { name: 'dissolve' } } },
    ];
    const master = composeMasterTimeline(engine, segments);
    expect(master.duration()).toBeCloseTo(0.2, 1);
    master.kill();
  });

  it('does not insert a transition before the first scene', () => {
    const engine = createTimelineEngine();
    const overlay = { value: 0 } as unknown as HTMLElement;
    const segments = [
      { id: 'a', timeline: tinyTimeline(), behavior: { transition: { name: 'dissolve' } } },
      { id: 'b', timeline: tinyTimeline() },
    ];
    const master = composeMasterTimeline(engine, segments, {
      transitions: defaultTransitions(),
      transitionOverlay: overlay,
    });
    // No transition before scene a (which is first). Total = 0.2s.
    expect(master.duration()).toBeCloseTo(0.2, 1);
    master.kill();
  });

  it('cut transition consumes zero master-time even when declared', () => {
    const engine = createTimelineEngine();
    const overlay = { value: 0 } as unknown as HTMLElement;
    const segments = [
      { id: 'a', timeline: tinyTimeline() },
      { id: 'b', timeline: tinyTimeline(), behavior: { transition: { name: 'cut' } } },
    ];
    const master = composeMasterTimeline(engine, segments, {
      transitions: defaultTransitions(),
      transitionOverlay: overlay,
    });
    expect(master.duration()).toBeCloseTo(0.2, 1);
    master.kill();
  });
});
