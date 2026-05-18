// Issue 98 — vertical-slice demo composition runtime-boundary tests.
//
// Coverage sits at the same runtime seams the demo flows through in
// production (per the codex preflight in
// `docs/design/issue-098-vertical-slice-demo-preflight.md`): the scene
// schema validator, the navigation resolver, the composition resolver
// lifecycle, the prompter aggregation function, and the GSAP timeline
// engine the runtime injects via `ctx.gsap`. The scene modules and
// composition manifest under test do not exist when this file is first
// committed; the failing tests drive each piece into existence (TDD per
// Step 4.4 of `/implement`).
//
// The existing PUL-P002 CI gate at `workbench-graph.test.ts` already
// runs `validateRuntime` over the registered workbench graph, so this
// file does not re-implement the duplicate-id / unknown-reference /
// asset-resolvability phases — it covers the demo-specific behavior
// the validator pass does not (lifecycle ordering across the slice,
// prompter caption aggregation, GSAP label presence on each scene's
// timeline). Browser-level reachability and the live-served asset path
// live in `tests-e2e/demo-composition.spec.ts`.

import { gsap } from 'gsap';
import { describe, expect, it, vi } from 'vitest';
import { DEMO_COMPOSITION_ID, demoComposition } from '../../src/compositions/demo';
import { createCompositionRegistry } from '../../src/runtime/composition-registry';
import type { CompositionTimelineAdapter } from '../../src/runtime/composition-resolver';
import type { NavigationTarget } from '../../src/runtime/navigation';
import { buildPrompterScript } from '../../src/runtime/prompter';
import { createSceneRegistry } from '../../src/runtime/registry';
import { type SceneModule, assertSceneModule } from '../../src/runtime/scene';
import {
  loadSceneNavigationTarget,
  resolveSceneNavigation,
} from '../../src/runtime/scene-navigation';
import { createGsapCompositionTimeline, createTimelineEngine } from '../../src/runtime/timeline';
import { DEMO_FEATURE_ASSET_URL, demoFeatureScene } from '../../src/scenes/demo-feature';
import { demoOutroScene } from '../../src/scenes/demo-outro';
import { demoTitleScene } from '../../src/scenes/demo-title';
import { WORKBENCH_COMPOSITIONS, WORKBENCH_SCENES } from '../../src/workbench-graph';

// The three demo scenes the issue 98 vertical slice composes. Listed
// in manifest order so any drift between this fixture and
// `src/compositions/demo.ts` surfaces in the slice-order assertion
// below rather than as a silent re-ordering.
const DEMO_SCENES: readonly SceneModule[] = [demoTitleScene, demoFeatureScene, demoOutroScene];

// ----- helpers --------------------------------------------------------------

// A minimal stage element good enough for the demo scenes' defensive
// ctx narrowing — same shape `browser-support-fixture.ts` and
// `dom-css-accessibility-fixture.ts` use. The recording array makes
// it easy to assert what attributes a scene wrote.
interface StageRecorder {
  readonly attrs: Map<string, string>;
  readonly children: unknown[];
  readonly removed: string[];
}

