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
// The ctx validation and DOM mount/find/remove scaffolding is shared
// with the loop verification fixture via `./fixture-support.ts`.
//
// The scene is `standalone: true` — it does not assume surrounding
// composition context. `trailerSafe: false` — it has nothing
// trailer-worthy to show.

import type { SceneModule } from '../runtime/scene';
import {
  findFixtureElement,
  isFixtureCtx,
  mountFixtureElement,
  removeFixtureElement,
} from './fixture-support';

const FIXTURE_TARGET_ATTR = 'data-pulsar-fixture-target';
const FIXTURE_STATE_ATTR = 'data-pulsar-fixture-state';
const FIXTURE_DURATION_SECONDS = 0.1;

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
    mountFixtureElement(ctx, FIXTURE_TARGET_ATTR, [[FIXTURE_STATE_ATTR, 'mounted']]);
  },
  timeline: (ctx: unknown) => {
    if (!isFixtureCtx(ctx)) return null;
    const stage = ctx.stage;
    if (stage === null) return null;
    const el = findFixtureElement(stage, FIXTURE_TARGET_ATTR);
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
    removeFixtureElement(ctx, FIXTURE_TARGET_ATTR);
  },
};
