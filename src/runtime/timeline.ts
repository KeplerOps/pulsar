// Timeline orchestration — PUL-F022. The GSAP timeline adapter.
//
// This module is the GSAP boundary for the runtime (ADR-003, ADR-025):
//
//  - Scenes receive the GSAP instance as `ctx.gsap` (via
//    `createTimelineEngine`) and construct their own timeline in
//    `timeline(ctx)`; they do not import GSAP directly.
//  - `composeMasterTimeline` nests the scene timelines of an active
//    composition slice into a single master GSAP timeline, copying each
//    scene's labels into the master under a deterministic namespace so a
//    composition that reuses the same scene id more than once (ADR-002)
//    keeps an unambiguous label space.
//  - `MasterTimeline` is the transport surface PUL-F022 mandates: play,
//    pause, seek (by time or named label), speed change (a validated
//    positive multiplier — zero / negative / NaN / Infinity / non-number
//    are rejected), named labels.
//  - `createGsapCompositionTimeline` is the composition-level timeline
//    adapter the workbench wires onto the composition resolver (ADR-011
//    + ADR-025): the resolver mounts every scene in the slice, hands the
//    adapter their timeline values, the adapter composes the master,
//    applies the URL/runner-input head hints, plays the master, and
//    resolves on the master's natural completion (so the resolver tears
//    every scene down) or on navigation abort.
//
// Scenes that have not yet authored a timeline return `null` (the
// placeholder scene does this); the adapter composes such a scene as a
// zero-duration segment rather than rejecting it.
//
// References:
//  - ADR-003 — GSAP as the timeline engine; `ctx.gsap`.
//  - ADR-011 — composition resolver as a pure orchestrator with an
//    injected timeline adapter; this module is that adapter.
//  - ADR-025 — timeline adapter + composition master + the revised
//    resolution lifecycle (mount-all → compose-master → play →
//    cleanup-all) superseding ADR-002 §Resolution / ADR-011 ordering.
//  - ADR-002 — the composition the master is built for.
//  - ADR-015 / ADR-018 / ADR-019 / ADR-021 — the URL beat / loop /
//    paused / screenshot head hints the adapter honors via the master's
//    transport API.

import { gsap } from 'gsap';
import type {
  CompositionTimelineAdapter,
  CompositionTimelineRunOptions,
  SceneTimelineSegment,
} from './composition-resolver';

type GsapTimeline = InstanceType<typeof gsap.core.Timeline>;

/**
 * The GSAP handle the workbench passes to scenes as `ctx.gsap`
 * (ADR-003). A thin wrapper so the rest of the runtime depends on this
 * module rather than on `gsap` directly — the one place a future engine
 * swap or wrapper expansion would land.
 */
export interface TimelineEngine {
  readonly gsap: typeof gsap;
}

/** Build a {@link TimelineEngine}. The GSAP instance is a process singleton. */
export function createTimelineEngine(): TimelineEngine {
  return { gsap };
}

/** Base class for every error raised by the timeline adapter. */
export class TimelineError extends Error {}

/** A scene's `timeline(ctx)` returned something that is not a GSAP timeline. */
export class SceneTimelineTypeError extends TimelineError {}

/** A speed multiplier or repeat count handed to the master was out of range. */
export class TimelineSpeedError extends TimelineError {}

/** A seek targeted an unknown label or a non-finite time. */
export class TimelineSeekError extends TimelineError {}

const isGsapTimeline = (value: unknown): value is GsapTimeline =>
  value instanceof gsap.core.Timeline;

/**
 * Validate the value a scene's `timeline(ctx)` returned. `null` /
 * `undefined` are accepted as "no timeline authored yet" (the
 * placeholder scene returns `null`); any other non-timeline value is a
 * scene-contract violation and throws {@link SceneTimelineTypeError}
 * with the scene id in the message.
 */
export function assertSceneTimeline(
  value: unknown,
  sceneId: string,
): asserts value is GsapTimeline | null | undefined {
  if (value === null || value === undefined) return;
  if (!isGsapTimeline(value)) {
    throw new SceneTimelineTypeError(
      `scene "${sceneId}" timeline is invalid: timeline(ctx) must return a GSAP timeline or null`,
    );
  }
}

/** Separator between a scene segment's prefix and a scene-local label. */
export const SCENE_LABEL_SEPARATOR = ':';

/**
 * The master label that marks where a scene segment starts.
 * `occurrence` disambiguates a composition that reuses the same scene
 * id: occurrence `0` (the first / only use) is the bare scene id;
 * later occurrences carry a `#<n>` suffix.
 */
export function sceneSegmentLabel(sceneId: string, occurrence = 0): string {
  return occurrence === 0 ? sceneId : `${sceneId}#${occurrence}`;
}

