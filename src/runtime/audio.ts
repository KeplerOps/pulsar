// Audio orchestration — PUL-F024 / ADR-004. The runtime's audio service.
//
// ADR-004 picks Howler.js as the audio engine and mandates that scenes
// reach audio through the runtime context, never by importing Howler or
// touching `<audio>` directly. This module is that boundary:
//
//  - `createHowlerAudioEngine()` wraps Howler behind the small
//    {@link AudioEngine} port — parallel to `createTimelineEngine()`
//    wrapping GSAP (ADR-003). It is the only `import ... from 'howler'`
//    site. `noopAudioEngine` is the silent fallback (mirrors Howler's
//    own `noAudio` graceful degradation) the scene loader uses when no
//    engine is wired — the same inert-seam pattern `renderPrompter` /
//    `presenterCommands` follow.
//  - `createAudioService(engine, opts)` is the per-navigation service
//    scenes see as `ctx.audio`. It exposes per-scene playback (`play` /
//    `stop`), fades (`fade`), sprites ({@link SoundDefinition.sprite} +
//    `play({ sprite })`), looping (`play({ loop })`), and named groups
//    (`play({ group })` + `stopGroup`), plus master mute (`mute` /
//    `isMuted` — persistent runtime state held by the engine, not a
//    per-scene checkbox). It is bound to the navigation's `AbortSignal`:
//    when the navigation is superseded / disposed / completes the
//    service `stopAll()`s — every sound it created is stopped and
//    unloaded, so fades, loops, sprites, and muted state never survive
//    scene cleanup (PUL-P001 / ADR-004). One service is shared across a
//    composition's slice (the resolver already forbids a slice repeating
//    a scene id), so the sound-id namespace and the source allowlist are
//    composition-slice-scoped: multi-scene compositions pick distinct
//    sound ids — the same stable-identity discipline scene ids obey
//    (ADR-008 #1) — and registering an id twice with the same definition
//    is idempotent (a shared transition SFX). A scene scopes a sound to
//    itself with `play(id, { group: <its-scene-id> })`; the resolver's
//    per-scene post-`cleanup(ctx)` hook stops that group when the scene
//    cleans up (runtime-driven, not author discipline). True per-scene
//    activation contexts (one `ctx.audio` facade per scene entry) are a
//    documented resolver follow-up (see `composition-resolver.ts`'s
//    `buildPlan`).
//
// Source URLs reuse PUL-F005's `resolveAssetUrl` scheme resolver — no
// copied scheme rules — and every registered source must be in the
// active composition slice's declared `scene.audio` (PUL-F030 / ADR-029
// — `scene.audio` is the audio-source allowlist; every entry must also
// be a member of `scene.assets` so the preloader (PUL-F005) warmed it).
// Sound ids and group names obey the kebab-case rule every other Pulsar
// identifier obeys (ADR-008 #1).
//
// References:
//  - ADR-004 — Howler as the audio engine, exposed through `ctx.audio`;
//    runtime-guaranteed per-scene cleanup; master mute.
//  - ADR-003 — timeline callbacks are how most audio cues fire (scenes
//    hang `ctx.audio.play(...)` off their `ctx.gsap` timeline).
//  - ADR-008 — agent-native authoring; #1 kebab ids, #5 `scene.assets`
//    is the canonical asset inventory; PUL-F030 / ADR-029 narrows audio
//    to a `scene.audio` subset of `scene.assets`.
//  - ADR-029 / PUL-F030 — `scene.audio` is the audio-source allowlist
//    AND the predicate the present-mode unlock gate consults.
//  - PUL-F005 / ADR-012 — the asset preloader whose URL resolver this
//    module reuses; declared audio sources are warmed before mount.

import { Howl, Howler, type SoundSpriteDefinitions } from 'howler';
import { DEFAULT_ALLOWED_SCHEMES, resolveAssetUrl } from './asset-preloader';
import { describeError } from './error';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import { deepFreeze, isPlainRecord } from './object';

/* ------------------------------------------------------------------ *
 *  Errors
 * ------------------------------------------------------------------ */

/** Base class for every error the audio service raises. */
export class AudioError extends Error {}

