// Tests for the runtime audio service — PUL-F024 / ADR-004.
//
// Coverage map (requirement clauses):
//  - C1 "the runtime SHALL provide an audio service": `createAudioService`.
//  - C2 "per-scene playback": `load` registers a sound, `play` / `stop`
//    drive it; the service is per-navigation (signal-bound `stopAll`).
//  - C3 "fades": `fade`.
//  - C4 "sprites": `SoundDefinition.sprite` + `play({ sprite })`.
//  - C5 "looping": `play({ loop: true })`.
//  - C6 "named groups": `play({ group })` + `stopGroup` (kebab-only,
//    audio routing/cleanup scope — not a scene/composition/timeline id).
//  - ADR-004 extras: master mute (`mute` / `isMuted`, persistent on the
//    engine), runtime-guaranteed cleanup (signal abort ⇒ `stopAll`),
//    screenshot/paused suppression (`silent`).
//
// The Howler boundary is exercised separately (`audio-engine.test.ts`);
// here the engine is a deterministic in-process fake so every code
// path of the service is asserted without a browser audio context.

import { afterEach, describe, expect, it } from 'vitest';
import {
  type AudioCueLogEntry,
  type AudioCueLogStopGroup,
  type AudioEngine,
  AudioError,
  AudioGroupError,
  AudioRangeError,
  type AudioSoundConfig,
  AudioSoundError,
  type AudioSoundHandle,
  AudioSourceError,
  type SoundDefinition,
  createAudioService,
  noopAudioEngine,
} from '../../src/runtime/audio';

/* -------------------------------------------------------------------- *
 *  Fake engine — records every call so tests can assert delegation.
 * -------------------------------------------------------------------- */

interface HandleCall {
  readonly sound: string;
  readonly method: 'play' | 'stop' | 'fade' | 'loop' | 'volume' | 'rate' | 'unload';
  readonly args: readonly unknown[];
}

interface FakeEngine {
  readonly engine: AudioEngine;
  readonly created: AudioSoundConfig[];
  readonly calls: HandleCall[];
  /** Invoke the recorded `onError` for the most recently created sound (or by index). */
  emitError(err: unknown, soundIndex?: number): void;
  masterMuted(): boolean;
}

