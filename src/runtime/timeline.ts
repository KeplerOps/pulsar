// Timeline orchestration — PUL-F022 / PUL-F023. The GSAP timeline adapter.
//
// This module is the GSAP boundary for the runtime (ADR-003, ADR-025)
// and the canonical home of the named-beat grammar (ADR-008 #1, ADR-026):
//
//  - Scenes receive the GSAP instance as `ctx.gsap` (via
//    `createTimelineEngine`) and construct their own timeline in
//    `timeline(ctx)`; they do not import GSAP directly.
//  - A scene's GSAP timeline labels ARE its beats (PUL-F023 / ADR-026):
//    the agent-friendly time grammar from ADR-008. An authored beat must
//    be a kebab-case identifier (the same rule scenes, compositions, and
//    assets obey — ADR-008 #1; the kebab-only URL `beat=` grammar could
//    never address anything else) at a finite, non-negative time no
//    later than the scene timeline's duration (a beat outside the
//    scene's content is not a usable moment). `assertSceneTimeline`
//    enforces both when a scene timeline first enters the runtime, so a
//    bad beat fails loudly instead of silently. There is no `beats`
//    field on `SceneModule` — the labels in the returned timeline are
//    the single source of truth (ADR-015).
//  - `composeMasterTimeline` nests the scene timelines of an active
//    composition slice into a single master GSAP timeline, copying each
//    scene's labels into the master under a deterministic namespace so a
//    composition that reuses the same scene id more than once (ADR-002)
//    keeps an unambiguous label space.
//  - `MasterTimeline` is the transport surface PUL-F022 mandates: play,
//    pause, seek (by time or named label), speed change (a validated
//    positive multiplier — zero / negative / NaN / Infinity / non-number
//    are rejected), named labels. It is also the canonical beat-query
//    surface PUL-F023 requires every runtime subsystem to reference
//    beats through: `labels` (every master label), `hasLabel`, `seek`,
//    `labelFor` (the master name for a scene-local beat), and `beats`
//    (just the scene-authored beats, in playhead order). `labelFor` /
//    `sceneTimelineLabel` build a master beat name; `parseSceneTimelineLabel`
//    is the one inverse — no subsystem reparses namespaced label strings.
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
//  - ADR-003 — GSAP as the timeline engine; `ctx.gsap`; labels + seeking.
//  - ADR-008 — agent-native authoring; #1 makes kebab-case binding on
//    scenes, compositions, beats, and assets.
//  - ADR-011 — composition resolver as a pure orchestrator with an
//    injected timeline adapter; this module is that adapter.
//  - ADR-025 — timeline adapter + composition master + the revised
//    resolution lifecycle (mount-all → compose-master → play →
//    cleanup-all) superseding ADR-002 §Resolution / ADR-011 ordering.
//  - ADR-026 — named timeline beats: beats are scene-local kebab GSAP
//    labels, validated at compose time, namespaced into the master, and
//    referenced by URL / presenter / scrub through the `MasterTimeline`
//    beat-query surface.
//  - ADR-002 — the composition the master is built for.
//  - ADR-015 / ADR-018 / ADR-019 / ADR-021 — the URL beat / loop /
//    paused / screenshot head hints the adapter honors via the master's
//    transport API.

import { gsap } from 'gsap';
import type { CueGateControl } from './audio';
import type {
  CompositionTimelineAdapter,
  CompositionTimelineRunOptions,
  SceneTimelineSegment,
} from './composition-resolver';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';

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

/**
 * A scene timeline carries a label that is not a valid beat identifier.
 * Beats share the kebab-case rule with every other Pulsar identifier
 * (ADR-008 #1); a label that does not match it could never be addressed
 * by the kebab-only URL `beat=` grammar, so it is a scene-contract
 * violation rather than a silent dead end.
 */
export class SceneTimelineLabelError extends TimelineError {}

