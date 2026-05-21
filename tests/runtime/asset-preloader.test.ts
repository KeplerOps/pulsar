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
  audio: [],
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
    it('stream-drains the response body via getReader (does not buffer the whole payload)', async () => {
      // Build a ReadableStream that emits a couple of chunks then
      // closes. Track every read so we can assert the preloader
      // actually consumed the stream rather than ignoring or
      // buffering it.
      const reads: number[] = [];
      const fetchImpl: typeof globalThis.fetch = async () => {
        let chunkIndex = 0;
        const stream = new ReadableStream({
          pull(controller) {
            chunkIndex += 1;
            if (chunkIndex > 3) {
              controller.close();
              return;
            }
            reads.push(chunkIndex);
            controller.enqueue(new Uint8Array([chunkIndex]));
          },
        });
        return new Response(stream, { status: 200 });
      };
      const preload = createAssetPreloader({ fetch: fetchImpl });
      await preload(buildScene('scene-a', ['/a']));
      // Three pulls were issued; the preloader must have driven the
      // reader to completion.
      expect(reads).toEqual([1, 2, 3]);
    });

    it('awaits the body drain before resolving (gated reader)', async () => {
      // Build a stream whose first read is gated. Until released, the
      // preloader's promise must NOT resolve.
      let releaseFirstChunk: (() => void) | undefined;
      const firstChunkGate = new Promise<void>((resolve) => {
        releaseFirstChunk = resolve;
      });
      let chunkIndex = 0;
      const fetchImpl: typeof globalThis.fetch = async () => {
        const stream = new ReadableStream({
          async pull(controller) {
            chunkIndex += 1;
            if (chunkIndex === 1) {
              await firstChunkGate;
              controller.enqueue(new Uint8Array([1]));
              return;
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      };
      const preload = createAssetPreloader({ fetch: fetchImpl });
      let resolved = false;
      const promise = preload(buildScene('scene-a', ['/a'])).then(() => {
        resolved = true;
      });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(resolved).toBe(false);
      releaseFirstChunk?.();
      await promise;
      expect(resolved).toBe(true);
    });
  });

  describe('up-front validation (codex review: validate full asset list before any fetch)', () => {
    it('does not start any fetch when a later asset has a disallowed scheme', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({ fetch: fetchImpl });
      await expect(
        preload(
          buildScene('scene-a', [
            'https://allowed.example/a.png',
            'file:///etc/passwd',
            'https://allowed.example/b.png',
          ]),
        ),
      ).rejects.toThrow(/^composition asset preload failed:/);
      // No URL — including the otherwise-allowed `https:` ones — was
      // fetched, because validation aborted before the network phase.
      expect(calls).toEqual([]);
    });
  });

  describe('post-redirect URL re-validation (security: redirect to disallowed scheme)', () => {
    it('rejects when fetch follows a redirect into a disallowed scheme', async () => {
      const fetchImpl: typeof globalThis.fetch = async () => {
        // Fake a Response whose `.url` reports a final URL with a
        // disallowed scheme — what fetch would do after following a
        // 302 from https://allowed.example to file:///etc/passwd
        // (`fetch` exposes the final URL on `response.url`).
        const response = new Response(new ArrayBuffer(0), { status: 200 });
        Object.defineProperty(response, 'url', {
          value: 'file:///etc/passwd',
        });
        return response;
      };
      const preload = createAssetPreloader({ fetch: fetchImpl });
      try {
        await preload(buildScene('scene-a', ['https://allowed.example/a.png']));
        expect.unreachable('expected redirect to disallowed scheme to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect((top.errors[0] as Error).message).toMatch(
          /redirected to disallowed URL "file:\/\/\/etc\/passwd"/,
        );
      }
    });

    it('accepts a same-scheme redirect (https → https)', async () => {
      const fetchImpl: typeof globalThis.fetch = async () => {
        const response = new Response(new ArrayBuffer(0), { status: 200 });
        Object.defineProperty(response, 'url', {
          value: 'https://cdn.example.com/redirected/a.png',
        });
        return response;
      };
      const preload = createAssetPreloader({ fetch: fetchImpl });
      await expect(
        preload(buildScene('scene-a', ['https://allowed.example/a.png'])),
      ).resolves.toBeUndefined();
    });
  });

  describe('protocol-relative URLs (codex review: must not bypass scheme allowlist)', () => {
    it('rejects // prefix when no baseUrl is configured', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({ fetch: fetchImpl });
      try {
        await preload(buildScene('scene-a', ['//attacker.example/a.png']));
        expect.unreachable('expected protocol-relative URL to be rejected without baseUrl');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect((top.errors[0] as Error).message).toMatch(
          /asset "\/\/attacker\.example\/a\.png": protocol-relative URL requires AssetPreloaderOptions\.baseUrl/,
        );
      }
      expect(calls).toEqual([]);
    });

    it('accepts // prefix once baseUrl is set (resolved scheme is validated)', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({
        fetch: fetchImpl,
        baseUrl: 'https://my-app.example/',
      });
      await preload(buildScene('scene-a', ['//cdn.example.com/a.png']));
      // // resolved against an https: base yields https: scheme — allowed.
      expect(calls.map((c) => c.input)).toEqual(['https://cdn.example.com/a.png']);
    });
  });

  describe('error message includes resolved URL when different from declared', () => {
    it('shows both declared and resolved URLs in failure messages', async () => {
      const fetchImpl: typeof globalThis.fetch = async () =>
        new Response(null, { status: 404, statusText: 'Not Found' });
      const preload = createAssetPreloader({
        fetch: fetchImpl,
        baseUrl: 'https://cdn.example.com/scenes/',
      });
      try {
        await preload(buildScene('scene-a', ['hero.png']));
        expect.unreachable('expected 404 to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect((top.errors[0] as Error).message).toBe(
          'asset "hero.png" → "https://cdn.example.com/scenes/hero.png": 404 Not Found',
        );
      }
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

    it('wraps a rejected fetch with the asset URL and preserves the original error as cause', async () => {
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
        expect(top.errors).toHaveLength(1);
        const wrapped = top.errors[0] as Error & { cause?: unknown };
        // Asset URL must appear in the message so multi-asset failures
        // stay distinguishable.
        expect(wrapped.message).toBe('asset "/x.png": fetch failed: ECONNRESET');
        expect(wrapped.cause).toBe(networkErr);
      }
    });

    it('keeps two distinct rejected fetches distinguishable via URL-scoped messages (no collapsed "fetch failed")', async () => {
      const fetchImpl: typeof globalThis.fetch = async (input) => {
        throw new TypeError(`fetch failed for ${String(input)}`);
      };
      const preload = createAssetPreloader({ fetch: fetchImpl });
      try {
        await preload(buildScene('scene-a', ['/first.png', '/second.png']));
        expect.unreachable('expected both assets to fail');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect(top.errors).toHaveLength(2);
        expect((top.errors[0] as Error).message).toMatch(/^asset "\/first\.png": /);
        expect((top.errors[1] as Error).message).toMatch(/^asset "\/second\.png": /);
      }
    });

    it('cancels the response body on a non-2xx response (no leaked open stream)', async () => {
      const cancelCalls: number[] = [];
      const fetchImpl: typeof globalThis.fetch = async () => {
        const response = new Response(new ReadableStream(), {
          status: 503,
          statusText: 'Service Unavailable',
        });
        // Wrap the body's cancel so we can observe it being called.
        const originalCancel = response.body?.cancel.bind(response.body);
        if (response.body !== null && originalCancel !== undefined) {
          Object.defineProperty(response.body, 'cancel', {
            value: async (reason?: unknown) => {
              cancelCalls.push(1);
              return originalCancel(reason);
            },
          });
        }
        return response;
      };
      const preload = createAssetPreloader({ fetch: fetchImpl });
      await expect(preload(buildScene('scene-a', ['/down.png']))).rejects.toThrow(
        /^composition asset preload failed:/,
      );
      expect(cancelCalls).toEqual([1]);
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

  describe('baseUrl resolution (Node-portable)', () => {
    it('resolves a relative asset against baseUrl before fetching (Node fetch requires absolute URLs)', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({
        fetch: fetchImpl,
        baseUrl: 'https://cdn.example.com/scenes/',
      });
      await preload(buildScene('scene-a', ['hero.png', 'audio/intro.mp3']));
      expect(calls.map((c) => c.input)).toEqual([
        'https://cdn.example.com/scenes/hero.png',
        'https://cdn.example.com/scenes/audio/intro.mp3',
      ]);
    });

    it('passes an absolute asset through unchanged even when baseUrl is set (URL constructor behavior)', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({
        fetch: fetchImpl,
        baseUrl: 'https://cdn.example.com/scenes/',
      });
      await preload(buildScene('scene-a', ['https://other.example.com/foo.png']));
      expect(calls.map((c) => c.input)).toEqual(['https://other.example.com/foo.png']);
    });

    it('passes a relative path through unchanged when baseUrl is unset (browser fetch handles document.baseURI)', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({ fetch: fetchImpl });
      await preload(buildScene('scene-a', ['/relative/x.png']));
      expect(calls.map((c) => c.input)).toEqual(['/relative/x.png']);
    });

    it('throws asset-scoped error when baseUrl + asset cannot form a valid URL', async () => {
      const { fetchImpl } = buildFakeFetch();
      const preload = createAssetPreloader({
        fetch: fetchImpl,
        baseUrl: 'not a valid base',
      });
      try {
        await preload(buildScene('scene-a', ['x.png']));
        expect.unreachable('expected invalid URL to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        const wrapped = top.errors[0] as Error;
        expect(wrapped.message).toBe('asset "x.png": invalid URL relative to baseUrl');
      }
    });
  });

  describe('scheme allowlist (SSRF defense)', () => {
    it('rejects file: scheme by default', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({ fetch: fetchImpl });
      try {
        await preload(buildScene('scene-a', ['file:///etc/passwd']));
        expect.unreachable('expected file: to be rejected');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect((top.errors[0] as Error).message).toBe(
          'asset "file:///etc/passwd": scheme "file:" not in allowed list (http:, https:, data:, blob:)',
        );
      }
      // Network MUST NOT be called for a rejected scheme.
      expect(calls).toEqual([]);
    });

    it('rejects gopher: and other obscure schemes by default', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({ fetch: fetchImpl });
      await expect(
        preload(buildScene('scene-a', ['gopher://internal.example/secrets'])),
      ).rejects.toThrow(/^composition asset preload failed:/);
      expect(calls).toEqual([]);
    });

    it('accepts https:, http:, data:, and blob: by default', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({ fetch: fetchImpl });
      await preload(
        buildScene('scene-a', [
          'https://cdn.example.com/a.png',
          'http://cdn.example.com/b.png',
          'data:audio/wav;base64,QQA=',
          'blob:https://example.com/uuid-here',
        ]),
      );
      expect(calls).toHaveLength(4);
    });

    it('honors a tightened allowlist (e.g. https-only for production)', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({
        fetch: fetchImpl,
        allowedSchemes: ['https:'],
      });
      try {
        await preload(buildScene('scene-a', ['http://insecure.example/a.png']));
        expect.unreachable('expected http: to be rejected by tightened allowlist');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect((top.errors[0] as Error).message).toBe(
          'asset "http://insecure.example/a.png": scheme "http:" not in allowed list (https:)',
        );
      }
      expect(calls).toEqual([]);
    });

    it('re-validates scheme after baseUrl resolution (an absolute file: URL declared as a relative-looking string is still caught)', async () => {
      const { fetchImpl, calls } = buildFakeFetch();
      const preload = createAssetPreloader({
        fetch: fetchImpl,
        baseUrl: 'file:///some/dir/',
      });
      try {
        await preload(buildScene('scene-a', ['relative-path.png']));
        expect.unreachable('expected file: scheme on resolved URL to be rejected');
      } catch (err) {
        expect(err).toBeInstanceOf(AggregateError);
        const top = err as AggregateError;
        expect((top.errors[0] as Error).message).toMatch(/scheme "file:" not in allowed list/);
      }
      expect(calls).toEqual([]);
    });

    it('re-exports DEFAULT_ALLOWED_SCHEMES so callers can extend rather than duplicate the default list', async () => {
      const { DEFAULT_ALLOWED_SCHEMES } = await import('../../src/runtime/asset-preloader');
      expect(DEFAULT_ALLOWED_SCHEMES).toEqual(['http:', 'https:', 'data:', 'blob:']);
      // Frozen so callers cannot accidentally mutate the default.
      expect(Object.isFrozen(DEFAULT_ALLOWED_SCHEMES)).toBe(true);
    });
  });
});
