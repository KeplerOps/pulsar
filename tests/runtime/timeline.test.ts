// Tests for the GSAP timeline adapter — PUL-F022 / ADR-025 and the
// named-beat grammar PUL-F023 / ADR-026.
//
// Coverage map (requirement clauses):
//  - PUL-F022 C1 "Each scene SHALL produce a timeline": `createTimelineEngine`
//    exposes `gsap` for `ctx.gsap`; `assertSceneTimeline` validates the
//    value a scene's `timeline(ctx)` returns.
//  - PUL-F022 C2 "the runtime composes into a master timeline for the active
//    composition": `composeMasterTimeline` nests scene timelines into a
//    master with namespaced labels; `createGsapCompositionTimeline` is
//    the composition-level adapter the resolver drives.
//  - PUL-F022 C3 "SHALL support play, pause, seek, speed change, and named
//    labels": the `MasterTimeline` controller.
//  - PUL-F023 "Scene timelines SHALL support named labels (beats)":
//    `assertSceneTimeline` enforces that authored beat labels are
//    kebab-case identifiers (ADR-008 #1) before any timeline is built,
//    and rejects a bad beat through `resolveComposition`'s envelope.
//  - PUL-F023 "referenceable by URL / presenter / other runtime
//    subsystems": the `MasterTimeline` beat-query surface — `labels`,
//    `hasLabel`, `seek`, `labelFor`, `beats` — plus `parseSceneTimelineLabel`,
//    the one inverse of `sceneTimelineLabel`.
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
import {
  type PresenterCommand,
  type PresenterCommandSource,
  createPresenterController,
} from '../../src/runtime/presenter';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { SceneModule } from '../../src/runtime/scene';
import {
  type MasterTimeline,
  SceneTimelineLabelError,
  SceneTimelineTypeError,
  TimelineSeekError,
  TimelineSpeedError,
  assertSceneTimeline,
  composeMasterTimeline,
  createGsapCompositionTimeline,
  createTimelineEngine,
  parseSceneTimelineLabel,
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
  audio: [],
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

  it('accepts kebab-case scene timeline labels (beats)', () => {
    const tl = sceneTl(2, { hook: 0.5, 'cold-open': 0, 'beat-2': 1 });
    expect(() => assertSceneTimeline(tl, 'intro')).not.toThrow();
    tl.kill();
  });

  it.each([
    ['an uppercase letter', 'My Beat'],
    ['whitespace', 'cold open'],
    ['an underscore', 'cold_open'],
    ['a leading hyphen', '-hook'],
    ['a trailing hyphen', 'hook-'],
    ['a double hyphen', 'cold--open'],
    ['the namespace separator', 'intro:hook'],
    ['the occurrence marker', 'beat#1'],
    ['an empty string', ''],
  ])(
    'rejects a scene timeline label containing %s with the scene id and label in the message',
    (_why, label) => {
      const tl = sceneTl(2, { [label]: 0.5 });
      expect(() => assertSceneTimeline(tl, 'intro')).toThrow(SceneTimelineLabelError);
      expect(() => assertSceneTimeline(tl, 'intro')).toThrow(/scene "intro"/);
      expect(() => assertSceneTimeline(tl, 'intro')).toThrow(
        new RegExp(`"${label.replace(/[.*+?^${}()|[\]\\#-]/g, '\\$&')}"`),
      );
      tl.kill();
    },
  );

  it('accepts a beat at time 0 and at exactly the scene timeline duration', () => {
    const tl = sceneTl(2, { start: 0, finish: 2 });
    expect(() => assertSceneTimeline(tl, 'intro')).not.toThrow();
    tl.kill();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative time', -0.5],
    ['a time past the scene timeline duration', 5],
  ])('rejects a beat at %s with the scene id, beat name, and time in the message', (_why, at) => {
    const tl = gsap.timeline({ paused: true });
    tl.to({ v: 0 }, { v: 1, duration: 2 });
    tl.addLabel('peak', at);
    expect(() => assertSceneTimeline(tl, 'intro')).toThrow(SceneTimelineLabelError);
    expect(() => assertSceneTimeline(tl, 'intro')).toThrow(/scene "intro"/);
    expect(() => assertSceneTimeline(tl, 'intro')).toThrow(/"peak"/);
    tl.kill();
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

describe('parseSceneTimelineLabel', () => {
  it('parses a first-occurrence namespaced label', () => {
    expect(parseSceneTimelineLabel('intro:hook')).toEqual({
      scene: 'intro',
      occurrence: 0,
      label: 'hook',
    });
    expect(parseSceneTimelineLabel('cold-open:beat-2')).toEqual({
      scene: 'cold-open',
      occurrence: 0,
      label: 'beat-2',
    });
  });

  it('parses a repeated-occurrence namespaced label', () => {
    expect(parseSceneTimelineLabel('intro#1:hook')).toEqual({
      scene: 'intro',
      occurrence: 1,
      label: 'hook',
    });
    expect(parseSceneTimelineLabel('intro#12:hook')).toEqual({
      scene: 'intro',
      occurrence: 12,
      label: 'hook',
    });
  });

  it('round-trips with sceneTimelineLabel', () => {
    for (const [scene, label, occ] of [
      ['intro', 'hook', 0],
      ['intro', 'hook', 3],
      ['cold-open', 'beat-2', 1],
    ] as const) {
      expect(parseSceneTimelineLabel(sceneTimelineLabel(scene, label, occ))).toEqual({
        scene,
        occurrence: occ,
        label,
      });
    }
  });

  it.each([
    ['a segment-start anchor (no separator)', 'intro'],
    ['a repeated segment-start anchor', 'intro#1'],
    ['an empty string', ''],
    ['a name with no separator', 'no-separator'],
    ['a trailing separator with no label', 'intro:'],
    ['a leading separator with no scene', ':hook'],
    ['a zero occurrence (occurrence 0 has no suffix)', 'intro#0:hook'],
    ['a non-numeric occurrence', 'intro#x:hook'],
    ['a negative occurrence', 'intro#-1:hook'],
    ['a non-kebab scene segment', 'Intro:hook'],
    ['a non-kebab local label', 'intro:Hook'],
    ['extra separators in the label', 'intro:hook:extra'],
  ])('returns null for %s', (_why, name) => {
    expect(parseSceneTimelineLabel(name)).toBeNull();
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

  it('rejects a segment whose timeline carries a non-kebab beat label, before building the master', () => {
    // The bad label is on the SECOND segment, so a successful compose
    // would already have added the first segment's labels to a master.
    // The pre-pass must reject before any timeline is constructed.
    const good = sceneTl(1, { hook: 0.5 });
    const bad = sceneTl(1, { 'Bad Label': 0.5 });
    let caught: unknown;
    try {
      composeMasterTimeline(engine, [segment('intro', good), segment('demo', bad)]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SceneTimelineLabelError);
    expect((caught as Error).message).toMatch(/scene "demo"/);
    expect((caught as Error).message).toMatch(/"Bad Label"/);
  });

  it('kills every scene timeline it was handed when compose rejects, leaking no live tickers', () => {
    // Default-playing timelines (`gsap.timeline()`, not `{ paused: true }`)
    // are children of the global timeline the moment they exist — i.e.
    // already ticking. A rejected compose must detach (kill) every one it
    // was handed so none keeps running after the resolver unmounts the scenes.
    const liveChildren = () => gsap.globalTimeline.getChildren(false) as unknown[];
    const live = gsap.timeline();
    live.to({ v: 0 }, { v: 1, duration: 30 });
    const bad = gsap.timeline();
    bad.to({ v: 0 }, { v: 1, duration: 30 });
    bad.addLabel('Bad Label', 0.5);
    expect(liveChildren()).toContain(live);
    expect(liveChildren()).toContain(bad);
    expect(() =>
      composeMasterTimeline(engine, [segment('intro', live), segment('demo', bad)]),
    ).toThrow(SceneTimelineLabelError);
    expect(liveChildren()).not.toContain(live);
    expect(liveChildren()).not.toContain(bad);
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

describe('MasterTimeline.beats', () => {
  /** Drop `time` (float) so the structural shape can be compared exactly. */
  const shape = (master: MasterTimeline) => master.beats().map(({ time: _time, ...rest }) => rest);

  it('lists scene-authored beats in playhead order, excluding the segment-start anchors', () => {
    const master = composeMasterTimeline(engine, [
      segment('intro', sceneTl(2, { hook: 0.5, outro: 1.5 })),
      segment('demo', sceneTl(1, { peak: 0.25 })),
    ]);
    expect(shape(master)).toEqual([
      { scene: 'intro', occurrence: 0, label: 'hook', name: 'intro:hook' },
      { scene: 'intro', occurrence: 0, label: 'outro', name: 'intro:outro' },
      { scene: 'demo', occurrence: 0, label: 'peak', name: 'demo:peak' },
    ]);
    const byName = new Map(master.beats().map((b) => [b.name, b.time]));
    expect(byName.get('intro:hook')).toBeCloseTo(0.5);
    expect(byName.get('intro:outro')).toBeCloseTo(1.5);
    expect(byName.get('demo:peak')).toBeCloseTo(2.25);
    // The segment-start anchors are present as labels but are not beats.
    expect(master.hasLabel('intro')).toBe(true);
    expect(master.hasLabel('demo')).toBe(true);
    expect(master.beats().some((b) => b.name === 'intro' || b.name === 'demo')).toBe(false);
    master.kill();
  });

  it('disambiguates repeated scene entries by occurrence', () => {
    const master = composeMasterTimeline(engine, [
      segment('beat', sceneTl(1, { mid: 0.5 })),
      segment('gap', sceneTl(1)),
      segment('beat', sceneTl(1, { mid: 0.5 })),
    ]);
    expect(shape(master)).toEqual([
      { scene: 'beat', occurrence: 0, label: 'mid', name: 'beat:mid' },
      { scene: 'beat', occurrence: 1, label: 'mid', name: 'beat#1:mid' },
    ]);
    const byName = new Map(master.beats().map((b) => [b.name, b.time]));
    expect(byName.get('beat:mid')).toBeCloseTo(0.5);
    expect(byName.get('beat#1:mid')).toBeCloseTo(2.5);
    master.kill();
  });

  it('returns an empty list when no scene authored a beat (including null timelines)', () => {
    const master = composeMasterTimeline(engine, [
      segment('a', sceneTl(1)),
      segment('empty', null),
      segment('b', sceneTl(1)),
    ]);
    expect(master.beats()).toEqual([]);
    master.kill();
  });

  it('returns a fresh array each call that does not alias the master state', () => {
    const master = composeMasterTimeline(engine, [segment('a', sceneTl(1, { mid: 0.5 }))]);
    const first = master.beats();
    expect(first).toHaveLength(1);
    (first as unknown as unknown[]).push('tamper');
    expect(master.beats()).toHaveLength(1);
    master.kill();
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
    // playback — not an immediate resolve-without-running. A scene
    // timeline that animates an external target lets us verify the
    // master actually played to completion (`target.v` reaches 1); a
    // very short master keeps the test fast.
    const target = { v: 0 };
    const child = engine.gsap.timeline({ paused: true });
    child.to(target, { v: 1, duration: 0.02 });
    const adapter = createGsapCompositionTimeline({ engine });
    await adapter.run([segment('a', child)], {});
    expect(target.v).toBeCloseTo(1);
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

  it('does not advance a scene tween under headHold — the animated value stays at frame 0', async () => {
    // PUL-F016 acceptance criterion 2: `mode=paused` must hold the
    // composition at its first frame *without advancing the timeline*.
    // The `isPaused()` / `time()` assertions in the test above prove
    // the master is parked at 0, but a runner that paused the master
    // yet still let a nested tween render forward — or one that briefly
    // played before pausing — would pass them. This test pins the
    // behavioral contract: a tween that animates an external attribute
    // from 0 -> 1 must leave that attribute at its initial value, and
    // must keep it there as real wall-clock time elapses past the
    // tween's duration. It is the runner-seam unit counterpart of the
    // headRepeat "actually restarts" test below.
    const controller = new AbortController();
    const target = { v: 0 };
    const child = gsap.timeline({ paused: true });
    child.to(target, { v: 1, duration: 0.05, ease: 'none' });

    const { master, settled } = runWith([segment('a', child)], {
      signal: controller.signal,
      headHold: 'first-frame',
    });
    await flush();
    expect(master().isPaused()).toBe(true);
    expect(target.v).toBeCloseTo(0);

    // Let real time pass well beyond the tween's 50ms duration. A
    // master that was not genuinely held would have the GSAP ticker
    // advance `target.v` toward 1; a held master leaves it untouched.
    await new Promise((r) => setTimeout(r, 80));
    expect(master().isPaused()).toBe(true);
    expect(master().time()).toBeCloseTo(0);
    expect(target.v).toBeCloseTo(0);

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

  it('starts the master playing (unpaused) under headRepeat', async () => {
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

  it('actually restarts the timeline on completion under headRepeat (>= 2 distinct iterations)', async () => {
    // PUL-F015 acceptance criterion 2: `mode=loop` must produce a
    // timeline that genuinely *restarts* on completion, not one that
    // plays once and parks at its last frame. The test above only
    // proves the master is unpaused; a runner that played the
    // composition exactly once and never advanced would still pass
    // it. This test pins the real contract: a scene timeline with a
    // terminal `.call()` re-fires that callback on every loop cycle,
    // so the cycle counter must reach >= 2. The promise resolves the
    // instant the second iteration completes — a non-restarting
    // implementation never reaches 2, so the test fails by hitting
    // the vitest timeout rather than passing silently.
    const controller = new AbortController();
    let iterations = 0;
    let reachedTwo: () => void = () => undefined;
    const twoIterations = new Promise<void>((resolve) => {
      reachedTwo = resolve;
    });
    const counted = gsap.timeline({ paused: true });
    counted.to({ v: 0 }, { v: 1, duration: 0.02 });
    counted.call(() => {
      iterations += 1;
      if (iterations >= 2) reachedTwo();
    });

    const { master, settled } = runWith([segment('a', counted)], {
      signal: controller.signal,
      headRepeat: 'until-aborted',
    });
    await twoIterations;
    expect(iterations).toBeGreaterThanOrEqual(2);
    // Still looping (not parked) when the second iteration landed.
    expect(master().isPaused()).toBe(false);
    controller.abort();
    await settled;
  });

  it('holds the master mounted and live (paused at frame 0) under headCueGate — scrub run mode', async () => {
    // PUL-F017 / ADR-020: under scrub the adapter must keep the head
    // scene mounted with a live master the workbench controls can
    // drive, instead of auto-playing it to natural completion before
    // the user can inspect it.
    const controller = new AbortController();
    const done = vi.fn();
    const { master, settled } = runWith([segment('a', sceneTl(30))], {
      signal: controller.signal,
      headCueGate: 'monotonic-forward',
    });
    void settled.then(done);
    await flush();
    expect(master().isPaused()).toBe(true);
    expect(master().time()).toBeCloseTo(0);
    expect(done).not.toHaveBeenCalled();
    controller.abort();
    await settled;
    expect(done).toHaveBeenCalledOnce();
  });

  it('honors headBeat as the initial scrub cursor under headCueGate', async () => {
    const controller = new AbortController();
    const { master, settled } = runWith([segment('intro', sceneTl(4, { hook: 2 }))], {
      signal: controller.signal,
      headCueGate: 'monotonic-forward',
      headBeat: 'hook',
      onBeatMissing: vi.fn(),
    });
    await flush();
    expect(master().time()).toBeCloseTo(2, 1);
    expect(master().isPaused()).toBe(true);
    controller.abort();
    await settled;
  });

  it('resolves immediately with no abort signal under headCueGate (held frame rendered)', async () => {
    const adapter = createGsapCompositionTimeline({ engine });
    await expect(
      adapter.run([segment('a', sceneTl(30))], { headCueGate: 'monotonic-forward' }),
    ).resolves.toBeUndefined();
  });

  it('exposes a reverse() transport method on the scrub master', async () => {
    const controller = new AbortController();
    const { master, settled } = runWith([segment('a', sceneTl(2))], {
      signal: controller.signal,
      headCueGate: 'monotonic-forward',
    });
    await flush();
    expect(master().reverse).toBeTypeOf('function');
    master().seek(1);
    master().reverse();
    expect(master().isPaused()).toBe(false);
    controller.abort();
    await settled;
  });

  it('toggles the audio cue gate by transport direction — pause/reverse close it, play opens it', async () => {
    // PUL-F017 / ADR-020: cue eligibility tracks "the master is playing
    // monotonically forward." The adapter sets it synchronously inside
    // each transport method, before GSAP's async tick fires any cue.
    const controller = new AbortController();
    const calls: boolean[] = [];
    const gate = {
      isEligible: () => calls.at(-1) ?? true,
      setEligible: (e: boolean) => calls.push(e),
    };
    const { master, settled } = runWith([segment('a', sceneTl(2))], {
      signal: controller.signal,
      headCueGate: 'monotonic-forward',
      audioCueGate: gate,
    });
    await flush();
    // The initial held frame is not forward playback → gate closed.
    expect(calls.at(-1)).toBe(false);
    master().play();
    expect(calls.at(-1)).toBe(true);
    master().pause();
    expect(calls.at(-1)).toBe(false);
    master().play();
    expect(calls.at(-1)).toBe(true);
    master().reverse();
    expect(calls.at(-1)).toBe(false);
    controller.abort();
    await settled;
  });

  it('does not touch a cue gate for a non-scrub navigation (no headCueGate)', async () => {
    // The cue gate exists only for scrub. A plain play-through master
    // must never call into a wired gate.
    const controller = new AbortController();
    const calls: boolean[] = [];
    const gate = {
      isEligible: () => true,
      setEligible: (e: boolean) => calls.push(e),
    };
    const { settled } = runWith([segment('a', sceneTl(0.02))], {
      signal: controller.signal,
      audioCueGate: gate,
    });
    await flush();
    expect(calls).toEqual([]);
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

  it('resolves immediately when headBeat seeks the master to a beat authored at the composition tail end', async () => {
    // The head (and only) scene authored a beat at its own end, so the
    // positioned master starts at progress 1. `play()` from there would
    // never re-fire `onComplete`, so the run must resolve right away
    // rather than park the resolver until an abort that never comes.
    const adapter = createGsapCompositionTimeline({ engine });
    await expect(
      adapter.run([segment('intro', sceneTl(0.02, { 'the-end': 0.02 }))], { headBeat: 'the-end' }),
    ).resolves.toBeUndefined();
  });

  it('tears the scene down through resolveComposition when headBeat lands on a terminal beat', async () => {
    // A single-scene composition whose head scene authored a beat at its
    // own end: the URL beat (head-scoped) seeks the master to its finite
    // end, so the run must resolve and the resolver must run cleanup —
    // not park forever waiting on an `onComplete` that cannot re-fire.
    const cleaned: string[] = [];
    const onBeatMissing = vi.fn();
    const adapter = createGsapCompositionTimeline({ engine });
    await resolveComposition({
      registry: createSceneRegistry([
        stubScene('intro', {
          timeline: () => sceneTl(0.02, { 'the-end': 0.02 }),
          cleanup: () => {
            cleaned.push('intro');
          },
        }),
      ]),
      manifest: ['intro'],
      ctx: () => ({}),
      preloadAssets: () => undefined,
      timeline: adapter,
      headBeat: 'the-end',
      onBeatMissing,
    });
    expect(onBeatMissing).not.toHaveBeenCalled();
    expect(cleaned).toEqual(['intro']);
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
      ctx: () => ({}),
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

  it('rejects through resolveComposition with the composition envelope and tears every scene down when a scene authors a bad beat label', async () => {
    const cleaned: string[] = [];
    const trace = (id: string, timeline: SceneModule['timeline']): SceneModule =>
      stubScene(id, {
        timeline,
        cleanup: () => {
          cleaned.push(id);
        },
      });
    const adapter = createGsapCompositionTimeline({ engine });
    let caught: unknown;
    try {
      await resolveComposition({
        registry: createSceneRegistry([
          trace('intro', () => sceneTl(0.005, { hook: 0.002 })),
          trace('demo', () => sceneTl(0.005, { 'Bad Beat': 0.002 })),
          trace('outro', () => sceneTl(0.005)),
        ]),
        manifest: ['intro', 'demo', 'outro'],
        ctx: () => ({}),
        preloadAssets: () => undefined,
        timeline: adapter,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/composition timeline failed:/);
    expect((caught as Error).message).toMatch(/scene "demo".*"Bad Beat"/);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(SceneTimelineLabelError);
    // Mandatory cleanup ran for every mounted scene (reverse order).
    expect(cleaned).toEqual(['outro', 'demo', 'intro']);
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

// PUL-F020 (advance / hold / skip-forward / skip-backward) and PUL-F021
// (pause / resume) — the runner's translation of presenter commands into
// master-timeline transport. ADR-024 *Cross-command precedence* is the
// binding contract: an explicit `pause` is distinct from a beat `hold`,
// and only `resume` unfreezes an explicit pause.
describe('createGsapCompositionTimeline — presenter command transport (PUL-F020 / PUL-F021)', () => {
  // A programmatic PresenterCommandSource the test drives via `emit`.
  const makeSource = (): {
    source: PresenterCommandSource;
    emit: (cmd: PresenterCommand) => void;
  } => {
    const handlers = new Set<(cmd: PresenterCommand) => void>();
    return {
      source: {
        subscribe(handler) {
          handlers.add(handler);
          return () => {
            handlers.delete(handler);
          };
        },
      },
      emit(cmd) {
        for (const handler of [...handlers]) handler(cmd);
      },
    };
  };

  /** Run the adapter with a live presenter controller wired to the runner. */
  const runWithPresenter = (
    segments: readonly SceneTimelineSegment[],
  ): {
    emit: (cmd: PresenterCommand) => void;
    master: () => MasterTimeline;
    abort: () => void;
    settled: Promise<void>;
  } => {
    const ctrl = new AbortController();
    const { source, emit } = makeSource();
    const presenter = createPresenterController(source, ctrl.signal);
    let captured: MasterTimeline | null = null;
    const adapter = createGsapCompositionTimeline({
      engine,
      onMaster: (m) => {
        captured = m;
      },
    });
    const settled = adapter.run(segments, { signal: ctrl.signal, presenter });
    return {
      emit,
      master: () => {
        if (captured === null) throw new Error('master not captured');
        return captured;
      },
      abort: () => ctrl.abort(),
      settled,
    };
  };

  it('pause freezes the master at the current playhead; resume continues from there', async () => {
    const r = runWithPresenter([segment('a', sceneTl(30))]);
    await flush();
    expect(r.master().isPaused()).toBe(false);
    r.emit({ kind: 'pause' });
    const frozenAt = r.master().time();
    expect(r.master().isPaused()).toBe(true);
    await flush();
    expect(r.master().time()).toBeCloseTo(frozenAt, 3);
    r.emit({ kind: 'resume' });
    expect(r.master().isPaused()).toBe(false);
    expect(r.master().time()).toBeCloseTo(frozenAt, 1);
    r.abort();
    await r.settled;
  });

  it('a second pause keeps the master frozen (idempotent)', async () => {
    const r = runWithPresenter([segment('a', sceneTl(30))]);
    await flush();
    r.emit({ kind: 'pause' });
    r.emit({ kind: 'pause' });
    expect(r.master().isPaused()).toBe(true);
    r.abort();
    await r.settled;
  });

  it('resume while playing is a no-op — it does not stop or restart the master', async () => {
    const r = runWithPresenter([segment('a', sceneTl(30))]);
    await flush();
    r.emit({ kind: 'resume' });
    expect(r.master().isPaused()).toBe(false);
    r.abort();
    await r.settled;
  });

  it('hold pauses the master; a second hold keeps it paused (not a play/pause toggle)', async () => {
    const r = runWithPresenter([segment('a', sceneTl(30))]);
    await flush();
    r.emit({ kind: 'hold' });
    expect(r.master().isPaused()).toBe(true);
    r.emit({ kind: 'hold' });
    expect(r.master().isPaused()).toBe(true);
    r.abort();
    await r.settled;
  });

  it('advance releases a beat hold (resumes playback)', async () => {
    const r = runWithPresenter([segment('a', sceneTl(30))]);
    await flush();
    r.emit({ kind: 'hold' });
    expect(r.master().isPaused()).toBe(true);
    r.emit({ kind: 'advance' });
    expect(r.master().isPaused()).toBe(false);
    r.abort();
    await r.settled;
  });

  it('advance seeks forward to the next authored beat while playing', async () => {
    const r = runWithPresenter([segment('intro', sceneTl(30, { 'mid-beat': 15 }))]);
    await flush();
    r.emit({ kind: 'advance' });
    expect(r.master().time()).toBeCloseTo(15, 0);
    r.abort();
    await r.settled;
  });

  it('skip-forward seeks to the next scene segment; skip-backward to the previous', async () => {
    const r = runWithPresenter([segment('a', sceneTl(20)), segment('b', sceneTl(20))]);
    await flush();
    r.emit({ kind: 'skip-forward' });
    expect(r.master().time()).toBeCloseTo(20, 0);
    r.emit({ kind: 'skip-backward' });
    expect(r.master().time()).toBeCloseTo(0, 0);
    r.abort();
    await r.settled;
  });

  it('advance received while explicitly paused does not resume or move the playhead (ADR-024)', async () => {
    const r = runWithPresenter([segment('intro', sceneTl(30, { 'mid-beat': 15 }))]);
    await flush();
    r.emit({ kind: 'pause' });
    const frozenAt = r.master().time();
    r.emit({ kind: 'advance' });
    expect(r.master().isPaused()).toBe(true);
    expect(r.master().time()).toBeCloseTo(frozenAt, 3);
    r.emit({ kind: 'resume' });
    expect(r.master().isPaused()).toBe(false);
    r.abort();
    await r.settled;
  });

  it('skip-forward while explicitly paused moves the frozen playhead but does not resume (ADR-024)', async () => {
    const r = runWithPresenter([segment('a', sceneTl(20)), segment('b', sceneTl(20))]);
    await flush();
    r.emit({ kind: 'pause' });
    r.emit({ kind: 'skip-forward' });
    expect(r.master().isPaused()).toBe(true);
    expect(r.master().time()).toBeCloseTo(20, 0);
    r.abort();
    await r.settled;
  });

  it('resume restores a hold engaged before pause — stays paused until advance releases it (ADR-024)', async () => {
    const r = runWithPresenter([segment('a', sceneTl(30))]);
    await flush();
    r.emit({ kind: 'hold' });
    r.emit({ kind: 'pause' });
    r.emit({ kind: 'resume' });
    // resume unfreezes the PUL-F021 pause but MUST NOT clear the prior hold.
    expect(r.master().isPaused()).toBe(true);
    r.emit({ kind: 'advance' });
    expect(r.master().isPaused()).toBe(false);
    r.abort();
    await r.settled;
  });

  it('toggle-master-mute does not affect master transport (audio-owned; runner ignores it)', async () => {
    const r = runWithPresenter([segment('a', sceneTl(30))]);
    await flush();
    expect(r.master().isPaused()).toBe(false);
    r.emit({ kind: 'toggle-master-mute' });
    expect(r.master().isPaused()).toBe(false);
    r.abort();
    await r.settled;
  });
});
