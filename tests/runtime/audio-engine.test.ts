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
  noopAudioEngine,
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

  // PUL-F030 / ADR-029: the engine's unlock operation is the
  // audio-boundary capability the loader/workbench unlock adapter
  // calls AFTER collecting a user gesture. The Howler-backed engine
  // resumes its AudioContext; the no-op engine resolves immediately.
  // Both branches must surface a Promise so the adapter can `await`
  // unlock before allowing lifecycle work to proceed.
  describe('unlock (PUL-F030 / ADR-029)', () => {
    it('resolves on the Howler-backed engine even when the context is unavailable (Node no-audio path)', async () => {
      const engine = createHowlerAudioEngine();
      await expect(engine.unlock()).resolves.toBeUndefined();
    });

    it('is idempotent across multiple invocations on the Howler engine', async () => {
      const engine = createHowlerAudioEngine();
      await expect(engine.unlock()).resolves.toBeUndefined();
      await expect(engine.unlock()).resolves.toBeUndefined();
      await expect(engine.unlock()).resolves.toBeUndefined();
    });

    // Idempotency on the Web Audio branch: a real-context fake records
    // every `resume()` call. The Node `noAudio` early-return wouldn't
    // catch a regression that breaks the Web Audio path on the second
    // invocation, so we exercise the branch directly here.
    it('calls AudioContext.resume() on every invocation when a Web Audio context exists', async () => {
      const { Howler } = await import('howler');
      const howlerHandle = Howler as unknown as {
        ctx: AudioContext | null | undefined;
        usingWebAudio: boolean | undefined;
        noAudio: boolean | undefined;
      };
      const originalCtx = howlerHandle.ctx;
      const originalUsing = howlerHandle.usingWebAudio;
      const originalNo = howlerHandle.noAudio;
      let resumeCalled = 0;
      const fakeCtx: AudioContext = {
        resume: () => {
          resumeCalled += 1;
          return Promise.resolve();
        },
      } as unknown as AudioContext;
      howlerHandle.ctx = fakeCtx;
      howlerHandle.usingWebAudio = true;
      howlerHandle.noAudio = false;
      try {
        const engine = createHowlerAudioEngine();
        await engine.unlock();
        await engine.unlock();
        await engine.unlock();
        expect(resumeCalled).toBe(3);
      } finally {
        howlerHandle.ctx = originalCtx;
        howlerHandle.usingWebAudio = originalUsing;
        howlerHandle.noAudio = originalNo;
      }
    });

    // Codex review cycle 2 (one-off "Direct Howler.ctx assignment
    // bypasses Howler setup"): the cycle-1 fix pre-set `Howler.ctx`
    // directly and skipped Howler's `_setup()`, which left
    // `Howler.masterGain` null and broke the next `new Howl()`. The
    // cycle-2 fix instead triggers Howler's OWN setup path by
    // constructing a throwaway Howl with a silent data URL during the
    // unlock call. The post-unlock contract is: `engine.createSound()`
    // works — Howler's global state is self-consistent — and `unlock()`
    // does not throw. Verified end-to-end against the real Howler
    // library (Node uses Howler's `noAudio` fallback, but the same
    // public surface is exercised end-to-end so a future regression
    // that re-introduces direct-ctx-assignment surfaces here too).
    it('triggers Howler setup so subsequent createSound() works end-to-end after unlock()', async () => {
      const engine = createHowlerAudioEngine();
      // unlock() must not throw even when Howler is in noAudio
      // fallback. The seed-Howl construction is guarded with try/catch
      // so a setup failure under restrictive environments still
      // resolves the gate cleanly.
      await expect(engine.unlock()).resolves.toBeUndefined();
      // The first-audio path the gate is meant to protect: build a
      // sound and forward methods. Must not throw — Howler's global
      // state remains self-consistent through the unlock call.
      const handle = engine.createSound({
        src: [SILENT_WAV],
        muted: false,
        onError: () => undefined,
      });
      expect(() => {
        const playId = handle.play();
        handle.stop(playId);
        handle.unload();
      }).not.toThrow();
    });

    // Cycle-3 review (class finding "Howler unlock resolves even
    // when no audio backend was unlocked") closes the fail-open
    // branches the cycle-2 fix still left behind. Under simulated
    // "Web Audio path, no ctx, Howler setup fails" the unlock now
    // REJECTS — not silently resolves — so the workbench gate
    // surfaces a navigation error and the lifecycle never starts.
    it('rejects when the Web Audio path cannot produce a usable AudioContext', async () => {
      const { Howler } = await import('howler');
      const howlerHandle = Howler as unknown as {
        ctx: AudioContext | null | undefined;
        usingWebAudio: boolean | undefined;
        noAudio: boolean | undefined;
      };
      const originalCtx = howlerHandle.ctx;
      const originalUsing = howlerHandle.usingWebAudio;
      const originalNo = howlerHandle.noAudio;
      // Simulate "browser-like: Web Audio claimed, no ctx yet".
      // Under Node, the seed-Howl construction throws (no `Audio` /
      // `AudioContext`) — the new code surfaces that as a rejection.
      howlerHandle.ctx = null;
      howlerHandle.noAudio = false;
      howlerHandle.usingWebAudio = true;
      try {
        const engine = createHowlerAudioEngine();
        await expect(engine.unlock()).rejects.toThrow(/audio unlock:/);
      } finally {
        howlerHandle.ctx = originalCtx;
        howlerHandle.usingWebAudio = originalUsing;
        howlerHandle.noAudio = originalNo;
      }
    });

    // HTML5 audio fallback path: Howler falls back to `<audio>`
    // elements when Web Audio is unavailable. HTML5 is also subject
    // to browser autoplay policy, so the gate must perform an HTML5-
    // compatible unlock. When `globalThis.Audio` exists, `unlock()`
    // plays a silent muted Audio element to satisfy the policy; when
    // it does NOT, `unlock()` rejects so the gate fails closed.
    it('exercises the HTML5 unlock path when usingWebAudio is false and globalThis.Audio is available', async () => {
      const { Howler } = await import('howler');
      const howlerHandle = Howler as unknown as {
        usingWebAudio: boolean | undefined;
        noAudio: boolean | undefined;
      };
      const globalHandle = globalThis as unknown as {
        Audio: { new (src?: string): HTMLAudioElement } | undefined;
      };
      const originalUsing = howlerHandle.usingWebAudio;
      const originalNo = howlerHandle.noAudio;
      const originalAudio = globalHandle.Audio;
      let constructedSrc: string | undefined;
      let playCalled = 0;
      let pauseCalled = 0;
      let muted = false;
      const FakeAudio: { new (src?: string): HTMLAudioElement } = new Proxy(
        class {} as unknown as { new (): HTMLAudioElement },
        {
          construct(_target, args) {
            constructedSrc = args[0] as string | undefined;
            return {
              play: () => {
                playCalled += 1;
                return Promise.resolve();
              },
              pause: () => {
                pauseCalled += 1;
              },
              get muted() {
                return muted;
              },
              set muted(value: boolean) {
                muted = value;
              },
            } as unknown as HTMLAudioElement;
          },
        },
      );
      howlerHandle.usingWebAudio = false;
      howlerHandle.noAudio = false;
      globalHandle.Audio = FakeAudio;
      try {
        const engine = createHowlerAudioEngine();
        await expect(engine.unlock()).resolves.toBeUndefined();
        expect(constructedSrc).toMatch(/^data:audio\/wav;base64,/);
        expect(playCalled).toBe(1);
        expect(pauseCalled).toBe(1);
        expect(muted).toBe(true);
      } finally {
        howlerHandle.usingWebAudio = originalUsing;
        howlerHandle.noAudio = originalNo;
        globalHandle.Audio = originalAudio;
      }
    });

    it('rejects when usingWebAudio is false and globalThis.Audio is missing', async () => {
      const { Howler } = await import('howler');
      const howlerHandle = Howler as unknown as {
        usingWebAudio: boolean | undefined;
        noAudio: boolean | undefined;
      };
      const globalHandle = globalThis as unknown as {
        Audio: { new (src?: string): HTMLAudioElement } | undefined;
      };
      const originalUsing = howlerHandle.usingWebAudio;
      const originalNo = howlerHandle.noAudio;
      const originalAudio = globalHandle.Audio;
      howlerHandle.usingWebAudio = false;
      howlerHandle.noAudio = false;
      globalHandle.Audio = undefined;
      try {
        const engine = createHowlerAudioEngine();
        await expect(engine.unlock()).rejects.toThrow(/audio unlock:.*HTML5/);
      } finally {
        howlerHandle.usingWebAudio = originalUsing;
        howlerHandle.noAudio = originalNo;
        globalHandle.Audio = originalAudio;
      }
    });

    it('resumes an already-constructed Howler AudioContext when one exists', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Howler } = await import('howler');
      const howlerHandle = Howler as unknown as {
        ctx: AudioContext | null | undefined;
        usingWebAudio: boolean | undefined;
        noAudio: boolean | undefined;
      };
      const originalCtx = howlerHandle.ctx;
      const originalUsing = howlerHandle.usingWebAudio;
      const originalNo = howlerHandle.noAudio;
      let resumeCalled = 0;
      const fakeCtx: AudioContext = {
        resume: () => {
          resumeCalled += 1;
          return Promise.resolve();
        },
      } as unknown as AudioContext;
      howlerHandle.ctx = fakeCtx;
      howlerHandle.usingWebAudio = true;
      howlerHandle.noAudio = false;
      try {
        const engine = createHowlerAudioEngine();
        await engine.unlock();
        expect(resumeCalled).toBe(1);
      } finally {
        howlerHandle.ctx = originalCtx;
        howlerHandle.usingWebAudio = originalUsing;
        howlerHandle.noAudio = originalNo;
      }
    });

    it('is a no-op when noAudio is true (Howler running with audio disabled)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Howler } = await import('howler');
      const howlerHandle = Howler as unknown as {
        ctx: AudioContext | null | undefined;
        noAudio: boolean | undefined;
      };
      const originalCtx = howlerHandle.ctx;
      const originalNo = howlerHandle.noAudio;
      let resumeCalled = 0;
      const fakeCtx: AudioContext = {
        resume: () => {
          resumeCalled += 1;
          return Promise.resolve();
        },
      } as unknown as AudioContext;
      howlerHandle.ctx = fakeCtx;
      howlerHandle.noAudio = true;
      try {
        const engine = createHowlerAudioEngine();
        await engine.unlock();
        expect(resumeCalled).toBe(0);
      } finally {
        howlerHandle.ctx = originalCtx;
        howlerHandle.noAudio = originalNo;
      }
    });
  });
});

describe('noopAudioEngine.unlock (PUL-F030 / ADR-029)', () => {
  it('resolves immediately', async () => {
    await expect(noopAudioEngine.unlock()).resolves.toBeUndefined();
  });
});