const fakeEngine = (): FakeEngine => {
  const created: AudioSoundConfig[] = [];
  const calls: HandleCall[] = [];
  let masterMuted = false;
  let playCounter = 0;
  return {
    created,
    calls,
    emitError(err, soundIndex) {
      const idx = soundIndex ?? created.length - 1;
      const cfg = created[idx];
      if (cfg === undefined) throw new Error(`no sound created at index ${idx}`);
      cfg.onError(err);
    },
    masterMuted: () => masterMuted,
    engine: {
      createSound(config) {
        const id = `sound#${created.length}`;
        created.push(config);
        const record =
          (method: HandleCall['method']) =>
          (...args: unknown[]): void => {
            calls.push({ sound: id, method, args });
          };
        const handle: AudioSoundHandle = {
          play: (sprite) => {
            calls.push({ sound: id, method: 'play', args: [sprite] });
            return ++playCounter;
          },
          stop: record('stop'),
          fade: record('fade'),
          loop: record('loop'),
          volume: record('volume'),
          rate: record('rate'),
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

const liveSignal = (): AbortSignal => new AbortController().signal;

const buildService = (overrides: Partial<Parameters<typeof createAudioService>[1]> = {}) => {
  const fake = fakeEngine();
  const controller = new AbortController();
  const service = createAudioService(fake.engine, {
    signal: controller.signal,
    ...overrides,
  });
  return { fake, controller, service };
};

/* -------------------------------------------------------------------- *
 *  Registration — `load`
 * -------------------------------------------------------------------- */

describe('createAudioService — load (C2 register a sound)', () => {
  it('registers a sound and forwards its sources to the engine', () => {
    const { fake, service } = buildService();
    service.load('stinger', { src: '/audio/stinger.mp3' });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]?.src).toEqual(['/audio/stinger.mp3']);
    expect(fake.created[0]?.muted).toBe(false);
  });

  it('accepts an array of source URLs (codec preference order)', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: ['/audio/bed.webm', '/audio/bed.mp3'] });
    expect(fake.created[0]?.src).toEqual(['/audio/bed.webm', '/audio/bed.mp3']);
  });

  it('forwards sprite definitions to the engine', () => {
    const { fake, service } = buildService();
    service.load('fx', {
      src: '/audio/fx.webm',
      sprite: { laugh: [0, 1000], cheer: [1500, 2000], hum: [3000, 1000, true] },
    });
    expect(fake.created[0]?.sprite).toEqual({
      laugh: [0, 1000],
      cheer: [1500, 2000],
      hum: [3000, 1000, true],
    });
  });

  it('validates sprite definitions at the runtime boundary', () => {
    const { service } = buildService();
    // A JS-authored scene can pass garbage here; build it through a
    // double-cast so the test exercises the runtime guard.
    const withSprite = (id: string, sprite: unknown): SoundDefinition =>
      ({ src: `/${id}.webm`, sprite }) as unknown as SoundDefinition;
    // Malformed shape: not an object / wrong tuple length / empty name.
    expect(() => service.load('a', withSprite('a', 'oops'))).toThrow(AudioSoundError);
    expect(() => service.load('b', withSprite('b', { x: [0] }))).toThrow(AudioSoundError);
    expect(() => service.load('c', withSprite('c', { x: [0, 1, 2, 3] }))).toThrow(AudioSoundError);
    expect(() => service.load('d', { src: '/d.webm', sprite: { '': [0, 100] } })).toThrow(
      AudioSoundError,
    );
    // Out-of-range offsets / durations.
    expect(() => service.load('e', { src: '/e.webm', sprite: { x: [-1, 100] } })).toThrow(
      AudioRangeError,
    );
    expect(() =>
      service.load('f', { src: '/f.webm', sprite: { x: [0, Number.POSITIVE_INFINITY] } }),
    ).toThrow(AudioRangeError);
    // Non-boolean loop flag.
    expect(() => service.load('g', withSprite('g', { x: [0, 100, 'yes'] }))).toThrow(
      AudioSoundError,
    );
  });

  it('rejects a non-kebab sound id with AudioSoundError', () => {
    const { service } = buildService();
    expect(() => service.load('Stinger', { src: '/a.mp3' })).toThrow(AudioSoundError);
    expect(() => service.load('two words', { src: '/a.mp3' })).toThrow(AudioSoundError);
    expect(() => service.load('', { src: '/a.mp3' })).toThrow(AudioSoundError);
  });

  it('validates the SoundDefinition payload shape at the runtime boundary', () => {
    const { service } = buildService();
    // A plain-JS scene can pass garbage where TypeScript would catch
    // the error; the service throws the documented audio-error family.
    const passDef =
      (id: string, def: unknown): (() => void) =>
      () =>
        service.load(id, def as unknown as SoundDefinition);
    expect(passDef('a', null)).toThrow(AudioSoundError);
    expect(passDef('b', 'not-an-object')).toThrow(AudioSoundError);
    expect(passDef('c', {})).toThrow(AudioSourceError); // missing src
    expect(passDef('d', { src: 42 })).toThrow(AudioSourceError); // src wrong type
    expect(passDef('e', { src: { not: 'array' } })).toThrow(AudioSourceError); // src wrong type
  });

  it('rejects re-registering an id with a different definition', () => {
    const { service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(() => service.load('bed', { src: '/audio/bed2.mp3' })).toThrow(AudioSoundError);
    service.load('fx', { src: '/audio/fx.webm', sprite: { laugh: [0, 1000] } });
    expect(() =>
      service.load('fx', { src: '/audio/fx.webm', sprite: { laugh: [0, 999] } }),
    ).toThrow(AudioSoundError);
  });

  it('is idempotent when re-registering an id with the same definition (shared SFX)', () => {
    const { fake, service } = buildService();
    service.load('whoosh', { src: ['/audio/whoosh.webm', '/audio/whoosh.mp3'] });
    service.load('whoosh', { src: ['/audio/whoosh.webm', '/audio/whoosh.mp3'] });
    service.load('fx', {
      src: '/audio/fx.webm',
      sprite: { hit: [0, 100], cheer: [200, 300, true] },
    });
    service.load('fx', {
      src: '/audio/fx.webm',
      sprite: { hit: [0, 100], cheer: [200, 300, true] },
    });
    expect(fake.created).toHaveLength(2); // one per distinct id, not per call
    expect(() => service.play('whoosh')).not.toThrow();
    expect(() => service.play('fx', { sprite: 'hit' })).not.toThrow();
  });

  it('rejects an empty source list', () => {
    const { service } = buildService();
    expect(() => service.load('bed', { src: [] })).toThrow(AudioSourceError);
  });

  it('rejects an empty / non-string source URL', () => {
    const { service } = buildService();
    expect(() => service.load('a', { src: '' })).toThrow(AudioSourceError);
    expect(() => service.load('b', { src: ['/ok.mp3', ''] })).toThrow(AudioSourceError);
  });

  it('rejects a disallowed source scheme when no slice allowlist is supplied', () => {
    const { service } = buildService();
    expect(() => service.load('bed', { src: 'file:///etc/passwd.mp3' })).toThrow(AudioSourceError);
    expect(() => service.load('bed', { src: '//cdn.example.com/bed.mp3' })).toThrow(
      AudioSourceError,
    );
  });

  it('allows http(s) / data / blob and relative source URLs', () => {
    const { service } = buildService();
    expect(() => service.load('a', { src: 'https://cdn.example.com/a.mp3' })).not.toThrow();
    expect(() => service.load('b', { src: '/audio/b.mp3' })).not.toThrow();
    expect(() => service.load('c', { src: 'audio/c.mp3' })).not.toThrow();
    expect(() => service.load('d', { src: 'data:audio/wav;base64,AAAA' })).not.toThrow();
  });

  describe('allowedSources — PUL-F030 / ADR-029 (audio is declared in scene.audio)', () => {
    it('rejects a source not in allowedSources', () => {
      const { service } = buildService({ allowedSources: ['/audio/bed.mp3'] });
      expect(() => service.load('bed', { src: '/audio/bed.mp3' })).not.toThrow();
      expect(() => service.load('typo', { src: '/audio/typo.mp3' })).toThrow(AudioSourceError);
    });

    it('rejects when one URL of a multi-source sound is undeclared', () => {
      const { service } = buildService({ allowedSources: ['/audio/bed.webm'] });
      expect(() => service.load('bed', { src: ['/audio/bed.webm', '/audio/bed.mp3'] })).toThrow(
        AudioSourceError,
      );
    });

    it('still applies the default scheme allowlist even when in allowedSources (defense-in-depth)', () => {
      // A weak / no-op preloader could declare a non-default-scheme URL
      // in `scene.audio`; audio refuses it regardless because the
      // audio service runs its own scheme check on top of membership.
      const { service } = buildService({ allowedSources: ['file:///etc/passwd.mp3'] });
      expect(() => service.load('x', { src: 'file:///etc/passwd.mp3' })).toThrow(AudioSourceError);
    });

    it('skips the membership check when allowedSources is omitted', () => {
      const { service } = buildService();
      expect(() => service.load('anything', { src: '/whatever.mp3' })).not.toThrow();
    });
  });

  it('builds every sound audible by default (outputPolicy: audible)', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(fake.created[0]?.muted).toBe(false);
  });

  it('builds every sound muted when outputPolicy is silent', () => {
    const { fake, service } = buildService({ outputPolicy: 'silent' });
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(fake.created[0]?.muted).toBe(true);
  });

  it('builds every sound muted when outputPolicy is log-cues (rehearsal)', () => {
    const { fake, service } = buildService({ outputPolicy: 'log-cues' });
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(fake.created[0]?.muted).toBe(true);
  });

  it("routes a sound's async load/play error through onError (non-fatal)", () => {
    const seen: unknown[] = [];
    const { fake, service } = buildService({ onError: (err) => seen.push(err) });
    service.load('bed', { src: '/audio/bed.mp3' });
    fake.emitError(new Error('decode failed'));
    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toContain('audio sound "bed"');
    expect(String(seen[0])).toContain('decode failed');
  });

  it('suppresses a sound error that arrives after the service is disposed', () => {
    const seen: unknown[] = [];
    const { fake, service } = buildService({ onError: (err) => seen.push(err) });
    service.load('bed', { src: '/audio/bed.mp3' });
    service.stopAll();
    fake.emitError(new Error('late decode failure')); // arrives after the navigation ended
    expect(seen).toEqual([]);
  });

  it('does not let a throwing onError sink escape through the async callback', () => {
    const { fake, service } = buildService({
      onError: () => {
        throw new Error('logger blew up');
      },
    });
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(() => fake.emitError(new Error('decode failed'))).not.toThrow();
  });
});

