/** @vitest-environment happy-dom */
// Pulsar L2 — shared lifecycle-envelope behavioral coverage.
//
// `_shared.ts` is the mount/find/activate/cleanup envelope every L2
// template factory routes through. The smoke tests in templates*.test.ts
// exercise it only through full template factories, which never hit the
// edge branches: a null `ctx.stage` (off-DOM Node environment), the
// `deactivateOtherRoots` sibling-flip when two scenes share a stage, the
// `setTemplateActive(null)` no-op, and the trailing-tween `onDeactivate`
// teardown. This file drives those helpers directly against the real
// happy-dom document and asserts the OBSERVED DOM/timeline effect of each
// branch so a regression in the envelope fails here.
//
// A companion block imports the register barrel (`src/system/register`)
// so the barrel re-export is exercised and `gsapDuration` is checked.

import { gsap } from 'gsap';
import { describe, expect, it } from 'vitest';
import { assertSceneModule } from '../../src/runtime/scene';
import { ADVANCE_GATE_LABEL } from '../../src/runtime/timeline';
// Barrel re-export under test: register/index.ts re-exports these from
// ./tokens. Importing through the barrel (not ./tokens) is what covers
// the re-export line.
import { CSS_TOKEN_NAMES, color, gsapDuration, motion, space, z } from '../../src/system/register';
import {
  TEMPLATE_ROOT_ATTR,
  asTemplateCtx,
  buildTemplateScene,
  buildTemplateTimeline,
  cleanupTemplateRoot,
  findTemplateRoot,
  mountTemplateRoot,
  setTemplateActive,
} from '../../src/system/templates/_shared';

const makeStage = (): HTMLElement => document.createElement('div');

/** A ctx whose stage IS attached to the live document tree. */
const liveCtx = (stage: HTMLElement): unknown => {
  document.body.appendChild(stage);
  return { stage, mode: 'present', gsap };
};

/** A ctx with a null stage — the off-DOM Node environment branch. */
const nullStageCtx = (): unknown => ({ stage: null, mode: 'present', gsap });

const requireRoot = (root: HTMLElement | null, message: string): HTMLElement => {
  expect(root).not.toBeNull();
  if (root === null) throw new Error(message);
  return root;
};