/**
 * A sound id is malformed, refers to a sound that was never registered,
 * is being registered twice, or names a sprite the sound does not have.
 */
export class AudioSoundError extends AudioError {}

/** A group name is not a valid kebab-case identifier. */
export class AudioGroupError extends AudioError {}

/**
 * A sound source URL has a disallowed scheme, is malformed, or was not
 * declared in `scene.audio` (PUL-F030 / ADR-029 — the audio-source
 * allowlist; every entry must also be in `scene.assets` so the
 * preloader warms it).
 */
export class AudioSourceError extends AudioError {}

/** A volume, fade endpoint, or duration is outside its allowed numeric range. */
export class AudioRangeError extends AudioError {}

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
 * — Howler's global is a process singleton, so master mute is global.
 *
 * Browser autoplay policy is centralized by Howler's default Web Audio
 * mode and `Howler.autoUnlock` (ADR-004 "the audio service centralizes
 * the unlock dance; scenes do not each implement it"): a `play()` made
 * before the first user gesture is deferred (`AudioContext` suspended →
 * Howler waits on its `resume` event) and replayed when the first
 * gesture resumes the context. So no first cue is lost and the runtime
 * does not re-implement the unlock dance. Both async failure events
 * Howler exposes — `loaderror` (a source that fails to fetch / decode)
 * and `playerror` (a playback failure; not emitted by Web Audio mode,
 * but the HTML5 fallback path can) — route to the service's non-fatal
 * `onError` sink.
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
    // PUL-F030 / ADR-029: satisfy browser autoplay policy so the
    // present-mode composition can play audio. The function MUST
    // either actually unlock playback (resume Web Audio context OR
    // exercise HTML5 audio under the active user gesture) OR REJECT,
    // so the gate fails closed instead of "click resolved but the
    // first cue is still suspended." The codex cycle-3 review named
    // four success-without-unlock failure modes the previous code
    // hit (`usingWebAudio === false` silently returning, seed-Howl
    // setup throwing under a try/catch that resolved, ctx still
    // missing after setup, ctx without a `resume()`). This rewrite
    // closes each of them.
    //
    // The three success branches:
    //
    //  1. `noAudio === true` — Howler has no audio backend at all
    //     (Node tests, browser with audio disabled). No autoplay
    //     policy to satisfy; resolve. The composition's `ctx.audio`
    //     calls are already no-ops in this engine.
    //  2. `usingWebAudio === false` — Howler falls back to HTML5
    //     audio. The HTML5 autoplay-policy unlock pattern is to
    //     `play()` a silent `<audio>` during the user gesture, which
    //     marks the document's HTML5 audio as user-activated.
    //     Requires `globalThis.Audio`; if absent, reject.
    //  3. Web Audio path — construct/resume an `AudioContext`. The
    //     ctx must be created INSIDE the user-activation tick so the
    //     browser marks it `running` not `suspended`; we trigger
    //     Howler's own `_setup()` via a throwaway `new Howl()` so
    //     `Howler.ctx` AND `Howler.masterGain` are created
    //     consistently (cycle-2 review fix). If Howler's setup
    //     throws, or the ctx remains null, or the ctx has no
    //     `resume()`, REJECT. Idempotent: a second unlock with a
    //     running ctx just calls `resume()` again (no-op when
    //     already running).
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: existing pre-rule offender (cognitive complexity 22). Audio-unlock branching covers Howler's setup, ctx-resume, and silent-fallback paths inside a single user-activation tick; refactor tracked in docs/design/complexity-backlog.md.
    async unlock() {
      const howlerHandle = Howler as unknown as {
        ctx: AudioContext | null | undefined;
        noAudio: boolean | undefined;
        usingWebAudio: boolean | undefined;
      };
      // Branch 1: explicit no-audio fallback.
      if (howlerHandle.noAudio === true) return;
      // 44-byte silent WAV used by both unlock branches.
      const SILENT_WAV =
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      // Branch 2: HTML5 audio fallback. Howler will play sounds via
      // `<audio>` elements, which are subject to autoplay policy too.
      if (howlerHandle.usingWebAudio === false) {
        type AudioCtor = new (src?: string) => HTMLAudioElement;
        const AudioCtor = (globalThis as unknown as { Audio?: AudioCtor }).Audio;
        if (AudioCtor === undefined) {
          throw new Error(
            'audio unlock: Howler is in HTML5 mode but globalThis.Audio is unavailable — cannot satisfy autoplay policy',
          );
        }
        const probe = new AudioCtor(SILENT_WAV);
        probe.muted = true;
        await probe.play();
        probe.pause();
        return;
      }
      // Branch 3: Web Audio path. Trigger Howler's setup if needed.
      if (howlerHandle.ctx === null || howlerHandle.ctx === undefined) {
        try {
          const seed = new Howl({ src: [SILENT_WAV] });
          seed.unload();
        } catch (cause) {
          throw new Error(
            `audio unlock: Howler setup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        }
      }
      const ctx = howlerHandle.ctx;
      if (ctx === null || ctx === undefined) {
        throw new Error(
          'audio unlock: Howler setup completed but Howler.ctx is still null — cannot resume audio',
        );
      }
      if (typeof ctx.resume !== 'function') {
        throw new TypeError('audio unlock: Howler.ctx.resume is not a function');
      }
      await ctx.resume();
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
   * is an {@link AudioSoundError}.
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
 *    is effectively silent (the workbench has not yet attached a cue
 *    UI / log surface).
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
 * One entry in the rehearsal cue log (PUL-F026 / ADR-004). Emitted by
 * `outputPolicy: 'log-cues'` after the audio service has accepted an
 * operation (sound id / sprite / group / range validation all passed
 * and the engine call has returned). The entry is **semantic only**:
 * sound ids, sprite names, group names, numeric envelope parameters,
 * a `sequence` monotonic across the service's lifetime, and the
 * `operation` name. It does NOT carry source URLs, Howler handles,
 * absolute paths, request headers, scene objects, or asset payload
 * — the preflight (`docs/design/pul-f026-rehearsal-mode-preflight.md`)
 * names this explicitly: "log semantic ids only."
 *
 * `load` and `mute` are NOT cues: registration is bookkeeping and
 * master mute is engine-level persistent state. Operations that fail
 * the boundary validation do NOT emit (the cue log represents
 * accepted operations, not rejected ones). Operations made after the
 * service is disposed do NOT emit (the cue log stops when the
 * navigation ends, parallel to `stopAll()`).
 *
 * Modeled as a discriminated union over `operation` so a consumer can
 * narrow with `if (entry.operation === 'fade') ...` and have the
 * compiler guarantee `entry.fade` is defined. Impossible shapes
 * (`{ operation: 'play' }` without `soundId`,
 * `{ operation: 'stop-group', soundId: 'bed' }`, etc.) are rejected
 * at the type level rather than left to runtime invariant.
 *
 * Entries are returned deep-frozen so a consumer cannot mutate the
 * log (or any nested payload such as `fade`) in place.
 */
export type AudioCueLogEntry =
  | AudioCueLogPlay
  | AudioCueLogFade
  | AudioCueLogStop
  | AudioCueLogStopGroup;

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
  /** Sink for non-fatal async audio errors (load / play failure). Defaults to a no-op. */
  readonly onError?: (err: unknown) => void;
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
   * Register a sound under `soundId` (kebab-case). Throws
   * {@link AudioSoundError} on a malformed or already-used id and
   * {@link AudioSourceError} when a `src` URL has a disallowed scheme,
   * is malformed, or is not in `allowedSources`.
   */
  load(soundId: string, definition: SoundDefinition): void;
  /**
   * Play a registered sound. Throws {@link AudioSoundError} on an
   * unknown sound id or sprite name, {@link AudioGroupError} on a
   * malformed group name, {@link AudioRangeError} on an out-of-range
   * volume.
   */
  play(soundId: string, options?: PlayOptions): void;
  /**
   * Fade every playing instance of `soundId` from `from` to `to` over
   * `durationMs` milliseconds. Throws {@link AudioSoundError} on an
   * unknown sound and {@link AudioRangeError} on an out-of-range
   * endpoint or duration.
   */
  fade(soundId: string, from: number, to: number, durationMs: number): void;
  /** Stop every playing instance of `soundId`. Throws {@link AudioSoundError} on an unknown sound. */
  stop(soundId: string): void;
  /**
   * Stop every play instance tagged with `group`. Throws
   * {@link AudioGroupError} on a malformed group name; an unknown or
   * already-emptied group is a no-op.
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
 * Validate the {@link SoundDefinition} payload shape at the runtime
 * boundary — scenes can be plain JS, so the static type does not hold.
 * `src` must be a string or array; `sprite` (if set) is validated by
 * {@link assertSpriteMap}.
 */
function assertSoundDefinition(
  soundId: string,
  definition: unknown,
): asserts definition is SoundDefinition {
  if (!isPlainRecord(definition)) {
    throw new AudioSoundError(
      `audio sound "${soundId}" definition must be an object with at least a "src" field`,
    );
  }
  const src = (definition as { src?: unknown }).src;
  if (typeof src !== 'string' && !Array.isArray(src)) {
    throw new AudioSourceError(
      `audio sound "${soundId}" "src" must be a string or array of strings`,
    );
  }
}

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
    throw new AudioSoundError(`audio sound "${soundId}" play options must be an object or omitted`);
  }
  const opts = options as {
    sprite?: unknown;
    loop?: unknown;
    volume?: unknown;
    group?: unknown;
    rate?: unknown;
  };
  assertPlayOptionTypeString(soundId, 'sprite', opts.sprite, AudioSoundError);
  assertPlayOptionTypeBoolean(soundId, 'loop', opts.loop, AudioSoundError);
  assertPlayOptionTypeString(soundId, 'group', opts.group, AudioGroupError);
  assertPlayOptionTypeNumber(soundId, 'volume', opts.volume, AudioRangeError);
  assertPlayOptionRate(soundId, opts.rate);
}

type AudioErrorCtor = new (message: string) => Error;

function assertPlayOptionTypeString(
  soundId: string,
  name: string,
  value: unknown,
  ErrorCtor: AudioErrorCtor,
): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new ErrorCtor(
      `audio sound "${soundId}" play option "${name}" must be a string; got ${typeof value}`,
    );
  }
}

function assertPlayOptionTypeBoolean(
  soundId: string,
  name: string,
  value: unknown,
  ErrorCtor: AudioErrorCtor,
): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new ErrorCtor(
      `audio sound "${soundId}" play option "${name}" must be a boolean; got ${typeof value}`,
    );
  }
}

function assertPlayOptionTypeNumber(
  soundId: string,
  name: string,
  value: unknown,
  ErrorCtor: AudioErrorCtor,
): void {
  if (value !== undefined && typeof value !== 'number') {
    throw new ErrorCtor(
      `audio sound "${soundId}" play option "${name}" must be a number; got ${typeof value}`,
    );
  }
}

function assertPlayOptionRate(soundId: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new AudioRangeError(
      `audio sound "${soundId}" play option "rate" must be a finite number > 0; got ${typeof value === 'number' ? value : typeof value}`,
    );
  }
}

/**
 * Validate a sprite map at the runtime boundary — scene modules can be
 * plain JS, so the {@link AudioSpriteMap} type guarantee does not hold.
 * Each entry must be `name → [startMs, durationMs]` or
 * `[startMs, durationMs, loop]` with finite, non-negative offsets and a
 * boolean loop flag. Throws {@link AudioSoundError} for a malformed
 * shape or name and {@link AudioRangeError} for an out-of-range offset
 * or duration.
 */
const assertSpriteMap = (soundId: string, sprite: unknown): void => {
  if (!isPlainRecord(sprite)) {
    throw new AudioSoundError(
      `audio sound "${soundId}" sprite map must be an object of name → [startMs, durationMs] or [startMs, durationMs, loop]`,
    );
  }
  for (const [name, def] of Object.entries(sprite)) {
    if (name === '') {
      throw new AudioSoundError(`audio sound "${soundId}" has a sprite with an empty name`);
    }
    if (!Array.isArray(def) || (def.length !== 2 && def.length !== 3)) {
      throw new AudioSoundError(
        `audio sound "${soundId}" sprite "${name}" must be [startMs, durationMs] or [startMs, durationMs, loop]`,
      );
    }
    if (!isFiniteNumber(def[0]) || def[0] < 0 || !isFiniteNumber(def[1]) || def[1] < 0) {
      throw new AudioRangeError(
        `audio sound "${soundId}" sprite "${name}" offset and duration must be finite, non-negative milliseconds; got [${def[0]}, ${def[1]}]`,
      );
    }
    if (def.length === 3 && typeof def[2] !== 'boolean') {
      throw new AudioSoundError(
        `audio sound "${soundId}" sprite "${name}" loop flag must be a boolean; got ${typeof def[2]}`,
      );
    }
  }
};

/** Build the per-navigation {@link AudioService} over `engine`. */
/**
 * Render an unknown value for the boundary-validation error message.
 * `JSON.stringify` throws on BigInt and silently drops Symbols, so a
 * plain-JS misuse that passes `1n` would surface as a `TypeError`
 * instead of {@link AudioError} (codex review, cycle 2). This helper
 * falls back to a `typeof` + `String()` rendering for values
 * `JSON.stringify` cannot encode, so every primitive / object value
 * produces a readable, safe diagnostic.
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
 * Build the `play` rehearsal-cue payload (PUL-F026): the soundId plus
 * every play option the scene actually supplied, with NO source URL.
 * Hoisted out of `play()` so that function stays within Sonar's
 * cognitive-complexity budget (S3776).
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
    throw new AudioError(
      "audio 'silent' option was replaced by outputPolicy in PUL-F026 / ADR-004 — pass outputPolicy: 'silent' / 'log-cues' / 'audible' instead",
    );
  }
  // Runtime boundary (codex review, cycles 1 + 2): a plain-JS caller
  // (or a direct caller that casts past the literal-typed union) could
  // pass a misspelled policy like `'log-cue'`, or pass `null`/`true`/
  // `1n` / a Symbol / etc., and silently get a muted, no-cues service
  // instead of `'audible'`. Validate at construction so the misuse
  // fails loud rather than producing dead-air playback. `undefined` →
  // default `'audible'`; every other value goes through the allowlist
  // check (so `null`, `true`, an empty string, and misspelled
  // policies all fail loud rather than coalescing to the default via
  // `??`). The allowlist is the same frozen tuple
  // {@link AUDIO_OUTPUT_POLICIES} the type derives from, so the type
  // and the runtime check cannot drift.
  // Validate the supplied value (if any) against the allowlist FIRST,
  // then default `undefined` to `'audible'`. Doing the default with
  // `??` BEFORE validation would coalesce `null` to `'audible'` and
  // skip the boundary check; explicit `=== undefined` keeps the two
  // concerns ordered correctly.
  const policyArg: unknown = options.outputPolicy;
  if (
    policyArg !== undefined &&
    !(AUDIO_OUTPUT_POLICIES as readonly unknown[]).includes(policyArg)
  ) {
    const quotedPolicies = AUDIO_OUTPUT_POLICIES.map((p) => `'${p}'`).join(' / ');
    throw new AudioError(
      `audio outputPolicy must be one of ${quotedPolicies}; got ${describeRawOption(policyArg)}`,
    );
  }
  const outputPolicy: AudioOutputPolicy = (policyArg ?? 'audible') as AudioOutputPolicy;
  // Same boundary discipline (codex review, cycle 2): `onCue` is a
  // workbench-supplied function (kept across navigations in
  // `SceneLoaderOptions.onAudioCue`), so a JS caller / a test
  // harness / a misconfigured bootstrap could pass a non-function
  // (`true`, `{}`, a number). Validating at construction surfaces
  // the misuse via the loader's existing rollback-then-surfaceError
  // path instead of silently swallowing a `TypeError` inside the
  // non-fatal `emitCue` try/catch — which would leave rehearsal with
  // an empty cue stream and no diagnostic.
  if (options.onCue !== undefined && typeof options.onCue !== 'function') {
    throw new AudioError(
      `audio onCue must be a function or omitted; got ${describeRawOption(options.onCue)}`,
    );
  }
  // Engine sounds are constructed muted under both 'silent' and
  // 'log-cues' — they share the no-audible-output structural defense.
  // 'log-cues' adds an extra logging layer on top.
  const muted = outputPolicy !== 'audible';
  const onError = options.onError ?? ((): void => undefined);
  const onCue = options.onCue;
  const allowed = options.allowedSources === undefined ? null : new Set(options.allowedSources);

  const sounds = new Map<string, RegisteredSound>();
  const groups = new Map<string, GroupedPlay[]>();
  let disposed = false;
  // Per-service monotonic sequence for `AudioCueLogEntry.sequence`.
  // Only incremented when a cue is actually emitted (policy is
  // `log-cues` AND a sink is wired), so non-log-cues services pay
  // zero cost.
  let cueSequence = 0;

  /**
   * Emit a cue log entry to the optional `onCue` sink (PUL-F026 /
   * ADR-004). Inert when:
   *  - the policy is not `'log-cues'`, OR
   *  - no sink was supplied, OR
   *  - the service has been disposed (the cue logger stops with the
   *    navigation, parallel to `stopAll()`).
   *
   * A throwing sink is swallowed: the diagnostic surface must not
   * propagate exceptions back through `play` / `fade` / `stop` /
   * `stopGroup` and break scene playback.
   */
  // Per-variant `Omit<…, 'sequence'>` so emitting code can hand in
  // each operation's exact shape and TypeScript narrows correctly.
  // `Omit<AudioCueLogEntry, 'sequence'>` on the union would collapse
  // the variant-specific required fields (`group` on `stop-group`,
  // `fade` on `fade`) into optional ones, defeating the
  // discriminated-union guarantee.
  type CueInput =
    | Omit<AudioCueLogPlay, 'sequence'>
    | Omit<AudioCueLogFade, 'sequence'>
    | Omit<AudioCueLogStop, 'sequence'>
    | Omit<AudioCueLogStopGroup, 'sequence'>;
  const emitCue = (entry: CueInput): void => {
    if (outputPolicy !== 'log-cues' || onCue === undefined || disposed) return;
    cueSequence += 1;
    // Deep-freeze (codex review, cycle 1): the contract says the cue
    // log is read-only. `Object.freeze` alone would leave nested
    // payloads (e.g. `fade: { from, to, durationMs }`) writable, so a
    // consumer could mutate `cue.fade.to` after receiving the entry.
    // `deepFreeze` walks every plain object/array reachable from the
    // entry.
    const frozen = deepFreeze({ sequence: cueSequence, ...entry });
    try {
      onCue(frozen);
    } catch {
      // Intentionally empty: the cue-log sink is non-fatal.
    }
  };

  const assertSoundId = (soundId: string): void => {
    if (!isKebabIdentifier(soundId)) {
      throw new AudioSoundError(
        `audio sound id "${soundId}" is invalid: sound ids must be lowercase kebab-case identifiers (${KEBAB_IDENTIFIER_FORM})`,
      );
    }
  };

  const assertGroupName = (group: string): void => {
    if (!isKebabIdentifier(group)) {
      throw new AudioGroupError(
        `audio group name "${group}" is invalid: group names must be lowercase kebab-case identifiers (${KEBAB_IDENTIFIER_FORM})`,
      );
    }
  };

  const assertGain = (value: number, what: string): void => {
    if (!isFiniteNumber(value) || value < GAIN_MIN || value > GAIN_MAX) {
      throw new AudioRangeError(
        `audio ${what} must be a finite number in [${GAIN_MIN}, ${GAIN_MAX}]; got ${value}`,
      );
    }
  };

  const requireSound = (soundId: string): RegisteredSound => {
    assertSoundId(soundId);
    const sound = sounds.get(soundId);
    if (sound === undefined) {
      throw new AudioSoundError(
        `audio sound "${soundId}" is not registered — call ctx.audio.load("${soundId}", ...) first`,
      );
    }
    return sound;
  };

  /**
   * Route an engine-side cleanup failure (a throwing `stop()` / `unload()`
   * during `stopGroup` / `stopAll`) through the non-fatal `onError`
   * sink, swallowing any further throw the sink itself produces. The
   * cleanup loops keep iterating after this returns so per-item
   * isolation holds.
   */
  const reportCleanupError = (where: string, target: string, cause: unknown): void => {
    try {
      onError(
        new AudioError(`audio ${where}("${target}") failed: ${describeError(cause)}`, { cause }),
      );
    } catch {
      // Intentionally empty: the diagnostic sink is non-fatal.
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: existing pre-rule offender (cognitive complexity 17). Source list normalizer enforces non-empty + per-item scheme/type validation with detailed error envelopes; refactor tracked in docs/design/complexity-backlog.md.
  const normalizeSources = (soundId: string, src: string | readonly string[]): string[] => {
    const list = typeof src === 'string' ? [src] : [...src];
    if (list.length === 0) {
      throw new AudioSourceError(
        `audio sound "${soundId}" has no source — provide at least one URL`,
      );
    }
    for (const url of list) {
      if (typeof url !== 'string' || url === '') {
        throw new AudioSourceError(
          `audio sound "${soundId}" source must be a non-empty URL string`,
        );
      }
      // Defense-in-depth: even when `allowedSources` is provided (the
      // slice's declared `scene.audio`, every entry of which is also
      // in `scene.assets` so the preloader warmed it), the audio
      // service also runs the same default scheme allowlist the
      // preloader uses by default — so a no-op or weak preloader
      // cannot let `file:` / `//host` URLs through. Threading the
      // preloader's exact `baseUrl` / `allowedSchemes` policy into
      // the audio service is a documented follow-up; for now the
      // service is at least as restrictive as `DEFAULT_ALLOWED_SCHEMES`.
      try {
        resolveAssetUrl(url, undefined, DEFAULT_ALLOWED_SCHEMES);
      } catch (cause) {
        throw new AudioSourceError(
          `audio sound "${soundId}" source "${url}" is invalid: ${describeError(cause)}`,
          { cause },
        );
      }
      if (allowed !== null && !allowed.has(url)) {
        // PUL-F030 / ADR-029: `scene.audio` is the audio-source
        // allowlist. A URL outside the slice's declared `scene.audio`
        // is rejected — even if it happens to be in `scene.assets`.
        // This is what makes the present-mode unlock gate predicate
        // and the runtime audio-source allowlist agree: a scene
        // cannot quietly register audio it did not also declare.
        throw new AudioSourceError(
          `audio sound "${soundId}" source "${url}" is not a declared audio source — list it in scene.audio (and ensure it is also in scene.assets so the preloader warms it) per PUL-F030 / ADR-029`,
        );
      }
    }
    return list;
  };

  const unknownSpriteMessage = (
    soundId: string,
    sprite: string,
    names: ReadonlySet<string>,
  ): string => {
    const known = names.size === 0 ? '' : ` — known sprites: ${[...names].join(', ')}`;
    return `audio sound "${soundId}" has no sprite "${sprite}"${known}`;
  };

  const service: AudioService = {
    load(soundId, definition) {
      if (disposed) return;
      assertSoundId(soundId);
      assertSoundDefinition(soundId, definition);
      const src = normalizeSources(soundId, definition.src);
      if (definition.sprite !== undefined) assertSpriteMap(soundId, definition.sprite);
      const existing = sounds.get(soundId);
      if (existing !== undefined) {
        // Idempotent re-registration of the same sound (e.g. a shared
        // transition SFX two scenes both `load` — the sound-id namespace
        // is composition-slice-scoped); a different definition is a
        // genuine conflict.
        if (
          sameSourceList(existing.src, src) &&
          sameSpriteMap(existing.sprite, definition.sprite)
        ) {
          return;
        }
        throw new AudioSoundError(
          `audio sound "${soundId}" is already registered with a different definition`,
        );
      }
      const spriteNames: ReadonlySet<string> = new Set(
        definition.sprite === undefined ? [] : Object.keys(definition.sprite),
      );
      const handle = engine.createSound({
        src,
        ...(definition.sprite === undefined ? {} : { sprite: definition.sprite }),
        muted,
        onError: (err) => {
          // Howler's async load failures can arrive after the navigation
          // ended (abort / supersession / completion). A disposed
          // service must not write a stale diagnostic over the active
          // navigation, and this non-fatal sink must not throw back
          // through Howler's callback.
          if (disposed) return;
          try {
            onError(
              new AudioError(`audio sound "${soundId}": ${describeError(err)}`, { cause: err }),
            );
          } catch {
            // Intentionally empty: the diagnostic sink is non-fatal.
          }
        },
      });
      sounds.set(soundId, { handle, spriteNames, src, sprite: definition.sprite });
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: existing pre-rule offender (cognitive complexity 22). play() validates sprite/offset/volume options, threads disposal and silent-mode gates, and wires error envelopes; refactor tracked in docs/design/complexity-backlog.md.
    play(soundId, options) {
      if (disposed) return;
      assertPlayOptions(soundId, options);
      const sound = requireSound(soundId);
      const opts = options ?? {};
      if (opts.sprite !== undefined && !sound.spriteNames.has(opts.sprite)) {
        throw new AudioSoundError(unknownSpriteMessage(soundId, opts.sprite, sound.spriteNames));
      }
      if (opts.group !== undefined) assertGroupName(opts.group);
      if (opts.volume !== undefined) assertGain(opts.volume, 'volume');
      const playId = sound.handle.play(opts.sprite);
      if (opts.loop === true) sound.handle.loop(true, playId);
      if (opts.volume !== undefined) sound.handle.volume(opts.volume, playId);
      if (opts.rate !== undefined) sound.handle.rate(opts.rate, playId);
      if (opts.group !== undefined) {
        const list = groups.get(opts.group);
        if (list === undefined) groups.set(opts.group, [{ handle: sound.handle, playId }]);
        else list.push({ handle: sound.handle, playId });
      }
      // Rehearsal cue log (PUL-F026): emitted only when `outputPolicy
      // === 'log-cues'` AND `onCue` is set (the `emitCue` helper
      // short-circuits otherwise so non-log-cues services pay no
      // per-op cost). `buildPlayCue` captures every play option the
      // scene supplied, with NO source URL.
      emitCue(buildPlayCue(soundId, opts));
    },

    fade(soundId, from, to, durationMs) {
      if (disposed) return;
      const sound = requireSound(soundId);
      assertGain(from, 'fade start volume');
      assertGain(to, 'fade end volume');
      if (!isFiniteNumber(durationMs) || durationMs < 0) {
        throw new AudioRangeError(
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
      if (disposed) return;
      const sound = requireSound(soundId);
      sound.handle.stop();
      emitCue({ operation: 'stop', soundId });
    },

    stopGroup(group) {
      if (disposed) return;
      assertGroupName(group);
      const list = groups.get(group);
      if (list !== undefined) {
        // Per-play error isolation (codex review, cycle 3): a throwing
        // engine `stop()` must not prevent later plays in the group from
        // being stopped. Failures route through the non-fatal `onError`
        // sink — the cleanup contract is "every play in the group is
        // attempted to be stopped," not "all-or-nothing."
        for (const play of list) {
          try {
            play.handle.stop(play.playId);
          } catch (err) {
            reportCleanupError('stopGroup', group, err);
          }
        }
        groups.delete(group);
      }
      // PUL-F026 (codex review, cycle 1): emit AFTER the engine
      // stop loop and the bookkeeping delete (parity with `play` /
      // `fade` / `stop`, which all emit after the engine call
      // returns). An accepted stop-group of an empty group is still
      // recorded as an audio operation the scene requested — same
      // semantics `stop` of a never-played sound has — but the cue
      // is published only after the state transition it represents.
      emitCue({ operation: 'stop-group', group });
    },

    mute(muted) {
      if (disposed) return;
      // Runtime boundary: scenes can be plain JS, so the boolean type
      // does not hold (codex review, cycle 4).
      if (typeof muted !== 'boolean') {
        throw new AudioError(`audio mute argument must be a boolean; got ${typeof muted}`);
      }
      engine.setMasterMute(muted);
    },

    isMuted() {
      return engine.isMasterMuted();
    },

    stopAll() {
      if (disposed) return;
      disposed = true;
      // Per-sound error isolation (codex review, cycle 3): a throwing
      // engine `stop()` / `unload()` must not prevent later sounds from
      // being torn down. Each call is wrapped; failures route through
      // the non-fatal `onError` sink. Bookkeeping is cleared
      // unconditionally so the disposed service is in a known state.
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
    },

    isDisposed() {
      return disposed;
    },
  };

  if (options.signal.aborted) {
    service.stopAll();
  } else {
    options.signal.addEventListener('abort', () => service.stopAll(), { once: true });
  }

  return service;
}
