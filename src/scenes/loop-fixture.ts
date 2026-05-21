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
// The ctx validation and DOM mount/find/remove scaffolding is shared
// with the browser-support fixture via `./fixture-support.ts`. Scope
// intentionally narrow: no declared assets, no declared audio. The
// scene is `standalone: true` — it does not assume surrounding
// composition context. `trailerSafe: false` — it has nothing
// trailer-worthy to show.

import type { SceneModule } from '../runtime/scene';
import {
  findFixtureElement,
  isFixtureCtx,
  mountFixtureElement,
  removeFixtureElement,
} from './fixture-support';

const FIXTURE_TARGET_ATTR = 'data-pulsar-loop-target';
const FIXTURE_ITERATION_ATTR = 'data-pulsar-loop-iteration';
const FIXTURE_DURATION_SECONDS = 0.1;

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
  // The element starts at iteration 0 — "mounted, not yet run" — so a
  // Playwright poll can distinguish a mounted-but-stalled runner from
  // a looping one.
  create: (ctx: unknown) => {
    mountFixtureElement(ctx, FIXTURE_TARGET_ATTR, [[FIXTURE_ITERATION_ATTR, '0']]);
  },
  timeline: (ctx: unknown) => {
    if (!isFixtureCtx(ctx)) return null;
    const stage = ctx.stage;
    if (stage === null) return null;
    const el = findFixtureElement(stage, FIXTURE_TARGET_ATTR);
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
    removeFixtureElement(ctx, FIXTURE_TARGET_ATTR);
  },
};
