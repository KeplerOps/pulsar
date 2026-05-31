// Timeline orchestration — PUL-F022 / PUL-F023. The GSAP timeline adapter
// (ADR-003 / ADR-025) and canonical home of the named-beat grammar
// (ADR-008 #1 / ADR-026):
//
//  - Scenes get GSAP as `ctx.gsap` and author their own timeline; they do
//    not import GSAP. A scene timeline's labels ARE its beats — kebab-case
//    at a finite time ≤ duration, enforced by `assertSceneTimeline` when a
//    scene timeline first enters the runtime. The labels are the single
//    source of truth — there is no `SceneModule.beats` field (ADR-015).
//  - `composeMasterTimeline` nests the slice's scene timelines into one
//    master, namespacing each scene's labels so a repeated scene id
//    (ADR-002) keeps an unambiguous label space.
//  - `MasterTimeline` is the PUL-F022 transport + PUL-F023 beat-query
//    surface (play / pause / seek / validated positive speed / `labels` /
//    `hasLabel` / `labelFor` / `beats`). `sceneTimelineLabel` builds a
//    master beat name; `parseSceneTimelineLabel` is the one inverse.
//  - `createGsapCompositionTimeline` is the composition adapter the
//    resolver drives (ADR-011 / ADR-025): compose the master, apply head
//    hints, play, resolve on natural completion or abort.
//
// A scene that authors no timeline returns `null`; the adapter composes it
// as a zero-duration segment rather than rejecting it.

import { gsap } from 'gsap';
import type { CueGateControl } from './audio';
import type {
  CompositionTimelineAdapter,
  CompositionTimelineRunOptions,
  SceneTimelineSegment,
} from './composition-resolver';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import { wirePresenterCommands } from './presenter-transport';

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
 * beats. `null` / `undefined` are accepted as "no timeline authored"
 * (the placeholder scene returns `null`); any other non-timeline
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
/**
 * A label's time must be a finite number in `[0, duration]` — a label
 * outside the scene's content is not a usable moment. `kind` is the noun
 * the error uses (`sentinel label` for runtime sentinels, `beat` for
 * authored beats) so both callers share one range check.
 */
function validateLabelTime(
  sceneId: string,
  kind: string,
  label: string,
  time: number,
  duration: number,
): void {
  if (!Number.isFinite(time) || time < 0 || time > duration) {
    throw new SceneTimelineLabelError(
      `scene "${sceneId}" timeline ${kind} "${label}" is at an invalid time ${time}: a ${kind} time must be a finite number between 0 and the scene timeline duration (${duration}s)`,
    );
  }
}

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
      validateLabelTime(sceneId, 'sentinel label', label, time, duration);
      continue;
    }
    if (!isKebabIdentifier(label)) {
      throw new SceneTimelineLabelError(
        `scene "${sceneId}" timeline label "${label}" is not a valid beat: beat labels must be lowercase kebab-case identifiers (${KEBAB_IDENTIFIER_FORM})`,
      );
    }
    validateLabelTime(sceneId, 'beat', label, time, duration);
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
 * One composition segment anchor on the composed master timeline. This
 * is the scene-level cursor surface used by presenter navigation; it
 * deliberately excludes scene-authored beat labels.
 */
