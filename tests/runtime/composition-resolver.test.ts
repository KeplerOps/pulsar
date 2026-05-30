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
  type FailureBucket,
  type LifecycleContext,
  type PlanStep,
  type SceneActivation,
  type SceneFailureEvent,
  type SceneFailurePhase,
  type SceneTimelineSegment,
  buildLifecycleContext,
  buildPlan,
  resolveComposition,
  runLifecycle,
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
  audio: [],
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
  readonly ctx?: (activation: SceneActivation) => unknown;
  readonly signal?: AbortSignal;
  readonly headBeat?: string;
  readonly onBeatMissing?: () => void;
  readonly headRepeat?: 'until-aborted';
  readonly headHold?: 'first-frame';
  readonly headCueGate?: 'monotonic-forward';
  readonly headScreenshot?: 'capture';
  readonly onSceneCleaned?: (activation: SceneActivation) => void;
  readonly onSceneFailed?: (event: SceneFailureEvent) => void;
}

const run = (args: ResolveArgs): Promise<void> =>
  resolveComposition({
    registry: createSceneRegistry([...args.scenes]),
    manifest: args.manifest,
    ctx: args.ctx ?? ((): unknown => ({})),
    preloadAssets: args.preloadAssets ?? ((): void => undefined),
    timeline: args.timeline ?? recordingTimeline().adapter,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
    ...(args.headBeat === undefined ? {} : { headBeat: args.headBeat }),
    ...(args.onBeatMissing === undefined ? {} : { onBeatMissing: args.onBeatMissing }),
    ...(args.headRepeat === undefined ? {} : { headRepeat: args.headRepeat }),
    ...(args.headHold === undefined ? {} : { headHold: args.headHold }),
    ...(args.headCueGate === undefined ? {} : { headCueGate: args.headCueGate }),
    ...(args.headScreenshot === undefined ? {} : { headScreenshot: args.headScreenshot }),
    ...(args.onSceneCleaned === undefined ? {} : { onSceneCleaned: args.onSceneCleaned }),
    ...(args.onSceneFailed === undefined ? {} : { onSceneFailed: args.onSceneFailed }),
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

  it('resolves a composition slice that repeats a scene id, mounting each occurrence once (issue #99)', async () => {
    // ADR-002 allows a composition to reference the same scene module
    // more than once. Each occurrence is a distinct activation: it is
    // mounted, composed, and torn down once, in manifest / reverse
    // order — never collapsed by scene id.
    const log: string[] = [];
    const { adapter, calls } = recordingTimeline();
    await expect(
      run({
        scenes: [recordingScene('intro', log), recordingScene('demo', log)],
        manifest: ['intro', 'demo', 'intro'],
        timeline: adapter,
      }),
    ).resolves.toBeUndefined();
    expect(log).toEqual([
      'create:intro',
      'create:demo',
      'create:intro',
      'timeline:intro',
      'timeline:demo',
      'timeline:intro',
      'cleanup:intro',
      'cleanup:demo',
      'cleanup:intro',
    ]);
    // Both `intro` occurrences contribute a distinct timeline segment,
    // in manifest order, so the composer can namespace them.
    expect(calls[0]?.segments.map((s) => s.id)).toEqual(['intro', 'demo', 'intro']);
  });

  it('hands onSceneCleaned a per-occurrence activation for repeated scene ids (issue #99)', async () => {
    const log: string[] = [];
    const cleaned: SceneActivation[] = [];
    await run({
      scenes: [recordingScene('intro', log), recordingScene('demo', log)],
      manifest: ['intro', 'demo', 'intro'],
      onSceneCleaned: (activation) => cleaned.push(activation),
    });
    // Reverse mount order: intro#1 (entry 2), demo#0 (entry 1),
    // intro#0 (entry 0). Each occurrence carries a stable identity.
    expect(cleaned).toEqual([
      { sceneId: 'intro', entryIndex: 2, occurrence: 1 },
      { sceneId: 'demo', entryIndex: 1, occurrence: 0 },
      { sceneId: 'intro', entryIndex: 0, occurrence: 0 },
    ]);
  });

  it('builds a distinct per-occurrence ctx carrying each occurrence activation (issue #99)', async () => {
    const seen: Array<{ phase: string; activation: SceneActivation }> = [];
    const record =
      (phase: string) =>
      (ctx: unknown): void => {
        seen.push({ phase, activation: (ctx as { activation: SceneActivation }).activation });
      };
    const intro = scene('intro', { create: record('create'), cleanup: record('cleanup') });
    await run({
      scenes: [intro, scene('demo')],
      manifest: ['intro', 'demo', 'intro'],
      ctx: (activation) => ({ activation }),
    });
    // Each `intro` occurrence's hooks receive a ctx scoped to ITS
    // activation — distinct entry index and occurrence ordinal — so a
    // scene can own its occurrence's DOM / listeners / state. Cleanup
    // runs in reverse mount order (intro#1 then intro#0).
    expect(seen).toEqual([
      { phase: 'create', activation: { sceneId: 'intro', entryIndex: 0, occurrence: 0 } },
      { phase: 'create', activation: { sceneId: 'intro', entryIndex: 2, occurrence: 1 } },
      { phase: 'cleanup', activation: { sceneId: 'intro', entryIndex: 2, occurrence: 1 } },
      { phase: 'cleanup', activation: { sceneId: 'intro', entryIndex: 0, occurrence: 0 } },
    ]);
  });

  it('isolates one occurrence of a repeated scene id and keeps the sibling (issue #99)', async () => {
    // The first `intro` occurrence's `create` throws; the resolver
    // isolates that occurrence (eager cleanup) and the second
    // occurrence still mounts and runs — repeated ids do not couple
    // failure isolation.
    const log: string[] = [];
    const failed: SceneFailureEvent[] = [];
    let createCalls = 0;
    const intro = scene('intro', {
      create: (): void => {
        const occurrence = createCalls;
        createCalls += 1;
        log.push(`create:intro#${occurrence}`);
        if (occurrence === 0) throw new Error('first intro boom');
      },
      timeline: (): null => {
        log.push('timeline:intro');
        return null;
      },
      cleanup: (): void => {
        log.push('cleanup:intro');
      },
    });
    await run({
      scenes: [intro],
      manifest: ['intro', 'intro'],
      onSceneFailed: (event) => failed.push(event),
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      sceneId: 'intro',
      entryIndex: 0,
      occurrence: 0,
      phase: 'create',
    });
    // intro#0: create throws → eager cleanup. intro#1: create →
    // timeline → final cleanup. The surviving occurrence is unaffected.
    expect(log).toEqual([
      'create:intro#0',
      'cleanup:intro',
      'create:intro#1',
      'timeline:intro',
      'cleanup:intro',
    ]);
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

  it('isolates a create failure: cleans the failing scene, mounts the rest, surfaces via onSceneFailed (PUL-F029)', async () => {
    const log: string[] = [];
    const failed: SceneFailureEvent[] = [];
    await run({
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
      onSceneFailed: (event) => failed.push(event),
    });
    // a creates → b create attempted then throws → b cleaned immediately →
    // c creates → timelines for a and c → run → cleanup c, a.
    expect(log).toEqual([
      'create:a',
      'create:b',
      'cleanup:b',
      'create:c',
      'timeline:a',
      'timeline:c',
      'cleanup:c',
      'cleanup:a',
    ]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      phase: 'create',
      sceneId: 'b',
      message: 'create kaboom',
    });
    expect(failed[0]?.cause).toBeInstanceOf(Error);
  });

  it('rejects with an AggregateError of scene failures when no onSceneFailed callback was supplied (PUL-F029)', async () => {
    // Back-compat path: callers that don't wire `onSceneFailed` still
    // get a deterministic surface (instead of silent isolation) at the
    // end of the lifecycle, so a caller never loses information.
    const log: string[] = [];
    let caught: unknown;
    await run({
      scenes: [
        recordingScene('a', log),
        recordingScene('b', log, {
          create: () => {
            throw new Error('create kaboom');
          },
        }),
        recordingScene('c', log),
      ],
      manifest: ['a', 'b', 'c'],
    }).catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(1);
    expect(((caught as AggregateError).errors[0] as Error).message).toBe(
      'composition resolution failed: scene "b" create threw: create kaboom',
    );
    expect((caught as Error).message).toContain('1 scene failure(s)');
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

  it('isolates a timeline-factory failure: cleans the failing scene, skips its segment, plays the rest (PUL-F029)', async () => {
    const log: string[] = [];
    const failed: SceneFailureEvent[] = [];
    const { adapter, calls } = recordingTimeline();
    await run({
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
      timeline: adapter,
      onSceneFailed: (event) => failed.push(event),
    });
    // All three mounted, b's timeline throws → b cleaned at compose time →
    // a and c contribute segments → run → cleanup c, a (b already cleaned).
    expect(log).toEqual([
      'create:a',
      'create:b',
      'create:c',
      'timeline:a',
      'timeline:b',
      'cleanup:b',
      'timeline:c',
      'cleanup:c',
      'cleanup:a',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.segments.map((s) => s.id)).toEqual(['a', 'c']);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      phase: 'timeline',
      sceneId: 'b',
      message: 'timeline kaboom',
    });
  });

  it('rejects with an AggregateError when a timeline factory throws and no onSceneFailed is supplied (PUL-F029)', async () => {
    const log: string[] = [];
    let caught: unknown;
    await run({
      scenes: [
        recordingScene('a', log),
        recordingScene('b', log, {
          timeline: () => {
            throw new Error('timeline kaboom');
          },
        }),
      ],
      manifest: ['a', 'b'],
    }).catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(AggregateError);
    expect(((caught as AggregateError).errors[0] as Error).message).toBe(
      'composition resolution failed: scene "b" timeline threw: timeline kaboom',
    );
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

  it('runs every scene cleanup even if an earlier one throws, then re-raises an AggregateError (PUL-F029: cleanup failures are scene failures)', async () => {
    // Pre-PUL-F029 the resolver lumped scene-cleanup throws and
    // `onSceneCleaned` hook throws together as "cleanup hooks
    // threw"; ADR-028 splits them — a scene's own `cleanup(ctx)` is a
    // scene failure (phase: 'cleanup'), and only `onSceneCleaned`
    // hook throws are "cleanup hook(s)" in the resolver's surface.
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
    expect((caught as Error).message).toContain('composition completed with 1 scene failure(s)');
    expect((caught as AggregateError).errors).toHaveLength(1);
    expect(((caught as AggregateError).errors[0] as Error).message).toBe(
      'composition resolution failed: scene "b" cleanup threw: cleanup-b kaboom',
    );
  });

  it('aggregates an isolated timeline failure and a final-cleanup failure when no onSceneFailed is supplied (PUL-F029)', async () => {
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
    // The order is "scene failures first (mount/timeline), then final-phase cleanup errors."
    const messages = errors.map((e) => (e as Error).message);
    expect(messages).toContain(
      'composition resolution failed: scene "b" timeline threw: timeline-b kaboom',
    );
    expect(messages).toContain(
      'composition resolution failed: scene "a" cleanup threw: cleanup-a kaboom',
    );
    // Both scenes' cleanups ran — b's at compose-time, a's at the end.
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

  it('invokes onSceneCleaned after each scene cleanup, in reverse mount order (PUL-F024)', async () => {
    const log: string[] = [];
    const recordCleaned = (activation: SceneActivation): void => {
      log.push(`cleaned:${activation.sceneId}`);
    };
    await run({
      scenes: [recordingScene('a', log), recordingScene('b', log), recordingScene('c', log)],
      manifest: ['a', 'b', 'c'],
      onSceneCleaned: recordCleaned,
    });
    expect(log.slice(-6)).toEqual([
      'cleanup:c',
      'cleaned:c',
      'cleanup:b',
      'cleaned:b',
      'cleanup:a',
      'cleaned:a',
    ]);
  });

  it('still invokes onSceneCleaned for a scene whose cleanup threw, and aggregates an onSceneCleaned throw', async () => {
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
      ],
      manifest: ['a', 'b'],
      onSceneCleaned: (activation) => {
        log.push(`cleaned:${activation.sceneId}`);
        if (activation.sceneId === 'a') throw new Error('hook-a kaboom');
      },
    }).catch((err: unknown) => {
      caught = err;
    });
    // b cleaned (threw) → hook(b) → a cleaned → hook(a) (threw).
    expect(log.slice(-4)).toEqual(['cleanup:b', 'cleaned:b', 'cleanup:a', 'cleaned:a']);
    expect(caught).toBeInstanceOf(AggregateError);
    const messages = (caught as AggregateError).errors.map((e) => (e as Error).message);
    expect(messages).toContain(
      'composition resolution failed: scene "b" cleanup threw: cleanup-b kaboom',
    );
    expect(messages).toContain(
      'composition resolution failed: scene "a" onSceneCleaned threw: hook-a kaboom',
    );
  });
});

describe('resolveComposition — PUL-F029 scene-level error isolation', () => {
  it('cascades a create failure: scene cleanup ALSO throws, both events surface via onSceneFailed', async () => {
    const log: string[] = [];
    const failed: SceneFailureEvent[] = [];
    await run({
      scenes: [
        recordingScene('a', log),
        recordingScene('b', log, {
          create: () => {
            throw new Error('create kaboom');
          },
          cleanup: () => {
            throw new Error('cleanup-b kaboom');
          },
        }),
        recordingScene('c', log),
      ],
      manifest: ['a', 'b', 'c'],
      onSceneFailed: (event) => failed.push(event),
    });
    // The composition still completed for a and c.
    expect(log).toEqual([
      'create:a',
      // b.create threw, b.cleanup throws too (no log push from the spy),
      'create:c',
      'timeline:a',
      'timeline:c',
      'cleanup:c',
      'cleanup:a',
    ]);
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ phase: 'create', sceneId: 'b', message: 'create kaboom' });
    expect(failed[1]).toMatchObject({
      phase: 'cleanup',
      sceneId: 'b',
      message: 'cleanup-b kaboom',
    });
  });

  it('surfaces a final-cleanup failure via onSceneFailed and does NOT reject the resolver (PUL-F029)', async () => {
    // PUL-F029 / ADR-028: when `onSceneFailed` is wired, the resolver
    // fans out every per-scene failure (mount / compose / cleanup)
    // through the callback and completes normally. Re-throwing the
    // same information through `resolveComposition`'s return value
    // would route the loader into its fatal navigation-error surface,
    // which is the very behavior PUL-F029 forbids.
    const log: string[] = [];
    const failed: SceneFailureEvent[] = [];
    let caught: unknown;
    await run({
      scenes: [
        recordingScene('a', log, {
          cleanup: () => {
            log.push('cleanup:a');
            throw new Error('cleanup-a kaboom');
          },
        }),
      ],
      manifest: ['a'],
      onSceneFailed: (event) => failed.push(event),
    }).catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeUndefined();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      phase: 'cleanup',
      sceneId: 'a',
      message: 'cleanup-a kaboom',
    });
  });

  it('runs the composition with zero segments when every scene fails to create (no rejection if callback wired)', async () => {
    const log: string[] = [];
    const failed: SceneFailureEvent[] = [];
    const { adapter, calls } = recordingTimeline();
    await run({
      scenes: [
        recordingScene('a', log, {
          create: () => {
            throw new Error('a kaboom');
          },
        }),
        recordingScene('b', log, {
          create: () => {
            throw new Error('b kaboom');
          },
        }),
      ],
      manifest: ['a', 'b'],
      timeline: adapter,
      onSceneFailed: (event) => failed.push(event),
    });
    // Both scenes failed to create; adapter still runs with an empty slice;
    // no scenes need final cleanup.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.segments).toEqual([]);
    expect(failed.map((e) => e.sceneId)).toEqual(['a', 'b']);
    expect(failed.every((e) => e.phase === 'create')).toBe(true);
  });

  it('preserves the cause via Error.cause on the SceneFailureEvent', async () => {
    const cause = new Error('create kaboom');
    const failed: SceneFailureEvent[] = [];
    await run({
      scenes: [
        scene('a', {
          create: () => {
            throw cause;
          },
        }),
      ],
      manifest: ['a'],
      onSceneFailed: (event) => failed.push(event),
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]?.cause).toBe(cause);
  });

  it('invokes onSceneCleaned for an eagerly-cleaned scene whose create threw (audio teardown invariant)', async () => {
    // Codex review cycle 1 finding: when create/timeline throws and
    // the resolver eagerly cleans the failing scene, the per-scene
    // post-cleanup hook (which the loader wires to
    // `audio.stopGroup(sceneId)` per ADR-004) MUST still fire — a
    // scene that played grouped audio during `create` before throwing
    // would otherwise leak that group while the surviving composition
    // continues.
    const log: string[] = [];
    const cleaned: string[] = [];
    await run({
      scenes: [
        recordingScene('a', log),
        recordingScene('b', log, {
          create: () => {
            throw new Error('boom');
          },
        }),
        recordingScene('c', log),
      ],
      manifest: ['a', 'b', 'c'],
      onSceneCleaned: (activation) => cleaned.push(activation.sceneId),
      onSceneFailed: () => undefined,
    });
    // b was eagerly cleaned (its `cleanup` ran AND `onSceneCleaned`
    // fired) → c was mounted and ran → final cleanup of c, a in
    // reverse mount order. b's hook firing in the middle of the
    // mount loop is the new invariant.
    expect(cleaned).toEqual(['b', 'c', 'a']);
  });

  it('invokes onSceneCleaned for an eagerly-cleaned scene whose timeline threw', async () => {
    const log: string[] = [];
    const cleaned: string[] = [];
    await run({
      scenes: [
        recordingScene('a', log),
        recordingScene('b', log, {
          timeline: () => {
            throw new Error('boom');
          },
        }),
        recordingScene('c', log),
      ],
      manifest: ['a', 'b', 'c'],
      onSceneCleaned: (activation) => cleaned.push(activation.sceneId),
      onSceneFailed: () => undefined,
    });
    // All three mounted; b's timeline throws at compose-time → b is
    // eagerly cleaned AND its hook fires → c contributes a segment →
    // adapter runs → final cleanup of c, a (b already cleaned).
    expect(cleaned).toEqual(['b', 'c', 'a']);
  });

  it('aggregates onSceneCleaned hook throws even when onSceneFailed is wired (hook errors are workbench bugs, not scene failures)', async () => {
    // Codex review cycle 1 finding: when onSceneFailed is wired, the
    // resolver fans out per-scene failures through the callback and
    // returns normally — but a throw from `onSceneCleaned` (the
    // workbench-supplied audio teardown hook) is NOT a scene failure
    // and must NOT be swallowed. It aggregates into the resolver's
    // throw regardless of `onSceneFailed`.
    const failed: SceneFailureEvent[] = [];
    let caught: unknown;
    await run({
      scenes: [scene('a')],
      manifest: ['a'],
      onSceneCleaned: () => {
        throw new Error('hook kaboom');
      },
      onSceneFailed: (event) => failed.push(event),
    }).catch((err: unknown) => {
      caught = err;
    });
    expect(failed).toEqual([]); // hook errors don't go through onSceneFailed
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as Error).message).toContain('1 cleanup hook(s) threw');
    expect((caught as AggregateError).errors).toHaveLength(1);
    expect(((caught as AggregateError).errors[0] as Error).message).toBe(
      'composition resolution failed: scene "a" onSceneCleaned threw: hook kaboom',
    );
  });

  it('SceneFailureEvent carries the manifest entry index (ADR-028 diagnostic contract)', async () => {
    const failed: SceneFailureEvent[] = [];
    await run({
      scenes: [
        scene('a'),
        scene('b', {
          create: () => {
            throw new Error('b kaboom');
          },
        }),
        scene('c', {
          timeline: () => {
            throw new Error('c kaboom');
          },
        }),
      ],
      manifest: ['a', 'b', 'c'],
      onSceneFailed: (event) => failed.push(event),
    });
    const byId = new Map(failed.map((e) => [e.sceneId, e.entryIndex] as const));
    expect(byId.get('b')).toBe(1);
    expect(byId.get('c')).toBe(2);
  });

  it('catches a throw from onSceneFailed so it cannot break mandatory cleanup (codex review, cycle 2)', async () => {
    // Codex review cycle 2 finding: if the diagnostic sink throws,
    // the resolver MUST NOT let that interrupt the cleanup-then-
    // continue invariant — a buggy logger could otherwise strand
    // surviving scenes uncleaned. The throw is collected as a hook
    // error (workbench bug, same shape as `onSceneCleaned` throws)
    // and the lifecycle continues.
    const log: string[] = [];
    let caught: unknown;
    await run({
      scenes: [
        recordingScene('a', log),
        recordingScene('b', log, {
          create: () => {
            throw new Error('create kaboom');
          },
        }),
        recordingScene('c', log),
      ],
      manifest: ['a', 'b', 'c'],
      onSceneFailed: () => {
        throw new Error('logger kaboom');
      },
    }).catch((err: unknown) => {
      caught = err;
    });
    // The composition still completed for a and c.
    expect(log).toEqual([
      'create:a',
      // b.create threw, b.cleanup ran eagerly (logging cleanup:b),
      'cleanup:b',
      'create:c',
      'timeline:a',
      'timeline:c',
      'cleanup:c',
      'cleanup:a',
    ]);
    // The logger throw aggregates as a hook error.
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as Error).message).toContain('cleanup hook(s) threw');
    expect(
      (caught as AggregateError).errors.some(
        (e) =>
          e instanceof Error && /onSceneFailed threw: logger kaboom/.test((e as Error).message),
      ),
    ).toBe(true);
  });

  it('re-checks the abort signal after eager cleanup so a superseded navigation does not preload the next scene (codex review, cycle 2)', async () => {
    // Codex review cycle 2 finding: without a post-eager-cleanup abort
    // checkpoint, a navigation aborted DURING the failed scene's
    // cleanup would still kick off the next scene's preload + create —
    // breaking cleanup-before-handoff. This test simulates an abort
    // happening inside `cleanup` and pins that the next scene's
    // preload is NOT called.
    const log: string[] = [];
    const controller = new AbortController();
    const preloadAssets = (s: SceneModule): void => {
      log.push(`preload:${s.id}`);
    };
    let caught: unknown;
    await run({
      scenes: [
        recordingScene('a', log, {
          create: () => {
            throw new Error('create kaboom');
          },
          cleanup: () => {
            controller.abort('navigated away');
          },
        }),
        recordingScene('b', log),
      ],
      manifest: ['a', 'b'],
      preloadAssets,
      signal: controller.signal,
    }).catch((err: unknown) => {
      caught = err;
    });
    // a's preload ran; a's cleanup ran (and aborted); b's preload did NOT run.
    expect(log).toEqual(['preload:a']);
    expect((caught as Error).message).toContain('aborted after isolating "a" create failure');
  });

  it('preload failures are NOT scene failures: they still abort the composition (ADR-028 non-goal)', async () => {
    // Preload errors keep their existing boundary — only create / timeline /
    // cleanup go through the PUL-F029 isolation path.
    const failed: SceneFailureEvent[] = [];
    const preloadAssets = (s: SceneModule): void => {
      if (s.id === 'b') throw new Error('preload kaboom');
    };
    await expect(
      run({
        scenes: [scene('a'), scene('b'), scene('c')],
        manifest: ['a', 'b', 'c'],
        preloadAssets,
        onSceneFailed: (event) => failed.push(event),
      }),
    ).rejects.toThrow(
      'composition resolution failed: scene "b" preloadAssets threw: preload kaboom',
    );
    expect(failed).toEqual([]);
  });
});

