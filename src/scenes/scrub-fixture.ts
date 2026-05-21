// PUL-F017 / ADR-020 — scrub verification fixture scene.
//
// PUL-F017: "In `mode=scrub`, the runtime SHALL display timeline
// controls allowing the user to scrub forward, backward, and to named
// beats. Audio cues SHALL fire only on monotonic forward playback."
//
// The scrub run mode and cue gating are shipped — `positionMaster()` in
// `src/runtime/timeline.ts` leaves the master held and live under
// `headCueGate`, and the GSAP adapter toggles the audio cue gate by
// playhead direction. The workbench scrub controls
// (`src/system/chrome/scrub.ts`) drive that master. What those
// implementations lacked was an *observable* scrub-acceptance signal in
// a real browser engine.
//
// This fixture gives scrub mode a *progress* observable plus a *named
// beat* so the transport controls have something to scrub and a beat
// affordance to render:
//
//   1. `create(ctx)` mounts a `<div data-pulsar-scrub-target>` under
//      the workbench stage, with `data-pulsar-scrub-progress` starting
//      at `"0"` (mounted, held at frame 0).
//   2. `timeline(ctx)` returns a GSAP timeline whose single tween moves
//      a numeric `progress` object from `0` to `100`; its `onUpdate`
//      callback writes `Math.round(progress.value)` onto the same
//      element's `data-pulsar-scrub-progress`. The timeline carries a
//      kebab-case label `midpoint`, so `MasterTimeline.beats()` exposes
//      one named beat and the scrub controls render one jump button.
//      Under `mode=scrub` the master is held (PUL-F017 / ADR-020), so
//      the attribute stays `"0"` until the user presses play; reverse
//      playback walks it back down.
//   3. `cleanup(ctx)` removes the fixture element entirely.
//
// The Playwright spec at `tests-e2e/scrub-mode.spec.ts` boots this
// scene under `mode=scrub`, asserts the scrub controls surface appears,
// drives play / reverse / beat-jump, and watches
// `data-pulsar-scrub-progress` respond — proving the controls drive a
// real GSAP master in a real browser engine.
//
// The `progress` object is a closure local to `timeline(ctx)`: the
// resolver calls `timeline(ctx)` once per navigation, so a fresh
// navigation starts a fresh tween from `0`.
//
// The ctx validation and DOM mount/find/remove scaffolding is shared
// with the browser-support, loop, and paused fixtures via
// `./fixture-support.ts`. Scope intentionally narrow: no declared
// assets, no declared audio. The scene is `standalone: true` — it does
// not assume surrounding composition context. `trailerSafe: false` —
// it has nothing trailer-worthy to show.

import type { SceneModule } from '../runtime/scene';
import {
  findFixtureElement,
  isFixtureCtx,
  mountFixtureElement,
  removeFixtureElement,
} from './fixture-support';

const FIXTURE_TARGET_ATTR = 'data-pulsar-scrub-target';
const FIXTURE_PROGRESS_ATTR = 'data-pulsar-scrub-progress';
const FIXTURE_DURATION_SECONDS = 0.6;

export const scrubFixtureScene: SceneModule = {
  id: 'scrub-fixture',
  title: 'Scrub verification fixture',
  duration: null,
  tags: ['fixture', 'scrub'],
  assets: [],
  captions: [],
  audio: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  // The element starts at progress 0 — "mounted, held at first frame" —
  // so a Playwright poll can distinguish a held master from one the
  // scrub controls have started advancing.
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
    // `data-pulsar-scrub-progress`. Under `mode=scrub` the master is
    // held (PUL-F017 / ADR-020), so the attribute stays `"0"` until the
    // scrub controls play it forward — and walks back down under
    // reverse playback. A linear ease keeps the projected value a
    // faithful read of how far the timeline progressed. The `midpoint`
    // label is a kebab-case beat (ADR-026), so the scrub controls
    // render exactly one named-beat jump button.
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
    tl.addLabel('midpoint', FIXTURE_DURATION_SECONDS / 2);
    return tl;
  },
  cleanup: (ctx: unknown) => {
    removeFixtureElement(ctx, FIXTURE_TARGET_ATTR);
  },
};
