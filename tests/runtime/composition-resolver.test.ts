// Composition resolver — PUL-F004 with the lifecycle revised by ADR-025.
//
// The resolver now: validates the manifest → builds the plan → mounts
// every scene in manifest order (preload + `create`, NOT torn down
// between steps) → collects each scene's `timeline(ctx)` and hands the
// slice to the injected `CompositionTimelineAdapter` (which composes one
// master and plays it) → tears every scene down via `cleanup(ctx)` in
// reverse mount order, ALWAYS. These tests exercise that lifecycle, its
// abort checkpoints, and its failure semantics with a spying scene
// factory and a recording timeline adapter (the GSAP adapter has its
// own tests in `timeline.test.ts`).

import { describe, expect, it, vi } from 'vitest';
import type { CompositionManifest } from '../../src/runtime/composition';
import {
  type CompositionTimelineAdapter,
  type CompositionTimelineRunOptions,
  type SceneTimelineSegment,
  resolveComposition,
} from '../../src/runtime/composition-resolver';
import { createSceneRegistry } from '../../src/runtime/registry';
import type { SceneLifecycleFn, SceneModule } from '../../src/runtime/scene';

// ----- spying scene factory -------------------------------------------------

type HookOverrides = Partial<Pick<SceneModule, 'create' | 'timeline' | 'cleanup'>>;

/** A minimal scene module; pass a shared `log` array to record hook calls. */
const scene = (id: string, hooks: HookOverrides = {}): SceneModule => ({
  id,
  title: id,
  duration: null,
  tags: [],
  assets: [],
  captions: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  create: hooks.create ?? ((): void => undefined),
  timeline: hooks.timeline ?? ((): null => null),
  cleanup: hooks.cleanup ?? ((): void => undefined),
});

/** A scene that records `create:<id>` / `timeline:<id>` / `cleanup:<id>` into `log`. */
const recordingScene = (id: string, log: string[], extra: HookOverrides = {}): SceneModule =>
  scene(id, {
    create:
      extra.create ??
      ((): void => {
        log.push(`create:${id}`);
      }),
    timeline:
      extra.timeline ??
      ((): null => {
        log.push(`timeline:${id}`);
        return null;
      }),
    cleanup:
      extra.cleanup ??
      ((): void => {
        log.push(`cleanup:${id}`);
      }),
  });

// ----- recording timeline adapter -------------------------------------------

interface AdapterCall {
  readonly segments: readonly SceneTimelineSegment[];
  readonly opts: CompositionTimelineRunOptions;
}

type AdapterBehavior =
  | { readonly kind: 'resolve' }
  | { readonly kind: 'reject'; readonly error: unknown }
  | { readonly kind: 'park' }; // resolves only when `opts.signal` aborts (or no signal)

/**
 * A `CompositionTimelineAdapter` stub that records every `run(segments,
 * opts)` call and resolves / rejects / parks-until-abort per `behavior`.
 * Optionally logs `run` into a shared array (to pin the lifecycle order).
 */
