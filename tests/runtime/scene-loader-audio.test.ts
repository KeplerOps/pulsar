// Loader ↔ audio-service integration — PUL-F024 / ADR-004.
//
// `audio.test.ts` covers `createAudioService` in isolation; this file
// covers the scene loader's wiring of it:
//  - the per-navigation `AudioService` is threaded into `ctx.audio`
//    so scenes reach audio only through the runtime context (clause:
//    "Each scene SHALL access audio only via the runtime context");
//  - it is bound to the navigation's `AbortSignal` (supersession /
//    dispose) AND `stopAll()`-ed when a navigation completes — so
//    fades / loops / sprites never survive scene cleanup (ADR-004:
//    "per-scene cleanup is guaranteed by the runtime");
//  - it is restricted to the URLs the active slice declared in
//    `scene.assets` (ADR-008 #5);
//  - it is `silent` under `mode=screenshot` / `mode=paused`
//    (audible playback suppressed — ADR-019 / ADR-021);
//  - `mode=prompter` bypasses it (no scene mounts, no `ctx.audio`);
//  - a workbench that omits `audioEngine` still gives scenes a
//    working (silent) `ctx.audio` via the no-op engine.

import { describe, expect, it } from 'vitest';
import type {
  AudioEngine,
  AudioService,
  AudioSoundConfig,
  AudioSoundHandle,
} from '../../src/runtime/audio';
import {
  type NavigationTarget,
  buildScene,
  buildStage,
  compositionTarget,
  createCompositionRegistry,
  createSceneLoader,
  createSceneRegistry,
  noopTimeline,
  recordingTimeline,
  sceneTarget,
  stubCtx,
} from './scene-loader.helpers';

/* -------------------------------------------------------------------- *
 *  Recording audio engine — records every sound it builds and every
 *  handle call so tests can assert the loader's wiring + teardown.
 * -------------------------------------------------------------------- */

interface HandleCall {
  readonly sound: number;
  readonly method: 'play' | 'stop' | 'fade' | 'loop' | 'volume' | 'unload';
}

interface RecordingEngine {
  readonly engine: AudioEngine;
  readonly created: AudioSoundConfig[];
  readonly calls: HandleCall[];
}

const recordingAudioEngine = (): RecordingEngine => {
  const created: AudioSoundConfig[] = [];
  const calls: HandleCall[] = [];
  let masterMuted = false;
  let playCounter = 0;
  return {
    created,
    calls,
    engine: {
      createSound(config) {
        const index = created.length;
        created.push(config);
        const record = (method: HandleCall['method']) => (): void => {
          calls.push({ sound: index, method });
        };
        const handle: AudioSoundHandle = {
          play: () => {
            calls.push({ sound: index, method: 'play' });
            return ++playCounter;
          },
          stop: record('stop'),
          fade: record('fade'),
          loop: record('loop'),
          volume: record('volume'),
          unload: record('unload'),
        };
        return handle;
      },
      setMasterMute(muted) {
        masterMuted = muted;
      },
      isMasterMuted: () => masterMuted,
    },
  };
};

const targetWithMode = (scene: string, mode: NavigationTarget['mode']): NavigationTarget => ({
  locator: { kind: 'scene', scene },
  ...(mode === undefined ? {} : { mode }),
});

/* -------------------------------------------------------------------- */