const createStage = (): {
  recorder: StageRecorder;
  stage: {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    appendChild(node: unknown): unknown;
    querySelector(selector: string): { remove(): void } | null;
    readonly ownerDocument: {
      createElement(tag: string): {
        setAttribute(name: string, value: string): void;
        appendChild(node: unknown): unknown;
        readonly tagName: string;
        textContent: string;
      };
    };
  };
} => {
  const attrs = new Map<string, string>();
  const children: unknown[] = [];
  const removed: string[] = [];
  const createElement = (
    tag: string,
  ): {
    setAttribute(name: string, value: string): void;
    appendChild(node: unknown): unknown;
    readonly tagName: string;
    textContent: string;
    readonly attrs: Map<string, string>;
  } => {
    const elAttrs = new Map<string, string>();
    const elChildren: unknown[] = [];
    return {
      tagName: tag.toUpperCase(),
      textContent: '',
      attrs: elAttrs,
      setAttribute: (n, v) => {
        elAttrs.set(n, v);
      },
      appendChild: (node) => {
        elChildren.push(node);
        return node;
      },
    };
  };
  const stage = {
    setAttribute: (n: string, v: string) => {
      attrs.set(n, v);
    },
    removeAttribute: (n: string) => {
      attrs.delete(n);
    },
    appendChild: (node: unknown) => {
      children.push(node);
      return node;
    },
    // Returns whichever child carries the matched attribute prefix so
    // cleanup can find it. The demo scenes locate their root via a
    // `data-pulsar-demo-scene` marker; mirroring the fixture pattern
    // is sufficient for these tests.
    querySelector: (selector: string) => {
      const match = selector.match(/\[([^\]]+)\]/);
      if (match === null) return null;
      const inside = match[1] ?? '';
      // Handle both `[attr]` and `[attr="value"]` shapes. We compare
      // on attribute name AND, when supplied, the value so the demo
      // scenes' per-scene `[data-pulsar-demo-scene="demo-title"]`
      // lookups distinguish between sibling scenes mounted on the
      // same stage. Strip surrounding quotes from the value.
      const [rawAttr, rawValue] = inside.split('=');
      const attr = rawAttr?.trim() ?? '';
      const value = rawValue?.trim().replace(/^["']|["']$/g, '');
      const found = children.find((c) => {
        if (typeof c !== 'object' || c === null) return false;
        const elAttrs = (c as { attrs?: Map<string, string> }).attrs;
        if (!(elAttrs instanceof Map) || !elAttrs.has(attr)) return false;
        if (value === undefined) return true;
        return elAttrs.get(attr) === value;
      });
      if (found === undefined) return null;
      return {
        remove: () => {
          removed.push(attr);
          const idx = children.indexOf(found);
          if (idx >= 0) children.splice(idx, 1);
        },
      };
    },
    ownerDocument: { createElement },
  };
  return { recorder: { attrs, children, removed }, stage };
};

// A ctx shape that satisfies every demo scene's ctx predicate (stage +
// mode + gsap). `mode: 'present'` because the demo runs under
// `?composition=demo` (default mode = present per ADR-007). A real GSAP
// instance is wired in so the timeline assertions are against the
// production engine, not a stub — same approach `timeline.test.ts` uses.
const createCtx = (stage: ReturnType<typeof createStage>['stage']) => ({
  stage,
  mode: 'present' as const,
  gsap,
});

// ----- scene contract -------------------------------------------------------

describe('demo scenes — schema (issue 98)', () => {
  it.each(DEMO_SCENES.map((s) => [s.id, s] as const))(
    '"%s" satisfies the SceneModule contract',
    (_id, scene) => {
      expect(() => assertSceneModule(scene)).not.toThrow();
    },
  );

  it('the three demo scene ids are distinct', () => {
    const ids = new Set(DEMO_SCENES.map((s) => s.id));
    expect(ids.size).toBe(DEMO_SCENES.length);
  });

  it('every demo scene id begins with "demo-" so the demo namespace is greppable', () => {
    for (const scene of DEMO_SCENES) {
      expect(scene.id.startsWith('demo-')).toBe(true);
    }
  });
});

// ----- demo-title -----------------------------------------------------------

describe('demo-title scene (issue 98)', () => {
  it('declares the documented named beats as GSAP labels on its timeline', () => {
    const { stage } = createStage();
    const ctx = createCtx(stage);
    demoTitleScene.create(ctx);
    const tl = demoTitleScene.timeline(ctx) as gsap.core.Timeline | null;
    expect(tl).not.toBeNull();
    if (tl === null) return;
    expect(tl.labels).toHaveProperty('title-in');
    expect(tl.labels).toHaveProperty('subtitle-in');
    tl.kill();
    demoTitleScene.cleanup(ctx);
  });

  it('caption beat labels resolve against the scene timeline labels', () => {
    const { stage } = createStage();
    const ctx = createCtx(stage);
    demoTitleScene.create(ctx);
    const tl = demoTitleScene.timeline(ctx) as gsap.core.Timeline | null;
    if (tl === null) throw new Error('expected non-null timeline');
    const labels = new Set(Object.keys(tl.labels));
    for (const caption of demoTitleScene.captions) {
      if (typeof caption.at === 'string') {
        expect(labels.has(caption.at)).toBe(true);
      }
    }
    tl.kill();
    demoTitleScene.cleanup(ctx);
  });

  it('cleanup removes everything create mounted', () => {
    const { recorder, stage } = createStage();
    const ctx = createCtx(stage);
    demoTitleScene.create(ctx);
    expect(recorder.children.length).toBeGreaterThan(0);
    demoTitleScene.cleanup(ctx);
    expect(recorder.children.length).toBe(0);
  });
});

// ----- demo-feature ---------------------------------------------------------

describe('demo-feature scene (issue 98)', () => {
  it('declares the static asset URL the e2e spec proves is served', () => {
    expect(demoFeatureScene.assets).toEqual([DEMO_FEATURE_ASSET_URL]);
    // The asset is same-origin and root-relative; bare root-relative
    // paths bypass the preloader's scheme validation by design (see
    // `src/runtime/asset-preloader.ts` `resolveAssetUrl`), so this
    // assertion fences future drift to a disallowed scheme.
    expect(DEMO_FEATURE_ASSET_URL.startsWith('/')).toBe(true);
    expect(DEMO_FEATURE_ASSET_URL.includes('://')).toBe(false);
  });

  it('declares no audio sources on the first authored pass', () => {
    // The PUL-F030 / ADR-029 audio⊆assets invariant is already
    // enforced by `assertSceneModule` (covered above in the schema
    // describe). This assertion documents the deliberate first-pass
    // decision the codex preflight names: no audio in the demo
    // composition until the asset-policy decision is in scope. A
    // future demo-scene PR that adds an audio source will fail this
    // test, prompting a review of the policy choice — that is the
    // change-detection signal the previous vacuous loop did not
    // provide (test-quality review, cycle 1).
    expect(demoFeatureScene.audio).toEqual([]);
  });

  it('declares at least one named GSAP beat the prompter captions reference', () => {
    const { stage } = createStage();
    const ctx = createCtx(stage);
    demoFeatureScene.create(ctx);
    const tl = demoFeatureScene.timeline(ctx) as gsap.core.Timeline | null;
    expect(tl).not.toBeNull();
    if (tl === null) return;
    const labels = new Set(Object.keys(tl.labels));
    const beatCaptions = demoFeatureScene.captions.filter((c) => typeof c.at === 'string');
    expect(beatCaptions.length).toBeGreaterThan(0);
    for (const c of beatCaptions) {
      expect(labels.has(c.at as string)).toBe(true);
    }
    tl.kill();
    demoFeatureScene.cleanup(ctx);
  });
});

// ----- demo-outro -----------------------------------------------------------

describe('demo-outro scene (issue 98)', () => {
  it('declares the documented named beat as a GSAP label on its timeline', () => {
    // Symmetric with the demo-title and demo-feature label-presence
    // tests: the prior version asserted only `typeof tl.addLabel ===
    // 'function'`, which is true of every GSAP timeline regardless of
    // what the scene actually labeled. Removing `tl.addLabel(BEAT_
    // OUTRO_OUT, 1)` would not be caught; the caption `{ at: 'outro-
    // out', ... }` would silently reference a non-existent label
    // (test-quality review, cycle 1).
    const { stage } = createStage();
    const ctx = createCtx(stage);
    demoOutroScene.create(ctx);
    const tl = demoOutroScene.timeline(ctx) as gsap.core.Timeline | null;
    expect(tl).not.toBeNull();
    if (tl === null) return;
    expect(tl.labels).toHaveProperty('outro-out');
    tl.kill();
    demoOutroScene.cleanup(ctx);
  });

  it('caption beat labels resolve against the scene timeline labels', () => {
    // Same shape as the demo-title test. Catches a future drift
    // between `demoOutroScene.captions[*].at` and the GSAP labels
    // its `timeline(ctx)` actually adds.
    const { stage } = createStage();
    const ctx = createCtx(stage);
    demoOutroScene.create(ctx);
    const tl = demoOutroScene.timeline(ctx) as gsap.core.Timeline | null;
    if (tl === null) throw new Error('expected non-null timeline');
    const labels = new Set(Object.keys(tl.labels));
    for (const caption of demoOutroScene.captions) {
      if (typeof caption.at === 'string') {
        expect(labels.has(caption.at)).toBe(true);
      }
    }
    tl.kill();
    demoOutroScene.cleanup(ctx);
  });
});

// ----- composition manifest -------------------------------------------------

describe('demo composition manifest (issue 98)', () => {
  it('exports the canonical id and a static manifest in the documented order', () => {
    expect(DEMO_COMPOSITION_ID).toBe('demo');
    expect(demoComposition).toEqual(['demo-title', 'demo-feature', 'demo-outro']);
  });

  it('every manifest entry id matches a demo scene module id', () => {
    const sceneIds = new Set(DEMO_SCENES.map((s) => s.id));
    for (const entry of demoComposition) {
      const id = typeof entry === 'string' ? entry : entry.id;
      expect(sceneIds.has(id)).toBe(true);
    }
  });
});

// ----- navigation resolver --------------------------------------------------

// Build the registries from the CANONICAL workbench graph so this
// test always sees what `src/main.ts` and the PUL-P002 CI gate see.
// A future change to `src/workbench-graph.ts` (a new fixture scene, a
// reorder, a renamed composition) will flow through here without
// requiring a parallel test-only registry edit (codex pre-push
// review, cycle 1 — class finding on test-private registry drift).
const buildRegistries = (): {
  scenes: ReturnType<typeof createSceneRegistry>;
  compositions: ReturnType<typeof createCompositionRegistry>;
} => {
  const scenes = createSceneRegistry(WORKBENCH_SCENES);
  const compositions = createCompositionRegistry(WORKBENCH_COMPOSITIONS);
  return { scenes, compositions };
};

describe('demo composition navigation (issue 98)', () => {
  it('resolveSceneNavigation produces the three-scene slice in manifest order', () => {
    const { scenes, compositions } = buildRegistries();
    const navTarget: NavigationTarget = {
      locator: { kind: 'composition', composition: DEMO_COMPOSITION_ID },
    };
    const resolved = resolveSceneNavigation(navTarget, { scenes, compositions });
    expect(resolved).not.toBeNull();
    if (resolved === null) return;
    expect(resolved.composition?.id).toBe(DEMO_COMPOSITION_ID);
    expect(resolved.composition?.sceneSlice.map((s) => s.id)).toEqual([
      'demo-title',
      'demo-feature',
      'demo-outro',
    ]);
    expect(resolved.scene.id).toBe('demo-title');
  });

  it('buildPrompterScript aggregates the demo slice captions', () => {
    const { scenes, compositions } = buildRegistries();
    const navTarget: NavigationTarget = {
      locator: { kind: 'composition', composition: DEMO_COMPOSITION_ID },
    };
    const resolved = resolveSceneNavigation(navTarget, { scenes, compositions });
    if (resolved === null) throw new Error('expected resolved target');
    const script = buildPrompterScript(resolved);
    expect(script.composition?.id).toBe(DEMO_COMPOSITION_ID);
    expect(script.entries.map((e) => e.sceneId)).toEqual([
      'demo-title',
      'demo-feature',
      'demo-outro',
    ]);
    for (const entry of script.entries) {
      const source = DEMO_SCENES.find((s) => s.id === entry.sceneId);
      if (source === undefined) throw new Error(`unknown scene ${entry.sceneId}`);
      expect(entry.captions.length).toBe(source.captions.length);
    }
  });
});

// ----- end-to-end lifecycle through loadSceneNavigationTarget --------------

// Wrap a scene module with a proxy that records create / timeline /
// cleanup invocations into a shared `log` array. Used by the
// lifecycle test below so create + cleanup are actually observed,
// not just inferred from preload + timeline-adapter calls (codex
// pre-push review, cycle 1 — the previous test had no eyes on the
// create/cleanup ordering at all).
const instrumentScene = (scene: SceneModule, log: string[]): SceneModule => ({
  ...scene,
  create: (ctx) => {
    log.push(`create:${scene.id}`);
    return scene.create(ctx);
  },
  timeline: (ctx) => {
    log.push(`timeline:${scene.id}`);
    return scene.timeline(ctx);
  },
  cleanup: (ctx) => {
    log.push(`cleanup:${scene.id}`);
    return scene.cleanup(ctx);
  },
});

describe('demo composition lifecycle (issue 98)', () => {
  it('runs preload, create, timeline, and cleanup across the slice in the documented order', async () => {
    // Build registries from instrumented copies of the demo scenes so
    // each lifecycle hook records its invocation; the fixture and
    // placeholder scenes pass through unchanged because the demo
    // composition only references the three demo scenes.
    const log: string[] = [];
    const instrumented = WORKBENCH_SCENES.map((s) =>
      s.id.startsWith('demo-') ? instrumentScene(s, log) : s,
    );
    const scenes = createSceneRegistry(instrumented);
    const compositions = createCompositionRegistry(WORKBENCH_COMPOSITIONS);

    const navTarget: NavigationTarget = {
      locator: { kind: 'composition', composition: DEMO_COMPOSITION_ID },
    };
    const resolved = resolveSceneNavigation(navTarget, { scenes, compositions });
    if (resolved === null) throw new Error('expected resolved target');

    const preloadAssets = vi.fn(async (scene: SceneModule) => {
      log.push(`preload:${scene.id}`);
    });
    // A recording timeline adapter — same shape the
    // composition-resolver tests use. Resolves immediately so the
    // resolver advances into the cleanup phase.
    const adapter: CompositionTimelineAdapter = {
      run: async (segments) => {
        for (const segment of segments) {
          log.push(`adapter:${segment.id}`);
        }
      },
    };

    const { stage } = createStage();
    const ctx = createCtx(stage);

    await loadSceneNavigationTarget(resolved, {
      ctx,
      preloadAssets,
      timeline: adapter,
    });

    // PUL-F004 / ADR-025 lifecycle: preload(every scene) →
    // create(every scene) → timeline(every scene) →
    // adapter.run(slice) → cleanup(reverse mount order).
    expect(log.filter((e) => e.startsWith('preload:'))).toEqual([
      'preload:demo-title',
      'preload:demo-feature',
      'preload:demo-outro',
    ]);
    expect(log.filter((e) => e.startsWith('create:'))).toEqual([
      'create:demo-title',
      'create:demo-feature',
      'create:demo-outro',
    ]);
    expect(log.filter((e) => e.startsWith('timeline:'))).toEqual([
      'timeline:demo-title',
      'timeline:demo-feature',
      'timeline:demo-outro',
    ]);
    expect(log.filter((e) => e.startsWith('adapter:'))).toEqual([
      'adapter:demo-title',
      'adapter:demo-feature',
      'adapter:demo-outro',
    ]);
    // Cleanup runs in reverse mount order per PUL-P001 — the resolver
    // unwinds the slice from tail to head so any later-scene resource
    // that depends on an earlier scene's setup is released first.
    expect(log.filter((e) => e.startsWith('cleanup:'))).toEqual([
      'cleanup:demo-outro',
      'cleanup:demo-feature',
      'cleanup:demo-title',
    ]);
  });

  it('runs the full slice end-to-end through the production GSAP timeline adapter', async () => {
    // Drive the production `createGsapCompositionTimeline` adapter
    // over the demo slice so all three scenes' GSAP timelines are
    // actually nested into a master timeline and played to natural
    // completion. The recording adapter test above only proves the
    // resolver hands segments to *some* adapter in order; this test
    // proves the real GSAP adapter (ADR-003 / ADR-025) composes the
    // demo scenes' returned timelines without throwing, runs them to
    // completion, AND the resolver tears every scene down (codex
    // pre-push review, cycle 1 — "?composition=demo&mode=paused
    // only proves demo-title can mount").
    const scenes = createSceneRegistry(WORKBENCH_SCENES);
    const compositions = createCompositionRegistry(WORKBENCH_COMPOSITIONS);
    const navTarget: NavigationTarget = {
      locator: { kind: 'composition', composition: DEMO_COMPOSITION_ID },
    };
    const resolved = resolveSceneNavigation(navTarget, { scenes, compositions });
    if (resolved === null) throw new Error('expected resolved target');

    const { recorder, stage } = createStage();
    const ctx = createCtx(stage);
    const engine = createTimelineEngine();
    const adapter = createGsapCompositionTimeline({ engine });

    await loadSceneNavigationTarget(resolved, {
      ctx,
      preloadAssets: async () => {},
      timeline: adapter,
    });

    // Cleanup observation (test-quality review, cycle 1): without
    // these assertions the test could only fail on an uncaught
    // exception, which would miss a resolver bug that silently
    // skipped cleanup, a GSAP adapter that swallowed errors, or a
    // demo scene whose `cleanup` hook never ran. The fixture stage's
    // `querySelector('[attr=value]').remove()` splices the child
    // from `recorder.children`; an empty array proves every scene's
    // cleanup() located its root and removed it.
    expect(
      recorder.children.length,
      'every scene root must be removed from the stage by the resolver cleanup phase',
    ).toBe(0);
    // `recorder.removed` records the attribute key passed to
    // querySelector for each successful `.remove()`. Cleanup runs in
    // reverse mount order per PUL-P001, so the three demo scene
    // roots must come out in that order — confirming the resolver
    // ran cleanup for ALL THREE scenes in the documented sequence,
    // not just one or two.
    expect(recorder.removed).toEqual([
      'data-pulsar-demo-scene',
      'data-pulsar-demo-scene',
      'data-pulsar-demo-scene',
    ]);
  }, 30_000);
});
