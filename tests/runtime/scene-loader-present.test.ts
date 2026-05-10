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

describe('createSceneLoader — present-mode & presenter seams (PUL-F008)', () => {
  describe('present-mode adapter seams (PUL-F013 boundary, NOT a PUL-F013 implementation)', () => {
    // PUL-F013 statement: in `mode=present`, the runtime SHALL render
    // full chrome, audio, and inter-scene transitions, and SHALL respond
    // to presenter input. NONE of the four facets has a corresponding
    // rendering / input surface in this repo today — chrome is a future
    // workbench-shell requirement, audio is reserved by ADR-004
    // (Howler.js), inter-scene transition RENDERING is reserved by
    // ADR-003 (GSAP timeline runner), and actual presenter input is
    // PUL-F020 / PUL-F021 / PUL-F025. The tests below DO NOT pin
    // PUL-F013's clauses end to end — they pin the underlying adapter
    // seams those four future surfaces will plug into, asserted under
    // `mode=present` so a future regression cannot quietly disable a
    // seam for the present value.
    //
    // PUL-F013 stays DRAFT until every facet its statement names
    // lands as a real rendering / input surface that adds its own
    // end-to-end "X renders / responds under mode=present" test
    // alongside these seam tests. ADR-016 records the boundary.
    //
    // The seams pinned here:
    //
    //   - The composition resolver's structural cleanup-before-next-
    //     create ordering — the lifecycle hook the GSAP runner will
    //     hang inter-scene transition rendering off (ADR-003 / ADR-011
    //     / PUL-F004).
    //   - The per-navigation `AbortSignal` forwarded to the runner —
    //     the seam PUL-F020 / F021 / F025 will drive when actual
    //     presenter input arrives (PUL-F006 / ADR-011).
    //   - `ctx.mode === 'present'` carried into every lifecycle hook —
    //     the hint chrome and audio surfaces will read when each lands
    //     (PUL-F012 / ADR-007).
    //   - Absence of any preemptive `data-pulsar-mode-*` suppression
    //     attribute on the stage under `present`.

    const presentTarget = (composition: string, index = 0): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'present',
    });
    const absentModeTarget = (composition: string, index = 0): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
    });

    interface LifecycleProbe {
      readonly log: string[];
      readonly scenes: readonly SceneModule[];
      readonly compositionId: string;
    }

    // Build a probe whose scene hooks (create / timeline / cleanup) all
    // write into ONE log, so a lifecycle-ordering test can pin the
    // ADR-025 order: mount every scene, compose their timelines, run the
    // master, then cleanup every scene in reverse.
    const buildLifecycleProbe = (compositionId = 'full-talk'): LifecycleProbe => {
      const log: string[] = [];
      const trace = (id: string): SceneModule =>
        buildScene({
          id,
          create: () => {
            log.push(`create:${id}`);
          },
          timeline: () => {
            log.push(`timeline:${id}`);
            return null;
          },
          cleanup: () => {
            log.push(`cleanup:${id}`);
          },
        });
      return {
        log,
        scenes: [trace('scene-a'), trace('scene-b'), trace('scene-c')],
        compositionId,
      };
    };

    it('runs every scene in a composition under `mode=present` — composed into one master timeline, in mount-all → compose → run → cleanup-all order (ADR-025; pins the inter-scene seam, NOT transition rendering)', async () => {
      // Inter-scene transition RENDERING is reserved by ADR-003's GSAP
      // runner. What this test pins is the lifecycle the future runner
      // hangs transition rendering off: ADR-025's resolver mounts every
      // entry in a composition slice in manifest order, collects their
      // timelines, hands the whole slice to the timeline adapter ONCE
      // (which composes the master), then tears every scene down in
      // reverse. The adapter's recorded `segments` catch a regression
      // that dropped a scene from the slice; the cleanup ordering
      // catches a regression that re-introduced per-scene teardown.
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const rec = recordingTimeline();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([
          { id: probe.compositionId, manifest: probe.scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: rec.adapter,
      });

      await loader.handle(presentTarget(probe.compositionId));

      expect(probe.log).toEqual([
        'create:scene-a',
        'create:scene-b',
        'create:scene-c',
        'timeline:scene-a',
        'timeline:scene-b',
        'timeline:scene-c',
        'cleanup:scene-c',
        'cleanup:scene-b',
        'cleanup:scene-a',
      ]);
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0]?.segments.map((s) => s.id)).toEqual(['scene-a', 'scene-b', 'scene-c']);
      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-a');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe(probe.compositionId);
    });

    it('produces the same multi-scene lifecycle when `mode` is absent (clause: present is the default)', async () => {
      // PUL-F013 is paired with PUL-F012's "absent mode defaults to
      // present" contract: a URL with no `mode=` parameter selects the
      // same behavior as an explicit `mode=present`. Pinning a separate
      // run of the multi-scene flow without `mode` proves the runtime
      // does not branch on "explicit vs default" present in any way that
      // would let PUL-F013 drift between the two.
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const rec = recordingTimeline();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([
          { id: probe.compositionId, manifest: probe.scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: rec.adapter,
      });

      await loader.handle(absentModeTarget(probe.compositionId));

      expect(probe.log).toEqual([
        'create:scene-a',
        'create:scene-b',
        'create:scene-c',
        'timeline:scene-a',
        'timeline:scene-b',
        'timeline:scene-c',
        'cleanup:scene-c',
        'cleanup:scene-b',
        'cleanup:scene-a',
      ]);
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0]?.segments.map((s) => s.id)).toEqual(['scene-a', 'scene-b', 'scene-c']);
    });

    it('exposes `ctx.mode === "present"` in every lifecycle hook for both explicit and absent mode (mode-hint contract clauses 1/2 will consume)', async () => {
      // Chrome and audio rendering, when those subsystems land, will
      // read `ctx.mode` to decide whether to render / play. Pinning that
      // every lifecycle hook in a multi-scene flow under `mode=present`
      // (and absent mode) sees `ctx.mode === 'present'` is the
      // executable form of "the runtime exposes the present hint to
      // every scene that runs under it" — a regression that built ctx
      // once per loader (instead of once per navigation) would leak the
      // wrong mode into later hooks here.
      const seen: { phase: string; sceneId: string; mode: unknown }[] = [];
      const recordMode =
        (phase: string, sceneId: string) =>
        (ctx: unknown): unknown => {
          seen.push({ phase, sceneId, mode: (ctx as { mode?: NavigationMode }).mode });
          return null;
        };
      const sceneA = buildScene({
        id: 'scene-a',
        create: recordMode('create', 'scene-a'),
        timeline: recordMode('timeline', 'scene-a') as SceneModule['timeline'],
        cleanup: recordMode('cleanup', 'scene-a'),
      });
      const sceneB = buildScene({
        id: 'scene-b',
        create: recordMode('create', 'scene-b'),
        timeline: recordMode('timeline', 'scene-b') as SceneModule['timeline'],
        cleanup: recordMode('cleanup', 'scene-b'),
      });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b'] },
        ]),
        stage: stage.element,
        buildCtx: (mode) => ({ stage: stage.element, mode, gsap }),
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
      });

      await loader.handle(presentTarget('full-talk'));
      await loader.handle(absentModeTarget('full-talk'));

      // 6 hooks per navigation × 2 navigations = 12 entries; every
      // single one carries `present`. The two-navigation shape also
      // catches a regression where mode is captured into a closure once
      // and reused across navigations.
      expect(seen).toHaveLength(12);
      for (const entry of seen) {
        expect(entry.mode).toBe('present');
      }
    });

    it('forwards a non-undefined `AbortSignal` to the runner under `mode=present` AND under absent `mode` (pins the presenter-input seam, NOT presenter input itself)', async () => {
      // Actual presenter input is PUL-F020's deliverable. What this
      // test pins is the seam PUL-F020 will drive: the per-navigation
      // `AbortSignal` (PUL-F006 / ADR-011) reaches the timeline
      // runner's `input.signal` under `mode=present` AND under absent
      // `mode` (the URL form that defaults to `present` per
      // PUL-F012 / ADR-007). Asserting both forms catches a regression
      // that dropped signal forwarding for one but not the other —
      // e.g. an "if mode is explicitly present" branch that skipped
      // the absent-mode default.
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const stage = buildStage();
      const rec = recordingTimeline();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: rec.adapter,
      });

      await loader.handle(presentTarget('full-talk'));
      await loader.handle(absentModeTarget('full-talk'));

      // One timeline run per navigation × 2 navigations = 2 calls; each
      // must carry a defined, un-aborted signal — proving the seam
      // reaches the timeline adapter identically for both URL forms that
      // select `present`.
      expect(rec.calls).toHaveLength(2);
      for (const call of rec.calls) {
        expect(call.opts.signal).toBeInstanceOf(AbortSignal);
        expect(call.opts.signal?.aborted).toBe(false);
      }
    });

    it('an in-flight abort under `mode=present` flips `signal.aborted` and triggers cleanup (pins the abort-to-cleanup connectedness PUL-F020 will drive)', async () => {
      // Actual presenter input is PUL-F020's deliverable; here we
      // pin the connectedness of the abort seam end to end under
      // `mode=present`: when the per-navigation `AbortController` is
      // aborted (PUL-F020 will drive this from a presenter control;
      // the loader drives it from a superseding handle() in this
      // test), the runner observes `signal.aborted === true`, the
      // runner's promise can resolve from that signal, and the
      // resolver's mandatory-cleanup invariant runs `cleanup(ctx)`
      // on the in-flight scene. Without this connectedness, every
      // future presenter-driven abort would either leak the signal
      // or skip cleanup.
      //
      // Determinism: the test asserts the runner observed a defined
      // signal BEFORE parking on the abort gate, so a regression that
      // dropped signal forwarding fails fast with an assertion rather
      // than via the test-runner timeout.
      const cleanupRan: string[] = [];
      let runnerSignal: AbortSignal | undefined;
      // The runner resolves a deferred when its first call enters; the
      // test awaits that deferred (or a 1s timeout) instead of an
      // unbounded microtask spin so a regression that prevents the
      // runner from starting fails with a deterministic assertion
      // rather than hanging the test process.
      let runnerEntered: () => void = () => undefined;
      const runnerEnteredPromise = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      // First runner call holds open until aborted; subsequent calls
      // (the superseding navigation's runner) resolve immediately so
      // the test does not hang waiting for an interrupt that never
      // arrives.
      let runnerCalls = 0;
      const runner = (input: LegacyRunInput) => {
        runnerCalls += 1;
        if (runnerCalls !== 1) return undefined;
        // Capture and assert signal presence synchronously, before
        // returning the gate promise. A missing signal fails the
        // test deterministically with the throw below — not via the
        // 5s test timeout the abort-listener path would otherwise
        // hit.
        runnerSignal = input.signal;
        runnerEntered();
        if (runnerSignal === undefined) {
          throw new Error('mode=present did not forward a signal to the runner');
        }
        const signal = runnerSignal;
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const sceneA = buildScene({
        id: 'scene-a',
        cleanup: () => {
          cleanupRan.push('scene-a');
        },
      });
      const sceneB = buildScene({
        id: 'scene-b',
        cleanup: () => {
          cleanupRan.push('scene-b');
        },
      });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        onError: () => undefined,
      });

      // First navigation: scene-a starts and the runner parks waiting
      // for abort. We do NOT await this handle — we want the runner
      // sitting on the gate when the abort arrives.
      const first = loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'present',
      });
      // Bounded wait: race the deferred against a 1s timeout. A
      // regression that prevents the runner from starting fails the
      // assertion below with `runnerCalls === 0`, not via the 5s test
      // timeout.
      const guard = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 1000);
      });
      const enteredOrTimeout = await Promise.race([
        runnerEnteredPromise.then(() => 'entered' as const),
        guard,
      ]);
      expect(enteredOrTimeout).toBe('entered');
      expect(runnerCalls).toBe(1);
      // Signal MUST be present by the time the runner parked on it;
      // assert before triggering the abort.
      expect(runnerSignal).toBeDefined();
      expect(runnerSignal?.aborted).toBe(false);

      // Second navigation: simulates the presenter / popstate trigger
      // that PUL-F020 will drive. The loader aborts the first load.
      const second = loader.handle({
        locator: { kind: 'scene', scene: 'scene-b' },
        mode: 'present',
      });

      await first;
      await second;

      expect(runnerSignal?.aborted).toBe(true);
      // scene-a's cleanup ran (mandatory cleanup on every scene exit
      // — PUL-F006). scene-b's cleanup ran on its normal-advance exit
      // because the second navigation also completed.
      expect(cleanupRan).toContain('scene-a');
      expect(cleanupRan).toContain('scene-b');
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=present`', async () => {
      // The PUL-F013 invariant is narrow: under `mode=present` the
      // loader MUST NOT preemptively write a suppression-style stage
      // attribute under the `data-pulsar-mode-` namespace (e.g.
      // `data-pulsar-mode-suppress-chrome`, `data-pulsar-mode-mute`).
      // Future modes that DO suppress facets are free to do so
      // through this namespace; PUL-F013 forbids it for `present`.
      // The assertion is scoped to that namespace only — adding
      // unrelated diagnostics or observability attributes (e.g. a
      // future `data-pulsar-state-*`) does not break this test.
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

      await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });
  });

  describe('presenter-controls dispatch (PUL-F020 / PUL-F021 / ADR-023 / ADR-024)', () => {
    // PUL-F020 statement: in `mode=present`, the runtime SHALL accept
    // presenter input to advance to the next beat, hold the current
    // beat, skip forward, and skip backward. Beat progression SHALL
    // be interruptible without breaking timeline state.
    //
    // PUL-F021 statement: the runtime SHALL accept presenter input to
    // pause the active timeline and SHALL accept input to resume from
    // the same point. ADR-024 records that PUL-F021 extends THIS seam
    // (not a new mode/source/controller/schema) by adding the `pause`
    // and `resume` command kinds; the loader-side dispatch — mode
    // scoping, controller construction, abort-tied auto-cleanup — is
    // unchanged. "Same point" playhead behavior is the runner's
    // contract, so PUL-F021, like PUL-F020, stays DRAFT until a real
    // presenter UI and a GSAP runner land with end-to-end tests.
    //
    // This block pins the loader-side dispatch — the seam by which a
    // workbench-supplied `PresenterCommandSource` reaches the
    // timeline runner under `mode=present` only, with per-navigation
    // auto-cleanup tied to the existing `AbortSignal`. This PR does
    // NOT deliver the visible presenter UI surface (keyboard
    // listener, on-screen controls); the placeholder source is omitted
    // in `src/main.ts` so production reaches the loader's
    // graceful-degradation path. PUL-F020 stays DRAFT until a real
    // presenter UI lands AND end-to-end tests confirm advance / hold
    // / skip-forward / skip-backward actually move beat state without
    // breaking the timeline (ADR-023 records the gating delivery).
    //
    // Materially-implementable parts pinned here:
    //   - `input.presenter` reaches the runner under `mode=present`
    //     when the workbench supplies `presenterCommands`.
    //   - `input.presenter` is forwarded to EVERY scene in a
    //     composition slice (NOT head-only — mode=present runs the
    //     full slice).
    //   - `input.presenter` is forwarded under absent-mode URLs
    //     (mode defaults to present per PUL-F012 / ADR-007).
    //   - `input.presenter` is omitted under every non-present mode.
    //   - `input.presenter` is omitted when the workbench does not
    //     supply `presenterCommands` (graceful degradation).
    //   - Commands flow through every kind PUL-F020 + PUL-F021 name
    //     (advance, hold, skip-forward, skip-backward, pause, resume).
    //   - Aborting the navigation tears down the runner's
    //     subscription so emissions after abort do not reach it
    //     (auto-cleanup on the per-navigation AbortSignal).
    //   - Cleanup-before-handoff: a navigation that supersedes
    //     a presenter-mounted scene runs `cleanup(ctx)` on the
    //     in-flight scene exactly once (PUL-F006 invariant; the
    //     "interruptible without breaking timeline state" clause).
    //   - Unknown command kinds are dropped at the controller
    //     boundary; the loader's `onError` sees a diagnostic.

    interface FakeSource {
      readonly source: import('../../src/runtime/presenter').PresenterCommandSource;
      readonly emit: (cmd: unknown) => void;
      readonly handlerCount: () => number;
    }
    const buildFakeSource = (): FakeSource => {
      const handlers = new Set<
        (cmd: import('../../src/runtime/presenter').PresenterCommand) => void
      >();
      return {
        source: {
          subscribe(handler) {
            handlers.add(handler);
            return () => {
              handlers.delete(handler);
            };
          },
        },
        emit(cmd) {
          for (const h of handlers) {
            h(cmd as import('../../src/runtime/presenter').PresenterCommand);
          }
        },
        handlerCount: () => handlers.size,
      };
    };

    it('forwards `input.presenter` to the runner under `mode=present` for a single-scene target', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const fake = buildFakeSource();
      const seen: { hasPresenter: boolean }[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline((input) => {
          seen.push({ hasPresenter: input.presenter !== undefined });
        }),
        presenterCommands: fake.source,
      });

      await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });

      expect(seen).toEqual([{ hasPresenter: true }]);
    });

    it('forwards the presenter controller into the single timeline run for the full (untruncated) composition slice under `mode=present`', async () => {
      // ADR-025: `mode=present` runs the FULL slice through one master
      // timeline, so the loader forwards the presenter controller once
      // (in the run options) and does NOT truncate the slice to the
      // head (unlike the single-scene modes). A regression that either
      // dropped the controller or truncated the slice under `present`
      // would fail here.
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const fake = buildFakeSource();
      const rec = recordingTimeline();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: rec.adapter,
        presenterCommands: fake.source,
      });

      await loader.handle({
        locator: { kind: 'composition', composition: 'full-talk' },
        mode: 'present',
      });

      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0]?.opts.presenter).toBeDefined();
      expect(rec.calls[0]?.segments.map((s) => s.id)).toEqual(['scene-a', 'scene-b', 'scene-c']);
    });

    it('forwards `input.presenter` under absent-mode URLs (mode defaults to present)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const fake = buildFakeSource();
      const seen: boolean[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline((input) => {
          seen.push(input.presenter !== undefined);
        }),
        presenterCommands: fake.source,
      });

      // Absent `mode` URL — defaults to present per PUL-F012 /
      // ADR-007. A regression that branched on `target.mode ===
      // 'present'` instead of `effectiveMode(target) === 'present'`
      // would skip the presenter forwarding here.
      await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' } });

      expect(seen).toEqual([true]);
    });

    it.each(NAVIGATION_MODES.filter((m) => m !== 'present'))(
      'does NOT forward `input.presenter` under non-present mode `%s` even when `presenterCommands` is supplied',
      async (mode) => {
        const sceneA = buildScene({ id: 'scene-a' });
        const stage = buildStage();
        const fake = buildFakeSource();
        const seen: { presenterPresent: boolean }[] = [];
        const noopRendererForPrompter: PrompterRenderer = () => undefined;
        const loader = createSceneLoader({
          scenes: createSceneRegistry([sceneA]),
          compositions: createCompositionRegistry([]),
          stage: stage.element,
          buildCtx: stubCtx,
          createPreloader: () => () => undefined,
          timeline: asTimeline((input) => {
            seen.push({ presenterPresent: 'presenter' in input });
          }),
          renderPrompter: noopRendererForPrompter,
          presenterCommands: fake.source,
        });

        await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode });

        if (mode === 'prompter') {
          // mode=prompter bypasses the lifecycle entirely (ADR-022),
          // so `runTimeline` is never invoked and `seen` stays empty.
          // The "presenter does not leak into prompter" invariant
          // holds vacuously through the lifecycle bypass — the
          // captions data path has no `input.presenter` slot.
          expect(seen).toEqual([]);
        } else {
          expect(seen).toEqual([{ presenterPresent: false }]);
        }
        // Source should NOT have been subscribed under any non-present
        // mode — the loader must not even build a controller.
        expect(fake.handlerCount()).toBe(0);
      },
    );

    it('does NOT forward `input.presenter` when `presenterCommands` is omitted (graceful degradation)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const seen: { presenterPresent: boolean }[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline((input) => {
          seen.push({ presenterPresent: 'presenter' in input });
        }),
      });

      await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });

      expect(seen).toEqual([{ presenterPresent: false }]);
    });

    it('delivers every command kind PUL-F020 + PUL-F021 name (advance, hold, skip-forward, skip-backward, pause, resume) to the runner', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const fake = buildFakeSource();
      const received: string[] = [];
      // The runner subscribes to the presenter, captures every
      // command it observes, then parks until aborted so the test
      // can drive commands while the scene is "running."
      let runnerEntered: () => void = () => undefined;
      const runnerEnteredPromise = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const runner = (input: LegacyRunInput) => {
        input.presenter?.subscribe((cmd) => received.push(cmd.kind));
        runnerEntered();
        return new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        presenterCommands: fake.source,
      });
      void loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'present',
      });
      await runnerEnteredPromise;

      fake.emit({ kind: 'advance' });
      fake.emit({ kind: 'hold' });
      fake.emit({ kind: 'skip-forward' });
      fake.emit({ kind: 'skip-backward' });
      // PUL-F021 (ADR-024): pause/resume ride the same dispatch path.
      fake.emit({ kind: 'pause' });
      fake.emit({ kind: 'resume' });

      loader.dispose();
      await loader.idle();

      expect(received).toEqual([
        'advance',
        'hold',
        'skip-forward',
        'skip-backward',
        'pause',
        'resume',
      ]);
    });

    it('aborting the navigation detaches the runner subscription so post-abort emissions do not reach it', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const stage = buildStage();
      const fake = buildFakeSource();
      const received: string[] = [];
      let runnerEntered: () => void = () => undefined;
      const runnerEnteredPromise = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const runner = (input: LegacyRunInput) => {
        if (input.scene.id === 'scene-a') {
          input.presenter?.subscribe((cmd) => received.push(cmd.kind));
          runnerEntered();
          return new Promise<void>((resolve) => {
            input.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return undefined;
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        presenterCommands: fake.source,
        onError: () => undefined,
      });

      const first = loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'present',
      });
      await runnerEnteredPromise;
      fake.emit({ kind: 'advance' });

      // Superseding navigation aborts scene-a's controller; the
      // runner's subscription must be detached BEFORE the next
      // emission so commands do not leak across navigations.
      const second = loader.handle({
        locator: { kind: 'scene', scene: 'scene-b' },
        mode: 'present',
      });
      await first;
      await second;

      fake.emit({ kind: 'hold' });

      expect(received).toEqual(['advance']);
    });

    it('runs `cleanup(ctx)` on the in-flight scene when a presenter-driven supersede aborts mid-run (interruptible without breaking timeline state)', async () => {
      // PUL-F020 statement clause: "Beat progression SHALL be
      // interruptible without breaking timeline state." A
      // superseding navigation under `mode=present` (which a
      // presenter UI will drive) MUST trigger the resolver's
      // mandatory-cleanup invariant on the in-flight scene exactly
      // once. Without this, "interrupt" would mean "leak the
      // previous scene's resources."
      const sceneA = buildScene({
        id: 'scene-a',
        cleanup: () => {
          cleanupRan.push('scene-a');
        },
      });
      const sceneB = buildScene({
        id: 'scene-b',
        cleanup: () => {
          cleanupRan.push('scene-b');
        },
      });
      const cleanupRan: string[] = [];
      const stage = buildStage();
      const fake = buildFakeSource();
      let runnerEntered: () => void = () => undefined;
      const runnerEnteredPromise = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      let runnerCalls = 0;
      const runner = (input: LegacyRunInput) => {
        runnerCalls += 1;
        if (runnerCalls === 1) {
          input.presenter?.subscribe(() => undefined);
          runnerEntered();
          return new Promise<void>((resolve) => {
            input.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return undefined;
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        presenterCommands: fake.source,
        onError: () => undefined,
      });

      const first = loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'present',
      });
      await runnerEnteredPromise;
      const second = loader.handle({
        locator: { kind: 'scene', scene: 'scene-b' },
        mode: 'present',
      });
      await first;
      await second;

      expect(cleanupRan).toEqual(['scene-a', 'scene-b']);
    });

    it("routes a runner presenter handler's exception through the loader's `onError` sink (per-scene wrapper threads the diagnostic channel)", async () => {
      // Codex review (cycle 2): without `onError` threaded through
      // the resolver's per-scene wrapper, a runner-handler exception
      // would be caught by the wrapper and silently dropped — the
      // loader's diagnostic channel would lose the failure even
      // though the navigation controller's own `onError` still
      // exists. This test pins the threading: an exception from the
      // runner's presenter handler reaches the loader's `onError`.
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const fake = buildFakeSource();
      const errors: unknown[] = [];
      let runnerEntered: () => void = () => undefined;
      const runnerEnteredPromise = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const runner = (input: LegacyRunInput) => {
        input.presenter?.subscribe(() => {
          throw new Error('runner-handler exception');
        });
        runnerEntered();
        return new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        presenterCommands: fake.source,
        onError: (err) => errors.push(err),
      });

      void loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'present',
      });
      await runnerEnteredPromise;
      fake.emit({ kind: 'advance' });
      loader.dispose();
      await loader.idle();

      // Filter to the handler-exception diagnostic; the dispose
      // path may surface unrelated errors depending on timing.
      const handlerErrors = errors.filter(
        (e) => e instanceof Error && /runner-handler exception/.test(e.message),
      );
      expect(handlerErrors).toHaveLength(1);
    });

    it('drops unknown command kinds at the controller boundary and surfaces a diagnostic via `onError`', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const fake = buildFakeSource();
      const errors: unknown[] = [];
      const received: string[] = [];
      let runnerEntered: () => void = () => undefined;
      const runnerEnteredPromise = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const runner = (input: LegacyRunInput) => {
        input.presenter?.subscribe((cmd) => received.push(cmd.kind));
        runnerEntered();
        return new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        presenterCommands: fake.source,
        onError: (err) => errors.push(err),
      });

      void loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'present',
      });
      await runnerEnteredPromise;
      fake.emit({ kind: 'rewind' });
      fake.emit({ kind: 'advance' });
      loader.dispose();
      await loader.idle();

      expect(received).toEqual(['advance']);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect((errors[0] as Error).message).toMatch(/presenter/i);
    });

    it('writes no `data-pulsar-mode-*` suppression attribute under `mode=present` even when `presenterCommands` is supplied', async () => {
      // Layered with the existing PUL-F013-boundary invariant
      // (ADR-016): adding presenter dispatch must not introduce a
      // new `data-pulsar-mode-*` suppression attribute under
      // `mode=present`.
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const fake = buildFakeSource();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        presenterCommands: fake.source,
      });

      await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });
  });
});
