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
// names the scenes and compositions this specific application ships
// (codex review cycle 2, class finding).
//
// PUL-P002 requires the PUL-F028 validation pass to run against the
// repository's actual registered graph on every pull request. Codex
// preflight (`docs/design/pul-p002-validation-ci-preflight.md`) is
// explicit: there must be one place a scene or composition is
// declared. Inlining the literals in `main.ts` and the test would
// let a future scene slip into the registry path without being
// validated, leaving the gate looking active while running
// unvalidated inputs.
//
// Both exports carry the strict runtime types (`SceneModule`,
// `CompositionRegistryEntry`) so `createSceneRegistry` /
// `createCompositionRegistry` accept them directly. The validator
// (`validateRuntime`) widens them at its `Iterable<unknown>` /
// `ValidationCompositionInput` boundary internally — there is no
// caller-side cast and the type checker still rejects a malformed
// literal at compile time.

import { DEFAULT_COMPOSITION_ID, defaultComposition } from './compositions/default';
import { DEMO_COMPOSITION_ID, demoComposition } from './compositions/demo';
import type { CompositionRegistryEntry } from './runtime/composition-registry';
import type { SceneModule } from './runtime/scene';
import { browserSupportFixtureScene } from './scenes/browser-support-fixture';
import { demoFeatureScene } from './scenes/demo-feature';
import { demoOutroScene } from './scenes/demo-outro';
import { demoTitleScene } from './scenes/demo-title';
import { domCssAccessibilityFixtureScene } from './scenes/dom-css-accessibility-fixture';
import { placeholderScene } from './scenes/placeholder';

// PUL-Q002 / ADR-030: the browser-support fixture scene is registered
// alongside the placeholder so the PUL-Q002 CI gate can exercise a
// real GSAP timeline + present-mode completion + cleanup path. It is
// not part of the default composition — the gate addresses it
// directly via `?scene=browser-support-fixture` (see
// `tests-e2e/browser-support.spec.ts`).
//
// PUL-Q008 / ADR-005: the DOM/CSS accessibility fixture is registered
// the same way so the PUL-Q008 Playwright spec
// (`tests-e2e/dom-css-accessibility.spec.ts`) can boot it via
// `?scene=dom-css-accessibility-fixture`. It is not part of the
// default composition.
//
// Issue 98: the three authored demo scenes are registered together
// and arranged by the `demo` composition. Reachable at
// `?composition=demo` in the workbench; the e2e spec at
// `tests-e2e/demo-composition.spec.ts` boots them and verifies the
// declared static asset is actually served by the production build.
export const WORKBENCH_SCENES: readonly SceneModule[] = [
  placeholderScene,
  browserSupportFixtureScene,
  domCssAccessibilityFixtureScene,
  demoTitleScene,
  demoFeatureScene,
  demoOutroScene,
];

export const WORKBENCH_COMPOSITIONS: readonly CompositionRegistryEntry[] = [
  { id: DEFAULT_COMPOSITION_ID, manifest: defaultComposition },
  { id: DEMO_COMPOSITION_ID, manifest: demoComposition },
];
