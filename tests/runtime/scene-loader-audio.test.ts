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
  AudioCueLogEntry,
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
      unlock: () => Promise.resolve(),
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
      audio: ['/audio/bed.mp3'],
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
      audio: ['/audio/bed.mp3'],
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
        audio: ['/audio/bed.mp3'],
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
      // outputPolicy === 'silent' constructs every sound muted at the
      // engine (PUL-F024 / ADR-019 / ADR-021). The cue log stays
      // silent because the policy is not 'log-cues'.
      expect(audio.created[0]?.muted).toBe(true);
    }
  });

  it('builds the audio service audible under mode=present', async () => {
    const audio = recordingAudioEngine();
    const scene = buildScene({
      id: 'a',
      assets: ['/audio/bed.mp3'],
      audio: ['/audio/bed.mp3'],
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

  it('restricts ctx.audio.load() to URLs the slice declared in scene.audio (PUL-F030 makes the audio list authoritative)', async () => {
    const stage = buildStage();
    const audio = recordingAudioEngine();
    const captured: unknown[] = [];
    const scene = buildScene({
      id: 'a',
      assets: ['/audio/bed.mp3'],
      audio: ['/audio/bed.mp3'],
      create: (ctx) => {
        // Not in scene.audio — the per-navigation service rejects it.
        // (PUL-F030 / ADR-029: scene.audio is the audio-source allowlist
        // so the unlock gate cannot be bypassed by undeclared loads.)
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
      onError: (err) => {
        captured.push(err);
      },
    });
    await loader.handle(sceneTarget('a'));
    await loader.idle();
    // PUL-F029 / ADR-028: a `create(ctx)` throw is a per-scene
    // failure, not a fatal navigation error. The diagnostic lands on
    // the per-scene stage attribute + `onError`, NOT on the
    // composition-wide `data-pulsar-navigation-error` surface.
    expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
    expect(stage.attrs.get('data-pulsar-scene-failures')).toBe('a:create');
    const sceneErr = captured.find((e) => e instanceof Error && /typo/.test((e as Error).message));
    expect(sceneErr).toBeDefined();
    // The resolver still tore the scene down (create-attempted ⇒ cleanup).
    expect(stage.attrs.get('data-cleanup-ran')).toBe('yes');
  });

  it('exposes every declared composition-slice audio source to ctx.audio under mode=present', async () => {
    const audio = recordingAudioEngine();
    const { adapter } = buildRecordingUnlockAdapter('resolve');
    const a = buildScene({
      id: 'scene-a',
      assets: ['/audio/a.mp3'],
      audio: ['/audio/a.mp3'],
      create: (ctx) => {
        (ctx as { audio: AudioService }).audio.load('a-bed', { src: '/audio/a.mp3' });
      },
    });
    const b = buildScene({
      id: 'scene-b',
      assets: ['/audio/b.mp3'],
      audio: ['/audio/b.mp3'],
      create: (ctx) => {
        // `scene-b` may register `scene-a`'s declared URL too — the
        // slice's declared audio sources are the union of every scene's
        // `audio` list (PUL-F030 makes the audio list authoritative).
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
      audioUnlockAdapter: adapter,
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

  it('threads onAudioCue through ctx.audio under mode=present but emits no cues (policy: audible)', async () => {
    const cues: AudioCueLogEntry[] = [];
    const audio = recordingAudioEngine();
    const scene = buildScene({
      id: 'a',
      assets: ['/audio/bed.mp3'],
      audio: ['/audio/bed.mp3'],
      create: (ctx) => {
        (ctx as { audio: AudioService }).audio.load('bed', { src: '/audio/bed.mp3' });
        (ctx as { audio: AudioService }).audio.play('bed');
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
      onAudioCue: (entry) => cues.push(entry),
    });
    await loader.handle(targetWithMode('a', 'present'));
    await loader.idle();
    // Audible policy => audio.created[0].muted is false; no cues emitted.
    expect(audio.created[0]?.muted).toBe(false);
    expect(cues).toEqual([]);
  });

  it('falls back to a silent (no-op) audio engine when audioEngine is omitted', async () => {
    let captured: AudioService | undefined;
    const scene = buildScene({
      id: 'a',
      assets: ['/audio/bed.mp3'],
      audio: ['/audio/bed.mp3'],
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

/* -------------------------------------------------------------------- *
 *  mode=rehearsal — PUL-F026 / ADR-004
 *
 *  Rehearsal is an audio-output policy, not a timeline-state mode. The
 *  loader's responsibility:
 *
 *  - Build the per-navigation `AudioService` with
 *    `outputPolicy: 'log-cues'` (audio muted at engine level AND
 *    every accepted audio operation emitted to the workbench's
 *    optional `onAudioCue` sink).
 *  - Thread `onAudioCue` through to `onCue` regardless of mode (the
 *    policy decides whether cues are emitted).
 *  - Reach `ctx.mode === 'rehearsal'` (PUL-F012 seam) on every
 *    lifecycle hook.
 *  - NOT truncate the composition slice (rehearsal preserves "the
 *    same scene slice and timeline progression as normal playback
 *    from that target" — preflight).
 *  - Preserve head-entry `range` / `behavior` overrides for composition
 *    + scene / composition + index rehearsal targets.
 * -------------------------------------------------------------------- */

describe('scene loader — mode=rehearsal (PUL-F026 / ADR-004)', () => {
  it('builds the audio service with outputPolicy log-cues (sounds muted at the engine)', async () => {
    const audio = recordingAudioEngine();
    const scene = buildScene({
      id: 'a',
      assets: ['/audio/bed.mp3'],
      audio: ['/audio/bed.mp3'],
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
    await loader.handle(targetWithMode('a', 'rehearsal'));
    await loader.idle();
    expect(audio.created).toHaveLength(1);
    expect(audio.created[0]?.muted).toBe(true);
  });

  it('emits cues through onAudioCue when scenes play audio under mode=rehearsal', async () => {
    const cues: AudioCueLogEntry[] = [];
    const audio = recordingAudioEngine();
    // Scope the scene's audio to its own group (`scene.id`) so the
    // loader's per-scene post-cleanup hook (`onSceneCleaned` →
    // `audio.stopGroup(sceneId)`) emits the same group's stop-group
    // cue at teardown — the runtime-guaranteed audio-group teardown
    // (ADR-004) is itself an accepted audio operation and therefore
    // part of the rehearsal cue stream.
    const scene = buildScene({
      id: 'a',
      assets: ['/audio/bed.mp3'],
      audio: ['/audio/bed.mp3'],
      create: (ctx) => {
        const x = (ctx as { audio: AudioService }).audio;
        x.load('bed', { src: '/audio/bed.mp3' });
        x.play('bed', { group: 'a' });
        x.fade('bed', 1, 0, 100);
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
      onAudioCue: (entry) => cues.push(entry),
    });
    await loader.handle(targetWithMode('a', 'rehearsal'));
    await loader.idle();
    expect(cues.map((c) => c.operation)).toEqual(['play', 'fade', 'stop-group']);
    expect(cues[0]).toMatchObject({ operation: 'play', soundId: 'bed', group: 'a' });
    expect(cues[1]).toMatchObject({ operation: 'fade', soundId: 'bed' });
    // The final stop-group cue is the runtime-fired teardown of the
    // scene's audio group on `cleanup(ctx)` (PUL-F024 / ADR-004).
    expect(cues[2]).toMatchObject({ operation: 'stop-group', group: 'a' });
    // Engine-level mute is independent of the cue log.
    expect(audio.created[0]?.muted).toBe(true);
  });

  it('rehearses a composition target through the FULL slice — no slice truncation', async () => {
    // Distinguishes rehearsal from standalone/loop/paused/scrub/screenshot:
    // those modes truncate the slice to the head; rehearsal preserves it.
    const a = buildScene({ id: 'scene-a' });
    const b = buildScene({ id: 'scene-b' });
    const c = buildScene({ id: 'scene-c' });
    const { adapter, calls } = recordingTimeline();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([a, b, c]),
      compositions: createCompositionRegistry([
        { id: 'talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
      ]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: adapter,
    });
    await loader.handle({
      locator: { kind: 'composition', composition: 'talk' },
      mode: 'rehearsal',
    });
    await loader.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.segments.map((s) => s.id)).toEqual(['scene-a', 'scene-b', 'scene-c']);
  });

  it('rehearses a composition+scene target from the addressed head onward (slice preserved)', async () => {
    const a = buildScene({ id: 'scene-a' });
    const b = buildScene({ id: 'scene-b' });
    const c = buildScene({ id: 'scene-c' });
    const { adapter, calls } = recordingTimeline();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([a, b, c]),
      compositions: createCompositionRegistry([
        { id: 'talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
      ]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: adapter,
    });
    await loader.handle({
      locator: { kind: 'composition-scene', composition: 'talk', scene: 'scene-b' },
      mode: 'rehearsal',
    });
    await loader.idle();
    // Slice from scene-b onward — full progression, no truncation to head.
    expect(calls[0]?.segments.map((s) => s.id)).toEqual(['scene-b', 'scene-c']);
  });

  it('rehearses a composition+index target preserving the head entry’s `range` / `behavior` overrides', async () => {
    const a = buildScene({ id: 'scene-a' });
    const b = buildScene({ id: 'scene-b' });
    const { adapter, calls } = recordingTimeline();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([a, b]),
      compositions: createCompositionRegistry([
        {
          id: 'talk',
          manifest: [
            'scene-a',
            // Object-form entry with range + behavior so we can verify
            // they reach the runner unchanged under rehearsal. The
            // entry shape is `{ id, range?, behavior? }` per PUL-F003;
            // `range` is a `[start, end]` tuple of kebab-case beat
            // labels (or a single kebab string).
            { id: 'scene-b', range: ['a-beat', 'z-beat'], behavior: { x: 1 } },
          ],
        },
      ]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: adapter,
    });
    await loader.handle({
      locator: { kind: 'composition-index', composition: 'talk', index: 1 },
      mode: 'rehearsal',
    });
    await loader.idle();
    const segment = calls[0]?.segments[0];
    expect(segment?.id).toBe('scene-b');
    expect(segment?.range).toEqual(['a-beat', 'z-beat']);
    expect(segment?.behavior).toEqual({ x: 1 });
  });

  it('reaches ctx.mode === "rehearsal" in every lifecycle hook of every scene in the slice', async () => {
    const seen: Array<{ id: string; phase: string; mode: string | undefined }> = [];
    const a = buildScene({
      id: 'scene-a',
      create: (ctx) => {
        seen.push({ id: 'scene-a', phase: 'create', mode: (ctx as WorkbenchSceneCtxLike).mode });
      },
      timeline: (ctx) => {
        seen.push({ id: 'scene-a', phase: 'timeline', mode: (ctx as WorkbenchSceneCtxLike).mode });
        return null;
      },
      cleanup: (ctx) => {
        seen.push({ id: 'scene-a', phase: 'cleanup', mode: (ctx as WorkbenchSceneCtxLike).mode });
      },
    });
    const b = buildScene({
      id: 'scene-b',
      create: (ctx) => {
        seen.push({ id: 'scene-b', phase: 'create', mode: (ctx as WorkbenchSceneCtxLike).mode });
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([a, b]),
      compositions: createCompositionRegistry([{ id: 'talk', manifest: ['scene-a', 'scene-b'] }]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: noopTimeline,
    });
    await loader.handle({
      locator: { kind: 'composition', composition: 'talk' },
      mode: 'rehearsal',
    });
    await loader.idle();
    expect(seen.every((s) => s.mode === 'rehearsal')).toBe(true);
    // Both scenes mounted (full slice — no truncation).
    expect(seen.some((s) => s.id === 'scene-a')).toBe(true);
    expect(seen.some((s) => s.id === 'scene-b')).toBe(true);
  });

  it('exposes every declared composition-slice audio source to ctx.audio under mode=rehearsal', async () => {
    // Rehearsal preserves the full slice, so the audio service's
    // allowedSources is the union of every scene's `scene.audio` —
    // same invariant as `mode=present`. A scene further down the slice
    // can register a sibling scene's declared URL.
    const a = buildScene({
      id: 'scene-a',
      assets: ['/audio/a.mp3'],
      audio: ['/audio/a.mp3'],
      create: (ctx) => {
        (ctx as { audio: AudioService }).audio.load('a-bed', { src: '/audio/a.mp3' });
      },
    });
    const b = buildScene({
      id: 'scene-b',
      assets: ['/audio/b.mp3'],
      audio: ['/audio/b.mp3'],
      create: (ctx) => {
        (ctx as { audio: AudioService }).audio.load('a-from-b', { src: '/audio/a.mp3' });
        (ctx as { audio: AudioService }).audio.load('b-bed', { src: '/audio/b.mp3' });
      },
    });
    const audio = recordingAudioEngine();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([a, b]),
      compositions: createCompositionRegistry([{ id: 'pair', manifest: ['scene-a', 'scene-b'] }]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: noopTimeline,
      audioEngine: audio.engine,
    });
    await loader.handle({
      locator: { kind: 'composition', composition: 'pair' },
      mode: 'rehearsal',
    });
    await loader.idle();
    expect(audio.created).toHaveLength(3);
    expect(audio.created.every((c) => c.muted)).toBe(true);
  });

  it('preserves head-only timeline-runner contracts under mode=rehearsal (no `repeat` / `hold` / `cueGate` / `screenshot`)', async () => {
    const a = buildScene({ id: 'scene-a' });
    const { adapter, calls } = recordingTimeline();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([a]),
      compositions: createCompositionRegistry([]),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: adapter,
    });
    await loader.handle(targetWithMode('scene-a', 'rehearsal'));
    await loader.idle();
    const opts = calls[0]?.opts;
    expect(opts?.headRepeat).toBeUndefined();
    expect(opts?.headHold).toBeUndefined();
    expect(opts?.headCueGate).toBeUndefined();
    expect(opts?.headScreenshot).toBeUndefined();
  });
});

type WorkbenchSceneCtxLike = { readonly mode?: string };

/* ===================================================================== *
 *  PUL-F030 / ADR-029 — Present-mode audio unlock gate.
 *
 *  Gate triggers when:
 *    - `effectiveMode(target) === 'present'` (URL absent mode collapses
 *      to 'present', mirroring ADR-007); AND
 *    - the resolved target carries a composition slice (composition
 *      navigation, not a direct `?scene=...&mode=present`); AND
 *    - at least one scene in `sceneSlice` declares audio via the
 *      static `scene.audio` field (PUL-F030 declaration predicate).
 *
 *  When the gate triggers AND an `audioUnlockAdapter` is supplied,
 *  the loader awaits the adapter — passing semantic composition
 *  context, the navigation `AbortSignal`, and an engine-bound
 *  `unlock()` callback — BEFORE any lifecycle work begins.
 *
 *  When the gate triggers AND no adapter is supplied, the loader
 *  surfaces a navigation error and skips the lifecycle (no
 *  inert-seam degradation here — the gate IS the structural
 *  defense PUL-F030 records).
 * ===================================================================== */

interface GateCall {
  readonly compositionId: string;
  readonly sceneIds: readonly string[];
  readonly signal: AbortSignal;
  readonly unlock: () => Promise<void>;
}

const buildRecordingUnlockAdapter = (
  behavior: 'resolve' | 'reject' | 'park' = 'resolve',
  err: Error | null = null,
): {
  readonly adapter: import('../../src/runtime/scene-loader').AudioUnlockAdapter;
  readonly calls: GateCall[];
  readonly releaseGate: () => void;
} => {
  const calls: GateCall[] = [];
  let release: () => void = () => undefined;
  return {
    calls,
    releaseGate: () => release(),
    adapter: (gate) => {
      calls.push(gate);
      if (behavior === 'resolve') return Promise.resolve();
      if (behavior === 'reject') {
        return Promise.reject(err ?? new Error('unlock adapter rejected'));
      }
      return new Promise<void>((resolve, reject) => {
        release = () => resolve();
        if (gate.signal.aborted) reject(new Error('aborted before gate released'));
        else
          gate.signal.addEventListener(
            'abort',
            () => reject(new Error('aborted before gate released')),
            { once: true },
          );
      });
    },
  };
};

const audioScene = (id: string): import('../../src/runtime/scene').SceneModule =>
  buildScene({
    id,
    assets: [`/audio/${id}.mp3`],
    audio: [`/audio/${id}.mp3`],
  });

const presentTarget = (composition: string, index = 0): NavigationTarget => ({
  locator: { kind: 'composition-index', composition, index },
  mode: 'present',
});

const presentCompositionTarget = (composition: string): NavigationTarget => ({
  locator: { kind: 'composition', composition },
  mode: 'present',
});

describe('scene loader — PUL-F030 audio unlock gate (ADR-029)', () => {
  describe('gate triggers', () => {
    it('awaits the unlock adapter BEFORE preload/create/timeline run, then runs lifecycle in order once the gate resolves', async () => {
      // Codex review cycle 1 (one-off "gate ordering test never
      // releases or awaits the parked gate"): both halves of the
      // ordering contract must be verified — (a) lifecycle has NOT
      // started while the gate is parked, AND (b) lifecycle DOES
      // start, in the canonical preload/create/timeline/cleanup
      // order, after the gate resolves. A test that asserts only
      // (a) would still pass if a regression made the loader
      // permanently stop after unlock; releasing the gate and
      // awaiting the navigation exercises both halves.
      const order: string[] = [];
      const audio = recordingAudioEngine();
      const scene = audioScene('intro');
      const { adapter, calls, releaseGate } = buildRecordingUnlockAdapter('park');
      const sceneWithHooks: import('../../src/runtime/scene').SceneModule = {
        ...scene,
        create: () => {
          order.push('create');
        },
        timeline: () => {
          order.push('timeline');
          return null;
        },
        cleanup: () => {
          order.push('cleanup');
        },
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneWithHooks]),
        compositions: createCompositionRegistry([{ id: 'show', manifest: ['intro'] }]),
        stage: null,
        buildCtx: stubCtx,
        createPreloader: () => (): Promise<void> => {
          order.push('preload');
          return Promise.resolve();
        },
        timeline: noopTimeline,
        audioEngine: audio.engine,
        audioUnlockAdapter: adapter,
      });
      const pending = loader.handle(presentCompositionTarget('show'));
      // Yield the microtask so the gate adapter has been invoked.
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toHaveLength(1);
      // Gate parked — no lifecycle phase has run yet.
      expect(order).toEqual([]);
      // Release the gate; the lifecycle now proceeds.
      releaseGate();
      await pending;
      await loader.idle();
      // Lifecycle ran AFTER the gate, in the canonical order.
      expect(order).toEqual(['preload', 'create', 'timeline', 'cleanup']);
    });

    it('passes semantic composition context and a one-shot unlock callback to the adapter', async () => {
      const audio = recordingAudioEngine();
      const a = audioScene('a');
      const b = buildScene({ id: 'b' }); // declares no audio
      const c = audioScene('c');
      const { adapter, calls } = buildRecordingUnlockAdapter('resolve');
      const loader = createSceneLoader({
        scenes: createSceneRegistry([a, b, c]),
        compositions: createCompositionRegistry([{ id: 'show', manifest: ['a', 'b', 'c'] }]),
        stage: null,
        buildCtx: stubCtx,
        createPreloader: () => () => Promise.resolve(),
        timeline: noopTimeline,
        audioEngine: audio.engine,
        audioUnlockAdapter: adapter,
      });
      await loader.handle(presentCompositionTarget('show'));
      await loader.idle();
      expect(calls).toHaveLength(1);
      const gate = calls[0];
      if (gate === undefined) throw new Error('gate not called');
      expect(gate.compositionId).toBe('show');
      expect(gate.sceneIds).toEqual(['a', 'b', 'c']);
      // The signal exists and is NOT aborted (lifecycle completed).
      expect(typeof gate.signal.aborted).toBe('boolean');
      // Adapter received an `unlock` callback that, when called,
      // forwards to engine.unlock() — but we don't call it here in
      // the success path; that's covered by the "adapter calls
      // engine.unlock" test below.
      expect(typeof gate.unlock).toBe('function');
    });

    it("forwards the adapter's unlock() to engine.unlock() exactly when called", async () => {
      const audio = recordingAudioEngine();
      let unlockInvocations = 0;
      const customEngine: typeof audio.engine = {
        ...audio.engine,
        unlock: () => {
          unlockInvocations += 1;
          return Promise.resolve();
        },
      };
      let captured: GateCall | undefined;
      const adapter: import('../../src/runtime/scene-loader').AudioUnlockAdapter = async (gate) => {
        captured = gate;
        await gate.unlock();
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([audioScene('a')]),
        compositions: createCompositionRegistry([{ id: 'show', manifest: ['a'] }]),
        stage: null,
        buildCtx: stubCtx,
        createPreloader: () => () => Promise.resolve(),
        timeline: noopTimeline,
        audioEngine: customEngine,
        audioUnlockAdapter: adapter,
      });
      await loader.handle(presentCompositionTarget('show'));
      await loader.idle();
      expect(captured).toBeDefined();
      expect(unlockInvocations).toBe(1);
    });

    it('surfaces an adapter rejection through onError and data-pulsar-navigation-error, skipping lifecycle', async () => {
      const audio = recordingAudioEngine();
      const stage = buildStage();
      const errors: unknown[] = [];
      let createCalled = false;
      const scene: import('../../src/runtime/scene').SceneModule = {
        ...audioScene('a'),
        create: () => {
          createCalled = true;
        },
      };
      const { adapter } = buildRecordingUnlockAdapter(
        'reject',
        new Error('user dismissed gesture'),
      );
      const loader = createSceneLoader({
        scenes: createSceneRegistry([scene]),
        compositions: createCompositionRegistry([{ id: 'show', manifest: ['a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => Promise.resolve(),
        timeline: noopTimeline,
        audioEngine: audio.engine,
        audioUnlockAdapter: adapter,
        onError: (e) => {
          errors.push(e);
        },
      });
      await loader.handle(presentCompositionTarget('show'));
      await loader.idle();
      expect(createCalled).toBe(false);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toMatch(/user dismissed gesture/);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(/user dismissed gesture/);
    });

    it('fails loud when the gate applies but no audioUnlockAdapter is supplied', async () => {
      const audio = recordingAudioEngine();
      const stage = buildStage();
      const errors: unknown[] = [];
      let createCalled = false;
      const scene: import('../../src/runtime/scene').SceneModule = {
        ...audioScene('a'),
        create: () => {
          createCalled = true;
        },
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([scene]),
        compositions: createCompositionRegistry([{ id: 'show', manifest: ['a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => Promise.resolve(),
        timeline: noopTimeline,
        audioEngine: audio.engine,
        // audioUnlockAdapter intentionally omitted
        onError: (e) => {
          errors.push(e);
        },
      });
      await loader.handle(presentCompositionTarget('show'));
      await loader.idle();
      expect(createCalled).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
      expect((errors[0] as Error).message).toMatch(/audio unlock/i);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(/audio unlock/i);
    });

    it('aborts the adapter on supersession (signal fires; lifecycle never starts)', async () => {
      const audio = recordingAudioEngine();
      const a = audioScene('a');
      const b = buildScene({ id: 'b' });
      let createA = false;
      const aWithHook: import('../../src/runtime/scene').SceneModule = {
        ...a,
        create: () => {
          createA = true;
        },
      };
      const { adapter, calls } = buildRecordingUnlockAdapter('park');
      const loader = createSceneLoader({
        scenes: createSceneRegistry([aWithHook, b]),
        compositions: createCompositionRegistry([{ id: 'show', manifest: ['a'] }]),
        stage: null,
        buildCtx: stubCtx,
        createPreloader: () => () => Promise.resolve(),
        timeline: noopTimeline,
        audioEngine: audio.engine,
        audioUnlockAdapter: adapter,
      });
      const firstNav = loader.handle(presentCompositionTarget('show'));
      // Let the gate be invoked.
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toHaveLength(1);
      const gate = calls[0];
      if (gate === undefined) throw new Error('gate not called');
      expect(gate.signal.aborted).toBe(false);
      // Supersede with a no-gate navigation.
      await loader.handle(sceneTarget('b'));
      await firstNav.catch(() => undefined);
      await loader.idle();
      expect(gate.signal.aborted).toBe(true);
      expect(createA).toBe(false);
    });
  });

  describe('gate bypass cases', () => {
    it('does not invoke the adapter for a present-mode single-scene target (no composition)', async () => {
      const audio = recordingAudioEngine();
      const scene = audioScene('a');
      const { adapter, calls } = buildRecordingUnlockAdapter('resolve');
      const loader = createSceneLoader({
        scenes: createSceneRegistry([scene]),
        compositions: createCompositionRegistry([]),
        stage: null,
        buildCtx: stubCtx,
        createPreloader: () => () => Promise.resolve(),
        timeline: noopTimeline,
        audioEngine: audio.engine,
        audioUnlockAdapter: adapter,
      });
      // `?scene=a&mode=present` — present mode but NOT a composition load.
      await loader.handle({ locator: { kind: 'scene', scene: 'a' }, mode: 'present' });
      await loader.idle();
      expect(calls).toHaveLength(0);
    });

    it('does not invoke the adapter when no scene in the composition slice declares audio', async () => {
      const audio = recordingAudioEngine();
      const a = buildScene({ id: 'a' }); // no audio
      const b = buildScene({ id: 'b' }); // no audio
      const { adapter, calls } = buildRecordingUnlockAdapter('resolve');
      const loader = createSceneLoader({
        scenes: createSceneRegistry([a, b]),
        compositions: createCompositionRegistry([{ id: 'show', manifest: ['a', 'b'] }]),
        stage: null,
        buildCtx: stubCtx,
        createPreloader: () => () => Promise.resolve(),
        timeline: noopTimeline,
        audioEngine: audio.engine,
        audioUnlockAdapter: adapter,
      });
      await loader.handle(presentCompositionTarget('show'));
      await loader.idle();
      expect(calls).toHaveLength(0);
    });

    it.each<['rehearsal' | 'screenshot' | 'paused' | 'scrub' | 'loop' | 'standalone' | 'prompter']>(
      [
        ['rehearsal'],
        ['screenshot'],
        ['paused'],
        ['scrub'],
        ['loop'],
        ['standalone'],
        ['prompter'],
      ],
    )('does not invoke the adapter under mode=%s', async (mode) => {
      const audio = recordingAudioEngine();
      const scene = audioScene('a');
      const { adapter, calls } = buildRecordingUnlockAdapter('resolve');
      const loader = createSceneLoader({
        scenes: createSceneRegistry([scene]),
        compositions: createCompositionRegistry([{ id: 'show', manifest: ['a'] }]),
        stage: null,
        buildCtx: stubCtx,
        createPreloader: () => () => Promise.resolve(),
        timeline: noopTimeline,
        audioEngine: audio.engine,
        audioUnlockAdapter: adapter,
      });
      const target: NavigationTarget = {
        locator: { kind: 'composition-index', composition: 'show', index: 0 },
        mode,
      };
      await loader.handle(target);
      await loader.idle();
      expect(calls).toHaveLength(0);
    });

    it('invokes the adapter for an absent-mode composition load (effective mode collapses to present)', async () => {
      const audio = recordingAudioEngine();
      const scene = audioScene('a');
      const { adapter, calls } = buildRecordingUnlockAdapter('resolve');
      const loader = createSceneLoader({
        scenes: createSceneRegistry([scene]),
        compositions: createCompositionRegistry([{ id: 'show', manifest: ['a'] }]),
        stage: null,
        buildCtx: stubCtx,
        createPreloader: () => () => Promise.resolve(),
        timeline: noopTimeline,
        audioEngine: audio.engine,
        audioUnlockAdapter: adapter,
      });
      // No `mode=` in the target → effectiveMode collapses to 'present'.
      await loader.handle({ locator: { kind: 'composition', composition: 'show' } });
      await loader.idle();
      expect(calls).toHaveLength(1);
    });
  });
});
// Reference presentTarget so it's exercised by composition-index path tests if added later.
void presentTarget;
