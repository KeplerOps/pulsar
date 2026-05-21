// Canonical workbench graph — single source for the scene and
// composition declarations the browser bootstrap (`src/main.ts`)
// AND the CI validation gate (`tests/runtime/workbench-graph.test.ts`)
// consume.
//
// This module lives at the application-composition-root level (next
// to `main.ts`), not inside `src/runtime/`. The runtime layer is the
// reusable engine — registries, validator, loader, navigation, audio,
// timeline — and must not import concrete scene or composition
// declarations from `src/scenes/` or `src/compositions/`. Putting the
// graph here keeps that boundary intact: the runtime stays
// app-agnostic; the workbench-graph module is the one place that
// names the scenes and compositions this specific application ships.

import { DEFAULT_COMPOSITION_ID, defaultComposition } from './compositions/default';
import { PULSAR_INTRO_SCENES, pulsarIntroCompositionEntry } from './decks/pulsar-intro';
import type { CompositionRegistryEntry } from './runtime/composition-registry';
import type { SceneModule } from './runtime/scene';
import { browserSupportFixtureScene } from './scenes/browser-support-fixture';
import { domCssAccessibilityFixtureScene } from './scenes/dom-css-accessibility-fixture';
import { loopFixtureScene } from './scenes/loop-fixture';
import { pausedFixtureScene } from './scenes/paused-fixture';
import { placeholderScene } from './scenes/placeholder';

// Optional local decks live under `src/decks/local-*/index.ts` and
// are gitignored — never enter the public repo, but auto-register at
// build time so `?composition=<id>` resolves them locally. Each module
// must export `scenes: SceneModule[]` and `composition:
// CompositionRegistryEntry`. Missing files are silently skipped.
interface LocalDeckModule {
  readonly scenes: readonly SceneModule[];
  readonly composition: CompositionRegistryEntry;
}
const LOCAL_DECK_MODULES = import.meta.glob<LocalDeckModule>('./decks/local-*/index.ts', {
  eager: true,
});
const LOCAL_SCENES: readonly SceneModule[] = Object.values(LOCAL_DECK_MODULES).flatMap(
  (m) => m.scenes,
);
const LOCAL_COMPOSITIONS: readonly CompositionRegistryEntry[] = Object.values(
  LOCAL_DECK_MODULES,
).map((m) => m.composition);

// PUL-Q002 / ADR-030: the browser-support fixture scene is registered
// alongside the placeholder so the PUL-Q002 CI gate can exercise a
// real GSAP timeline + present-mode completion + cleanup path.
//
// PUL-Q008 / ADR-005: the DOM/CSS accessibility fixture is registered
// the same way so the PUL-Q008 Playwright spec can boot it via
// `?scene=dom-css-accessibility-fixture`.
//
// PUL-F015 / ADR-018: the loop verification fixture is registered the
// same way so the loop-mode Playwright spec can boot it via
// `?scene=loop-fixture&mode=loop` and observe the master timeline
// genuinely restarting on completion (a strictly increasing
// `data-pulsar-loop-iteration` attribute).
//
// PUL-F016 / ADR-019: the paused verification fixture is registered the
// same way so the paused-mode Playwright spec can boot it via
// `?scene=paused-fixture&mode=paused` and observe the master timeline
// genuinely holding at its first frame (a `data-pulsar-paused-progress`
// attribute pinned at `"0"`).
//
// Pulsar L2: the pulsar-intro reference deck (`?composition=pulsar-intro`)
// is the self-referential proof of the L2 system layer. Its 15 scenes
// collectively exercise every shipped template, every transition, every
// chrome treatment, and every presenter key. Authoring a new scene in
// the deck is a single template-factory call in
// `src/decks/pulsar-intro/content.ts`.
export const WORKBENCH_SCENES: readonly SceneModule[] = [
  placeholderScene,
  browserSupportFixtureScene,
  domCssAccessibilityFixtureScene,
  loopFixtureScene,
  pausedFixtureScene,
  ...PULSAR_INTRO_SCENES,
  ...LOCAL_SCENES,
];

export const WORKBENCH_COMPOSITIONS: readonly CompositionRegistryEntry[] = [
  { id: DEFAULT_COMPOSITION_ID, manifest: defaultComposition },
  pulsarIntroCompositionEntry,
  ...LOCAL_COMPOSITIONS,
];