describe('_shared envelope — mount/find/activate/cleanup edge branches', () => {
  it('asTemplateCtx returns the same object identity and exposes the typed view', () => {
    const raw = { stage: makeStage(), mode: 'present', gsap };
    const view = asTemplateCtx(raw);
    // The narrowing is identity-preserving (a cast, not a copy): the
    // returned view must be the very object passed in so reads see live
    // ctx state.
    expect(view).toBe(raw);
    expect(view.stage).toBe(raw.stage);
    expect(view.mode).toBe('present');
  });

  it('mountTemplateRoot returns null when ctx.stage is null (off-DOM)', () => {
    let built = false;
    const root = mountTemplateRoot({
      ctx: nullStageCtx(),
      rootValue: 'off-dom',
      buildChildren: () => {
        built = true;
      },
    });
    expect(root).toBeNull();
    // The off-DOM guard short-circuits before buildChildren runs.
    expect(built).toBe(false);
  });

  it('mountTemplateRoot builds, marks, and appends the root with defaults', () => {
    const stage = makeStage();
    const root = requireRoot(
      mountTemplateRoot({
        ctx: liveCtx(stage),
        rootValue: 'mount-default',
        buildChildren: (el, ownerDoc) => {
          const span = ownerDoc.createElement('span');
          span.className = 'child-marker';
          span.textContent = 'hello';
          el.appendChild(span);
        },
      }),
      'expected mounted root',
    );

    // Default tag is <section>.
    expect(root.tagName).toBe('SECTION');
    // Attribute (not dataset) so it is queryable by the literal name.
    expect(root.getAttribute(TEMPLATE_ROOT_ATTR)).toBe('mount-default');
    // class includes base + kind (kind defaults to rootValue).
    expect(root.getAttribute('class')).toBe('pulsar-template pulsar-template--mount-default');
    // Mounted INACTIVE so it stays hidden until the timeline activates it.
    expect(root.dataset.pulsarTemplateActive).toBe('false');
    // Actually appended into the stage tree.
    expect(root.parentElement).toBe(stage);
    expect(stage.querySelector(`[${TEMPLATE_ROOT_ATTR}="mount-default"]`)).toBe(root);
    // buildChildren ran inside the freshly-mounted root with the owner doc.
    const child = requireRoot(
      root.querySelector<HTMLElement>('.child-marker'),
      'expected built child',
    );
    expect(child.textContent).toBe('hello');
    expect(child.ownerDocument).toBe(stage.ownerDocument);
  });

  it('mountTemplateRoot honors tag, templateKind, and extraClasses overrides', () => {
    const stage = makeStage();
    const root = requireRoot(
      mountTemplateRoot({
        ctx: liveCtx(stage),
        rootValue: 'unique-id',
        templateKind: 'shared-kind',
        tag: 'article',
        extraClasses: ['extra-a', 'extra-b'],
      }),
      'expected mounted root',
    );
    expect(root.tagName).toBe('ARTICLE');
    // rootValue stays unique while the kind drives the CSS modifier.
    expect(root.getAttribute(TEMPLATE_ROOT_ATTR)).toBe('unique-id');
    expect(root.getAttribute('class')).toBe(
      'pulsar-template pulsar-template--shared-kind extra-a extra-b',
    );
  });

  it('mountTemplateRoot without buildChildren leaves an empty root', () => {
    const stage = makeStage();
    const root = requireRoot(
      mountTemplateRoot({ ctx: liveCtx(stage), rootValue: 'no-children' }),
      'expected mounted root',
    );
    expect(root.children).toHaveLength(0);
  });

  it('findTemplateRoot returns null on a null stage', () => {
    expect(findTemplateRoot(nullStageCtx(), 'whatever')).toBeNull();
  });

  it('findTemplateRoot resolves the mounted root by value and misses otherwise', () => {
    const stage = makeStage();
    const ctx = liveCtx(stage);
    const mounted = requireRoot(
      mountTemplateRoot({ ctx, rootValue: 'findable' }),
      'expected mounted root',
    );
    expect(findTemplateRoot(ctx, 'findable')).toBe(mounted);
    expect(findTemplateRoot(ctx, 'not-there')).toBeNull();
  });

  it('setTemplateActive is a no-op when the root is null', () => {
    // The off-DOM path passes a null root; the call must not throw and
    // there is nothing to assert on but the absence of a crash plus the
    // contract that true/false both no-op.
    expect(() => setTemplateActive(null, true)).not.toThrow();
    expect(() => setTemplateActive(null, false)).not.toThrow();
  });

  it('setTemplateActive flips the activation marker both directions', () => {
    const stage = makeStage();
    const root = requireRoot(
      mountTemplateRoot({ ctx: liveCtx(stage), rootValue: 'flip' }),
      'expected mounted root',
    );
    expect(root.dataset.pulsarTemplateActive).toBe('false');
    setTemplateActive(root, true);
    expect(root.dataset.pulsarTemplateActive).toBe('true');
    // CSS reveals on data-pulsar-template-active="true".
    expect(root.matches('[data-pulsar-template-active="true"]')).toBe(true);
    setTemplateActive(root, false);
    expect(root.dataset.pulsarTemplateActive).toBe('false');
  });

  it('cleanupTemplateRoot removes only the matching root from the stage', () => {
    const stage = makeStage();
    const ctx = liveCtx(stage);
    mountTemplateRoot({ ctx, rootValue: 'keep' });
    mountTemplateRoot({ ctx, rootValue: 'drop' });
    expect(stage.querySelectorAll(`[${TEMPLATE_ROOT_ATTR}]`)).toHaveLength(2);

    cleanupTemplateRoot('drop')(ctx);

    expect(findTemplateRoot(ctx, 'drop')).toBeNull();
    expect(findTemplateRoot(ctx, 'keep')).not.toBeNull();
    expect(stage.querySelectorAll(`[${TEMPLATE_ROOT_ATTR}]`)).toHaveLength(1);
  });

  it('cleanupTemplateRoot on a null stage is a safe no-op', () => {
    expect(() => cleanupTemplateRoot('any')(nullStageCtx())).not.toThrow();
  });
});