/* -------------------------------------------------------------------- *
 *  Playback — `play`
 * -------------------------------------------------------------------- */

describe('createAudioService — play (C2 playback, C4 sprites, C5 looping)', () => {
  it('plays a registered sound', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed');
    expect(fake.calls).toContainEqual({ sound: 'sound#0', method: 'play', args: [undefined] });
  });

  it('rejects playing an unregistered sound', () => {
    const { service } = buildService();
    expect(() => service.play('ghost')).toThrow(AudioSoundError);
  });

  it('rejects playing with a non-kebab sound id', () => {
    const { service } = buildService();
    expect(() => service.play('Bad Id')).toThrow(AudioSoundError);
  });

  it('plays a named sprite (C4)', () => {
    const { fake, service } = buildService();
    service.load('fx', { src: '/audio/fx.webm', sprite: { laugh: [0, 1000] } });
    service.play('fx', { sprite: 'laugh' });
    expect(fake.calls).toContainEqual({ sound: 'sound#0', method: 'play', args: ['laugh'] });
  });

  it('rejects an unknown sprite name', () => {
    const { service } = buildService();
    service.load('fx', { src: '/audio/fx.webm', sprite: { laugh: [0, 1000] } });
    expect(() => service.play('fx', { sprite: 'sob' })).toThrow(AudioSoundError);
  });

  it('rejects any sprite name on a sound with no sprites', () => {
    const { service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(() => service.play('bed', { sprite: 'laugh' })).toThrow(AudioSoundError);
  });

  it('sets the loop flag on the play instance when loop is requested (C5)', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed', { loop: true });
    const loopCall = fake.calls.find((c) => c.method === 'loop');
    expect(loopCall).toBeDefined();
    expect(loopCall?.args[0]).toBe(true);
    // loop is keyed to the playId play() returned
    expect(loopCall?.args[1]).toBe(1);
  });

  it('does not set loop when loop is absent or false', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed');
    service.play('bed', { loop: false });
    expect(fake.calls.some((c) => c.method === 'loop')).toBe(false);
  });

  it('applies a per-play rate override to the play instance', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed', { rate: 1.25 });
    const rateCall = fake.calls.find((c) => c.method === 'rate');
    expect(rateCall).toBeDefined();
    expect(rateCall?.args[0]).toBe(1.25);
    expect(rateCall?.args[1]).toBe(1);
  });

  it('does not set rate when absent', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed');
    expect(fake.calls.some((c) => c.method === 'rate')).toBe(false);
  });

  it('rejects a non-numeric rate', () => {
    const { service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(() => service.play('bed', { rate: 'fast' as unknown as number })).toThrow(
      AudioRangeError,
    );
  });

  it('rejects a non-positive rate', () => {
    const { service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(() => service.play('bed', { rate: 0 })).toThrow(AudioRangeError);
    expect(() => service.play('bed', { rate: -0.5 })).toThrow(AudioRangeError);
  });

  it('applies a per-play volume override to the play instance', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed', { volume: 0.25 });
    expect(fake.calls).toContainEqual({ sound: 'sound#0', method: 'volume', args: [0.25, 1] });
  });

  it('rejects an out-of-range per-play volume', () => {
    const { service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(() => service.play('bed', { volume: -0.1 })).toThrow(AudioRangeError);
    expect(() => service.play('bed', { volume: 1.5 })).toThrow(AudioRangeError);
    expect(() => service.play('bed', { volume: Number.NaN })).toThrow(AudioRangeError);
  });

  it('validates the PlayOptions payload shape at the runtime boundary', () => {
    const { service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    const passOpts =
      (opts: unknown): (() => void) =>
      () =>
        service.play('bed', opts as Parameters<typeof service.play>[1]);
    expect(passOpts('not-an-object')).toThrow(AudioSoundError);
    expect(passOpts({ sprite: 42 })).toThrow(AudioSoundError);
    expect(passOpts({ loop: 'true' })).toThrow(AudioSoundError);
    expect(passOpts({ group: 99 })).toThrow(AudioGroupError);
    expect(passOpts({ volume: 'loud' })).toThrow(AudioRangeError);
  });
});

/* -------------------------------------------------------------------- *
 *  Fades — `fade`
 * -------------------------------------------------------------------- */

describe('createAudioService — fade (C3)', () => {
  it('fades a registered sound through the engine', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.fade('bed', 0.8, 0.15, 1200);
    expect(fake.calls).toContainEqual({
      sound: 'sound#0',
      method: 'fade',
      args: [0.8, 0.15, 1200],
    });
  });

  it('rejects fading an unregistered sound', () => {
    const { service } = buildService();
    expect(() => service.fade('ghost', 1, 0, 100)).toThrow(AudioSoundError);
  });

  it('rejects out-of-range fade endpoints', () => {
    const { service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(() => service.fade('bed', 1.2, 0, 100)).toThrow(AudioRangeError);
    expect(() => service.fade('bed', 1, -0.5, 100)).toThrow(AudioRangeError);
  });

  it('rejects a negative or non-finite fade duration', () => {
    const { service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(() => service.fade('bed', 1, 0, -10)).toThrow(AudioRangeError);
    expect(() => service.fade('bed', 1, 0, Number.POSITIVE_INFINITY)).toThrow(AudioRangeError);
  });
});

/* -------------------------------------------------------------------- *
 *  stop / stopGroup — named groups (C6)
 * -------------------------------------------------------------------- */

describe('createAudioService — stop / stopGroup (C6 named groups)', () => {
  it('stops every instance of a sound via stop()', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed');
    service.stop('bed');
    expect(fake.calls).toContainEqual({ sound: 'sound#0', method: 'stop', args: [] });
  });

  it('rejects stopping an unregistered sound', () => {
    const { service } = buildService();
    expect(() => service.stop('ghost')).toThrow(AudioSoundError);
  });

  it('rejects a non-kebab group name on play and on stopGroup', () => {
    const { service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(() => service.play('bed', { group: 'Scene A' })).toThrow(AudioGroupError);
    expect(() => service.stopGroup('Scene A')).toThrow(AudioGroupError);
  });

  it('stopGroup stops only the play instances tagged with that group', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.load('stinger', { src: '/audio/stinger.mp3' });
    service.play('bed', { group: 'scene-a' }); // playId 1
    service.play('stinger', { group: 'scene-a' }); // playId 2
    service.play('bed', { group: 'scene-b' }); // playId 3
    service.play('bed'); // playId 4 — ungrouped
    fake.calls.length = 0;
    service.stopGroup('scene-a');
    expect(fake.calls).toEqual([
      { sound: 'sound#0', method: 'stop', args: [1] },
      { sound: 'sound#1', method: 'stop', args: [2] },
    ]);
  });

  it('stopGroup on an unknown or already-emptied group is a no-op', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed', { group: 'scene-a' });
    service.stopGroup('scene-a');
    fake.calls.length = 0;
    expect(() => service.stopGroup('scene-a')).not.toThrow();
    expect(() => service.stopGroup('never-used')).not.toThrow();
    expect(fake.calls).toEqual([]);
  });
});

