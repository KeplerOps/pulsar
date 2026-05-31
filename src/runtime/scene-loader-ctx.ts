// Scene-loader per-navigation context construction — PUL-F008.
//
// Builds the per-navigation audio service (PUL-F024 / PUL-F026 / ADR-004),
// presenter pipe (PUL-F025 / ADR-023), deterministic RNG seed
// (PUL-F018 / ADR-021), and per-occurrence ctx factory (issue #99) —
// the ctx-assembly seam, separate from `scene-loader.ts`'s queue.

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
 * The static `SceneModule.audio` URLs the resolved slice declared. The
 * audio service uses this as the scene-facing source allowlist so
 * `ctx.audio.load()` can only register declared audio (not any URL in
 * `scene.assets`), keeping it consistent with the PUL-F030 unlock-gate
 * predicate. The PUL-F014 composition bed is deliberately excluded (it is
 * gated against its own `src` in `startBed`).
 */
function collectAudioSources(target: SceneNavigationTarget): readonly string[] {
  return target.composition === undefined
    ? target.scene.audio
    : target.composition.sceneSlice.flatMap((scene) => scene.audio);
}

/**
 * Count, per scene id, its occurrences in the slice (issue #99). The
 * loader's occurrence-safe audio teardown stops the scene-scoped group
 * only after the LAST occurrence's cleanup, not once per occurrence.
 */
export function countSceneOccurrences(target: SceneNavigationTarget): Map<string, number> {
  const scenes = target.composition === undefined ? [target.scene] : target.composition.sceneSlice;
  const counts = new Map<string, number>();
  for (const scene of scenes) {
    counts.set(scene.id, (counts.get(scene.id) ?? 0) + 1);
  }
  return counts;
}

/** Mode → per-navigation {@link AudioOutputPolicy} via the mode profile. */
function audioOutputPolicyFor(mode: NavigationMode): AudioOutputPolicy {
  return profileFor(mode).audioPolicy;
}

/**
 * Serialize a {@link NavigationLocator} to a stable, collision-free
 * string for {@link deriveNavigationSeed}.
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
 * PUL-F018 / ADR-021: derive the per-navigation deterministic RNG seed
 * from bounded URL inputs only (locator + beat + `PULSAR_RUNTIME_VERSION`),
 * never the clock / storage / process state / `mode`, so screenshot frames
 * reproduce across reloads.
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
 * PUL-F018 / ADR-021: combine the navigation seed with one occurrence's
 * identity so every occurrence gets an independent random stream (#99).
 */
function deriveActivationSeed(navigationSeed: string, activation: SceneActivation): string {
  return `${navigationSeed}|occ:${activation.sceneId}#${activation.entryIndex}.${activation.occurrence}`;
}

/** A bound scene-ctx base, omitting the per-occurrence fields. */
type BaseCtx = unknown;

/** The per-occurrence ctx factory the resolver lifecycle consumes. */
export type SceneCtxFactory = (activation: SceneActivation) => unknown;

/**
 * Per-navigation services threaded into the resolver lifecycle: audio
 * service, presenter controller (`mode=present` only), presenter teardown
 * signal, and the per-occurrence ctx factory.
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
 * Construct the per-navigation presenter pipeline (PUL-F020 / ADR-023):
 * a `PresenterController` plus a separate `presenterAbort` signal so the
 * navigation signal can stay un-aborted across a successful completion
 * (PUL-F013). Both `null` / `undefined` for non-present mode or when no
 * `presenterCommands` source was supplied.
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
  // Propagate navigation abort → presenter abort, so supersession tears
  // down the controller (bound to `presenterAbort.signal`).
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
  // PUL-F025 / ADR-004: flip master mute via the audio boundary on
  // `'toggle-master-mute'`; `audio.mute()` is inert post-dispose.
  presenter.subscribe((cmd) => {
    if (cmd.kind !== 'toggle-master-mute') return;
    audio.mute(!audio.isMuted());
  });
  return { presenter, presenterAbort };
}

/** Build the per-navigation {@link AudioService} options. */
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
    // PUL-F014 / ADR-004: composition audio bed, suppressed under standalone.
    ...(resolved.composition?.audioBed === undefined ? {} : { bed: resolved.composition.audioBed }),
    bedSuppressed: suppressBed,
    // PUL-F017 / ADR-020: shared scrub cue gate (audio consults, timeline toggles).
    ...(audioCueGate === undefined ? {} : { cueGate: audioCueGate }),
  };
}

/**
 * Build the per-navigation audio service, presenter pipe, and
 * per-occurrence ctx factory (PUL-F024 / PUL-F025 / PUL-F018). Audio is
 * built FIRST so the presenter mute handler can close over it; the ctx
 * factory layers each occurrence's `activation` + seeded `rng` onto the
 * `buildCtx` base. Throws on failure; the caller rolls back.
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
