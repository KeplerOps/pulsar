// Pulsar L2 presenter — cross-window command bridge tests.
//
// Exercises `createPresenterBridge` over a real Node `BroadcastChannel`
// (a same-origin window pair), the malformed-message and handler-error
// arms, `dispose` idempotency, the `BroadcastChannel`-absent inert
// fallback, and `combinePresenterSources` fan-out.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PresenterCommand, PresenterCommandSource } from '../../src/runtime/presenter';
import {
  DEFAULT_PRESENTER_CHANNEL,
  combinePresenterSources,
  createPresenterBridge,
} from '../../src/system/presenter/bridge';

// BroadcastChannel delivers messages on a macrotask; wait one out.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const advance: PresenterCommand = { kind: 'advance' };

describe('createPresenterBridge', () => {
  const bridges: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(b: T): T => {
    bridges.push(b);
    return b;
  };
  afterEach(() => {
    for (const b of bridges) b.dispose();
    bridges.length = 0;
  });

  it('exposes the default channel name', () => {
    expect(DEFAULT_PRESENTER_CHANNEL).toBe('pulsar-presenter');
  });

  it('delivers a command sent from one window to another', async () => {
    const channelName = `pulsar-test-${Math.random()}`;
    const sender = track(createPresenterBridge({ channelName }));
    const receiver = track(createPresenterBridge({ channelName }));
    const received: PresenterCommand[] = [];
    receiver.source.subscribe((cmd) => received.push(cmd));
    sender.send(advance);
    await flush();
    expect(received).toEqual([advance]);
  });

  it('does not echo a command back to the sending window', async () => {
    const channelName = `pulsar-test-${Math.random()}`;
    const sender = track(createPresenterBridge({ channelName }));
    const ownReceived: PresenterCommand[] = [];
    sender.source.subscribe((cmd) => ownReceived.push(cmd));
    sender.send(advance);
    await flush();
    expect(ownReceived).toEqual([]);
  });

  it('ignores messages that are not valid presenter commands', async () => {
    const channelName = `pulsar-test-${Math.random()}`;
    const sender = track(createPresenterBridge({ channelName }));
    const receiver = track(createPresenterBridge({ channelName }));
    const received: PresenterCommand[] = [];
    receiver.source.subscribe((cmd) => received.push(cmd));
    // Raw BroadcastChannel post bypassing `send`'s typed surface.
    new BroadcastChannel(channelName).postMessage({ kind: 'not-a-command' });
    new BroadcastChannel(channelName).postMessage('garbage');
    sender.send(advance);
    await flush();
    expect(received).toEqual([advance]);
  });

  it('routes a throwing handler to onError without losing other handlers', async () => {
    const channelName = `pulsar-test-${Math.random()}`;
    const onError = vi.fn();
    const sender = track(createPresenterBridge({ channelName }));
    const receiver = track(createPresenterBridge({ channelName, onError }));
    const good: PresenterCommand[] = [];
    receiver.source.subscribe(() => {
      throw new Error('handler boom');
    });
    receiver.source.subscribe((cmd) => good.push(cmd));
    sender.send(advance);
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(good).toEqual([advance]);
  });

  it('stops delivering after a handler unsubscribes', async () => {
    const channelName = `pulsar-test-${Math.random()}`;
    const sender = track(createPresenterBridge({ channelName }));
    const receiver = track(createPresenterBridge({ channelName }));
    const received: PresenterCommand[] = [];
    const unsubscribe = receiver.source.subscribe((cmd) => received.push(cmd));
    unsubscribe();
    sender.send(advance);
    await flush();
    expect(received).toEqual([]);
  });

  it('goes inert after dispose: send is a no-op and subscribe returns a noop', async () => {
    const channelName = `pulsar-test-${Math.random()}`;
    const sender = track(createPresenterBridge({ channelName }));
    const receiver = track(createPresenterBridge({ channelName }));
    const received: PresenterCommand[] = [];
    receiver.dispose();
    const unsubscribe = receiver.source.subscribe((cmd) => received.push(cmd));
    expect(() => unsubscribe()).not.toThrow();
    sender.dispose();
    expect(() => sender.send(advance)).not.toThrow();
    await flush();
    expect(received).toEqual([]);
    // Idempotent.
    expect(() => receiver.dispose()).not.toThrow();
  });

  it('reports a postMessage failure through onError', () => {
    const onError = vi.fn();
    const bridge = track(
      createPresenterBridge({ channelName: `pulsar-test-${Math.random()}`, onError }),
    );
    // A function value is not structured-cloneable, so `postMessage`
    // throws DataCloneError synchronously inside `send`.
    const uncloneable = { kind: 'advance', fn: () => {} } as unknown as PresenterCommand;
    expect(() => bridge.send(uncloneable)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('is inert when BroadcastChannel is unavailable', async () => {
    const original = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
    try {
      const bridge = createPresenterBridge();
      const received: PresenterCommand[] = [];
      bridge.source.subscribe((cmd) => received.push(cmd));
      expect(() => bridge.send(advance)).not.toThrow();
      await flush();
      expect(received).toEqual([]);
      expect(() => bridge.dispose()).not.toThrow();
    } finally {
      (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = original;
    }
  });
});

describe('combinePresenterSources', () => {
  const makeSource = (): {
    source: PresenterCommandSource;
    emit: (cmd: PresenterCommand) => void;
    subscriberCount: () => number;
  } => {
    const handlers = new Set<(cmd: PresenterCommand) => void>();
    return {
      source: {
        subscribe(handler) {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
      },
      emit: (cmd) => {
        for (const h of [...handlers]) h(cmd);
      },
      subscriberCount: () => handlers.size,
    };
  };

  it('fans a subscription out across every source and unsubscribes all', () => {
    const a = makeSource();
    const b = makeSource();
    const combined = combinePresenterSources(a.source, b.source);
    const received: PresenterCommand[] = [];
    const unsubscribe = combined.subscribe((cmd) => received.push(cmd));
    expect(a.subscriberCount()).toBe(1);
    expect(b.subscriberCount()).toBe(1);
    a.emit(advance);
    b.emit({ kind: 'hold' });
    expect(received).toEqual([{ kind: 'advance' }, { kind: 'hold' }]);
    unsubscribe();
    expect(a.subscriberCount()).toBe(0);
    expect(b.subscriberCount()).toBe(0);
  });
});