/* -------------------------------------------------------------------- *
 *  Master mute — ADR-004
 * -------------------------------------------------------------------- */

describe('createAudioService — master mute (ADR-004)', () => {
  it('delegates mute / isMuted to the engine', () => {
    const { fake, service } = buildService();
    expect(service.isMuted()).toBe(false);
    service.mute(true);
    expect(fake.masterMuted()).toBe(true);
    expect(service.isMuted()).toBe(true);
    service.mute(false);
    expect(service.isMuted()).toBe(false);
  });

  it('rejects a non-boolean mute argument at the runtime boundary', () => {
    const { service } = buildService();
    const muteUnchecked = service.mute as (value: unknown) => void;
    expect(() => muteUnchecked('on')).toThrow(AudioError);
    expect(() => muteUnchecked(1)).toThrow(AudioError);
    expect(() => muteUnchecked(undefined)).toThrow(AudioError);
  });

  it('persists master mute across services backed by the same engine', () => {
    const fake = fakeEngine();
    const a = createAudioService(fake.engine, { signal: liveSignal() });
    a.mute(true);
    const b = createAudioService(fake.engine, { signal: liveSignal() });
    expect(b.isMuted()).toBe(true);
  });

  it('stopAll does not reset master mute (it is persistent runtime state)', () => {
    const { service } = buildService();
    service.mute(true);
    service.stopAll();
    expect(service.isMuted()).toBe(true);
  });

  /* ---------------------------------------------------------------- *
   *  PUL-Q010 — master mute responsiveness (≤ 100 ms)
   *
   *  PUL-Q010 statement: "Master mute SHALL silence active audio
   *  playback within 100 milliseconds of being engaged."
   *
   *  The audio-service boundary is one leg of the runtime latency
   *  path the loader-owned `'toggle-master-mute'` handler walks
   *  (see `scene-loader-present.test.ts` PUL-Q010 block for the
   *  end-to-end test). At THIS layer the bound translates to two
   *  structural invariants that any regression toward async work
   *  (debounce / queueMicrotask / setTimeout / fade-to-silence)
   *  would break:
   *
   *  (1) `engine.setMasterMute(...)` is invoked SYNCHRONOUSLY on
   *      the same call stack as `AudioService.mute(...)`. No
   *      microtask gap, no scheduler hop, no fade interpolation.
   *  (2) The invocation happens regardless of whether playback is
   *      currently active — silencing an already-playing sound is
   *      delegated to the engine's master-mute mechanism rather
   *      than to per-sound iteration or fade scheduling.
   * ---------------------------------------------------------------- */

  it('PUL-Q010 — engine.setMasterMute is invoked synchronously from AudioService.mute (no microtask hop)', () => {
    // The 100 ms bound collapses to "synchronous" at this layer
    // because a single synchronous call costs sub-millisecond on
    // any realistic V8. The only way to blow the bound here is to
    // defer the engine call — `queueMicrotask`, `Promise.resolve()
    // .then`, `setTimeout(..., 0)`, debounce, fade scheduling, etc.
    // This test pins the synchronous contract by checking the
    // engine's mute state on the very next statement after the
    // service call (no `await`, no `await Promise.resolve()`).
    const { fake, service } = buildService();
    expect(fake.masterMuted()).toBe(false);
    service.mute(true);
    // No await between these two lines — a microtask-deferred
    // implementation would see `false` here.
    expect(fake.masterMuted()).toBe(true);
    service.mute(false);
    expect(fake.masterMuted()).toBe(false);
  });

  it('PUL-Q010 — engine.setMasterMute is invoked synchronously even while sounds are loaded and playing', () => {
    // Pins the "active audio playback" clause: silencing an
    // already-playing sound is delegated to the engine's master
    // mute, not to iterating the registered sounds. A regression
    // that re-implemented mute as `for (const sound of sounds)
    // sound.handle.<stop|fade|volume|loop|unload>()` (or similar
    // per-sound work) would silently break the engine-state
    // contract — and the next `play()` after un-muting would no
    // longer be inhibited by the engine, because the per-sound
    // mute would be a snapshot rather than persistent runtime
    // state. The assertion below snapshots the entire handle-call
    // record before `mute(...)` and asserts that mute adds NO
    // handle-level calls (codex review cycle 1: a `stop`-only
    // filter would miss `fade` / `volume` / `loop` / `unload`
    // regressions on the mute path).
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed');
    service.load('stinger', { src: '/audio/stinger.mp3' });
    service.play('stinger');
    expect(fake.masterMuted()).toBe(false);
    const handleCallsBeforeMute = fake.calls.length;
    service.mute(true);
    expect(fake.masterMuted()).toBe(true);
    // `mute(...)` MUST NOT add any per-sound handle calls — the
    // path is purely engine-level. Any new entry in `fake.calls`
    // (`stop` / `fade` / `volume` / `loop` / `unload`) would mean
    // mute is iterating registered sounds.
    expect(fake.calls.length).toBe(handleCallsBeforeMute);
  });
});

