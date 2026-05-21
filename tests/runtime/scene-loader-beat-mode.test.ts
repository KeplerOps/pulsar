import { describe, expect, it, vi } from 'vitest';
import {
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

describe('createSceneLoader — beat positioning & mode dispatch (PUL-F008)', () => {
  describe('beat positioning (PUL-F011)', () => {
    // PUL-F011: when `beat=<label>` is present, the runtime SHALL
    // position the active scene's timeline at the named label; if the
    // label does not exist, surface an error and remain at the scene's
    // first beat. ADR-015 places label existence + seeking in the
    // timeline-runner boundary; the loader's job is to:
    //   (a) extract `target.beat` and forward it to the runner;
    //   (b) provide an `onBeatMissing` callback that writes the
    //       `data-pulsar-navigation-error` attribute + calls `onError`
    //       WITHOUT unmounting the scene (no rejection through the
    //       resolver, which would trigger cleanup).

    const sceneTargetWithBeat = (id: string, beat: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      beat,
    });

    it('forwards `beat` from the parsed navigation target to the runner', async () => {
      const seen: { beat?: string }[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline((input) => {
          const captured: { beat?: string } = {};
          if ('beat' in input) captured.beat = input.beat;
          seen.push(captured);
        }),
      });

      await loader.handle(sceneTargetWithBeat('intro', 'hook'));

      expect(seen).toEqual([{ beat: 'hook' }]);
    });

    it('keeps the scene mounted while the runner is still active after onBeatMissing (PUL-F011 "remain at the scene\'s first beat")', async () => {
      // The substantive PUL-F011 invariant: a missing-label diagnostic
      // MUST NOT cause the scene to be unmounted. Reading "create then
      // cleanup" alone is insufficient evidence — that just describes
      // any normal lifecycle. The test instead holds the runner pending
      // (so the scene is "live"), observes the diagnostic surfaced AND
      // the scene is still mounted (cleanup has NOT yet fired), then
      // releases the runner and confirms cleanup ran on natural exit.
      // This pins that the missing-beat path does NOT short-circuit the
      // resolver into an early cleanup.
      const captured: unknown[] = [];
      const lifecycleLog: string[] = [];
      let resolveRunner: (() => void) | undefined;
      const runnerGate = new Promise<void>((res) => {
        resolveRunner = res;
      });
      let runnerEntered: (() => void) | undefined;
      const runnerEnteredBarrier = new Promise<void>((res) => {
        runnerEntered = res;
      });
      const intro = buildScene({
        id: 'intro',
        create: () => {
          lifecycleLog.push('create');
        },
        cleanup: () => {
          lifecycleLog.push('cleanup');
        },
      });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(async (input) => {
          // Simulate an unknown timeline label: runner reports the
          // diagnostic via `onBeatMissing`, signals the test that
          // it has entered, and stays alive (await gate). The
          // runner MUST NOT throw — that would trigger cleanup and
          // unmount the scene per PUL-F006.
          input.onBeatMissing?.();
          runnerEntered?.();
          await runnerGate;
        }),
        onError: (err) => {
          captured.push(err);
        },
      });

      const handlePromise = loader.handle(sceneTargetWithBeat('intro', 'unknown-label'));

      // Block until the runner has fired the diagnostic and is
      // awaiting the gate. This synchronizes the assertions to a
      // deterministic lifecycle point — independent of how many
      // microtasks the queue / dispatcher / resolver chain costs.
      await runnerEnteredBarrier;

      // While the runner is still pending: scene IS mounted (create
      // fired, cleanup has NOT), the diagnostic IS surfaced. This is
      // the substantive "remain at the scene's first beat" assertion.
      expect(lifecycleLog).toEqual(['create']);
      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBe(
        'beat positioning failed: scene "intro" at beat "unknown-label" — beat does not exist',
      );
      expect(captured).toHaveLength(1);
      expect((captured[0] as Error).message).toBe(
        'beat positioning failed: scene "intro" at beat "unknown-label" — beat does not exist',
      );

      // Release the runner so the lifecycle completes naturally.
      // Cleanup runs only now — proves the diagnostic did NOT
      // short-circuit into an early unmount.
      resolveRunner?.();
      await handlePromise;
      expect(lifecycleLog).toEqual(['create', 'cleanup']);
    });

    it('suppresses a missing-beat diagnostic if the runner reports after the load was aborted by a superseding navigation (signal.aborted guard)', async () => {
      // Defense parallel to `isPureAbort` for fatal-error suppression:
      // a runner that calls `onBeatMissing` AFTER its navigation was
      // superseded (popstate / new handle() / dispose) must NOT write
      // a diagnostic for the dead navigation. Otherwise the stage
      // would carry the previous URL's beat error after the next
      // navigation completed. This test specifically exercises the
      // `signal.aborted` branch of the closure (NOT the `disposed`
      // branch — that's covered by the dispose-then-fire variant).
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      let capturedOnBeatMissing: (() => void) | undefined;
      let resolveFirstRunner: (() => void) | undefined;
      const firstRunnerGate = new Promise<void>((res) => {
        resolveFirstRunner = res;
      });
      let firstRunnerEntered: (() => void) | undefined;
      const firstRunnerEnteredBarrier = new Promise<void>((res) => {
        firstRunnerEntered = res;
      });
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(async (input) => {
          if (input.beat !== undefined) {
            // Capture the callback but do not fire it yet. The first
            // navigation is held open via the gate, then aborted by
            // the second handle() below; we'll fire the captured
            // callback AFTER the abort so the closure sees
            // `signal.aborted === true` (and `disposed === false`).
            capturedOnBeatMissing = input.onBeatMissing;
            firstRunnerEntered?.();
            await firstRunnerGate;
          }
        }),
        onError: (err) => {
          captured.push(err);
        },
      });

      // Start the first navigation but do NOT await it — the runner
      // is parked on `firstRunnerGate`.
      const firstHandle = loader.handle(sceneTargetWithBeat('intro', 'unknown-label'));
      await firstRunnerEnteredBarrier;

      // Enqueue a second navigation. `enqueue()` aborts the in-flight
      // load via `inFlight.controller.abort()` — that flips the first
      // navigation's signal.aborted to true. The second navigation
      // proceeds to wait for the first to settle (it won't, until we
      // release the gate below).
      const secondHandle = loader.handle(sceneTarget('intro'));

      // The first runner's signal is now aborted. Fire its captured
      // callback — the closure must observe `signal.aborted === true`
      // and no-op (the loader is NOT disposed). Without the guard,
      // this would write `data-pulsar-navigation-error` for a dead
      // navigation.
      capturedOnBeatMissing?.();

      // Release the first runner's gate so the lifecycle drains and
      // the second navigation can proceed.
      resolveFirstRunner?.();
      await firstHandle;
      await secondHandle;

      // Stage carries the second navigation's scene (`intro` with no
      // beat) and no error attribute — the stale beat-missing was
      // suppressed.
      expect(captured).toEqual([]);
      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
    });

    it('suppresses a missing-beat diagnostic if the runner reports after dispose (disposed guard)', async () => {
      // Sibling of the signal.aborted test above — proves the
      // `disposed` branch of the closure independently.
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      let capturedOnBeatMissing: (() => void) | undefined;
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline((input) => {
          // Capture but don't fire; the runner exits immediately so
          // the lifecycle settles. Then dispose; then fire.
          capturedOnBeatMissing = input.onBeatMissing;
        }),
        onError: (err) => {
          captured.push(err);
        },
      });

      await loader.handle(sceneTargetWithBeat('intro', 'unknown-label'));
      // Drop the diagnostic the runner DID surface during the first
      // navigation — focus the test on a SECOND, late call.
      stage.attrs.delete('data-pulsar-navigation-error');
      captured.length = 0;

      loader.dispose();
      capturedOnBeatMissing?.();

      expect(captured).toEqual([]);
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
    });

    it('keeps the missing-beat path non-fatal when the injected onError sink throws', async () => {
      // PUL-F011 / ADR-015: the diagnostic callback is contractually
      // non-fatal — the runner is forbidden from throwing on missing
      // labels. The injected `onError` sink is user-supplied, so an
      // exception from it must NOT propagate back through
      // `input.onBeatMissing()` into the resolver (which would treat
      // it as a lifecycle failure and unmount the scene). Cleanup is
      // therefore the natural lifecycle exit, NOT a phase-error
      // wrap, when onError throws.
      const lifecycleLog: string[] = [];
      const intro = buildScene({
        id: 'intro',
        create: () => {
          lifecycleLog.push('create');
        },
        cleanup: () => {
          lifecycleLog.push('cleanup');
        },
      });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline((input) => {
          input.onBeatMissing?.();
          // If onBeatMissing's surfaceError had thrown out, this
          // line would not execute and the runner would surface a
          // rejection — the assertion below would catch it.
        }),
        onError: () => {
          throw new Error('user-injected logger blew up');
        },
      });

      await expect(
        loader.handle(sceneTargetWithBeat('intro', 'unknown-label')),
      ).resolves.toBeUndefined();

      // Lifecycle ran end-to-end as expected for a successful
      // missing-beat exit. cleanup fired naturally; no extra
      // phase-error wrap, no AggregateError, no rejection.
      expect(lifecycleLog).toEqual(['create', 'cleanup']);
    });

    it('only fires the diagnostic once per navigation even if the runner calls onBeatMissing repeatedly', async () => {
      // A buggy runner (or a future GSAP integration that retries on
      // each beat-not-found) must not spam the error sink. Once-only
      // gating matches every other surfaceError call in the loader.
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline((input) => {
          input.onBeatMissing?.();
          input.onBeatMissing?.();
          input.onBeatMissing?.();
        }),
        onError: (err) => {
          captured.push(err);
        },
      });

      await loader.handle(sceneTargetWithBeat('intro', 'unknown-label'));

      expect(captured).toHaveLength(1);
    });

    it('rejects a constructed target whose `beat` value is not kebab-case (defense-in-depth for parser)', async () => {
      // The parser validates `beat` shape; the loader re-validates so
      // a hand-built `NavigationTarget` (event-detail unmarshaling,
      // programmatic navigation) cannot bypass kebab-case enforcement.
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError: (err) => {
          captured.push(err);
        },
      });

      const malformed: NavigationTarget = {
        locator: { kind: 'scene', scene: 'intro' },
        // `Bad Label` has uppercase + space — invalid kebab.
        // Cast to string is needed because the type annotation on
        // `beat` is `string`, but parser enforcement makes any
        // non-kebab beat unreachable in normal flow.
        beat: 'Bad Label' as unknown as string,
      };

      await loader.handle(malformed);

      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(
        /^navigation grammar is invalid: "beat" must be a non-empty lowercase kebab-case string/,
      );
      expect(captured).toHaveLength(1);
    });

    it('a successful beat (runner does NOT invoke onBeatMissing) leaves the error attribute absent', async () => {
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline, // simulates successful seek
      });

      await loader.handle(sceneTargetWithBeat('intro', 'hook'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('intro');
      expect(stage.attrs.has('data-pulsar-navigation-error')).toBe(false);
    });

    it('rejects a constructed `composition`-only target with `beat` (defense-in-depth for ADR-013)', async () => {
      // `parseNavigationSearch` already rejects `composition=<id>&beat=<label>`,
      // but `NavigationTarget` is an exported type and a non-parser
      // caller could construct one directly. The loader re-enforces
      // the rule before any side effect so a hand-built target does
      // not bypass the grammar invariant the parser would have caught.
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([{ id: 'full-talk', manifest: ['intro'] }]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError: (err) => {
          captured.push(err);
        },
      });

      const compositionOnlyWithBeat: NavigationTarget = {
        locator: { kind: 'composition', composition: 'full-talk' },
        beat: 'hook',
      };

      await loader.handle(compositionOnlyWithBeat);

      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
      expect(stage.attrs.has('data-pulsar-composition-target')).toBe(false);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(
        /^navigation grammar is invalid: "beat" requires a scene-like target/,
      );
      expect(captured).toHaveLength(1);
    });

    it('targets without `beat` carry no `beat` or `onBeatMissing` on the run input', async () => {
      const seen: { beatPresent: boolean; onBeatMissingPresent: boolean }[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline((input) => {
          seen.push({
            beatPresent: 'beat' in input,
            onBeatMissingPresent: 'onBeatMissing' in input,
          });
        }),
      });

      await loader.handle(sceneTarget('intro'));

      expect(seen).toEqual([{ beatPresent: false, onBeatMissingPresent: false }]);
    });
  });

  describe('mode dispatch (PUL-F012)', () => {
    // PUL-F012 / ADR-007: when the parsed `NavigationTarget` carries
    // `mode`, the loader selects the corresponding workbench mode.
    // Absent `mode` defaults to `'present'`. Mode dispatch lives in
    // the runtime core (this loader), not in scenes — the loader
    // calls `options.buildCtx(effectiveMode)` once per navigation,
    // and the returned ctx (carrying `mode`) is what scenes see.
    //
    // The "URL is the only source" rule (no localStorage,
    // sessionStorage, cookies, history.state, cached state) is pinned
    // by the across-navigation no-leak test below: a navigation that
    // sets a non-`present` mode must not influence a subsequent
    // `mode`-less navigation's effective mode.

    interface ModeProbe {
      readonly modes: NavigationMode[];
      readonly buildCtx: (
        mode: NavigationMode,
        audio: AudioService,
      ) => Omit<WorkbenchSceneCtx, 'activation'>;
    }

    const buildModeProbe = (): ModeProbe => {
      const modes: NavigationMode[] = [];
      return {
        modes,
        buildCtx: vi.fn(
          (mode: NavigationMode, audio: AudioService): Omit<WorkbenchSceneCtx, 'activation'> => {
            modes.push(mode);
            return { stage: null, mode, gsap, audio };
          },
        ),
      };
    };

    // PUL-F019 / ADR-022: under `mode=prompter` the loader bypasses
    // the resolver lifecycle structurally — `buildCtx` is NOT
    // invoked because there is no scene to mount. The
    // buildCtx-per-mode test therefore only applies to the six
    // lifecycle-running modes; prompter's "no buildCtx invocation"
    // invariant is pinned by the dedicated `prompter-mode caption-
    // view dispatch (PUL-F019)` block.
    const LIFECYCLE_MODES = NAVIGATION_MODES.filter((m) => m !== 'prompter');

    it.each(LIFECYCLE_MODES)(
      'invokes buildCtx with %s when target.mode is %s (clause 1: explicit mode is selected)',
      async (mode) => {
        const intro = buildScene({ id: 'intro' });
        const stage = buildStage();
        const probe = buildModeProbe();
        const loader = createSceneLoader({
          scenes: createSceneRegistry([intro]),
          compositions: createCompositionRegistry([]),
          stage: stage.element,
          buildCtx: probe.buildCtx,
          createPreloader: () => () => undefined,
          timeline: noopTimeline,
        });

        await loader.handle({ locator: { kind: 'scene', scene: 'intro' }, mode });

        expect(probe.modes).toEqual([mode]);
      },
    );

    it('does NOT invoke buildCtx when target.mode is "prompter" (PUL-F019: lifecycle is structurally bypassed under prompter)', async () => {
      // The structural inverse of the lifecycle-mode test above —
      // pinned here so PUL-F012's mode-dispatch block is honest
      // about which modes actually run the lifecycle.
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
      });

      await loader.handle({ locator: { kind: 'scene', scene: 'intro' }, mode: 'prompter' });

      expect(probe.modes).toEqual([]);
    });

    it('invokes buildCtx with "present" when target.mode is absent (clause 2: default is present)', async () => {
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
      });

      await loader.handle(sceneTarget('intro'));

      expect(probe.modes).toEqual(['present']);
    });

    it('the ctx threaded into the lifecycle carries the effective mode', async () => {
      // The ctx the loader hands the lifecycle MUST carry the mode
      // value returned by buildCtx — proves the per-navigation ctx
      // (not a stale cached one) is what scenes receive on every
      // hook (`create` / `timeline` / `cleanup`).
      const seen: { phase: string; mode: unknown }[] = [];
      const recordMode = (phase: string) => (ctx: unknown) => {
        seen.push({
          phase,
          mode: (ctx as { mode?: NavigationMode }).mode,
        });
      };
      const intro = buildScene({
        id: 'intro',
        create: recordMode('create'),
        timeline: ((ctx: unknown) => {
          recordMode('timeline')(ctx);
        }) as SceneModule['timeline'],
        cleanup: recordMode('cleanup'),
      });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: (mode, audio: AudioService) => ({ stage: stage.element, mode, gsap, audio }),
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
      });

      await loader.handle({ locator: { kind: 'scene', scene: 'intro' }, mode: 'screenshot' });

      expect(seen).toEqual([
        { phase: 'create', mode: 'screenshot' },
        { phase: 'timeline', mode: 'screenshot' },
        { phase: 'cleanup', mode: 'screenshot' },
      ]);
    });

    it('a previous non-present mode does not leak into a later mode-less navigation (ADR-007 risk-table)', async () => {
      // ADR-007 risk-table: "A previous non-`present` mode leaks into
      // a URL without `mode`" — mitigation: "Treat omitted `mode` as a
      // fresh `present` selection on every startup and `popstate`; do
      // not cache the last effective mode." This is the canonical
      // regression test: load with mode=screenshot, then load with no
      // mode, and verify the second navigation's ctx carries `present`,
      // NOT `screenshot`.
      //
      // Two assertions in one test: (a) the probe's `buildCtx` was
      // called with the right effective mode at each step, AND (b) the
      // ctx that actually reaches the second scene's lifecycle hooks
      // carries `mode: 'present'`. The second assertion guards against
      // a regression that calls `buildCtx('present')` correctly but
      // accidentally reuses the previously-built `{ mode: 'screenshot' }`
      // ctx — that bug would pass the input-only assertion but leak the
      // stale mode to the runner / scene.
      const seen: { sceneId: string; mode: unknown }[] = [];
      const recordCreate =
        (sceneId: string) =>
        (ctx: unknown): void => {
          seen.push({ sceneId, mode: (ctx as { mode?: NavigationMode }).mode });
        };
      const intro = buildScene({ id: 'intro', create: recordCreate('intro') });
      const outro = buildScene({ id: 'outro', create: recordCreate('outro') });
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro, outro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
      });

      await loader.handle({ locator: { kind: 'scene', scene: 'intro' }, mode: 'screenshot' });
      await loader.handle({ locator: { kind: 'scene', scene: 'outro' } });

      expect(probe.modes).toEqual(['screenshot', 'present']);
      expect(seen).toEqual([
        { sceneId: 'intro', mode: 'screenshot' },
        { sceneId: 'outro', mode: 'present' },
      ]);
    });

    it('does not invoke buildCtx when the locator is `kind: "none"` (no scene mounts)', async () => {
      // The runtime does not mount any scene for `?` (no explicit
      // target), so the per-navigation ctx is never assembled — there
      // is nothing to hand it to. Without this contract, an "always
      // build ctx" loader would invoke the workbench's `buildCtx` for
      // every popstate even when no lifecycle ran, which makes
      // ctx-build cost (e.g. async stage allocation) charge the no-op
      // path.
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
      });

      await loader.handle(noneTarget);

      expect(probe.modes).toEqual([]);
    });

    it('does not invoke buildCtx on parse-error events (handleError path)', async () => {
      // The error path writes the navigation-error attribute and runs
      // `onError`; no lifecycle runs, so no ctx is needed. Asserting
      // `buildCtx` was not invoked stops a regression that
      // pre-emptively built ctx on the error path (wasted allocation
      // and a misleading "fresh navigation" signal to mode listeners).
      // Pin the surface-error contract too so a regression that
      // silently drops the `surfaceError` call on the handleError
      // path cannot pass this test (it would otherwise look identical
      // to "correctly handled, no lifecycle").
      const captured: unknown[] = [];
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError: (err) => {
          captured.push(err);
        },
      });

      loader.handleError(new Error('navigation grammar is invalid: parse failure'));
      await loader.idle();

      expect(probe.modes).toEqual([]);
      expect(captured).toHaveLength(1);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(
        /navigation grammar is invalid: parse failure/,
      );
    });

    it('rejects a constructed target with an unknown mode (defense-in-depth for ADR-007)', async () => {
      // `parseNavigationSearch` already rejects unknown modes, but
      // `NavigationTarget` is an exported type and a non-parser caller
      // could construct one directly. The loader re-enforces the
      // ADR-007 mode allowlist before any side effect so a hand-built
      // target does not bypass the grammar invariant the parser would
      // have caught — same defense-in-depth pattern used for `beat`.
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError: (err) => {
          captured.push(err);
        },
      });

      const malformedMode: NavigationTarget = {
        locator: { kind: 'scene', scene: 'intro' },
        mode: 'shouty-mode' as unknown as NavigationMode,
      };

      await loader.handle(malformedMode);

      expect(probe.modes).toEqual([]);
      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(
        /^navigation grammar is invalid: "mode"/,
      );
      expect(captured).toHaveLength(1);
    });

    it('surfaces a buildCtx exception via onError and resets stage attrs (no stale targets)', async () => {
      // A throwing builder must NOT leave stale `data-pulsar-scene-target`
      // / `data-pulsar-composition-target` attrs on the stage, must
      // surface the error through the configured `onError` sink, and
      // must keep the navigation queue healthy (subsequent handle()
      // calls succeed). Without this contract, a workbench with a
      // crashing ctx-builder would lie to the operator about a
      // half-loaded scene and reject every queued navigation.
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const outro = buildScene({ id: 'outro' });
      const stage = buildStage();
      let ctxCalls = 0;
      const buildCtx = (
        mode: NavigationMode,
        audio: AudioService,
      ): Omit<WorkbenchSceneCtx, 'activation'> => {
        ctxCalls += 1;
        if (ctxCalls === 1) {
          throw new Error('builder bug');
        }
        return { stage: null, mode, gsap, audio };
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro, outro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError: (err) => {
          captured.push(err);
        },
      });

      await loader.handle(sceneTarget('intro'));

      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
      expect(stage.attrs.has('data-pulsar-composition-target')).toBe(false);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(/builder bug/);
      expect(captured).toHaveLength(1);
      expect((captured[0] as Error).message).toBe('builder bug');

      // The queue is still healthy: a subsequent navigation runs
      // through the lifecycle normally.
      await loader.handle(sceneTarget('outro'));
      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('outro');
    });

    it('aborts the per-load AbortController when buildCtx throws (no signal-tied resource leak)', async () => {
      // The preloader factory has already received the controller's
      // signal before buildCtx runs. If buildCtx then throws, the
      // controller would otherwise be GC'd in the never-aborted state
      // and any abort-keyed listener registered against the signal
      // (e.g. a fetch listener) would never see cancellation. Pin
      // that the loader explicitly aborts on the buildCtx-throw path.
      let capturedSignal: AbortSignal | undefined;
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: () => {
          throw new Error('builder bug');
        },
        createPreloader: (signal) => {
          capturedSignal = signal;
          return () => undefined;
        },
        timeline: noopTimeline,
        onError: () => undefined,
      });

      await loader.handle(sceneTarget('intro'));

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('does not invoke buildCtx when the preloader factory throws (no wasted builder allocation)', async () => {
      // ADR-007 / PUL-F012 ordering: the loader builds the preloader
      // FIRST. If the preloader factory throws, no lifecycle runs and
      // no cleanup will consume any ctx. Asserting `buildCtx` was not
      // invoked stops a regression that pre-emptively ran the builder
      // (wasted side effects, plus a misleading "fresh navigation"
      // signal to mode listeners).
      // Also pin the rollback contract — a regression that suppresses
      // `resetStageAttrs()` + `surfaceError()` on this path would
      // leave the failure invisible (stage attrs would lie about a
      // half-loaded scene); the ctx-only assertion cannot tell the
      // difference between "correctly surfaced" and "silently
      // swallowed."
      const captured: unknown[] = [];
      const intro = buildScene({ id: 'intro' });
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([intro]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => {
          throw new Error('preloader factory bug');
        },
        timeline: noopTimeline,
        onError: (err) => {
          captured.push(err);
        },
      });

      await loader.handle(sceneTarget('intro'));

      expect(probe.modes).toEqual([]);
      expect(captured).toHaveLength(1);
      expect((captured[0] as Error).message).toContain('preloader factory bug');
      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(/preloader factory bug/);
    });

    it('does not invoke buildCtx when scene resolution fails (no lifecycle, no ctx)', async () => {
      // A target that names an unregistered scene fails resolution
      // before the lifecycle starts. There is no ctx-handoff to do
      // because nothing is mounted; charging buildCtx in this path
      // would be wasted work and could leak mode-aware listeners on
      // failed navigations.
      // Pin the surface-error contract too — a regression that drops
      // the `surfaceError(err)` call on the `resolveSceneNavigation`
      // catch path would leave the navigation silent (no stage error,
      // no `onError`); a ctx-only assertion would not catch that.
      const captured: unknown[] = [];
      const stage = buildStage();
      const probe = buildModeProbe();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: probe.buildCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        onError: (err) => {
          captured.push(err);
        },
      });

      await loader.handle(sceneTarget('does-not-exist'));

      expect(probe.modes).toEqual([]);
      expect(captured).toHaveLength(1);
      expect(stage.attrs.get('data-pulsar-navigation-error')).toMatch(/does-not-exist/);
      expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
    });
  });
});
