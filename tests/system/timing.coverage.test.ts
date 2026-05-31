// Pulsar L2 — timing-helper behavioral coverage.
//
// `helpers.test.ts` already exercises the core aSleep / holdUntilAdvance
// resolution paths. This file covers the surfaces that file leaves
// untested and that ship as the authoring primitive set:
//
//  - addAdvanceGate: the default-name label, the explicit-`name` prefixed
//    label, the explicit-`time` placement, and the no-duration() branch.
//    Most importantly, the AUTHORED gate is verified to behave: a real
//    GSAP master composed from a child carrying the gate actually pauses
//    at the gate's master-time and holds there, then resumes past it.
//  - runLoopUntilCleanup: the undefined-gsap inert handle, the build /
//    play path (the loop runs at repeat:-1), and idempotent stop().
//  - schedule: the callback fires after the delay, cancel() suppresses it,
//    and cancel() is idempotent.
//
// Every assertion checks OBSERVABLE behavior (label names + times on a
// real timeline, a real master's playhead pausing/resuming, a callback
// firing or being suppressed). Real timers throughout — GSAP's ticker
// runs on real time, so fake timers would freeze the master.

import { gsap } from 'gsap';
import { describe, expect, it, vi } from 'vitest';
import {
  ADVANCE_GATE_LABEL,
  ADVANCE_GATE_PREFIX,
  composeMasterTimeline,
  createTimelineEngine,
} from '../../src/runtime/timeline';
import {
  addAdvanceGate,
  holdUntilAdvance,
  runLoopUntilCleanup,
  schedule,
} from '../../src/system/helpers/timing';
import { createControllerFake as makeController } from '../support/fakes';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('addAdvanceGate — label authoring', () => {
  it('writes the default gate label at the timeline duration', () => {
    const tl = gsap.timeline({ paused: true });
    tl.to({ x: 0 }, { x: 1, duration: 1 });
    expect(tl.duration()).toBeCloseTo(1, 5);

    addAdvanceGate(tl);

    // The label exists, under the canonical name, at the current end.
    expect(Object.hasOwn(tl.labels, ADVANCE_GATE_LABEL)).toBe(true);
    expect(tl.labels[ADVANCE_GATE_LABEL]).toBeCloseTo(1, 5);
    // No stray prefixed label was authored for the default case.
    const prefixed = Object.keys(tl.labels).filter((n) => n.startsWith(ADVANCE_GATE_PREFIX));
    expect(prefixed).toEqual([]);
    tl.kill();
  });

  it('writes a uniquely-named gate label when `name` is supplied', () => {
    const tl = gsap.timeline({ paused: true });
    tl.to({ x: 0 }, { x: 1, duration: 0.5 });

    addAdvanceGate(tl, { name: 'reveal' });

    const expected = `${ADVANCE_GATE_PREFIX}reveal`;
    expect(Object.hasOwn(tl.labels, expected)).toBe(true);
    expect(tl.labels[expected]).toBeCloseTo(0.5, 5);
    // The bare default label is NOT written when a name is given.
    expect(Object.hasOwn(tl.labels, ADVANCE_GATE_LABEL)).toBe(false);
    tl.kill();
  });

  it('places the gate at an explicit `time` rather than the duration', () => {
    const tl = gsap.timeline({ paused: true });
    tl.to({ x: 0 }, { x: 1, duration: 2 });

    addAdvanceGate(tl, { name: 'mid', time: 0.75 });

    const expected = `${ADVANCE_GATE_PREFIX}mid`;
    // Authored at 0.75 — NOT the 2s duration the default branch would use.
    expect(tl.labels[expected]).toBeCloseTo(0.75, 5);
    tl.kill();
  });

  it('allows two distinct named gates on one timeline', () => {
    const tl = gsap.timeline({ paused: true });
    tl.to({ x: 0 }, { x: 1, duration: 1 });
    addAdvanceGate(tl, { name: 'first', time: 0.25 });
    addAdvanceGate(tl, { name: 'second', time: 0.9 });

    expect(tl.labels[`${ADVANCE_GATE_PREFIX}first`]).toBeCloseTo(0.25, 5);
    expect(tl.labels[`${ADVANCE_GATE_PREFIX}second`]).toBeCloseTo(0.9, 5);
    tl.kill();
  });

  it('addLabel receives no time when the timeline reports no duration()', () => {
    // A minimal timeline stub without a `duration()` method exercises the
    // `at === undefined` branch: addLabel is called with the label only.
    const calls: Array<{ name: string; time: number | undefined }> = [];
    const stub = {
      addLabel(name: string, time?: number): unknown {
        calls.push({ name, time });
        return undefined;
      },
    };

    addAdvanceGate(stub);

    expect(calls).toEqual([{ name: ADVANCE_GATE_LABEL, time: undefined }]);
  });
});