export interface MasterSegment {
  /** The scene id this composition segment plays. */
  readonly id: string;
  /** The segment's 0-based position in the active composition slice. */
  readonly index: number;
  /** Which occurrence of `id` this segment represents. */
  readonly occurrence: number;
  /** The segment-start master label. */
  readonly label: string;
  /** The segment-start time on the master timeline, in seconds. */
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
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0) {
      const got = typeof multiplier === 'number' ? `${multiplier}` : typeof multiplier;
      throw new TimelineSpeedError(
        `timeline speed must be a finite number greater than 0; got ${got}`,
      );
    }
    this.#tl.timeScale(multiplier);
  }

  speed(): number {
    return this.#tl.timeScale();
  }

  repeat(count: number): void {
    if (!Number.isInteger(count) || count < -1) {
      throw new TimelineSpeedError(`timeline repeat count must be an integer >= -1; got ${count}`);
    }
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
 * Inter-scene transition contract (L2 implementations in
 * `src/system/transitions/`; the runtime carries the type so the composer
 * can invoke them). Invoked between two segments with the live master, the
 * master-time `insertAt`, an optional overlay, and an override duration;
 * returns the master-time seconds consumed (`cut`-style returns 0).
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

/** Compose options for {@link composeMasterTimeline}. */
export interface ComposeMasterTimelineOptions {
  /** Transition implementations available to manifest entries. Absent = transitions ignored. */
  readonly transitions?: TransitionRegistry;
  /** Optional overlay element the registered transitions may mutate. */
  readonly transitionOverlay?: HTMLElement | null;
  /**
   * Called when forward playback reaches a segment-start anchor. Direct
   * presenter skips report their target explicitly and do not rely on
   * this GSAP callback.
   */
  readonly onSegmentStart?: (segment: MasterSegment) => void;
  /**
   * Dynamic audio cue gate (PUL-F017 / ADR-020). Supplied only for a
   * `scrub`-mode master; the resulting {@link MasterTimeline}'s
   * transport methods toggle it so audio cues fire only on monotonic
   * forward playback. Absent for every other run mode.
   */
  readonly audioCueGate?: CueGateControl;
}

/**
 * Copy a scene's labels onto the master under the namespaced
 * `sceneTimelineLabel(...)` name, adding a `master.addPause(...)` at any
 * advance-gate label.
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

/**
 * Compose `segments` into one master GSAP timeline (PUL-F022 C2),
 * appending each in order with namespaced labels so a repeated scene id
 * (ADR-002) keeps an unambiguous label space. `null` segments contribute
 * zero duration; nested `{ paused: true }` scene timelines are un-paused,
 * the master itself stays paused at 0. Throws (before nesting any
 * timeline) on a non-GSAP value or a malformed beat, killing every
 * timeline it was handed so none keeps ticking after unmount.
 */
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
      const segmentLabel = sceneSegmentLabel(segment.id, occurrence);
      const segmentAnchor: MasterSegment = {
        id: segment.id,
        index: segmentIndex,
        occurrence,
        label: segmentLabel,
        time: start,
      };
      master.addLabel(segmentLabel, start);
      if (options.onSegmentStart !== undefined) {
        master.call(() => options.onSegmentStart?.(segmentAnchor), [], start);
      }
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
   * Observability + UI-state seam: invoked when the active scene
   * segment changes. Presenter skips call it directly from the segment
   * cursor; forward playback may also call it from segment-start
   * timeline callbacks.
   */
  readonly onSegmentChange?: (segment: MasterSegment) => void;
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
 * Head hints that freeze the master at the addressed beat (or frame 0)
 * and never play, in precedence order — same positioning
 * (`seek(beat ?? 0); pause()`), differing only in run mode (so the branch
 * is table-driven). `headHold` is excluded: it holds at frame 0 before any
 * beat lookup (`mode=paused` is first-frame inspection).
 */
const PAUSE_AT_BEAT_HINTS: readonly {
  readonly engaged: (opts: CompositionTimelineRunOptions) => boolean;
  readonly mode: MasterRunMode;
}[] = [
  { engaged: (o) => o.headScreenshot === 'capture', mode: 'hold' },
  { engaged: (o) => o.headCueGate === 'monotonic-forward', mode: 'scrub' },
];

/**
 * Apply the head hints to the composed master (seek / pause / repeat) and
 * report its run mode: `headHold` → `'hold'` at frame 0 (wins over all);
 * `headScreenshot` → `'hold'` at the beat; `headRepeat` → `'loop'`;
 * `headCueGate` → `'scrub'` (held live for the scrub controls); else
 * seek any `headBeat` and `'play'`.
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
  const pauseHint = PAUSE_AT_BEAT_HINTS.find((hint) => hint.engaged(opts));
  if (pauseHint !== undefined) {
    master.seek(beatLabel ?? 0);
    master.pause();
    return pauseHint.mode;
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
 * Compute each segment's anchoring master label, mirroring the occurrence
 * counting `composeMasterTimeline` does so handlers can locate the labels.
 */
function buildSegmentLabelMap(
  segments: readonly SceneTimelineSegment[],
  master: MasterTimeline,
): readonly MasterSegment[] {
  const occurrences = new Map<string, number>();
  const out: MasterSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    const n = occurrences.get(segment.id) ?? 0;
    occurrences.set(segment.id, n + 1);
    const label = sceneSegmentLabel(segment.id, n);
    const time = master.labels[label];
    if (typeof time === 'number') {
      out.push({ id: segment.id, index, occurrence: n, label, time });
    }
  }
  return out;
}