const recordingTimeline = (
  behavior: AdapterBehavior = { kind: 'resolve' },
  log?: string[],
): { adapter: CompositionTimelineAdapter; calls: AdapterCall[] } => {
  const calls: AdapterCall[] = [];
  const adapter: CompositionTimelineAdapter = {
    run(segments, opts) {
      log?.push('run');
      calls.push({ segments, opts });
      if (behavior.kind === 'reject') return Promise.reject(behavior.error);
      if (behavior.kind === 'park') {
        return new Promise<void>((resolve) => {
          const sig = opts.signal;
          if (sig === undefined || sig.aborted) {
            resolve();
            return;
          }
          sig.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return Promise.resolve();
    },
  };
  return { adapter, calls };
};

// ----- options helper -------------------------------------------------------

interface ResolveArgs {
  readonly scenes: readonly SceneModule[];
  readonly manifest: CompositionManifest;
  readonly timeline?: CompositionTimelineAdapter;
  readonly preloadAssets?: (scene: SceneModule) => void | Promise<void>;
  readonly ctx?: unknown;
  readonly signal?: AbortSignal;
  readonly headBeat?: string;
  readonly onBeatMissing?: () => void;
  readonly headRepeat?: 'until-aborted';
  readonly headHold?: 'first-frame';
  readonly headCueGate?: 'monotonic-forward';
  readonly headScreenshot?: 'capture';
}

const run = (args: ResolveArgs): Promise<void> =>
  resolveComposition({
    registry: createSceneRegistry([...args.scenes]),
    manifest: args.manifest,
    ctx: args.ctx ?? {},
    preloadAssets: args.preloadAssets ?? ((): void => undefined),
    timeline: args.timeline ?? recordingTimeline().adapter,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
    ...(args.headBeat === undefined ? {} : { headBeat: args.headBeat }),
    ...(args.onBeatMissing === undefined ? {} : { onBeatMissing: args.onBeatMissing }),
    ...(args.headRepeat === undefined ? {} : { headRepeat: args.headRepeat }),
    ...(args.headHold === undefined ? {} : { headHold: args.headHold }),
    ...(args.headCueGate === undefined ? {} : { headCueGate: args.headCueGate }),
    ...(args.headScreenshot === undefined ? {} : { headScreenshot: args.headScreenshot }),
  });

const aborted = (reason?: unknown): AbortSignal => {
  const c = new AbortController();
  c.abort(reason);
  return c.signal;
};

const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ----------------------------------------------------------------------------

describe('resolveComposition — boundary validation', () => {
  it('resolves an empty manifest without touching scenes or the timeline', async () => {
    const { adapter, calls } = recordingTimeline();
    await expect(run({ scenes: [], manifest: [], timeline: adapter })).resolves.toBeUndefined();
    expect(calls).toEqual([{ segments: [], opts: {} }]);
  });

  it('defensively validates the manifest shape (assertCompositionManifest)', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input for the boundary check.
      run({ scenes: [], manifest: [{ notAnEntry: true }] as any }),
    ).rejects.toThrow(/composition entry \[0\] is invalid/);
  });

  it('rejects with every unregistered scene id aggregated, before any side effect', async () => {
    const log: string[] = [];
    const preloadAssets = vi.fn((): void => undefined);
    await expect(
      run({
        scenes: [recordingScene('intro', log)],
        manifest: ['ghost-a', 'intro', 'ghost-b'],
        preloadAssets,
      }),
    ).rejects.toThrow(
      'composition resolution failed: unknown scene id(s): "ghost-a" (entry [0]), "ghost-b" (entry [2]) — not registered',
    );
    expect(preloadAssets).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it('rejects when headBeat is supplied without onBeatMissing', async () => {
    await expect(run({ scenes: [scene('a')], manifest: ['a'], headBeat: 'hook' })).rejects.toThrow(
      /"onBeatMissing" is required when "headBeat" is supplied/,
    );
  });

  it('rejects a composition slice that repeats a scene id, before any side effect (ADR-025)', async () => {
    // The mount-all lifecycle activates every entry concurrently, so two
    // `intro` occurrences would share one activation context. Per-entry
    // contexts are a follow-up; until then a repeated scene id in a
    // slice is a navigation error (single-scene modes truncate the slice
    // to the head, so they stay navigable).
    const log: string[] = [];
    const preloadAssets = vi.fn((): void => undefined);
    await expect(
      run({
        scenes: [recordingScene('intro', log), recordingScene('demo', log)],
        manifest: ['intro', 'demo', 'intro'],
        preloadAssets,
      }),
    ).rejects.toThrow(
      'composition resolution failed: composition references scene id "intro" more than once (entries [0], [2]) — repeated scene ids in a composition slice are not yet supported: each occurrence would share one activation context (DOM, listeners, timeline targets, cleanup ownership)',
    );
    expect(preloadAssets).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });
});

describe('resolveComposition — mount phase', () => {
  it('preloads and creates every scene in manifest order, NOT torn down between steps', async () => {
    const log: string[] = [];
    const preloadAssets = (s: SceneModule): void => {
      log.push(`preload:${s.id}`);
    };
    const { adapter } = recordingTimeline({ kind: 'resolve' }, log);
    await run({
      scenes: [recordingScene('a', log), recordingScene('b', log)],
      manifest: ['a', 'b'],
      preloadAssets,
      timeline: adapter,
    });
    expect(log).toEqual([
      'preload:a',
      'create:a',
      'preload:b',
      'create:b',
      'timeline:a',
      'timeline:b',
      'run',
      'cleanup:b',
      'cleanup:a',
    ]);
  });

  it('aborts and tears down the scenes mounted so far when a preload throws (the failing scene is not created or cleaned)', async () => {
    const log: string[] = [];
    const preloadAssets = (s: SceneModule): void => {
      if (s.id === 'b') throw new Error('preload kaboom');
      log.push(`preload:${s.id}`);
    };
    await expect(
      run({
        scenes: [recordingScene('a', log), recordingScene('b', log), recordingScene('c', log)],
        manifest: ['a', 'b', 'c'],
        preloadAssets,
      }),
    ).rejects.toThrow(
      'composition resolution failed: scene "b" preloadAssets threw: preload kaboom',
    );
    // a was mounted then cleaned; b never created/cleaned; c never touched.
    expect(log).toEqual(['preload:a', 'create:a', 'cleanup:a']);
  });

  it('aborts and tears down every mounted scene (including the failing one) when a create throws', async () => {
    const log: string[] = [];
    await expect(
      run({
        scenes: [
          recordingScene('a', log),
          recordingScene('b', log, {
            create: () => {
              log.push('create:b');
              throw new Error('create kaboom');
            },
          }),
          recordingScene('c', log),
        ],
        manifest: ['a', 'b', 'c'],
      }),
    ).rejects.toThrow('composition resolution failed: scene "b" create threw: create kaboom');
    // a + b mounted (b's create attempted) → cleaned in reverse; c never touched.
    expect(log).toEqual(['create:a', 'create:b', 'cleanup:b', 'cleanup:a']);
  });

  it('does not start the composition when the signal is already aborted', async () => {
    const log: string[] = [];
    const preloadAssets = vi.fn((): void => undefined);
    await expect(
      run({
        scenes: [recordingScene('a', log)],
        manifest: ['a'],
        preloadAssets,
        signal: aborted('user navigated away'),
      }),
    ).rejects.toThrow('composition resolution failed: aborted before the composition started');
    expect(preloadAssets).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it('aborts after a slow preload, before the scene is activated', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const preloadAssets = async (s: SceneModule): Promise<void> => {
      log.push(`preload:${s.id}`);
      if (s.id === 'a') controller.abort();
      await flushMicrotasks();
    };
    await expect(
      run({
        scenes: [recordingScene('a', log), recordingScene('b', log)],
        manifest: ['a', 'b'],
        preloadAssets,
        signal: controller.signal,
      }),
    ).rejects.toThrow(
      'composition resolution failed: aborted after preloading "a", before scene activation',
    );
    // a's preload ran; a's create never ran (aborted before activation); nothing to clean.
    expect(log).toEqual(['preload:a']);
  });

  it('aborts after a scene was mounted, before the next is preloaded', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    await expect(
      run({
        scenes: [
          recordingScene('a', log, {
            create: async () => {
              log.push('create:a');
              controller.abort();
              await flushMicrotasks();
            },
          }),
          recordingScene('b', log),
        ],
        manifest: ['a', 'b'],
        signal: controller.signal,
      }),
    ).rejects.toThrow('composition resolution failed: aborted after mounting "a"');
    // a mounted → cleaned; b never touched.
    expect(log).toEqual(['create:a', 'cleanup:a']);
  });
});

describe('resolveComposition — compose phase', () => {
  it('hands the scene timeline values (and per-entry overrides) to the adapter as segments', async () => {
    const tlA = { handle: 'a-timeline' };
    const tlB = { handle: 'b-timeline' };
    const { adapter, calls } = recordingTimeline();
    await run({
      scenes: [scene('a', { timeline: () => tlA }), scene('b', { timeline: () => tlB })],
      manifest: ['a', { id: 'b', range: ['intro', 'outro'], behavior: { speed: 2 } }],
      timeline: adapter,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.segments).toEqual([
      { id: 'a', timeline: tlA },
      { id: 'b', timeline: tlB, range: ['intro', 'outro'], behavior: { speed: 2 } },
    ]);
  });

  it('does NOT await the scene timeline value — a thenable reaches the adapter as-is', async () => {
    // A GSAP timeline (ADR-003 / ADR-025) is itself thenable; awaiting it
    // would block on completion. Modelled here with a thenable that never
    // settles: if the resolver awaited it, `resolveComposition` would hang.
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable — it stands in for a GSAP timeline the resolver must not await.
    const neverSettles = { then: () => undefined } as unknown;
    const { adapter, calls } = recordingTimeline();
    await run({
      scenes: [scene('a', { timeline: () => neverSettles })],
      manifest: ['a'],
      timeline: adapter,
    });
    expect(calls[0]?.segments).toEqual([{ id: 'a', timeline: neverSettles }]);
  });

  it('aborts and tears down every mounted scene when a timeline factory throws', async () => {
    const log: string[] = [];
    await expect(
      run({
        scenes: [
          recordingScene('a', log),
          recordingScene('b', log, {
            timeline: () => {
              log.push('timeline:b');
              throw new Error('timeline kaboom');
            },
          }),
          recordingScene('c', log),
        ],
        manifest: ['a', 'b', 'c'],
      }),
    ).rejects.toThrow('composition resolution failed: scene "b" timeline threw: timeline kaboom');
    // all three mounted (mount phase completed) → cleaned in reverse.
    expect(log).toEqual([
      'create:a',
      'create:b',
      'create:c',
      'timeline:a',
      'timeline:b',
      'cleanup:c',
      'cleanup:b',
      'cleanup:a',
    ]);
  });
});

describe('resolveComposition — run phase', () => {
  it('forwards the head hints to the adapter, omitting absent keys', async () => {
    const onBeatMissing = (): void => undefined;
    const { adapter, calls } = recordingTimeline();
    const controller = new AbortController();
    await run({
      scenes: [scene('a')],
      manifest: ['a'],
      timeline: adapter,
      signal: controller.signal,
      headBeat: 'hook',
      onBeatMissing,
      headRepeat: 'until-aborted',
    });
    expect(calls[0]?.opts).toEqual({
      signal: controller.signal,
      headBeat: 'hook',
      onBeatMissing,
      headRepeat: 'until-aborted',
    });
  });

  it('passes only the timeline and segments when no hints are supplied', async () => {
    const { adapter, calls } = recordingTimeline();
    await run({ scenes: [scene('a')], manifest: ['a'], timeline: adapter });
    expect(calls[0]?.opts).toEqual({});
  });

  it('tears every scene down and wraps the rejection when the adapter run rejects', async () => {
    const log: string[] = [];
    const cause = new Error('master kaboom');
    await expect(
      run({
        scenes: [recordingScene('a', log), recordingScene('b', log)],
        manifest: ['a', 'b'],
        timeline: recordingTimeline({ kind: 'reject', error: cause }, log).adapter,
      }),
    ).rejects.toThrow('composition resolution failed: composition timeline failed: master kaboom');
    expect(log).toEqual([
      'create:a',
      'create:b',
      'timeline:a',
      'timeline:b',
      'run',
      'cleanup:b',
      'cleanup:a',
    ]);
  });

  it('preserves the original error as Error.cause when the adapter run rejects', async () => {
    const cause = new Error('master kaboom');
    let caught: unknown;
    await run({
      scenes: [scene('a')],
      manifest: ['a'],
      timeline: recordingTimeline({ kind: 'reject', error: cause }).adapter,
    }).then(
      () => expect.unreachable('resolveComposition should have rejected'),
      (err: unknown) => {
        caught = err;
      },
    );
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBe(cause);
  });

  it('tears every scene down then surfaces an aborted error when the navigation aborts during playback', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const promise = run({
      scenes: [recordingScene('a', log), recordingScene('b', log)],
      manifest: ['a', 'b'],
      timeline: recordingTimeline({ kind: 'park' }, log).adapter,
      signal: controller.signal,
    });
    await flushMicrotasks();
    expect(log).toEqual(['create:a', 'create:b', 'timeline:a', 'timeline:b', 'run']);
    controller.abort('navigated away');
    await expect(promise).rejects.toThrow(
      'composition resolution failed: aborted during composition playback',
    );
    expect(log).toEqual([
      'create:a',
      'create:b',
      'timeline:a',
      'timeline:b',
      'run',
      'cleanup:b',
      'cleanup:a',
    ]);
  });
});

describe('resolveComposition — cleanup phase', () => {
  it('tears every scene down in reverse mount order on the happy path', async () => {
    const log: string[] = [];
    await run({
      scenes: [recordingScene('a', log), recordingScene('b', log), recordingScene('c', log)],
      manifest: ['a', 'b', 'c'],
    });
    expect(log.slice(-3)).toEqual(['cleanup:c', 'cleanup:b', 'cleanup:a']);
  });

  it('runs every scene cleanup even if an earlier one throws, then re-raises an AggregateError', async () => {
    const log: string[] = [];
    let caught: unknown;
    await run({
      scenes: [
        recordingScene('a', log),
        recordingScene('b', log, {
          cleanup: () => {
            log.push('cleanup:b');
            throw new Error('cleanup-b kaboom');
          },
        }),
        recordingScene('c', log),
      ],
      manifest: ['a', 'b', 'c'],
    }).catch((err: unknown) => {
      caught = err;
    });
    // c, b, a all cleaned (b threw but a still ran).
    expect(log.slice(-3)).toEqual(['cleanup:c', 'cleanup:b', 'cleanup:a']);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as Error).message).toContain(
      'composition completed but 1 cleanup hook(s) threw',
    );
    expect((caught as AggregateError).errors).toHaveLength(1);
    expect(((caught as AggregateError).errors[0] as Error).message).toBe(
      'composition resolution failed: scene "b" cleanup threw: cleanup-b kaboom',
    );
  });

  it('aggregates the phase error and the cleanup error(s) when both fail (phase error first)', async () => {
    const log: string[] = [];
    let caught: unknown;
    await run({
      scenes: [
        recordingScene('a', log, {
          cleanup: () => {
            log.push('cleanup:a');
            throw new Error('cleanup-a kaboom');
          },
        }),
        recordingScene('b', log, {
          timeline: () => {
            log.push('timeline:b');
            throw new Error('timeline-b kaboom');
          },
        }),
      ],
      manifest: ['a', 'b'],
    }).catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(AggregateError);
    const errors = (caught as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe(
      'composition resolution failed: scene "b" timeline threw: timeline-b kaboom',
    );
    expect((errors[1] as Error).message).toBe(
      'composition resolution failed: scene "a" cleanup threw: cleanup-a kaboom',
    );
    // both scenes' cleanup attempted.
    expect(log.filter((e) => e.startsWith('cleanup:')).sort()).toEqual(['cleanup:a', 'cleanup:b']);
  });

  it('reports a cleanup failure during an aborted-playback exit (not suppressed by the abort)', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    let caught: unknown;
    const promise = run({
      scenes: [
        recordingScene('a', log, {
          cleanup: () => {
            log.push('cleanup:a');
            throw new Error('cleanup-a kaboom');
          },
        }),
      ],
      manifest: ['a'],
      timeline: recordingTimeline({ kind: 'park' }).adapter,
      signal: controller.signal,
    });
    await flushMicrotasks();
    controller.abort();
    await promise.catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as Error).message).toContain(
      'composition aborted during playback with 1 cleanup failure(s)',
    );
  });

  it('does not call any cleanup when no scene was mounted (already-aborted navigation)', async () => {
    const log: string[] = [];
    await run({
      scenes: [recordingScene('a', log)],
      manifest: ['a'],
      signal: aborted(),
    }).catch(() => undefined);
    expect(log).toEqual([]);
  });
});
