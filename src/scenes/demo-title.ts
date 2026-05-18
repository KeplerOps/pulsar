// Issue 98 — vertical-slice demo: title-card scene.
//
// The demo composition (`src/compositions/demo.ts`) wires this scene
// first. It opens the slice with a heading and a subtitle, fading
// each in on a named GSAP beat so reviewers can verify the timeline
// engine, the prompter caption path, and the URL beat-seek surface
// against authored content rather than a fixture. The codex preflight
// at `docs/design/issue-098-vertical-slice-demo-preflight.md` is
// binding: this scene reuses `ctx.gsap`, `ctx.stage.ownerDocument`,
// the existing scene schema, and the existing identifier grammar; it
// adds no new ADR, mode, asset pipeline, audio engine, or runtime
// abstraction.

import { NAVIGATION_MODES } from '../runtime/navigation';
import type { SceneModule } from '../runtime/scene';
import type { WorkbenchSceneCtx } from '../runtime/scene-loader';

// Stable DOM marker shared by all three demo scenes; the e2e spec
// asserts the scene root mounts so blank-stage regressions surface
// as a layout-or-mount problem rather than a failure to compile the
// scene. Per-scene constants so each scene owns its own attribute
// key — the preflight is explicit about avoiding a "demo framework"
// on the first pass.
const ROOT_ATTR = 'data-pulsar-demo-scene';
const ROOT_VALUE = 'demo-title';
const STATE_ATTR = 'data-pulsar-demo-state';
// Timeline-owned activation marker. The composition resolver mounts
// every scene's root before the master timeline runs (ADR-025), so a
// scene that is visible from `create(ctx)` would render alongside
// every other scene at once. The activation marker AND the inline
// `display` style are flipped from `false` / `none` to `true` / `''`
// by a `tl.call(...)` at the start of this scene's timeline segment
// and back at its end. Result: only the currently-playing scene is
// active, which is what a sequential composition is supposed to look
// like. Per-scene constant so each scene owns its own marker.
const ACTIVE_ATTR = 'data-pulsar-demo-active';

const BEAT_TITLE_IN = 'title-in';
const BEAT_SUBTITLE_IN = 'subtitle-in';

const TITLE_TEXT = 'Pulsar';
const SUBTITLE_TEXT = 'A scene-and-composition runtime for cinematic browser presentations.';

interface FixtureDomElement {
  setAttribute(name: string, value: string): void;
  appendChild?(node: unknown): unknown;
  textContent?: string;
}

interface FixtureDomFactory {
  createElement(tag: string): FixtureDomElement;
}

interface FixtureStageElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild?(node: unknown): unknown;
  querySelector?(selector: string): {
    setAttribute?(name: string, value: string): void;
    remove?(): void;
  } | null;
  readonly ownerDocument?: FixtureDomFactory | null;
}

interface DemoCtx {
  readonly stage: FixtureStageElement | null;
  readonly mode: WorkbenchSceneCtx['mode'];
  readonly gsap: WorkbenchSceneCtx['gsap'];
}

const isStageShape = (stage: unknown): stage is FixtureStageElement | null => {
  if (stage === null) return true;
  if (typeof stage !== 'object') return false;
  const candidate = stage as Partial<Record<'setAttribute' | 'removeAttribute', unknown>>;
  return (
    typeof candidate.setAttribute === 'function' && typeof candidate.removeAttribute === 'function'
  );
};

const isGsapShape = (gsap: unknown): gsap is WorkbenchSceneCtx['gsap'] => {
  if (gsap === null || typeof gsap !== 'object') return false;
  return typeof (gsap as { timeline?: unknown }).timeline === 'function';
};

const isDemoCtx = (value: unknown): value is DemoCtx => {
  if (typeof value !== 'object' || value === null) return false;
  if (!('stage' in value) || !('mode' in value) || !('gsap' in value)) return false;
  const { stage, mode, gsap } = value;
  if (!isStageShape(stage)) return false;
  if (typeof mode !== 'string' || !(NAVIGATION_MODES as readonly string[]).includes(mode)) {
    return false;
  }
  return isGsapShape(gsap);
};

const findRoot = (
  stage: FixtureStageElement,
): {
  setAttribute?(name: string, value: string): void;
  remove?(): void;
} | null => {
  if (typeof stage.querySelector !== 'function') return null;
  return stage.querySelector(`[${ROOT_ATTR}="${ROOT_VALUE}"]`);
};

// Flip the scene root's activation marker + inline display style in
// one place so the start-of-segment and end-of-segment `tl.call(...)`s
// stay symmetric. `null` root is a no-op (off-DOM test harness) so
// these are safe to invoke unconditionally.
const setActive = (
  root: {
    setAttribute?(name: string, value: string): void;
  } | null,
  active: boolean,
): void => {
  if (root === null || typeof root.setAttribute !== 'function') return;
  root.setAttribute(ACTIVE_ATTR, active ? 'true' : 'false');
  // Inline-style activation rather than relying on production CSS,
  // because the workbench currently ships no CSS — relying on an
  // external rule would leave the demo visually layered even when the
  // marker said "inactive". Inline keeps the demo self-contained.
  root.setAttribute('style', active ? '' : 'display: none;');
};