/**
 * The 0-based index of the composition segment whose start time the
 * `time` playhead has reached, scanning from the tail so the most recent
 * boundary wins. `-1` for an empty slice; `0` before the first segment
 * start. The present-mode presenter transport (`presenter-transport.ts`)
 * uses this to keep its scene cursor in sync with the playhead.
 */
export const segmentIndexAtTime = (segments: readonly MasterSegment[], time: number): number => {
  if (segments.length === 0) return -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment !== undefined && time >= segment.time - 0.001) return i;
  }
  return 0;
};

/**
 * Run the positioned master and resolve when the activation is done —
 * natural end (so the resolver tears scenes down) or abort — killing the
 * master so the GSAP ticker idles.
 *  - `'play'`: resolve on completion (or immediately if already at a
 *    finite end, since `play()` would not re-fire `onComplete`).
 *  - `'loop'`: only abort resolves it (immediate without a signal).
 *  - `'hold'` / `'scrub'`: already paused; only abort resolves it. `'scrub'`
 *    is left live for the scrub controls and arms no completion handler.
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
        // Already at the end — `play()` from progress 1 won't re-fire `onComplete`.
        finish();
        return;
      }
      // Arm `onComplete` BEFORE play() so a very short master cannot complete first.
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
 * Per-activation observability sink for active-segment changes. `report`
 * de-duplicates consecutive identical segments (so a segment-start callback
 * landing where a seek already reported does not double-fire);
 * `reportInitial` seeds it from the positioned playhead.
 */
interface SegmentReporter {
  report(segment: MasterSegment): void;
  reportInitial(master: MasterTimeline, segmentAnchors: readonly MasterSegment[]): void;
}

const createSegmentReporter = (
  onSegmentChange: ((segment: MasterSegment) => void) | undefined,
): SegmentReporter => {
  let lastReportedSegment: string | null = null;
  const report = (segment: MasterSegment): void => {
    const key = `${segment.label}@${segment.index}`;
    if (key === lastReportedSegment) return;
    lastReportedSegment = key;
    onSegmentChange?.(segment);
  };
  return {
    report,
    reportInitial(master, segmentAnchors) {
      const initial = segmentAnchors[segmentIndexAtTime(segmentAnchors, master.time())];
      if (initial !== undefined) report(initial);
    },
  };
};

const buildRunComposeOptions = (
  opts: CompositionTimelineRunOptions,
  options: GsapCompositionTimelineOptions,
  reporter: SegmentReporter,
): ComposeMasterTimelineOptions => ({
  ...(options.transitions !== undefined && { transitions: options.transitions }),
  ...(options.transitionOverlay !== undefined && {
    transitionOverlay: options.transitionOverlay,
  }),
  ...(options.onSegmentChange !== undefined && {
    onSegmentStart: (segment: MasterSegment) => reporter.report(segment),
  }),
  ...(opts.headCueGate === 'monotonic-forward' &&
    opts.audioCueGate !== undefined && { audioCueGate: opts.audioCueGate }),
});

/**
 * Build the GSAP-backed {@link CompositionTimelineAdapter} the resolver
 * drives. Each `run(segments, opts)` composes the master, applies head
 * hints, reports it via `onMaster`, then plays — resolving on natural
 * completion or `opts.signal` abort. A non-timeline value rejects.
 * `opts.presenter` is the opt-in present-mode seam:
 * {@link import('./presenter-transport').wirePresenterCommands} translates
 * commands to transport (never instantiated for non-present navigations).
 */
export function createGsapCompositionTimeline(
  options: GsapCompositionTimelineOptions,
): CompositionTimelineAdapter {
  const { engine, onMaster, onSegmentChange } = options;
  return {
    run(segments, opts) {
      let master: MasterTimeline;
      let mode: MasterRunMode;
      let segmentAnchors: readonly MasterSegment[];
      const reporter = createSegmentReporter(onSegmentChange);
      try {
        const composeOpts = buildRunComposeOptions(opts, options, reporter);
        master = composeMasterTimeline(engine, segments, composeOpts);
        segmentAnchors = buildSegmentLabelMap(segments, master);
        mode = positionMaster(master, segments[0]?.id, opts);
        reporter.reportInitial(master, segmentAnchors);
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
      // Wire the presenter controller to master transport — only when
      // `opts.presenter` is set; signal-bound, so subscriptions never leak.
      wirePresenterCommands(master, segmentAnchors, opts, (segment) => reporter.report(segment));
      return runMasterUntilDone(master, mode, opts.signal);
    },
  };
}
