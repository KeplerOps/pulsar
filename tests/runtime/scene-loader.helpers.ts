// Shared fixtures for the PUL-F008 scene-loader test suites.
//
// `scene-loader.test.ts` was split into focused suites (navigation,
// beat/mode dispatch, present/presenter, single-scene modes, capture
// modes) so no file exceeds the repo's size budget; this module holds
// the helpers they all use. The loader is the testable unit `main.ts`
// drives once PUL-F007 has parsed the URL into a `NavigationTarget`.

import {
  type AudioEngine,
  type AudioService,
  createAudioService,
  noopAudioEngine,
} from '../../src/runtime/audio';
import { createCompositionRegistry } from '../../src/runtime/composition-registry';
import type {
  CompositionTimelineAdapter,
  CompositionTimelineRunOptions,
  SceneTimelineSegment,
} from '../../src/runtime/composition-resolver';
import {
  NAVIGATION_MODES,
  type NavigationMode,
  type NavigationTarget,
} from '../../src/runtime/navigation';
import { createPresenterController } from '../../src/runtime/presenter';
import type { PrompterRenderer, PrompterScript } from '../../src/runtime/prompter';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { Caption, SceneModule } from '../../src/runtime/scene';
import {
  type SceneLoaderOptions,
  type StageElement,
  type WorkbenchSceneCtx,
  createSceneLoader,
} from '../../src/runtime/scene-loader';

export {
  createCompositionRegistry,
  createSceneRegistry,
  createPresenterController,
  createSceneLoader,
  createAudioService,
  noopAudioEngine,
  NAVIGATION_MODES,
};
export type {
  AudioEngine,
  AudioService,
  Caption,
  CompositionTimelineAdapter,
  CompositionTimelineRunOptions,
  NavigationMode,
  NavigationTarget,
  PrompterRenderer,
  PrompterScript,
  SceneLoaderOptions,
  SceneModule,
  SceneTimelineSegment,
  StageElement,
  WorkbenchSceneCtx,
};

// PUL-F012 added `mode`, PUL-F022 added `gsap`, and PUL-F024 added
// `audio` to the ctx. The shared GSAP handle is real (the timeline
// engine is a process singleton); the loader supplies the per-navigation
// audio service as the second `buildCtx` argument, so a ctx-builder stub
// that does not care about ctx contents still satisfies `WorkbenchSceneCtx`
// by forwarding it.
import { createTimelineEngine } from '../../src/runtime/timeline';
export const { gsap } = createTimelineEngine();
// `buildCtx` builds the navigation-scoped ctx; the loader adds each
// occurrence's `activation` (issue #99), so the stub's return type
// omits it — same as the production `SceneLoaderOptions.buildCtx`.
export const stubCtx = (
  mode: NavigationMode,
  audio: AudioService,
): Omit<WorkbenchSceneCtx, 'activation'> => ({
  stage: null,
  mode,
  gsap,
  audio,
});

export interface BuildSceneOpts {
  readonly id: string;
  readonly title?: string;
  readonly assets?: readonly string[];
  readonly captions?: readonly Caption[];
  readonly audio?: readonly string[];
  readonly create?: SceneModule['create'];
  readonly timeline?: SceneModule['timeline'];
  readonly cleanup?: SceneModule['cleanup'];
}

