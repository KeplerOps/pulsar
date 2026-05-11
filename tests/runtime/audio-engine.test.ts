// Smoke tests for the Howler-backed audio engine — PUL-F024 / ADR-004.
//
// `audio.test.ts` exercises the service against a fake engine; this file
// exercises the real Howler boundary (`createHowlerAudioEngine`) so the
// `import ... from 'howler'` path, the `Howl` construction, and the
// method forwarding are covered. Howler runs in its `noAudio` fallback
// under the `node` test environment (no `AudioContext` / `Audio`), so
// these assert "does not throw / round-trips" rather than audible
// behavior — which is the right contract for a headless environment and
// mirrors how Pulsar itself degrades when audio is unavailable.

import { describe, expect, it } from 'vitest';
import {
  type AudioSoundConfig,
  createAudioService,
  createHowlerAudioEngine,
} from '../../src/runtime/audio';

// A tiny silent WAV — valid bytes so Howler does not choke on the URL
// shape even in the no-audio path.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

const config = (over: Partial<AudioSoundConfig> = {}): AudioSoundConfig => ({
  src: [SILENT_WAV],
  muted: false,
  onError: () => undefined,
  ...over,
});

describe('createHowlerAudioEngine (Howler boundary)', () => {
  it('constructs a sound and forwards every handle method without throwing', () => {
    const engine = createHowlerAudioEngine();
    const handle = engine.createSound(config());
    expect(() => {
      const playId = handle.play();
      handle.volume(0.5, playId);
      handle.loop(true, playId);
      handle.fade(1, 0, 10, playId);
      handle.fade(0.5, 0.2, 10);
      handle.volume(0.3);
      handle.stop(playId);
      handle.stop();
      handle.unload();
    }).not.toThrow();
  });

  it('supports a muted sound and a sprite map', () => {
    const engine = createHowlerAudioEngine();
    const handle = engine.createSound(
      config({ muted: true, sprite: { hit: [0, 100], cheer: [200, 300, true] } }),
    );
    expect(() => {
      handle.play('hit');
      handle.stop();
      handle.unload();
    }).not.toThrow();
  });

  it('round-trips master mute', () => {
    const engine = createHowlerAudioEngine();
    expect(engine.isMasterMuted()).toBe(false);
    engine.setMasterMute(true);
    expect(engine.isMasterMuted()).toBe(true);
    engine.setMasterMute(false);
    expect(engine.isMasterMuted()).toBe(false);
  });

  it('drives a full AudioService end-to-end over the real engine', () => {
    const engine = createHowlerAudioEngine();
    const service = createAudioService(engine, { signal: new AbortController().signal });
    expect(() => {
      service.load('bed', { src: SILENT_WAV });
      service.play('bed', { loop: true, volume: 0.4, group: 'scene-a' });
      service.fade('bed', 0.4, 0, 20);
      service.stopGroup('scene-a');
      service.mute(true);
      service.stopAll();
    }).not.toThrow();
    expect(service.isDisposed()).toBe(true);
  });
});
