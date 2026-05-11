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
// active composition slice's declared `scene.assets` (ADR-008 #5: the
// only audio inventory is `scene.assets`; there is no `audio:` field on
// `SceneModule`). The preloader (PUL-F005) warms those URLs before
// `create(ctx)` runs. Sound ids and group names obey the kebab-case
// rule every other Pulsar identifier obeys (ADR-008 #1).
//
// References:
//  - ADR-004 — Howler as the audio engine, exposed through `ctx.audio`;
//    runtime-guaranteed per-scene cleanup; master mute.
//  - ADR-003 — timeline callbacks are how most audio cues fire (scenes
//    hang `ctx.audio.play(...)` off their `ctx.gsap` timeline).
//  - ADR-008 — agent-native authoring; #1 kebab ids, #5 the only asset
//    inventory is `scene.assets`.
//  - PUL-F005 / ADR-012 — the asset preloader whose URL resolver this
//    module reuses; declared audio sources are warmed before mount.

import { Howl, Howler, type SoundSpriteDefinitions } from 'howler';
import { DEFAULT_ALLOWED_SCHEMES, resolveAssetUrl } from './asset-preloader';
import { describeError } from './error';
import { KEBAB_IDENTIFIER_FORM, isKebabIdentifier } from './identifier';
import { isPlainRecord } from './object';

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
 * declared in `scene.assets` (so the preloader never warmed it).
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
    unload: () => undefined,
  };
  return {
    createSound: () => handle,
    setMasterMute: (muted) => {
      masterMuted = muted;
    },
    isMasterMuted: () => masterMuted,
  };
})();

/* ------------------------------------------------------------------ *
 *  The audio service (`ctx.audio`)
 * ------------------------------------------------------------------ */

/** What a scene passes to {@link AudioService.load} to register one sound. */
export interface SoundDefinition {
  /**
   * Source URL, or URLs in codec-preference order. Every URL must be
   * declared in the active composition slice's `scene.assets` so the
   * preloader warms it (ADR-008 #5) and must pass the asset scheme
   * allowlist ({@link import('./asset-preloader').DEFAULT_ALLOWED_SCHEMES}).
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
  /** Construct every sound muted (screenshot / paused modes — audible playback is suppressed). */
  readonly silent?: boolean;
  /**
   * The source URLs scenes may register. Every {@link SoundDefinition.src}
   * URL must be in this set (ADR-008 #5 — audio is declared in
   * `scene.assets`, which the preloader warms). Omit to skip the
   * membership check (non-composition / test callers); scheme
   * validation still applies.
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
  const opts = options as { sprite?: unknown; loop?: unknown; volume?: unknown; group?: unknown };
  if (opts.sprite !== undefined && typeof opts.sprite !== 'string') {
    throw new AudioSoundError(
      `audio sound "${soundId}" play option "sprite" must be a string; got ${typeof opts.sprite}`,
    );
  }
  if (opts.loop !== undefined && typeof opts.loop !== 'boolean') {
    throw new AudioSoundError(
      `audio sound "${soundId}" play option "loop" must be a boolean; got ${typeof opts.loop}`,
    );
  }
  if (opts.group !== undefined && typeof opts.group !== 'string') {
    throw new AudioGroupError(
      `audio sound "${soundId}" play option "group" must be a string; got ${typeof opts.group}`,
    );
  }
  if (opts.volume !== undefined && typeof opts.volume !== 'number') {
    throw new AudioRangeError(
      `audio sound "${soundId}" play option "volume" must be a number; got ${typeof opts.volume}`,
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
export function createAudioService(
  engine: AudioEngine,
  options: AudioServiceOptions,
): AudioService {
  const silent = options.silent === true;
  const onError = options.onError ?? ((): void => undefined);
  const allowed = options.allowedSources === undefined ? null : new Set(options.allowedSources);

  const sounds = new Map<string, RegisteredSound>();
  const groups = new Map<string, GroupedPlay[]>();
  let disposed = false;

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
      // Defense-in-depth (codex review, cycle 3): even when
      // `allowedSources` is provided (the slice's declared
      // `scene.assets`, which the preloader warmed), the audio service
      // also runs the same default scheme allowlist the preloader uses
      // by default — so a no-op or weak preloader cannot let `file:` /
      // `//host` URLs through. Threading the preloader's exact
      // `baseUrl` / `allowedSchemes` policy into the audio service is a
      // documented follow-up; for now the service is at least as
      // restrictive as `DEFAULT_ALLOWED_SCHEMES`.
      try {
        resolveAssetUrl(url, undefined, DEFAULT_ALLOWED_SCHEMES);
      } catch (cause) {
        throw new AudioSourceError(
          `audio sound "${soundId}" source "${url}" is invalid: ${describeError(cause)}`,
          { cause },
        );
      }
      if (allowed !== null && !allowed.has(url)) {
        // ADR-008 #5: the only audio inventory is `scene.assets`. A URL
        // outside the slice's declared assets is not preloader-warmed
        // and is rejected here regardless of scheme.
        throw new AudioSourceError(
          `audio sound "${soundId}" source "${url}" is not a declared asset — list it in scene.assets so the preloader warms it (ADR-008 #5)`,
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
        muted: silent,
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
      if (opts.group !== undefined) {
        const list = groups.get(opts.group);
        if (list === undefined) groups.set(opts.group, [{ handle: sound.handle, playId }]);
        else list.push({ handle: sound.handle, playId });
      }
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
    },

    stop(soundId) {
      if (disposed) return;
      const sound = requireSound(soundId);
      sound.handle.stop();
    },

    stopGroup(group) {
      if (disposed) return;
      assertGroupName(group);
      const list = groups.get(group);
      if (list === undefined) return;
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