describe('addAdvanceGate — the authored gate actually pauses the composed master', () => {
  it('pauses the master at the gate time and holds there, then resumes past it', async () => {
    const engine = createTimelineEngine();
    const child = gsap.timeline({ paused: true });
    // Content BEFORE the gate (0.05s) and content AFTER it (another 0.05s),
    // so a master that ignored the gate would run straight to 0.1s.
    child.to({ x: 0 }, { x: 1, duration: 0.05 });
    addAdvanceGate(child);
    child.to({ x: 1 }, { x: 2, duration: 0.05 });

    const master = composeMasterTimeline(engine, [{ id: 'scene-a', timeline: child }]);

    // The gate label is namespaced onto the master under the scene segment.
    expect(master.hasLabel(`scene-a:${ADVANCE_GATE_LABEL}`)).toBe(true);
    expect(master.duration()).toBeCloseTo(0.1, 2);

    master.play();
    // Wait well past the gate time AND past the full duration. If the gate
    // were a no-op, the playhead would be at ~0.1 and unpaused.
    await wait(200);
    expect(master.isPaused()).toBe(true);
    expect(master.time()).toBeCloseTo(0.05, 2);

    // A presenter `advance` resumes the held master (transport calls play()).
    master.play();
    await wait(200);
    expect(master.isPaused()).toBe(false);
    expect(master.time()).toBeCloseTo(0.1, 2);

    master.kill();
  });
});

describe('runLoopUntilCleanup', () => {
  it('returns an inert handle and never builds when gsap is undefined', () => {
    const build = vi.fn();
    const handle = runLoopUntilCleanup(undefined, build);

    // The builder is never invoked (no engine to build against)...
    expect(build).not.toHaveBeenCalled();
    // ...and the handle's stop() is a safe no-op, callable repeatedly.
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  it('builds the loop, plays it, and runs at repeat:-1 until stopped', async () => {
    // Capture the timeline the builder is handed so we can observe its
    // repeat config and that it is actually progressing the loop target.
    let configuredRepeat: number | undefined;
    const realTimeline = gsap.timeline.bind(gsap);
    const spy = vi.spyOn(gsap, 'timeline').mockImplementation((opts?: gsap.TimelineVars) => {
      configuredRepeat = opts?.repeat;
      return realTimeline(opts);
    });

    const target = { v: 0 };
    let built = false;
    const handle = runLoopUntilCleanup(gsap, (tl) => {
      built = true;
      tl.to(target, { v: 1, duration: 0.05 });
    });

    try {
      // The builder ran and the ambient loop was created with repeat:-1.
      expect(built).toBe(true);
      expect(configuredRepeat).toBe(-1);

      // The loop is live: the target animates away from its initial value.
      await wait(80);
      expect(target.v).toBeGreaterThan(0);

      handle.stop();
      const settled = target.v;
      // After stop() the loop is dead — the target no longer advances.
      await wait(80);
      expect(target.v).toBe(settled);

      // stop() is idempotent.
      expect(() => handle.stop()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('schedule', () => {
  it('fires the callback once after the delay', async () => {
    const cb = vi.fn();
    schedule(cb, 20);

    expect(cb).not.toHaveBeenCalled();
    await wait(60);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('cancel() suppresses a pending callback', async () => {
    const cb = vi.fn();
    const handle = schedule(cb, 40);

    handle.cancel();
    await wait(80);
    expect(cb).not.toHaveBeenCalled();
  });

  it('cancel() is idempotent and safe to call after the callback fired', async () => {
    const cb = vi.fn();
    const handle = schedule(cb, 10);

    await wait(40);
    expect(cb).toHaveBeenCalledTimes(1);
    // Cancelling after firing, and twice, must not throw or re-run anything.
    expect(() => {
      handle.cancel();
      handle.cancel();
    }).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('holdUntilAdvance — non-advance commands do not release the hold', () => {
  it('ignores a non-advance command and only resolves on a later advance', async () => {
    const { controller, emit, subscriberCount } = makeController();
    let outcome: 'advance' | 'aborted' | 'pending' = 'pending';
    const p = holdUntilAdvance(controller).then((o) => {
      outcome = o;
      return o;
    });

    // One live subscription while held.
    expect(subscriberCount()).toBe(1);

    // A non-advance command must NOT resolve the hold.
    emit({ kind: 'toggle-master-mute' });
    await wait(20);
    expect(outcome).toBe('pending');
    expect(subscriberCount()).toBe(1);

    // The advance command releases it, and the subscription is torn down.
    emit({ kind: 'advance' });
    expect(await p).toBe('advance');
    expect(subscriberCount()).toBe(0);
  });
});