/**
 * The master label name for a scene-local label, namespaced under the
 * scene segment so repeated scene entries do not share an ambiguous
 * global label namespace (e.g. `intro:hook`, `intro#1:hook`).
 */
export function sceneTimelineLabel(sceneId: string, localLabel: string, occurrence = 0): string {
  return `${sceneSegmentLabel(sceneId, occurrence)}${SCENE_LABEL_SEPARATOR}${localLabel}`;
}

/**
 * The composed master timeline's transport surface (PUL-F022 C3). All
 * methods keep GSAP behind the boundary — callers never touch the
 * underlying timeline directly.
 */
export interface MasterTimeline {
  /** Resume (or start) playback from the current playhead. */
  play(): void;
  /** Pause at the current playhead. */
  pause(): void;
  /** Whether playback is currently paused. */
  isPaused(): boolean;
  /**
   * Move the playhead to a time (seconds) or a named label. An unknown
   * label or a non-finite time throws {@link TimelineSeekError}.
   */
  seek(position: number | string): void;
  /**
   * Set the playback rate as a multiplier of real time. Must be a
   * finite number greater than zero — zero, negative, NaN, Infinity,
   * and non-number values throw {@link TimelineSpeedError} and leave
   * the prior rate unchanged.
   */
  setSpeed(multiplier: number): void;
  /** The current playback rate multiplier. */
  speed(): number;
  /**
   * Set the repeat count for loop playback: `-1` repeats forever, `0`
   * disables repeating, `n` plays `n` extra times. Non-integer or
   * `< -1` values throw {@link TimelineSpeedError}.
   */
  repeat(count: number): void;
  /** The current playhead time, in seconds. */
  time(): number;
  /** The duration of one iteration, in seconds. */
  duration(): number;
  /** A frozen snapshot of the master's label names → times (seconds). */
  readonly labels: Readonly<Record<string, number>>;
  /** Whether `name` is a label of this master timeline. */
  hasLabel(name: string): boolean;
  /** The master label name for a scene-local label (see {@link sceneTimelineLabel}). */
  labelFor(sceneId: string, localLabel: string, occurrence?: number): string;
  /**
   * Register a handler invoked whenever the master reaches its end.
   * A master with `repeat(-1)` never reaches its end, and a paused /
   * held master never advances to it, so the handler does not fire in
   * those cases. Replaces any previously-registered completion handler.
   */
  onComplete(handler: () => void): void;
  /** Stop the master, release its children, and let the GSAP ticker idle. Idempotent. */
  kill(): void;
}

const validateSpeed = (multiplier: number): void => {
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0) {
    const got = typeof multiplier === 'number' ? `${multiplier}` : typeof multiplier;
    throw new TimelineSpeedError(
      `timeline speed must be a finite number greater than 0; got ${got}`,
    );
  }
};

const validateRepeat = (count: number): void => {
  if (!Number.isInteger(count) || count < -1) {
    throw new TimelineSpeedError(`timeline repeat count must be an integer >= -1; got ${count}`);
  }
};

class GsapMasterTimeline implements MasterTimeline {
  readonly #tl: GsapTimeline;

  constructor(tl: GsapTimeline) {
    this.#tl = tl;
  }

  play(): void {
    this.#tl.play();
  }

  pause(): void {
    this.#tl.pause();
  }

  isPaused(): boolean {
    return this.#tl.paused();
  }

