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

describe('createSceneLoader — standalone & loop modes (PUL-F008)', () => {
  describe('standalone-mode single-scene execution (PUL-F014)', () => {
    // PUL-F014 statement: in `mode=standalone`, the runtime SHALL render
    // a single scene with surrounding chrome, inter-scene transitions,
    // and audio bed suppressed; the scene SHALL run as if no surrounding
    // composition existed.
    //
    // Materially-implementable parts of the statement that this block
    // pins:
    //   - "Render a single scene" / "run as if no surrounding
    //     composition existed" — composition / composition+scene /
    //     composition+index targets resolve normally (composition
    //     validation still runs), but only the addressed head scene's
    //     lifecycle is executed. No following composition entry runs.
    //   - "Inter-scene transitions suppressed" — by virtue of
    //     single-scene execution there is no second scene to transition
    //     to; no later `runTimeline` call is made for the dropped
    //     slice. The suppression is structural.
    //   - `ctx.mode === 'standalone'` is exposed to every lifecycle
    //     hook of the head scene — the seam future chrome / audio
    //     surfaces (ADR-004 / future workbench-shell requirement) will
    //     read to decide their own suppression behavior. Today there is
    //     no chrome or audio bed in the repo to suppress, so no
    //     end-to-end suppression test is possible until those surfaces
    //     land.
    //   - No `data-pulsar-mode-*` suppression attribute is preemptively
    //     written under `standalone` (parity with ADR-016's invariant
    //     for `mode=present`; future modes are free to use that
    //     namespace if they actually need it).
    //
    // PUL-F014 stays DRAFT after this PR (ADR-017 records the
    // boundary; following the ADR-016 / PUL-F013 precedent). The
    // single-scene execution mechanism and the `ctx.mode` seam ARE
    // materially shipped; the three named suppression surfaces
    // (chrome, audio bed, inter-scene transitions) gate the
    // DRAFT → ACTIVE transition — each must land as a real surface
    // that actively reads `ctx.mode === 'standalone'` and suppresses,
    // with end-to-end tests alongside these seam tests.

    const standaloneCompositionTarget = (composition: string): NavigationTarget => ({
      locator: { kind: 'composition', composition },
      mode: 'standalone',
    });
    const standaloneCompositionSceneTarget = (
      composition: string,
      scene: string,
    ): NavigationTarget => ({
      locator: { kind: 'composition-scene', composition, scene },
      mode: 'standalone',
    });
    const standaloneCompositionIndexTarget = (
      composition: string,
      index: number,
    ): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'standalone',
    });
    const standaloneSceneTarget = (id: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      mode: 'standalone',
    });

    interface LifecycleProbe {
      readonly log: string[];
      readonly scenes: readonly SceneModule[];
      readonly compositionId: string;
      readonly runner: (input: LegacyRunInput) => void;
    }

    // Probe whose runner ALSO writes into the same lifecycle log so a
    // regression that bypassed `runTimeline` for the head scene under
    // standalone (e.g. "skip the runner because it's standalone") would
    // be caught — without the runner observation, dropping `runTimeline`
    // entirely would still emit `create → timeline → cleanup` and pass.
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
      const runner = (input: LegacyRunInput) => {
        log.push(`runTimeline:${input.scene.id}`);
      };
      return {
        log,
        scenes: [trace('scene-a'), trace('scene-b'), trace('scene-c')],
        compositionId,
        runner,
      };
    };

    it('runs only the head scene of a `composition` target under `mode=standalone` (no following entries fire)', async () => {
      // The composition lists three scenes; under `mode=standalone` only
      // the first must execute. A regression that forgot to drop the
      // composition slice would emit lifecycle entries for scene-b and
      // scene-c too.
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([
          { id: probe.compositionId, manifest: probe.scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(probe.runner),
      });

      await loader.handle(standaloneCompositionTarget(probe.compositionId));

      expect(probe.log).toEqual([
        'create:scene-a',
        'timeline:scene-a',
        'runTimeline:scene-a',
        'cleanup:scene-a',
      ]);
    });

    it('runs only the addressed scene of a `composition+scene` target under `mode=standalone`', async () => {
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([
          { id: probe.compositionId, manifest: probe.scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(probe.runner),
      });

      await loader.handle(standaloneCompositionSceneTarget(probe.compositionId, 'scene-b'));

      expect(probe.log).toEqual([
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline:scene-b',
        'cleanup:scene-b',
      ]);
    });

    it('runs only the entry at the requested index of a `composition+index` target under `mode=standalone` (skipping following entries — a last-index test would NOT catch a slice-truncation regression because the slice has no successors to skip)', async () => {
      // index=1 against [a, b, c] resolves to a slice [b, c]. Under
      // mode=standalone the loader must drop the trailing entry so
      // only scene-b runs; without the slice transform scene-c would
      // run too. Choosing a non-final index is what makes this test
      // a regression detector for the slice transform itself —
      // index=2 would slice to [c] and pass under any mode (no
      // successors), so it would fail to discriminate standalone from
      // present.
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([
          { id: probe.compositionId, manifest: probe.scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(probe.runner),
      });

      await loader.handle(standaloneCompositionIndexTarget(probe.compositionId, 1));

      expect(probe.log).toEqual([
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline:scene-b',
        'cleanup:scene-b',
      ]);
    });

    it('runs a direct `scene` target under `mode=standalone` unchanged (baseline parity — no slice to drop)', async () => {
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(probe.runner),
      });

      await loader.handle(standaloneSceneTarget('scene-b'));

      expect(probe.log).toEqual([
        'create:scene-b',
        'timeline:scene-b',
        'runTimeline:scene-b',
        'cleanup:scene-b',
      ]);
    });

    it('forwards `beat` to the head scene runner under `mode=standalone` and surfaces missing-beat as a non-fatal diagnostic', async () => {
      // Beat semantics under standalone are identical to other modes:
      // the runner sees `headBeat` on its input, and a missing-label
      // call from the runner surfaces via `data-pulsar-navigation-error`
      // and `onError` without unmounting the scene. A regression that
      // dropped beat forwarding for standalone would lose the diagnostic
      // surface for single-scene authoring — exactly the use case this
      // mode targets.
      const captured: { sceneId: string; beat: string | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, beat: input.beat });
        if (input.beat !== undefined && input.onBeatMissing !== undefined) {
          input.onBeatMissing();
        }
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
        onError: (err) => {
          errors.push(err);
        },
      });

      await loader.handle({
        locator: { kind: 'composition-scene', composition: 'full-talk', scene: 'scene-b' },
        mode: 'standalone',
        beat: 'midpoint',
      });

      // Only scene-b's runner ran (single-scene), with the beat
      // forwarded.
      expect(captured).toEqual([{ sceneId: 'scene-b', beat: 'midpoint' }]);
      // The missing-beat diagnostic surfaced via the loader's standard
      // path — `onError` invoked once with the loader's wrapping
      // message, and the stage attribute is set.
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('beat positioning failed');
      expect((errors[0] as Error).message).toContain('"midpoint"');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('exposes `ctx.mode === "standalone"` to every lifecycle hook of the head scene under all locator shapes', async () => {
      const seen: { phase: string; locatorKind: string; mode: unknown }[] = [];
      const recordMode =
        (phase: string, locatorKind: string) =>
        (ctx: unknown): unknown => {
          seen.push({ phase, locatorKind, mode: (ctx as { mode?: NavigationMode }).mode });
          return null;
        };
      // Build a single scene with phase recorders; we rebuild the loader
      // per locator-shape navigation so each navigation gets a fresh
      // recorder run without cross-contamination.
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

      await buildLoader('scene-a', 'scene').handle(standaloneSceneTarget('scene-a'));
      await buildLoader('scene-a', 'composition').handle(standaloneCompositionTarget('full-talk'));
      await buildLoader('scene-a', 'composition-scene').handle(
        standaloneCompositionSceneTarget('full-talk', 'scene-a'),
      );
      await buildLoader('scene-a', 'composition-index').handle(
        standaloneCompositionIndexTarget('full-talk', 0),
      );

      // 3 hooks per navigation × 4 locator shapes = 12 entries; every
      // single one must carry `standalone`.
      expect(seen).toHaveLength(12);
      for (const entry of seen) {
        expect(entry.mode).toBe('standalone');
      }
    });

    it('writes both `data-pulsar-scene-target` and `data-pulsar-composition-target` for a composition target under `mode=standalone` (preserves observability of what the URL addressed)', async () => {
      const probe = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...probe.scenes]),
        compositions: createCompositionRegistry([
          { id: probe.compositionId, manifest: probe.scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(probe.runner),
      });

      await loader.handle(standaloneCompositionSceneTarget(probe.compositionId, 'scene-b'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-b');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe(probe.compositionId);
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=standalone`', async () => {
      // Mirrors ADR-016's invariant for `mode=present`. Future
      // chrome/audio adapters may use `data-pulsar-mode-*` if they need
      // a stage-level signal; PUL-F014 forbids the loader from
      // preemptively writing one.
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

      await loader.handle(standaloneSceneTarget('scene-a'));

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });

    it('surfaces composition-not-registered as a navigation error under `mode=standalone` (no silent fallback to direct scene lookup)', async () => {
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

      await loader.handle(standaloneCompositionTarget('not-registered'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'composition "not-registered" is not registered',
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('surfaces composition-member error under `mode=standalone` for an unknown scene in `composition+scene`', async () => {
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

      await loader.handle(standaloneCompositionSceneTarget('full-talk', 'scene-z'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'scene "scene-z" is not a member of composition "full-talk"',
      );
    });

    it('surfaces index-out-of-range under `mode=standalone`', async () => {
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

      await loader.handle(standaloneCompositionIndexTarget('full-talk', 5));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('index 5 is out of range');
    });

    it("preserves the addressed head entry's `range` and `behavior` overrides on the runner input under `mode=standalone` (composition+index with object-form entry)", async () => {
      // PUL-F014 / ADR-017: standalone is single-scene EXECUTION at the
      // addressed head, NOT direct-scene flattening. A regression that
      // dropped the composition slice entirely (instead of truncating
      // it to one entry) would lose the head entry's `range` /
      // `behavior` overrides — the runner would receive `range:
      // undefined, behavior: undefined` even though the URL named an
      // object-form entry that carries them. This test pins both
      // override slots through to the runner.
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const captured: {
        sceneId: string;
        range: unknown;
        behavior: unknown;
      }[] = [];
      const runner = (input: LegacyRunInput) => {
        captured.push({
          sceneId: input.scene.id,
          range: input.range,
          behavior: input.behavior,
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

      await loader.handle(standaloneCompositionIndexTarget('full-talk', 1));

      // Runner ran exactly once (single-scene execution) AND the
      // addressed entry's overrides reached `input.range` /
      // `input.behavior`. A regression that flattened to direct-scene
      // would show `range: undefined, behavior: undefined` here.
      expect(captured).toEqual([{ sceneId: 'scene-b', range: 'hook', behavior: { hold: true } }]);
    });

    it('runs cleanup exactly once for the head scene under `mode=standalone`, never for dropped slice entries', async () => {
      // A regression that dropped the slice for execution but left
      // following scenes in the synthesized registry could double-clean
      // or skip-clean. This test pins exactly-once cleanup on the head
      // scene and zero cleanup for the dropped entries.
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

      await loader.handle(standaloneCompositionTarget('full-talk'));

      expect(cleaned).toEqual(['scene-a']);
    });
  });

  describe('loop-mode runner repeat-hint forwarding (PUL-F015)', () => {
    // PUL-F015 statement: in `mode=loop`, the runtime SHALL run the
    // addressed scene's timeline and restart it on completion.
    //
    // Materially-implementable parts of the statement that this block
    // pins (ADR-018 records the contract boundary):
    //   - The loader passes `repeat: 'until-aborted'` to the timeline
    //     runner adapter when `effectiveMode(target) === 'loop'`. The
    //     runner is responsible for honoring the hint (e.g. ADR-003's
    //     future GSAP runner uses `timeline.repeat(-1)`).
    //   - The hint is HEAD-ONLY: under composition targets the head
    //     scene's runner input carries `repeat`; following entries do
    //     not. (Following entries do not run anyway because a looping
    //     head's timeline never naturally completes — the head-only
    //     scoping is what keeps the contract honest if a future
    //     runner exposes a non-`'until-aborted'` repeat semantics.)
    //   - `ctx.mode === 'loop'` reaches every lifecycle hook of the
    //     head scene — the seam future runner / chrome / audio
    //     surfaces will read.
    //   - Other modes (`present`, `standalone`, `paused`, `scrub`,
    //     `screenshot`, `prompter`) and a `mode`-less URL DO NOT set
    //     `repeat`. A regression that broadcast `repeat` under any
    //     mode would break URLs that depend on no-repeat semantics
    //     (e.g. screenshot determinism).
    //   - No `data-pulsar-mode-*` suppression attribute is preemptively
    //     written under `loop` (parity with ADR-016 / ADR-017).
    //   - Composition validation (unregistered composition, unknown
    //     member scene, out-of-range index) STILL surfaces as a
    //     navigation error under `mode=loop` — no silent fallback to
    //     direct scene lookup.
    //   - Beat semantics under `mode=loop` are unchanged from PUL-F011:
    //     the head scene's runner sees `input.beat`; missing-label
    //     diagnostics surface via `data-pulsar-navigation-error` /
    //     `onError` without unmounting.
    //   - Object-form head entry's `range` / `behavior` overrides
    //     reach the runner unchanged. Loop is single-scene-timeline
    //     repeat at the head, NOT direct-scene flattening.
    //
    // PUL-F015 stays DRAFT after this PR (ADR-018 records the
    // boundary; following the ADR-016 / ADR-017 / PUL-F013 / PUL-F014
    // precedent). The seam — the loader passes `repeat: 'until-aborted'`
    // and `ctx.mode === 'loop'` — IS materially shipped. The actual
    // restart-on-completion behavior is the runner's contract:
    // ADR-003's GSAP runner reads `input.repeat` when it lands.
    // Until then, the placeholder runner has no real timeline (returns
    // `null`) and parks until abort — vacuously satisfying "restart
    // on completion" because no completion ever fires. ACTIVE
    // transitions when the GSAP runner actively reads
    // `input.repeat === 'until-aborted'` and restarts the timeline,
    // with an end-to-end test alongside these seam tests.

    const loopSceneTarget = (id: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      mode: 'loop',
    });
    const loopCompositionTarget = (composition: string): NavigationTarget => ({
      locator: { kind: 'composition', composition },
      mode: 'loop',
    });
    const loopCompositionSceneTarget = (composition: string, scene: string): NavigationTarget => ({
      locator: { kind: 'composition-scene', composition, scene },
      mode: 'loop',
    });
    const loopCompositionIndexTarget = (composition: string, index: number): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'loop',
    });

    it('passes `repeat: "until-aborted"` to the runner for a `scene` target under `mode=loop`', async () => {
      // Direct-scene navigation is the simplest loop path: the
      // addressed scene IS the head, no slice resolution. A regression
      // that gated `repeat` on `target.composition` being defined
      // would silently drop the hint here.
      const captured: { sceneId: string; repeat: 'until-aborted' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, repeat: input.repeat });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      await loader.handle(loopSceneTarget('scene-a'));

      expect(captured).toEqual([{ sceneId: 'scene-a', repeat: 'until-aborted' }]);
    });

    it('runs only the head scene of a `composition` target under `mode=loop` (slice truncation; runner sees `repeat: "until-aborted"` for the head)', async () => {
      // PUL-F015 / ADR-018: loop truncates the validated composition
      // slice to the addressed head, parallel to standalone (ADR-017).
      // Truncation makes "no following entries run" a structural
      // guarantee — a runner bug or no-op runner under `mode=loop`
      // MUST NOT silently degrade into normal composition playback
      // (codex pre-push review). Use a non-final-index navigation so
      // the slice has successors that would be observable if
      // truncation were missing — last-index would slice to one
      // entry anyway and fail to discriminate.
      const captured: { sceneId: string; repeat: 'until-aborted' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, repeat: input.repeat });
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

      await loader.handle(loopCompositionIndexTarget('full-talk', 0));

      expect(captured).toEqual([{ sceneId: 'scene-a', repeat: 'until-aborted' }]);
    });

    it('runs only the addressed scene of a `composition+scene` target under `mode=loop`', async () => {
      // composition+scene targeting a non-final entry exercises the
      // slice transform from a different locator shape; pins parity
      // with the composition-target case above.
      const captured: { sceneId: string; repeat: 'until-aborted' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, repeat: input.repeat });
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

      await loader.handle(loopCompositionSceneTarget('full-talk', 'scene-b'));

      expect(captured).toEqual([{ sceneId: 'scene-b', repeat: 'until-aborted' }]);
    });

    it('runs cleanup exactly once for the head scene under `mode=loop`, never for dropped slice entries', async () => {
      // Same invariant as PUL-F014 (ADR-017) under standalone: a
      // regression that dropped the slice for execution but left
      // following scenes wired through the synthesized registry could
      // double-clean or skip-clean. Pin exactly-once cleanup on the
      // head and zero cleanup for the dropped entries.
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

      await loader.handle(loopCompositionTarget('full-talk'));

      expect(cleaned).toEqual(['scene-a']);
    });

    it('omits the `repeat` key on the runner input when `mode=loop` is absent (key-presence semantics)', async () => {
      // The runner input uses key-presence semantics for optional
      // fields (parallel to `beat` / `range` / `behavior`): a runner
      // can branch on `'repeat' in input` rather than `=== undefined`.
      // A regression that always set `input.repeat = undefined` (or
      // any non-`'until-aborted'` value) under non-loop modes would
      // break that contract.
      const captured: { hasRepeat: boolean; repeat: unknown }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ hasRepeat: 'repeat' in input, repeat: input.repeat });
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

      expect(captured).toEqual([{ hasRepeat: false, repeat: undefined }]);
    });

    it('does not set `repeat` for any non-loop, lifecycle-running mode', async () => {
      // Walk the seven-mode allowlist (minus `loop` and `prompter`)
      // and confirm that none of them produce `repeat` on the
      // runner input. Catching every non-loop mode discriminates
      // against an over-broad fix that gated `repeat` on
      // `mode !== undefined` rather than `mode === 'loop'`.
      // Capturing the per-iteration mode alongside the
      // `'repeat' in input` flag means the assertion failure
      // identifies WHICH mode regressed, not just "some mode did."
      //
      // PUL-F019 / ADR-022: `prompter` does not invoke `runTimeline`
      // at all (lifecycle is structurally bypassed), so it cannot
      // appear in this test's `captured` array. The dedicated
      // `prompter-mode caption-view dispatch (PUL-F019)` block
      // pins prompter's no-runner invariant directly. Filtering
      // it out here keeps this test focused on lifecycle modes.
      const nonLoopLifecycleModes = NAVIGATION_MODES.filter(
        (m) => m !== 'loop' && m !== 'prompter',
      );
      const captured: { mode: NavigationMode; hasRepeat: boolean }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      for (const mode of nonLoopLifecycleModes) {
        const runner = (input: LegacyRunInput) => {
          captured.push({ mode, hasRepeat: 'repeat' in input });
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

      // One entry per non-loop lifecycle mode, each must have
      // `hasRepeat: false`. Building the expected array from
      // `nonLoopLifecycleModes` keeps the assertion in sync if the
      // mode allowlist ever changes.
      expect(captured).toEqual(nonLoopLifecycleModes.map((mode) => ({ mode, hasRepeat: false })));
    });

    it('exposes `ctx.mode === "loop"` to every lifecycle hook of the head scene under all locator shapes', async () => {
      // Parallel to the PUL-F014 standalone seam test. Future runner /
      // chrome / audio surfaces read `ctx.mode` to decide their own
      // repeat / suppression behavior; this test pins the seam end to
      // end across all four locator shapes that can appear under
      // `mode=loop`.
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

      await buildLoader('scene-a', 'scene').handle(loopSceneTarget('scene-a'));
      await buildLoader('scene-a', 'composition').handle(loopCompositionTarget('full-talk'));
      await buildLoader('scene-a', 'composition-scene').handle(
        loopCompositionSceneTarget('full-talk', 'scene-a'),
      );
      await buildLoader('scene-a', 'composition-index').handle(
        loopCompositionIndexTarget('full-talk', 0),
      );

      // 3 hooks per navigation × 4 locator shapes = 12 entries; every
      // single one must carry `loop`.
      expect(seen).toHaveLength(12);
      for (const entry of seen) {
        expect(entry.mode).toBe('loop');
      }
    });

    it('forwards `beat` to the head scene runner alongside `repeat` under `mode=loop`, and surfaces missing-beat as a non-fatal diagnostic', async () => {
      // PUL-F011 / PUL-F015 are independent: a URL like
      // `?scene=x&beat=hook&mode=loop` must deliver both `beat` and
      // `repeat` to the runner. A regression that paired them — e.g.
      // dropping `repeat` when `beat` is supplied — would silently
      // break loop-mode navigation when a beat is also requested.
      const captured: {
        sceneId: string;
        beat: string | undefined;
        repeat: 'until-aborted' | undefined;
      }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const runner = (input: LegacyRunInput) => {
        captured.push({
          sceneId: input.scene.id,
          beat: input.beat,
          repeat: input.repeat,
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
        mode: 'loop',
        beat: 'midpoint',
      });

      expect(captured).toEqual([{ sceneId: 'scene-a', beat: 'midpoint', repeat: 'until-aborted' }]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('beat positioning failed');
      expect((errors[0] as Error).message).toContain('"midpoint"');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=loop`', async () => {
      // Mirrors ADR-016 / ADR-017 invariant. PUL-F015 forbids the
      // loader from preemptively writing a stage attribute for loop
      // mode; runner-side or future-surface-side signaling lives at
      // those surfaces, not at the loader.
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

      await loader.handle(loopSceneTarget('scene-a'));

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });

    it('surfaces composition-not-registered as a navigation error under `mode=loop` (no silent fallback)', async () => {
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

      await loader.handle(loopCompositionTarget('not-registered'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'composition "not-registered" is not registered',
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('surfaces composition-member error under `mode=loop` for an unknown scene in `composition+scene`', async () => {
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

      await loader.handle(loopCompositionSceneTarget('full-talk', 'scene-z'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'scene "scene-z" is not a member of composition "full-talk"',
      );
    });

    it('surfaces index-out-of-range under `mode=loop`', async () => {
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

      await loader.handle(loopCompositionIndexTarget('full-talk', 5));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('index 5 is out of range');
    });

    it("preserves the addressed head entry's `range` and `behavior` overrides on the runner input under `mode=loop` (composition+index with object-form entry)", async () => {
      // PUL-F015 / ADR-018: loop truncates the validated composition
      // slice to the addressed head and forwards `repeat` to that
      // head's runner input. The slice is TRUNCATED rather than
      // flattened — a flat `{ scene }` would lose object-form
      // `range` / `behavior` overrides on the head entry, turning
      // loop into direct-scene flattening (parity with ADR-017's
      // standalone invariant). This pins all three slots — `range`,
      // `behavior`, and `repeat` — through to the head runner, plus
      // the truncation itself (the runner runs exactly once).
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const captured: {
        sceneId: string;
        range: unknown;
        behavior: unknown;
        repeat: unknown;
      }[] = [];
      const runner = (input: LegacyRunInput) => {
        captured.push({
          sceneId: input.scene.id,
          range: input.range,
          behavior: input.behavior,
          repeat: input.repeat,
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

      await loader.handle(loopCompositionIndexTarget('full-talk', 1));

      // Single runner invocation (truncation), with overrides AND
      // `repeat` reaching the head's runner input together. A
      // regression that flattened to direct-scene would show
      // `range: undefined, behavior: undefined`; a regression that
      // dropped truncation would show a second invocation for
      // scene-c.
      expect(captured).toEqual([
        {
          sceneId: 'scene-b',
          range: 'hook',
          behavior: { hold: true },
          repeat: 'until-aborted',
        },
      ]);
    });
  });
});