/* -------------------------------------------------------------------- *
 *  Lifecycle — stopAll + signal binding (ADR-004 runtime cleanup)
 * -------------------------------------------------------------------- */

describe('createAudioService — lifecycle / cleanup (ADR-004)', () => {
  it('stopAll stops and unloads every registered sound and clears groups', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.load('stinger', { src: '/audio/stinger.mp3' });
    service.play('bed', { group: 'scene-a' });
    fake.calls.length = 0;
    service.stopAll();
    expect(service.isDisposed()).toBe(true);
    expect(fake.calls).toEqual([
      { sound: 'sound#0', method: 'stop', args: [] },
      { sound: 'sound#0', method: 'unload', args: [] },
      { sound: 'sound#1', method: 'stop', args: [] },
      { sound: 'sound#1', method: 'unload', args: [] },
    ]);
  });

  it('stopAll is idempotent', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.stopAll();
    fake.calls.length = 0;
    service.stopAll();
    expect(fake.calls).toEqual([]);
  });

  it('mutating methods are inert after dispose; introspectors still work', () => {
    const { fake, service } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.stopAll();
    fake.calls.length = 0;
    // None of these throw and none reach the engine.
    service.load('late', { src: '/x.mp3' });
    service.play('bed');
    service.fade('bed', 1, 0, 10);
    service.stop('bed');
    service.stopGroup('scene-a');
    service.mute(true);
    expect(fake.calls).toEqual([]);
    expect(fake.created).toHaveLength(1);
    expect(service.isDisposed()).toBe(true);
  });

  it('aborting the navigation signal disposes the service (stopAll)', () => {
    const { service, controller } = buildService();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed', { loop: true });
    expect(service.isDisposed()).toBe(false);
    controller.abort();
    expect(service.isDisposed()).toBe(true);
  });

  it('an already-aborted signal disposes the service immediately', () => {
    const fake = fakeEngine();
    const controller = new AbortController();
    controller.abort();
    const service = createAudioService(fake.engine, { signal: controller.signal });
    expect(service.isDisposed()).toBe(true);
  });

  it('isolates per-item failures in stopAll: every sound is still torn down', () => {
    const seen: unknown[] = [];
    const fake = fakeEngine();
    // Inject a throwing handle for sound#0; sound#1 stays well-behaved.
    const original = fake.engine.createSound;
    let firstSoundCreated = false;
    fake.engine.createSound = ((config) => {
      const handle = original.call(fake.engine, config);
      if (!firstSoundCreated) {
        firstSoundCreated = true;
        return {
          ...handle,
          stop: () => {
            throw new Error('stop kaboom');
          },
          unload: () => {
            throw new Error('unload kaboom');
          },
        };
      }
      return handle;
    }) as typeof fake.engine.createSound;
    const service = createAudioService(fake.engine, {
      signal: new AbortController().signal,
      onError: (err) => seen.push(err),
    });
    service.load('a', { src: '/audio/a.mp3' });
    service.load('b', { src: '/audio/b.mp3' });
    expect(() => service.stopAll()).not.toThrow();
    expect(service.isDisposed()).toBe(true);
    // sound#1 (`b`) still got stop+unload despite sound#0 (`a`) throwing.
    expect(fake.calls).toContainEqual({ sound: 'sound#1', method: 'stop', args: [] });
    expect(fake.calls).toContainEqual({ sound: 'sound#1', method: 'unload', args: [] });
    // The two failures from sound#0 routed through onError (non-fatal).
    expect(seen).toHaveLength(2);
    expect(String(seen[0])).toContain('stop kaboom');
    expect(String(seen[1])).toContain('unload kaboom');
  });

  it('isolates per-play failures in stopGroup: every play in the group is still stopped', () => {
    const seen: unknown[] = [];
    const fake = fakeEngine();
    const original = fake.engine.createSound;
    let playCount = 0;
    let throwingPlayId: number | null = null;
    fake.engine.createSound = ((config) => {
      const handle = original.call(fake.engine, config);
      return {
        ...handle,
        play: (sprite) => {
          playCount += 1;
          const id = handle.play(sprite);
          if (playCount === 2) throwingPlayId = id;
          return id;
        },
        stop: (playId) => {
          if (playId === throwingPlayId) {
            throw new Error('per-play stop kaboom');
          }
          handle.stop(playId);
        },
      };
    }) as typeof fake.engine.createSound;
    const service = createAudioService(fake.engine, {
      signal: new AbortController().signal,
      onError: (err) => seen.push(err),
    });
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed', { group: 'g' }); // playId 1, well-behaved
    service.play('bed', { group: 'g' }); // playId 2, throws on stop
    expect(() => service.stopGroup('g')).not.toThrow();
    // The first play's stop went through; the second's threw and was
    // routed through onError. Both calls were attempted (per-play
    // isolation), and the recording engine recorded the first stop.
    expect(fake.calls).toContainEqual({ sound: 'sound#0', method: 'stop', args: [1] });
    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toContain('per-play stop kaboom');
  });
});

