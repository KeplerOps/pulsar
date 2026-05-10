// Tests for the GSAP timeline adapter — PUL-F022 / ADR-025.
//
// Coverage map (requirement clauses):
//  - C1 "Each scene SHALL produce a timeline": `createTimelineEngine`
//    exposes `gsap` for `ctx.gsap`; `assertSceneTimeline` validates the
//    value a scene's `timeline(ctx)` returns.
//  - C2 "the runtime composes into a master timeline for the active
//    composition": `composeMasterTimeline` nests scene timelines into a
//    master with namespaced labels; `createGsapCompositionTimeline` is
//    the composition-level adapter the resolver drives.
//  - C3 "SHALL support play, pause, seek, speed change, and named
//    labels": the `MasterTimeline` controller.
//
// GSAP runs in the `node` test environment: timeline math, labels,
// seeking, and timeScale need no DOM. Tests that call `play()` always
// abort the navigation signal so the GSAP ticker goes back to sleep and
// the process exits cleanly.

import { describe, expect, it, vi } from 'vitest';
import type {
  CompositionTimelineRunOptions,
  SceneTimelineSegment,
} from '../../src/runtime/composition-resolver';
import { resolveComposition } from '../../src/runtime/composition-resolver';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { SceneModule } from '../../src/runtime/scene';
import {
  type MasterTimeline,
  SceneTimelineTypeError,
  TimelineSeekError,
  TimelineSpeedError,
  assertSceneTimeline,
  composeMasterTimeline,
  createGsapCompositionTimeline,
  createTimelineEngine,
  sceneSegmentLabel,
  sceneTimelineLabel,
} from '../../src/runtime/timeline';

const engine = createTimelineEngine();
const { gsap } = engine;

/** A scene timeline of `seconds` duration (one no-op tween on a plain object). */
const sceneTl = (seconds: number, labels: Record<string, number> = {}) => {
  const tl = gsap.timeline({ paused: true });
  tl.to({ v: 0 }, { v: 1, duration: seconds });
  for (const [name, at] of Object.entries(labels)) tl.addLabel(name, at);
  return tl;
};

const segment = (id: string, timeline: unknown): SceneTimelineSegment => ({ id, timeline });

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const stubScene = (
  id: string,
  hooks: Partial<Pick<SceneModule, 'create' | 'timeline' | 'cleanup'>> = {},
): SceneModule => ({
  id,
  title: id,
  duration: null,
  tags: [],
  assets: [],
  captions: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  create: hooks.create ?? ((): void => undefined),
  timeline: hooks.timeline ?? ((): null => null),
  cleanup: hooks.cleanup ?? ((): void => undefined),
});

describe('createTimelineEngine', () => {
  it('exposes the gsap instance scenes receive as ctx.gsap', () => {
    expect(engine.gsap).toBeTruthy();
    expect(engine.gsap.timeline).toBeTypeOf('function');
    expect(engine.gsap.core.Timeline).toBeTypeOf('function');
    const tl = engine.gsap.timeline({ paused: true });
    expect(tl).toBeInstanceOf(engine.gsap.core.Timeline);
    tl.kill();
  });

  it('returns a stable engine handle each call', () => {
    expect(createTimelineEngine().gsap).toBe(createTimelineEngine().gsap);
  });
});

describe('assertSceneTimeline', () => {
  it('accepts a GSAP timeline', () => {
    const tl = sceneTl(1);
    expect(() => assertSceneTimeline(tl, 'scene-a')).not.toThrow();
    tl.kill();
  });

  it('accepts null and undefined as an empty (not-yet-authored) timeline', () => {
    expect(() => assertSceneTimeline(null, 'scene-a')).not.toThrow();
    expect(() => assertSceneTimeline(undefined, 'scene-a')).not.toThrow();
  });

  it('rejects a non-timeline value with the scene id in the message', () => {
    expect(() => assertSceneTimeline({}, 'scene-a')).toThrow(SceneTimelineTypeError);
    expect(() => assertSceneTimeline({}, 'scene-a')).toThrow(/scene "scene-a"/);
    expect(() => assertSceneTimeline(42, 'scene-a')).toThrow(SceneTimelineTypeError);
    expect(() => assertSceneTimeline('not-a-timeline', 'scene-a')).toThrow(SceneTimelineTypeError);
  });
});

