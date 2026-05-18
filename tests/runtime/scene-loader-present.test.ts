import { describe, expect, it, vi } from 'vitest';
import {
  type AudioEngine,
  type AudioService,
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

interface FakeSource {
  readonly source: import('../../src/runtime/presenter').PresenterCommandSource;
  readonly emit: (cmd: unknown) => void;
  readonly handlerCount: () => number;
}

const buildFakeSource = (): FakeSource => {
  const handlers = new Set<(cmd: import('../../src/runtime/presenter').PresenterCommand) => void>();
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
        buildCtx: (mode, audio: AudioService) => ({ stage: stage.element, mode, gsap, audio }),
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

  describe('presenter-controls dispatch (PUL-F020 / PUL-F021 / PUL-F025 / ADR-023 / ADR-024)', () => {
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
    // PUL-F025 statement: the runtime SHALL accept presenter input to
    // toggle master mute, and master mute SHALL silence audio without
    // altering timeline state. PUL-F025 also extends THIS seam by
    // adding the `toggle-master-mute` command kind; the loader-side
    // dispatch is the same mode scoping + controller construction +
    // abort-tied auto-cleanup. PUL-F025-specific behavior is the
    // loader's audio handler: on `toggle-master-mute` it calls
    // `audio.mute(!audio.isMuted())`. The audio engine already owns
    // master mute as runtime state per ADR-004, so PUL-F025 stays
    // DRAFT until a real presenter UI surface lands and emits the
    // kind end-to-end (mirroring PUL-F020 / PUL-F021). The
    // PUL-F025-specific tests live in their own describe block below.
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
      expect(typeof rec.calls[0]?.opts.presenter?.subscribe).toBe('function');
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

    it('delivers every command kind PUL-F020 + PUL-F021 + PUL-F025 name (advance, hold, skip-forward, skip-backward, pause, resume, toggle-master-mute) to the runner', async () => {
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
      // PUL-F025 (ADR-004): toggle-master-mute rides the same
      // dispatch path. The runner sees it too — the loader's audio
      // handler is additive, not a filter.
      fake.emit({ kind: 'toggle-master-mute' });

      loader.dispose();
      await loader.idle();

      expect(received).toEqual([
        'advance',
        'hold',
        'skip-forward',
        'skip-backward',
        'pause',
        'resume',
        'toggle-master-mute',
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
      // PUL-F025 / ADR-023 (codex review, post-PUL-F025): even
      // though PUL-F025 added a second subscriber on the navigation
      // controller (the loader's audio handler), the controller
      // validates each source emission ONCE — not once per
      // subscriber — and surfaces ONE diagnostic per rejected
      // emission regardless of how many subscribers are attached.
      // Pin the exact count so a regression that reverted the
      // controller to per-subscriber validation (multiplying
      // diagnostic noise as subscribers grow) is caught here.
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

  describe('presenter master-mute dispatch (PUL-F025 / ADR-004)', () => {
    // PUL-F025 statement: the runtime SHALL accept presenter input to
    // toggle master mute. Master mute SHALL silence audio without
    // altering timeline state.
    //
    // PUL-F025 composes ADR-004 (master mute as engine-level runtime
    // state) with the existing presenter command seam (ADR-023):
    //  - Schema: `'toggle-master-mute'` joins `PRESENTER_COMMAND_KINDS`.
    //    No new command source, controller, validator, or mode.
    //  - Loader-side audio handler: on `'toggle-master-mute'`,
    //    `audio.mute(!audio.isMuted())`. The handler lives in
    //    `buildLoad` because that is the only seam holding both the
    //    per-navigation `PresenterController` and the per-navigation
    //    `AudioService`. The subscription is auto-detached on the
    //    navigation's `AbortSignal` via the controller's existing
    //    teardown.
    //  - Timeline state untouched: no `cleanup(ctx)`, no abort, no
    //    URL / history / mode mutation. The runner's pending promise
    //    stays pending while mute toggles.
    //
    // PUL-F025 stays DRAFT until a presenter UI surface lands and
    // emits the kind end-to-end, mirroring the PUL-F020 / PUL-F021
    // precedent. The runtime-side contract is delivered by this PR;
    // the issue ↔ PUL-F025 link stays `DOCUMENTS`.

    // Local fresh-engine factory: the exported `noopAudioEngine` is a
    // process singleton with mutable master-mute state, so reusing it
    // across tests would leak state. This mirrors `noopAudioEngine`
    // but returns a fresh instance per test, giving each test
    // hermetic engine state.
    const freshAudioEngine = (): AudioEngine => {
      let muted = false;
      const noopHandle = {
        play: () => 0,
        stop: () => undefined,
        fade: () => undefined,
        loop: () => undefined,
        volume: () => undefined,
        unload: () => undefined,
      };
      return {
        createSound: () => noopHandle,
        setMasterMute: (m: boolean) => {
          muted = m;
        },
        isMasterMuted: () => muted,
        unlock: () => Promise.resolve(),
      };
    };

    interface MountedPresent {
      readonly loader: ReturnType<typeof createSceneLoader>;
      readonly fake: ReturnType<typeof buildFakeSource>;
      readonly capturedAudio: () => AudioService;
      readonly captureCount: () => number;
      readonly readyP: Promise<void>;
    }

    // Mount a single-scene `mode=present` navigation, capture
    // `ctx.audio` from the scene's `create(ctx)` (the only lifecycle
    // hook guaranteed to run before the runner starts), park the
    // runner until abort, and resolve `readyP` once the scene is
    // mounted and the runner has entered. Tests then drive presenter
    // commands and assert on the captured audio service.
    //
    // The runner subscribes to `input.presenter` so the codex review
    // can verify the loader's audio handler is additive (the runner
    // still receives every kind). `runner.received` is exposed for
    // tests that need it.
    const mountPresent = (opts?: {
      readonly noPresenterCommands?: boolean;
      readonly mode?: NavigationMode;
      readonly scenes?: readonly SceneModule[];
      readonly compositionId?: string;
      readonly compositionScenes?: readonly string[];
      readonly engine?: AudioEngine;
      readonly runnerReceived?: string[];
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test fixture mount helper that threads optional presenter / audio / composition / engine wiring for every mode permutation; complexity is intrinsic to the option-by-option permutation.
    }): MountedPresent => {
      const fake = buildFakeSource();
      const engine = opts?.engine ?? freshAudioEngine();
      let captured: AudioService | undefined;
      let captureCount = 0;
      const captureCtx = (ctx: unknown): void => {
        const a = (ctx as { audio: AudioService }).audio;
        captured = a;
        captureCount += 1;
      };
      const scenes = opts?.scenes ?? [
        buildScene({
          id: 'scene-a',
          create: (ctx) => captureCtx(ctx),
        }),
      ];
      let runnerEntered: () => void = () => undefined;
      const readyP = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const runner = (input: LegacyRunInput): Promise<void> => {
        // Capture commands the runner sees so additive-handler tests
        // can verify the loader's PUL-F025 dispatch did not consume
        // the command before the runner.
        if (opts?.runnerReceived !== undefined) {
          input.presenter?.subscribe((cmd) => opts.runnerReceived?.push(cmd.kind));
        }
        runnerEntered();
        return new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const loaderOpts: SceneLoaderOptions = {
        scenes: createSceneRegistry(scenes),
        compositions: createCompositionRegistry(
          opts?.compositionId === undefined
            ? []
            : [
                {
                  id: opts.compositionId,
                  manifest: opts.compositionScenes ?? [scenes[0]?.id ?? ''],
                },
              ],
        ),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        audioEngine: engine,
        ...(opts?.noPresenterCommands === true ? {} : { presenterCommands: fake.source }),
      };
      const loader = createSceneLoader(loaderOpts);
      const target: NavigationTarget =
        opts?.compositionId === undefined
          ? {
              locator: { kind: 'scene', scene: scenes[0]?.id ?? 'scene-a' },
              ...(opts?.mode === undefined ? {} : { mode: opts.mode }),
            }
          : {
              locator: { kind: 'composition', composition: opts.compositionId },
              ...(opts?.mode === undefined ? {} : { mode: opts.mode }),
            };
      void loader.handle(target);
      return {
        loader,
        fake,
        capturedAudio: () => {
          if (captured === undefined) throw new Error('ctx.audio was never captured');
          return captured;
        },
        captureCount: () => captureCount,
        readyP,
      };
    };

    it('flips master mute from unmuted to muted on the first `toggle-master-mute` command', async () => {
      // Clause 1: "accept presenter input to toggle master mute."
      // First emission must flip the engine-level mute state via
      // the audio service.
      const m = mountPresent({ mode: 'present' });
      await m.readyP;
      expect(m.capturedAudio().isMuted()).toBe(false);
      m.fake.emit({ kind: 'toggle-master-mute' });
      expect(m.capturedAudio().isMuted()).toBe(true);
      m.loader.dispose();
      await m.loader.idle();
    });

    it('round-trips master mute on repeated `toggle-master-mute` commands', async () => {
      // The command is a *fact*, not a target state — the loader
      // reads the engine's current mute at receipt time and flips
      // it. Two emissions return to unmuted; a third re-mutes.
      const m = mountPresent({ mode: 'present' });
      await m.readyP;
      expect(m.capturedAudio().isMuted()).toBe(false);
      m.fake.emit({ kind: 'toggle-master-mute' });
      m.fake.emit({ kind: 'toggle-master-mute' });
      expect(m.capturedAudio().isMuted()).toBe(false);
      m.fake.emit({ kind: 'toggle-master-mute' });
      expect(m.capturedAudio().isMuted()).toBe(true);
      m.loader.dispose();
      await m.loader.idle();
    });

    it('does NOT alter timeline state — no `cleanup(ctx)`, no abort, runner pending stays pending across toggles', async () => {
      // Clause 2: "Master mute SHALL silence audio without altering
      // timeline state." The handler must not abort the navigation,
      // call cleanup, or affect the runner's transport. We pin this
      // by counting `cleanup(ctx)` invocations, observing
      // `signal.aborted` from the runner side, and verifying the
      // navigation handle stays pending while toggles fire.
      let cleanupRan = 0;
      let abortedAtRunner = false;
      let capturedAudio: AudioService | undefined;
      let runnerEntered: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      // One scene that captures `ctx.audio` in `create` AND counts
      // cleanup invocations, so both invariants are pinned on the
      // same navigation.
      const scene = buildScene({
        id: 'scene-a',
        create: (ctx) => {
          capturedAudio = (ctx as { audio: AudioService }).audio;
        },
        cleanup: () => {
          cleanupRan += 1;
        },
      });
      const runner = (input: LegacyRunInput): Promise<void> => {
        // Resolve `ready` once the runner has entered so the test
        // can assert mid-flight. `create(ctx)` already ran by this
        // point (ADR-025: mount-all then run), so `capturedAudio`
        // is set.
        runnerEntered();
        return new Promise<void>((resolve) => {
          input.signal?.addEventListener(
            'abort',
            () => {
              abortedAtRunner = true;
              resolve();
            },
            { once: true },
          );
        });
      };
      const fake = buildFakeSource();
      const engine = freshAudioEngine();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([scene]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        audioEngine: engine,
        presenterCommands: fake.source,
      });
      const handle = loader.handle({
        locator: { kind: 'scene', scene: 'scene-a' },
        mode: 'present',
      });
      // Track handle settlement so we can pin "toggles do not
      // complete the navigation."
      let handleSettled = false;
      void handle.then(
        () => {
          handleSettled = true;
        },
        () => {
          handleSettled = true;
        },
      );
      await ready;
      expect(capturedAudio?.isMuted()).toBe(false);
      fake.emit({ kind: 'toggle-master-mute' });
      fake.emit({ kind: 'toggle-master-mute' });
      fake.emit({ kind: 'toggle-master-mute' });
      // Yield to the microtask queue so any spurious settle would
      // have already happened.
      await Promise.resolve();
      await Promise.resolve();
      expect(handleSettled).toBe(false);
      expect(cleanupRan).toBe(0);
      expect(abortedAtRunner).toBe(false);
      // Three toggles on a no-op engine — ends muted.
      expect(capturedAudio?.isMuted()).toBe(true);
      loader.dispose();
      await loader.idle();
      // After dispose: cleanup must run exactly once (the normal
      // mandatory-cleanup invariant), and the runner must observe
      // the abort. Both are existing PUL-F006 invariants; we only
      // re-pin them to make explicit that PUL-F025's handler did
      // NOT cause additional cleanups.
      expect(cleanupRan).toBe(1);
      expect(abortedAtRunner).toBe(true);
    });

    it.each(NAVIGATION_MODES.filter((m) => m !== 'present'))(
      'does NOT toggle master mute under non-present mode `%s` even when `presenterCommands` is supplied',
      async (mode) => {
        // PUL-F025 mode scoping: presenter input is `mode=present`
        // only. The controller is never built for other modes, so a
        // workbench source that emits `'toggle-master-mute'` while a
        // non-present navigation is active reaches NO subscriber —
        // master mute stays untouched. Without this guard, mute
        // would leak into screenshot / paused / loop / etc.
        const sceneA = buildScene({ id: 'scene-a' });
        const fake = buildFakeSource();
        const engine = freshAudioEngine();
        let capturedAudio: AudioService | undefined;
        let runnerEntered: () => void = () => undefined;
        const ready = new Promise<void>((resolve) => {
          runnerEntered = resolve;
        });
        const runner = (input: LegacyRunInput): Promise<void> => {
          runnerEntered();
          return new Promise<void>((resolve) => {
            input.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        };
        const noopRendererForPrompter: PrompterRenderer = () => undefined;
        const captureScene = buildScene({
          id: 'scene-a',
          create: (ctx) => {
            capturedAudio = (ctx as { audio: AudioService }).audio;
            runnerEntered();
          },
        });
        const loader = createSceneLoader({
          scenes: createSceneRegistry([captureScene]),
          compositions: createCompositionRegistry([]),
          stage: buildStage().element,
          buildCtx: stubCtx,
          createPreloader: () => () => undefined,
          timeline: asTimeline(runner),
          audioEngine: engine,
          renderPrompter: noopRendererForPrompter,
          presenterCommands: fake.source,
        });
        void sceneA;
        const handle = loader.handle({
          locator: { kind: 'scene', scene: 'scene-a' },
          mode,
        });
        if (mode === 'prompter') {
          // mode=prompter bypasses the resolver lifecycle entirely
          // (ADR-022) so `ctx.audio` is never built. The invariant
          // "presenter master mute does not run under non-present
          // modes" still holds vacuously, because no subscription
          // exists; pin it by emitting and confirming the source
          // has zero handlers.
          await handle;
          fake.emit({ kind: 'toggle-master-mute' });
          expect(fake.handlerCount()).toBe(0);
        } else {
          await ready;
          expect(capturedAudio?.isMuted()).toBe(false);
          fake.emit({ kind: 'toggle-master-mute' });
          fake.emit({ kind: 'toggle-master-mute' });
          fake.emit({ kind: 'toggle-master-mute' });
          expect(capturedAudio?.isMuted()).toBe(false);
          // The loader must not have wired a controller — the source
          // has zero subscribed handlers.
          expect(fake.handlerCount()).toBe(0);
          loader.dispose();
          await loader.idle();
        }
      },
    );

    it('toggles master mute under absent-mode URLs (mode defaults to present per ADR-007)', async () => {
      // Defense in depth: a regression that branched on
      // `target.mode === 'present'` instead of
      // `effectiveMode(target) === 'present'` would skip the mute
      // handler for `mode`-absent URLs even though they resolve to
      // present.
      const sceneA = buildScene({ id: 'scene-a' });
      const fake = buildFakeSource();
      const engine = freshAudioEngine();
      let capturedAudio: AudioService | undefined;
      let runnerEntered: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const captureScene = buildScene({
        id: 'scene-a',
        create: (ctx) => {
          capturedAudio = (ctx as { audio: AudioService }).audio;
          runnerEntered();
        },
      });
      const runner = (input: LegacyRunInput): Promise<void> =>
        new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([captureScene]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        audioEngine: engine,
        presenterCommands: fake.source,
      });
      void sceneA;
      void loader.handle({ locator: { kind: 'scene', scene: 'scene-a' } });
      await ready;
      fake.emit({ kind: 'toggle-master-mute' });
      expect(capturedAudio?.isMuted()).toBe(true);
      loader.dispose();
      await loader.idle();
    });

    it('does NOT toggle master mute when `presenterCommands` is omitted (graceful degradation)', async () => {
      // Mirror of the PUL-F020 graceful-degradation invariant: when
      // the workbench omits `presenterCommands` the loader builds no
      // controller, so there is no subscriber for the audio handler.
      // The audio service stays unmuted; no source to assert against,
      // so we drive the test by mounting and inspecting `isMuted()`
      // after a hypothetical out-of-band emission would have run.
      const engine = freshAudioEngine();
      let capturedAudio: AudioService | undefined;
      let runnerEntered: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const sceneA = buildScene({
        id: 'scene-a',
        create: (ctx) => {
          capturedAudio = (ctx as { audio: AudioService }).audio;
          runnerEntered();
        },
      });
      const runner = (input: LegacyRunInput): Promise<void> =>
        new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        audioEngine: engine,
      });
      void loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
      await ready;
      // With no source the workbench cannot emit; the invariant is
      // "engine stays at initial unmuted." A regression that wired
      // master mute through some other path (e.g., a default-on
      // listener) would flip the engine state here.
      expect(capturedAudio?.isMuted()).toBe(false);
      loader.dispose();
      await loader.idle();
    });

    it('toggles master mute even when no scene has registered a sound (engine-level state, noop engine round-trip)', async () => {
      // The preflight calls out: "The command is accepted even before
      // any sound has been registered. `noopAudioEngine` must round-
      // trip the mute state the same way the Howler engine does."
      // The scene here does NOT call `ctx.audio.load(...)`, yet the
      // toggle still mutates engine state observable via `isMuted()`.
      const engine = freshAudioEngine();
      const fake = buildFakeSource();
      let capturedAudio: AudioService | undefined;
      let runnerEntered: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const sceneA = buildScene({
        id: 'scene-a',
        create: (ctx) => {
          capturedAudio = (ctx as { audio: AudioService }).audio;
          runnerEntered();
        },
      });
      const runner = (input: LegacyRunInput): Promise<void> =>
        new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        audioEngine: engine,
        presenterCommands: fake.source,
      });
      void loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
      await ready;
      // The engine starts unmuted; isMasterMuted() reads from the
      // engine, not from any registered sound.
      expect(engine.isMasterMuted()).toBe(false);
      fake.emit({ kind: 'toggle-master-mute' });
      expect(engine.isMasterMuted()).toBe(true);
      expect(capturedAudio?.isMuted()).toBe(true);
      loader.dispose();
      await loader.idle();
    });

    it('persists master mute across scenes within a present-mode composition slice (engine-level runtime state)', async () => {
      // A composition slice runs the full slice through one audio
      // service shared across scenes (PUL-F024 / ADR-004), backed by
      // a single engine. Toggling mute mid-slice must be observable
      // by the next scene's `ctx.audio.isMuted()`; the audio service
      // delegates to the engine, which is the single source of
      // truth. Without engine-level persistence the second scene
      // would see unmuted again.
      const engine = freshAudioEngine();
      const fake = buildFakeSource();
      let firstAudio: AudioService | undefined;
      let secondAudio: AudioService | undefined;
      let firstEntered: () => void = () => undefined;
      const firstReady = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      let secondEntered: () => void = () => undefined;
      const secondReady = new Promise<void>((resolve) => {
        secondEntered = resolve;
      });
      const sceneA = buildScene({
        id: 'scene-a',
        create: (ctx) => {
          firstAudio = (ctx as { audio: AudioService }).audio;
          firstEntered();
        },
      });
      const sceneB = buildScene({
        id: 'scene-b',
        create: (ctx) => {
          secondAudio = (ctx as { audio: AudioService }).audio;
          secondEntered();
        },
      });
      // The composition runs both scenes through one master timeline
      // adapter `run` call (ADR-025). Park until aborted so we can
      // assert mid-flight.
      const rec = recordingTimeline(true);
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([
          { id: 'two-scenes', manifest: ['scene-a', 'scene-b'] },
        ]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: rec.adapter,
        audioEngine: engine,
        presenterCommands: fake.source,
      });
      void loader.handle({
        locator: { kind: 'composition', composition: 'two-scenes' },
        mode: 'present',
      });
      await firstReady;
      await secondReady;
      // Both scenes mounted under the same per-navigation service —
      // the resolver mounts every entry before `run` begins (ADR-025).
      expect(firstAudio).toBeDefined();
      expect(secondAudio).toBeDefined();
      fake.emit({ kind: 'toggle-master-mute' });
      expect(firstAudio?.isMuted()).toBe(true);
      expect(secondAudio?.isMuted()).toBe(true);
      // Engine-level probe: `secondAudio === firstAudio` under the
      // current single-service navigation contract, so re-asserting on
      // `secondAudio.isMuted()` would only be a second probe of the
      // same object. Probe the engine directly so the assertion still
      // exercises engine-level state if per-scene `AudioService`
      // facades are introduced later (`WorkbenchSceneCtx` resolver
      // follow-up) — a regression that failed to propagate mute state
      // across distinct service instances would fail here even though
      // each service's own `isMuted()` would return the wrong value.
      expect(engine.isMasterMuted()).toBe(true);
      loader.dispose();
      await loader.idle();
    });

    it('stops responding to `toggle-master-mute` after the navigation aborts', async () => {
      // Auto-cleanup: the presenter controller detaches the loader's
      // mute subscription when the per-navigation `AbortSignal`
      // fires. Post-abort emissions reach NO subscriber. The audio
      // service is also disposed and inert, so even if the
      // subscription somehow stayed attached the engine state would
      // not move — this test pins both layers.
      const engine = freshAudioEngine();
      const fake = buildFakeSource();
      let capturedAudio: AudioService | undefined;
      let runnerEntered: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const sceneA = buildScene({
        id: 'scene-a',
        create: (ctx) => {
          capturedAudio = (ctx as { audio: AudioService }).audio;
          runnerEntered();
        },
      });
      const runner = (input: LegacyRunInput): Promise<void> =>
        new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        audioEngine: engine,
        presenterCommands: fake.source,
      });
      void loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
      await ready;
      // First toggle pre-abort flips engine state — proves the
      // baseline subscription works.
      fake.emit({ kind: 'toggle-master-mute' });
      expect(engine.isMasterMuted()).toBe(true);
      loader.dispose();
      await loader.idle();
      // Post-abort: the loader's subscription is detached AND the
      // audio service is disposed (PUL-F024). Engine state stays
      // wherever the last pre-abort toggle left it.
      fake.emit({ kind: 'toggle-master-mute' });
      expect(engine.isMasterMuted()).toBe(true);
      expect(fake.handlerCount()).toBe(0);
      // The audio service is disposed; calling mute() on it from
      // outside the runtime now is a no-op (PUL-F024 invariant).
      expect(capturedAudio?.isDisposed()).toBe(true);
    });

    it('still delivers `toggle-master-mute` to the runner — the loader handler is additive, not a filter', async () => {
      // A runner that subscribes to `input.presenter` MUST still
      // receive every command the controller forwards, including
      // `toggle-master-mute`. The loader's audio handler is a
      // second subscriber on the controller, not a transformation
      // of the stream — see the existing "delivers every command
      // kind" test, which already includes `toggle-master-mute` in
      // the expected sequence. This focused test pins the rule in
      // isolation so a regression that gated the runner on a kind
      // allowlist would fail here with a single-kind failure that
      // is easy to read in CI output.
      const received: string[] = [];
      const engine = freshAudioEngine();
      const fake = buildFakeSource();
      let runnerEntered: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const sceneA = buildScene({ id: 'scene-a' });
      const runner = (input: LegacyRunInput): Promise<void> => {
        input.presenter?.subscribe((cmd) => received.push(cmd.kind));
        runnerEntered();
        return new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        audioEngine: engine,
        presenterCommands: fake.source,
      });
      void loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
      await ready;
      fake.emit({ kind: 'toggle-master-mute' });
      // Engine moved AND the runner observed the kind.
      expect(engine.isMasterMuted()).toBe(true);
      expect(received).toEqual(['toggle-master-mute']);
      loader.dispose();
      await loader.idle();
    });

    it('tears down the presenter subscription when a `mode=present` navigation completes normally (no leak across successful runs)', async () => {
      // Finding 1 from the codex review, post-PUL-F025: the
      // presenter controller's only teardown path used to be the
      // navigation `AbortSignal`. A `mode=present` navigation that
      // resolved normally (the resolver finished + `load.settled`
      // resolved) would clear `inFlight` without aborting the
      // navigation controller, leaving the loader-owned mute
      // subscription (and any runner-owned subscription) attached
      // to the long-lived `PresenterCommandSource`. Across many
      // successful navigations, stale wrappers would accumulate.
      //
      // Pin the fix: after a successful navigation completes, the
      // workbench source has zero attached handlers — the loader's
      // happy-path teardown disposed the presenter controller.
      const engine = freshAudioEngine();
      const fake = buildFakeSource();
      const sceneA = buildScene({ id: 'scene-a' });
      // Adapter resolves immediately — successful normal completion.
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        audioEngine: engine,
        presenterCommands: fake.source,
      });
      await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
      expect(fake.handlerCount()).toBe(0);
      // A second successful navigation must also leave the source
      // clean — a regression that only fixed the first nav would
      // pass the assertion above and fail here as the second
      // controller leaks.
      await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
      expect(fake.handlerCount()).toBe(0);
    });

    it('keeps the navigation `AbortSignal` un-aborted after a successful completion (the presenter teardown uses its own lifecycle signal)', async () => {
      // Layered defense for the PUL-F013-boundary invariant: the
      // happy-path presenter teardown MUST use a separate
      // AbortController from the navigation `controller` so the
      // navigation signal's "un-aborted at runner receive time AND
      // un-aborted across a successful completion" property is
      // preserved. A regression that aborted the navigation
      // controller in `finally` to tear down the presenter
      // controller would flip this invariant — the cached signal
      // reference on the recorded run options would show
      // `aborted: true` after navigation completes.
      const engine = freshAudioEngine();
      const fake = buildFakeSource();
      const sceneA = buildScene({ id: 'scene-a' });
      const rec = recordingTimeline();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: rec.adapter,
        audioEngine: engine,
        presenterCommands: fake.source,
      });
      await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
      expect(rec.calls).toHaveLength(1);
      // Navigation signal stays un-aborted across a successful
      // completion. Presenter teardown happens via the separate
      // `presenterAbort` signal in `InFlightLoad`.
      expect(rec.calls[0]?.opts.signal?.aborted).toBe(false);
      // And the presenter source's wrappers were nonetheless
      // detached — proving both invariants hold simultaneously.
      expect(fake.handlerCount()).toBe(0);
    });

    it('surfaces a subscribe-time throw from `presenterCommands.subscribe` through the loader `onError` envelope (does not escape `buildLoad`)', async () => {
      // Finding 3 from the codex review, post-PUL-F025: the loader
      // now subscribes a navigation-owned audio handler in
      // `buildLoad`. A workbench source whose `subscribe` throws
      // during registration would have escaped past the existing
      // stage-attr rollback + `surfaceError` envelope, leaving the
      // navigation in an inconsistent state. Pin the fix: a
      // throwing source surfaces a diagnostic via `onError` and the
      // navigation still settles (the resolver still runs because
      // the loader's `buildLoad` returned without re-throwing).
      const engine = freshAudioEngine();
      const throwingSource: import('../../src/runtime/presenter').PresenterCommandSource = {
        subscribe() {
          throw new Error('source subscribe failed (test)');
        },
      };
      const sceneA = buildScene({ id: 'scene-a' });
      const errors: unknown[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        audioEngine: engine,
        presenterCommands: throwingSource,
        onError: (err) => errors.push(err),
      });
      await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
      // The subscribe-time throw was routed through `onError`
      // exactly once and did NOT abort the navigation. A regression
      // that let the throw escape `buildLoad` would either reject
      // the handle promise or leave stale stage attrs (the latter
      // detectable by additional tests; the former by this `await`
      // throwing). The exact count of 1 also pins that the
      // controller does NOT retry the source's subscribe (a
      // regression that mistakenly looped on transient failure
      // would surface here).
      const subscribeFailures = errors.filter(
        (e) => e instanceof Error && /subscribe failed/i.test(e.message),
      );
      expect(subscribeFailures).toHaveLength(1);
    });

    it('drops misspelled mute kinds (`mute`, `master-mute`, `unmute`) at the controller boundary — audio is never toggled', async () => {
      // PUL-F025 spelling defense at the loader level: only the full
      // `'toggle-master-mute'` reaches the audio handler. Common
      // drift candidates that pass static-string checks but fail the
      // allowlist must be dropped at `isPresenterCommand` and never
      // touch the engine. Mirrors the unit-level coverage in
      // `presenter.test.ts` but pinned at the integrated seam.
      const engine = freshAudioEngine();
      const fake = buildFakeSource();
      const errors: unknown[] = [];
      let runnerEntered: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const sceneA = buildScene({
        id: 'scene-a',
        create: () => {
          runnerEntered();
        },
      });
      const runner = (input: LegacyRunInput): Promise<void> =>
        new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        audioEngine: engine,
        presenterCommands: fake.source,
        onError: (err) => errors.push(err),
      });
      void loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
      await ready;
      fake.emit({ kind: 'mute' });
      fake.emit({ kind: 'master-mute' });
      fake.emit({ kind: 'unmute' });
      expect(engine.isMasterMuted()).toBe(false);
      // Centralized validation surfaces exactly one diagnostic per
      // rejected emission, regardless of subscriber count — so 3
      // misspelled kinds yield 3 errors. A regression to per-
      // subscriber validation would emit 3 × subscribers and fail
      // this exact-count assertion.
      const rejects = errors.filter((e) => e instanceof Error && /presenter/i.test(e.message));
      expect(rejects).toHaveLength(3);
      loader.dispose();
      await loader.idle();
    });

    /* ---------------------------------------------------------------- *
     *  PUL-Q010 — master mute responsiveness (≤ 100 ms)
     *
     *  PUL-Q010 statement: "Master mute SHALL silence active audio
     *  playback within 100 milliseconds of being engaged."
     *
     *  Engagement is the accepted `'toggle-master-mute'` command at
     *  the presenter controller boundary; silence is delivered by
     *  the audio engine's master mute (`Howler.mute(true)` in the
     *  production engine — see `audio.ts`). The runtime seam being
     *  bounded is therefore:
     *
     *    source.emit({ kind: 'toggle-master-mute' })
     *      → controller.centralWrapped (validation + fan-out)
     *      → loader audio handler (`audio.mute(!audio.isMuted())`)
     *      → engine.setMasterMute(...) returns.
     *
     *  The path is synchronous in production code: no `await`, no
     *  `queueMicrotask`, no timer, no fade interpolation, no runner
     *  hop. The tests below pin THAT property structurally so a
     *  future regression toward async work or subscription-order
     *  drift cannot blow the 100 ms bound silently. They use a
     *  deterministic fake engine that records `performance.now()`
     *  at each `setMasterMute` invocation and a shared `events[]`
     *  sequence labeling each observable side-effect, so ordering
     *  and wall-clock are both first-class assertions.
     *
     *  Companion audio-service-layer tests live in
     *  `tests/runtime/audio.test.ts` PUL-Q010 block; together they
     *  pin the full audio-side of the latency path.
     * ---------------------------------------------------------------- */

    /** Engine fake that records wall-clock + ordering for PUL-Q010. */
    const instrumentedAudioEngine = (muteTimes: number[], events: string[]): AudioEngine => {
      let muted = false;
      const noopHandle = {
        play: () => 0,
        stop: () => undefined,
        fade: () => undefined,
        loop: () => undefined,
        volume: () => undefined,
        unload: () => undefined,
      };
      return {
        createSound: () => noopHandle,
        setMasterMute: (m: boolean) => {
          muted = m;
          muteTimes.push(performance.now());
          events.push('audio-flip');
        },
        isMasterMuted: () => muted,
        unlock: () => Promise.resolve(),
      };
    };

    // PUL-Q010's 100 ms budget collapses to "synchronous" at the
    // runtime seam: a single synchronous call chain
    // (`source.emit` → controller fan-out → loader handler →
    // `AudioService.mute` → `AudioEngine.setMasterMute`) costs
    // sub-millisecond on any realistic V8, so the 100 ms wall-clock
    // bound is satisfied by proving the path is synchronous. A
    // wall-clock assertion would be both flaky (GC / OS pauses) and
    // strictly weaker than the structural observability check below;
    // see codex review cycle 1 on issue 49. The structural test is
    // the gate of record.
    it('PUL-Q010 — engine master mute is observable synchronously on the next statement after `emit`', async () => {
      // The synchronous-path invariant: a microtask-deferred
      // implementation (e.g., `queueMicrotask(() => audio.mute(...))`
      // in the loader handler, or `Promise.resolve().then(...)` in
      // the audio service) would leave the engine state unchanged
      // on the very next line after `emit(...)`. Pinning this
      // separately from the wall-clock test means a regression
      // toward microtask deferral fails LOUD here even on a CI
      // whose `performance.now()` granularity would still satisfy
      // the 100 ms bound.
      const engine = instrumentedAudioEngine([], []);
      const m = mountPresent({ mode: 'present', engine });
      await m.readyP;
      expect(engine.isMasterMuted()).toBe(false);
      m.fake.emit({ kind: 'toggle-master-mute' });
      // No await between these two lines — a microtask-deferred
      // implementation would see `false` here.
      expect(engine.isMasterMuted()).toBe(true);
      m.loader.dispose();
      await m.loader.idle();
    });

    it('PUL-Q010 — the loader audio handler runs BEFORE any runner-supplied subscriber on the same emission', async () => {
      // The preflight guardrail: "A slow or throwing runner handler
      // must not sit before the audio mute action on the critical
      // path." The controller fans subscribers out in subscription
      // order; the loader subscribes the audio handler in
      // `buildPresenterPipe` BEFORE the runner subscribes via
      // `input.presenter.subscribe(...)`. A regression that moved
      // the audio handler subscription into `runner(input)` (or
      // any later seam) would put it AFTER the runner subscriber
      // in the fan-out and a slow runner could delay the engine
      // flip past 100 ms.
      const muteTimes: number[] = [];
      const events: string[] = [];
      const engine = instrumentedAudioEngine(muteTimes, events);
      const fake = buildFakeSource();
      let runnerEntered: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const sceneA = buildScene({ id: 'scene-a' });
      const runner = (input: LegacyRunInput): Promise<void> => {
        input.presenter?.subscribe((cmd) => {
          if (cmd.kind === 'toggle-master-mute') events.push('runner-saw-cmd');
        });
        runnerEntered();
        return new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        audioEngine: engine,
        presenterCommands: fake.source,
      });
      void loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
      await ready;
      fake.emit({ kind: 'toggle-master-mute' });
      // The audio flip is the FIRST observable side-effect; the
      // runner subscriber sees the command strictly after.
      expect(events).toEqual(['audio-flip', 'runner-saw-cmd']);
      loader.dispose();
      await loader.idle();
    });

    it('PUL-Q010 — a slow runner subscriber cannot delay the engine flip past 100 ms', async () => {
      // Strongest form of the handler-ordering invariant: even
      // when the runner subscriber does a deliberate synchronous
      // busy-loop, the engine flip has already happened BEFORE
      // the loop starts — because the loader's audio handler is
      // FIRST in the fan-out and its work (one boolean flip) is
      // complete before control reaches the runner's handler.
      // Asserted via ordering AND wall-clock: the
      // `setMasterMute` timestamp is captured before the busy-
      // loop's start timestamp, so a regression that pushed the
      // audio handler after the runner would surface as either
      // an inverted `events[]` order OR a `muteTimes[0]` reading
      // AFTER the loop wall-clock.
      const muteTimes: number[] = [];
      const events: string[] = [];
      const engine = instrumentedAudioEngine(muteTimes, events);
      const fake = buildFakeSource();
      let runnerEntered: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const sceneA = buildScene({ id: 'scene-a' });
      let busyStart = -1;
      let busyEnd = -1;
      const runner = (input: LegacyRunInput): Promise<void> => {
        input.presenter?.subscribe((cmd) => {
          if (cmd.kind !== 'toggle-master-mute') return;
          busyStart = performance.now();
          // Bounded busy loop: deliberately spin for ~5 ms so
          // any "runner-runs-first" regression would put
          // `muteTimes[0]` AT OR AFTER `busyEnd`.
          while (performance.now() - busyStart < 5) {
            // intentionally empty busy loop
          }
          busyEnd = performance.now();
        });
        runnerEntered();
        return new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        audioEngine: engine,
        presenterCommands: fake.source,
      });
      void loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
      await ready;
      fake.emit({ kind: 'toggle-master-mute' });
      expect(muteTimes).toHaveLength(1);
      expect(busyStart).toBeGreaterThan(0);
      expect(busyEnd).toBeGreaterThanOrEqual(busyStart);
      // The engine flip happened strictly before the runner's
      // busy loop started — a regression that put the runner
      // first would have `muteTimes[0] >= busyEnd`.
      const firstMuteTime = muteTimes[0] ?? Number.NaN;
      expect(firstMuteTime).toBeLessThan(busyEnd);
      // Even with the runner's deliberate ~5 ms spin in the
      // same fan-out, the engine flip stayed comfortably under
      // 100 ms because it ran first.
      loader.dispose();
      await loader.idle();
    });

    it('PUL-Q010 — a throwing runner subscriber does NOT prevent the engine flip', async () => {
      // Per-subscriber isolation guarantee: the controller wraps
      // each subscriber's handler in try/catch (presenter.ts
      // `centralWrapped`). A runner subscriber that throws on
      // `'toggle-master-mute'` cannot prevent the loader's audio
      // handler (which already executed first per the ordering
      // invariant above) from having flipped the engine. The
      // throw is surfaced via the loader's `onError` sink.
      const muteTimes: number[] = [];
      const events: string[] = [];
      const engine = instrumentedAudioEngine(muteTimes, events);
      const fake = buildFakeSource();
      const errors: unknown[] = [];
      let runnerEntered: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        runnerEntered = resolve;
      });
      const sceneA = buildScene({ id: 'scene-a' });
      const runner = (input: LegacyRunInput): Promise<void> => {
        input.presenter?.subscribe((cmd) => {
          if (cmd.kind === 'toggle-master-mute') throw new Error('runner subscriber boom');
        });
        runnerEntered();
        return new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: buildStage().element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        audioEngine: engine,
        presenterCommands: fake.source,
        onError: (err) => errors.push(err),
      });
      void loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
      await ready;
      fake.emit({ kind: 'toggle-master-mute' });
      expect(engine.isMasterMuted()).toBe(true);
      expect(muteTimes).toHaveLength(1);
      const boomErrors = errors.filter(
        (e) => e instanceof Error && /runner subscriber boom/.test(e.message),
      );
      expect(boomErrors).toHaveLength(1);
      loader.dispose();
      await loader.idle();
    });
  });
});