/* -------------------------------------------------------------------- *
 *  noopAudioEngine — the silent fallback
 * -------------------------------------------------------------------- */

describe('noopAudioEngine', () => {
  // `noopAudioEngine` is a module-level singleton with mutable
  // `masterMuted` state. Sharing it across tests in the same
  // Vitest worker creates the same leak `scene-loader-present.test.ts`
  // documents and avoids with its own `freshAudioEngine` helper.
  // Test-quality review (issue #49 cycle 1) flagged the singleton
  // hazard here. The `afterEach` below resets the singleton so any
  // test that flips `mute(true)` on the noop engine and bails
  // before unsetting it does not corrupt the baseline for later
  // tests that observe `isMasterMuted()`.
  afterEach(() => {
    noopAudioEngine.setMasterMute(false);
  });

  it('produces handles whose methods do not throw, back a working service, and dispose cleanly', () => {
    // Pre-fix: pure `not.toThrow()`. Post-fix: assert
    // `isDisposed()` precondition and postcondition so a regression
    // that broke `stopAll()`'s dispose flag (or that disposed the
    // service early) surfaces here (test-quality review, issue #49
    // cycle 1).
    const service = createAudioService(noopAudioEngine, { signal: liveSignal() });
    expect(service.isDisposed()).toBe(false);
    service.load('bed', { src: '/audio/bed.mp3', sprite: { hit: [0, 100] } });
    expect(() => {
      service.play('bed', { sprite: 'hit', loop: true, volume: 0.5, group: 'scene-a' });
      service.fade('bed', 1, 0, 50);
      service.stopGroup('scene-a');
      service.stop('bed');
      service.stopAll();
    }).not.toThrow();
    expect(service.isDisposed()).toBe(true);
  });

  it('round-trips master mute', () => {
    const service = createAudioService(noopAudioEngine, { signal: liveSignal() });
    // The `afterEach` above resets the singleton, so the baseline
    // here is always `false` regardless of prior-test mute state.
    expect(service.isMuted()).toBe(false);
    service.mute(true);
    expect(service.isMuted()).toBe(true);
    service.mute(false);
    expect(service.isMuted()).toBe(false);
  });
});

/* -------------------------------------------------------------------- *
 *  Output policy `log-cues` — PUL-F026 / ADR-004 rehearsal mode
 *
 *  The cue log is the runtime-visible half of "audio is silenced or
 *  logged as cues" (PUL-F026). Engine sounds are still constructed
 *  muted (the `silent` parity check lives above), and every ACCEPTED
 *  audio operation (post-validation, post-engine-call) emits a
 *  semantic `AudioCueLogEntry` to `onCue`. Entries carry sound id,
 *  sprite, group, volume, loop, fade endpoints, operation, and a
 *  monotonic sequence — NO source URLs, Howler handles, raw scene
 *  objects, or asset paths (preflight: "log semantic ids only").
 *  `load` and `mute` are NOT cues; validation throws never emit;
 *  post-dispose calls never emit; a throwing sink is swallowed.
 * -------------------------------------------------------------------- */