describe('label namespacing helpers', () => {
  it('computes deterministic segment + label names', () => {
    expect(sceneSegmentLabel('intro')).toBe('intro');
    expect(sceneSegmentLabel('intro', 0)).toBe('intro');
    expect(sceneSegmentLabel('intro', 2)).toBe('intro#2');
    expect(sceneTimelineLabel('intro', 'hook')).toBe('intro:hook');
    expect(sceneTimelineLabel('intro', 'hook', 0)).toBe('intro:hook');
    expect(sceneTimelineLabel('intro', 'hook', 1)).toBe('intro#1:hook');
  });
});

describe('composeMasterTimeline', () => {
  it('composes a single scene timeline and exposes a paused master', () => {
    const master = composeMasterTimeline(engine, [segment('scene-a', sceneTl(2))]);
    expect(master.duration()).toBeCloseTo(2);
    expect(master.isPaused()).toBe(true);
    expect(master.time()).toBe(0);
    master.kill();
  });

  it('nests multiple scene timelines sequentially and accumulates duration', () => {
    const master = composeMasterTimeline(engine, [
      segment('a', sceneTl(1)),
      segment('b', sceneTl(2)),
      segment('c', sceneTl(0.5)),
    ]);
    expect(master.duration()).toBeCloseTo(3.5);
    master.kill();
  });

  it('emits a segment-start label for each scene at its master offset', () => {
    const master = composeMasterTimeline(engine, [
      segment('a', sceneTl(1)),
      segment('b', sceneTl(2)),
    ]);
    expect(master.labels.a).toBeCloseTo(0);
    expect(master.labels.b).toBeCloseTo(1);
    expect(master.hasLabel('a')).toBe(true);
    expect(master.hasLabel('b')).toBe(true);
    expect(master.hasLabel('nope')).toBe(false);
    master.kill();
  });

  it('namespaces each scene timeline label under the scene id', () => {
    const master = composeMasterTimeline(engine, [
      segment('intro', sceneTl(2, { hook: 0.5, outro: 1.5 })),
      segment('demo', sceneTl(1, { peak: 0.25 })),
    ]);
    expect(master.labels['intro:hook']).toBeCloseTo(0.5);
    expect(master.labels['intro:outro']).toBeCloseTo(1.5);
    expect(master.labels['demo:peak']).toBeCloseTo(2.25);
    expect(master.labelFor('intro', 'hook')).toBe('intro:hook');
    master.kill();
  });

  it('disambiguates repeated scene entries by 0-based occurrence index', () => {
    const master = composeMasterTimeline(engine, [
      segment('beat', sceneTl(1, { mid: 0.5 })),
      segment('gap', sceneTl(1)),
      segment('beat', sceneTl(1, { mid: 0.5 })),
    ]);
    expect(master.labels.beat).toBeCloseTo(0);
    expect(master.labels['beat#1']).toBeCloseTo(2);
    expect(master.labels['beat:mid']).toBeCloseTo(0.5);
    expect(master.labels['beat#1:mid']).toBeCloseTo(2.5);
    expect(master.labelFor('beat', 'mid', 1)).toBe('beat#1:mid');
    master.kill();
  });

  it('treats a null / undefined scene timeline as a zero-duration segment', () => {
    const master = composeMasterTimeline(engine, [
      segment('a', sceneTl(1)),
      segment('empty', null),
      segment('b', sceneTl(1)),
    ]);
    expect(master.duration()).toBeCloseTo(2);
    expect(master.labels.empty).toBeCloseTo(1);
    expect(master.labels.b).toBeCloseTo(1);
    master.kill();
  });

  it('rejects a segment whose timeline value is not a GSAP timeline', () => {
    expect(() => composeMasterTimeline(engine, [segment('a', {})])).toThrow(SceneTimelineTypeError);
  });

  it('exposes a frozen labels snapshot that does not mutate the master', () => {
    const master = composeMasterTimeline(engine, [segment('a', sceneTl(1, { mid: 0.5 }))]);
    const labels = master.labels;
    expect(Object.isFrozen(labels)).toBe(true);
    expect(() => {
      (labels as Record<string, number>).injected = 1;
    }).toThrow();
    expect(master.hasLabel('injected')).toBe(false);
    master.kill();
  });
});

