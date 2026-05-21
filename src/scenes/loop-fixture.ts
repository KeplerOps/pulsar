// PUL-F015 / ADR-018 — loop verification fixture scene.
//
// PUL-F015: "In `mode=loop`, the runtime SHALL run the addressed
// scene's timeline and restart it on completion." The restart
// mechanic is shipped — `positionMaster()` in
// `src/runtime/timeline.ts` sets `master.repeat(-1)` for
// `headRepeat === 'until-aborted'`. What that implementation lacked
// was an *observable* loop-acceptance signal.
//
// The browser-support fixture (`./browser-support-fixture.ts`)
// advances a single sticky `data-pulsar-fixture-state="ran"`
// attribute. That proves one timeline completion, not
// restart-on-completion: under `mode=loop` the attribute reaches
// `"ran"` once and never changes again, so a runner that played the
// timeline exactly once would be indistinguishable from one that
// genuinely loops.
//
// This fixture gives loop mode a *distinct per-iteration* observable:
//
//   1. `create(ctx)` mounts a `<div data-pulsar-loop-target>` under
//      the workbench stage, with `data-pulsar-loop-iteration`
//      starting at `"0"` (mounted, not yet run).
//   2. `timeline(ctx)` returns a GSAP timeline whose end `.call()`
//      increments a per-navigation counter and writes it to the same
//      element's `data-pulsar-loop-iteration`. Under a looping
//      master (`repeat(-1)`) the nested scene timeline replays each
//      cycle, so the attribute strictly increases: `"1"`, `"2"`, ….
//   3. `cleanup(ctx)` removes the fixture element entirely.
//
// The Playwright spec at `tests-e2e/loop-mode.spec.ts` boots this
// scene under `mode=loop` and polls `data-pulsar-loop-iteration`
// until it reaches at least `2` — proving the GSAP master actually
// restarted the timeline on completion in a real browser engine.
//
// The counter is a closure local to `timeline(ctx)`. PUL-F015 loops
// the *timeline*, not the scene lifecycle: the resolver calls
// `timeline(ctx)` once per navigation and the master's `repeat(-1)`
// replays that one timeline, so a per-`timeline`-call counter
// matches the contract — a fresh navigation starts a fresh count.
//
// Scope intentionally narrow, mirroring the browser-support fixture:
// no declared assets, no declared audio. The scene is
// `standalone: true` — it does not assume surrounding composition
// context. `trailerSafe: false` — it has nothing trailer-worthy to
// show.

import { NAVIGATION_MODES } from '../runtime/navigation';
import type { SceneModule } from '../runtime/scene';
import type { WorkbenchSceneCtx } from '../runtime/scene-loader';

const FIXTURE_TARGET_ATTR = 'data-pulsar-loop-target';
const FIXTURE_ITERATION_ATTR = 'data-pulsar-loop-iteration';
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
// (no `stage`, no `mode`, unknown `mode`, non-element `stage`) is a
// no-op rather than a crash. Same defensive pattern the
// browser-support fixture uses, scoped to what this scene reads.
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

export const loopFixtureScene: SceneModule = {
  id: 'loop-fixture',
  title: 'Loop verification fixture',
  duration: null,
  tags: ['fixture', 'loop'],
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
    // document — the same dependency seam the runtime hands scenes
    // via `ctx.stage`. Reaching for the ambient global `document`
    // would bypass the explicit-dependency boundary the rest of the
    // runtime enforces (ADR-008 #2). Off-DOM test harnesses that
    // supply a stage without `ownerDocument` are a no-op rather than
    // a crash.
    const ownerDoc = stage.ownerDocument;
    if (ownerDoc === undefined || ownerDoc === null) return;
    if (typeof ownerDoc.createElement !== 'function') return;
    const el = ownerDoc.createElement('div');
    el.setAttribute(FIXTURE_TARGET_ATTR, '');
    // Start at 0 — "mounted, not yet run" — so a Playwright poll can
    // distinguish a mounted-but-stalled runner from a looping one.
    el.setAttribute(FIXTURE_ITERATION_ATTR, '0');
    stage.appendChild(el);
  },
  timeline: (ctx: unknown) => {
    if (!isFixtureCtx(ctx)) return null;
    const stage = ctx.stage;
    if (stage === null) return null;
    const el = findFixtureElement(stage);
    if (el === null) return null;
    // Build a real GSAP timeline through `ctx.gsap`. The `.call(...)`
    // at the timeline's end increments a per-navigation counter and
    // writes it to `data-pulsar-loop-iteration`. Under `mode=loop`
    // the master is set to `repeat(-1)` (PUL-F015 / ADR-018), so the
    // nested scene timeline replays on every cycle and the `.call()`
    // re-fires — the attribute strictly increases, which is the
    // observable the loop-mode e2e spec polls. The tween itself is a
    // no-op `to` so the test does not depend on visual styles
    // surviving a CSS reset; the structural datum is the counter.
    let iterations = 0;
    const tl = ctx.gsap.timeline();
    tl.set(el, { opacity: 1 });
    tl.to(el, { opacity: 1, duration: FIXTURE_DURATION_SECONDS });
    tl.call(() => {
      iterations += 1;
      el.setAttribute(FIXTURE_ITERATION_ATTR, String(iterations));
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
