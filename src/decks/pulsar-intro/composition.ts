// Pulsar reference deck composition.
//
// The manifest is the canonical sequence the workbench plays for
// `?composition=pulsar-intro`. Transitions are declared per-entry by
// the composition; scenes carry no successor knowledge.

import type { CompositionManifest } from '../../runtime/composition';
import type { CompositionRegistryEntry } from '../../runtime/composition-registry';

export const PULSAR_INTRO_COMPOSITION_ID = 'pulsar-intro';

const transition = (id: string, name: string, durationMs?: number) => ({
  id,
  behavior: {
    transition: {
      name,
      ...(durationMs === undefined ? {} : { durationMs }),
    },
  },
});

export const pulsarIntroComposition: CompositionManifest = [
  'pi-title',
  transition('pi-thesis', 'dissolve'),
  transition('pi-scene', 'hold-on-black', 900),
  transition('pi-composition', 'dissolve'),
  transition('pi-recompose', 'dissolve'),
  transition('pi-modes', 'hold-on-black', 900),
  transition('pi-url', 'dissolve'),
  transition('pi-transport', 'dissolve'),
  transition('pi-layers', 'hold-on-black', 900),
  transition('pi-author', 'dissolve'),
  transition('pi-self', 'hold-on-black', 900),
  transition('pi-outro', 'dissolve'),
];

export const pulsarIntroCompositionEntry: CompositionRegistryEntry = {
  id: PULSAR_INTRO_COMPOSITION_ID,
  manifest: pulsarIntroComposition,
};
