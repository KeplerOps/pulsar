// Default composition — the workbench's bootstrap manifest.
//
// Pulsar's URL navigation (PUL-F008) routes `?composition=<id>` and
// `?composition=<id>&scene=<id>` through the composition registry.
// The default composition gives the registry a single entry so
// `?composition=default` resolves until requirement-driven
// compositions (full talk, short cut, trailer) land in
// `src/compositions/`.
//
// The composition references the placeholder scene from
// `src/scenes/placeholder.ts`; both the scene id and the composition
// id are kebab-case per ADR-008 #1.

import type { CompositionManifest } from '../runtime/composition';

export const DEFAULT_COMPOSITION_ID = 'default';

export const defaultComposition: CompositionManifest = ['placeholder'];
