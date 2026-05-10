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

describe('createSceneLoader — screenshot & prompter modes (PUL-F008)', () => {
  describe('screenshot-mode runner capture-hint forwarding (PUL-F018)', () => {
    // PUL-F018 statement: in `mode=screenshot`, the runtime SHALL
    // render the addressed scene at the addressed beat (or first
    // frame if no beat) with all asset preloads resolved, no
    // animation in progress, all audio suppressed, and any
    // randomness sourced from a deterministic seed.
    //
    // Materially-implementable parts of the statement that this
    // block pins (ADR-021 records the contract boundary):
    //   - The loader passes `screenshot: 'capture'` to the
    //     timeline runner adapter when
    //     `effectiveMode(target) === 'screenshot'`. The runner is
    //     responsible for honoring the bundle (frame freeze at
    //     beat-or-zero, no animation, all audio suppressed,
    //     deterministic seed).
    //   - The hint is HEAD-ONLY: under composition targets the head
    //     scene's runner input carries `screenshot`; following
    //     entries do not. Following entries do not run at all
    //     because the slice is truncated to the addressed head —
    //     same structural defense ADR-018 / ADR-019 / ADR-020 record
    //     for `mode=loop` / `mode=paused` / `mode=scrub`.
    //   - `ctx.mode === 'screenshot'` reaches every lifecycle hook
    //     of the head scene — the seam future capture tooling reads
    //     when it observes the stage.
    //   - Other modes (`present`, `standalone`, `loop`, `paused`,
    //     `scrub`, `prompter`) and a `mode`-less URL DO NOT set
    //     `screenshot`. A regression that broadcast `screenshot`
    //     under any mode would break URLs that depend on normal
    //     playback semantics.
    //   - No `data-pulsar-mode-*` suppression attribute is preempt-
    //     ively written under `screenshot` (parity with ADR-016 /
    //     ADR-017 / ADR-018 / ADR-019 / ADR-020).
    //   - Composition validation (unregistered composition, unknown
    //     member scene, out-of-range index) STILL surfaces as a
    //     navigation error under `mode=screenshot` — no silent
    //     fallback to direct scene lookup.
    //   - Beat semantics under `mode=screenshot` are honored as the
    //     captured-frame anchor: PUL-F018 explicitly says "at the
    //     addressed beat (or first frame if no beat)," unlike
    //     `mode=paused` where ADR-019 records "first frame wins."
    //     The loader forwards `input.beat` alongside
    //     `input.screenshot`; missing-label diagnostics surface
    //     via `data-pulsar-navigation-error` / `onError` without
    //     unmounting.
    //   - Object-form head entry's `range` / `behavior` overrides
    //     reach the runner unchanged. Screenshot is single-scene-
    //     mount with deterministic capture at the head, NOT
    //     direct-scene flattening.
    //
    // PUL-F018 stays DRAFT after this PR (ADR-021 records the
    // boundary; following the ADR-016 / ADR-017 / ADR-018 / ADR-019
    // / ADR-020 / PUL-F013 / PUL-F014 / PUL-F015 / PUL-F016 /
    // PUL-F017 precedent). The seam — the loader passes
    // `screenshot: 'capture'` and `ctx.mode === 'screenshot'` — IS
    // materially shipped. The actual capture-bundle behavior
    // (frame freeze, audio suppression, deterministic randomness)
    // is the runner's contract (ADR-003's GSAP runner + ADR-004's
    // audio engine + a deterministic-randomness convention when
    // they land); all three are required for ACTIVE.

    const screenshotSceneTarget = (id: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      mode: 'screenshot',
    });
    const screenshotCompositionTarget = (composition: string): NavigationTarget => ({
      locator: { kind: 'composition', composition },
      mode: 'screenshot',
    });
    const screenshotCompositionSceneTarget = (
      composition: string,
      scene: string,
    ): NavigationTarget => ({
      locator: { kind: 'composition-scene', composition, scene },
      mode: 'screenshot',
    });
    const screenshotCompositionIndexTarget = (
      composition: string,
      index: number,
    ): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'screenshot',
    });

    it('passes `screenshot: "capture"` to the runner for a `scene` target under `mode=screenshot`', async () => {
      // Direct-scene navigation is the simplest screenshot path:
      // the addressed scene IS the head, no slice resolution. A
      // regression that gated `screenshot` on `target.composition`
      // being defined would silently drop the hint here.
      const captured: { sceneId: string; screenshot: 'capture' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, screenshot: input.screenshot });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      await loader.handle(screenshotSceneTarget('scene-a'));

      expect(captured).toEqual([{ sceneId: 'scene-a', screenshot: 'capture' }]);
    });

    it('runs only the head scene of a `composition` target under `mode=screenshot` (slice truncation; runner sees `screenshot: "capture"` for the head)', async () => {
      // PUL-F018 / ADR-021: screenshot truncates the validated
      // composition slice to the addressed head, parallel to
      // standalone (ADR-017), loop (ADR-018), paused (ADR-019), and
      // scrub (ADR-020). Truncation makes "no following entries
      // run" a structural guarantee — a runner bug or no-op runner
      // under `mode=screenshot` MUST NOT silently degrade into
      // normal composition playback. The plain `composition`
      // locator (no scene id, no index) exercises the path that
      // resolves the head from the manifest's first entry; a
      // regression that only dropped `screenshot: 'capture'` for
      // this locator (vs the composition+index path the next test
      // covers) would slip past a test that named itself
      // "composition target" but actually used composition+index.
      const captured: { sceneId: string; screenshot: 'capture' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, screenshot: input.screenshot });
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

      await loader.handle(screenshotCompositionTarget('full-talk'));

      expect(captured).toEqual([{ sceneId: 'scene-a', screenshot: 'capture' }]);
    });

    it('runs only the head scene of a `composition+index` target under `mode=screenshot` (slice truncation pinned for the index locator too)', async () => {
      // The composition+index locator exercises the slice-from-N
      // path; pins parity with the plain composition target above.
      // Use a non-final-index navigation so the slice has
      // successors that would be observable if truncation were
      // missing.
      const captured: { sceneId: string; screenshot: 'capture' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, screenshot: input.screenshot });
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

      await loader.handle(screenshotCompositionIndexTarget('full-talk', 0));

      expect(captured).toEqual([{ sceneId: 'scene-a', screenshot: 'capture' }]);
    });

    it('runs only the addressed scene of a `composition+scene` target under `mode=screenshot`', async () => {
      // composition+scene targeting a non-final entry exercises the
      // slice transform from a different locator shape; pins parity
      // with the composition-target case above.
      const captured: { sceneId: string; screenshot: 'capture' | undefined }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ sceneId: input.scene.id, screenshot: input.screenshot });
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

      await loader.handle(screenshotCompositionSceneTarget('full-talk', 'scene-b'));

      expect(captured).toEqual([{ sceneId: 'scene-b', screenshot: 'capture' }]);
    });

    it('runs cleanup exactly once for the head scene under `mode=screenshot`, never for dropped slice entries', async () => {
      // Same invariant as PUL-F014 (ADR-017) under standalone,
      // PUL-F015 (ADR-018) under loop, PUL-F016 (ADR-019) under
      // paused, PUL-F017 (ADR-020) under scrub: a regression that
      // dropped the slice for execution but left following scenes
      // wired through the synthesized registry could double-clean
      // or skip-clean. Pin exactly-once cleanup on the head and
      // zero cleanup for the dropped entries.
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

      await loader.handle(screenshotCompositionTarget('full-talk'));

      expect(cleaned).toEqual(['scene-a']);
    });

    it('omits the `screenshot` key on the runner input when `mode=screenshot` is absent (key-presence semantics)', async () => {
      // The runner input uses key-presence semantics for optional
      // fields (parallel to `beat` / `repeat` / `hold` / `cueGate`
      // / `range` / `behavior`): a runner can branch on
      // `'screenshot' in input` rather than `=== undefined`. A
      // regression that always set `input.screenshot = undefined`
      // (or any non-`'capture'` value) under non-screenshot modes
      // would break that contract.
      const captured: { hasScreenshot: boolean; screenshot: unknown }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const runner = (input: LegacyRunInput) => {
        captured.push({ hasScreenshot: 'screenshot' in input, screenshot: input.screenshot });
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

      expect(captured).toEqual([{ hasScreenshot: false, screenshot: undefined }]);
    });

    it('does not set `screenshot` for any non-screenshot, lifecycle-running mode', async () => {
      // Walk the seven-mode allowlist (minus `screenshot` and
      // `prompter`) and confirm that none of them produce
      // `screenshot` on the runner input. Catching every
      // non-screenshot mode discriminates against an over-broad fix
      // that gated `screenshot` on `mode !== undefined` rather than
      // `mode === 'screenshot'`. Capturing the per-iteration mode
      // alongside the `'screenshot' in input` flag means the
      // assertion failure identifies WHICH mode regressed, not
      // just "some mode did."
      //
      // PUL-F019 / ADR-022: `prompter` does not invoke `runTimeline`
      // (lifecycle bypassed); the dedicated F019 block pins that
      // invariant.
      const nonScreenshotLifecycleModes = NAVIGATION_MODES.filter(
        (m) => m !== 'screenshot' && m !== 'prompter',
      );
      const captured: { mode: NavigationMode; hasScreenshot: boolean }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      for (const mode of nonScreenshotLifecycleModes) {
        const runner = (input: LegacyRunInput) => {
          captured.push({ mode, hasScreenshot: 'screenshot' in input });
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

      // One entry per non-screenshot lifecycle mode, each must have
      // `hasScreenshot: false`. Building the expected array from
      // `nonScreenshotLifecycleModes` keeps the assertion in sync if
      // the mode allowlist ever changes.
      expect(captured).toEqual(
        nonScreenshotLifecycleModes.map((mode) => ({ mode, hasScreenshot: false })),
      );
    });

    it('exposes `ctx.mode === "screenshot"` to every lifecycle hook of the head scene under all locator shapes', async () => {
      // Parallel to the PUL-F014 standalone, PUL-F015 loop,
      // PUL-F016 paused, and PUL-F017 scrub seam tests. Future
      // capture tooling that observes the runtime reads `ctx.mode`
      // (or the equivalent stage seam) to decide its own behavior;
      // this test pins the seam end to end across all four locator
      // shapes that can appear under `mode=screenshot`.
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

      await buildLoader('scene-a', 'scene').handle(screenshotSceneTarget('scene-a'));
      await buildLoader('scene-a', 'composition').handle(screenshotCompositionTarget('full-talk'));
      await buildLoader('scene-a', 'composition-scene').handle(
        screenshotCompositionSceneTarget('full-talk', 'scene-a'),
      );
      await buildLoader('scene-a', 'composition-index').handle(
        screenshotCompositionIndexTarget('full-talk', 0),
      );

      // 3 hooks per navigation × 4 locator shapes = 12 entries;
      // every single one must carry `screenshot`.
      expect(seen).toHaveLength(12);
      for (const entry of seen) {
        expect(entry.mode).toBe('screenshot');
      }
    });

    it('forwards `beat` to the head scene runner alongside `screenshot` under `mode=screenshot`, and surfaces missing-beat as a non-fatal diagnostic', async () => {
      // PUL-F018 explicitly says "at the addressed beat (or first
      // frame if no beat)," so a URL like
      // `?scene=x&beat=midpoint&mode=screenshot` must deliver both
      // `beat` and `screenshot` to the runner. Unlike `mode=paused`
      // (ADR-019: "first frame wins"), screenshot HONORS the beat
      // as the addressed-frame anchor; the runner seeks to the
      // beat and then freezes. A regression that dropped `beat`
      // when `mode=screenshot` is set would silently break the
      // natural deterministic-frame-capture-at-named-beat path
      // PUL-F018 names directly.
      const captured: {
        sceneId: string;
        beat: string | undefined;
        screenshot: 'capture' | undefined;
      }[] = [];
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const runner = (input: LegacyRunInput) => {
        captured.push({
          sceneId: input.scene.id,
          beat: input.beat,
          screenshot: input.screenshot,
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
        mode: 'screenshot',
        beat: 'midpoint',
      });

      expect(captured).toEqual([{ sceneId: 'scene-a', beat: 'midpoint', screenshot: 'capture' }]);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('beat positioning failed');
      expect((errors[0] as Error).message).toContain('"midpoint"');
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=screenshot`', async () => {
      // Mirrors ADR-016 / ADR-017 / ADR-018 / ADR-019 / ADR-020
      // invariant. PUL-F018 forbids the loader from preemptively
      // writing a stage attribute for screenshot mode; runner-side
      // or future-tooling-side signaling lives at those surfaces,
      // not at the loader.
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

      await loader.handle(screenshotSceneTarget('scene-a'));

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });

    it('writes both `data-pulsar-scene-target` and `data-pulsar-composition-target` for a composition target under `mode=screenshot` (preserves observability of what the URL addressed)', async () => {
      // The stage attrs communicate "what was addressed," not "what
      // ran." Truncation drops following entries from execution
      // but does not drop the composition id from the stage attrs
      // — mirrors the standalone / loop / paused / scrub
      // invariant.
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

      await loader.handle(screenshotCompositionSceneTarget('full-talk', 'scene-b'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-b');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
    });

    it('surfaces composition-not-registered as a navigation error under `mode=screenshot` (no silent fallback)', async () => {
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

      await loader.handle(screenshotCompositionTarget('not-registered'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'composition "not-registered" is not registered',
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
    });

    it('surfaces composition-member error under `mode=screenshot` for an unknown scene in `composition+scene`', async () => {
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

      await loader.handle(screenshotCompositionSceneTarget('full-talk', 'scene-z'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'scene "scene-z" is not a member of composition "full-talk"',
      );
    });

    it('surfaces index-out-of-range under `mode=screenshot`', async () => {
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

      await loader.handle(screenshotCompositionIndexTarget('full-talk', 5));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('index 5 is out of range');
    });

    it("preserves the addressed head entry's `range` and `behavior` overrides on the runner input under `mode=screenshot` (composition+index with object-form entry)", async () => {
      // PUL-F018 / ADR-021: screenshot truncates the validated
      // composition slice to the addressed head and forwards
      // `screenshot` to that head's runner input. The slice is
      // TRUNCATED rather than flattened — a flat `{ scene }` would
      // lose object-form `range` / `behavior` overrides on the
      // head entry, turning screenshot into direct-scene
      // flattening (parity with ADR-017's standalone, ADR-018's
      // loop, ADR-019's paused, and ADR-020's scrub invariant).
      // This pins all three slots — `range`, `behavior`, and
      // `screenshot` — through to the head runner, plus the
      // truncation itself (the runner runs exactly once).
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneB = buildScene({ id: 'scene-b' });
      const sceneC = buildScene({ id: 'scene-c' });
      const stage = buildStage();
      const captured: {
        sceneId: string;
        range: unknown;
        behavior: unknown;
        screenshot: unknown;
      }[] = [];
      const runner = (input: LegacyRunInput) => {
        captured.push({
          sceneId: input.scene.id,
          range: input.range,
          behavior: input.behavior,
          screenshot: input.screenshot,
        });
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          {
            id: 'full-talk',
            manifest: [
              'scene-a',
              { id: 'scene-b', range: 'midpoint', behavior: { hold: true } },
              'scene-c',
            ],
          },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(runner),
      });

      await loader.handle(screenshotCompositionIndexTarget('full-talk', 1));

      expect(captured).toEqual([
        {
          sceneId: 'scene-b',
          range: 'midpoint',
          behavior: { hold: true },
          screenshot: 'capture',
        },
      ]);
    });
  });

  describe('prompter-mode caption-view dispatch (PUL-F019)', () => {
    // PUL-F019 statement: in `mode=prompter`, the runtime SHALL render
    // a script/caption view derived from the captions metadata of the
    // addressed scene or composition. Visual rendering of the scene
    // SHALL be suppressed.
    //
    // Materially-implementable parts of the statement that this block
    // pins (ADR-022 records the contract boundary):
    //   - Visual rendering is suppressed STRUCTURALLY: under
    //     `mode=prompter` the loader does NOT invoke `createPreloader`,
    //     does NOT invoke `runTimeline`, and does NOT mount the scene
    //     (no `create` / `timeline` / `cleanup`). The captions data
    //     path runs INSTEAD of the resolver lifecycle. CSS-hiding an
    //     already-rendered scene would not satisfy the requirement —
    //     the codex preflight guardrails for PUL-F019 explicitly call
    //     this out.
    //   - The captions view is derived from the captions metadata of
    //     the addressed scene OR composition. The slice is NOT
    //     truncated under composition addressing — every entry's
    //     captions are aggregated, in dispatch order. This is the
    //     structural difference from `mode=loop` / `mode=paused` /
    //     `mode=scrub` / `mode=screenshot`, which truncate to head
    //     because their lifecycle promise is "no following entries
    //     run." Under prompter the lifecycle doesn't run AT ALL, so
    //     the truncation defense from the other modes does not apply.
    //   - The loader hands the computed `PrompterScript` to an
    //     optional `renderPrompter` adapter on `SceneLoaderOptions`.
    //     A workbench bootstrap that has not yet wired a captions UI
    //     omits the field; the loader still suppresses the lifecycle
    //     (the structural defense) but invokes no renderer. Production
    //     bootstrap supplies a concrete renderer when the UI surface
    //     lands.
    //   - Stage attrs (`data-pulsar-scene-target`,
    //     `data-pulsar-composition-target`) are still set so external
    //     observers see what was addressed. NO `data-pulsar-mode-*`
    //     preemptive attribute (parity with ADR-016 / ADR-017 /
    //     ADR-018 / ADR-019 / ADR-020 / ADR-021).
    //   - Composition validation (unregistered composition, unknown
    //     member scene, out-of-range index) STILL surfaces as a
    //     navigation error under `mode=prompter` — no silent fallback
    //     to direct scene lookup.
    //   - Other modes (`present`, `standalone`, `loop`, `paused`,
    //     `scrub`, `screenshot`) and a `mode`-less URL DO NOT invoke
    //     `renderPrompter`. A regression that broadcast prompter
    //     dispatch under any mode would suppress lifecycle for normal
    //     playback URLs.
    //
    // PUL-F019 stays DRAFT after this PR (ADR-022 records the
    // boundary; following the ADR-016 / ADR-017 / ADR-018 / ADR-019 /
    // ADR-020 / ADR-021 / PUL-F013 / PUL-F014 / PUL-F015 / PUL-F016 /
    // PUL-F017 / PUL-F018 precedent). The seam — the loader bypasses
    // the lifecycle and hands a `PrompterScript` to the adapter — IS
    // materially shipped. The visible captions/script UI is the
    // future workbench surface, gated on the DRAFT → ACTIVE
    // transition.

    const prompterSceneTarget = (id: string): NavigationTarget => ({
      locator: { kind: 'scene', scene: id },
      mode: 'prompter',
    });
    const prompterCompositionTarget = (composition: string): NavigationTarget => ({
      locator: { kind: 'composition', composition },
      mode: 'prompter',
    });
    const prompterCompositionSceneTarget = (
      composition: string,
      scene: string,
    ): NavigationTarget => ({
      locator: { kind: 'composition-scene', composition, scene },
      mode: 'prompter',
    });
    const prompterCompositionIndexTarget = (
      composition: string,
      index: number,
    ): NavigationTarget => ({
      locator: { kind: 'composition-index', composition, index },
      mode: 'prompter',
    });

    interface LifecycleProbe {
      readonly log: string[];
      readonly preloaderInvocations: number;
      readonly buildCtxInvocations: number;
    }

    // Probe that records every lifecycle observation across every
    // boundary the lifecycle would touch under non-prompter modes:
    //   - `createPreloader` (asset pipeline)
    //   - `buildCtx` (per-navigation ctx — its very invocation means
    //     the loader is on the lifecycle path)
    //   - `runTimeline` (runner adapter)
    //   - scene `create` / `timeline` / `cleanup` (lifecycle hooks)
    // Under `mode=prompter` every counter / log entry MUST stay zero.
    // The codex guardrails for PUL-F019 explicitly call out asset
    // pipeline + scene renderer + canvas/stage + media playback +
    // animation loop as side effects to avoid; an under-watched test
    // (e.g. one that only checked `runTimeline`) would miss an
    // ABI regression that started running the preloader under
    // prompter — exactly the `asset pipeline` clause of the guardrails.

    type ProbeOpts = {
      readonly probe: LifecycleProbe;
      readonly preloader: () => Promise<void>;
      readonly runner: (input: LegacyRunInput) => void;
      readonly buildCtxFn: (mode: NavigationMode) => WorkbenchSceneCtx;
      readonly scenes: readonly SceneModule[];
    };

    const buildLifecycleProbe = (): ProbeOpts => {
      const log: string[] = [];
      const probe: { -readonly [K in keyof LifecycleProbe]: LifecycleProbe[K] } = {
        log,
        preloaderInvocations: 0,
        buildCtxInvocations: 0,
      };
      const trace = (id: string, captions?: readonly Caption[]): SceneModule =>
        buildScene({
          id,
          title: id,
          captions: captions ?? [],
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
      const preloader = (): Promise<void> => {
        probe.preloaderInvocations += 1;
        return Promise.resolve();
      };
      const buildCtxFn = (mode: NavigationMode): WorkbenchSceneCtx => {
        probe.buildCtxInvocations += 1;
        return { stage: null, mode, gsap };
      };
      const scenes = [
        trace('scene-a', [{ at: 0, text: 'A1' }]),
        trace('scene-b', [{ at: 0, text: 'B1' }]),
        trace('scene-c', [{ at: 0, text: 'C1' }]),
      ];
      return { probe, preloader, runner, buildCtxFn, scenes };
    };

    it('suppresses every lifecycle side effect under `mode=prompter` (no preloader, no buildCtx, no runner, no scene hooks)', async () => {
      // The structural-suppression guarantee. A regression that
      // dispatched prompter through `loadSceneNavigationTarget`
      // (the same path other modes use) would emit lifecycle entries
      // for the head scene AND increment the preloader and buildCtx
      // counters; this test would surface every one of those
      // regressions.
      const { probe, preloader, runner, buildCtxFn, scenes } = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...scenes]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: scenes.map((s) => s.id) },
        ]),
        stage: stage.element,
        buildCtx: buildCtxFn,
        createPreloader: () => preloader,
        timeline: asTimeline(runner),
      });

      await loader.handle(prompterCompositionTarget('full-talk'));

      expect(probe.log).toEqual([]);
      expect(probe.preloaderInvocations).toBe(0);
      expect(probe.buildCtxInvocations).toBe(0);
    });

    it('invokes `renderPrompter` with a script aggregating captions across the FULL composition slice (NOT truncated to head)', async () => {
      // Captions span every entry in the composition slice. The
      // composition list has three scenes; under prompter every
      // scene's captions must reach the renderer in manifest order.
      // A regression that copy-pasted truncation from F015–F018
      // would observe only the head scene's captions in the script.
      // PUL-F019 explicitly says "addressed scene OR composition,"
      // and ADR-022 records the no-truncation policy as the
      // structural difference.
      const sceneA = buildScene({
        id: 'scene-a',
        title: 'Alpha',
        captions: [
          { at: 0, text: 'A1' },
          { at: 100, text: 'A2' },
        ],
      });
      const sceneB = buildScene({
        id: 'scene-b',
        title: 'Bravo',
        captions: [{ at: 0, text: 'B1' }],
      });
      const sceneC = buildScene({
        id: 'scene-c',
        title: 'Charlie',
        captions: [{ at: 0, text: 'C1' }],
      });
      const stage = buildStage();
      const captured: PrompterScript[] = [];
      const renderPrompter: PrompterRenderer = (script) => {
        captured.push(script);
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        renderPrompter,
      });

      await loader.handle(prompterCompositionTarget('full-talk'));

      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual({
        composition: { id: 'full-talk' },
        entries: [
          {
            sceneId: 'scene-a',
            title: 'Alpha',
            captions: [
              { at: 0, text: 'A1' },
              { at: 100, text: 'A2' },
            ],
          },
          { sceneId: 'scene-b', title: 'Bravo', captions: [{ at: 0, text: 'B1' }] },
          { sceneId: 'scene-c', title: 'Charlie', captions: [{ at: 0, text: 'C1' }] },
        ],
      });
    });

    it('invokes `renderPrompter` with a single-scene script for a `scene` target under `mode=prompter`', async () => {
      // Direct-scene addressing — no composition context. The script
      // has one entry and no `composition` field. A regression that
      // assumed every prompter dispatch had a composition would
      // either crash on `target.composition!.id` or produce a
      // misleading script. Pin the single-scene shape explicitly.
      const sceneA = buildScene({
        id: 'scene-a',
        captions: [{ at: 250, text: 'hello' }],
      });
      const stage = buildStage();
      const captured: PrompterScript[] = [];
      const renderPrompter: PrompterRenderer = (script) => {
        captured.push(script);
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        renderPrompter,
      });

      await loader.handle(prompterSceneTarget('scene-a'));

      expect(captured).toHaveLength(1);
      expect(captured[0]?.entries).toEqual([
        { sceneId: 'scene-a', title: 'scene-a', captions: [{ at: 250, text: 'hello' }] },
      ]);
      expect(captured[0] && 'composition' in captured[0]).toBe(false);
    });

    it('starts the prompter slice at the addressed scene under `composition+scene` non-head', async () => {
      // The dispatcher already snapshots the slice from the addressed
      // scene onward (PUL-F008 / ADR-014). The prompter view honors
      // that — entries match the slice, NOT the full composition.
      // A regression that walked back to the composition's first
      // entry would surface skipped-scene captions. Choose a non-head
      // start so the test discriminates against "always full
      // composition."
      const sceneA = buildScene({ id: 'scene-a', captions: [{ at: 0, text: 'skipped' }] });
      const sceneB = buildScene({
        id: 'scene-b',
        title: 'Bravo',
        captions: [{ at: 0, text: 'kept' }],
      });
      const sceneC = buildScene({
        id: 'scene-c',
        title: 'Charlie',
        captions: [{ at: 0, text: 'also kept' }],
      });
      const stage = buildStage();
      const captured: PrompterScript[] = [];
      const renderPrompter: PrompterRenderer = (script) => {
        captured.push(script);
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        renderPrompter,
      });

      await loader.handle(prompterCompositionSceneTarget('full-talk', 'scene-b'));

      expect(captured).toHaveLength(1);
      expect(captured[0]?.entries.map((e) => e.sceneId)).toEqual(['scene-b', 'scene-c']);
    });

    it('starts the prompter slice at the requested index under `composition+index`', async () => {
      // index=1 against [a, b, c] resolves to slice [b, c]. Non-final
      // index discriminates against a regression that re-walked from
      // 0 (would surface scene-a) AND a regression that always sliced
      // to length 1 (would drop scene-c). Choosing index=1 catches
      // both.
      const sceneA = buildScene({ id: 'scene-a', captions: [{ at: 0, text: 'A' }] });
      const sceneB = buildScene({ id: 'scene-b', captions: [{ at: 0, text: 'B' }] });
      const sceneC = buildScene({ id: 'scene-c', captions: [{ at: 0, text: 'C' }] });
      const stage = buildStage();
      const captured: PrompterScript[] = [];
      const renderPrompter: PrompterRenderer = (script) => {
        captured.push(script);
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB, sceneC]),
        compositions: createCompositionRegistry([
          { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
        ]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        renderPrompter,
      });

      await loader.handle(prompterCompositionIndexTarget('full-talk', 1));

      expect(captured).toHaveLength(1);
      expect(captured[0]?.entries.map((e) => e.sceneId)).toEqual(['scene-b', 'scene-c']);
    });

    it('does not invoke `renderPrompter` for any non-prompter mode', async () => {
      // Walk the seven-mode allowlist (minus `prompter`) and confirm
      // that none of them invoke the prompter renderer. A regression
      // that gated `renderPrompter` on `mode !== undefined` (instead
      // of `mode === 'prompter'`) would call the renderer for
      // standalone / loop / paused / scrub / screenshot under URL
      // navigations that should run the lifecycle. The renderer's
      // invocation count IS the assertion — not the count of any
      // particular mode — because the regression is "renderer fires
      // when it shouldn't."
      const nonPrompterModes = NAVIGATION_MODES.filter((m) => m !== 'prompter');
      const calls: PrompterScript[] = [];
      const renderPrompter: PrompterRenderer = (script) => {
        calls.push(script);
      };
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      for (const mode of nonPrompterModes) {
        const loader = createSceneLoader({
          scenes: createSceneRegistry([sceneA]),
          compositions: createCompositionRegistry([]),
          stage: stage.element,
          buildCtx: stubCtx,
          createPreloader: () => () => undefined,
          timeline: noopTimeline,
          renderPrompter,
        });
        await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode });
      }
      // No mode at all (defaults to `present`).
      const loaderNoMode = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        renderPrompter,
      });
      await loaderNoMode.handle(sceneTarget('scene-a'));

      expect(calls).toEqual([]);
    });

    it('still suppresses the lifecycle when `renderPrompter` is omitted (graceful degradation)', async () => {
      // A workbench bootstrap that has not yet wired a captions UI
      // omits the field. The loader's structural-suppression
      // guarantee is independent of the renderer's presence — under
      // `mode=prompter` the lifecycle is bypassed regardless. The
      // captions data path simply has no consumer until the UI lands.
      // A regression that skipped suppression when `renderPrompter`
      // was absent would surface lifecycle entries here.
      const { probe, preloader, runner, buildCtxFn, scenes } = buildLifecycleProbe();
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([...scenes]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: buildCtxFn,
        createPreloader: () => preloader,
        timeline: asTimeline(runner),
        // renderPrompter omitted on purpose.
      });

      await loader.handle(prompterSceneTarget('scene-a'));

      expect(probe.log).toEqual([]);
      expect(probe.preloaderInvocations).toBe(0);
      expect(probe.buildCtxInvocations).toBe(0);
    });

    it('writes `data-pulsar-scene-target` and `data-pulsar-composition-target` for a composition-prompter target (preserves observability of what was addressed)', async () => {
      // Stage attrs communicate "what was addressed," not "what runs."
      // Suppressed lifecycle does NOT mean suppressed observability —
      // an external observer (agent, future tooling) reading the
      // stage must still see what URL the runtime navigated to.
      // Mirrors the standalone / loop / paused / scrub / screenshot
      // invariant.
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
        renderPrompter: () => undefined,
      });

      await loader.handle(prompterCompositionSceneTarget('full-talk', 'scene-b'));

      expect(stage.attrs.get('data-pulsar-scene-target')).toBe('scene-b');
      expect(stage.attrs.get('data-pulsar-composition-target')).toBe('full-talk');
    });

    it('writes no `data-pulsar-mode-*` suppression attribute on the stage under `mode=prompter`', async () => {
      // Mirrors ADR-016 / ADR-017 / ADR-018 / ADR-019 / ADR-020 /
      // ADR-021. ADR-022 keeps the same invariant: the prompter UI
      // surface (when it lands) is free to write its own stage
      // attributes, but the loader does NOT preemptively claim a
      // `data-pulsar-mode-*` namespace.
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        renderPrompter: () => undefined,
      });

      await loader.handle(prompterSceneTarget('scene-a'));

      const modeAttrs = Array.from(stage.attrs.keys()).filter((name) =>
        name.startsWith('data-pulsar-mode-'),
      );
      expect(modeAttrs).toEqual([]);
    });

    it('surfaces composition-not-registered as a navigation error under `mode=prompter` (no silent fallback)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const calls: PrompterScript[] = [];
      const renderPrompter: PrompterRenderer = (script) => {
        calls.push(script);
      };
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
        renderPrompter,
      });

      await loader.handle(prompterCompositionTarget('not-registered'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'composition "not-registered" is not registered',
      );
      expect(stage.attrs.get('data-pulsar-navigation-error')).toBeDefined();
      expect(calls).toEqual([]);
    });

    it('surfaces composition-member error under `mode=prompter` for an unknown scene in `composition+scene` (renderPrompter is NOT called on error paths)', async () => {
      const sceneA = buildScene({ id: 'scene-a' });
      const sceneZ = buildScene({ id: 'scene-z' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const calls: PrompterScript[] = [];
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
        renderPrompter: (script) => {
          calls.push(script);
        },
      });

      await loader.handle(prompterCompositionSceneTarget('full-talk', 'scene-z'));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        'scene "scene-z" is not a member of composition "full-talk"',
      );
      expect(calls).toEqual([]);
    });

    it('surfaces index-out-of-range under `mode=prompter` (renderPrompter is NOT called on error paths)', async () => {
      // Parity with the composition-not-registered and
      // composition-member error tests: error paths MUST surface
      // via `onError` AND MUST NOT invoke the renderer. Capturing
      // the renderer's invocations here keeps the index-out-of-
      // range coverage symmetric with its siblings; without that
      // assertion, a regression that dispatched the renderer
      // before validation would slip past this test.
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const errors: unknown[] = [];
      const calls: PrompterScript[] = [];
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
        renderPrompter: (script) => {
          calls.push(script);
        },
      });

      await loader.handle(prompterCompositionIndexTarget('full-talk', 5));

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain('index 5 is out of range');
      expect(calls).toEqual([]);
    });

    it('does not invoke `renderPrompter` for `kind: "none"` under `mode=prompter` (nothing addressed, nothing to render)', async () => {
      // `?mode=prompter` with no scene or composition target resolves
      // to `kind: 'none'`. There is no addressed metadata to derive
      // captions from, so the loader should run no renderer. A
      // regression that synthesized an empty script for `none`
      // targets would cause the captions UI to flash an empty view
      // on every popstate without an addressed scene.
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      const calls: PrompterScript[] = [];
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        renderPrompter: (script) => {
          calls.push(script);
        },
      });

      await loader.handle({ locator: { kind: 'none' }, mode: 'prompter' });

      expect(calls).toEqual([]);
    });

    it("invokes a renderer's PrompterDispose callback after abort when the navigation is superseded", async () => {
      // ADR-022's renderer contract (enforceable, not docs-only): a
      // renderer that mounts persistent DOM returns a
      // `PrompterDispose` callback (`() => void | Promise<void>`).
      // The loader OWNS the cleanup sequencing: it parks until
      // `signal.aborted` fires (next navigation, dispose(), etc.),
      // then invokes the callback. This test pins the loader's
      // call to dispose specifically — without the loader-driven
      // sequencing, a renderer that mounted DOM and returned a
      // dispose function would never see it called.
      const teardown: string[] = [];
      const sceneA = buildScene({ id: 'scene-a', captions: [{ at: 0, text: 'a' }] });
      const sceneB = buildScene({ id: 'scene-b', captions: [{ at: 0, text: 'b' }] });
      const stage = buildStage();
      const renderPrompter: PrompterRenderer = (script) => {
        if (script.entries[0]?.sceneId === 'scene-b') {
          // Second navigation: trivial renderer (no DOM mounted),
          // returns void. Lets `loader.idle()` settle without a
          // third navigation supersession.
          return undefined;
        }
        // First navigation: simulate "mount captions DOM" and
        // return the dispose callback the loader will invoke
        // after abort.
        return () => {
          teardown.push('dispose:scene-a');
        };
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        renderPrompter,
      });

      void loader.handle(prompterSceneTarget('scene-a'));
      // Yield so the first dispatch's renderer returns its dispose
      // callback to the loader before the second navigation
      // supersedes it.
      await new Promise<void>((r) => setTimeout(r, 0));
      void loader.handle(prompterSceneTarget('scene-b'));
      await loader.idle();

      expect(teardown).toEqual(['dispose:scene-a']);
    });

    it('awaits an async PrompterDispose callback before settling the dispatch', async () => {
      // The dispose callback may be async (e.g. waiting for a CSS
      // transition before unmounting captions DOM). The loader
      // MUST await it before resolving the dispatch — otherwise
      // the next navigation's dispatch could overlap with the
      // previous renderer's lingering teardown. Pin async dispose
      // explicitly: after the supersession, the
      // present-mode-runner's create only fires AFTER the prompter
      // dispatch's async dispose completes.
      const order: string[] = [];
      const sceneA = buildScene({ id: 'scene-a', captions: [{ at: 0, text: 'a' }] });
      const sceneB = buildScene({
        id: 'scene-b',
        create: () => {
          order.push('create:scene-b');
        },
      });
      const stage = buildStage();
      const renderPrompter: PrompterRenderer = () => async () => {
        // Async teardown — yields to the microtask queue twice
        // before completing, so a regression that didn't await
        // dispose would let scene-b's create run first.
        await Promise.resolve();
        await Promise.resolve();
        order.push('dispose:scene-a');
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        renderPrompter,
      });

      void loader.handle(prompterSceneTarget('scene-a'));
      await new Promise<void>((r) => setTimeout(r, 0));
      // Second navigation is `mode=present` (default) — its
      // lifecycle running BEFORE prompter dispose would fail this
      // assertion.
      void loader.handle(sceneTarget('scene-b'));
      await loader.idle();

      expect(order).toEqual(['dispose:scene-a', 'create:scene-b']);
    });

    it('does not park when the renderer returns void (no persistent state mounted)', async () => {
      // The void-return path of the contract: renderer mounted
      // nothing, dispatch is fully complete after the renderer's
      // promise resolves. `loader.idle()` should settle WITHOUT a
      // second navigation aborting the dispatch. A regression that
      // always parked would hang `idle()` here (vitest's per-test
      // timeout would surface the hang as a failure).
      //
      // Beyond the no-hang behavior, also verify that the renderer
      // was invoked exactly once and that `loader.idle()` is
      // settled by the time we observe it (proving the dispatch
      // completed, not that idle() simply returned the still-
      // pending queue promise).
      const sceneA = buildScene({ id: 'scene-a' });
      const stage = buildStage();
      let renderCount = 0;
      const renderPrompter: PrompterRenderer = () => {
        renderCount += 1;
        return undefined;
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: noopTimeline,
        renderPrompter,
      });

      // Single navigation — no supersession, no abort. With void
      // return, idle() must still settle.
      await loader.handle(prompterSceneTarget('scene-a'));
      const idleSettled = await Promise.race([
        loader.idle().then(() => 'settled' as const),
        new Promise<'pending'>((r) => setTimeout(() => r('pending'), 0)),
      ]);

      expect(renderCount).toBe(1);
      expect(idleSettled).toBe('settled');
    });

    it('aborts a long-running `renderPrompter` when superseded by another navigation (the renderer signal honors abort)', async () => {
      // `renderPrompter` is awaited by the loader's serialized queue
      // — same shape as `runTimeline`. A renderer that doesn't honor
      // `signal` would hold up the next navigation forever. The
      // loader aborts the in-flight signal eagerly on enqueue (parity
      // with `runTimeline`'s abort path). The renderer's signal-tied
      // promise resolves on abort, allowing the next navigation to
      // proceed. A regression that forgot to abort prompter would
      // surface here as a hung second navigation (vitest's per-test
      // timeout makes the hang an explicit failure).
      //
      // The test must yield between the two `handle()` calls so the
      // first navigation actually starts running its renderer before
      // the second navigation aborts it. Without the yield, latest-
      // event supersession (in `runOnce`) would drop event 1 before
      // it ran — that is correct behavior for back-to-back enqueues
      // but would not exercise the abort path this test pins.
      const sceneA = buildScene({ id: 'scene-a', captions: [{ at: 0, text: 'first' }] });
      const sceneB = buildScene({ id: 'scene-b', captions: [{ at: 0, text: 'second' }] });
      const stage = buildStage();
      const seenScripts: PrompterScript[] = [];
      // The first navigation's renderer parks until abort (so the
      // second navigation has something to abort). The second
      // navigation's renderer returns immediately, so loader.idle()
      // settles instead of hanging on a non-existent third
      // navigation.
      const renderPrompter: PrompterRenderer = (script, signal) => {
        seenScripts.push(script);
        if (script.entries[0]?.sceneId === 'scene-a') {
          return new Promise<undefined>((resolve) => {
            if (signal.aborted) {
              resolve(undefined);
              return;
            }
            signal.addEventListener('abort', () => resolve(undefined), { once: true });
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
        timeline: noopTimeline,
        renderPrompter,
      });

      void loader.handle(prompterSceneTarget('scene-a'));
      // Yield to the microtask queue so the first navigation enters
      // its renderer (and registers the abort listener) before the
      // second navigation enqueues and aborts it.
      await new Promise<void>((r) => setTimeout(r, 0));
      void loader.handle(prompterSceneTarget('scene-b'));
      await loader.idle();

      // Both renders were entered (the second only after the first
      // aborted). A regression that didn't abort the first would
      // hang the second indefinitely.
      expect(seenScripts.map((s) => s.entries[0]?.sceneId)).toEqual(['scene-a', 'scene-b']);
    });

    it('cleans up an in-flight non-prompter scene before dispatching prompter (cleanup-before-handoff across mode boundary)', async () => {
      // Navigating from `mode=present` (running scene) to
      // `mode=prompter` MUST run the previous scene's `cleanup`
      // before the prompter renderer fires. The loader's
      // abort-and-await pattern already delivers this for any two
      // navigations; this test pins it specifically across the
      // present→prompter boundary, which is the most common
      // workbench trigger (a reviewer pivots from playback to
      // captions review without reloading).
      //
      // Yield between the two `handle()` calls so the first
      // navigation actually mounts before the second supersedes it
      // — without the yield, latest-event supersession would drop
      // the present-mode lifecycle entirely and there would be no
      // cleanup to observe.
      const order: string[] = [];
      const sceneA = buildScene({
        id: 'scene-a',
        create: () => {
          order.push('create:scene-a');
        },
        cleanup: () => {
          order.push('cleanup:scene-a');
        },
      });
      const sceneB = buildScene({ id: 'scene-b', captions: [{ at: 0, text: 'b' }] });
      const stage = buildStage();
      // First navigation: a runner that parks until abort so the
      // loader observes an in-flight scene at the moment the prompter
      // navigation enqueues. Second navigation: prompter; its
      // renderer logs its turn order to confirm cleanup ran first.
      const heldRunnerB = (input: LegacyRunInput) =>
        new Promise<void>((resolve) => {
          if (input.signal?.aborted === true) {
            resolve();
            return;
          }
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      const renderPrompter: PrompterRenderer = () => {
        order.push('renderPrompter:scene-b');
      };
      const loader = createSceneLoader({
        scenes: createSceneRegistry([sceneA, sceneB]),
        compositions: createCompositionRegistry([]),
        stage: stage.element,
        buildCtx: stubCtx,
        createPreloader: () => () => undefined,
        timeline: asTimeline(heldRunnerB),
        renderPrompter,
      });

      void loader.handle(sceneTarget('scene-a')); // mode=present (default)
      // Yield so scene-a's lifecycle starts (create runs, runner
      // parks waiting for abort).
      await new Promise<void>((r) => setTimeout(r, 0));
      void loader.handle(prompterSceneTarget('scene-b'));
      await loader.idle();

      // create:scene-a → (abort fires) → cleanup:scene-a → then
      // renderPrompter:scene-b. The relative order pins
      // cleanup-before-handoff across the present→prompter boundary.
      expect(order).toEqual(['create:scene-a', 'cleanup:scene-a', 'renderPrompter:scene-b']);
    });
  });
});