describe('MasterTimeline transport', () => {
  it('play / pause toggle the paused state', () => {
    const master = composeMasterTimeline(engine, [segment('a', sceneTl(5))]);
    expect(master.isPaused()).toBe(true);
    master.play();
    expect(master.isPaused()).toBe(false);
    master.pause();
    expect(master.isPaused()).toBe(true);
    master.kill();
  });

  it('seeks by time and by named label', () => {
    const master = composeMasterTimeline(engine, [
      segment('a', sceneTl(1)),
      segment('b', sceneTl(4, { peak: 2 })),
    ]);
    master.seek(0.5);
    expect(master.time()).toBeCloseTo(0.5);
    master.seek('b:peak');
    expect(master.time()).toBeCloseTo(3);
    master.seek('b');
    expect(master.time()).toBeCloseTo(1);
    master.kill();
  });

  it('rejects a seek to an unknown label or a non-finite time', () => {
    const master = composeMasterTimeline(engine, [segment('a', sceneTl(1))]);
    expect(() => master.seek('a:ghost')).toThrow(TimelineSeekError);
    expect(() => master.seek('a:ghost')).toThrow(/a:ghost/);
    expect(() => master.seek(Number.NaN)).toThrow(TimelineSeekError);
    expect(() => master.seek(Number.POSITIVE_INFINITY)).toThrow(TimelineSeekError);
    master.kill();
  });

  it('changes speed via a validated positive multiplier', () => {
    const master = composeMasterTimeline(engine, [segment('a', sceneTl(1))]);
    expect(master.speed()).toBeCloseTo(1);
    master.setSpeed(2);
    expect(master.speed()).toBeCloseTo(2);
    master.setSpeed(0.25);
    expect(master.speed()).toBeCloseTo(0.25);
    master.kill();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s as a speed multiplier and leaves the prior rate intact', (_label, value) => {
    const master = composeMasterTimeline(engine, [segment('a', sceneTl(1))]);
    expect(() => master.setSpeed(value)).toThrow(TimelineSpeedError);
    expect(master.speed()).toBeCloseTo(1);
    master.kill();
  });

  it('rejects a non-number speed multiplier', () => {
    const master = composeMasterTimeline(engine, [segment('a', sceneTl(1))]);
    expect(() => master.setSpeed('2' as unknown as number)).toThrow(TimelineSpeedError);
    master.kill();
  });

  it('repeats the master indefinitely, and rejects a bad repeat count', () => {
    const master = composeMasterTimeline(engine, [segment('a', sceneTl(1))]);
    master.repeat(-1);
    expect(master.duration()).toBeCloseTo(1);
    expect(() => master.repeat(1.5)).toThrow(TimelineSpeedError);
    expect(() => master.repeat(-2)).toThrow(TimelineSpeedError);
    master.kill();
  });

  it('kill is idempotent', () => {
    const master = composeMasterTimeline(engine, [segment('a', sceneTl(1))]);
    master.kill();
    expect(() => master.kill()).not.toThrow();
  });
});

