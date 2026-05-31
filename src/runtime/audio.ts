// Audio orchestration — PUL-F024 / ADR-004. The runtime's audio boundary,
// so scenes reach audio through `ctx.audio`, never Howler or `<audio>`.
//
//  - `createHowlerAudioEngine()` wraps Howler behind the {@link AudioEngine}
//    port (the only `import ... from 'howler'` site); `noopAudioEngine` is
//    the silent fallback when no engine is wired.
//  - `createAudioService(engine, opts)` is the per-navigation `ctx.audio`:
//    playback / fades / sprites / loops / named groups + master mute.
//    Bound to the navigation `AbortSignal` — on supersession/dispose/
//    completion it `stopAll()`s, so nothing survives scene cleanup
//    (PUL-P001). One service per composition slice, so sound ids and the
//    source allowlist are slice-scoped (registering an id twice with the
//    same definition is idempotent). A scene's `group` is scene-scoped
//    across repeated occurrences (issue #99); the loader stops it only
//    after the LAST occurrence's cleanup, never cutting a live sibling.
//
// Source URLs reuse PUL-F005's `resolveAssetUrl`; every registered source
// must be in the slice's declared `scene.audio` (PUL-F030 / ADR-029 — the
// audio-source allowlist, itself a subset of `scene.assets`). Sound ids
// and group names are kebab-case (ADR-008 #1).

import { Howl, Howler, type SoundSpriteDefinitions } from 'howler';
import { type AssetUrlPolicy, DEFAULT_ALLOWED_SCHEMES, resolveAssetUrl } from './asset-preloader';
import { describeError } from './error';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import { deepFreeze, isPlainRecord } from './object';

/* ------------------------------------------------------------------ *
 *  Errors
 * ------------------------------------------------------------------ */

/**
 * Which failure mode an {@link AudioError} represents. No `src/` caller
 * branches on the error type, so the service carries this discriminant
 * instead of a subclass-per-mode hierarchy; callers/tests tell a bad
 * group from a bad volume range by reading `.category`.
 *
 *  - `sound`  — bad/unknown/re-registered sound id or unknown sprite.
 *  - `group`  — group name is not a kebab-case identifier.
 *  - `source` — bad scheme/URL, or a source not in `scene.audio`
 *    (PUL-F030 / ADR-029 — the audio-source allowlist).
 *  - `range`  — volume / fade endpoint / rate / sprite or fade duration
 *    out of its allowed numeric range.
 *  - `option` — a service / play option has the wrong type or shape.
 */
export type AudioErrorCategory = 'sound' | 'group' | 'source' | 'range' | 'option';

/**
 * Every error the audio service raises. `category` is the failure-mode
 * discriminant (the role the former per-mode subclasses played);
 * `name` is the stable `'AudioError'`.
 */
export class AudioError extends Error {
  readonly category: AudioErrorCategory;

  constructor(category: AudioErrorCategory, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AudioError';
    this.category = category;
  }
}

// Per-category constructors so throw sites read as one line.
const soundError = (message: string, options?: ErrorOptions): AudioError =>
  new AudioError('sound', message, options);
const groupError = (message: string): AudioError => new AudioError('group', message);
const sourceError = (message: string, options?: ErrorOptions): AudioError =>
  new AudioError('source', message, options);
const rangeError = (message: string): AudioError => new AudioError('range', message);
const optionError = (message: string): AudioError => new AudioError('option', message);

/* ------------------------------------------------------------------ *
 *  Engine port — the Howler boundary
 * ------------------------------------------------------------------ */

/**
 * Sprite definitions: name → `[startMs, durationMs]` or
 * `[startMs, durationMs, loop]` (matching Howler's sprite shape). The
 * record is the runtime's own type so `ctx.audio` callers never depend
 * on `howler`'s types.
 */
export type AudioSpriteMap = Readonly<
  Record<string, readonly [number, number] | readonly [number, number, boolean]>
>;

/** What an {@link AudioEngine} needs to construct one sound. */
export interface AudioSoundConfig {
  /** Source URL(s), in codec-preference order (like Howler's `src`). Non-empty. */
  readonly src: readonly string[];
  /** Optional sprite definitions. */
  readonly sprite?: AudioSpriteMap;
  /** Construct the sound muted (used by `silent` services — screenshot / paused modes). */
  readonly muted: boolean;
  /** Non-fatal sink for this sound's async load / play failures. */
  readonly onError: (err: unknown) => void;
}

/**
 * One sound produced by an {@link AudioEngine}. The methods mirror the
 * slice of Howler's `Howl` the service drives; `playId` is the per-play
 * handle `play()` returns — a plain number, not a Howler object — so a
 * group stop targets exactly the instances it tagged.
 */
export interface AudioSoundHandle {
  /** Start playback (optionally of a named sprite); returns the per-play id. */
  play(sprite?: string): number;
  /** Stop one play instance, or every instance when `playId` is omitted. */
  stop(playId?: number): void;
  /** Fade one (or every) instance from `from` to `to` over `durationMs`. */
  fade(from: number, to: number, durationMs: number, playId?: number): void;
  /** Set the loop flag on one (or every) instance. */
  loop(enabled: boolean, playId?: number): void;
  /** Set the volume of one (or every) instance, 0..1. */
  volume(value: number, playId?: number): void;
  /**
   * Set the playback rate (speed) of one (or every) instance.
   * 1.0 = normal speed; 1.25 = 25% faster; 0.5 = half speed. Howler
   * uses the Web Audio playback-rate node which preserves pitch in
   * the WebAudio path (PUL-F024 / ADR-004).
   */
  rate(value: number, playId?: number): void;
  /** Free this sound's buffers. Idempotent. */
  unload(): void;
}

/**
 * The audio engine: a sound factory plus master-mute state. A process
 * singleton in production (`createHowlerAudioEngine()` — Howler's global
 * is itself a singleton), like {@link import('./timeline').TimelineEngine}.
 */
