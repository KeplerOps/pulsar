// PUL-F017 / ADR-020 — monotonic-forward audio cue gating.
//
// The requirement clause "audio cues SHALL fire only on monotonic
// forward playback" is delivered by three collaborating pieces:
//
//   - the dynamic cue gate (`createCueGate`, `src/runtime/audio.ts`):
//     the audio service suppresses an accepted cue's output while the
//     gate is closed;
//   - the GSAP timeline adapter (`src/runtime/timeline.ts`): under the
//     scrub run mode it toggles that gate by playhead direction —
//     `play()` opens it, `pause()` / `reverse()` close it;
//   - the loader, which wires the same gate into both.
//
// This file is the end-to-end proof: a real audio service over a
// recording engine, a real GSAP scene timeline whose `.call()` cue at
// master time T invokes `ctx.audio.play(...)`, composed under the scrub
// run mode. It asserts the cue fires when the playhead crosses T
// monotonically forward and does NOT fire when the playhead crosses T
// backward under reverse playback.

import { describe, expect, it } from 'vitest';
import {
  type AudioEngine,
  type AudioSoundHandle,
  createAudioService,
  createCueGate,
} from '../../src/runtime/audio';
import type { SceneTimelineSegment } from '../../src/runtime/composition-resolver';
import {
  type MasterTimeline,
  createGsapCompositionTimeline,
  createTimelineEngine,
} from '../../src/runtime/timeline';

const engine = createTimelineEngine();
const { gsap } = engine;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Pump the event loop until `pred` holds or the iteration budget runs out. */
const pumpUntil = async (pred: () => boolean, limit = 400): Promise<void> => {
  for (let i = 0; i < limit && !pred(); i += 1) await flush();
};

/** A recording audio engine — counts every `play()` that reaches it. */
const recordingEngine = (): { engine: AudioEngine; plays: () => number } => {
  let plays = 0;
  const handle: AudioSoundHandle = {
    play: () => {
      plays += 1;
      return plays;
    },
    stop: () => undefined,
    fade: () => undefined,
    loop: () => undefined,
    volume: () => undefined,
    rate: () => undefined,
    unload: () => undefined,
  };
  return {
    plays: () => plays,
    engine: {
      createSound: () => handle,
      setMasterMute: () => undefined,
      isMasterMuted: () => false,
      unlock: () => Promise.resolve(),
    },
  };
};

describe('PUL-F017 — monotonic-forward audio cue gating', () => {
  it('fires a cue on a forward crossing of its master time and suppresses it on a reverse crossing', async () => {
    const nav = new AbortController();
    const audioEngine = recordingEngine();
    // One gate shared by the audio service (which reads it) and the
    // timeline adapter (which toggles it) — exactly the wiring the
    // scene loader builds for `mode=scrub`.
    const gate = createCueGate(false);
    const audio = createAudioService(audioEngine.engine, {
      signal: nav.signal,
      cueGate: gate,
    });
    audio.load('cue', { src: '/cue.webm' });

    // A 0.4s scene timeline with an audio cue authored at t=0.2 via a
    // GSAP `.call()` — the canonical way a scene fires `ctx.audio`.
    const sceneTimeline = gsap.timeline({ paused: true });
    sceneTimeline.to({ v: 0 }, { v: 1, duration: 0.4, ease: 'none' });
    sceneTimeline.call(
      () => {
        audio.play('cue');
      },
      [],
      0.2,
    );
    const segments: SceneTimelineSegment[] = [{ id: 'scene-a', timeline: sceneTimeline }];

    let master: MasterTimeline | null = null;
    const adapter = createGsapCompositionTimeline({
      engine,
      onMaster: (m) => {
        master = m;
      },
    });
    const settled = adapter.run(segments, {
      signal: nav.signal,
      headCueGate: 'monotonic-forward',
      audioCueGate: gate,
    });
    await flush();
    const tl = master as unknown as MasterTimeline;
    expect(tl).not.toBeNull();
    // Scrub run mode: held at frame 0, gate closed.
    expect(tl.isPaused()).toBe(true);
    expect(audioEngine.plays()).toBe(0);

    // Monotonic forward playback across t=0.2 — the cue fires.
    tl.play();
    await pumpUntil(() => tl.time() >= 0.35);
    expect(audioEngine.plays()).toBe(1);

    // Reverse playback from the end back across t=0.2 — the cue is
    // suppressed: `reverse()` closed the gate, so the audio service
    // accepts the cue call but produces no output.
    tl.seek(0.4);
    tl.reverse();
    await pumpUntil(() => tl.time() <= 0.05);
    expect(audioEngine.plays()).toBe(1);

    // Forward again — the gate re-opens, the cue fires once more.
    tl.seek(0);
    tl.play();
    await pumpUntil(() => tl.time() >= 0.35);
    expect(audioEngine.plays()).toBe(2);

    nav.abort();
    await settled;
  });
});
