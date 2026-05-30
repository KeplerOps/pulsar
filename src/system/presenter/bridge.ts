// Pulsar L2 presenter — cross-window command bridge.
//
// Same-origin windows in one workbench session (the present window + a
// popped-out prompter window) share a scoped presenter BroadcastChannel
// so a keystroke in either drives the same `PresenterController`. The
// bridge is symmetric: each window subscribes for inbound commands AND
// emits local keyboard events outbound, but a window does NOT re-
// broadcast commands it received over the channel (no echo loop).
//
// Use `combinePresenterSources` to merge multiple sources (keyboard +
// bridge.source) into one source the loader can subscribe to.

import {
  type PresenterCommand,
  type PresenterCommandSource,
  isPresenterCommand,
} from '../../runtime/presenter';

/** Base channel prefix; runtime bridges append a per-session scope. */
export const DEFAULT_PRESENTER_CHANNEL = 'pulsar-presenter';
export const PRESENTER_SESSION_QUERY_PARAM = 'pulsar-presenter-session';

const PRESENTER_SESSION_ID_FORM = /^[A-Za-z0-9_-]{8,128}$/;
let resolvedPresenterSessionId: string | null = null;

export const isPresenterSessionId = (value: string): boolean =>
  PRESENTER_SESSION_ID_FORM.test(value);

export const presenterChannelName = (sessionId: string): string => {
  if (!isPresenterSessionId(sessionId)) {
    throw new Error('presenter session id must be 8-128 URL-safe characters');
  }
  return `${DEFAULT_PRESENTER_CHANNEL}:${sessionId}`;
};

const presenterSessionIdFromLocation = (location: Pick<Location, 'href'>): string | null => {
  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return null;
  }
  const value = url.searchParams.get(PRESENTER_SESSION_QUERY_PARAM);
  if (value === null || !isPresenterSessionId(value)) return null;
  return value;
};

const createPresenterSessionId = (): string => {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  // `randomUUID()` is secure-context-only in Chromium. `getRandomValues()`
  // remains available on HTTP origins and is the correct Web Crypto source
  // for same-origin presenter channel isolation. This value never feeds
  // scene rendering or screenshot capture.
  const getRandomValues = crypto?.getRandomValues; // PUL-Q001-allow: presenter-session entropy, not scene rendering.
  if (typeof getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    getRandomValues.call(crypto, bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  throw new Error(
    'secure random presenter session id source is unavailable: requires crypto.randomUUID or crypto.getRandomValues',
  );
};

export const getPresenterSessionId = (
  location: Pick<Location, 'href'> | undefined = globalThis.window?.location,
): string => {
  if (resolvedPresenterSessionId !== null) return resolvedPresenterSessionId;
  const fromLocation = location === undefined ? null : presenterSessionIdFromLocation(location);
  resolvedPresenterSessionId = fromLocation ?? createPresenterSessionId();
  return resolvedPresenterSessionId;
};

export interface PresenterBridgeOptions {
  /** Exact channel name override. Supplying this bypasses session scoping. */
  readonly channelName?: string;
  /** Per-workbench session id used to scope the default presenter channel. */
  readonly sessionId?: string;
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
  const handlers = new Set<(cmd: PresenterCommand) => void>();
  let disposed = false;
  // Guard for older runtimes / SSR / Node tests.
  const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  const ch =
    typeof BC === 'function'
      ? new BC(
          options.channelName ?? presenterChannelName(options.sessionId ?? getPresenterSessionId()),
        )
      : null;
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
