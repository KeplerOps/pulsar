// PUL-F014 — composition audio bed, end to end.
//
// Composes the real boot + navigation subsystems for a bed-carrying
// composition: the runtime validation pass (`validateRuntime`) accepts
// the bed at boot, the composition registry stores and freezes it, and
// the scene loader plays it looping underneath a composition navigation
// — but suppresses it under `mode=standalone`, where the scene runs as
// if no surrounding composition existed. This is the PUL-F014 audio-bed
// contract exercised through the full navigation path, not a single
// subsystem in isolation.

import { describe, expect, it } from 'vitest';
import type { AudioEngine, AudioSoundConfig, AudioSoundHandle } from '../../src/runtime/audio';
import { validateRuntime } from '../../src/runtime/validation';
import {
  type NavigationTarget,
  buildScene,
  createCompositionRegistry,
  createSceneLoader,
  createSceneRegistry,
  noopTimeline,
  stubCtx,
} from '../runtime/scene-loader.helpers';

const BED_SRC = '/audio/room-tone.webm';

interface RecordingEngine {
  readonly engine: AudioEngine;
  readonly created: AudioSoundConfig[];
  readonly looped: boolean[];
}

/** Engine fake that records every sound built and every loop toggle. */
const recordingEngine = (): RecordingEngine => {
  const created: AudioSoundConfig[] = [];
  const looped: boolean[] = [];
  let muted = false;
  return {
    created,
    looped,
    engine: {
      createSound(config) {
        created.push(config);
        const handle: AudioSoundHandle = {
          play: () => 1,
          stop: () => undefined,
          fade: () => undefined,
          loop: (enabled) => {
            looped.push(enabled);
          },
          volume: () => undefined,
          rate: () => undefined,
          unload: () => undefined,
        };
        return handle;
      },
      setMasterMute: (value) => {
        muted = value;
      },
      isMasterMuted: () => muted,
      unlock: () => Promise.resolve(),
    },
  };
};

const bedComposition = () =>
  createCompositionRegistry([
    { id: 'keynote', manifest: ['opener'], audioBed: { src: BED_SRC, volume: 0.4 } },
  ]);

describe('PUL-F014 — composition audio bed (end-to-end)', () => {
  it('the runtime validation pass accepts a composition that declares an audio bed', () => {
    const findings = validateRuntime({
      scenes: [buildScene({ id: 'opener' })],
      compositions: [
        { id: 'keynote', manifest: ['opener'], audioBed: { src: BED_SRC, volume: 0.4 } },
      ],
    });
    expect(findings).toEqual([]);
  });

  it('plays the composition audio bed looping for a composition navigation', async () => {
    const audio = recordingEngine();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([buildScene({ id: 'opener' })]),
      compositions: bedComposition(),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: noopTimeline,
      audioEngine: audio.engine,
    });
    await loader.handle({ locator: { kind: 'composition', composition: 'keynote' } });
    await loader.idle();
    // The bed is the one sound the navigation built, and it loops.
    expect(audio.created.map((config) => config.src)).toEqual([[BED_SRC]]);
    expect(audio.looped).toContain(true);
  });

  it('suppresses the composition audio bed under mode=standalone', async () => {
    const audio = recordingEngine();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([buildScene({ id: 'opener' })]),
      compositions: bedComposition(),
      stage: null,
      buildCtx: stubCtx,
      createPreloader: () => () => Promise.resolve(),
      timeline: noopTimeline,
      audioEngine: audio.engine,
    });
    const target: NavigationTarget = {
      locator: { kind: 'composition', composition: 'keynote' },
      mode: 'standalone',
    };
    await loader.handle(target);
    await loader.idle();
    // PUL-F014: standalone runs the scene as if no surrounding
    // composition existed — the audio bed never plays.
    expect(audio.created).toEqual([]);
  });
});