/** A speed multiplier or repeat count handed to the master was out of range. */
export class TimelineSpeedError extends TimelineError {}

/** A seek targeted an unknown label or a non-finite time. */
export class TimelineSeekError extends TimelineError {}

const isGsapTimeline = (value: unknown): value is GsapTimeline =>
  value instanceof gsap.core.Timeline;

/**
 * Validate the value a scene's `timeline(ctx)` returned, including its
 * beats. `null` / `undefined` are accepted as "no timeline authored
 * yet" (the placeholder scene returns `null`); any other non-timeline
 * value is a scene-contract violation and throws
 * {@link SceneTimelineTypeError} with the scene id in the message.
 *
 * When the value is a GSAP timeline, every label on it is treated as a
 * named beat (PUL-F023 / ADR-026). Each must be:
 *  - a kebab-case identifier — the same rule scenes, compositions, and
 *    assets obey (ADR-008 #1, via `isKebabIdentifier`) — because the URL
 *    `beat=` grammar is kebab-only and a name it cannot express could
 *    never be addressed; and
 *  - at a finite, non-negative time no later than the scene timeline's
 *    duration — a beat past (or outside) the scene's content is not a
 *    usable moment, and `seek` / `beats()` would otherwise expose a
 *    clamped or out-of-range position as canonical.
 *
 * The first non-conforming label throws {@link SceneTimelineLabelError}
 * naming the scene id and the offending label (PUL-Q006).
 * `composeMasterTimeline` runs this over every segment before it builds
 * the master, so a bad beat is rejected before any timeline is
 * constructed; the resolver wraps the throw in its
 * `composition timeline failed:` envelope and tears every mounted scene
 * down (ADR-025).
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
  const duration = value.duration();
  for (const [label, time] of Object.entries(value.labels)) {
    // Underscore-prefixed labels are runtime sentinels (advance gates,
    // future flow-control hints) — they are NOT beats, are never
    // addressable from the URL `beat=` grammar, and are not surfaced
    // by `MasterTimeline.beats()`. The kebab-case rule is a contract
    // for beat names only.
    if (label.startsWith('_')) {
      if (!Number.isFinite(time) || time < 0 || time > duration) {
        throw new SceneTimelineLabelError(
          `scene "${sceneId}" timeline sentinel label "${label}" is at an invalid time ${time}: a label time must be a finite number between 0 and the scene timeline duration (${duration}s)`,
        );
      }
      continue;
    }
    if (!isKebabIdentifier(label)) {
      throw new SceneTimelineLabelError(
        `scene "${sceneId}" timeline label "${label}" is not a valid beat: beat labels must be lowercase kebab-case identifiers (${KEBAB_IDENTIFIER_FORM})`,
      );
    }
    if (!Number.isFinite(time) || time < 0 || time > duration) {
      throw new SceneTimelineLabelError(
        `scene "${sceneId}" timeline beat "${label}" is at an invalid time ${time}: a beat time must be a finite number between 0 and the scene timeline duration (${duration}s)`,
      );
    }
  }
}

/** Separator between a scene segment's prefix and a scene-local label. */
export const SCENE_LABEL_SEPARATOR = ':';

/**
 * Scene-local label name that, when present on a scene's child timeline,
 * causes the master to pause at the corresponding master-time. The
 * presenter `advance` command resumes playback. Multiple gates per
 * scene use {@link ADVANCE_GATE_PREFIX} + unique suffix.
 */
export const ADVANCE_GATE_LABEL = '_advance-gate';
export const ADVANCE_GATE_PREFIX = '_advance-gate:';

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

/** A namespaced master beat name decomposed into its parts. */
export interface ParsedSceneTimelineLabel {
  /** The scene id the beat belongs to. */
  readonly scene: string;
  /** Which occurrence of `scene` in the composition (0 = first / only). */
  readonly occurrence: number;
  /** The scene-local label name the scene author wrote. */
  readonly label: string;
}

