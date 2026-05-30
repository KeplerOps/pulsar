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
  presenterChannelName,
} from '../../src/system/presenter/bridge';

// BroadcastChannel delivers messages on a macrotask; wait one out.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const advance: PresenterCommand = { kind: 'advance' };
const importFreshBridge = async (): Promise<typeof import('../../src/system/presenter/bridge')> => {
  vi.resetModules();
  return import('../../src/system/presenter/bridge');
};

describe('createPresenterBridge', () => {
  const bridges: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(b: T): T => {
    bridges.push(b);
    return b;
  };
  afterEach(() => {
    for (const b of bridges) b.dispose();
    bridges.length = 0;
    vi.unstubAllGlobals();
  });

  it('exposes the default channel name', () => {
    expect(DEFAULT_PRESENTER_CHANNEL).toBe('pulsar-presenter');
  });

  it('derives scoped channel names from the presenter session id', () => {
    expect(presenterChannelName('session-a-123456')).toBe('pulsar-presenter:session-a-123456');
  });

  it('rejects invalid presenter session ids before deriving channel names', () => {
    expect(() => presenterChannelName('short')).toThrow(
      'presenter session id must be 8-128 URL-safe characters',
    );
  });

  it('generates one ephemeral session id when no URL scope exists', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'generated-session-123456' });
    const { getPresenterSessionId } = await importFreshBridge();
    expect(getPresenterSessionId({ href: 'https://pulsar.test/?composition=demo' })).toBe(
      'generated-session-123456',
    );
    expect(getPresenterSessionId({ href: 'https://pulsar.test/?composition=other' })).toBe(
      'generated-session-123456',
    );
  });

  it('falls back to a generated session id when the bootstrap URL is unreadable', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'generated-session-abcdef' });
    const { getPresenterSessionId } = await importFreshBridge();
    const location = {
      get href(): string {
        throw new Error('bad href');
      },
    };
    expect(getPresenterSessionId(location)).toBe('generated-session-abcdef');
  });

  it('uses getRandomValues when randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set([
          0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
          0xff,
        ]);
        return bytes;
      },
    });
    const { getPresenterSessionId } = await importFreshBridge();
    expect(getPresenterSessionId({ href: 'http://red-dragon:5174/?composition=demo' })).toBe(
      '00112233445566778899aabbccddeeff',
    );
  });

  it('reports missing secure random support when no URL scope exists', async () => {
    vi.stubGlobal('crypto', {});
    const { getPresenterSessionId } = await importFreshBridge();
    expect(() => getPresenterSessionId({ href: 'https://pulsar.test/?composition=demo' })).toThrow(
      'secure random presenter session id source is unavailable: requires crypto.randomUUID or crypto.getRandomValues',
    );
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

  it('delivers commands within a session scope but not across different scopes', async () => {
    const inSessionSender = track(createPresenterBridge({ sessionId: 'session-a-123456' }));
    const inSessionReceiver = track(createPresenterBridge({ sessionId: 'session-a-123456' }));
    const otherSessionReceiver = track(createPresenterBridge({ sessionId: 'session-b-123456' }));
    const inSessionReceived: PresenterCommand[] = [];
    const otherSessionReceived: PresenterCommand[] = [];
    inSessionReceiver.source.subscribe((cmd) => inSessionReceived.push(cmd));
    otherSessionReceiver.source.subscribe((cmd) => otherSessionReceived.push(cmd));
    inSessionSender.send(advance);
    await flush();
    expect(inSessionReceived).toEqual([advance]);
    expect(otherSessionReceived).toEqual([]);
  });

  it('keeps presenter-command validation on scoped channels', async () => {
    const sessionId = 'session-a-123456';
    const scopedChannel = presenterChannelName(sessionId);
    const receiver = track(createPresenterBridge({ sessionId }));
    const received: PresenterCommand[] = [];
    receiver.source.subscribe((cmd) => received.push(cmd));
    new BroadcastChannel(scopedChannel).postMessage({ kind: 'not-a-command' });
    new BroadcastChannel(scopedChannel).postMessage({ sessionId, command: advance });
    new BroadcastChannel(scopedChannel).postMessage(advance);
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
