// Pulsar L2 — terminal-template audio integration tests.
//
// `playScript` (the script-playback worker inside `terminal.ts`)
// requires a real DOM (`document.body`, `<pre>` children) and is not
// reachable from the Node-environment vitest harness. The audio
// integration lives behind a small standalone helper
// (`startTerminalAudio`) so the load / play / fade-out closure
// contract can be unit-tested directly against a mock `AudioService`.

import { describe, expect, it, vi } from 'vitest';
import type { AudioService, PlayOptions, SoundDefinition } from '../../src/runtime/audio';
import { type TerminalAudio, startTerminalAudio, terminal } from '../../src/system/templates';

interface AudioCall {
  readonly kind: 'load' | 'play' | 'fade' | 'stop';
  readonly args: readonly unknown[];
}

const buildMockAudio = (
  overrides: { isDisposed?: boolean } = {},
): { service: AudioService; calls: AudioCall[] } => {
  const calls: AudioCall[] = [];
  const service: AudioService = {
    load: (soundId: string, def: SoundDefinition) => {
      calls.push({ kind: 'load', args: [soundId, def] });
    },
    play: (soundId: string, opts?: PlayOptions) => {
      calls.push({ kind: 'play', args: [soundId, opts] });
    },
    fade: (soundId: string, from: number, to: number, durationMs: number) => {
      calls.push({ kind: 'fade', args: [soundId, from, to, durationMs] });
    },
    stop: (soundId: string) => {
      calls.push({ kind: 'stop', args: [soundId] });
    },
    stopGroup: () => undefined,
    mute: () => undefined,
    isMuted: () => false,
    stopAll: () => undefined,
    isDisposed: () => overrides.isDisposed ?? false,
  };
  return { service, calls };
};

describe('terminal — audio integration', () => {
  it('startTerminalAudio loads + plays the sound with defaults (volume 0.7, no rate)', () => {
    const { service, calls } = buildMockAudio();
    const config: TerminalAudio = {
      src: '/audio/bed.mp3',
      soundId: 'terminal-bed',
    };
    const fadeOut = startTerminalAudio(service, config);
    expect(typeof fadeOut).toBe('function');
    expect(calls).toEqual([
      { kind: 'load', args: ['terminal-bed', { src: ['/audio/bed.mp3'] }] },
      { kind: 'play', args: ['terminal-bed', { volume: 0.7 }] },
    ]);
  });

  it('startTerminalAudio honors volume + rate overrides', () => {
    const { service, calls } = buildMockAudio();
    const config: TerminalAudio = {
      src: '/audio/bed.mp3',
      soundId: 'terminal-bed',
      volume: 0.85,
      rate: 1.25,
    };
    startTerminalAudio(service, config);
    expect(calls[1]).toEqual({
      kind: 'play',
      args: ['terminal-bed', { volume: 0.85, rate: 1.25 }],
    });
  });

  it('returned fadeOut closure calls audio.fade(from, 0, durationMs) and schedules stop', () => {
    vi.useFakeTimers();
    try {
      const { service, calls } = buildMockAudio();
      const config: TerminalAudio = {
        src: '/audio/bed.mp3',
        soundId: 'terminal-bed',
        volume: 0.6,
        fadeOutMs: 800,
      };
      const fadeOut = startTerminalAudio(service, config);
      calls.length = 0; // ignore load/play
      fadeOut();
      expect(calls).toEqual([{ kind: 'fade', args: ['terminal-bed', 0.6, 0, 800] }]);
      // fadeAndStop schedules a stop after durationMs + 50.
      vi.advanceTimersByTime(900);
      expect(calls).toEqual([
        { kind: 'fade', args: ['terminal-bed', 0.6, 0, 800] },
        { kind: 'stop', args: ['terminal-bed'] },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returned fadeOut closure uses default fade duration (1200ms) when fadeOutMs omitted', () => {
    vi.useFakeTimers();
    try {
      const { service, calls } = buildMockAudio();
      const fadeOut = startTerminalAudio(service, {
        src: '/audio/bed.mp3',
        soundId: 'terminal-bed',
      });
      calls.length = 0;
      fadeOut();
      vi.advanceTimersByTime(1300);
      expect(calls).toEqual([
        { kind: 'fade', args: ['terminal-bed', 0.7, 0, 1200] },
        { kind: 'stop', args: ['terminal-bed'] },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('startTerminalAudio is a no-op when audio is undefined', () => {
    const config: TerminalAudio = {
      src: '/audio/bed.mp3',
      soundId: 'terminal-bed',
    };
    const fadeOut = startTerminalAudio(undefined, config);
    expect(typeof fadeOut).toBe('function');
    // The fadeOut closure routes through fadeAndStop, which also no-ops
    // when audio is undefined (no throw).
    expect(() => fadeOut()).not.toThrow();
  });

  it('startTerminalAudio is a no-op when audio service is disposed', () => {
    const { service, calls } = buildMockAudio({ isDisposed: true });
    startTerminalAudio(service, {
      src: '/audio/bed.mp3',
      soundId: 'terminal-bed',
    });
    expect(calls).toEqual([]);
  });

  it('terminal factory declares the audio src in scene.assets and scene.audio when audio is set', () => {
    const scene = terminal('term-with-audio', {
      script: [{ t: 'user', text: 'ls' }],
      audio: {
        src: '/audio/bed.mp3',
        soundId: 'terminal-bed',
      },
    });
    expect(scene.assets).toEqual(['/audio/bed.mp3']);
    expect(scene.audio).toEqual(['/audio/bed.mp3']);
  });

  it('terminal factory leaves scene.assets and scene.audio empty when audio is omitted', () => {
    const scene = terminal('term-no-audio', {
      script: [{ t: 'user', text: 'ls' }],
    });
    expect(scene.assets).toEqual([]);
    expect(scene.audio).toEqual([]);
  });
});
