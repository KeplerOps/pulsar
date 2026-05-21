// PUL-F016 / ADR-019 — paused verification fixture scene.
//
// PUL-F016: "In `mode=paused`, the runtime SHALL mount the addressed
// scene and hold it at its first frame without advancing the
// timeline." The hold mechanic is shipped — `positionMaster()` in
// `src/runtime/timeline.ts` handles `headHold === 'first-frame'` by
// `master.seek(0)` + `master.pause()` and never advances the master.
// What that implementation lacked was an *observable* paused-acceptance
// signal.
//
// The browser-support fixture (`./browser-support-fixture.ts`) advances
// a sticky `data-pulsar-fixture-state` from `"mounted"` to `"ran"` at
// the end of its timeline. Under `mode=paused` it would simply never
// reach `"ran"` — but a runner that skipped `timeline(ctx)` entirely
// would be indistinguishable from one that built the timeline and held
// it at frame 0.
//
// This fixture gives paused mode a *progress* observable:
//
//   1. `create(ctx)` mounts a `<div data-pulsar-paused-target>` under
//      the workbench stage, with `data-pulsar-paused-progress` starting
//      at `"0"` (mounted, first frame).
//   2. `timeline(ctx)` returns a GSAP timeline whose single tween moves
//      a numeric `progress` object from `0` to `100`. Its `onUpdate`
//      callback writes `Math.round(progress.value)` onto the same
//      element's `data-pulsar-paused-progress`. Under a held master the
//      tween value stays at `0`, so the attribute stays `"0"`; under a
//      playing master the attribute climbs toward `"100"`.
//   3. `cleanup(ctx)` removes the fixture element entirely.
//
// The Playwright spec at `tests-e2e/paused-mode.spec.ts` boots this
// scene under `mode=paused` and asserts `data-pulsar-paused-progress`
// holds at `"0"` past the tween's natural duration — proving the GSAP
// master genuinely held the timeline at its first frame in a real
// browser engine — and, as a control, boots it under `mode=loop` to
// confirm the same tween does climb when the master is allowed to run.
//
// The `progress` object is a closure local to `timeline(ctx)`: the
// resolver calls `timeline(ctx)` once per navigation, so a fresh
// navigation starts a fresh tween from `0`.
//
// The ctx validation and DOM mount/find/remove scaffolding is shared
// with the browser-support and loop fixtures via `./fixture-support.ts`.
// Scope intentionally narrow: no declared assets, no declared audio.
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

const FIXTURE_TARGET_ATTR = 'data-pulsar-paused-target';
const FIXTURE_PROGRESS_ATTR = 'data-pulsar-paused-progress';
const FIXTURE_DURATION_SECONDS = 0.1;

export const pausedFixtureScene: SceneModule = {
  id: 'paused-fixture',
  title: 'Paused verification fixture',
  duration: null,
  tags: ['fixture', 'paused'],
  assets: [],
  captions: [],
  audio: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  // The element starts at progress 0 — "mounted, held at first frame" —
  // so a Playwright poll can distinguish a held master from one that
  // advanced the timeline.
  create: (ctx: unknown) => {
    mountFixtureElement(ctx, FIXTURE_TARGET_ATTR, [[FIXTURE_PROGRESS_ATTR, '0']]);
  },
  timeline: (ctx: unknown) => {
    if (!isFixtureCtx(ctx)) return null;
    const stage = ctx.stage;
    if (stage === null) return null;
    const el = findFixtureElement(stage, FIXTURE_TARGET_ATTR);
    if (el === null) return null;
    // Build a real GSAP timeline through `ctx.gsap`. The single tween
    // would move `progress.value` from 0 to 100 over the fixture
    // duration; `onUpdate` projects the current value onto
    // `data-pulsar-paused-progress`. Under `mode=paused` the master is
    // `seek(0)` + `pause()` (PUL-F016 / ADR-019), so the tween never
    // advances and the attribute stays `"0"` — the observable the
    // paused-mode e2e spec asserts. A linear ease keeps the projected
    // value a faithful read of how far the timeline progressed.
    const progress = { value: 0 };
    const tl = ctx.gsap.timeline();
    tl.to(progress, {
      value: 100,
      duration: FIXTURE_DURATION_SECONDS,
      ease: 'none',
      onUpdate: () => {
        el.setAttribute(FIXTURE_PROGRESS_ATTR, String(Math.round(progress.value)));
      },
    });
    return tl;
  },
  cleanup: (ctx: unknown) => {
    removeFixtureElement(ctx, FIXTURE_TARGET_ATTR);
  },
};
