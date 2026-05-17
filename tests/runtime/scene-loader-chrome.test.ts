// Tests for the loader → chrome dispatch seam — PUL-F031 / ADR-031.
//
// The chrome controller is workbench-owned and built by `main.ts`; the
// loader's only job is to call `chrome.applyMode(effectiveMode(target))`
// once per navigation, before any lifecycle work, so chrome visibility
// tracks the addressed workbench mode. These tests pin that seam:
//
//   - Called exactly once per navigation with the effective mode.
//   - Called BEFORE `scene.create(ctx)` so chrome is in place when
//     the first frame paints.
//   - Called ONCE for a multi-scene composition (not once per scene)
//     — pins the "persists across scene navigations within a
//     composition" clause structurally.
//   - Called with the URL-derived mode even when target resolution
//     fails (a `?scene=nonexistent&mode=standalone` URL still
//     suppresses chrome because the user asked).
//   - NOT called on parse-error events (chrome state persists across
//     malformed URLs).
//   - NOT called when `validateModeGrammar` rejects a hand-built
//     forged mode (the URL is invalid; chrome state is preserved).

import { describe, expect, it } from 'vitest';

import {
  type AudioService,
  type CompositionTimelineAdapter,
  type NavigationMode,
  type NavigationTarget,
  type SceneModule,
  type WorkbenchSceneCtx,
  buildScene,
  buildStage,
  compositionTarget,
  createCompositionRegistry,
  createSceneLoader,
  createSceneRegistry,
  gsap,
  noneTarget,
  noopTimeline,
  sceneTarget,
  stubCtx,
} from './scene-loader.helpers';

interface RecordingChrome {
  readonly chrome: { applyMode(mode: NavigationMode): void };
  readonly calls: readonly NavigationMode[];
}

const recordingChrome = (): RecordingChrome => {
  const calls: NavigationMode[] = [];
  return {
    calls,
    chrome: {
      applyMode: (mode) => {
        calls.push(mode);
      },
    },
  };
};