describe('createAudioService — outputPolicy log-cues (PUL-F026 / ADR-004)', () => {
  const buildLogCues = (
    options: Partial<Parameters<typeof createAudioService>[1]> = {},
  ): {
    fake: FakeEngine;
    controller: AbortController;
    service: ReturnType<typeof createAudioService>;
    cues: AudioCueLogEntry[];
  } => {
    const cues: AudioCueLogEntry[] = [];
    const fake = fakeEngine();
    const controller = new AbortController();
    const service = createAudioService(fake.engine, {
      signal: controller.signal,
      outputPolicy: 'log-cues',
      onCue: (entry) => cues.push(entry),
      ...options,
    });
    return { fake, controller, service, cues };
  };

  it('emits a cue entry for an accepted play (sound id, monotonic sequence)', () => {
    const { service, cues } = buildLogCues();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed');
    expect(cues).toHaveLength(1);
    const cue = cues[0];
    expect(cue?.operation).toBe('play');
    if (cue?.operation === 'play') {
      expect(cue.soundId).toBe('bed');
      expect(cue.sequence).toBe(1);
    }
  });

  it('captures sprite, group, volume, and loop on the play cue', () => {
    const { service, cues } = buildLogCues();
    service.load('fx', { src: '/audio/fx.webm', sprite: { laugh: [0, 1000] } });
    service.play('fx', { sprite: 'laugh', group: 'scene-a', volume: 0.5, loop: true });
    expect(cues).toEqual([
      {
        sequence: 1,
        operation: 'play',
        soundId: 'fx',
        sprite: 'laugh',
        group: 'scene-a',
        volume: 0.5,
        loop: true,
      },
    ]);
  });

  it('omits optional fields from the play cue when not supplied', () => {
    const { service, cues } = buildLogCues();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed');
    const cue = cues[0];
    expect(cue?.operation).toBe('play');
    if (cue?.operation !== 'play') return;
    expect(cue.sprite).toBeUndefined();
    expect(cue.group).toBeUndefined();
    expect(cue.volume).toBeUndefined();
    expect(cue.loop).toBeUndefined();
  });

  it('emits a fade cue with from / to / durationMs', () => {
    const { service, cues } = buildLogCues();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.fade('bed', 0.8, 0.15, 1200);
    expect(cues).toEqual([
      {
        sequence: 1,
        operation: 'fade',
        soundId: 'bed',
        fade: { from: 0.8, to: 0.15, durationMs: 1200 },
      },
    ]);
  });

  it('emits a stop cue with sound id', () => {
    const { service, cues } = buildLogCues();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed');
    service.stop('bed');
    const stops = cues.filter((c) => c.operation === 'stop');
    expect(stops).toEqual([{ sequence: 2, operation: 'stop', soundId: 'bed' }]);
  });

  it('emits a stop-group cue with group only (no sound id)', () => {
    const { service, cues } = buildLogCues();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed', { group: 'scene-a' });
    service.stopGroup('scene-a');
    const groupStops = cues.filter((c): c is AudioCueLogStopGroup => c.operation === 'stop-group');
    expect(groupStops).toEqual([{ sequence: 2, operation: 'stop-group', group: 'scene-a' }]);
    // The discriminated-union type already guarantees `soundId` is
    // absent on `stop-group` cues — assert at runtime too.
    const entry = groupStops[0];
    expect(entry).toBeDefined();
    expect(entry !== undefined && 'soundId' in entry).toBe(false);
  });

  it('emits a stop-group cue even when the group has no plays (audible call vs effect)', () => {
    const { service, cues } = buildLogCues();
    service.stopGroup('scene-a');
    expect(cues).toEqual([{ sequence: 1, operation: 'stop-group', group: 'scene-a' }]);
  });

  it('does NOT emit cues for load (registration is not a cue)', () => {
    const { service, cues } = buildLogCues();
    service.load('bed', { src: '/audio/bed.mp3', sprite: { hit: [0, 100] } });
    service.load('whoosh', { src: ['/audio/whoosh.webm', '/audio/whoosh.mp3'] });
    expect(cues).toEqual([]);
  });

  it('does NOT emit cues for master mute (engine state, not a cue)', () => {
    const { service, cues } = buildLogCues();
    service.mute(true);
    service.mute(false);
    expect(cues).toEqual([]);
  });

  it('does NOT emit a cue when validation rejects an operation', () => {
    const { service, cues } = buildLogCues();
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(() => service.play('ghost')).toThrow(AudioSoundError);
    expect(() => service.play('bed', { volume: 5 })).toThrow(AudioRangeError);
    expect(() => service.fade('bed', -0.1, 1, 100)).toThrow(AudioRangeError);
    expect(() => service.stop('ghost')).toThrow(AudioSoundError);
    expect(() => service.stopGroup('Bad Group')).toThrow(AudioGroupError);
    expect(cues).toEqual([]);
  });

  it('sequence is monotonic across operations', () => {
    const { service, cues } = buildLogCues();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed', { group: 'scene-a' });
    service.fade('bed', 1, 0, 100);
    service.stop('bed');
    service.stopGroup('scene-a');
    expect(cues.map((c) => c.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('never includes source URLs in cue entries', () => {
    const { service, cues } = buildLogCues();
    service.load('bed', { src: '/audio/super-secret-asset.mp3' });
    service.play('bed', { group: 'scene-a' });
    service.fade('bed', 1, 0, 100);
    service.stop('bed');
    service.stopGroup('scene-a');
    const blob = JSON.stringify(cues);
    expect(blob).not.toContain('super-secret-asset.mp3');
    expect(blob).not.toContain('/audio/');
    expect(blob).not.toContain('mp3');
  });

  it('does NOT emit cues after the service is disposed', () => {
    const { service, controller, cues } = buildLogCues();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed');
    cues.length = 0;
    controller.abort();
    service.play('bed');
    service.fade('bed', 1, 0, 100);
    service.stop('bed');
    service.stopGroup('scene-a');
    expect(cues).toEqual([]);
  });

  it('does not let a throwing onCue sink escape through play / fade / stop / stopGroup', () => {
    const fake = fakeEngine();
    const service = createAudioService(fake.engine, {
      signal: liveSignal(),
      outputPolicy: 'log-cues',
      onCue: () => {
        throw new Error('cue sink blew up');
      },
    });
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(() => service.play('bed', { group: 'g' })).not.toThrow();
    expect(() => service.fade('bed', 1, 0, 100)).not.toThrow();
    expect(() => service.stop('bed')).not.toThrow();
    expect(() => service.stopGroup('g')).not.toThrow();
  });

  it('emits cues only under outputPolicy log-cues (not silent, not audible)', () => {
    for (const policy of ['audible', 'silent'] as const) {
      const cues: AudioCueLogEntry[] = [];
      const fake = fakeEngine();
      const service = createAudioService(fake.engine, {
        signal: liveSignal(),
        outputPolicy: policy,
        onCue: (e) => cues.push(e),
      });
      service.load('bed', { src: '/audio/bed.mp3' });
      service.play('bed');
      service.fade('bed', 1, 0, 100);
      service.stop('bed');
      expect(cues).toEqual([]);
    }
  });

  it('log-cues without an onCue sink still mutes audio (silent rehearsal)', () => {
    const fake = fakeEngine();
    const service = createAudioService(fake.engine, {
      signal: liveSignal(),
      outputPolicy: 'log-cues',
      // onCue intentionally omitted — workbench has not wired a cue UI
    });
    service.load('bed', { src: '/audio/bed.mp3' });
    expect(fake.created[0]?.muted).toBe(true);
    expect(() => service.play('bed')).not.toThrow();
  });

  it('cue entries are frozen so consumers cannot mutate them in place', () => {
    const { service, cues } = buildLogCues();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed');
    expect(Object.isFrozen(cues[0])).toBe(true);
  });

  it('fade cues are deep-frozen — nested fade payload is also immutable', () => {
    const { service, cues } = buildLogCues();
    service.load('bed', { src: '/audio/bed.mp3' });
    service.fade('bed', 1, 0, 100);
    const cue = cues[0];
    expect(cue?.operation).toBe('fade');
    if (cue?.operation !== 'fade') return;
    expect(Object.isFrozen(cue.fade)).toBe(true);
  });

  it('emits the stop-group cue AFTER the engine stop loop and bookkeeping delete', () => {
    // Contract parity with `play` / `fade` / `stop`: a cue is published
    // only after the state transition it represents. A consumer must
    // not observe a stop-group cue before its grouped handles have
    // been stopped.
    const fake = fakeEngine();
    const cues: AudioCueLogEntry[] = [];
    let stoppedPlays = 0;
    const original = fake.engine.createSound;
    fake.engine.createSound = ((config) => {
      const handle = original.call(fake.engine, config);
      return {
        ...handle,
        stop: (playId) => {
          stoppedPlays += 1;
          handle.stop(playId);
        },
      };
    }) as typeof fake.engine.createSound;
    const service = createAudioService(fake.engine, {
      signal: liveSignal(),
      outputPolicy: 'log-cues',
      onCue: (entry) => {
        if (entry.operation === 'stop-group') {
          // Observed at cue-emit time: every play in the group has
          // already been stopped (the engine `stop()` calls ran
          // before the cue published).
          expect(stoppedPlays).toBe(2);
        }
        cues.push(entry);
      },
    });
    service.load('bed', { src: '/audio/bed.mp3' });
    service.play('bed', { group: 'scene-a' });
    service.play('bed', { group: 'scene-a' });
    service.stopGroup('scene-a');
    expect(cues.map((c) => c.operation)).toEqual(['play', 'play', 'stop-group']);
  });
});

describe('createAudioService — legacy silent option rejection (codex review, cycle 3)', () => {
  type Opts = Parameters<typeof createAudioService>[1];

  it('rejects the legacy `silent: true` key loudly instead of failing open to audible playback', () => {
    // The previous public option was `silent?: boolean`; PUL-F026
    // replaces it with the general `outputPolicy` union. A JS caller
    // that still passes `{ silent: true }` would have the key silently
    // ignored and produce AUDIBLE playback — the worst migration
    // failure for an audio-suppression option. The boundary throws
    // `AudioError` instead.
    const fake = fakeEngine();
    const buildWithSilent =
      (silentValue: unknown): (() => void) =>
      () => {
        const opts = { signal: liveSignal(), silent: silentValue } as unknown as Opts;
        createAudioService(fake.engine, opts);
      };
    expect(buildWithSilent(true)).toThrow(AudioError);
    expect(buildWithSilent(false)).toThrow(AudioError);
    expect(buildWithSilent(undefined)).toThrow(AudioError);
  });
});

describe('createAudioService — outputPolicy runtime validation', () => {
  type Opts = Parameters<typeof createAudioService>[1];
  // Cast the bad value through `unknown` and into the parameter type
  // so the test exercises the runtime guard (a plain-JS / direct
  // caller can supply garbage that the literal-typed union would
  // not).
  const buildBadPolicy =
    (fake: FakeEngine, policy: unknown): (() => void) =>
    () => {
      const opts = { signal: liveSignal(), outputPolicy: policy } as unknown as Opts;
      createAudioService(fake.engine, opts);
    };

  it('rejects an unknown outputPolicy value at construction', () => {
    const fake = fakeEngine();
    expect(buildBadPolicy(fake, 'log-cue')).toThrow(AudioError);
    expect(buildBadPolicy(fake, 'SILENT')).toThrow(AudioError);
    expect(buildBadPolicy(fake, '')).toThrow(AudioError);
    expect(buildBadPolicy(fake, true)).toThrow(AudioError);
    expect(buildBadPolicy(fake, null)).toThrow(AudioError);
  });

  it('does NOT throw a TypeError on values JSON.stringify cannot encode (codex review, cycle 2)', () => {
    // A plain-JS caller passing `1n` or a Symbol used to surface as a
    // `TypeError` from `JSON.stringify` inside the audio-error
    // construction itself — the documented `AudioError` envelope
    // never reached the loader's rollback path. The safe describer
    // turns these into a typeof+String rendering so the construction
    // throws `AudioError` instead.
    const fake = fakeEngine();
    expect(buildBadPolicy(fake, 1n)).toThrow(AudioError);
    expect(buildBadPolicy(fake, 1n)).not.toThrow(TypeError);
    expect(buildBadPolicy(fake, Symbol('x'))).toThrow(AudioError);
    expect(buildBadPolicy(fake, Symbol('x'))).not.toThrow(TypeError);
  });

  it('accepts each of the three valid policies', () => {
    const fake = fakeEngine();
    for (const policy of ['audible', 'silent', 'log-cues'] as const) {
      expect(() =>
        createAudioService(fake.engine, { signal: liveSignal(), outputPolicy: policy }),
      ).not.toThrow();
    }
  });
});

describe('createAudioService — onCue runtime validation (codex review, cycle 2)', () => {
  type Opts = Parameters<typeof createAudioService>[1];
  const buildBadOnCue =
    (fake: FakeEngine, onCue: unknown): (() => void) =>
    () => {
      const opts = {
        signal: liveSignal(),
        outputPolicy: 'log-cues' as const,
        onCue,
      } as unknown as Opts;
      createAudioService(fake.engine, opts);
    };

  it('rejects a non-function onCue at construction so misconfiguration fails loud', () => {
    const fake = fakeEngine();
    // A plain-JS caller or a misconfigured loader could pass garbage
    // here; without boundary validation, the misuse would be silently
    // swallowed inside the non-fatal `emitCue` try/catch and rehearsal
    // would see an empty cue stream.
    expect(buildBadOnCue(fake, true)).toThrow(AudioError);
    expect(buildBadOnCue(fake, 42)).toThrow(AudioError);
    expect(buildBadOnCue(fake, {})).toThrow(AudioError);
    expect(buildBadOnCue(fake, 'cue-log')).toThrow(AudioError);
    expect(buildBadOnCue(fake, null)).toThrow(AudioError);
  });

  it('accepts an omitted onCue (workbench without a cue UI)', () => {
    const fake = fakeEngine();
    expect(() =>
      createAudioService(fake.engine, {
        signal: liveSignal(),
        outputPolicy: 'log-cues',
      }),
    ).not.toThrow();
  });
});