// The two most fragile invariants of the lifecycle, exercised on EVERY
// failure path with BOTH error-routing wirings (onSceneFailed supplied /
// omitted):
//   1. cleanup runs EXACTLY ONCE per scene activation;
//   2. the AggregateError-vs-onSceneFailed selection — a supplied
//      callback isolates the failing scene and the resolver resolves;
//      an omitted callback isolates mid-flight but aggregates at the end.
// The cases parameterize over the wiring so the symmetry is mechanical
// and a regression on either path fails loudly.
describe('resolveComposition — cleanup-exactly-once + error routing on every failure path', () => {
  /**
   * A scene whose `create` / `timeline` / `cleanup` push
   * `<phase>:<id>#<n>` into `log`, where `<n>` is the per-occurrence call
   * ordinal for that phase. Lets a test assert exactly-once cleanup per
   * activation by counting `cleanup:<id>#<n>` lines.
   */
  const occScene = (id: string, log: string[], throwIn?: 'create' | 'timeline' | 'cleanup') => {
    const counters = { create: 0, timeline: 0, cleanup: 0 };
    const step = (phase: 'create' | 'timeline' | 'cleanup'): void => {
      const n = counters[phase];
      counters[phase] += 1;
      log.push(`${phase}:${id}#${n}`);
      if (throwIn === phase) throw new Error(`${id} ${phase} boom`);
    };
    return scene(id, {
      create: () => step('create'),
      timeline: () => {
        step('timeline');
        return null;
      },
      cleanup: () => step('cleanup'),
    });
  };

  const cleanupLines = (log: readonly string[]): string[] =>
    log.filter((l) => l.startsWith('cleanup:'));

  describe.each([
    { wired: true, label: 'onSceneFailed supplied' },
    { wired: false, label: 'onSceneFailed omitted' },
  ])('$label', ({ wired }) => {
    const sink = (
      events: SceneFailureEvent[],
    ): { onSceneFailed?: (e: SceneFailureEvent) => void } =>
      wired ? { onSceneFailed: (e) => events.push(e) } : {};

    it('create-throw: failing scene cleaned exactly once, sibling runs, routing correct', async () => {
      const log: string[] = [];
      const events: SceneFailureEvent[] = [];
      const promise = run({
        scenes: [occScene('a', log, 'create'), occScene('b', log)],
        manifest: ['a', 'b'],
        ...sink(events),
      });
      if (wired) {
        await promise;
        expect(events.map((e) => `${e.sceneId}:${e.phase}`)).toEqual(['a:create']);
      } else {
        const err = await promise.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AggregateError);
      }
      // a: create throws → eager cleanup once. b: full lifecycle, cleaned once.
      expect(cleanupLines(log)).toEqual(['cleanup:a#0', 'cleanup:b#0']);
    });

    it('timeline-throw: failing scene cleaned exactly once, sibling runs, routing correct', async () => {
      const log: string[] = [];
      const events: SceneFailureEvent[] = [];
      const promise = run({
        scenes: [occScene('a', log, 'timeline'), occScene('b', log)],
        manifest: ['a', 'b'],
        ...sink(events),
      });
      if (wired) {
        await promise;
        expect(events.map((e) => `${e.sceneId}:${e.phase}`)).toEqual(['a:timeline']);
      } else {
        const err = await promise.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AggregateError);
      }
      // a: timeline throws → eager cleanup once (in mount order, before b's
      // final cleanup). b: cleaned once.
      expect(cleanupLines(log)).toEqual(['cleanup:a#0', 'cleanup:b#0']);
    });

    it('cleanup-throw: failing scene still cleaned exactly once, routing correct', async () => {
      const log: string[] = [];
      const events: SceneFailureEvent[] = [];
      const promise = run({
        scenes: [occScene('a', log, 'cleanup'), occScene('b', log)],
        manifest: ['a', 'b'],
        ...sink(events),
      });
      if (wired) {
        await promise;
        expect(events.map((e) => `${e.sceneId}:${e.phase}`)).toEqual(['a:cleanup']);
      } else {
        const err = await promise.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AggregateError);
      }
      // Reverse-order final cleanup: b then a. a's throwing cleanup ran once.
      expect(cleanupLines(log)).toEqual(['cleanup:b#0', 'cleanup:a#0']);
    });

    it('abort-mid-mount: mounted scene cleaned exactly once, next never touched', async () => {
      const log: string[] = [];
      const events: SceneFailureEvent[] = [];
      const controller = new AbortController();
      const a = scene('a', {
        create: async () => {
          log.push('create:a#0');
          controller.abort();
          await flushMicrotasks();
        },
        cleanup: () => log.push('cleanup:a#0'),
      });
      const err = await run({
        scenes: [a, occScene('b', log)],
        manifest: ['a', 'b'],
        signal: controller.signal,
        ...sink(events),
      }).catch((e: unknown) => e);
      // Abort is a composition-wide failure (NOT a scene failure): routing
      // is identical on both wirings — the abort wrapper re-raises and
      // onSceneFailed is never invoked.
      expect((err as Error).message).toContain('aborted after mounting "a"');
      expect(events).toEqual([]);
      // a mounted → cleaned exactly once; b never preloaded/created/cleaned.
      expect(cleanupLines(log)).toEqual(['cleanup:a#0']);
      expect(log).toEqual(['create:a#0', 'cleanup:a#0']);
    });

    it('repeated-id with one occurrence failing: each occurrence cleaned exactly once', async () => {
      // One scene module, referenced twice; the FIRST occurrence's create
      // throws. The failing occurrence is isolated (eager cleanup) and the
      // sibling occurrence runs its full lifecycle — each activation is
      // cleaned exactly once.
      const log: string[] = [];
      const events: SceneFailureEvent[] = [];
      let createCalls = 0;
      const intro = scene('intro', {
        create: () => {
          const occurrence = createCalls;
          createCalls += 1;
          log.push(`create:intro#${occurrence}`);
          if (occurrence === 0) throw new Error('first intro boom');
        },
        timeline: () => null,
        cleanup: () => log.push('cleanup:intro'),
      });
      const promise = run({ scenes: [intro], manifest: ['intro', 'intro'], ...sink(events) });
      if (wired) {
        await promise;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ sceneId: 'intro', occurrence: 0, phase: 'create' });
      } else {
        const err = await promise.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AggregateError);
      }
      // Two activations, two cleanups: intro#0 eager-cleaned on its create
      // throw, intro#1 cleaned at the end. Exactly one cleanup per occurrence.
      expect(log.filter((l) => l === 'cleanup:intro')).toHaveLength(2);
    });
  });
});

