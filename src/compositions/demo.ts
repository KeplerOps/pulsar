// Issue 98 — vertical-slice demo composition.
//
// A static three-scene manifest that arranges the demo scenes into a
// composition reachable at `?composition=demo` in the workbench. The
// manifest is a plain `readonly` array of bare scene-id strings so the
// PUL-A005 declarative-composition source-policy gate continues to
// classify it as declarative, the same way it classifies
// `defaultComposition` in `./default.ts`.
//
// Per the codex preflight at
// `docs/design/issue-098-vertical-slice-demo-preflight.md`: future
// variants (a short cut, a trailer, an alternate ordering) are a new
// manifest under `src/compositions/`, not a runtime change or a
// scene-side flag.

import type { CompositionManifest } from '../runtime/composition';

export const DEMO_COMPOSITION_ID = 'demo';

export const demoComposition: CompositionManifest = ['demo-title', 'demo-feature', 'demo-outro'];
