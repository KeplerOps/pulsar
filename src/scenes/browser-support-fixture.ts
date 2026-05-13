// PUL-Q002 / ADR-030 — browser-support fixture scene.
//
// The placeholder scene (`./placeholder.ts`) is intentionally a no-op:
// no assets, an empty timeline, no DOM mutation beyond a lifecycle
// marker. That makes it adequate for boot-shape coverage but
// inadequate as the *only* scene the PUL-Q002 browser gate exercises
// — a WebKit-only regression in the GSAP timeline engine
// (ADR-003), the per-navigation audio service (ADR-004), the
// composition resolver's natural-completion path, or scene-level
// `cleanup(ctx)` would not be observable through the placeholder
// alone (codex pre-push review, cycle 1).
//
// This scene gives the browser-support smoke gate a real GSAP
// timeline to run end-to-end:
//
//   1. `create(ctx)` mounts a `<div data-pulsar-fixture-target>`
//      under the workbench stage, with `data-pulsar-fixture-state`
//      starting at `"mounted"`.
//   2. `timeline(ctx)` returns a GSAP timeline whose tween advances
//      the same element's `data-pulsar-fixture-state` to `"ran"`.
//      The timeline's natural duration is short (100ms) so the
//      master timeline completes inside the navigation rather than
//      stalling the spec.
//   3. `cleanup(ctx)` removes the fixture element entirely.
//
// The Playwright spec at `tests-e2e/browser-support.spec.ts` boots
// this scene under `mode=present` and asserts the fixture element
// reached `data-pulsar-fixture-state="ran"` (proving the GSAP
// timeline executed) and was then torn down (proving the
// composition resolver completed and cleanup ran). All three
// supported engines run the same spec.
//
// Scope intentionally narrow: no declared assets, no declared audio.
// The asset preloader and audio service paths have their own unit
// tests; this fixture is for the GSAP / resolver / cleanup surface
// the placeholder cannot exercise. Adding declared assets here
// would expand the gate beyond what its smoke-coverage role asks
// for and would couple the gate to file-serving behavior that is
// already covered by Vitest unit tests.
//
// The scene is `standalone: true` — it does not assume surrounding
// composition context. `trailerSafe: false` — it has nothing
// trailer-worthy to show.

import { NAVIGATION_MODES } from '../runtime/navigation';
import type { SceneModule } from '../runtime/scene';
import type { WorkbenchSceneCtx } from '../runtime/scene-loader';

const FIXTURE_TARGET_ATTR = 'data-pulsar-fixture-target';
const FIXTURE_STATE_ATTR = 'data-pulsar-fixture-state';
const FIXTURE_DURATION_SECONDS = 0.1;

interface FixtureDomFactory {
  createElement(tag: string): { setAttribute(name: string, value: string): void };
}

interface FixtureStageElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild?(node: unknown): unknown;
  querySelector?(selector: string): {
    setAttribute(name: string, value: string): void;
    remove?(): void;
  } | null;
  // Real DOM elements expose `ownerDocument`; the fixture allocates
  // DOM through the injected stage's owner document rather than the
  // ambient global `document` so the scene stays pure against
  // injected dependencies (ADR-008 #2). Optional so off-DOM test
  // harnesses can supply a bare stage without a document.
  readonly ownerDocument?: FixtureDomFactory | null;
}

// PUL-F012 / PUL-F022 / ADR-003: the runtime fills `ctx.stage`,
// `ctx.mode`, and `ctx.gsap`. The fixture only reads those three
// fields; the predicate narrows to that subset so a malformed ctx
// (no `stage`, no `mode`, unknown `mode`, non-element `stage`) is
// a no-op rather than a crash. Same defensive pattern the
// placeholder scene uses, scoped to what this scene actually reads.
// `stage` narrows to `FixtureStageElement | null` (not the
// runtime's `StageElement | null`) so the lifecycle hooks can
// read the optional `appendChild` / `querySelector` /
// `ownerDocument` members without a per-hook type assertion.
interface FixtureCtx {
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

const isFixtureCtx = (value: unknown): value is FixtureCtx => {
  if (typeof value !== 'object' || value === null) return false;
  if (!('stage' in value) || !('mode' in value) || !('gsap' in value)) return false;
  const { stage, mode, gsap } = value;
  if (!isStageShape(stage)) return false;
  if (typeof mode !== 'string' || !(NAVIGATION_MODES as readonly string[]).includes(mode)) {
    return false;
  }
  return isGsapShape(gsap);
};

const findFixtureElement = (
  stage: FixtureStageElement,
): { setAttribute(name: string, value: string): void; remove?: () => void } | null => {
  if (typeof stage.querySelector !== 'function') return null;
  return stage.querySelector(`[${FIXTURE_TARGET_ATTR}]`);
};

export const browserSupportFixtureScene: SceneModule = {
  id: 'browser-support-fixture',
  title: 'Browser support fixture',
  duration: null,
  tags: ['fixture', 'browser-support'],
  assets: [],
  captions: [],
  audio: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  create: (ctx: unknown) => {
    if (!isFixtureCtx(ctx)) return;
    const stage = ctx.stage;
    if (stage === null) return;
    if (typeof stage.appendChild !== 'function') return;
    // Allocate the fixture element through the stage's owner
    // document — same dependency seam the runtime hands scenes via
    // `ctx.stage`. Reaching for the ambient global `document` would
    // bypass the explicit-dependency boundary the rest of the
    // runtime enforces (ADR-008 #2; codex pre-push review, cycle
    // 2). Off-DOM test harnesses that supply a stage without
    // `ownerDocument` are a no-op rather than a crash.
    const ownerDoc = stage.ownerDocument;
    if (ownerDoc === undefined || ownerDoc === null) return;
    if (typeof ownerDoc.createElement !== 'function') return;
    const el = ownerDoc.createElement('div');
    el.setAttribute(FIXTURE_TARGET_ATTR, '');
    el.setAttribute(FIXTURE_STATE_ATTR, 'mounted');
    stage.appendChild(el);
  },
  timeline: (ctx: unknown) => {
    if (!isFixtureCtx(ctx)) return null;
    const stage = ctx.stage;
    if (stage === null) return null;
    const el = findFixtureElement(stage);
    if (el === null) return null;
    // Build a real GSAP timeline through `ctx.gsap`. A `.call(...)` at
    // the timeline's end advances the fixture state, which the
    // Playwright spec polls after `mode=present` runs to natural
    // completion. The tween itself is a no-op set so the test
    // doesn't depend on visual styles surviving a CSS reset — the
    // structural assertion is that the GSAP timeline ran.
    const tl = ctx.gsap.timeline();
    tl.set(el, { opacity: 1 });
    tl.to(el, { opacity: 1, duration: FIXTURE_DURATION_SECONDS });
    tl.call(() => {
      el.setAttribute(FIXTURE_STATE_ATTR, 'ran');
    });
    return tl;
  },
  cleanup: (ctx: unknown) => {
    if (!isFixtureCtx(ctx)) return;
    const stage = ctx.stage;
    if (stage === null) return;
    const el = findFixtureElement(stage);
    if (el !== null && typeof el.remove === 'function') {
      el.remove();
    }
  },
};