describe('runLifecycle — bare engine (no onSceneFailed / AggregateError layer)', () => {
  // The bare engine is driven directly here — NOT through resolveComposition
  // — with a plain collecting `reportFailure`. This proves clause (d)'s
  // objective: the orchestrator is testable bare, so the lifecycle-order
  // and cleanup-exactly-once invariants can be asserted without the
  // scene-failure-isolation decorator's fan-out / aggregate selection.

  /** A bare `LifecycleContext` whose `reportFailure` just collects into an array. */
  const bareContext = (
    onSceneCleaned?: (a: SceneActivation) => void,
  ): {
    lc: LifecycleContext;
    reported: { phase: SceneFailurePhase; step: PlanStep; cause: unknown }[];
    bucket: FailureBucket;
  } => {
    const reported: { phase: SceneFailurePhase; step: PlanStep; cause: unknown }[] = [];
    const bucket: FailureBucket = { sceneFailureErrors: [], hookErrors: [] };
    const lc: LifecycleContext = {
      signal: undefined,
      onSceneCleaned,
      bucket,
      reportFailure: (phase, step, cause) => reported.push({ phase, step, cause }),
    };
    return { lc, reported, bucket };
  };

  const plan = (scenes: readonly SceneModule[], ctx: unknown = {}): readonly PlanStep[] =>
    buildPlan(
      scenes.map((s) => s.id),
      createSceneRegistry([...scenes]),
      () => ctx,
    );

  it('drives mount → compose → run → reverse cleanup and returns "completed"', async () => {
    const log: string[] = [];
    const { adapter } = recordingTimeline({ kind: 'resolve' }, log);
    const { lc, reported } = bareContext();
    const outcome = await runLifecycle(
      plan([recordingScene('a', log), recordingScene('b', log)]),
      () => undefined,
      adapter,
      {},
      lc,
    );
    expect(outcome).toEqual({ kind: 'completed' });
    expect(log).toEqual([
      'create:a',
      'create:b',
      'timeline:a',
      'timeline:b',
      'run',
      'cleanup:b',
      'cleanup:a',
    ]);
    expect(reported).toEqual([]);
  });

  it('routes a create throw through the bare reportFailure and still cleans up exactly once', async () => {
    const log: string[] = [];
    const a = scene('a', {
      create: () => {
        log.push('create:a');
        throw new Error('a boom');
      },
      cleanup: () => log.push('cleanup:a'),
    });
    const { lc, reported, bucket } = bareContext();
    const outcome = await runLifecycle(
      plan([a, recordingScene('b', log)]),
      () => undefined,
      recordingTimeline({ kind: 'resolve' }, log).adapter,
      {},
      lc,
    );
    expect(outcome).toEqual({ kind: 'completed' });
    // The bare engine fanned the failure ONLY through `reportFailure`; it
    // made no aggregate decision and the bucket stays untouched (the
    // collecting stub did not write to it).
    expect(reported.map((r) => `${r.step.scene.id}:${r.phase}`)).toEqual(['a:create']);
    expect(bucket.sceneFailureErrors).toEqual([]);
    // a eager-cleaned once on its create throw; b ran its full lifecycle.
    expect(log.filter((l) => l.startsWith('cleanup:'))).toEqual(['cleanup:a', 'cleanup:b']);
  });

  it('surfaces an adapter run rejection as a "phase-error" outcome after cleanup', async () => {
    const log: string[] = [];
    const boom = new Error('adapter boom');
    const { lc } = bareContext();
    const outcome = await runLifecycle(
      plan([recordingScene('a', log)]),
      () => undefined,
      recordingTimeline({ kind: 'reject', error: boom }, log).adapter,
      {},
      lc,
    );
    expect(outcome.kind).toBe('phase-error');
    if (outcome.kind === 'phase-error') {
      expect((outcome.error as Error).cause).toBe(boom);
    }
    // Cleanup still ran for the mounted scene.
    expect(log).toContain('cleanup:a');
  });

  it('reports an "aborted" outcome when the signal aborts during a parked run', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const reason = new Error('superseded');
    const { reported } = bareContext();
    const lc = buildLifecycleContext(controller.signal, undefined, undefined, {
      sceneFailureErrors: [],
      hookErrors: [],
    });
    const promise = runLifecycle(
      plan([recordingScene('a', log)]),
      () => undefined,
      recordingTimeline({ kind: 'park' }, log).adapter,
      { signal: controller.signal },
      lc,
    );
    await flushMicrotasks();
    controller.abort(reason);
    const outcome = await promise;
    expect(outcome).toEqual({ kind: 'aborted', reason });
    expect(log).toContain('cleanup:a');
    expect(reported).toEqual([]);
  });
});