/**
 * The single inverse of {@link sceneTimelineLabel}: decompose a master
 * label name into `{ scene, occurrence, label }`, or `null` when `name`
 * is not a namespaced scene beat — a bare segment-start anchor
 * (`scene-a`, `scene-a#1`), a malformed occurrence suffix, or anything
 * whose scene / label parts are not kebab-case identifiers. Runtime
 * subsystems that hold a master label name resolve it through here
 * rather than reparsing the `:` / `#` grammar locally (ADR-026).
 */
export function parseSceneTimelineLabel(name: string): ParsedSceneTimelineLabel | null {
  const sep = name.indexOf(SCENE_LABEL_SEPARATOR);
  if (sep < 0) return null;
  const segment = name.slice(0, sep);
  const label = name.slice(sep + 1);
  if (!isKebabIdentifier(label)) return null;
  const hash = segment.indexOf('#');
  if (hash < 0) {
    return isKebabIdentifier(segment) ? { scene: segment, occurrence: 0, label } : null;
  }
  const scene = segment.slice(0, hash);
  const occurrenceText = segment.slice(hash + 1);
  if (!isKebabIdentifier(scene)) return null;
  // Occurrence 0 is the bare segment label (no `#` suffix), so a valid
  // suffix is a positive integer with no leading zero.
  if (!/^[1-9]\d*$/.test(occurrenceText)) return null;
  return { scene, occurrence: Number(occurrenceText), label };
}

/**
 * One scene-authored beat on the composed master timeline (PUL-F023 /
 * ADR-026): the scene-local label, the scene segment it belongs to and
 * which occurrence of that scene, the namespaced master label name to
 * `seek` to, and the beat's time on the master in seconds. The
 * automatic segment-start anchors (`scene-a`, `scene-a#1`) are
 * transport anchors, not authored beats, and are not represented here.
 */
export interface MasterBeat {
  /** The scene segment this beat belongs to. */
  readonly scene: string;
  /** Which occurrence of `scene` in the composition (0 = first / only). */
  readonly occurrence: number;
  /** The scene-local label name the scene author wrote. */
  readonly label: string;
  /** The namespaced master label name (`<scene>:<label>` / `<scene>#<n>:<label>`). */
  readonly name: string;
  /** The beat's time on the master timeline, in seconds. */
  readonly time: number;
}

/**
 * The composed master timeline's transport surface (PUL-F022 C3) and
 * the canonical beat-query surface (PUL-F023 / ADR-026). All methods
 * keep GSAP behind the boundary — callers never touch the underlying
 * timeline directly.
 */
export interface MasterTimeline {
  /** Resume (or start) monotonic forward playback from the current playhead. */
  play(): void;
  /**
   * Play backward from the current playhead (PUL-F017 / ADR-020). The
   * `scrub`-mode transport surface uses this for the "scrub backward"
   * affordance; the adapter treats reverse playback as non-monotonic,
   * so audio cues crossed in reverse do not fire.
   */
  reverse(): void;
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
   * The scene-authored beats on this master, in playhead order (ties
   * broken by master label name for determinism). Excludes the
   * automatic segment-start anchors — see {@link MasterBeat}. A fresh
   * array each call; mutating it does not affect the master.
   */
  beats(): readonly MasterBeat[];
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
  /**
   * Dynamic audio cue gate (PUL-F017 / ADR-020). Present only for a
   * `scrub`-mode master; the transport methods toggle eligibility so
   * cues fire only on monotonic forward playback. Absent for every
   * other run mode — `#cueGate?.setEligible(...)` is then a no-op.
   */
  readonly #cueGate: CueGateControl | undefined;

  constructor(tl: GsapTimeline, cueGate?: CueGateControl) {
    this.#tl = tl;
    this.#cueGate = cueGate;
  }

  play(): void {
    // Monotonic forward playback — cues crossed forward are eligible.
    this.#cueGate?.setEligible(true);
    this.#tl.play();
  }

