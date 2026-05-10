import { describe, expect, it, vi } from 'vitest';
import {
  type Caption,
  type CompositionTimelineAdapter,
  type CompositionTimelineRunOptions,
  type FakeStage,
  type LegacyRunInput,
  NAVIGATION_MODES,
  type NavigationMode,
  type NavigationTarget,
  type PrompterRenderer,
  type PrompterScript,
  type SceneLoaderOptions,
  type SceneModule,
  type SceneTimelineSegment,
  type StageElement,
  type TimelineRunCall,
  type WorkbenchSceneCtx,
  asTimeline,
  buildScene,
  buildStage,
  compositionIndexTarget,
  compositionSceneTarget,
  compositionTarget,
  createCompositionRegistry,
  createPresenterController,
  createSceneLoader,
  createSceneRegistry,
  gsap,
  noneTarget,
  noopTimeline,
  recordingTimeline,
  sceneTarget,
  stubCtx,
} from './scene-loader.helpers';

describe('createSceneLoader — paused & scrub modes (PUL-F008)', () => {
  describe('paused-mode runner hold-hint forwarding (PUL-F016)', () => {
    // PUL-F016 statement: in `mode=paused`, the runtime SHALL mount
    // the addressed scene and hold it at its first frame without
    // advancing the timeline.
    //
    // Materially-implementable parts of the statement that this
    // block pins (ADR-019 records the contract boundary):
    //   - The loader passes `hold: 'first-frame'` to the timeline
    //     runner adapter when `effectiveMode(target) === 'paused'`.
    //     The runner is responsible for honoring the hint (e.g.
    //     ADR-003's future GSAP runner uses `timeline.pause()` at
    //     time 0).
    //   - The hint is HEAD-ONLY: under composition targets the head
    //     scene's runner input carries `hold`; following entries do
    //     not. Following entries do not run at all because the slice
    //     is truncated to the addressed head — same structural
    //     defense ADR-018 records for `mode=loop`.
    //   - `ctx.mode === 'paused'` reaches every lifecycle hook of
    //     the head scene — the seam future runner / chrome / audio
    //     surfaces will read.
    //   - Other modes (`present`, `standalone`, `loop`, `scrub`,
    //     `screenshot`, `prompter`) and a `mode`-less URL DO NOT
    //     set `hold`. A regression that broadcast `hold` under any
    //     mode would break URLs that depend on no-hold semantics
    //     (e.g. normal playback under `present`).
    //   - No `data-pulsar-mode-*` suppression attribute is preempt-
    //     ively written under `paused` (parity with ADR-016/017/018).
    //   - Composition validation (unregistered composition, unknown
    //     member scene, out-of-range index) STILL surfaces as a
    //     navigation error under `mode=paused` — no silent fallback
    //     to direct scene lookup.
    //   - Beat semantics under `mode=paused` are unchanged from
    //     PUL-F011 at the loader: the head scene's runner sees
    //     `input.beat`; missing-label diagnostics surface via
    //     `data-pulsar-navigation-error` / `onError` without
    //     unmounting. ADR-019 records the runner-side policy that
    //     `hold='first-frame'` wins over `beat` when both are
    //     present, but that is a runner-side semantic, not a
    //     loader-side filter — the loader forwards both.
    //   - Object-form head entry's `range` / `behavior` overrides
    //     reach the runner unchanged. Paused is single-scene-mount
    //     with held timeline at the head, NOT direct-scene
    //     flattening.
    //
    // PUL-F016 stays DRAFT after this PR (ADR-019 records the
    // boundary; following the ADR-016 / ADR-017 / ADR-018 / PUL-F013
    // / PUL-F014 / PUL-F015 precedent). The seam — the loader passes
    // `hold: 'first-frame'` and `ctx.mode === 'paused'` — IS
    // materially shipped. The actual hold-at-first-frame behavior is
    // the runner's contract: ADR-003's GSAP runner reads
    // `input.hold` when it lands. Until then, the placeholder runner
    // has no real timeline (returns `null`) and parks until abort —
    // vacuously satisfying "hold it at its first frame without
    // advancing" because no frame ever advances. ACTIVE transitions
    // when the GSAP runner actively reads `input.hold ===
    // 'first-frame'` and pauses the timeline at time 0, with an
    // end-to-end test alongside these seam tests.

    const pausedSceneTarget = (id: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      mode: 'paused',
    });
    const pausedCompositionTarget = (composition: string): NavigationTarget => ({
      locator: { kind: 'composition', composition },
      mode: 'paused',
    });
    const pausedCompositionSceneTarget = (
      composition: string,
      scene: string,
    ): NavigationTarget => ({
      locator: { kind: 'composition-scene', composition, scene },
      mode: 'paused',
    });
    const pausedCompositionIndexTarget = (
      composition: string,
      index: number,
    ): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'paused',
    });

    it('passes `hold: "first-frame"` to the runner for a `scene` target under `mode=paused`', async () => {
      // Direct-scene navigation is the simplest paused path: the
      // addressed scene IS the head, no slice resolution. A
      // regression that gated `hold` on `target.composition` being
      // defined would silently drop the hint here.
      const captured: { sceneId: string; hold: 'first-frame' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, hold: input.hold });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      await loader.handle(pausedSceneTarget('scene-a'));

      expect(captured).toEqual([{ sceneId: 'scene-a', hold: 'first-frame' }]);
    });

    it('runs only the head scene of a `composition` target under `mode=paused` (slice truncation; runner sees `hold: "first-frame"` for the head)', async () => {
      // PUL-F016 / ADR-019: paused truncates the validated
      // composition slice to the addressed head, parallel to
      // standalone (ADR-017) and loop (ADR-018). Truncation makes
      // "no following entries run" a structural guarantee — a
      // runner bug or no-op runner under `mode=paused` MUST NOT
      // silently degrade into normal composition playback. Use a
      // non-final-index navigation so the slice has successors that
      // would be observable if truncation were missing.
      const captured: { sceneId: string; hold: 'first-frame' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, hold: input.hold });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      await loader.handle(pausedCompositionIndexTarget('full-talk', 0));

      expect(captured).toEqual([{ sceneId: 'scene-a', hold: 'first-frame' }]);
    });

    it('runs only the addressed scene of a `composition+scene` target under `mode=paused`', async () => {
      // composition+scene targeting a non-final entry exercises the
      // slice transform from a different locator shape; pins parity
      // with the composition-target case above.
      const captured: { sceneId: string; hold: 'first-frame' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, hold: input.hold });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      await loader.handle(pausedCompositionSceneTarget('full-talk', 'scene-b'));

      expect(captured).toEqual([{ sceneId: 'scene-b', hold: 'first-frame' }]);
    });

    it('runs cleanup exactly once for the head scene under `mode=paused`, never for dropped slice entries', async () => {
      // Same invariant as PUL-F014 (ADR-017) under standalone and
      // PUL-F015 (ADR-018) under loop: a regression that dropped
      // the slice for execution but left following scenes wired
      // through the synthesized registry could double-clean or
      // skip-clean. Pin exactly-once cleanup on the head and zero
      // cleanup for the dropped entries.
      const cleaned: string[] = [];
      const trace = (id: string): SceneModule =>
        buildScene({
          id,
          cleanup: () => {
            cleaned.push(id);
          },
        });
      const scenes = [trace('scene-a'), trace('scene-b'), trace('scene-c')];
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry(scenes),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
      });

      await loader.handle(pausedCompositionTarget('full-talk'));

      expect(cleaned).toEqual(['scene-a']);
    });

    it('a hold-until-abort runner under `mode=paused` keeps the head scene mounted until a new navigation supersedes it; cleanup fires only on abort, not on `hold` arrival (pins the runner-side pending-until-abort contract through the loader+resolver+navigation flow)', async () => {
      // ADR-019 makes pending-until-abort a structural part of the
      // hold contract: `resolveComposition()` awaits `runTimeline()`
      // and then runs `cleanup(ctx)`. A runner that observes
      // `input.hold === 'first-frame'`, calls `seek(0)` + `pause()`,
      // and resolves synchronously would let the resolver advance
      // to cleanup one turn after mount — the scene would unmount
      // immediately, contradicting "hold." This test models the
      // correct runner contract (pend until `input.signal.aborted`)
      // and pins the loader+resolver+navigation flow so a
      // regression that, for instance, made the resolver bypass
      // `runTimeline` under `hold`, or that dropped signal
      // forwarding to the runner under paused, would fail here.
      //
      // The placeholder runner in `src/main.ts` already follows
      // this shape (parks until abort with no real timeline);
      // ADR-003's GSAP runner must continue to follow it under
      // `hold`. The runner-side scene-author guarantee — "the
      // timeline does not advance" — is what the GSAP runner PR
      // additionally pins; this test pins the structural
      // mount-then-hold-then-abort-then-cleanup ordering, which is
      // a necessary precondition for the scene-author guarantee.
      const events: string[] = [];
      // Per-scene "runner entered" gates so the test can deterministic-
      // ally wait for the head scene's runner to reach the held state
      // without relying on a fragile microtask count. The lifecycle is
      // many-awaits-deep (queue → abortAndAwait → runOnce → runTarget
      // → loadSceneNavigationTarget → resolveComposition → runScene →
      // await create → await timeline → await runTimeline), so a fixed
      // `await Promise.resolve()` count is brittle.
      const enteredGates = new Map<string, Promise<void>>();
      const enteredResolvers = new Map<string, () => void>();
      const enteredGate = (id: string): Promise<void> => {
        const existing = enteredGates.get(id);
        if (existing !== undefined) return existing;
        let resolver: () => void = () => undefined;
        const promise = new Promise<void>((resolve) => {
          resolver = resolve;
        });
        enteredGates.set(id, promise);
        enteredResolvers.set(id, resolver);
        return promise;
      };
      // Pre-create the head's gate so the test code below can `await
      // enteredGate('scene-a')` even before the runner has run.
      enteredGate('scene-a');
      enteredGate('scene-b');
      const sceneA = buildScene({
        id: 'scene-a',
        create: () => {
          events.push('create:scene-a');
        },
        timeline: () => {
          events.push('timeline:scene-a');
          return null;
        },
        cleanup: () => {
          events.push('cleanup:scene-a');
        },
      });
      const sceneB = buildScene({
        id: 'scene-b',
        create: () => {
          events.push('create:scene-b');
        },
        timeline: () => {
          events.push('timeline:scene-b');
          return null;
        },
        cleanup: () => {
          events.push('cleanup:scene-b');
        },
      });
      const stage = buildStage();
      const runnerObservations: { sceneId: string; hold: unknown; hasSignal: boolean }[] = [];
      const heldRunner = (input: LegacyRunInput) =>
        new Promise<void>((resolve) => {
          runnerObservations.push({
            sceneId: input.scene.id,
            hold: input.hold,
            hasSignal: input.signal !== undefined,
          });
          events.push(`runTimeline-enter:${input.scene.id}`);
          enteredResolvers.get(input.scene.id)?.();
          // Pend until the per-navigation signal aborts. This is the
          // shape the placeholder runner uses today and the shape
          // ADR-019 requires of the future GSAP runner under `hold`.
          // Without `input.signal`, the test misuses the contract.
          if (input.signal === undefined) {
            // Defensive: assert the seam exists. A regression that
            // dropped signal forwarding under paused would surface
            // here rather than via the test-runner timeout.
            throw new Error('expected `input.signal` to be forwarded under `mode=paused`');
          }
          input.signal.addEventListener(
            'abort',
            () => {
              events.push(`runTimeline-aborted:${input.scene.id}`);
              resolve();
            },
            { once: true },
          );
        });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(heldRunner),
      });

      // Launch the paused navigation but do NOT await — the runner
      // is designed to pend, so awaiting here would hang. Instead,
      // drive a second navigation that aborts the first.
      const firstSettled = loader.handle(pausedSceneTarget('scene-a'));

      // Wait deterministically for the runner to enter. The gate
      // resolves the moment the runner observes its scene.
      await enteredGate('scene-a');

      // The held state: scene-a mounted, runner entered and
      // pending, NO cleanup yet. A regression that let cleanup run
      // immediately under `hold` would show `cleanup:scene-a` here.
      expect(events).toEqual(['create:scene-a', 'timeline:scene-a', 'runTimeline-enter:scene-a']);
      expect(runnerObservations).toEqual([
        { sceneId: 'scene-a', hold: 'first-frame', hasSignal: true },
      ]);

      // Now navigate elsewhere. The loader aborts the in-flight
      // load, the runner's signal listener fires, and cleanup runs
      // for scene-a before scene-b's lifecycle starts. The second
      // navigation is to a non-paused target so its runner sees
      // `'hold' in input === false`; we still use the heldRunner so
      // we can verify the lifecycle ordering before disposing.
      const secondSettled = loader.handle(sceneTarget('scene-b'));
      await enteredGate('scene-b');

      // Expected ordering up to scene-b entering its runner:
      // paused mount → held runner → abort → cleanup of scene-a →
      // mount of scene-b → held runner for scene-b.
      expect(events).toEqual([
        'create:scene-a',
        'timeline:scene-a',
        'runTimeline-enter:scene-a',
        'runTimeline-aborted:scene-a',
        'cleanup:scene-a',
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline-enter:scene-b',
      ]);

      // Dispose to release scene-b's runner gate so the test does
      // not leak a pending promise. Cleanup for scene-b fires after
      // dispose-triggered abort.
      loader.dispose();
      await firstSettled;
      await secondSettled;
      await loader.idle();

      expect(events).toEqual([
        'create:scene-a',
        'timeline:scene-a',
        'runTimeline-enter:scene-a',
        'runTimeline-aborted:scene-a',
        'cleanup:scene-a',
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline-enter:scene-b',
        'runTimeline-aborted:scene-b',
        'cleanup:scene-b',
      ]);
    });

    it('omits the `hold` key on the runner input when `mode=paused` is absent (key-presence semantics)', async () => {
      // The runner input uses key-presence semantics for optional
      // fields (parallel to `beat` / `repeat` / `range` /
      // `behavior`): a runner can branch on `'hold' in input`
      // rather than `=== undefined`. A regression that always set
      // `input.hold = undefined` (or any non-`'first-frame'` value)
      // under non-paused modes would break that contract.
      const captured: { hasHold: boolean; hold: unknown }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ hasHold: 'hold' in input, hold: input.hold });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      // No mode at all (defaults to `present`).
      await loader.handle(sceneTarget('scene-a'));

      expect(captured).toEqual([{ hasHold: false, hold: undefined }]);
    });

    it('does not set `hold` for any non-paused, lifecycle-running mode', async () => {
      // Walk the seven-mode allowlist (minus `paused` and
      // `prompter`) and confirm that none of them produce `hold` on
      // the runner input. Catching every non-paused mode
      // discriminates against an over-broad fix that gated `hold` on
      // `mode !== undefined` rather than `mode === 'paused'`.
      // Capturing the per-iteration mode alongside the
      // `'hold' in input` flag means the assertion failure
      // identifies WHICH mode regressed, not just "some mode did."
      //
      // PUL-F019 / ADR-022: `prompter` does not invoke `runTimeline`
      // (lifecycle bypassed); the dedicated F019 block pins that
      // invariant. Filter prompter out here so this test stays
      // focused on lifecycle-running modes.
      const nonPausedLifecycleModes = NAVIGATION_MODES.filter(
        (m) => m !== 'paused' && m !== 'prompter',
      );
      const captured: { mode: NavigationMode; hasHold: boolean }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      for (const mode of nonPausedLifecycleModes) {
        const runner = (input: LegacyRunInput) => {
          captured.push({ mode, hasHold: 'hold' in input });
        };
        const loader = createSceneLoader({
          scenes: createSceneRegistry([sceneA]),
          compositions: createCompositionRegistry([]),
          stage: stage.element,
          buildCtx: stubCtx,
          createPreloader: () => () => undefined,
          timeline: asTimeline(runner),
        });
        await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode });
      }

      // One entry per non-paused lifecycle mode, each must have
      // `hasHold: false`. Building the expected array from
      // `nonPausedLifecycleModes` keeps the assertion in sync if the
      // mode allowlist ever changes.
      expect(captured).toEqual(nonPausedLifecycleModes.map((mode) => ({ mode, hasHold: false })));
    });

    it('exposes `ctx.mode === "paused"` to every lifecycle hook of the head scene under all locator shapes', async () => {
      // Parallel to the PUL-F014 standalone and PUL-F015 loop seam
      // tests. Future runner / chrome / audio surfaces read
      // `ctx.mode` to decide their own behavior; this test pins the
      // seam end to end across all four locator shapes that can
      // appear under `mode=paused`.
      const seen: { phase: string; locatorKind: string; mode: unknown }[] = [];
      const recordMode =
        (phase: string, locatorKind: string) =>
        (ctx: unknown): unknown => {
          seen.push({ phase, locatorKind, mode: (ctx as { mode?: NavigationMode }).mode });
          return null;
        };
      const makeScene = (locatorKind: string): SceneModule =>
        buildScene({
          id: 'scene-a',
          create: recordMode('create', locatorKind),
          timeline: recordMode('timeline', locatorKind) as SceneModule['timeline'],
          cleanup: recordMode('cleanup', locatorKind),
        });
      const stage = buildStage();
      const buildLoader = (sceneId: string, locatorKind: string) =>
        createSceneLoader({
          scenes: createSceneRegistry([makeScene(locatorKind)]),
          compositions: createCompositionRegistry([{ id: 'full-talk', manifest: [sceneId] }]),
          stage: stage.element,
          buildCtx: (mode) => ({ stage: stage.element, mode, gsap }),
          createPreloader: () => () => undefined,
          timeline: noopTimeline,
        });

      await buildLoader('scene-a', 'scene').handle(pausedSceneTarget('scene-a'));
      await buildLoader('scene-a', 'composition').handle(pausedCompositionTarget('full-talk'));
      await buildLoader('scene-a', 'composition-scene').handle(
        pausedCompositionSceneTarget('full-talk', 'scene-a'),
      );
      await buildLoader('scene-a', 'composition-index').handle(
        pausedCompositionIndexTarget('full-talk', 0),
      );

      // 3 hooks per navigation × 4 locator shapes = 12 entries;
      // every single one must carry `paused`.
      expect(seen).toHaveLength(12);
      for (const entry of seen) {
        expect(entry.mode).toBe('paused');
      }
    });

    it('forwards `beat` to the head scene runner alongside `hold` under `mode=paused`, and surfaces missing-beat as a non-fatal diagnostic', async () => {
      // PUL-F011 / PUL-F016 are independent at the loader: a URL
      // like `?scene=x&beat=hook&mode=paused` must deliver both
      // `beat` and `hold` to the runner. ADR-019 records the
      // runner-side policy that `hold` wins over `beat` (paused is
      // first-frame; `mode=scrub` is the inspection mode for
      // beat-targeting), but that policy is the runner's contract,
      // not a loader-side filter. A regression that paired the
      // fields at the loader — e.g. dropping `hold` when `beat` is
      // supplied — would silently break paused-mode navigation
      // when a beat is also requested.
      const captured: {
        sceneId: string;
        beat: string | undefined;
        hold: 'first-frame' | undefined;
      }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const runner = (input: LegacyRunInput) => {
        captured.push({
          sceneId: input.scene.id,
          beat: input.beat,
          hold: input.hold,
        });
        if (input.beat !== undefined && input.onBeatMissing !== undefined) {
          input.onBeatMissing();
        }
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'paused',
        beat: 'midpoint',
      });

      expect(captured).toEqual([{ sceneId: 'scene-a', beat: 'midpoint', hold: 'first-frame' }]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('beat positioning failed');
      expect((errors[0] as Error).message).toContain('"midpoint"');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=paused`', async () => {
      // Mirrors ADR-016 / ADR-017 / ADR-018 invariant. PUL-F016
      // forbids the loader from preemptively writing a stage
      // attribute for paused mode; runner-side or future-surface-
      // side signaling lives at those surfaces, not at the loader.
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
      });

      await loader.handle(pausedSceneTarget('scene-a'));

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });

    it('writes both `data-pulsar-scene-target` and `data-pulsar-composition-target` for a composition target under `mode=paused` (preserves observability of what the URL addressed)', async () => {
      // The stage attrs communicate "what was addressed," not "what
      // ran." Truncation drops following entries from execution but
      // does not drop the composition id from the stage attrs —
      // mirrors the standalone / loop invariant.
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
      });

      await loader.handle(pausedCompositionSceneTarget('full-talk', 'scene-b'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-b');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
    });

    it('surfaces composition-not-registered as a navigation error under `mode=paused` (no silent fallback)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(pausedCompositionTarget('not-registered'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'composition "not-registered" is not registered',
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('surfaces composition-member error under `mode=paused` for an unknown scene in `composition+scene`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneZ = buildScene({ id: 'scene-z' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneZ]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(pausedCompositionSceneTarget('full-talk', 'scene-z'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'scene "scene-z" is not a member of composition "full-talk"',
      );
    });

    it('surfaces index-out-of-range under `mode=paused`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(pausedCompositionIndexTarget('full-talk', 5));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('index 5 is out of range');
    });

    it("preserves the addressed head entry's `range` and `behavior` overrides on the runner input under `mode=paused` (composition+index with object-form entry)", async () => {
      // PUL-F016 / ADR-019: paused truncates the validated
      // composition slice to the addressed head and forwards `hold`
      // to that head's runner input. The slice is TRUNCATED rather
      // than flattened — a flat `{ scene }` would lose object-form
      // `range` / `behavior` overrides on the head entry, turning
      // paused into direct-scene flattening (parity with ADR-017's
      // standalone and ADR-018's loop invariant). This pins all
      // three slots — `range`, `behavior`, and `hold` — through to
      // the head runner, plus the truncation itself (the runner
      // runs exactly once).
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const captured: {
        sceneId: string;
        range: unknown;
        behavior: unknown;
        hold: unknown;
      }[] = [];
      const runner = (input: LegacyRunInput) => {
        captured.push({
          sceneId: input.scene.id,
          range: input.range,
          behavior: input.behavior,
          hold: input.hold,
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          {
            id: 'full-talk',
            manifest: [
              'scene-a',
              { id: 'scene-b', range: 'hook', behavior: { hold: true } },
              'scene-c',
            ],
          },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      await loader.handle(pausedCompositionIndexTarget('full-talk', 1));

      // Single runner invocation (truncation), with overrides AND
      // `hold` reaching the head's runner input together. A
      // regression that flattened to direct-scene would show
      // `range: undefined, behavior: undefined`; a regression that
      // dropped truncation would show a second invocation for
      // scene-c.
      expect(captured).toEqual([
        {
          sceneId: 'scene-b',
          range: 'hook',
          behavior: { hold: true },
          hold: 'first-frame',
        },
      ]);
    });
  });

  describe('scrub-mode runner cue-gate-hint forwarding (PUL-F017)', () => {
    // PUL-F017 statement: in `mode=scrub`, the runtime SHALL display
    // timeline controls allowing the user to scrub forward, backward,
    // and to named beats. Audio cues SHALL fire only on monotonic
    // forward playback.
    //
    // Materially-implementable parts of the statement that this
    // block pins (ADR-020 records the contract boundary):
    //   - The loader passes `cueGate: 'monotonic-forward'` to the
    //     timeline runner adapter when
    //     `effectiveMode(target) === 'scrub'`. The runner is
    //     responsible for honoring the hint (e.g. ADR-003's future
    //     GSAP runner gates audio-cue firing by direction; ADR-004's
    //     future Howler integration is the consumer).
    //   - The hint is HEAD-ONLY: under composition targets the head
    //     scene's runner input carries `cueGate`; following entries
    //     do not. Following entries do not run at all because the
    //     slice is truncated to the addressed head — same structural
    //     defense ADR-018 / ADR-019 record for `mode=loop` /
    //     `mode=paused`.
    //   - `ctx.mode === 'scrub'` reaches every lifecycle hook of the
    //     head scene — the seam the future scrub-controls UI surface
    //     will read.
    //   - Other modes (`present`, `standalone`, `loop`, `paused`,
    //     `screenshot`, `prompter`) and a `mode`-less URL DO NOT set
    //     `cueGate`. A regression that broadcast `cueGate` under any
    //     mode would break URLs that depend on no-cue-gating
    //     semantics (e.g. normal playback under `present`).
    //   - No `data-pulsar-mode-*` suppression attribute is preempt-
    //     ively written under `scrub` (parity with ADR-016 / ADR-017
    //     / ADR-018 / ADR-019).
    //   - Composition validation (unregistered composition, unknown
    //     member scene, out-of-range index) STILL surfaces as a
    //     navigation error under `mode=scrub` — no silent fallback to
    //     direct scene lookup.
    //   - Beat semantics under `mode=scrub` are unchanged from
    //     PUL-F011 at the loader: the head scene's runner sees
    //     `input.beat`; missing-label diagnostics surface via
    //     `data-pulsar-navigation-error` / `onError` without
    //     unmounting. PUL-F017 explicitly names "to named beats" as
    //     part of scrub's UX, so beat forwarding under `scrub` is
    //     the natural scrub-to-beat path the future controls UI will
    //     drive.
    //   - Object-form head entry's `range` / `behavior` overrides
    //     reach the runner unchanged. Scrub is single-scene-mount
    //     with cue-gated playback at the head, NOT direct-scene
    //     flattening.
    //
    // PUL-F017 stays DRAFT after this PR (ADR-020 records the
    // boundary; following the ADR-016 / ADR-017 / ADR-018 / ADR-019 /
    // PUL-F013 / PUL-F014 / PUL-F015 / PUL-F016 precedent). The seam
    // — the loader passes `cueGate: 'monotonic-forward'` and
    // `ctx.mode === 'scrub'` — IS materially shipped. The actual
    // monotonic-forward cue-gating behavior is the runner's contract
    // (ADR-003's GSAP runner + ADR-004's audio engine when they
    // land) and the timeline-controls UI is a future workbench
    // chrome surface; both are required for ACTIVE.

    const scrubSceneTarget = (id: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      mode: 'scrub',
    });
    const scrubCompositionTarget = (composition: string): NavigationTarget => ({
      locator: { kind: 'composition', composition },
      mode: 'scrub',
    });
    const scrubCompositionSceneTarget = (composition: string, scene: string): NavigationTarget => ({
      locator: { kind: 'composition-scene', composition, scene },
      mode: 'scrub',
    });
    const scrubCompositionIndexTarget = (composition: string, index: number): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'scrub',
    });

    it('passes `cueGate: "monotonic-forward"` to the runner for a `scene` target under `mode=scrub`', async () => {
      // Direct-scene navigation is the simplest scrub path: the
      // addressed scene IS the head, no slice resolution. A
      // regression that gated `cueGate` on `target.composition`
      // being defined would silently drop the hint here.
      const captured: { sceneId: string; cueGate: 'monotonic-forward' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, cueGate: input.cueGate });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      await loader.handle(scrubSceneTarget('scene-a'));

      expect(captured).toEqual([{ sceneId: 'scene-a', cueGate: 'monotonic-forward' }]);
    });

    it('runs only the head scene of a `composition` target under `mode=scrub` (slice truncation; runner sees `cueGate: "monotonic-forward"` for the head)', async () => {
      // PUL-F017 / ADR-020: scrub truncates the validated
      // composition slice to the addressed head, parallel to
      // standalone (ADR-017), loop (ADR-018), and paused (ADR-019).
      // Truncation makes "no following entries run" a structural
      // guarantee — a runner bug or no-op runner under `mode=scrub`
      // MUST NOT silently degrade into normal composition playback.
      // Use a non-final-index navigation so the slice has successors
      // that would be observable if truncation were missing.
      const captured: { sceneId: string; cueGate: 'monotonic-forward' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, cueGate: input.cueGate });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      await loader.handle(scrubCompositionIndexTarget('full-talk', 0));

      expect(captured).toEqual([{ sceneId: 'scene-a', cueGate: 'monotonic-forward' }]);
    });

    it('runs only the addressed scene of a `composition+scene` target under `mode=scrub`', async () => {
      // composition+scene targeting a non-final entry exercises the
      // slice transform from a different locator shape; pins parity
      // with the composition-target case above.
      const captured: { sceneId: string; cueGate: 'monotonic-forward' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, cueGate: input.cueGate });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      await loader.handle(scrubCompositionSceneTarget('full-talk', 'scene-b'));

      expect(captured).toEqual([{ sceneId: 'scene-b', cueGate: 'monotonic-forward' }]);
    });

    it('runs cleanup exactly once for the head scene under `mode=scrub`, never for dropped slice entries', async () => {
      // Same invariant as PUL-F014 (ADR-017) under standalone,
      // PUL-F015 (ADR-018) under loop, PUL-F016 (ADR-019) under
      // paused: a regression that dropped the slice for execution
      // but left following scenes wired through the synthesized
      // registry could double-clean or skip-clean. Pin
      // exactly-once cleanup on the head and zero cleanup for the
      // dropped entries.
      const cleaned: string[] = [];
      const trace = (id: string): SceneModule =>
        buildScene({
          id,
          cleanup: () => {
            cleaned.push(id);
          },
        });
      const scenes = [trace('scene-a'), trace('scene-b'), trace('scene-c')];
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry(scenes),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
      });

      await loader.handle(scrubCompositionTarget('full-talk'));

      expect(cleaned).toEqual(['scene-a']);
    });

    it('omits the `cueGate` key on the runner input when `mode=scrub` is absent (key-presence semantics)', async () => {
      // The runner input uses key-presence semantics for optional
      // fields (parallel to `beat` / `repeat` / `hold` / `range` /
      // `behavior`): a runner can branch on `'cueGate' in input`
      // rather than `=== undefined`. A regression that always set
      // `input.cueGate = undefined` (or any non-`'monotonic-forward'`
      // value) under non-scrub modes would break that contract.
      const captured: { hasCueGate: boolean; cueGate: unknown }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ hasCueGate: 'cueGate' in input, cueGate: input.cueGate });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      // No mode at all (defaults to `present`).
      await loader.handle(sceneTarget('scene-a'));

      expect(captured).toEqual([{ hasCueGate: false, cueGate: undefined }]);
    });

    it('does not set `cueGate` for any non-scrub, lifecycle-running mode', async () => {
      // Walk the seven-mode allowlist (minus `scrub` and `prompter`)
      // and confirm that none of them produce `cueGate` on the
      // runner input. Catching every non-scrub mode discriminates
      // against an over-broad fix that gated `cueGate` on
      // `mode !== undefined` rather than `mode === 'scrub'`.
      // Capturing the per-iteration mode alongside the
      // `'cueGate' in input` flag means the assertion failure
      // identifies WHICH mode regressed, not just "some mode did."
      //
      // PUL-F019 / ADR-022: `prompter` does not invoke `runTimeline`
      // (lifecycle bypassed); the dedicated F019 block pins that
      // invariant.
      const nonScrubLifecycleModes = NAVIGATION_MODES.filter(
        (m) => m !== 'scrub' && m !== 'prompter',
      );
      const captured: { mode: NavigationMode; hasCueGate: boolean }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      for (const mode of nonScrubLifecycleModes) {
        const runner = (input: LegacyRunInput) => {
          captured.push({ mode, hasCueGate: 'cueGate' in input });
        };
        const loader = createSceneLoader({
          scenes: createSceneRegistry([sceneA]),
          compositions: createCompositionRegistry([]),
          stage: stage.element,
          buildCtx: stubCtx,
          createPreloader: () => () => undefined,
          timeline: asTimeline(runner),
        });
        await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode });
      }

      // One entry per non-scrub lifecycle mode, each must have
      // `hasCueGate: false`. Building the expected array from
      // `nonScrubLifecycleModes` keeps the assertion in sync if the
      // mode allowlist ever changes.
      expect(captured).toEqual(nonScrubLifecycleModes.map((mode) => ({ mode, hasCueGate: false })));
    });

    it('exposes `ctx.mode === "scrub"` to every lifecycle hook of the head scene under all locator shapes', async () => {
      // Parallel to the PUL-F014 standalone, PUL-F015 loop, and
      // PUL-F016 paused seam tests. Future runner / chrome / audio
      // surfaces (specifically the timeline-controls UI named in the
      // PUL-F017 statement) read `ctx.mode` to decide their own
      // behavior; this test pins the seam end to end across all four
      // locator shapes that can appear under `mode=scrub`.
      const seen: { phase: string; locatorKind: string; mode: unknown }[] = [];
      const recordMode =
        (phase: string, locatorKind: string) =>
        (ctx: unknown): unknown => {
          seen.push({ phase, locatorKind, mode: (ctx as { mode?: NavigationMode }).mode });
          return null;
        };
      const makeScene = (locatorKind: string): SceneModule =>
        buildScene({
          id: 'scene-a',
          create: recordMode('create', locatorKind),
          timeline: recordMode('timeline', locatorKind) as SceneModule['timeline'],
          cleanup: recordMode('cleanup', locatorKind),
        });
      const stage = buildStage();
      const buildLoader = (sceneId: string, locatorKind: string) =>
        createSceneLoader({
          scenes: createSceneRegistry([makeScene(locatorKind)]),
          compositions: createCompositionRegistry([{ id: 'full-talk', manifest: [sceneId] }]),
          stage: stage.element,
          buildCtx: (mode) => ({ stage: stage.element, mode, gsap }),
          createPreloader: () => () => undefined,
          timeline: noopTimeline,
        });

      await buildLoader('scene-a', 'scene').handle(scrubSceneTarget('scene-a'));
      await buildLoader('scene-a', 'composition').handle(scrubCompositionTarget('full-talk'));
      await buildLoader('scene-a', 'composition-scene').handle(
        scrubCompositionSceneTarget('full-talk', 'scene-a'),
      );
      await buildLoader('scene-a', 'composition-index').handle(
        scrubCompositionIndexTarget('full-talk', 0),
      );

      // 3 hooks per navigation × 4 locator shapes = 12 entries;
      // every single one must carry `scrub`.
      expect(seen).toHaveLength(12);
      for (const entry of seen) {
        expect(entry.mode).toBe('scrub');
      }
    });

    it('forwards `beat` to the head scene runner alongside `cueGate` under `mode=scrub`, and surfaces missing-beat as a non-fatal diagnostic', async () => {
      // PUL-F011 / PUL-F017 are independent at the loader: a URL
      // like `?scene=x&beat=hook&mode=scrub` must deliver both
      // `beat` and `cueGate` to the runner. PUL-F017 explicitly
      // mentions "named beats" as part of scrub's UX, so a
      // regression that dropped `beat` when `mode=scrub` is set
      // would silently break the natural scrub-to-beat path.
      const captured: {
        sceneId: string;
        beat: string | undefined;
        cueGate: 'monotonic-forward' | undefined;
      }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const runner = (input: LegacyRunInput) => {
        captured.push({
          sceneId: input.scene.id,
          beat: input.beat,
          cueGate: input.cueGate,
        });
        if (input.beat !== undefined && input.onBeatMissing !== undefined) {
          input.onBeatMissing();
        }
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'scrub',
        beat: 'midpoint',
      });

      expect(captured).toEqual([
        { sceneId: 'scene-a', beat: 'midpoint', cueGate: 'monotonic-forward' },
      ]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('beat positioning failed');
      expect((errors[0] as Error).message).toContain('"midpoint"');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=scrub`', async () => {
      // Mirrors ADR-016 / ADR-017 / ADR-018 / ADR-019 invariant.
      // PUL-F017 forbids the loader from preemptively writing a
      // stage attribute for scrub mode; runner-side or future-
      // surface-side signaling (the controls UI) lives at those
      // surfaces, not at the loader.
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
      });

      await loader.handle(scrubSceneTarget('scene-a'));

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });

    it('writes both `data-pulsar-scene-target` and `data-pulsar-composition-target` for a composition target under `mode=scrub` (preserves observability of what the URL addressed)', async () => {
      // The stage attrs communicate "what was addressed," not "what
      // ran." Truncation drops following entries from execution but
      // does not drop the composition id from the stage attrs —
      // mirrors the standalone / loop / paused invariant.
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
      });

      await loader.handle(scrubCompositionSceneTarget('full-talk', 'scene-b'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-b');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
    });

    it('surfaces composition-not-registered as a navigation error under `mode=scrub` (no silent fallback)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(scrubCompositionTarget('not-registered'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'composition "not-registered" is not registered',
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('surfaces composition-member error under `mode=scrub` for an unknown scene in `composition+scene`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneZ = buildScene({ id: 'scene-z' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneZ]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(scrubCompositionSceneTarget('full-talk', 'scene-z'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'scene "scene-z" is not a member of composition "full-talk"',
      );
    });

    it('surfaces index-out-of-range under `mode=scrub`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['scene-a'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle(scrubCompositionIndexTarget('full-talk', 5));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('index 5 is out of range');
    });

    it("preserves the addressed head entry's `range` and `behavior` overrides on the runner input under `mode=scrub` (composition+index with object-form entry)", async () => {
      // PUL-F017 / ADR-020: scrub truncates the validated
      // composition slice to the addressed head and forwards
      // `cueGate` to that head's runner input. The slice is
      // TRUNCATED rather than flattened — a flat `{ scene }` would
      // lose object-form `range` / `behavior` overrides on the head
      // entry, turning scrub into direct-scene flattening (parity
      // with ADR-017's standalone, ADR-018's loop, and ADR-019's
      // paused invariant). This pins all three slots — `range`,
      // `behavior`, and `cueGate` — through to the head runner,
      // plus the truncation itself (the runner runs exactly once).
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const captured: {
        sceneId: string;
        range: unknown;
        behavior: unknown;
        cueGate: unknown;
      }[] = [];
      const runner = (input: LegacyRunInput) => {
        captured.push({
          sceneId: input.scene.id,
          range: input.range,
          behavior: input.behavior,
          cueGate: input.cueGate,
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          {
            id: 'full-talk',
            manifest: [
              'scene-a',
              { id: 'scene-b', range: 'hook', behavior: { hold: true } },
              'scene-c',
            ],
          },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      await loader.handle(scrubCompositionIndexTarget('full-talk', 1));

      expect(captured).toEqual([
        {
          sceneId: 'scene-b',
          range: 'hook',
          behavior: { hold: true },
          cueGate: 'monotonic-forward',
        },
      ]);
    });
  });
});