export const demoTitleScene: SceneModule = {
  id: 'demo-title',
  title: 'Demo — title card',
  // `null` is honest: the scene's playable length is whatever
  // `timeline(ctx)` constructs, and PUL-F001 / ADR-002 explicitly
  // treats a divergence between `duration` metadata and the actual
  // GSAP timeline as a drift risk for prompter / export consumers.
  // Promoting this to an authoritative integer is a follow-up if /
  // when scene authoring needs scrub-bar metadata.
  duration: null,
  tags: ['demo'],
  assets: [],
  // Caption `at` labels are kebab-case and resolve against the GSAP
  // labels added in `timeline(ctx)`; the shared identifier grammar
  // (ADR-008 #1) covers both.
  captions: [
    { at: BEAT_TITLE_IN, text: TITLE_TEXT },
    { at: BEAT_SUBTITLE_IN, text: SUBTITLE_TEXT },
  ],
  audio: [],
  defaultNext: 'demo-feature',
  standalone: true,
  trailerSafe: true,
  create: (ctx: unknown) => {
    if (!isDemoCtx(ctx)) return;
    const stage = ctx.stage;
    if (stage === null) return;
    if (typeof stage.appendChild !== 'function') return;
    const ownerDoc = stage.ownerDocument;
    if (ownerDoc === undefined || ownerDoc === null) return;
    if (typeof ownerDoc.createElement !== 'function') return;

    const root = ownerDoc.createElement('section');
    root.setAttribute(ROOT_ATTR, ROOT_VALUE);
    root.setAttribute(STATE_ATTR, 'mounted');
    // Initially inactive: the resolver mounts every scene in the
    // slice before any timeline runs, so a visible-on-create root
    // would render alongside every sibling scene. Activation flips
    // to true inside the scene's own timeline segment.
    root.setAttribute(ACTIVE_ATTR, 'false');
    root.setAttribute('style', 'display: none;');
    if (typeof root.appendChild === 'function') {
      const title = ownerDoc.createElement('h1');
      title.setAttribute('data-pulsar-demo-title', '');
      title.textContent = TITLE_TEXT;
      root.appendChild(title);
      const subtitle = ownerDoc.createElement('p');
      subtitle.setAttribute('data-pulsar-demo-subtitle', '');
      subtitle.textContent = SUBTITLE_TEXT;
      root.appendChild(subtitle);
    }
    stage.appendChild(root);
  },
  timeline: (ctx: unknown) => {
    if (!isDemoCtx(ctx)) return null;
    const stage = ctx.stage;
    if (stage === null) return null;
    const root = findRoot(stage);
    // GSAP labels are the named beats the URL / prompter / future
    // beat-seek surface address. We add them on the scene's own
    // timeline so `composeMasterTimeline` translates them into
    // `scene("demo-title").label("title-in")` master labels per
    // `sceneTimelineLabel` in `src/runtime/timeline.ts`.
    //
    // Timeline-owned activation: the first `tl.call(...)` flips the
    // root from inactive to active (visible); the trailing
    // `tl.call(...)` flips it back. Wrapping the work in `tl.call`
    // (rather than `tl.set` on the element) keeps the test stub —
    // which is not a real DOM element — happy.
    const tl = ctx.gsap.timeline();
    tl.call(() => setActive(root, true));
    tl.addLabel(BEAT_TITLE_IN, 0);
    tl.to({}, { duration: 1 });
    tl.addLabel(BEAT_SUBTITLE_IN, 1);
    // Pin the terminal mutation to a tween's `onComplete` rather than
    // a trailing `tl.call(...)`: when a scene is the LAST entry in the
    // composition slice its child timeline ends at master time
    // `master.duration()`, and a callback registered at that exact
    // position races the master's `onComplete` and may be skipped on
    // the final tick. A tween's `onComplete` fires when the tween
    // itself ends, which is what every other scene timeline in this
    // runtime relies on — see the browser-support fixture's
    // terminating `tl.call` after a non-trailing `.to`.
    tl.to(
      {},
      {
        duration: 1,
        onComplete: () => {
          if (root !== null && typeof root.setAttribute === 'function') {
            root.setAttribute(STATE_ATTR, 'ran');
          }
          setActive(root, false);
        },
      },
    );
    return tl;
  },
  cleanup: (ctx: unknown) => {
    if (!isDemoCtx(ctx)) return;
    const stage = ctx.stage;
    if (stage === null) return;
    const root = findRoot(stage);
    if (root !== null && typeof root.remove === 'function') {
      root.remove();
    }
  },
};
