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
import { placeholderScene } from './scenes/placeholder';

// PUL-Q002 / ADR-030: the browser-support fixture scene is registered
// alongside the placeholder so the PUL-Q002 CI gate can exercise a
// real GSAP timeline + present-mode completion + cleanup path.
//
// PUL-Q008 / ADR-005: the DOM/CSS accessibility fixture is registered
// the same way so the PUL-Q008 Playwright spec can boot it via
// `?scene=dom-css-accessibility-fixture`.
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
  ...PULSAR_INTRO_SCENES,
];

export const WORKBENCH_COMPOSITIONS: readonly CompositionRegistryEntry[] = [
  { id: DEFAULT_COMPOSITION_ID, manifest: defaultComposition },
  pulsarIntroCompositionEntry,
];
