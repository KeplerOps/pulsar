// Pulsar L2 — timing-helper behavioral coverage.
//
// `helpers.test.ts` already exercises the core aSleep / holdUntilAdvance
// resolution paths. This file covers the surfaces that file leaves
// untested and that ship as the authoring primitive set:
//
//  - schedule: the callback fires after the delay, cancel() suppresses it,
//    and cancel() is idempotent.
//  - holdUntilAdvance: a non-advance command does not release the hold.
//
// Every assertion checks OBSERVABLE behavior (a callback firing or being
// suppressed; a subscription torn down on release). Real timers throughout.

import { describe, expect, it, vi } from 'vitest';
import { holdUntilAdvance, schedule } from '../../src/system/helpers/timing';
import { createControllerFake as makeController } from '../support/fakes';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
