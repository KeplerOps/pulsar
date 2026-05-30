// ACES ecosystem intro composition.
//
// The manifest is the canonical sequence the workbench plays for
// `?composition=aces-ecosystem-intro`. Transitions are restricted to
// `cut` (between consecutive content scenes within a section) and
// `dissolve` (into a section title or appendix). The briefing register
// avoids slams, flashes, holds-on-black, and directional pushes.

import type { CompositionManifest } from '../../runtime/composition';
import type { CompositionRegistryEntry } from '../../runtime/composition-registry';

export const ACES_ECOSYSTEM_INTRO_COMPOSITION_ID = 'aces-ecosystem-intro';

const cut = (id: string) => ({
  id,
  behavior: { transition: { name: 'cut' } },
});

const dissolve = (id: string, durationMs?: number) => ({
  id,
  behavior: {
    transition: {
      name: 'dissolve',
      ...(durationMs === undefined ? {} : { durationMs }),
    },
  },
});

export const acesEcosystemIntroComposition: CompositionManifest = [
  'aces-cover',
  dissolve('aces-non-claim'),
  dissolve('aces-toc'),

  dissolve('aces-1', 700),
  cut('aces-1-instrument-problem'),
  cut('aces-1-rqs'),
  cut('aces-1-corpus'),

  dissolve('aces-2', 700),
  cut('aces-2-definition'),
  cut('aces-2-sdl-doc'),
  cut('aces-2-separates'),
  cut('aces-2-not'),
  cut('aces-2-deferred'),

  dissolve('aces-3', 700),
  cut('aces-3-layout'),
  cut('aces-3-authority'),
  cut('aces-3-identifiers'),

  dissolve('aces-4', 700),
  cut('aces-4-contracts'),
  cut('aces-4-conformance'),
  cut('aces-4-gate'),

  dissolve('aces-5', 700),
  cut('aces-5-reads'),

  dissolve('aces-refs'),
];

export const acesEcosystemIntroCompositionEntry: CompositionRegistryEntry = {
  id: ACES_ECOSYSTEM_INTRO_COMPOSITION_ID,
  manifest: acesEcosystemIntroComposition,
};
