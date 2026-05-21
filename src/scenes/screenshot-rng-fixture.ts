// PUL-F018 / ADR-021 — screenshot RNG verification fixture scene.
//
// PUL-F018: "In `mode=screenshot`, the runtime SHALL render the
// addressed scene at the addressed beat (or first frame if no beat)
// with all asset preloads resolved, no animation in progress, all
// audio suppressed, and any randomness sourced from a deterministic
// seed."
//
// The deterministic-seed axis is shipped: the loader derives a
// per-navigation seed from the addressed URL (`deriveNavigationSeed`
// in `src/runtime/scene-loader.ts`) and exposes a seeded generator on
// `WorkbenchSceneCtx.rng` (`createSeededRng` in `src/runtime/rng.ts`).
// What that implementation lacked was an *observable* screenshot-
// determinism signal in a real browser engine.
//
// This fixture gives screenshot mode a *randomness* observable:
//
//   1. `create(ctx)` draws a fixed number of values from `ctx.rng`,
//      formats each at fixed precision, joins them, and mounts a
//      `<div data-pulsar-screenshot-rng-target>` under the workbench
//      stage carrying the joined draws on `data-pulsar-screenshot-rng`.
//   2. The fixture declares no animation — `timeline(ctx)` returns
//      `null`. The determinism the requirement names is captured at
//      `create(ctx)`, before any timeline runs; a held timeline would
//      add nothing to observe.
//   3. `cleanup(ctx)` removes the fixture element entirely.
//
// The Playwright spec at `tests-e2e/screenshot-mode.spec.ts` boots
// this scene under `mode=screenshot`, reads `data-pulsar-screenshot-rng`,
// reloads the same URL, and asserts the attribute is byte-identical —
// proving the seeded generator replays the same sequence across
// reloads in a real browser engine. A second, structurally distinct
// URL produces a different attribute, proving the seed actually tracks
// the addressed target.
//
// The DOM mount/find/remove scaffolding is shared with the
// browser-support, loop, paused, and scrub fixtures via
// `./fixture-support.ts`. Reading `ctx.rng` is fixture-local: only
// this fixture consumes the RNG surface, so its narrowing stays here
// rather than widening the shared `FixtureCtx`. Scope intentionally
// narrow: no declared assets, no declared audio. The scene is
// `standalone: true` — it does not assume surrounding composition
// context. `trailerSafe: false` — it has nothing trailer-worthy to
// show.

import type { SceneModule } from '../runtime/scene';
import { mountFixtureElement, removeFixtureElement } from './fixture-support';

const FIXTURE_TARGET_ATTR = 'data-pulsar-screenshot-rng-target';
const FIXTURE_RNG_ATTR = 'data-pulsar-screenshot-rng';
// How many draws to project. More than one so the e2e spec compares a
// sequence — a regression that re-seeded per draw would still pass a
// single-value check.
const RNG_SAMPLE_COUNT = 8;
// Fixed decimal precision so the projected text is a stable, engine-
// independent rendering of the float (no locale or formatting drift).
const RNG_SAMPLE_PRECISION = 8;

/**
 * Draw {@link RNG_SAMPLE_COUNT} values from `ctx.rng` and render them
 * as a comma-separated, fixed-precision string. An off-contract ctx
 * with no callable `rng` yields the empty string rather than throwing
 * — the same defensive posture the shared fixture scaffolding takes
 * against malformed injected dependencies.
 */
const projectSeededDraws = (ctx: unknown): string => {
  if (typeof ctx !== 'object' || ctx === null) return '';
  const rng = (ctx as { rng?: unknown }).rng;
  if (typeof rng !== 'function') return '';
  const next = rng as () => number;
  return Array.from({ length: RNG_SAMPLE_COUNT }, () => next().toFixed(RNG_SAMPLE_PRECISION)).join(
    ',',
  );
};

export const screenshotRngFixtureScene: SceneModule = {
  id: 'screenshot-rng-fixture',
  title: 'Screenshot RNG verification fixture',
  duration: null,
  tags: ['fixture', 'screenshot'],
  assets: [],
  captions: [],
  audio: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  // `create(ctx)` captures the deterministic draws: under
  // `mode=screenshot` the seed is derived from the addressed URL, so
  // reloading the same URL projects an identical attribute.
  create: (ctx: unknown) => {
    mountFixtureElement(ctx, FIXTURE_TARGET_ATTR, [[FIXTURE_RNG_ATTR, projectSeededDraws(ctx)]]);
  },
  // No animation — the requirement's "no animation in progress" clause
  // is vacuously honored, and the determinism observable is already
  // projected by `create(ctx)`.
  timeline: () => null,
  cleanup: (ctx: unknown) => {
    removeFixtureElement(ctx, FIXTURE_TARGET_ATTR);
  },
};