describe('createSceneLoader — chrome dispatch (PUL-F031 / ADR-031)', () => {
  it('calls chrome.applyMode exactly once per navigation with the effective mode', async () => {
    const rec = recordingChrome();
    const scene = buildScene({ id: 'scene-a' });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([scene]),
      compositions: createCompositionRegistry([]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome: rec.chrome,
    });

    await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
    expect(rec.calls).toEqual(['present']);
  });

  it('defaults to present when mode is absent (matches effectiveMode)', async () => {
    const rec = recordingChrome();
    const scene = buildScene({ id: 'scene-a' });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([scene]),
      compositions: createCompositionRegistry([]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome: rec.chrome,
    });

    await loader.handle(sceneTarget('scene-a'));
    expect(rec.calls).toEqual(['present']);
  });

  it.each([
    ['standalone'],
    ['screenshot'],
    ['loop'],
    ['paused'],
    ['scrub'],
    ['rehearsal'],
  ] as const)("forwards mode='%s' to chrome.applyMode", async (mode) => {
    const rec = recordingChrome();
    const scene = buildScene({ id: 'scene-a' });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([scene]),
      compositions: createCompositionRegistry([]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome: rec.chrome,
    });

    await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode });
    expect(rec.calls).toEqual([mode]);
  });

  it("forwards mode='prompter' even though the resolver lifecycle is bypassed", async () => {
    // mode=prompter bypasses scene lifecycle entirely, but chrome
    // still tracks the URL-addressed mode (preflight: the chrome
    // policy is mode-driven, not lifecycle-driven).
    const rec = recordingChrome();
    const scene = buildScene({ id: 'scene-a' });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([scene]),
      compositions: createCompositionRegistry([]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome: rec.chrome,
    });

    await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'prompter' });
    expect(rec.calls).toEqual(['prompter']);
  });

  it('calls chrome.applyMode for a `kind: "none"` target (mode still applies even without a scene)', async () => {
    const rec = recordingChrome();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([]),
      compositions: createCompositionRegistry([]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome: rec.chrome,
    });

    await loader.handle(noneTarget);
    expect(rec.calls).toEqual(['present']);
  });

  it('calls chrome.applyMode BEFORE scene.create(ctx) so chrome is in place when the first frame paints', async () => {
    const log: string[] = [];
    const chrome = {
      applyMode: (mode: NavigationMode) => {
        log.push(`chrome:${mode}`);
      },
    };
    const scene = buildScene({
      id: 'scene-a',
      create: () => {
        log.push('create:scene-a');
      },
      timeline: () => {
        log.push('timeline:scene-a');
        return null;
      },
      cleanup: () => {
        log.push('cleanup:scene-a');
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([scene]),
      compositions: createCompositionRegistry([]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome,
    });

    await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
    // Pin the exact ordering — chrome MUST flip visibility before
    // create runs, so a present-mode composition does not flash an
    // un-chromed frame.
    expect(log).toEqual([
      'chrome:present',
      'create:scene-a',
      'timeline:scene-a',
      'cleanup:scene-a',
    ]);
  });

  it('calls chrome.applyMode ONCE for a multi-scene composition navigation (persists across scene transitions)', async () => {
    // PUL-F031 clause: chrome SHALL persist across scene navigations
    // within a composition without being torn down between scenes.
    // Structural pin: the loader's dispatch point is upstream of the
    // resolver's per-scene loop, so a 3-scene composition under
    // present produces exactly ONE applyMode call.
    const rec = recordingChrome();
    const scenes: SceneModule[] = [
      buildScene({ id: 'scene-a' }),
      buildScene({ id: 'scene-b' }),
      buildScene({ id: 'scene-c' }),
    ];
    const loader = createSceneLoader({
      scenes: createSceneRegistry(scenes),
      compositions: createCompositionRegistry([
        { id: 'full-talk', manifest: ['scene-a', 'scene-b', 'scene-c'] },
      ]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome: rec.chrome,
    });

    await loader.handle(compositionTarget('full-talk'));
    expect(rec.calls).toEqual(['present']);
  });

  it('receives ordered applyMode calls when two sequential navigations flip the mode', async () => {
    const rec = recordingChrome();
    const sceneA = buildScene({ id: 'scene-a' });
    const sceneB = buildScene({ id: 'scene-b' });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([sceneA, sceneB]),
      compositions: createCompositionRegistry([]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome: rec.chrome,
    });

    await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });
    await loader.handle({ locator: { kind: 'scene', scene: 'scene-b' }, mode: 'standalone' });
    expect(rec.calls).toEqual(['present', 'standalone']);
  });

  it('applies the URL-addressed mode even when resolution fails (chrome reflects user intent)', async () => {
    // A `?scene=nonexistent&mode=standalone` URL should still
    // suppress chrome — the user asked for standalone. The chrome
    // call lives upstream of resolveSceneNavigation, so the
    // resolution failure does not skip the chrome flip.
    const rec = recordingChrome();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([]),
      compositions: createCompositionRegistry([]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome: rec.chrome,
      onError: () => undefined,
    });

    await loader.handle({
      locator: { kind: 'scene', scene: 'nonexistent' },
      mode: 'standalone',
    });
    expect(rec.calls).toEqual(['standalone']);
  });

  it('does NOT call chrome.applyMode on the parse-error path (chrome persists across malformed URLs)', async () => {
    const rec = recordingChrome();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([]),
      compositions: createCompositionRegistry([]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome: rec.chrome,
      onError: () => undefined,
    });

    loader.handleError(new Error('navigation grammar is invalid: bogus'));
    await loader.idle();
    expect(rec.calls).toEqual([]);
  });

  it('does NOT call chrome.applyMode when validateModeGrammar rejects a hand-built forged mode', async () => {
    // Defense in depth: a non-parser caller that constructs a
    // NavigationTarget with a forged mode trips validateModeGrammar
    // BEFORE chrome would apply. The chrome contract requires a
    // valid NavigationMode; we MUST NOT apply an invalid mode to
    // chrome (which would then throw and contaminate the navigation
    // error path).
    const rec = recordingChrome();
    const loader = createSceneLoader({
      scenes: createSceneRegistry([]),
      compositions: createCompositionRegistry([]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome: rec.chrome,
      onError: () => undefined,
    });

    await loader.handle({
      locator: { kind: 'scene', scene: 'whatever' },
      mode: 'made-up-mode' as unknown as NavigationMode,
    });
    expect(rec.calls).toEqual([]);
  });

  it('flips chrome visibility immediately on a superseding navigation, without waiting for the prior loadʼs cleanup (codex review, cycle 1)', async () => {
    // PUL-F031 clause: chrome is workbench-owned and outside the
    // scene-lifecycle serialization invariant. A navigation that
    // flips mode (visible → hidden) MUST hide chrome BEFORE the
    // prior load's `cleanup(ctx)` drains — otherwise a slow
    // present-mode cleanup would leave chrome visible while the user
    // already navigated to standalone / screenshot.
    let releaseFirstCleanup: () => void = () => undefined;
    const firstCleanupBlocker = new Promise<void>((resolve) => {
      releaseFirstCleanup = resolve;
    });
    const log: { event: string; mode?: NavigationMode }[] = [];
    const chrome = {
      applyMode: (mode: NavigationMode) => {
        log.push({ event: 'chrome', mode });
      },
    };
    const sceneA = buildScene({
      id: 'scene-a',
      cleanup: () => {
        log.push({ event: 'cleanup:scene-a' });
        // Holds cleanup until the test releases it — pins that the
        // SECOND navigation's chrome flip does NOT wait for this.
        return firstCleanupBlocker;
      },
    });
    const sceneB = buildScene({
      id: 'scene-b',
      create: () => {
        log.push({ event: 'create:scene-b' });
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([sceneA, sceneB]),
      compositions: createCompositionRegistry([]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome,
      onError: () => undefined,
    });

    // First navigation: present-mode scene-a starts. Cleanup will
    // hang on the blocker until we release it.
    const first = loader.handle({
      locator: { kind: 'scene', scene: 'scene-a' },
      mode: 'present',
    });
    // Wait for first navigation's chrome dispatch to happen so the
    // second call's eagerness is observable.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log.filter((entry) => entry.event === 'chrome').map((e) => e.mode)).toEqual(['present']);

    // Second navigation: standalone — should hide chrome immediately,
    // BEFORE scene-a's cleanup drains.
    const second = loader.handle({
      locator: { kind: 'scene', scene: 'scene-b' },
      mode: 'standalone',
    });
    // Yield so the synchronous chrome dispatch in `runOnce` runs even
    // though the queue's `pending.then(...)` is still waiting for
    // scene-a's cleanup.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The chrome dispatch for the second navigation MUST have fired
    // before scene-a's cleanup released — that is the structural
    // form of "chrome is workbench-owned, outside scene cleanup."
    const chromeCalls = log.filter((entry) => entry.event === 'chrome').map((e) => e.mode);
    expect(chromeCalls).toEqual(['present', 'standalone']);

    // Release the first navigation's cleanup so both promises can
    // settle and the test does not hang.
    releaseFirstCleanup();
    await first;
    await second;
  });

  it('surfaces a chrome adapter throw through onError + data-pulsar-navigation-error and skips lifecycle for that event (codex review, cycle 1)', async () => {
    // PUL-F031 preflight error-envelope clause: chrome-related
    // failures use the existing onError / data-pulsar-navigation-
    // error surface. A synchronous adapter throw is a workbench
    // bootstrap defect; the loader MUST route it through the same
    // envelope as a grammar failure, and MUST NOT then run scene
    // lifecycle around an unsynchronized chrome surface.
    const errors: unknown[] = [];
    let createRan = false;
    const stage = buildStage();
    const scene = buildScene({
      id: 'scene-a',
      create: () => {
        createRan = true;
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([scene]),
      compositions: createCompositionRegistry([]),
      stage: stage.element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      chrome: {
        applyMode: () => {
          throw new Error('chrome adapter exploded');
        },
      },
      onError: (err) => errors.push(err),
    });

    await loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' });

    // The error must reach onError.
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain('chrome adapter exploded');
    // The stage attribute must reflect the navigation failure — the
    // post-reset surface is the durable diagnostic.
    expect(stage.attrs.get('data-pulsar-navigation-error')).toContain('chrome adapter exploded');
    // The lifecycle MUST NOT have run — chrome is in an unknown
    // state, and proceeding would compound the bootstrap defect.
    expect(createRan).toBe(false);
    // Stage's scene/composition attrs must NOT be set — runTarget
    // never ran.
    expect(stage.attrs.has('data-pulsar-scene-target')).toBe(false);
  });

  it('is inert when no chrome adapter is supplied (preserves the existing optional-seam pattern)', async () => {
    // Mirrors the existing renderPrompter / presenterCommands /
    // audioUnlockAdapter ergonomics: a loader that has not yet wired
    // chrome (e.g. Node tests, pre-chrome workbench bootstraps) MUST
    // NOT throw when the navigation fires AND must still run the
    // full lifecycle. Asserting only `resolves.toBeUndefined()` would
    // pass even if a regression silently skipped `runTarget` for
    // `chrome === undefined` (test-quality review, cycle 1).
    let createRan = false;
    let timelineRan = false;
    let cleanupRan = false;
    const scene = buildScene({
      id: 'scene-a',
      create: () => {
        createRan = true;
      },
      timeline: () => {
        timelineRan = true;
        return null;
      },
      cleanup: () => {
        cleanupRan = true;
      },
    });
    const loader = createSceneLoader({
      scenes: createSceneRegistry([scene]),
      compositions: createCompositionRegistry([]),
      stage: buildStage().element,
      buildCtx: stubCtx,
      createPreloader: () => () => undefined,
      timeline: noopTimeline,
      // chrome intentionally omitted
    });

    await expect(
      loader.handle({ locator: { kind: 'scene', scene: 'scene-a' }, mode: 'present' }),
    ).resolves.toBeUndefined();
    // Pin that the full lifecycle ran — the inert-seam contract is
    // "chrome absence does not break the rest of the pipeline."
    expect(createRan).toBe(true);
    expect(timelineRan).toBe(true);
    expect(cleanupRan).toBe(true);
  });
});