  seek(position: number | string): void {
    if (typeof position === 'string') {
      if (!Object.hasOwn(this.#tl.labels, position)) {
        throw new TimelineSeekError(`timeline has no label "${position}"`);
      }
      this.#tl.seek(position);
      return;
    }
    if (!Number.isFinite(position)) {
      throw new TimelineSeekError(`timeline seek time must be a finite number; got ${position}`);
    }
    this.#tl.seek(position);
  }

  setSpeed(multiplier: number): void {
    validateSpeed(multiplier);
    this.#tl.timeScale(multiplier);
  }

  speed(): number {
    return this.#tl.timeScale();
  }

  repeat(count: number): void {
    validateRepeat(count);
    this.#tl.repeat(count);
  }

  time(): number {
    return this.#tl.time();
  }

  duration(): number {
    return this.#tl.duration();
  }

  get labels(): Readonly<Record<string, number>> {
    return Object.freeze({ ...this.#tl.labels });
  }

  hasLabel(name: string): boolean {
    return Object.hasOwn(this.#tl.labels, name);
  }

  labelFor(sceneId: string, localLabel: string, occurrence = 0): string {
    return sceneTimelineLabel(sceneId, localLabel, occurrence);
  }

  onComplete(handler: () => void): void {
    this.#tl.eventCallback('onComplete', handler);
  }

  kill(): void {
    this.#tl.kill();
  }
}

/**
 * Compose `segments` into a single master GSAP timeline (PUL-F022 C2).
 *
 * Each segment's timeline is appended after the previous one. Every
 * segment gets a master label at its start (`sceneSegmentLabel`), and
 * every scene-local label is copied into the master under the
 * namespaced form (`sceneTimelineLabel`), so a composition that reuses
 * a scene id keeps an unambiguous label space (ADR-002 allows repeated
 * entries). A `null` / `undefined` segment timeline contributes a
 * zero-duration segment. A scene timeline built with `{ paused: true }`
 * (the GSAP "construct to nest" idiom) is un-paused once nested so the
 * master drives it; the master itself stays paused at time 0 —
 * positioning and playback are the caller's (the adapter's) job.
 *
 * Throws {@link SceneTimelineTypeError} (before any timeline is built)
 * if a segment's timeline value is not a GSAP timeline or `null` /
 * `undefined`.
 */
export function composeMasterTimeline(
  engine: TimelineEngine,
  segments: readonly SceneTimelineSegment[],
): MasterTimeline {
  for (const segment of segments) {
    assertSceneTimeline(segment.timeline, segment.id);
  }
  const master = engine.gsap.timeline({ paused: true });
  const occurrences = new Map<string, number>();
  for (const segment of segments) {
    const occurrence = occurrences.get(segment.id) ?? 0;
    occurrences.set(segment.id, occurrence + 1);
    // `master.duration()` before the add is the position the segment
    // lands at (`'>'` appends at the current end) and the offset for
    // the segment's labels in master coordinates.
    const start = master.duration();
    master.addLabel(sceneSegmentLabel(segment.id, occurrence), start);
    const child = segment.timeline;
    if (isGsapTimeline(child)) {
      // Normalize the scene's timeline before nesting: pause it (a scene
      // that returned a default-playing `gsap.timeline()` has already
      // started ticking on the root) and reset its playhead to 0, then
      // nest it and let the master drive it. After this the master owns
      // all playback — no scene timeline runs outside it.
      child.pause();
      child.seek(0);
      master.add(child, '>');
      child.paused(false);
      for (const [localLabel, localTime] of Object.entries(child.labels)) {
        master.addLabel(sceneTimelineLabel(segment.id, localLabel, occurrence), start + localTime);
      }
    }
  }
  return new GsapMasterTimeline(master);
}

/** Construction options for {@link createGsapCompositionTimeline}. */
export interface GsapCompositionTimelineOptions {
  readonly engine: TimelineEngine;
  /**
   * Observability seam: invoked once per composition activation with the
   * live master after it has been composed and positioned. The future
   * workbench transport surface (scrub controls, presenter HUD) uses
   * this to drive `play` / `pause` / `seek` / `setSpeed`. Optional.
   */
  readonly onMaster?: (master: MasterTimeline) => void;
}

/**
 * Resolve the URL beat (PUL-F011 / ADR-015) to the head scene's master
 * label name, or `undefined` when no beat was requested or the named
 * label does not exist. A missing label is the non-fatal path: report
 * via `onBeatMissing` (a throwing sink is swallowed — the path is
 * non-fatal by contract) and leave the playhead at frame 0.
 */
function resolveHeadBeatLabel(
  master: MasterTimeline,
  headSceneId: string | undefined,
  opts: CompositionTimelineRunOptions,
): string | undefined {
  if (opts.headBeat === undefined || headSceneId === undefined) return undefined;
  const labelName = sceneTimelineLabel(headSceneId, opts.headBeat);
  if (!master.hasLabel(labelName)) {
    try {
      opts.onBeatMissing?.();
    } catch {
      // Intentionally empty: the missing-beat path is non-fatal by contract.
    }
    return undefined;
  }
  return labelName;
}

/**
 * How the master should run after positioning:
 *  - `'hold'` — paused at a frame; never completes (`headHold` /
 *    `headScreenshot`).
 *  - `'loop'` — plays, repeating forever; never completes (`headRepeat`).
 *  - `'play'` — plays once and reaches its natural end.
 */
type MasterRunMode = 'hold' | 'loop' | 'play';

/**
 * Apply the URL/runner-input head hints to the freshly-composed master
 * (seeks / pauses / sets repeat) and report how it should run.
 *
 *  - `headHold: 'first-frame'` (PUL-F016 / ADR-019): hold at frame 0;
 *    wins over `headBeat` and `headRepeat`; attempts no beat lookup —
 *    `mode=paused` is first-frame inspection. → `'hold'`.
 *  - `headScreenshot: 'capture'` (PUL-F018 / ADR-021): freeze at the
 *    addressed beat, or frame 0, with no playback (beat IS the anchor).
 *    → `'hold'`.
 *  - `headBeat` (PUL-F011 / ADR-015): seek to the head scene's named
 *    label (a missing label reports via `onBeatMissing` and stays at
 *    frame 0), then play forward. → `'play'`.
 *  - `headRepeat: 'until-aborted'` (PUL-F015 / ADR-018): loop the master
 *    forever. → `'loop'`.
 *  - `headCueGate: 'monotonic-forward'` (PUL-F017 / ADR-020): no effect
 *    here — no audio engine to gate cues against yet (PUL-F024).
 *  - default: → `'play'`.
 */
function positionMaster(
  master: MasterTimeline,
  headSceneId: string | undefined,
  opts: CompositionTimelineRunOptions,
): MasterRunMode {
  if (opts.headHold === 'first-frame') {
    master.seek(0);
    master.pause();
    return 'hold';
  }
  const beatLabel = resolveHeadBeatLabel(master, headSceneId, opts);
  if (opts.headScreenshot === 'capture') {
    master.seek(beatLabel ?? 0);
    master.pause();
    return 'hold';
  }
  if (beatLabel !== undefined) {
    master.seek(beatLabel);
  }
  if (opts.headRepeat === 'until-aborted') {
    master.repeat(-1);
    return 'loop';
  }
  return 'play';
}

/**
 * Run the positioned master and resolve when the composition activation
 * is done — the master reached its natural end (so the resolver tears
 * every scene down — ADR-002's "advance" becomes "the composition
 * ended") or the navigation aborted — killing the master so the GSAP
 * ticker can idle.
 *
 *  - `'play'`: play and resolve on natural completion, regardless of
 *    whether a cancellation signal is wired (a caller without a signal
 *    still gets playback and completion — the export pipeline before it
 *    owns abort, a test harness).
 *  - `'loop'`: start (infinite) playback; only abort resolves it. With
 *    no signal there is nothing to wait for, so resolve immediately —
 *    a loop cannot be observed without cancellation.
 *  - `'hold'`: the master is already paused; only abort resolves it.
 *    With no signal, resolve immediately — the held frame has been
 *    rendered.
 */
function runMasterUntilDone(
  master: MasterTimeline,
  mode: MasterRunMode,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      master.kill();
      resolve();
    };
    if (signal?.aborted === true) {
      finish();
      return;
    }
    if (signal !== undefined) {
      signal.addEventListener('abort', finish, { once: true });
    }
    if (mode === 'play') {
      // Arm the completion handler BEFORE play() so a very short master
      // cannot complete before the waiter is installed.
      master.onComplete(finish);
      master.play();
      return;
    }
    if (mode === 'loop' && signal !== undefined) {
      master.play();
    }
    if (signal === undefined) {
      finish();
    }
  });
}

/**
 * Build the GSAP-backed {@link CompositionTimelineAdapter} the workbench
 * wires onto the composition resolver (replacing the placeholder
 * runner). Each `run(segments, opts)` call: composes `segments` (the
 * active composition slice's scene timeline values, in manifest order)
 * into one master GSAP timeline; applies the head hints; reports the
 * live master to `onMaster`; then plays the master, resolving on its
 * natural completion (so the resolver runs `cleanup(ctx)` for every
 * scene) or on `opts.signal` abort. A non-timeline scene value rejects
 * (the resolver wraps it with `composition resolution failed:` and
 * tears every scene down).
 *
 * `opts.presenter` (the presenter command controller) and a segment's
 * `range` (per-entry composition override) are not interpreted here yet
 * — presenter → transport translation is PUL-F020 / PUL-F021's runner
 * contract and sub-range cuts are PUL-F003's; both extend this adapter's
 * `MasterTimeline` transport seam when those requirements are
 * implemented.
 */
export function createGsapCompositionTimeline(
  options: GsapCompositionTimelineOptions,
): CompositionTimelineAdapter {
  const { engine, onMaster } = options;
  return {
    run(segments, opts) {
      let master: MasterTimeline;
      let mode: MasterRunMode;
      try {
        master = composeMasterTimeline(engine, segments);
        mode = positionMaster(master, segments[0]?.id, opts);
      } catch (err) {
        return Promise.reject(err);
      }
      try {
        onMaster?.(master);
      } catch (err) {
        // An observability hook throwing is a caller bug; kill the live
        // master before propagating so it does not leak.
        master.kill();
        return Promise.reject(err);
      }
      return runMasterUntilDone(master, mode, opts.signal);
    },
  };
}