describe('createGsapCompositionTimeline', () => {
  /** Run the adapter, capturing the live master via `onMaster`. */
  const runWith = (
    segments: readonly SceneTimelineSegment[],
    opts: CompositionTimelineRunOptions = {},
  ): { master: () => MasterTimeline; settled: Promise<void> } => {
    let captured: MasterTimeline | null = null;
    const adapter = createGsapCompositionTimeline({
      engine,
      onMaster: (m) => {
        captured = m;
      },
    });
    const settled = adapter.run(segments, opts);
    return {
      master: () => {
        if (captured === null) throw new Error('master not captured');
        return captured;
      },
      settled,
    };
  };

  it('composes the slice into one master, plays it, and resolves on navigation abort', async () => {
    const controller = new AbortController();
    const done = vi.fn();
    const { master, settled } = runWith([segment('a', sceneTl(30)), segment('b', sceneTl(30))], {
      signal: controller.signal,
    });
    void settled.then(done);
    await flush();
    expect(master().duration()).toBeCloseTo(60);
    expect(master().isPaused()).toBe(false);
    expect(done).not.toHaveBeenCalled();
    controller.abort();
    await settled;
    expect(done).toHaveBeenCalledOnce();
  });

  it('plays a finite master to its natural end and resolves even with no abort signal wired', async () => {
    // ADR-025 codex review: a caller without a cancellation signal (a
    // test harness, an export pipeline before it owns abort) still gets
    // playback and a resolution-on-completion — not an immediate
    // resolve. A very short master keeps the test fast.
    const adapter = createGsapCompositionTimeline({ engine });
    await expect(adapter.run([segment('a', sceneTl(0.01))], {})).resolves.toBeUndefined();
  });

  it('resolves immediately with no signal when the master is held (paused) at a frame', async () => {
    const adapter = createGsapCompositionTimeline({ engine });
    await expect(
      adapter.run([segment('a', sceneTl(30))], { headHold: 'first-frame' }),
    ).resolves.toBeUndefined();
  });

  it('resolves immediately when the navigation signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = createGsapCompositionTimeline({ engine });
    await expect(
      adapter.run([segment('a', sceneTl(30))], { signal: controller.signal }),
    ).resolves.toBeUndefined();
  });

  it('rejects when a scene produced a non-timeline value', async () => {
    const adapter = createGsapCompositionTimeline({ engine });
    await expect(adapter.run([segment('a', { not: 'a timeline' })], {})).rejects.toBeInstanceOf(
      SceneTimelineTypeError,
    );
  });

  it('seeks the master to the head scene beat; a missing beat reports once and stays at frame 0', async () => {
    const c1 = new AbortController();
    const onBeatMissing = vi.fn();
    const r1 = runWith([segment('intro', sceneTl(4, { hook: 2 })), segment('demo', sceneTl(2))], {
      signal: c1.signal,
      headBeat: 'hook',
      onBeatMissing,
    });
    await flush();
    expect(onBeatMissing).not.toHaveBeenCalled();
    expect(r1.master().time()).toBeCloseTo(2, 1);
    c1.abort();
    await r1.settled;

    const c2 = new AbortController();
    const obm = vi.fn();
    const r2 = runWith([segment('intro', sceneTl(4))], {
      signal: c2.signal,
      headBeat: 'ghost',
      onBeatMissing: obm,
    });
    await flush();
    expect(obm).toHaveBeenCalledOnce();
    expect(r2.master().time()).toBeCloseTo(0, 1);
    c2.abort();
    await r2.settled;
  });

  it('holds the master paused at frame 0 under headHold; wins over headBeat with no beat lookup', async () => {
    const controller = new AbortController();
    const onBeatMissing = vi.fn();
    const { master, settled } = runWith([segment('intro', sceneTl(4, { hook: 2 }))], {
      signal: controller.signal,
      headHold: 'first-frame',
      headBeat: 'ghost',
      onBeatMissing,
    });
    await flush();
    expect(master().isPaused()).toBe(true);
    expect(master().time()).toBeCloseTo(0);
    expect(onBeatMissing).not.toHaveBeenCalled();
    controller.abort();
    await settled;
  });

  it('freezes the master at the addressed beat under headScreenshot (frame 0 with no beat)', async () => {
    const c1 = new AbortController();
    const r1 = runWith([segment('intro', sceneTl(6, { mid: 3 }))], {
      signal: c1.signal,
      headScreenshot: 'capture',
      headBeat: 'mid',
      onBeatMissing: vi.fn(),
    });
    await flush();
    expect(r1.master().isPaused()).toBe(true);
    expect(r1.master().time()).toBeCloseTo(3);
    c1.abort();
    await r1.settled;

    const c2 = new AbortController();
    const r2 = runWith([segment('intro', sceneTl(6))], {
      signal: c2.signal,
      headScreenshot: 'capture',
    });
    await flush();
    expect(r2.master().isPaused()).toBe(true);
    expect(r2.master().time()).toBeCloseTo(0);
    c2.abort();
    await r2.settled;
  });

  it('repeats the master indefinitely under headRepeat and keeps playing', async () => {
    const controller = new AbortController();
    const { master, settled } = runWith([segment('a', sceneTl(1))], {
      signal: controller.signal,
      headRepeat: 'until-aborted',
    });
    await flush();
    expect(master().isPaused()).toBe(false);
    controller.abort();
    await settled;
  });

  it('ignores headCueGate (no audio engine yet) and plays normally', async () => {
    const controller = new AbortController();
    const { master, settled } = runWith([segment('a', sceneTl(1))], {
      signal: controller.signal,
      headCueGate: 'monotonic-forward',
    });
    await flush();
    expect(master().isPaused()).toBe(false);
    controller.abort();
    await settled;
  });

  it('resolves when the master timeline completes naturally so the resolver can tear scenes down', async () => {
    const controller = new AbortController();
    const { settled } = runWith([segment('a', sceneTl(0.01)), segment('b', sceneTl(0.01))], {
      signal: controller.signal,
    });
    await expect(settled).resolves.toBeUndefined();
    controller.abort(); // no-op: already settled.
  });

  it('does not reject when the missing-beat sink throws', async () => {
    const controller = new AbortController();
    const { settled } = runWith([segment('intro', sceneTl(4))], {
      signal: controller.signal,
      headBeat: 'ghost',
      onBeatMissing: () => {
        throw new Error('diagnostic sink boom');
      },
    });
    await flush();
    controller.abort();
    await expect(settled).resolves.toBeUndefined();
  });

  it('kills the master and rejects when onMaster throws', async () => {
    let captured: MasterTimeline | null = null;
    const adapter = createGsapCompositionTimeline({
      engine,
      onMaster: (m) => {
        captured = m;
        throw new Error('observer boom');
      },
    });
    const controller = new AbortController();
    await expect(
      adapter.run([segment('a', sceneTl(4))], { signal: controller.signal }),
    ).rejects.toThrow('observer boom');
    expect(captured).not.toBeNull();
    expect(() => (captured as unknown as MasterTimeline).kill()).not.toThrow();
  });

  it('drives a multi-scene composition through resolveComposition, composing every scene timeline into one master', async () => {
    const created: string[] = [];
    const cleaned: string[] = [];
    const composedDurations: number[] = [];
    const trace = (id: string): SceneModule =>
      stubScene(id, {
        create: () => {
          created.push(id);
        },
        timeline: () => sceneTl(0.005, { hook: 0.002 }),
        cleanup: () => {
          cleaned.push(id);
        },
      });
    const adapter = createGsapCompositionTimeline({
      engine,
      onMaster: (m) => {
        composedDurations.push(m.duration());
      },
    });
    // No abort signal: the finite master plays to completion (≈ 0.015s),
    // then the resolver tears every scene down — the full mount-all →
    // compose → run → cleanup-all walk.
    await resolveComposition({
      registry: createSceneRegistry([trace('intro'), trace('demo'), trace('outro')]),
      manifest: ['intro', 'demo', 'outro'],
      ctx: {},
      preloadAssets: () => undefined,
      timeline: adapter,
    });
    expect(created).toEqual(['intro', 'demo', 'outro']);
    expect(cleaned).toEqual(['outro', 'demo', 'intro']);
    // One master composed for the whole composition, spanning all three
    // scene timelines (3 × 0.005s).
    expect(composedDurations).toHaveLength(1);
    expect(composedDurations[0]).toBeCloseTo(0.015);
  });

  it('passes a default-playing (not `{ paused: true }`) scene timeline through, master-driven', async () => {
    // The scene-facing convention is `ctx.gsap.timeline()`; a scene need
    // not pass `{ paused: true }`. `composeMasterTimeline` normalizes the
    // child (pause + seek 0) before nesting so the master owns playback.
    const child = engine.gsap.timeline();
    child.to({ v: 0 }, { v: 1, duration: 2 });
    const master = composeMasterTimeline(engine, [segment('a', child)]);
    expect(master.duration()).toBeCloseTo(2);
    expect(master.isPaused()).toBe(true);
    expect(master.time()).toBe(0);
    master.kill();
  });
});