describe('scene loader — audio service wiring (PUL-F024 / ADR-004)', () => {
  it('threads a working ctx.audio into every lifecycle hook', async () => {
    const seen: Array<{ phase: string; audio: AudioService | undefined }> = [];
    const audio = recordingAudioEngine();
    const scene = buildScene({
      id: 'a',
      assets: ['/audio/bed.mp3'],
      create: (ctx) => {
        const a = (ctx as { audio?: AudioService }).audio;
        seen.push({ phase: 'create', audio: a });
        a?.load('bed', { src: '/audio/bed.mp3' });
        a?.play('bed', { loop: true });
      },
      timeline: (ctx) => {
        seen.push({ phase: 'timeline', audio: (ctx as { audio?: AudioService }).audio });
        return null;
      },
      cleanup: (ctx) => {
        seen.push({ phase: 'cleanup', audio: (ctx as { audio?: AudioService }).audio });
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([scene]),
      compositions: createCompositionRegistry([]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: noopTimeline,
      audioEngine: audio.engine,
    });
    await loader.handle(sceneTarget('a'));
    await loader.idle();
    expect(seen.map((s) => s.phase)).toEqual(['create', 'timeline', 'cleanup']);
    for (const s of seen) expect(s.audio).toBeDefined();
    // create() registered + played + looped the bed.
    expect(audio.created).toHaveLength(1);
    expect(audio.calls).toContainEqual({ sound: 0, method: 'play' });
    expect(audio.calls).toContainEqual({ sound: 0, method: 'loop' });
    // The navigation completed → the loader stopped + unloaded it.
    expect(audio.calls).toContainEqual({ sound: 0, method: 'stop' });
    expect(audio.calls).toContainEqual({ sound: 0, method: 'unload' });
  });

  it('disposes the audio service when a navigation is superseded', async () => {
    let captured: AudioService | undefined;
    let mounted: () => void = () => undefined;
    const mountedP = new Promise<void>((resolve) => {
      mounted = resolve;
    });
    const audio = recordingAudioEngine();
    const long = buildScene({
      id: 'long',
      assets: ['/audio/bed.mp3'],
      create: (ctx) => {
        captured = (ctx as { audio: AudioService }).audio;
        captured.load('bed', { src: '/audio/bed.mp3' });
        captured.play('bed', { loop: true });
        mounted();
      },
    });
    const next = buildScene({ id: 'next' });
    const { adapter: parking } = recordingTimeline(true); // parks until the navigation aborts
    const loader = createSceneLoader({
      scenes: createSceneRegistry([long, next]),
      compositions: createCompositionRegistry([]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: parking,
      audioEngine: audio.engine,
    });
    void loader.handle(sceneTarget('long'));
    await mountedP; // `long` mounted and is parked in the timeline adapter
    expect(captured?.isDisposed()).toBe(false);
    void loader.handle(sceneTarget('next')); // synchronously aborts `long`'s controller
    expect(captured?.isDisposed()).toBe(true);
    loader.dispose();
    await loader.idle();
    expect(audio.calls).toContainEqual({ sound: 0, method: 'unload' });
  });

  it('disposes the audio service on loader dispose()', async () => {
    let captured: AudioService | undefined;
    let mounted: () => void = () => undefined;
    const mountedP = new Promise<void>((resolve) => {
      mounted = resolve;
    });
    const audio = recordingAudioEngine();
    const scene = buildScene({
      id: 'a',
      create: (ctx) => {
        captured = (ctx as { audio: AudioService }).audio;
        mounted();
      },
    });
    const { adapter: parking } = recordingTimeline(true);
    const loader = createSceneLoader({
      scenes: createSceneRegistry([scene]),
      compositions: createCompositionRegistry([]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: parking,
      audioEngine: audio.engine,
    });
    void loader.handle(sceneTarget('a'));
    await mountedP;
    expect(captured?.isDisposed()).toBe(false);
    loader.dispose();
    expect(captured?.isDisposed()).toBe(true);
    await loader.idle();
  });

  it('builds the audio service silent under mode=screenshot and mode=paused', async () => {
    for (const mode of ['screenshot', 'paused'] as const) {
      const audio = recordingAudioEngine();
      const scene = buildScene({
        id: 'a',
        assets: ['/audio/bed.mp3'],
        create: (ctx) => {
          (ctx as { audio: AudioService }).audio.load('bed', { src: '/audio/bed.mp3' });
        },
      });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([scene]),
        compositions: createCompositionRegistry([]),
        stage: null,
        buildCtx: stubCtx,
        createPreloader: () => () => Promise.resolve(),
        timeline: noopTimeline,
        audioEngine: audio.engine,
      });
      await loader.handle(targetWithMode('a', mode));
      await loader.idle();
      expect(audio.created).toHaveLength(1);
      expect(audio.created[0]?.muted).toBe(true);
    }
  });

  it('builds the audio service audible under mode=present', async () => {
    const audio = recordingAudioEngine();
    const scene = buildScene({
      id: 'a',
      assets: ['/audio/bed.mp3'],
      create: (ctx) => {
        (ctx as { audio: AudioService }).audio.load('bed', { src: '/audio/bed.mp3' });
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([scene]),
      compositions: createCompositionRegistry([]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: noopTimeline,
      audioEngine: audio.engine,
    });
    await loader.handle(targetWithMode('a', 'present'));
    await loader.idle();
    expect(audio.created[0]?.muted).toBe(false);
  });

  it('restricts ctx.audio.load() to URLs the slice declared in scene.assets', async () => {
    const stage = buildStage();
    const audio = recordingAudioEngine();
    const scene = buildScene({
      id: 'a',
      assets: ['/audio/bed.mp3'],
      create: (ctx) => {
        // Not in scene.assets — the per-navigation service rejects it.
        (ctx as { audio: AudioService }).audio.load('typo', { src: '/audio/typo.mp3' });
      },
      cleanup: () => {
        stage.attrs.set('data-cleanup-ran', 'yes');
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([scene]),
      compositions: createCompositionRegistry([]),
      stage: stage.element,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: noopTimeline,
      audioEngine: audio.engine,
      onError: () => undefined,
    });
    await loader.handle(sceneTarget('a'));
    await loader.idle();
    const err = stage.attrs.get('data-pulsar-navigation-error');
    expect(err).toBeDefined();
    expect(err).toContain('typo');
    // The resolver still tore the scene down (create-attempted ⇒ cleanup).
    expect(stage.attrs.get('data-cleanup-ran')).toBe('yes');
  });

  it('exposes every declared composition-slice asset to ctx.audio under mode=present', async () => {
    const audio = recordingAudioEngine();
    const a = buildScene({
      id: 'scene-a',
      assets: ['/audio/a.mp3'],
      create: (ctx) => {
        (ctx as { audio: AudioService }).audio.load('a-bed', { src: '/audio/a.mp3' });
      },
    });
    const b = buildScene({
      id: 'scene-b',
      assets: ['/audio/b.mp3'],
      create: (ctx) => {
        // `scene-b` may register `scene-a`'s declared URL too — the
        // slice's declared assets are the union (preloader warmed all).
        (ctx as { audio: AudioService }).audio.load('a-from-b', { src: '/audio/a.mp3' });
        (ctx as { audio: AudioService }).audio.load('b-bed', { src: '/audio/b.mp3' });
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([a, b]),
      compositions: createCompositionRegistry([{ id: 'pair', manifest: ['scene-a', 'scene-b'] }]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: noopTimeline,
      audioEngine: audio.engine,
    });
    await loader.handle(compositionTarget('pair'));
    await loader.idle();
    expect(audio.created).toHaveLength(3);
  });

  it('does not build an audio service under mode=prompter (no scene mounts)', async () => {
    const audio = recordingAudioEngine();
    const head = buildScene({
      id: 'head',
      assets: ['/audio/head.mp3'],
      create: (ctx) => {
        // Would register a sound — but prompter never mounts the scene.
        (ctx as { audio: AudioService }).audio.load('head-bed', { src: '/audio/head.mp3' });
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([head]),
      compositions: createCompositionRegistry([{ id: 'talk', manifest: ['head'] }]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: noopTimeline,
      audioEngine: audio.engine,
    });
    await loader.handle({
      locator: { kind: 'composition', composition: 'talk' },
      mode: 'prompter',
    });
    await loader.idle();
    expect(audio.created).toHaveLength(0);
  });

  it('falls back to a silent (no-op) audio engine when audioEngine is omitted', async () => {
    let captured: AudioService | undefined;
    const scene = buildScene({
      id: 'a',
      assets: ['/audio/bed.mp3'],
      create: (ctx) => {
        captured = (ctx as { audio: AudioService }).audio;
        // The no-op engine still backs a working service.
        captured.load('bed', { src: '/audio/bed.mp3', sprite: { hit: [0, 100] } });
        captured.play('bed', { sprite: 'hit', loop: true, volume: 0.5, group: 'scene-a' });
        captured.fade('bed', 0.5, 0, 25);
        captured.stopGroup('scene-a');
        captured.mute(true);
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([scene]),
      compositions: createCompositionRegistry([]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: noopTimeline,
    });
    await expect(loader.handle(sceneTarget('a'))).resolves.toBeUndefined();
    await loader.idle();
    expect(captured).toBeDefined();
    expect(captured?.isMuted()).toBe(true);
    expect(captured?.isDisposed()).toBe(true);
  });
});