export interface AudioEngine {
  /** Build a sound from `config`. */
  createSound(config: AudioSoundConfig): AudioSoundHandle;
  /** Mute / unmute every sound the engine produces (persistent runtime state). */
  setMasterMute(muted: boolean): void;
  /** Whether the engine is currently master-muted. */
  isMasterMuted(): boolean;
  /**
   * Resume the underlying audio context so subsequent playback satisfies
   * browser autoplay policy (PUL-F030 / ADR-029). The loader/workbench
   * unlock adapter calls this AFTER collecting an explicit user gesture
   * and BEFORE present-mode composition lifecycle work begins. The
   * Howler-backed engine forwards to `Howler.ctx.resume()` (a no-op when
   * Howler runs in its no-audio fallback, e.g. Node tests). The no-op
   * engine resolves immediately. Idempotent — successive calls after the
   * context is running resolve without side effects.
   */
  unlock(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 *  Howler-backed engine
 * ------------------------------------------------------------------ */

/** The slice of Howler's mutable global the unlock dance reads. */
interface HowlerHandle {
  ctx: AudioContext | null | undefined;
  noAudio: boolean | undefined;
  usingWebAudio: boolean | undefined;
}

/** 44-byte silent WAV used by both unlock fallback branches. */
const SILENT_UNLOCK_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

/**
 * HTML5-audio autoplay-policy unlock: `play()` a muted silent `<audio>`
 * during the user gesture so the document's HTML5 audio is marked
 * user-activated. Requires `globalThis.Audio`; rejects (fails closed) if
 * it is absent. Used when Howler falls back to HTML5 audio
 * (`usingWebAudio === false`).
 */
async function unlockHtml5Fallback(): Promise<void> {
  type AudioCtor = new (src?: string) => HTMLAudioElement;
  const AudioCtor = (globalThis as unknown as { Audio?: AudioCtor }).Audio;
  if (AudioCtor === undefined) {
    throw new Error(
      'audio unlock: Howler is in HTML5 mode but globalThis.Audio is unavailable — cannot satisfy autoplay policy',
    );
  }
  const probe = new AudioCtor(SILENT_UNLOCK_WAV);
  probe.muted = true;
  await probe.play();
  probe.pause();
}

/**
 * Web Audio autoplay-policy unlock: ensure `Howler.ctx` exists (via a
 * throwaway `Howl` so `ctx` AND `masterGain` are created together), then
 * `resume()` it. Fails closed if setup throws or no ctx/`resume()` exists.
 * Idempotent.
 */
async function resumeWebAudioContext(howler: HowlerHandle): Promise<void> {
  if (howler.ctx === null || howler.ctx === undefined) {
    try {
      const seed = new Howl({ src: [SILENT_UNLOCK_WAV] });
      seed.unload();
    } catch (cause) {
      throw new Error(
        `audio unlock: Howler setup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
  const ctx = howler.ctx;
  if (ctx === null || ctx === undefined) {
    throw new Error(
      'audio unlock: Howler setup completed but Howler.ctx is still null — cannot resume audio',
    );
  }
  if (typeof ctx.resume !== 'function') {
    throw new TypeError('audio unlock: Howler.ctx.resume is not a function');
  }
  await ctx.resume();
}

function wrapHowl(howl: Howl): AudioSoundHandle {
  return {
    play: (sprite) => (sprite === undefined ? howl.play() : howl.play(sprite)),
    stop: (playId) => {
      howl.stop(playId);
    },
    fade: (from, to, durationMs, playId) => {
      howl.fade(from, to, durationMs, playId);
    },
    loop: (enabled, playId) => {
      howl.loop(enabled, playId);
    },
    volume: (value, playId) => {
      if (playId === undefined) howl.volume(value);
      else howl.volume(value, playId);
    },
    rate: (value, playId) => {
      if (playId === undefined) howl.rate(value);
      else howl.rate(value, playId);
    },
    unload: () => {
      // Howler's `unload()` dereferences a sound node that its no-audio
      // fallback never creates, throwing a TypeError. In a browser
      // (where the runtime actually runs) `unload()` is the right call;
      // under Node's no-audio Howler, stopping is all that is needed.
      if (Howler.noAudio) {
        howl.stop();
        return;
      }
      howl.unload();
    },
  };
}

/**
 * Build the production {@link AudioEngine} backed by Howler. Call once
 * (Howler's global is a process singleton, so master mute is global).
 * Autoplay policy is centralized by Howler's Web Audio mode +
 * `Howler.autoUnlock` (ADR-004) — no first cue is lost. Howler's
 * `loaderror` / `playerror` route to the service's non-fatal `onError`.
 */
export function createHowlerAudioEngine(): AudioEngine {
  let masterMuted = false;
  return {
    createSound(config) {
      const howl = new Howl({
        src: [...config.src],
        // The runtime's `AudioSpriteMap` widens to Howler's mutable
        // `SoundSpriteDefinitions` at this one boundary; Howler reads it
        // at construction. Scenes pass the readonly shape.
        ...(config.sprite === undefined ? {} : { sprite: config.sprite as SoundSpriteDefinitions }),
        ...(config.muted ? { mute: true } : {}),
        onloaderror: (_id, err) => {
          config.onError(err);
        },
        onplayerror: (_id, err) => {
          config.onError(err);
        },
      });
      return wrapHowl(howl);
    },
    setMasterMute(muted) {
      masterMuted = muted;
      Howler.mute(muted);
    },
    isMasterMuted() {
      return masterMuted;
    },
    // PUL-F030 / ADR-029: satisfy browser autoplay policy. MUST either
    // actually unlock playback OR REJECT, so the gate fails closed (never
    // "click resolved but the first cue is still suspended"). Three
    // branches:
    //  1. `noAudio` — no backend (Node/disabled); nothing to unlock.
    //  2. `usingWebAudio === false` — HTML5 fallback: play a silent
    //     `<audio>` under the gesture (reject if `globalThis.Audio` absent).
    //  3. Web Audio — construct/resume the ctx inside the gesture tick.
    async unlock() {
      const howler = Howler as unknown as HowlerHandle;
      // Branch 1: explicit no-audio fallback — nothing to unlock.
      if (howler.noAudio === true) return;
      // Branch 2: Howler fell back to HTML5 audio.
      if (howler.usingWebAudio === false) {
        await unlockHtml5Fallback();
        return;
      }
      // Branch 3: Web Audio path.
      await resumeWebAudioContext(howler);
    },
  };
}

/**
 * A silent {@link AudioEngine}: every sound it produces is a no-op
 * handle. Mirrors Howler's own `noAudio` graceful degradation — the
 * scene loader uses it when no engine is wired so `ctx.audio` is always
 * a working (if mute) service, and Node-side / test callers get a
 * deterministic engine. Master mute is still tracked so `mute` /
 * `isMuted` round-trip.
 */
export const noopAudioEngine: AudioEngine = (() => {
  let masterMuted = false;
  const handle: AudioSoundHandle = {
    play: () => 0,
    stop: () => undefined,
    fade: () => undefined,
    loop: () => undefined,
    volume: () => undefined,
    rate: () => undefined,
    unload: () => undefined,
  };
  return {
    createSound: () => handle,
    setMasterMute: (muted) => {
      masterMuted = muted;
    },
    isMasterMuted: () => masterMuted,
    // PUL-F030 / ADR-029: a no-audio engine has no browser context to
    // resume, so unlock is a deterministic resolved promise.
    unlock: () => Promise.resolve(),
  };
})();

/* ------------------------------------------------------------------ *
 *  The audio service (`ctx.audio`)
 * ------------------------------------------------------------------ */

/** What a scene passes to {@link AudioService.load} to register one sound. */
export interface SoundDefinition {
  /**
   * Source URL, or URLs in codec-preference order. Every URL must be
   * declared in the active composition slice's `scene.audio` (PUL-F030
   * / ADR-029 — the audio-source allowlist; every `scene.audio` entry
   * is also a member of `scene.assets` so the preloader warms it,
   * ADR-008 #5) and must pass the asset scheme allowlist
   * ({@link import('./asset-preloader').DEFAULT_ALLOWED_SCHEMES}).
   * Re-registering an id with the same definition (same `src` list,
   * same `sprite` map) is idempotent — e.g. a shared transition SFX two
   * scenes both `load`; re-registering it with a different definition
   * is an {@link AudioError} (`category: 'sound'`).
   */
  readonly src: string | readonly string[];
  /** Optional sprite definitions (offsets/durations in ms; optional third element marks a sprite looping). */
  readonly sprite?: AudioSpriteMap;
}

/** Per-play options for {@link AudioService.play}. */
export interface PlayOptions {
  /** Play a named sprite of the sound instead of the whole file. */
  readonly sprite?: string;
  /** Loop this play instance until it is stopped. */
  readonly loop?: boolean;
  /** Volume for this play instance, 0..1 (master mute / `silent` still override). */
  readonly volume?: number;
  /** Tag this play with a named group (kebab-case) so `stopGroup` can stop it. */
  readonly group?: string;
  /**
   * Playback rate (speed) multiplier for this play instance. 1.0 =
   * normal; 1.25 = 25% faster; 0.5 = half speed. Must be a finite
   * number > 0. Howler preserves pitch in the WebAudio path.
   */
  readonly rate?: number;
}

/**
 * Public allowlist of audio output policies (PUL-F024 / PUL-F026 /
 * ADR-004). Frozen so consumers cannot mutate the public set, and
 * mirrored by {@link AudioOutputPolicy} so the type and the runtime
 * check share one source of truth — same pattern
 * {@link import('./navigation').NAVIGATION_MODES} uses. Adding a value
 * here automatically widens the type, the validation, and any
 * `(AUDIO_OUTPUT_POLICIES as readonly string[]).includes(...)`
 * defense-in-depth check at the loader.
 */
export const AUDIO_OUTPUT_POLICIES = Object.freeze(['audible', 'silent', 'log-cues'] as const);

/**
 * Output policy for the audio service (PUL-F024 / PUL-F026 / ADR-004).
 *
 * The policy is held on the per-navigation service rather than the
 * engine because rehearsal vs screenshot vs paused vs present is a
 * per-navigation contract — the engine is a process singleton.
 *
 *  - `'audible'` (default) — sounds are constructed unmuted; cue
 *    requests reach the engine and produce audio. The historical
 *    default for `mode=present` / `mode=standalone` / `mode=loop` /
 *    `mode=scrub`.
 *  - `'silent'` — sounds are constructed muted at the engine. The
 *    workbench-mode capture / paused-inspection contract: `mode=
 *    screenshot` / `mode=paused` build the service silent because
 *    audible playback is suppressed (ADR-019 / ADR-021).
 *  - `'log-cues'` — sounds are constructed muted AND each accepted
 *    audio operation (post-validation, post-engine-call) emits a
 *    semantic {@link AudioCueLogEntry} to the optional
 *    {@link AudioServiceOptions.onCue} sink. The PUL-F026 / ADR-004
 *    rehearsal-mode contract: "audio is silenced OR logged as cues
 *    without altering timeline state." With no sink wired the policy
 *    is effectively silent (the workbench attaches no cue UI / log
 *    surface today).
 *
 * Future variations (silent rehearsal as a distinct mode, export
 * silence, ducking, bus volume, an audio-status UI) extend this same
 * union rather than adding scattered branches across the runtime.
 */
export type AudioOutputPolicy = (typeof AUDIO_OUTPUT_POLICIES)[number];

/**
 * Common fields shared by every {@link AudioCueLogEntry} variant.
 * Factored out so a consumer that does not narrow by `operation` can
 * still read `sequence` and `operation` without branching.
 */
interface AudioCueLogBase {
  /**
   * Per-service monotonic sequence number. Starts at `1` for the
   * first emitted cue and increments by one per emitted cue. A
   * service that emits no cues never assigns a sequence.
   */
  readonly sequence: number;
}

/** A `play` cue (PUL-F026 / ADR-004). `soundId` is always present. */
export interface AudioCueLogPlay extends AudioCueLogBase {
  readonly operation: 'play';
  readonly soundId: string;
  readonly sprite?: string;
  readonly group?: string;
  readonly volume?: number;
  readonly loop?: boolean;
  readonly rate?: number;
}

/** A `fade` cue (PUL-F026 / ADR-004). `soundId` and `fade` are always present. */
export interface AudioCueLogFade extends AudioCueLogBase {
  readonly operation: 'fade';
  readonly soundId: string;
  readonly fade: { readonly from: number; readonly to: number; readonly durationMs: number };
}

/** A `stop` cue (PUL-F026 / ADR-004). `soundId` is always present. */
export interface AudioCueLogStop extends AudioCueLogBase {
  readonly operation: 'stop';
  readonly soundId: string;
}

/** A `stop-group` cue (PUL-F026 / ADR-004). `group` is present; `soundId` is forbidden (the call targets a group, not a sound). */
export interface AudioCueLogStopGroup extends AudioCueLogBase {
  readonly operation: 'stop-group';
  readonly group: string;
}

/**
 * One rehearsal cue-log entry (PUL-F026 / ADR-004), emitted by
 * `outputPolicy: 'log-cues'` after an operation is accepted. SEMANTIC
 * ONLY — ids, names, numeric params, the `operation`, a monotonic
 * `sequence` — never source URLs, handles, paths, headers, scene objects,
 * or payload. `load` / `mute` are not cues; rejected or post-dispose
 * operations do not emit. A discriminated union over `operation` so
 * impossible shapes are rejected at the type level.
 *
 * Entries are returned deep-frozen so a consumer cannot mutate the
 * log (or any nested payload such as `fade`) in place.
 */
export type AudioCueLogEntry =
  | AudioCueLogPlay
  | AudioCueLogFade
  | AudioCueLogStop
  | AudioCueLogStopGroup;

/**
 * A composition-level audio bed (PUL-F014 / ADR-004): a single
 * continuous looping source that belongs to the *composition*, not to
 * any one scene. Unlike a `scene.audio` sound reached through
 * `ctx.audio`, the bed is started by the runtime when a composition
 * navigation begins and runs underneath every scene in the slice — an
 * ambient pad, room tone, or musical bed. It loops for the lifetime of
 * the navigation and is torn down with the audio service.
 *
 * `mode=standalone` suppresses the bed entirely (PUL-F014): a scene
 * inspected on its own runs "as if no surrounding composition
 * existed," so the surrounding bed must not play. Suppression is the
 * {@link AudioServiceOptions.bedSuppressed} scope — deliberately
 * distinct from {@link AudioOutputPolicy} `'silent'`, which would also
 * silence the scene's own audio.
 *
 * The bed has no sprites and no groups: it is one looping source. A
 * future crossfade / ducking / multi-bed need extends this
 * declaration at this one seam rather than scattering bed flags.
 */
export interface AudioBedDeclaration {
  /**
   * Source URL, or an ordered codec-preference fallback list (same
   * shape as {@link SoundDefinition.src}). Every URL passes the same
   * scheme allowlist and {@link AudioServiceOptions.allowedSources}
   * membership check scene sounds pass.
   */
  readonly src: string | readonly string[];
  /**
   * Optional playback volume in `[0, 1]`. Omit for the engine default.
   */
  readonly volume?: number;
}

/* ------------------------------------------------------------------ *
 *  Dynamic cue eligibility gate (PUL-F017 / ADR-020)
 * ------------------------------------------------------------------ */

/**
 * Read-only view of the dynamic audio cue-eligibility gate (PUL-F017 /
 * ADR-020). The audio service consults {@link isEligible} after a cue
 * has passed every boundary check and before it reaches the engine: a
 * closed gate suppresses the cue's audible output without masking a
 * malformed cue.
 *
 * The gate is deliberately distinct from the static
 * {@link AudioOutputPolicy}: `silent` / `log-cues` are a per-navigation
 * contract decided at construction, whereas the cue gate is toggled
 * *during* a navigation by playhead movement direction — a `scrub`-mode
 * master that plays backwards closes the gate so cues do not re-fire on
 * reverse playback, and re-opens it on monotonic forward playback.
 */
export interface CueGate {
  /** Whether audio cues are currently eligible to produce output. */
  isEligible(): boolean;
}

/**
 * Controllable {@link CueGate}. The GSAP timeline adapter holds this
 * side and toggles eligibility from its transport methods so the
 * decision of *when* to gate stays in one place (the runner that owns
 * playhead direction) — never in chrome event handlers or scene
 * modules. Scenes receive the {@link AudioService}, never this control.
 */
export interface CueGateControl extends CueGate {
  /** Open (`true`) or close (`false`) the gate. */
  setEligible(eligible: boolean): void;
}

/**
 * Build a {@link CueGateControl}. Eligible by default; pass
 * `initialEligible: false` for a `scrub`-mode master, which starts
 * paused (not playing monotonically forward) so its cues are ineligible
 * until the user presses play.
 */
export function createCueGate(initialEligible = true): CueGateControl {
  let eligible = initialEligible;
  return {
    isEligible: () => eligible,
    setEligible: (next) => {
      eligible = next;
    },
  };
}

/** Construction options for {@link createAudioService}. */
export interface AudioServiceOptions {
  /**
   * Navigation lifecycle signal. When it aborts the service `stopAll()`s
   * (every sound stopped + unloaded, groups cleared, the service marked
   * disposed) — so audio never survives the navigation that started it.
   * An already-aborted signal disposes the service immediately.
   */
  readonly signal: AbortSignal;
  /**
   * Per-navigation audio output policy (PUL-F024 / PUL-F026 / ADR-004).
   * Defaults to `'audible'`. `'silent'` mutes at engine construction
   * time (screenshot / paused). `'log-cues'` mutes AND emits a
   * semantic {@link AudioCueLogEntry} to {@link onCue} for every
   * accepted audio operation (rehearsal).
   */
  readonly outputPolicy?: AudioOutputPolicy;
  /**
   * Cue-log sink for {@link AudioOutputPolicy} `'log-cues'`. Receives
   * a frozen {@link AudioCueLogEntry} per accepted audio operation
   * (post-validation, post-engine-call). Non-fatal: a throwing sink is
   * swallowed so a workbench-side log surface bug does not break
   * scene playback. Inert under any policy other than `'log-cues'`
   * even when supplied — the policy decides whether cues are emitted,
   * not the presence of the sink. Inert post-dispose.
   */
  readonly onCue?: (entry: AudioCueLogEntry) => void;
  /**
   * The source URLs scenes may register. Every {@link SoundDefinition.src}
   * URL must be in this set (PUL-F030 / ADR-029 — `scene.audio` is the
   * authoritative audio-source allowlist; the loader passes the union
   * of every scene's `scene.audio` in the active slice. Every entry is
   * also a member of `scene.assets`, which the preloader warms,
   * ADR-008 #5). Omit to skip the membership check (non-composition /
   * test callers); scheme validation still applies.
   */
  readonly allowedSources?: Iterable<string>;
  /**
   * Asset URL policy shared with validation and the preloader. When
   * supplied, every scene sound source and composition bed source is
   * resolved with the same `baseUrl` / `allowedSchemes` rules before
   * reaching the engine. Omit to keep the default authoring policy.
   */
  readonly assetPolicy?: AssetUrlPolicy;
  /** Sink for non-fatal async audio errors (load / play failure). Defaults to a no-op. */
  readonly onError?: (err: unknown) => void;
  /**
   * Composition-level audio bed (PUL-F014 / ADR-004). When supplied —
   * and not suppressed — the service starts it looping at construction
   * time and tears it down with `stopAll()`. The loader passes the
   * resolved composition's {@link AudioBedDeclaration}; a non-
   * composition navigation omits it. The bed is internal: it is NOT
   * reachable through any {@link AudioService} method, so scenes (which
   * receive the service as `ctx.audio`) cannot start, observe, or stop
   * it — composition-level bed playback stays distinct from scene-owned
   * `ctx.audio` playback.
   */
  readonly bed?: AudioBedDeclaration;
  /**
   * Suppress the composition audio {@link bed} entirely (PUL-F014).
   * When `true`, the bed is never loaded or played — the loader sets
   * this for `mode=standalone`, where a scene runs as if no surrounding
   * composition existed. Defaults to `false`. This is a bed-specific
   * scope: scene-owned `ctx.audio` playback is unaffected, unlike
   * {@link AudioOutputPolicy} `'silent'`.
   */
  readonly bedSuppressed?: boolean;
  /**
   * Dynamic cue-eligibility gate (PUL-F017 / ADR-020). When supplied,
   * {@link AudioService.play} suppresses a cue's audible output
   * (post-validation) whenever {@link CueGate.isEligible} returns
   * `false`. The scene loader wires this for `mode=scrub` and the GSAP
   * timeline adapter toggles it by playhead direction, so "audio cues
   * fire only on monotonic forward playback" holds. Omit it for every
   * other navigation — an absent gate means cues are always eligible,
   * so non-scrub playback is unchanged.
   */
  readonly cueGate?: CueGate;
}

/**
 * The audio service scenes see as `ctx.audio` (ADR-004). Per-navigation;
 * one instance is shared across a composition's slice — named groups
 * give per-scene grouping inside that. Every mutating method is inert
 * after the service is disposed (navigation end) so a stale callback
 * from a superseded scene cannot make sound.
 */
export interface AudioService {
  /**
   * Register a sound under `soundId` (kebab-case). Throws an
   * {@link AudioError} with `category: 'sound'` on a malformed or
   * already-used id and `category: 'source'` when a `src` URL has a
   * disallowed scheme, is malformed, or is not in `allowedSources`.
   */
  load(soundId: string, definition: SoundDefinition): void;
  /**
   * Play a registered sound. Throws an {@link AudioError} with
   * `category: 'sound'` on an unknown sound id or sprite name,
   * `category: 'group'` on a malformed group name, `category: 'range'`
   * on an out-of-range volume.
   */
  play(soundId: string, options?: PlayOptions): void;
  /**
   * Fade every playing instance of `soundId` from `from` to `to` over
   * `durationMs` milliseconds. Throws an {@link AudioError} with
   * `category: 'sound'` on an unknown sound and `category: 'range'` on
   * an out-of-range endpoint or duration.
   */
  fade(soundId: string, from: number, to: number, durationMs: number): void;
  /** Stop every playing instance of `soundId`. Throws {@link AudioError} (`category: 'sound'`) on an unknown sound. */
  stop(soundId: string): void;
  /**
   * Stop every play instance tagged with `group`. Throws an
   * {@link AudioError} with `category: 'group'` on a malformed group
   * name; an unknown or already-emptied group is a no-op.
   */
  stopGroup(group: string): void;
  /** Set master mute (persistent runtime state on the engine). */
  mute(muted: boolean): void;
  /** Whether the engine is currently master-muted. */
  isMuted(): boolean;
  /** Stop and unload every registered sound; clear groups; mark the service disposed. Idempotent. */
  stopAll(): void;
  /** Whether the service has been torn down (navigation ended). */
  isDisposed(): boolean;
}

const GAIN_MIN = 0;
const GAIN_MAX = 1;

/**
 * `sounds`-map key the composition audio bed (PUL-F014) is registered
 * under. Deliberately NOT a valid kebab identifier: every scene-facing
 * `load` / `play` / `stop` runs `assertSoundId`, so no scene can ever
 * name, collide with, or reach the bed entry — bed playback stays
 * distinct from scene-owned `ctx.audio` playback. Registering it in the
 * shared `sounds` map still gives the bed `stopAll()` / abort teardown
 * for free.
 */
const BED_SOUND_KEY = 'composition audio bed';

interface RegisteredSound {
  readonly handle: AudioSoundHandle;
  readonly spriteNames: ReadonlySet<string>;
  /** Normalized source list, kept so a re-`load` of the same id can verify the definition matches. */
  readonly src: readonly string[];
  /** Sprite map, kept for the same definition-equality check. */
  readonly sprite: AudioSpriteMap | undefined;
}

interface GroupedPlay {
  readonly handle: AudioSoundHandle;
  readonly playId: number;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Element-wise equality of two source lists. */
const sameSourceList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((url, i) => url === b[i]);

/** Element-wise equality of two sprite tuples (`[start, duration]` or `[start, duration, loop]`). */
const sameSpriteTuple = (
  av: readonly [number, number] | readonly [number, number, boolean] | undefined,
  bv: readonly [number, number] | readonly [number, number, boolean] | undefined,
): boolean => {
  if (av?.length !== bv?.length) return false;
  if (av === undefined || bv === undefined) return true;
  return av.every((v, i) => v === bv[i]);
};

/** Equality of two optional sprite maps (same keys, each tuple element-wise equal). */
const sameSpriteMap = (a: AudioSpriteMap | undefined, b: AudioSpriteMap | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => sameSpriteTuple(a[key], b[key]));
};

/**
 * Validate one sprite-map entry (`name → [startMs, durationMs]` or
 * `[startMs, durationMs, loop]`). Split per-entry so
 * {@link assertSoundDefinition}'s sprite loop stays a flat iteration
 * under the cognitive-complexity gate.
 */
function assertSpriteEntry(soundId: string, name: string, def: unknown): void {
  if (name === '') {
    throw soundError(`audio sound "${soundId}" has a sprite with an empty name`);
  }
  if (!Array.isArray(def) || (def.length !== 2 && def.length !== 3)) {
    throw soundError(
      `audio sound "${soundId}" sprite "${name}" must be [startMs, durationMs] or [startMs, durationMs, loop]`,
    );
  }
  if (!isFiniteNumber(def[0]) || def[0] < 0 || !isFiniteNumber(def[1]) || def[1] < 0) {
    throw rangeError(
      `audio sound "${soundId}" sprite "${name}" offset and duration must be finite, non-negative milliseconds; got [${def[0]}, ${def[1]}]`,
    );
  }
  if (def.length === 3 && typeof def[2] !== 'boolean') {
    throw soundError(
      `audio sound "${soundId}" sprite "${name}" loop flag must be a boolean; got ${typeof def[2]}`,
    );
  }
}

/**
 * Validate the {@link SoundDefinition} payload shape at the runtime
 * boundary — scenes are repo-owned but author-fallible plain JS, so the
 * static type does not hold. `src` must be a string or array; the
 * optional `sprite` map (a field of the definition) is validated here
 * too, so the whole definition passes one boundary assert.
 */
function assertSoundDefinition(
  soundId: string,
  definition: unknown,
): asserts definition is SoundDefinition {
  if (!isPlainRecord(definition)) {
    throw soundError(
      `audio sound "${soundId}" definition must be an object with at least a "src" field`,
    );
  }
  const src = (definition as { src?: unknown }).src;
  if (typeof src !== 'string' && !Array.isArray(src)) {
    throw sourceError(`audio sound "${soundId}" "src" must be a string or array of strings`);
  }
  const sprite = (definition as { sprite?: unknown }).sprite;
  if (sprite === undefined) return;
  if (!isPlainRecord(sprite)) {
    throw soundError(
      `audio sound "${soundId}" sprite map must be an object of name → [startMs, durationMs] or [startMs, durationMs, loop]`,
    );
  }
  for (const [name, def] of Object.entries(sprite)) assertSpriteEntry(soundId, name, def);
}

/**
 * Validate an {@link AudioBedDeclaration} payload shape at the runtime
 * boundary — composition registrations can be plain JS, so the static
 * type does not hold. `src` must be a string or array; `volume` (if
 * present) must be a number. Deep source validation (scheme allowlist,
 * `allowedSources` membership) and the `[0, 1]` volume range check run
 * later inside the audio service against the same gates scene sounds
 * pass — this is only the shallow shape guard, mirroring
 * {@link assertSoundDefinition}. Exported so the composition-
 * registration boundary (PUL-F003) and the runtime validation pass
 * (PUL-F028) reject a malformed bed up front.
 */
export function assertAudioBedDeclaration(value: unknown): asserts value is AudioBedDeclaration {
  if (!isPlainRecord(value)) {
    throw optionError('audio bed declaration must be an object with at least a "src" field');
  }
  const src = (value as { src?: unknown }).src;
  if (typeof src !== 'string' && !Array.isArray(src)) {
    throw sourceError('audio bed "src" must be a string or array of strings');
  }
  const volume = (value as { volume?: unknown }).volume;
  if (volume !== undefined && typeof volume !== 'number') {
    throw rangeError(`audio bed "volume" must be a number; got ${typeof volume}`);
  }
}

/**
 * The simple-typed {@link PlayOptions} fields and the {@link AudioError}
 * category each raises on a type mismatch. `sprite` / `loop` are
 * `sound`, `group` is `group`, `volume` is `range` (its numeric range
 * is checked later by `assertGain`); `rate` is validated separately
 * because it is range-bounded, not just typed.
 */
const PLAY_OPTION_TYPES: readonly {
  readonly name: keyof PlayOptions;
  readonly type: 'string' | 'boolean' | 'number';
  readonly category: AudioErrorCategory;
}[] = [
  { name: 'sprite', type: 'string', category: 'sound' },
  { name: 'loop', type: 'boolean', category: 'sound' },
  { name: 'group', type: 'string', category: 'group' },
  { name: 'volume', type: 'number', category: 'range' },
];

/**
 * Validate the {@link PlayOptions} payload shape at the runtime
 * boundary — scenes can be plain JS, so the static type does not hold.
 * Each option is type-checked before the play is attempted; volume is
 * also range-checked later by `assertGain` inside the service.
 */
function assertPlayOptions(
  soundId: string,
  options: unknown,
): asserts options is PlayOptions | undefined {
  if (options === undefined) return;
  if (!isPlainRecord(options)) {
    throw soundError(`audio sound "${soundId}" play options must be an object or omitted`);
  }
  const opts = options as Record<string, unknown>;
  for (const { name, type, category } of PLAY_OPTION_TYPES) {
    const value = opts[name];
    const actual = typeof value;
    if (value !== undefined && actual !== type) {
      throw new AudioError(
        category,
        `audio sound "${soundId}" play option "${name}" must be a ${type}; got ${actual}`,
      );
    }
  }
  const rate = opts.rate;
  if (rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0)) {
    throw rangeError(
      `audio sound "${soundId}" play option "rate" must be a finite number > 0; got ${typeof rate === 'number' ? rate : typeof rate}`,
    );
  }
}

/**
 * Validate one audio source URL for a registration (a scene sound or
 * the composition bed). Three checks, in order:
 *
 *  1. The URL is a non-empty string — scene modules can be plain JS,
 *     so the static type does not hold.
 *  2. The URL resolves under the supplied asset policy, or under
 *     {@link DEFAULT_ALLOWED_SCHEMES} when no policy was supplied.
 *     This is the same `baseUrl` / `allowedSchemes` rule the
 *     validation pass and asset preloader use, so hardened
 *     deployments do not get a looser audio-bed URL path when
 *     validation is skipped.
 *  3. When `allowedForSource` is non-null, the URL is a member of it.
 *     PUL-F030 / ADR-029: `scene.audio` is the audio-source allowlist
 *     for scene sounds; for the composition bed it is the bed's own
 *     declared `src`. A URL outside the registration's allowlist is
 *     rejected — even if it happens to be in `scene.assets`. This is
 *     what makes the present-mode unlock gate predicate and the
 *     runtime audio-source allowlist agree, and what keeps the bed
 *     source out of the scene-facing `ctx.audio.load()` allowlist.
 *
 * Module-scope and pure (no closure captures): owns the per-URL
 * allowlist/policy decision for one source so `normalizeSources` maps
 * over its inputs without inlining the branching.
 */
function normalizeAudioUrl(
  soundId: string,
  url: unknown,
  allowedForSource: ReadonlySet<string> | null,
  assetPolicy: AssetUrlPolicy | undefined,
): string {
  if (typeof url !== 'string' || url === '') {
    throw sourceError(`audio sound "${soundId}" source must be a non-empty URL string`);
  }
  let resolved: string;
  try {
    resolved = resolveAssetUrl(
      url,
      assetPolicy?.baseUrl,
      assetPolicy?.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES,
    );
  } catch (cause) {
    throw sourceError(
      `audio sound "${soundId}" source "${url}" is invalid: ${describeError(cause)}`,
      { cause },
    );
  }
  if (allowedForSource !== null && !allowedForSource.has(url)) {
    throw sourceError(
      `audio sound "${soundId}" source "${url}" is not a declared audio source — list it in scene.audio (and ensure it is also in scene.assets so the preloader warms it) per PUL-F030 / ADR-029`,
    );
  }
  return resolved;
}

/**
 * Render an unknown value for a boundary-validation error message,
 * falling back to `typeof` + `String()` for values `JSON.stringify`
 * cannot encode (BigInt, Symbol) so misuse always yields an {@link AudioError}.
 */
function describeRawOption(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Fall through to the typeof path for BigInt / cyclic / etc.
  }
  return `${typeof value}(${String(value)})`;
}

/**
 * Build the `play` rehearsal-cue payload (PUL-F026): the soundId plus the
 * supplied play options, with NO source URL.
 */
function buildPlayCue(soundId: string, opts: PlayOptions): Omit<AudioCueLogPlay, 'sequence'> {
  return {
    operation: 'play',
    soundId,
    ...(opts.sprite === undefined ? {} : { sprite: opts.sprite }),
    ...(opts.group === undefined ? {} : { group: opts.group }),
    ...(opts.volume === undefined ? {} : { volume: opts.volume }),
    ...(opts.loop === undefined ? {} : { loop: opts.loop }),
    ...(opts.rate === undefined ? {} : { rate: opts.rate }),
  };
}

/**
 * Start one play instance on `handle`, apply per-play options (loop /
 * volume / rate) keyed to the returned `playId`, and return that `playId`.
 */
function applyPlayToHandle(handle: AudioSoundHandle, opts: PlayOptions): number {
  const playId = handle.play(opts.sprite);
  if (opts.loop === true) handle.loop(true, playId);
  if (opts.volume !== undefined) handle.volume(opts.volume, playId);
  if (opts.rate !== undefined) handle.rate(opts.rate, playId);
  return playId;
}

/**
 * Register and start the composition audio bed (PUL-F014) through the
 * shared {@link registerSound} core, with the bed's OWN `src` as its
 * allowlist — so the bed URL can never leak into the scene-facing
 * `ctx.audio.load()` allowlist. `register` returns `undefined` for an
 * idempotent re-registration.
 */
function startCompositionBed(
  bed: AudioBedDeclaration,
  register: (
    key: string,
    definition: SoundDefinition,
    allowedForSource: ReadonlySet<string> | null,
  ) => AudioSoundHandle | undefined,
  assertGain: (value: number, what: string) => void,
): void {
  if (bed.volume !== undefined) assertGain(bed.volume, 'bed volume');
  const allowed = new Set(typeof bed.src === 'string' ? [bed.src] : bed.src);
  const handle = register(BED_SOUND_KEY, { src: bed.src }, allowed);
  if (handle === undefined) return;
  const playId = handle.play();
  handle.loop(true, playId);
  if (bed.volume !== undefined) handle.volume(bed.volume, playId);
}

export function createAudioService(
  engine: AudioEngine,
  options: AudioServiceOptions,
): AudioService {
  // Reject the legacy `silent: boolean` key loudly (codex review,
  // cycle 3). The previous public option was `silent?: boolean`; the
  // new public option is the more general `outputPolicy`. A
  // plain-JS / downstream caller that still passes `{ silent: true }`
  // would have the key silently ignored and produce audible playback
  // — the worst possible migration failure for an audio-suppression
  // option. Fail loud at the boundary instead.
  if ('silent' in options) {
    throw optionError(
      "audio 'silent' option was replaced by outputPolicy in PUL-F026 / ADR-004 — pass outputPolicy: 'silent' / 'log-cues' / 'audible' instead",
    );
  }
  // Runtime boundary: validate `outputPolicy` against the allowlist BEFORE
  // defaulting (`undefined` → `'audible'`), so a misspelled / non-string
  // value fails loud rather than coalescing via `??` into dead-air playback.
  const policyArg: unknown = options.outputPolicy;
  if (
    policyArg !== undefined &&
    !(AUDIO_OUTPUT_POLICIES as readonly unknown[]).includes(policyArg)
  ) {
    const quotedPolicies = AUDIO_OUTPUT_POLICIES.map((p) => `'${p}'`).join(' / ');
    throw optionError(
      `audio outputPolicy must be one of ${quotedPolicies}; got ${describeRawOption(policyArg)}`,
    );
  }
  const outputPolicy: AudioOutputPolicy = (policyArg ?? 'audible') as AudioOutputPolicy;
  // Validate `onCue` at construction so a non-function fails loud rather
  // than being swallowed inside the non-fatal `emitCue` try/catch (which
  // would leave rehearsal with an empty cue stream and no diagnostic).
  if (options.onCue !== undefined && typeof options.onCue !== 'function') {
    throw optionError(
      `audio onCue must be a function or omitted; got ${describeRawOption(options.onCue)}`,
    );
  }
  // PUL-F014 bed shape check up front; deep source/volume validation runs
  // in `startBed` against the same gates scene sounds pass.
  if (options.bed !== undefined) {
    assertAudioBedDeclaration(options.bed);
  }
  if (options.bedSuppressed !== undefined && typeof options.bedSuppressed !== 'boolean') {
    throw optionError(
      `audio bedSuppressed must be a boolean or omitted; got ${describeRawOption(
        options.bedSuppressed,
      )}`,
    );
  }
  // Collapse `outputPolicy` to its two orthogonal axes once, so no method
  // re-derives from the string: `muted` (silent + log-cues) is the
  // no-audible-output defense; `emitCues` (log-cues only) gates the rehearsal sink.
  const muted = outputPolicy !== 'audible';
  const emitCues = outputPolicy === 'log-cues';
  const onError = options.onError ?? ((): void => undefined);
  const onCue = options.onCue;
  const assetPolicy = options.assetPolicy;
  const allowed = options.allowedSources === undefined ? null : new Set(options.allowedSources);
  // PUL-F017 / ADR-020: the dynamic cue-eligibility gate. Absent for
  // every navigation except `mode=scrub`; an absent gate means cues
  // are always eligible, so non-scrub playback is unchanged.
  const cueGate = options.cueGate;

  const sounds = new Map<string, RegisteredSound>();
  const groups = new Map<string, GroupedPlay[]>();
  // Disposal gate: both `options.signal` and `stopAll()` feed this one
  // controller, so `lifecycle.signal.aborted` is the single disposed-check.
  // Teardown runs once, on its abort.
  const lifecycle = new AbortController();
  const disposed = (): boolean => lifecycle.signal.aborted;
  // Monotonic `AudioCueLogEntry.sequence`, only bumped on an actual emit.
  let cueSequence = 0;

  /**
   * Emit a cue log entry to the optional `onCue` sink (PUL-F026 / ADR-004).
   * Inert unless the policy is `'log-cues'`, a sink is wired, and the
   * service is live. A throwing sink is swallowed so it cannot break
   * scene playback.
   */
  // Per-variant `Omit<…, 'sequence'>` (not on the union) so TypeScript keeps
  // each variant's required fields and narrows the discriminated union.
  type CueInput =
    | Omit<AudioCueLogPlay, 'sequence'>
    | Omit<AudioCueLogFade, 'sequence'>
    | Omit<AudioCueLogStop, 'sequence'>
    | Omit<AudioCueLogStopGroup, 'sequence'>;
  const emitCue = (entry: CueInput): void => {
    if (!emitCues || onCue === undefined || disposed()) return;
    cueSequence += 1;
    // Deep-freeze: the cue log is read-only, and `Object.freeze` alone
    // would leave nested payloads (e.g. `fade`) mutable.
    const frozen = deepFreeze({ sequence: cueSequence, ...entry });
    try {
      onCue(frozen);
    } catch {
      // Intentionally empty: the cue-log sink is non-fatal.
    }
  };

  const assertSoundId = (soundId: string): void => {
    if (!isKebabIdentifier(soundId)) {
      throw soundError(
        `audio sound id "${soundId}" is invalid: sound ids must be lowercase kebab-case identifiers (${KEBAB_IDENTIFIER_FORM})`,
      );
    }
  };

  const assertGroupName = (group: string): void => {
    if (!isKebabIdentifier(group)) {
      throw groupError(
        `audio group name "${group}" is invalid: group names must be lowercase kebab-case identifiers (${KEBAB_IDENTIFIER_FORM})`,
      );
    }
  };

  const assertGain = (value: number, what: string): void => {
    if (!isFiniteNumber(value) || value < GAIN_MIN || value > GAIN_MAX) {
      throw rangeError(
        `audio ${what} must be a finite number in [${GAIN_MIN}, ${GAIN_MAX}]; got ${value}`,
      );
    }
  };

  const requireSound = (soundId: string): RegisteredSound => {
    assertSoundId(soundId);
    const sound = sounds.get(soundId);
    if (sound === undefined) {
      throw soundError(
        `audio sound "${soundId}" is not registered — call ctx.audio.load("${soundId}", ...) first`,
      );
    }
    return sound;
  };

  /**
   * Validate `play` options against the registered `sound` (sprite, group,
   * volume), after `assertPlayOptions` has shape-checked the payload.
   */
  const validatePlay = (soundId: string, sound: RegisteredSound, opts: PlayOptions): void => {
    if (opts.sprite !== undefined && !sound.spriteNames.has(opts.sprite)) {
      throw soundError(unknownSpriteMessage(soundId, opts.sprite, sound.spriteNames));
    }
    if (opts.group !== undefined) assertGroupName(opts.group);
    if (opts.volume !== undefined) assertGain(opts.volume, 'volume');
  };

  /**
   * Route an engine-side cleanup failure through the non-fatal `onError`
   * sink (swallowing any further sink throw) so the cleanup loops keep
   * iterating with per-item isolation.
   */
  const reportCleanupError = (where: string, target: string, cause: unknown): void => {
    try {
      onError(
        soundError(`audio ${where}("${target}") failed: ${describeError(cause)}`, {
          cause,
        }),
      );
    } catch {
      // Intentionally empty: the diagnostic sink is non-fatal.
    }
  };

  // `normalizeSources` validates a registration's source list:
  // non-empty, then each item through `assertValidAudioUrl`. The
  // `allowedForSource` argument is the membership allowlist for THIS
  // registration: scene sounds pass `allowed` (the slice's declared
  // `scene.audio`); the composition bed (PUL-F014) passes its own
  // declared `src` list via `startBed` — the bed declaration is
  // authoritative for the bed exactly as `scene.audio` is for scenes.
  // Keeping the gate per-registration is what stops the bed source
  // from leaking into the scene-facing `ctx.audio.load()` allowlist
  // (codex review, cycle 1 — "composition bed source leaks into scene
  // audio allowlist"). `null` skips the membership check
  // (non-composition / test callers); scheme validation still applies.
  const normalizeSources = (
    soundId: string,
    src: string | readonly string[],
    allowedForSource: ReadonlySet<string> | null,
  ): string[] => {
    const list = typeof src === 'string' ? [src] : [...src];
    if (list.length === 0) {
      throw sourceError(`audio sound "${soundId}" has no source — provide at least one URL`);
    }
    return list.map((url) => normalizeAudioUrl(soundId, url, allowedForSource, assetPolicy));
  };

  const unknownSpriteMessage = (
    soundId: string,
    sprite: string,
    names: ReadonlySet<string>,
  ): string => {
    const known = names.size === 0 ? '' : ` — known sprites: ${[...names].join(', ')}`;
    return `audio sound "${soundId}" has no sprite "${sprite}"${known}`;
  };

  /**
   * Register a sound under `key` and return its handle, or `undefined`
   * when the key is already bound to an identical definition (idempotent
   * re-`load` of a shared SFX). The single registration core shared by
   * the scene-facing `load` and the composition-bed startup below.
   *
   * `allowedForSource` is the membership allowlist for THIS
   * registration: scene sounds pass `allowed` (the slice's declared
   * `scene.audio`); the composition bed passes its OWN declared `src`
   * set — NOT the scene-facing `allowedSources` — so routing the bed
   * through the scene allowlist can never leak the bed URL into
   * `ctx.audio.load()` (codex review, cycle 1). A re-`load` with a
   * different definition is an {@link AudioError} (`category: 'sound'`).
   */
  const registerSound = (
    key: string,
    definition: SoundDefinition,
    allowedForSource: ReadonlySet<string> | null,
  ): AudioSoundHandle | undefined => {
    // Sprites are validated up front by `assertSoundDefinition`; the bed
    // carries none. Both callers reach here validated-or-absent.
    const src = normalizeSources(key, definition.src, allowedForSource);
    const existing = sounds.get(key);
    if (existing !== undefined) {
      // Idempotent re-registration of the same sound (slice-scoped id
      // namespace); a different definition is a genuine conflict.
      if (sameSourceList(existing.src, src) && sameSpriteMap(existing.sprite, definition.sprite)) {
        return undefined;
      }
      throw soundError(`audio sound "${key}" is already registered with a different definition`);
    }
    const spriteNames: ReadonlySet<string> = new Set(
      definition.sprite === undefined ? [] : Object.keys(definition.sprite),
    );
    const handle = engine.createSound({
      src,
      ...(definition.sprite === undefined ? {} : { sprite: definition.sprite }),
      muted,
      onError: (err) => {
        // Howler async load failures can arrive after the navigation ended;
        // a disposed service must not write a stale diagnostic, and this
        // non-fatal sink must not throw back through Howler.
        if (disposed()) return;
        try {
          onError(soundError(`audio sound "${key}": ${describeError(err)}`, { cause: err }));
        } catch {
          // Intentionally empty: the diagnostic sink is non-fatal.
        }
      },
    });
    sounds.set(key, { handle, spriteNames, src, sprite: definition.sprite });
    return handle;
  };

  const service: AudioService = {
    load(soundId, definition) {
      if (disposed()) return;
      assertSoundId(soundId);
      assertSoundDefinition(soundId, definition);
      // Scene-facing `load`: the allowlist is the slice's `scene.audio`
      // (`allowed`); the bed source is excluded, so a scene cannot register it.
      registerSound(soundId, definition, allowed);
    },

    play(soundId, options) {
      if (disposed()) return;
      assertPlayOptions(soundId, options);
      const sound = requireSound(soundId);
      const opts = options ?? {};
      validatePlay(soundId, sound, opts);
      // PUL-F017 / ADR-020: cue gate, AFTER validation (a malformed cue
      // still fails loud) and BEFORE any output — a closed gate means the
      // master is not playing monotonically forward, so the cue is silent.
      if (cueGate !== undefined && !cueGate.isEligible()) return;
      const playId = applyPlayToHandle(sound.handle, opts);
      if (opts.group !== undefined) {
        const list = groups.get(opts.group);
        if (list === undefined) groups.set(opts.group, [{ handle: sound.handle, playId }]);
        else list.push({ handle: sound.handle, playId });
      }
      // Rehearsal cue log (PUL-F026); `emitCue` short-circuits unless
      // log-cues + a sink. `buildPlayCue` carries the options, no URL.
      emitCue(buildPlayCue(soundId, opts));
    },

    fade(soundId, from, to, durationMs) {
      if (disposed()) return;
      const sound = requireSound(soundId);
      assertGain(from, 'fade start volume');
      assertGain(to, 'fade end volume');
      if (!isFiniteNumber(durationMs) || durationMs < 0) {
        throw rangeError(
          `audio fade duration must be a finite, non-negative number of milliseconds; got ${durationMs}`,
        );
      }
      sound.handle.fade(from, to, durationMs);
      emitCue({
        operation: 'fade',
        soundId,
        fade: { from, to, durationMs },
      });
    },

    stop(soundId) {
      if (disposed()) return;
      const sound = requireSound(soundId);
      sound.handle.stop();
      emitCue({ operation: 'stop', soundId });
    },

    stopGroup(group) {
      if (disposed()) return;
      assertGroupName(group);
      const list = groups.get(group);
      if (list !== undefined) {
        // Per-play error isolation: a throwing engine `stop()` must not
        // block later plays — every play in the group is attempted.
        for (const play of list) {
          try {
            play.handle.stop(play.playId);
          } catch (err) {
            reportCleanupError('stopGroup', group, err);
          }
        }
        groups.delete(group);
      }
      // PUL-F026: emit AFTER the stop loop + bookkeeping delete (parity
      // with `play` / `fade` / `stop`); an empty group still records a cue.
      emitCue({ operation: 'stop-group', group });
    },

    mute(muted) {
      if (disposed()) return;
      // Runtime boundary: scenes can be plain JS, so the boolean type does not hold.
      if (typeof muted !== 'boolean') {
        throw optionError(`audio mute argument must be a boolean; got ${typeof muted}`);
      }
      engine.setMasterMute(muted);
    },

    isMuted() {
      return engine.isMasterMuted();
    },

    // Disposal triggers the `lifecycle` controller; teardown runs on its
    // abort. Idempotent.
    stopAll() {
      lifecycle.abort();
    },

    isDisposed() {
      return disposed();
    },
  };

  // The one place sounds are stopped + unloaded, so abort and `stopAll()`
  // share one teardown (PUL-F024 / ADR-004 — audio never outlives the navigation).
  const teardown = (): void => {
    // Per-sound error isolation: a throwing `stop()` / `unload()` must not
    // block later sounds; bookkeeping is cleared unconditionally.
    for (const [soundId, sound] of sounds) {
      try {
        sound.handle.stop();
      } catch (err) {
        reportCleanupError('stopAll', soundId, err);
      }
      try {
        sound.handle.unload();
      } catch (err) {
        reportCleanupError('stopAll', soundId, err);
      }
    }
    sounds.clear();
    groups.clear();
  };

  // Wire teardown BEFORE anything can abort the gate.
  lifecycle.signal.addEventListener('abort', teardown, { once: true });

  // Composition audio bed (PUL-F014): a looping source registered through
  // the same core into the same `sounds` map (so it gets teardown for free)
  // under the reserved {@link BED_SOUND_KEY} — deliberately NOT a kebab id,
  // so scene-facing `load` / `play` / `stop` (which run `assertSoundId`) can
  // never reach it. Gated against the bed's OWN `src`. Skipped when
  // suppressed (standalone), absent, or the navigation already aborted.
  if (options.bed !== undefined && options.bedSuppressed !== true && !options.signal.aborted) {
    startCompositionBed(options.bed, registerSound, assertGain);
  }

  // Forward navigation abort into the gate (pre-aborted → dispose at once).
  if (options.signal.aborted) {
    lifecycle.abort();
  } else {
    options.signal.addEventListener('abort', () => lifecycle.abort(), { once: true });
  }

  return service;
}
