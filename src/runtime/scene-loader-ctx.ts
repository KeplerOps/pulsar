// Scene-loader per-navigation context construction — PUL-F008.
//
// `scene-loader.ts` orchestrates the navigation queue, abort lifecycle,
// and stage-attr envelope. This module owns the cohesive sub-concern it
// delegates to: building the per-navigation audio service, presenter
// pipe, deterministic RNG seed, and the per-occurrence `ctx` factory —
// the work `createSceneLoader.buildLoad` used to inline. Pulling it here
// keeps `buildLoad` within the cognitive-complexity budget and gives the
// ctx-assembly seam a single home.
//
// References:
//  - PUL-F018 / ADR-021 — deterministic per-navigation RNG seed.
//  - PUL-F024 / PUL-F026 / ADR-004 — per-navigation audio service.
//  - PUL-F025 / ADR-023 — presenter pipe + master-mute audio handler.
//  - issue #99 — per-occurrence activation identity + RNG stream.

import type { AssetUrlPolicy } from './asset-preloader';
import {
  type AudioCueLogEntry,
  type AudioEngine,
  type AudioOutputPolicy,
  type AudioService,
  type AudioServiceOptions,
  type CueGateControl,
  createAudioService,
} from './audio';
import type { SceneActivation } from './composition-resolver';
import { profileFor } from './mode-profile';
import type { NavigationLocator, NavigationMode, NavigationTarget } from './navigation';
import {
  type PresenterCommandSource,
  type PresenterController,
  createPresenterController,
} from './presenter';
import { createSeededRng } from './rng';
import type { SceneNavigationTarget } from './scene-navigation';
import { PULSAR_RUNTIME_VERSION } from './version';

/**
 * The audio source URLs the resolved (possibly head-truncated) slice
 * declared as audio — every scene's static `SceneModule.audio` list in
 * the slice (just the head scene's for a bare `kind: 'scene'` target,
 * the full composition slice's for composition targets). The
 * per-navigation audio service uses this as the SCENE-FACING source
 * allowlist so `ctx.audio.load()` can only register URLs the scene
 * EXPLICITLY declared as audio — not any URL that happens to be in
 * `scene.assets`. This keeps the PUL-F030 / ADR-029 unlock-gate
 * predicate and the audio-service allowlist consistent, so the
 * present-mode unlock gate cannot be bypassed by a scene that hides
 * its audio in `assets`.
 *
 * The PUL-F014 composition audio bed is deliberately NOT added here:
 * the bed is composition-owned runtime infrastructure gated against its
 * OWN declared `src` inside `startBed`, so exposing it through the scene
 * allowlist would let a scene replay the bed as its own sound.
 */
function collectAudioSources(target: SceneNavigationTarget): readonly string[] {
  return target.composition === undefined
    ? target.scene.audio
    : target.composition.sceneSlice.flatMap((scene) => scene.audio);
}

/**
 * Count, per scene id, how many times it occurs in the resolved
 * navigation slice (issue #99). The loader's occurrence-safe audio
 * teardown consults this so the scene-scoped audio group (shared by
 * every occurrence of that scene because `ctx.audio` is one
 * slice-scoped service) is stopped exactly once — when the LAST
 * occurrence of that id has been cleaned up — rather than once per
 * occurrence. For a single-occurrence scene the count is `1`.
 */
