// Present-mode loader (ADR-032) — the lean replacement for the
// master-timeline scene-loader + composition-resolver.
//
// Per navigation: resolve the target, then either render the prompter
// (captions-only) or run the resolved scene slice through the imperative
// control plane (`runSceneModules`): preload → create → play the scene's
// own GSAP timeline standalone → hold for advance → cleanup → next. No
// master timeline, no advance-gate composition. Supersession aborts the
// in-flight navigation; the next navigation gets a fresh controller.

import type { ChromeSlots } from '../system/chrome';
import type { AssetUrlPolicy } from './asset-preloader';
import type { AudioEngine, AudioService } from './audio';
import type { CompositionRegistry } from './composition-registry';
import { type NavigationMode, type NavigationTarget, effectiveMode } from './navigation';
import type { PresenterCommandSource } from './presenter';
import { type PrompterRenderer, buildPrompterScript } from './prompter';
import type { SceneRegistry } from './registry';
import type { SceneActivation, SceneModule } from './scene';
import { type NavigationServicesDeps, buildNavigationServices } from './scene-loader-ctx';
import { type AudioUnlockAdapter, resolveUnlockGate } from './scene-loader-guard';
import { type SceneNavigationTarget, resolveSceneNavigation } from './scene-navigation';
import { runSceneModules } from './spike/control-plane';

/** Per-navigation scene context the SceneModule lifecycle hooks consume. */
export type WorkbenchCtxBase = (
  mode: NavigationMode,
  audio: AudioService,
  presenter?: import('./presenter').PresenterController,
) => unknown;

export interface PresentLoaderDeps {
  readonly scenes: SceneRegistry;
  readonly compositions: CompositionRegistry;
  /** L2 chrome slots — the control plane resets them between scenes. */
  readonly chrome?: ChromeSlots;
  readonly audioEngine: AudioEngine;
  readonly presenterCommands?: PresenterCommandSource;
  readonly audioUnlockAdapter?: AudioUnlockAdapter;
  readonly renderPrompter?: PrompterRenderer;
  readonly createPreloader: (signal: AbortSignal) => (scene: SceneModule) => void | Promise<void>;
  /** Base ctx factory (stage/gsap/chrome/mode/audio/presenter) — per-occurrence rng+activation are layered on. */
  readonly buildCtx: WorkbenchCtxBase;
  readonly assetPolicy?: AssetUrlPolicy;
  readonly onError?: (err: unknown) => void;
}

export interface PresentLoader {
  handle(target: NavigationTarget): Promise<void>;
  handleError(err: unknown): void;
  /** Abort any in-flight navigation (HMR teardown). */
  dispose(): void;
}

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });

/** Build one activation per slice entry, counting occurrences of repeated ids. */
function buildActivations(scenes: readonly { id: string }[]): readonly SceneActivation[] {
  const occurrence = new Map<string, number>();
  return scenes.map((scene, entryIndex) => {
    const occ = occurrence.get(scene.id) ?? 0;
    occurrence.set(scene.id, occ + 1);
    return { sceneId: scene.id, entryIndex, occurrence: occ };
  });
}

export function createPresentLoader(deps: PresentLoaderDeps): PresentLoader {
  const report = (err: unknown): void => deps.onError?.(err);
  let current: AbortController | null = null;

  const renderPrompterMode = async (
    resolved: SceneNavigationTarget,
    signal: AbortSignal,
  ): Promise<void> => {
    const renderer = deps.renderPrompter;
    if (renderer === undefined) return;
    const result = await renderer(buildPrompterScript(resolved), signal);
    if (typeof result !== 'function') return;
    await waitForAbort(signal);
    await result();
  };

  const runPresentMode = async (
    resolved: SceneNavigationTarget,
    target: NavigationTarget,
    controller: AbortController,
  ): Promise<void> => {
    const navServicesDeps: NavigationServicesDeps = {
      audioEngine: deps.audioEngine,
      onError: (err) => report(err),
      buildCtx: deps.buildCtx,
      ...(deps.assetPolicy ? { assetPolicy: deps.assetPolicy } : {}),
      ...(deps.presenterCommands ? { presenterCommands: deps.presenterCommands } : {}),
    };
    const services = buildNavigationServices(
      navServicesDeps,
      resolved,
      target,
      'present',
      controller,
      undefined,
    );
    const slice = resolved.composition ? resolved.composition.sceneSlice : [resolved.scene];
    const activations = buildActivations(slice);
    const preloadAssets = deps.createPreloader(controller.signal);

    const run = (): Promise<void> =>
      runSceneModules(slice, {
        ...(deps.chrome !== undefined ? { chrome: deps.chrome } : {}),
        audio: services.audio,
        ...(services.presenter ? { presenter: services.presenter } : {}),
        navSignal: controller.signal,
        onError: (err) => report(err),
        preload: (scene) => preloadAssets(scene),
        buildCtx: (_scene, index) => services.buildSceneCtx(activations[index] as SceneActivation),
      });

    const gate = resolveUnlockGate(deps.audioUnlockAdapter, target, resolved);
    try {
      if (gate === 'fail-loud') {
        report(
          new Error(
            'present-mode composition declares audio but no audio-unlock adapter was supplied',
          ),
        );
        return;
      }
      if (gate === null) {
        await run();
      } else {
        await gate({ signal: controller.signal, unlock: () => deps.audioEngine.unlock() });
        if (!controller.signal.aborted) await run();
      }
    } finally {
      services.presenterAbort?.abort();
      services.audio.stopAll();
    }
  };

  const handle = async (target: NavigationTarget): Promise<void> => {
    current?.abort();
    const controller = new AbortController();
    current = controller;
    let resolved: SceneNavigationTarget | null = null;
    try {
      resolved = resolveSceneNavigation(target, {
        scenes: deps.scenes,
        compositions: deps.compositions,
      });
    } catch (err) {
      report(err);
      return;
    }
    if (resolved === null) return;
    try {
      if (effectiveMode(target) === 'prompter') {
        await renderPrompterMode(resolved, controller.signal);
      } else {
        await runPresentMode(resolved, target, controller);
      }
    } catch (err) {
      report(err);
    }
  };

  const handleError = (err: unknown): void => {
    current?.abort();
    report(err);
  };

  const dispose = (): void => {
    current?.abort();
    current = null;
  };

  return { handle, handleError, dispose };
}