  reverse(): void {
    // Reverse playback is not monotonic forward — close the gate so a
    // cue crossed backward does not fire (PUL-F017 / ADR-020).
    this.#cueGate?.setEligible(false);
    this.#tl.reverse();
  }

  pause(): void {
    // A paused master is not playing forward — close the gate.
    this.#cueGate?.setEligible(false);
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

  beats(): readonly MasterBeat[] {
    const beats: MasterBeat[] = [];
    for (const [name, time] of Object.entries(this.#tl.labels)) {
      const parsed = parseSceneTimelineLabel(name);
      if (parsed === null) continue;
      beats.push({ ...parsed, name, time });
    }
    beats.sort((a, b) => {
      if (a.time !== b.time) return a.time - b.time;
      // Tie-break on the (unique) master label name so the order is
      // deterministic for beats that land at the same time.
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });
    return beats;
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
 * Throws {@link SceneTimelineTypeError} (a non-GSAP-timeline segment
 * value) or {@link SceneTimelineLabelError} (a malformed beat) — in
 * both cases before any timeline is nested. The resolver has already
 * called every scene's `timeline(ctx)` by the time this runs, so on
 * rejection this kills every GSAP timeline it was handed: a scene that
 * returned a default-playing or repeating timeline must not keep
 * ticking on the GSAP root after the resolver unmounts the scenes.
 * (A timeline already nested into a partial master is killed redundantly
 * — GSAP's `kill()` is idempotent.)
 */
/**
 * Inter-scene transition contract (L2-owned implementations live in
 * `src/system/transitions/`; the runtime carries the type so the
 * timeline composer can invoke them).
 *
 * A transition is invoked between two scene segments in a composition
 * slice. It receives the live master GSAP timeline, the master-time
 * position where the transition should land (the current end of the
 * master), an optional overlay element it can mutate, and the
 * caller-requested duration in milliseconds (overriding the
 * transition's own default if supplied).
 *
 * The transition returns the master-time duration its insertion
 * consumed (in seconds). The composer uses the return value to know
 * how far the master has advanced before adding the next scene.
 * `cut`-style transitions return 0 (no master-time consumed).
 */
export interface TransitionContext {
  readonly master: GsapTimeline;
  readonly insertAt: number;
  readonly overlay: HTMLElement | null;
  readonly durationMs: number;
}

export interface Transition {
  readonly name: string;
  readonly defaultDurationMs: number;
  /**
   * Insert this transition's effect into `ctx.master` at `ctx.insertAt`.
   * Return the master-time duration consumed (in seconds).
   */
  insert(ctx: TransitionContext): number;
}

/**
 * Map of transition name → implementation. Supplied to
 * {@link composeMasterTimeline} (via `createGsapCompositionTimeline`'s
 * `transitions` option) so the composer can resolve manifest-declared
 * transitions at slice-composition time.
 */
export type TransitionRegistry = ReadonlyMap<string, Transition>;

/**
 * Carry-through for the optional inter-scene transition declared in
 * `BehaviorOverride` for object-form composition entries. The
 * composer reads this shape; the L2 system layer's
 * `src/system/transitions/registry.ts` ships default implementations.
 */
export interface TransitionDeclaration {
  readonly name: string;
  readonly durationMs?: number;
}

const isTransitionDeclaration = (value: unknown): value is TransitionDeclaration => {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.name !== 'string' || rec.name.length === 0) return false;
  if (rec.durationMs !== undefined && typeof rec.durationMs !== 'number') return false;
  return true;
};

/**
 * Read a manifest entry's `behavior.transition` declaration (if any)
 * and apply the registered transition to the master at its current
 * end. No-op when the segment is the first, no registry is supplied,
 * the declaration is malformed, or the named transition is not
 * registered. Hoisted out of `composeMasterTimeline` to keep its
 * cognitive complexity under the Biome gate.
 */
function applySegmentTransition(
  master: GsapTimeline,
  segment: SceneTimelineSegment,
  segmentIndex: number,
  transitions: TransitionRegistry | undefined,
  overlay: HTMLElement | null,
): void {
  if (segmentIndex === 0 || transitions === undefined) return;
  const decl = (segment.behavior as { transition?: unknown } | undefined)?.transition;
  if (!isTransitionDeclaration(decl)) return;
  const t = transitions.get(decl.name);
  if (t === undefined) return;
  const dur = decl.durationMs ?? t.defaultDurationMs;
  t.insert({ master, insertAt: master.duration(), overlay, durationMs: dur });
}

/**
 * Compose options for {@link composeMasterTimeline}. Lifted into a
 * dedicated interface so the optional transitions registry + overlay
 * element can be added without breaking the existing positional-
 * arguments callers (the function still accepts the old signature).
 */
export interface ComposeMasterTimelineOptions {
  /** Transition implementations available to manifest entries. Absent = transitions ignored. */
  readonly transitions?: TransitionRegistry;
  /** Optional overlay element the registered transitions may mutate. */
  readonly transitionOverlay?: HTMLElement | null;
  /**
   * Dynamic audio cue gate (PUL-F017 / ADR-020). Supplied only for a
   * `scrub`-mode master; the resulting {@link MasterTimeline}'s
   * transport methods toggle it so audio cues fire only on monotonic
   * forward playback. Absent for every other run mode.
   */
  readonly audioCueGate?: CueGateControl;
}

/**
 * Copy a scene's child-timeline labels onto the master under the
 * namespaced `sceneTimelineLabel(...)` name, and emit a
 * `master.addPause(...)` at any label that opts into the advance-gate
 * convention. Hoisted out of `composeMasterTimeline` so the latter
 * stays within the cognitive-complexity gate.
 */
function copyChildLabelsAndAdvanceGates(
  master: GsapTimeline,
  child: GsapTimeline,
  segmentId: string,
  occurrence: number,
  start: number,
): void {
  for (const [localLabel, localTime] of Object.entries(child.labels)) {
    master.addLabel(sceneTimelineLabel(segmentId, localLabel, occurrence), start + localTime);
    if (localLabel === ADVANCE_GATE_LABEL || localLabel.startsWith(ADVANCE_GATE_PREFIX)) {
      master.addPause(start + localTime);
    }
  }
}

export function composeMasterTimeline(
  engine: TimelineEngine,
  segments: readonly SceneTimelineSegment[],
  options: ComposeMasterTimelineOptions = {},
): MasterTimeline {
  const transitions = options.transitions;
  const overlay = options.transitionOverlay ?? null;
  let master: GsapTimeline | undefined;
  try {
    for (const segment of segments) {
      assertSceneTimeline(segment.timeline, segment.id);
    }
    master = engine.gsap.timeline({ paused: true });
    const occurrences = new Map<string, number>();
    let segmentIndex = 0;
    for (const segment of segments) {
      // Insert an inter-scene transition before every segment after
      // the first, if the entry declared one via `behavior.transition`
      // and the registry has the named transition. Transitions
      // consume master time; the segment that follows is positioned
      // at the new end via `'>'` so the ordering is natural.
      applySegmentTransition(master, segment, segmentIndex, transitions, overlay);
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
        copyChildLabelsAndAdvanceGates(master, child, segment.id, occurrence, start);
      }
      segmentIndex++;
    }
    return new GsapMasterTimeline(master, options.audioCueGate);
  } catch (err) {
    master?.kill();
    for (const segment of segments) {
      if (isGsapTimeline(segment.timeline)) segment.timeline.kill();
    }
    throw err;
  }
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
  /**
   * Inter-scene transitions registry. When supplied, manifest entries
   * whose `behavior.transition` declares a name present in the
   * registry get an inserted transition tween between scenes during
   * master composition (see {@link composeMasterTimeline}). Absent =
   * transitions ignored (default behavior is `cut`, no master-time
   * consumed between scenes).
   */
  readonly transitions?: TransitionRegistry;
  /**
   * Overlay element transitions may mutate. Typically a transient
   * `<div data-pulsar-transition>` parented to `#stage` — never a
   * scene-owned element, so transitions cannot desynchronize scene
   * GSAP state.
   */
  readonly transitionOverlay?: HTMLElement | null;
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
 *  - `'scrub'` — left mounted and live, paused at the initial cursor;
 *    never auto-completes (`headCueGate`). The workbench scrub controls
 *    drive playback; the run resolves only on navigation abort.
 */
type MasterRunMode = 'hold' | 'loop' | 'play' | 'scrub';

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
 *  - `headCueGate: 'monotonic-forward'` (PUL-F017 / ADR-020): the scrub
 *    run mode. Seek to the addressed beat (the initial cursor — ADR-020
 *    §Beat semantics) or frame 0, then hold the master live so the
 *    workbench scrub controls can drive it. The initial seek is a
 *    direct seek, not monotonic forward play, so no cue fires for it.
 *    → `'scrub'`.
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
  if (opts.headCueGate === 'monotonic-forward') {
    master.seek(beatLabel ?? 0);
    master.pause();
    return 'scrub';
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
 * Per-segment occurrence counter used to compute the master label name
 * that anchors each segment. Mirrors the counting `composeMasterTimeline`
 * does when it adds `sceneSegmentLabel` markers so navigation handlers
 * can locate the same label after the fact.
 */
function buildSegmentLabelMap(
  segments: readonly SceneTimelineSegment[],
  master: MasterTimeline,
): readonly { id: string; label: string; time: number }[] {
  const occurrences = new Map<string, number>();
  const out: { id: string; label: string; time: number }[] = [];
  for (const segment of segments) {
    const n = occurrences.get(segment.id) ?? 0;
    occurrences.set(segment.id, n + 1);
    const label = sceneSegmentLabel(segment.id, n);
    const time = master.labels[label];
    if (typeof time === 'number') {
      out.push({ id: segment.id, label, time });
    }
  }
  return out;
}

/**
 * Translate a {@link PresenterCommand} into a master-timeline transport
 * action. Wired by {@link createGsapCompositionTimeline} so the
 * presenter keyboard / cross-window bridge / future remote source all
 * drive playback the same way:
 *
 *  - `advance` — if paused (at an addPause gate or a `hold`), resume.
 *    Otherwise seek forward to the next authored beat label OR next
 *    segment boundary (whichever is closer), then keep playing.
 *  - `hold` — toggle pause/resume at the current playhead.
 *  - `skip-forward` — seek to the start of the next segment.
 *  - `skip-backward` — seek to the start of the previous segment, or
 *    frame 0 if before the first segment.
 *  - `pause` / `resume` — explicit pause/play.
 *  - `toggle-master-mute` — handled by the loader against the audio
 *    service; ignored here.
 */
function presenterAdvance(master: MasterTimeline, segments: readonly SceneTimelineSegment[]): void {
  if (master.isPaused()) {
    master.play();
    return;
  }
  const now = master.time();
  const beatTimes = master.beats().map((b) => b.time);
  const segmentTimes = buildSegmentLabelMap(segments, master).map((s) => s.time);
  const next = [...beatTimes, ...segmentTimes]
    .filter((t) => t > now + 0.05)
    .sort((a, b) => a - b)[0];
  if (next !== undefined) master.seek(next);
  if (master.isPaused()) master.play();
}

function presenterSkipForward(
  master: MasterTimeline,
  segments: readonly SceneTimelineSegment[],
): void {
  const segs = buildSegmentLabelMap(segments, master);
  const next = segs.find((s) => s.time > master.time() + 0.05);
  if (next !== undefined) master.seek(next.time);
  if (master.isPaused()) master.play();
}

function presenterSkipBackward(
  master: MasterTimeline,
  segments: readonly SceneTimelineSegment[],
): void {
  const segs = buildSegmentLabelMap(segments, master);
  const prev = [...segs].reverse().find((s) => s.time < master.time() - 0.2);
  master.seek(prev?.time ?? 0);
  if (master.isPaused()) master.play();
}

function applyPresenterCommandToMaster(
  master: MasterTimeline,
  segments: readonly SceneTimelineSegment[],
  cmd: { readonly kind: string },
): void {
  switch (cmd.kind) {
    case 'hold':
      if (master.isPaused()) master.play();
      else master.pause();
      return;
    case 'pause':
      master.pause();
      return;
    case 'resume':
      master.play();
      return;
    case 'advance':
      presenterAdvance(master, segments);
      return;
    case 'skip-forward':
      presenterSkipForward(master, segments);
      return;
    case 'skip-backward':
      presenterSkipBackward(master, segments);
      return;
    default:
      return; // toggle-master-mute / toggle-practice / unknown — not master's concern
  }
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
 *    owns abort, a test harness). If positioning already left the master
 *    at (or past) its finite end — e.g. `headBeat` seeked to a beat the
 *    scene authored at its own end and that scene is the composition's
 *    tail — `play()` would not re-fire `onComplete`, so resolve right
 *    away instead of parking the resolver until an abort that may never
 *    come.
 *  - `'loop'`: start (infinite) playback; only abort resolves it. With
 *    no signal there is nothing to wait for, so resolve immediately —
 *    a loop cannot be observed without cancellation.
 *  - `'hold'` / `'scrub'`: the master is already paused; only abort
 *    resolves it. With no signal, resolve immediately — the held frame
 *    has been rendered. Under `'scrub'` the master is additionally left
 *    live for the workbench scrub controls to drive between now and
 *    abort; the run does not arm a completion handler, so playing the
 *    scrub master to its natural end does not tear the scene down.
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
      const duration = master.duration();
      if (Number.isFinite(duration) && duration > 0 && master.time() >= duration) {
        // Already at the end after positioning — playing from progress 1
        // does not re-fire `onComplete` in GSAP. Treat it as completed.
        finish();
        return;
      }
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
  const { engine, onMaster, transitions, transitionOverlay } = options;
  return {
    run(segments, opts) {
      let master: MasterTimeline;
      let mode: MasterRunMode;
      try {
        // Build the options object piecewise so the
        // exactOptionalPropertyTypes-strict signature doesn't see
        // `undefined` for unset keys.
        const composeOpts: ComposeMasterTimelineOptions = {};
        if (transitions !== undefined) {
          (composeOpts as { transitions?: TransitionRegistry }).transitions = transitions;
        }
        if (transitionOverlay !== undefined) {
          (composeOpts as { transitionOverlay?: HTMLElement | null }).transitionOverlay =
            transitionOverlay;
        }
        // PUL-F017 / ADR-020: wire the dynamic audio cue gate into the
        // master ONLY under the scrub run mode. Outside scrub the gate
        // is never wired, so a normal play-through master's transport
        // never toggles cue eligibility.
        if (opts.headCueGate === 'monotonic-forward' && opts.audioCueGate !== undefined) {
          (composeOpts as { audioCueGate?: CueGateControl }).audioCueGate = opts.audioCueGate;
        }
        master = composeMasterTimeline(engine, segments, composeOpts);
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
      // Wire the per-navigation presenter controller to master-timeline
      // navigation. The controller is signal-bound (per-handler
      // auto-detach on navigation abort), so we never accumulate
      // subscriptions across activations.
      if (opts.presenter !== undefined) {
        opts.presenter.subscribe((cmd) => {
          applyPresenterCommandToMaster(master, segments, cmd);
        });
      }
      return runMasterUntilDone(master, mode, opts.signal);
    },
  };
}