export const buildScene = (opts: BuildSceneOpts): SceneModule => ({
  id: opts.id,
  title: opts.title ?? opts.id,
  duration: 1000,
  tags: [],
  assets: opts.assets ?? [],
  captions: opts.captions ?? [],
  audio: opts.audio ?? [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  create: opts.create ?? ((): void => undefined),
  timeline: opts.timeline ?? ((): undefined => undefined),
  cleanup: opts.cleanup ?? ((): void => undefined),
});

export interface FakeStage {
  readonly attrs: Map<string, string>;
  readonly element: StageElement;
}

export const buildStage = (): FakeStage => {
  const attrs = new Map<string, string>();
  return {
    attrs,
    element: {
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: (name) => attrs.delete(name),
    },
  };
};

export const sceneTarget = (id: string): NavigationTarget => ({
  locator: { kind: 'scene', scene: id },
});
export const compositionTarget = (composition: string): NavigationTarget => ({
  locator: { kind: 'composition', composition },
});
export const compositionSceneTarget = (composition: string, scene: string): NavigationTarget => ({
  locator: { kind: 'composition-scene', composition, scene },
});
export const compositionIndexTarget = (composition: string, index: number): NavigationTarget => ({
  locator: { kind: 'composition-index', composition, index },
});
export const noneTarget: NavigationTarget = { locator: { kind: 'none' } };

/** A no-op composition timeline adapter — resolves immediately. */
export const noopTimeline: CompositionTimelineAdapter = { run: () => Promise.resolve() };

/**
 * ADR-025 reshaped the timeline seam from a per-scene `SceneTimelineRunner`
 * to a composition-level `CompositionTimelineAdapter` (`run(segments,
 * opts)`, one call per navigation). Most loader tests only care that a
 * per-navigation hint reached the adapter, or that the scene stays
 * mounted until abort — `asTimeline` keeps those tests' `(input) => ...`
 * callbacks by mapping the new `(segments, opts)` call onto the old
 * shape: the head scene's id/timeline plus the `head*` hints renamed
 * without the `head` prefix, plus `segments` for tests that want the
 * whole slice. Tests that exercise composition-level behaviour directly
 * (the full slice under `mode=present`, presenter forwarding, the master
 * timeline) drive a recording adapter instead.
 */
export interface LegacyRunInput {
  readonly scene: { readonly id: string };
  readonly timeline: unknown;
  readonly range?: unknown;
  readonly behavior?: unknown;
  readonly segments: readonly SceneTimelineSegment[];
  readonly signal?: AbortSignal;
  readonly beat?: string;
  readonly onBeatMissing?: () => void;
  readonly repeat?: 'until-aborted';
  readonly hold?: 'first-frame';
  readonly cueGate?: 'monotonic-forward';
  readonly screenshot?: 'capture';
  readonly presenter?: ReturnType<typeof createPresenterController>;
}

export const asTimeline = (
  runner: (input: LegacyRunInput) => void | Promise<void>,
): CompositionTimelineAdapter => ({
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test helper that fan-in maps a CompositionTimelineAdapter's per-segment options into the legacy single-input runner shape; complexity is intrinsic to the option-by-option shape adaptation.
  run(segments, opts) {
    const head = segments[0];
    const input: LegacyRunInput = {
      scene: { id: head?.id ?? '' },
      timeline: head?.timeline,
      segments,
      ...(head?.range === undefined ? {} : { range: head.range }),
      ...(head?.behavior === undefined ? {} : { behavior: head.behavior }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      ...(opts.headBeat === undefined ? {} : { beat: opts.headBeat }),
      ...(opts.onBeatMissing === undefined ? {} : { onBeatMissing: opts.onBeatMissing }),
      ...(opts.headRepeat === undefined ? {} : { repeat: opts.headRepeat }),
      ...(opts.headHold === undefined ? {} : { hold: opts.headHold }),
      ...(opts.headCueGate === undefined ? {} : { cueGate: opts.headCueGate }),
      ...(opts.headScreenshot === undefined ? {} : { screenshot: opts.headScreenshot }),
      ...(opts.presenter === undefined ? {} : { presenter: opts.presenter }),
    };
    return Promise.resolve().then(() => runner(input));
  },
});

/** A recording composition timeline adapter — captures every `run` call; resolves immediately, or parks until abort. */
export interface TimelineRunCall {
  readonly segments: readonly SceneTimelineSegment[];
  readonly opts: CompositionTimelineRunOptions;
}
export const recordingTimeline = (
  park = false,
): { adapter: CompositionTimelineAdapter; calls: TimelineRunCall[] } => {
  const calls: TimelineRunCall[] = [];
  return {
    calls,
    adapter: {
      run(segments, opts) {
        calls.push({ segments, opts });
        if (!park) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const sig = opts.signal;
          if (sig === undefined || sig.aborted) {
            resolve();
            return;
          }
          sig.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
  };
};