describe('_shared envelope — buildTemplateTimeline activation lifecycle', () => {
  it('returns null when ctx.stage is null', () => {
    const tl = buildTemplateTimeline({
      ctx: nullStageCtx(),
      rootValue: 'off-dom',
      buildSegments: () => {},
    });
    expect(tl).toBeNull();
  });

  it('leading call deactivates sibling roots and activates the kept root', () => {
    const stage = makeStage();
    const ctx = liveCtx(stage);
    // Two scenes mounted on the same stage. The sibling starts ACTIVE so
    // we can observe deactivateOtherRoots flipping it back off.
    const sibling = requireRoot(
      mountTemplateRoot({ ctx, rootValue: 'sibling' }),
      'expected sibling root',
    );
    setTemplateActive(sibling, true);
    expect(sibling.dataset.pulsarTemplateActive).toBe('true');

    const keep = requireRoot(
      mountTemplateRoot({ ctx, rootValue: 'keep-active' }),
      'expected keep root',
    );
    expect(keep.dataset.pulsarTemplateActive).toBe('false');

    let segmentRoot: HTMLElement | null = null;
    const tl = buildTemplateTimeline({
      ctx,
      rootValue: 'keep-active',
      holdForAdvance: false,
      // Give the body real duration so we can park the playhead AFTER the
      // leading activation call but BEFORE the trailing deactivation
      // onComplete and observe the active state mid-segment.
      suffixDurationSeconds: 0.5,
      buildSegments: (segTl, root) => {
        segmentRoot = root;
        segTl.to({}, { duration: 1 });
      },
    });
    const timeline = tl as gsap.core.Timeline;
    expect(timeline).not.toBeNull();
    // buildSegments was handed the resolved root.
    expect(segmentRoot).toBe(keep);

    // Advance into the middle of the segment so the leading `tl.call(...)`
    // (at t=0) has fired but the trailing onComplete (at the end) has not.
    timeline.time(0.5, false);
    // The kept root is now active; the sibling was forced inactive.
    expect(keep.dataset.pulsarTemplateActive).toBe('true');
    expect(sibling.dataset.pulsarTemplateActive).toBe('false');

    timeline.kill();
  });

  it('trailing tween onComplete deactivates the root and fires onDeactivate', () => {
    const stage = makeStage();
    const ctx = liveCtx(stage);
    const root = requireRoot(mountTemplateRoot({ ctx, rootValue: 'teardown' }), 'expected root');

    let teardownFired = false;
    const tl = buildTemplateTimeline({
      ctx,
      rootValue: 'teardown',
      holdForAdvance: false,
      suffixDurationSeconds: 0.1,
      buildSegments: (segTl) => {
        segTl.to({}, { duration: 0.1 });
      },
      onDeactivate: () => {
        teardownFired = true;
      },
    });
    const timeline = tl as gsap.core.Timeline;

    // Run the whole timeline synchronously to its very end so both the
    // leading call (activate) and the trailing onComplete (deactivate +
    // teardown) execute.
    timeline.totalTime(timeline.totalDuration(), false);

    expect(root.dataset.pulsarTemplateActive).toBe('false');
    expect(teardownFired).toBe(true);

    timeline.kill();
  });

  it('inserts an advance gate label when holdForAdvance is left default', () => {
    const stage = makeStage();
    const ctx = liveCtx(stage);
    mountTemplateRoot({ ctx, rootValue: 'gated' });

    const tl = buildTemplateTimeline({
      ctx,
      rootValue: 'gated',
      buildSegments: (segTl) => {
        segTl.to({}, { duration: 0.2 });
      },
    });
    const timeline = tl as gsap.core.Timeline;
    // The canonical hold gate is authored on the timeline by label.
    expect(timeline.labels[ADVANCE_GATE_LABEL]).toBeDefined();
    timeline.kill();
  });

  it('omits the advance gate when holdForAdvance is false', () => {
    const stage = makeStage();
    const ctx = liveCtx(stage);
    mountTemplateRoot({ ctx, rootValue: 'ungated' });

    const tl = buildTemplateTimeline({
      ctx,
      rootValue: 'ungated',
      holdForAdvance: false,
      buildSegments: (segTl) => {
        segTl.to({}, { duration: 0.2 });
      },
    });
    const timeline = tl as gsap.core.Timeline;
    expect(timeline.labels[ADVANCE_GATE_LABEL]).toBeUndefined();
    timeline.kill();
  });
});

