import { describe, expect, it } from 'vitest';
import {
  type AssetPreloaderOptions,
  createAssetPreloader,
} from '../../src/runtime/asset-preloader';
import type { SceneModule } from '../../src/runtime/scene';

// Each test builds a per-scene fixture inline. The shared `buildScene`
// keeps fixture cost low and pins exactly one variable per test.
const buildScene = (id: string, assets: readonly string[] = []): SceneModule => ({
  id,
  title: id,
  duration: 1000,
  tags: [],
  assets,
  captions: [],
  defaultNext: null,
  standalone: false,
  trailerSafe: false,
  create: () => undefined,
  timeline: () => undefined,
  cleanup: () => undefined,
});

interface FetchCall {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
}

interface BuildFakeFetchOpts {
  /**
   * Per-URL response factory. Default: 200 OK with an immediate empty
   * body. Throw / reject from the factory to simulate network errors.
   */
  readonly respond?: (input: RequestInfo | URL) => Response | Promise<Response>;
}

const buildFakeFetch = (opts: BuildFakeFetchOpts = {}) => {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    if (opts.respond) return opts.respond(input);
    return new Response(new ArrayBuffer(0), { status: 200 });
  };
  return { fetchImpl, calls };
};

describe('createAssetPreloader (PUL-F005)', () => {
  describe('clause (b) — preload before mount: empty input', () => {
    it('resolves immediately with no fetch calls when scene.assets is empty', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({ fetch: fetchImpl });
      await expect(preload(buildScene('scene-a', []))).resolves.toBeUndefined();
      expect(calls).toEqual([]);
    });
  });

  describe('clause (b) — preload before mount: happy path', () => {
    it('calls fetch once with the asset URL when scene.assets has one entry', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({ fetch: fetchImpl });
      await preload(buildScene('scene-a', ['/assets/scene-a/hero.png']));
      expect(calls.map((c) => c.input)).toEqual(['/assets/scene-a/hero.png']);
    });

    it('calls fetch once per asset, in declaration order, when scene.assets has multiple entries', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({ fetch: fetchImpl });
      await preload(buildScene('scene-a', ['/a.png', '/b.mp3', '/c.json']));
      expect(calls.map((c) => c.input)).toEqual(['/a.png', '/b.mp3', '/c.json']);
    });

    it('starts every fetch in parallel (does not serialize per asset)', async () => {
      // Each fetch resolves on its own gate. If the preloader serialized
      // the fetches it would never get past the first one before we
      // unblock its gate. We unblock all gates at once and verify all
      // fetches start before any complete.
      const startedAt: string[] = [];
      const gates = new Map<string, () => void>();
      const fetchImpl: typeof globalThis.fetch = async (input) => {
        const url = String(input);
        startedAt.push(url);
        await new Promise<void>((resolve) => {
          gates.set(url, resolve);
        });
        return new Response(new ArrayBuffer(0), { status: 200 });
      };
      const preload = createAssetPreloader({ fetch: fetchImpl });
      const promise = preload(buildScene('scene-a', ['/a', '/b', '/c']));
      // Drain microtasks until all three fetches have started.
      while (startedAt.length < 3) {
        await Promise.resolve();
      }
      expect(startedAt).toEqual(['/a', '/b', '/c']);
      // Now unblock all three; the promise resolves once they all
      // complete (and bodies are drained).
      for (const release of gates.values()) {
        release();
      }
      await expect(promise).resolves.toBeUndefined();
    });

    it('forwards asset URLs verbatim — no path munging', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({ fetch: fetchImpl });
      await preload(
        buildScene('scene-a', [
          'https://cdn.example.com/full-url.png',
          '/leading-slash.json',
          'relative/path.mp3',
          'data:audio/wav;base64,QQA=',
        ]),
      );
      expect(calls.map((c) => c.input)).toEqual([
        'https://cdn.example.com/full-url.png',
        '/leading-slash.json',
        'relative/path.mp3',
        'data:audio/wav;base64,QQA=',
      ]);
    });
  });

  describe('configurable fetch / init', () => {
    it('uses the fetch override from AssetPreloaderOptions instead of globalThis.fetch', async () => {
      const overrideCalls: string[] = [];
      const fetchImpl: typeof globalThis.fetch = async (input) => {
        overrideCalls.push(String(input));
        return new Response(new ArrayBuffer(0), { status: 200 });
      };
      const opts: AssetPreloaderOptions = { fetch: fetchImpl };
      const preload = createAssetPreloader(opts);
      await preload(buildScene('scene-a', ['/x']));
      expect(overrideCalls).toEqual(['/x']);
    });

    it('falls back to globalThis.fetch when no override is provided', async () => {
      const calls: string[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(new ArrayBuffer(0), { status: 200 });
      }) as typeof globalThis.fetch;
      try {
        const preload = createAssetPreloader();
        await preload(buildScene('scene-a', ['/y']));
        expect(calls).toEqual(['/y']);
      } finally {
        globalThis.fetch = original;
      }
    });

    it('forwards the optional init (headers / signal / cache mode) to every fetch call', async () => {
      const init: RequestInit = {
        headers: { 'X-Pulsar-Preload': '1' },
        cache: 'no-store',
      };
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({ fetch: fetchImpl, init });
      await preload(buildScene('scene-a', ['/a', '/b']));
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.init).toBe(init);
      }
    });
  });

  describe('body drain invariant', () => {
    it("awaits the response body's arrayBuffer() before resolving", async () => {
      // fetch resolves with headers immediately, but the body's
      // arrayBuffer() resolution is gated. The preloader must wait on
      // the body before its own promise resolves.
      let releaseBody: ((value: ArrayBuffer) => void) | undefined;
      const bodyGate = new Promise<ArrayBuffer>((resolve) => {
        releaseBody = resolve;
      });
      const fetchImpl: typeof globalThis.fetch = async () => {
        const response = new Response(new ArrayBuffer(0), { status: 200 });
        // Override arrayBuffer to return the gated promise so the
        // preloader's drain step is observable.
        Object.defineProperty(response, 'arrayBuffer', {
          value: () => bodyGate,
        });
        return response;
      };
      const preload = createAssetPreloader({ fetch: fetchImpl });
      let resolved = false;
      const promise = preload(buildScene('scene-a', ['/a'])).then(() => {
        resolved = true;
      });
      // Drain microtasks: fetch resolves, but body is still gated,
      // so the preloader promise must NOT have resolved yet.
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
      expect(resolved).toBe(false);
      releaseBody?.(new ArrayBuffer(0));
      await promise;
      expect(resolved).toBe(true);
    });
  });

  describe('failure paths (clause b: must not swallow)', () => {
    it('throws AggregateError with the URL + status when a single asset returns 404', async () => {
      const fetchImpl: typeof globalThis.fetch = async () =>
        new Response(null, { status: 404, statusText: 'Not Found' });
      const preload = createAssetPreloader({ fetch: fetchImpl });
      try {
        await preload(buildScene('scene-a', ['/missing.png']));
        expect.unreachable('expected 404 to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect(top.message).toBe('composition asset preload failed: scene "scene-a"');
        expect(top.errors).toHaveLength(1);
        expect((top.errors[0] as Error).message).toBe('asset "/missing.png": 404 Not Found');
      }
    });

    it('throws AggregateError carrying the original cause when a fetch rejects (network error)', async () => {
      const networkErr = new TypeError('fetch failed: ECONNRESET');
      const fetchImpl: typeof globalThis.fetch = async () => {
        throw networkErr;
      };
      const preload = createAssetPreloader({ fetch: fetchImpl });
      try {
        await preload(buildScene('scene-a', ['/x.png']));
        expect.unreachable('expected network error to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect(top.errors).toEqual([networkErr]);
      }
    });

    it('throws AggregateError with one entry when one of many assets fails (others succeed)', async () => {
      const fetchImpl: typeof globalThis.fetch = async (input) => {
        if (String(input) === '/bad.png') {
          return new Response(null, { status: 500, statusText: 'Server Error' });
        }
        return new Response(new ArrayBuffer(0), { status: 200 });
      };
      const preload = createAssetPreloader({ fetch: fetchImpl });
      try {
        await preload(buildScene('scene-a', ['/ok-a.png', '/bad.png', '/ok-b.png']));
        expect.unreachable('expected partial failure to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect(top.errors).toHaveLength(1);
        expect((top.errors[0] as Error).message).toBe('asset "/bad.png": 500 Server Error');
      }
    });

    it('aggregates multiple failures in declaration order, regardless of completion order', async () => {
      // First and third assets fail; the middle one succeeds. Make the
      // first asset's failure RESOLVE later than the third's so we can
      // verify ordering is by declaration index, not completion order.
      const fetchImpl: typeof globalThis.fetch = async (input) => {
        const url = String(input);
        if (url === '/first-bad') {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return new Response(null, { status: 404, statusText: 'Not Found' });
        }
        if (url === '/third-bad') {
          return new Response(null, { status: 500, statusText: 'Server Error' });
        }
        return new Response(new ArrayBuffer(0), { status: 200 });
      };
      const preload = createAssetPreloader({ fetch: fetchImpl });
      try {
        await preload(buildScene('scene-a', ['/first-bad', '/middle-ok', '/third-bad']));
        expect.unreachable('expected aggregated failure to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect(top.errors).toHaveLength(2);
        expect((top.errors[0] as Error).message).toBe('asset "/first-bad": 404 Not Found');
        expect((top.errors[1] as Error).message).toBe('asset "/third-bad": 500 Server Error');
      }
    });

    it('always throws AggregateError (not a bare Error) — consistency for callers regardless of failure count', async () => {
      const fetchImpl: typeof globalThis.fetch = async () =>
        new Response(null, { status: 404, statusText: 'Not Found' });
      const preload = createAssetPreloader({ fetch: fetchImpl });
      try {
        await preload(buildScene('scene-a', ['/x']));
        expect.unreachable('expected single-failure to throw AggregateError');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
      }
    });

    it('does not silently fall through when only some assets succeed', async () => {
      let succeededCount = 0;
      const fetchImpl: typeof globalThis.fetch = async (input) => {
        if (String(input) === '/bad') {
          return new Response(null, { status: 404, statusText: 'Not Found' });
        }
        succeededCount += 1;
        return new Response(new ArrayBuffer(0), { status: 200 });
      };
      const preload = createAssetPreloader({ fetch: fetchImpl });
      await expect(preload(buildScene('scene-a', ['/ok-1', '/bad', '/ok-2']))).rejects.toThrow();
      // Sanity: the OK fetches still ran (parallel start, no early
      // abort) — the function rejects after waiting for all.
      expect(succeededCount).toBe(2);
    });
  });
});
