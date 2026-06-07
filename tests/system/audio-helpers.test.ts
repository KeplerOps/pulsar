// Pulsar L2 — audio cue authoring helpers (playCue / fadeAndStop /
// loadAndPlayCue): undefined/disposed short-circuits, happy paths, and
// fadeAndStop's fault-tolerant try/catch arms.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioService } from '../../src/runtime/audio';
import { fadeAndStop, loadAndPlayCue, playCue } from '../../src/system/helpers/audio';

type Call = readonly [string, ...unknown[]];

interface FakeAudio {
  readonly service: AudioService;
  readonly calls: Call[];
  disposed: boolean;
}

const makeAudio = (faults: { fadeThrows?: boolean; stopThrows?: boolean } = {}): FakeAudio => {
  const calls: Call[] = [];
  const fake = {
    disposed: false,
    isDisposed(): boolean {
      return fake.disposed;
    },
    load(id: string, def: unknown): void {
      calls.push(['load', id, def]);
    },
    play(id: string, opts: unknown): void {
      calls.push(['play', id, opts]);
    },
    fade(id: string, from: number, to: number, dur: number): void {
      calls.push(['fade', id, from, to, dur]);
      if (faults.fadeThrows === true) throw new Error('not loaded');
    },
    stop(id: string): void {
      calls.push(['stop', id]);
      if (faults.stopThrows === true) throw new Error('unknown id');
    },
  };
  return {
    service: fake as unknown as AudioService,
    calls,
    get disposed(): boolean {
      return fake.disposed;
    },
    set disposed(v: boolean) {
      fake.disposed = v;
    },
  };
};

const kinds = (calls: Call[]): string[] => calls.map((c) => c[0]);

describe('playCue', () => {
  it('is a no-op when audio is undefined', () => {
    expect(() => playCue(undefined, 'cue')).not.toThrow();
  });

  it('is a no-op when the service is disposed', () => {
    const audio = makeAudio();
    audio.disposed = true;
    playCue(audio.service, 'cue', { loop: true });
    expect(audio.calls).toHaveLength(0);
  });

  it('plays the cue with the given options', () => {
    const audio = makeAudio();
    playCue(audio.service, 'cold-open', { loop: true, volume: 0.68 });
    expect(audio.calls).toEqual([['play', 'cold-open', { loop: true, volume: 0.68 }]]);
  });

  it('defaults the options to an empty object', () => {
    const audio = makeAudio();
    playCue(audio.service, 'cue');
    expect(audio.calls).toEqual([['play', 'cue', {}]]);
  });
});

describe('fadeAndStop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a no-op when audio is undefined', () => {
    expect(() => fadeAndStop(undefined, 'cue', 1, 500)).not.toThrow();
  });

  it('is a no-op when the service is disposed', () => {
    const audio = makeAudio();
    audio.disposed = true;
    fadeAndStop(audio.service, 'cue', 1, 500);
    vi.advanceTimersByTime(1000);
    expect(audio.calls).toHaveLength(0);
  });

  it('fades, then stops once the post-fade timer fires', () => {
    const audio = makeAudio();
    fadeAndStop(audio.service, 'bed', 0.8, 400);
    expect(audio.calls).toEqual([['fade', 'bed', 0.8, 0, 400]]);
    vi.advanceTimersByTime(399 + 50); // < durationMs + 50
    expect(kinds(audio.calls)).toEqual(['fade']);
    vi.advanceTimersByTime(1);
    expect(audio.calls).toEqual([
      ['fade', 'bed', 0.8, 0, 400],
      ['stop', 'bed'],
    ]);
  });

  it('still schedules the stop when fade throws (sound not loaded yet)', () => {
    const audio = makeAudio({ fadeThrows: true });
    expect(() => fadeAndStop(audio.service, 'bed', 1, 200)).not.toThrow();
    vi.advanceTimersByTime(250);
    expect(kinds(audio.calls)).toEqual(['fade', 'stop']);
  });

  it('skips the stop when the service is disposed before the timer fires', () => {
    const audio = makeAudio();
    fadeAndStop(audio.service, 'bed', 1, 200);
    audio.disposed = true;
    vi.advanceTimersByTime(250);
    expect(kinds(audio.calls)).toEqual(['fade']);
  });

  it('swallows a throwing stop on an unknown id', () => {
    const audio = makeAudio({ stopThrows: true });
    fadeAndStop(audio.service, 'bed', 1, 200);
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    expect(kinds(audio.calls)).toEqual(['fade', 'stop']);
  });
});

describe('loadAndPlayCue', () => {
  it('is a no-op when audio is undefined', () => {
    expect(() => loadAndPlayCue(undefined, 'cue', { src: ['/a.mp3'] })).not.toThrow();
  });

  it('is a no-op when the service is disposed', () => {
    const audio = makeAudio();
    audio.disposed = true;
    loadAndPlayCue(audio.service, 'cue', { src: ['/a.mp3'] });
    expect(audio.calls).toHaveLength(0);
  });

  it('loads then plays the cue', () => {
    const audio = makeAudio();
    loadAndPlayCue(audio.service, 'sting', { src: ['/sting.mp3'] }, { volume: 0.5 });
    expect(audio.calls).toEqual([
      ['load', 'sting', { src: ['/sting.mp3'] }],
      ['play', 'sting', { volume: 0.5 }],
    ]);
  });
});
