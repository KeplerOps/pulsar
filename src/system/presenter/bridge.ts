// Pulsar L2 presenter — cross-window command bridge.
//
// Same-origin windows (the present window + a popped-out prompter
// window) share a `BroadcastChannel('pulsar-presenter')` so a keystroke
// in either drives the same `PresenterController`. The bridge is
// symmetric: each window subscribes for inbound commands AND emits
// local keyboard events outbound, but a window does NOT re-broadcast
// commands it received over the channel (no echo loop).
//
// Use `combinePresenterSources` to merge multiple sources (keyboard +
// bridge.source) into one source the loader can subscribe to.

import {
  type PresenterCommand,
  type PresenterCommandSource,
  isPresenterCommand,
} from '../../runtime/presenter';

/** Default channel name used by every pulsar workbench. */
export const DEFAULT_PRESENTER_CHANNEL = 'pulsar-presenter';

export interface PresenterBridgeOptions {
  /** Channel name. Defaults to {@link DEFAULT_PRESENTER_CHANNEL}. */
  readonly channelName?: string;
  /** Optional sink for non-fatal errors (bad message, channel close). */
  readonly onError?: (err: unknown) => void;
}

export interface PresenterBridgeHandle {
  /**
   * Command source: emits every {@link PresenterCommand} received from
   * other windows on the channel. Pass to `combinePresenterSources` to
   * feed into the loader alongside the local keyboard source.
   */
  readonly source: PresenterCommandSource;
  /** Broadcast a command to every other window listening on the channel. */
  send(cmd: PresenterCommand): void;
  /** Close the channel and detach every subscriber. Idempotent. */
  dispose(): void;
}

/**
 * Create a `BroadcastChannel`-backed bridge between same-origin
 * pulsar workbench windows. Inert in environments without
 * `BroadcastChannel` (older browsers, Node tests): `send` becomes a
 * no-op and `source` emits nothing.
 */
export const createPresenterBridge = (
  options: PresenterBridgeOptions = {},
): PresenterBridgeHandle => {
  const channelName = options.channelName ?? DEFAULT_PRESENTER_CHANNEL;
  const handlers = new Set<(cmd: PresenterCommand) => void>();
  let disposed = false;
  // Guard for older runtimes / SSR / Node tests.
  const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  const ch = typeof BC === 'function' ? new BC(channelName) : null;
  if (ch !== null) {
    ch.onmessage = (event) => {
      const data = (event as MessageEvent<unknown>).data;
      if (!isPresenterCommand(data)) return;
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          options.onError?.(err);
        }
      }
    };
  }
  return {
    source: {
      subscribe(handler) {
        if (disposed) return () => {};
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    },
    send(cmd) {
      if (disposed || ch === null) return;
      try {
        ch.postMessage(cmd);
      } catch (err) {
        options.onError?.(err);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      handlers.clear();
      ch?.close();
    },
  };
};

/**
 * Compose multiple {@link PresenterCommandSource}s into a single
 * source that fans out subscriptions across all of them. Useful for
 * threading both the keyboard source and a cross-window bridge into
 * the loader's single `presenterCommands` slot.
 */
export const combinePresenterSources = (
  ...sources: readonly PresenterCommandSource[]
): PresenterCommandSource => ({
  subscribe(handler) {
    const unsubs = sources.map((s) => s.subscribe(handler));
    return () => {
      for (const u of unsubs) u();
    };
  },
});