describe('_shared envelope — buildTemplateScene wiring', () => {
  it('builds a valid SceneModule whose default cleanup removes the root', () => {
    const stage = makeStage();
    const ctx = liveCtx(stage);

    const scene = buildTemplateScene({
      id: 'built-scene',
      title: 'Built Scene',
      create: (c) => {
        mountTemplateRoot({ ctx: c, rootValue: 'built-scene' });
      },
      timeline: (c) =>
        buildTemplateTimeline({
          ctx: c,
          rootValue: 'built-scene',
          buildSegments: (segTl) => {
            segTl.to({}, { duration: 0.1 });
          },
        }),
    });

    expect(() => assertSceneModule(scene)).not.toThrow();
    // Template defaults: standalone + trailer-safe + 'template' tag.
    expect(scene.id).toBe('built-scene');
    expect(scene.title).toBe('Built Scene');
    expect(scene.tags).toEqual(['template']);
    expect(scene.standalone).toBe(true);
    expect(scene.trailerSafe).toBe(true);

    // Lifecycle: create mounts the root, default cleanup removes it.
    scene.create(ctx);
    const root = requireRoot(findTemplateRoot(ctx, 'built-scene'), 'expected root');
    expect(root.getAttribute(TEMPLATE_ROOT_ATTR)).toBe('built-scene');
    const tl = scene.timeline(ctx) as gsap.core.Timeline | null;
    expect(tl).not.toBeNull();
    tl?.kill();

    scene.cleanup?.(ctx);
    expect(findTemplateRoot(ctx, 'built-scene')).toBeNull();
    expect(stage.querySelector(`[${TEMPLATE_ROOT_ATTR}="built-scene"]`)).toBeNull();
  });
});

describe('register barrel — re-export surface', () => {
  it('re-exports gsapDuration and converts ms to seconds', () => {
    // Imported from the barrel (src/system/register), exercising the
    // re-export line in register/index.ts.
    expect(gsapDuration(1000)).toBe(1);
    expect(gsapDuration(280)).toBeCloseTo(0.28);
    expect(gsapDuration(0)).toBe(0);
  });

  it('re-exports the token tables with their authored values', () => {
    expect(color.brandOrange).toBe('#fa582d');
    expect(motion.baseMs).toBe(280);
    expect(space.railVw).toBe(5);
    expect(z.hud).toBe(70);
  });

  it('re-exports CSS_TOKEN_NAMES as a non-empty list of --pulsar- names', () => {
    expect(Array.isArray(CSS_TOKEN_NAMES)).toBe(true);
    expect(CSS_TOKEN_NAMES.length).toBeGreaterThan(0);
    expect(CSS_TOKEN_NAMES).toContain('--pulsar-motion-base');
    for (const name of CSS_TOKEN_NAMES) {
      expect(name.startsWith('--pulsar-')).toBe(true);
    }
  });
});