export function countSceneOccurrences(target: SceneNavigationTarget): Map<string, number> {
  const scenes = target.composition === undefined ? [target.scene] : target.composition.sceneSlice;
  const counts = new Map<string, number>();
  for (const scene of scenes) {
    counts.set(scene.id, (counts.get(scene.id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Map the effective workbench mode to the per-navigation
 * {@link AudioOutputPolicy} (PUL-F024 / PUL-F026 / ADR-004). Sourced
 * from the mode profile so the mode→policy table lives in one place.
 */
function audioOutputPolicyFor(mode: NavigationMode): AudioOutputPolicy {
  return profileFor(mode).audioPolicy;
}

/**
 * Serialize a {@link NavigationLocator} into a stable, collision-free
 * string. Every locator kind contributes its discriminant plus its
 * identifier fields, so two distinct addressed targets never fold to
 * the same string. Pure helper for {@link deriveNavigationSeed}.
 */
function serializeLocator(locator: NavigationLocator): string {
  switch (locator.kind) {
    case 'none':
      return 'none';
    case 'scene':
      return `scene:${locator.scene}`;
    case 'composition':
      return `composition:${locator.composition}`;
    case 'composition-scene':
      return `composition:${locator.composition}/scene:${locator.scene}`;
    case 'composition-index':
      return `composition:${locator.composition}/index:${locator.index}`;
  }
}

/**
 * PUL-F018 / ADR-021: derive the per-navigation deterministic seed
 * string for the scene-context RNG ({@link import('./scene-loader').WorkbenchSceneCtx.rng}).
 *
 * The seed is built only from bounded, deterministic inputs the
 * workbench URL already carries: the normalized navigation locator, the
 * addressed beat, and `PULSAR_RUNTIME_VERSION` so a code revision
 * changes the seed. It deliberately does NOT read the wall clock,
 * storage, cookies, `history.state`, process state, or the workbench
 * `mode` (the addressed frame is mode-independent). Under
 * `mode=screenshot` this makes the captured frame reproducible across
 * reloads. Pure function, exported so the per-navigation seam is
 * unit-testable in isolation.
 */
export function deriveNavigationSeed(target: NavigationTarget): string {
  return [
    'pulsar-rng',
    serializeLocator(target.locator),
    `beat:${target.beat ?? ''}`,
    `v:${PULSAR_RUNTIME_VERSION}`,
  ].join('|');
}

/**
 * PUL-F018 / ADR-021: combine the per-navigation seed from
 * {@link deriveNavigationSeed} with one scene occurrence's identity
 * ({@link SceneActivation}) so every occurrence gets its OWN seeded
 * generator. A composition slice that repeats a scene id (issue #99)
 * therefore hands each occurrence an independent random stream.
 */
function deriveActivationSeed(navigationSeed: string, activation: SceneActivation): string {
  return `${navigationSeed}|occ:${activation.sceneId}#${activation.entryIndex}.${activation.occurrence}`;
}

/** A bound scene-ctx base, omitting the per-occurrence fields. */
type BaseCtx = unknown;

/** The per-occurrence ctx factory the resolver lifecycle consumes. */
export type SceneCtxFactory = (activation: SceneActivation) => unknown;

/**
 * The per-navigation services the loader threads into the resolver
 * lifecycle: the audio service (for happy-path `stopAll()` + per-scene
 * group teardown), the presenter controller (`mode=present` only), the
 * presenter teardown signal, and the per-occurrence ctx factory.
 */
export interface NavigationServices {
  readonly audio: AudioService;
  readonly presenter: PresenterController | undefined;
  readonly presenterAbort: AbortController | null;
  readonly buildSceneCtx: SceneCtxFactory;
}

/** Dependencies {@link buildNavigationServices} captures from the loader. */
export interface NavigationServicesDeps {
  readonly audioEngine: AudioEngine;
  readonly assetPolicy?: AssetUrlPolicy;
  readonly onAudioCue?: (entry: AudioCueLogEntry) => void;
  readonly presenterCommands?: PresenterCommandSource;
  readonly onError: (err: unknown) => void;
  readonly buildCtx: (
    mode: NavigationMode,
    audio: AudioService,
    presenter?: PresenterController,
  ) => BaseCtx;
}

/**
 * Construct the per-navigation presenter pipeline:
 *  - `presenterAbort` — a separate `AbortController` whose signal drives
 *    the `PresenterController`'s teardown. Distinct from the navigation
 *    `controller` so the navigation signal can stay un-aborted across a
 *    successful completion (PUL-F013 boundary). Wired to fire on
 *    navigation abort AND aborted by the loader's `finally` on normal
 *    completion.
 *  - `presenter` — the `PresenterController` itself (PUL-F020 / ADR-023),
 *    with the PUL-F025 audio handler (presenter master mute / ADR-004)
 *    attached. This is the only seam where both the controller and the
 *    per-navigation `AudioService` are in scope.
 *
 * Both are `null` / `undefined` when the loader does NOT build a
 * controller for this navigation: non-present mode OR the workbench did
 * not supply a `presenterCommands` source.
 */
function buildPresenterPipe(
  deps: NavigationServicesDeps,
  mode: NavigationMode,
  controller: AbortController,
  audio: AudioService,
): { presenter: PresenterController | undefined; presenterAbort: AbortController | null } {
  if (mode !== 'present' || deps.presenterCommands === undefined) {
    return { presenter: undefined, presenterAbort: null };
  }
  const presenterAbort = new AbortController();
  // Propagate navigation abort → presenter abort. Without this wiring,
  // supersession-time `controller.abort()` would not tear down the
  // presenter controller (bound to `presenterAbort.signal`).
  if (controller.signal.aborted) {
    presenterAbort.abort();
  } else {
    controller.signal.addEventListener('abort', () => presenterAbort.abort(), { once: true });
  }
  const presenter = createPresenterController(
    deps.presenterCommands,
    presenterAbort.signal,
    deps.onError,
  );
  // PUL-F025 / ADR-004 audio handler. On `'toggle-master-mute'` flip the
  // engine's current master mute via the audio boundary; `audio.mute()`
  // validates the boolean and is inert post-dispose.
  presenter.subscribe((cmd) => {
    if (cmd.kind !== 'toggle-master-mute') return;
    audio.mute(!audio.isMuted());
  });
  return { presenter, presenterAbort };
}

/**
 * Build the audio-service options for the per-navigation
 * {@link AudioService}. Split out so the conditional-spread density does
 * not charge {@link buildNavigationServices}'s cognitive complexity.
 */
function audioServiceOptions(
  deps: NavigationServicesDeps,
  resolved: SceneNavigationTarget,
  signal: AbortSignal,
  outputPolicy: AudioOutputPolicy,
  suppressBed: boolean,
  audioCueGate: CueGateControl | undefined,
): AudioServiceOptions {
  return {
    signal,
    outputPolicy,
    allowedSources: collectAudioSources(resolved),
    ...(deps.assetPolicy === undefined ? {} : { assetPolicy: deps.assetPolicy }),
    onError: deps.onError,
    ...(deps.onAudioCue === undefined ? {} : { onCue: deps.onAudioCue }),
    // PUL-F014 / ADR-004: the composition audio bed, suppressed under
    // `mode=standalone` (the loader is the mode-dispatch point that
    // decides bed vs no-bed, keeping the resolver mode-opaque).
    ...(resolved.composition?.audioBed === undefined ? {} : { bed: resolved.composition.audioBed }),
    bedSuppressed: suppressBed,
    // PUL-F017 / ADR-020: the shared cue gate (scrub only). The audio
    // service consults it; the timeline adapter toggles it.
    ...(audioCueGate === undefined ? {} : { cueGate: audioCueGate }),
  };
}

/**
 * Build the per-navigation audio service, presenter pipe, and the
 * per-occurrence ctx factory (PUL-F024 / PUL-F025 / PUL-F018). The
 * audio service is built FIRST so the presenter pipe's mute handler can
 * close over it; the ctx factory then layers each occurrence's
 * `activation` + seeded `rng` onto the navigation-scoped `buildCtx`
 * base. Throws on a failing `createAudioService` / `buildCtx`; the
 * caller aborts the controller and rolls back stage attrs.
 */
export function buildNavigationServices(
  deps: NavigationServicesDeps,
  resolved: SceneNavigationTarget,
  target: NavigationTarget,
  mode: NavigationMode,
  controller: AbortController,
  audioCueGate: CueGateControl | undefined,
): NavigationServices {
  const audio = createAudioService(
    deps.audioEngine,
    audioServiceOptions(
      deps,
      resolved,
      controller.signal,
      audioOutputPolicyFor(mode),
      profileFor(mode).suppressBed,
      audioCueGate,
    ),
  );
  const { presenter, presenterAbort } = buildPresenterPipe(deps, mode, controller, audio);
  const baseCtx = deps.buildCtx(mode, audio, presenter);
  const navigationSeed = deriveNavigationSeed(target);
  const buildSceneCtx: SceneCtxFactory = (activation) => ({
    ...(baseCtx as object),
    activation,
    rng: createSeededRng(deriveActivationSeed(navigationSeed, activation)),
  });
  return { audio, presenter, presenterAbort, buildSceneCtx };
}
