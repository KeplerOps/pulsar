// Pulsar reference deck — composition manifest.
//
// 15 scenes in order. Half the boundaries declare an inter-scene
// transition (cut / dissolve / hard-slam / hold-on-black / push) so
// the deck exercises every shipped transition shape at least once.

import type { CompositionManifest } from '../../runtime/composition';
import type { CompositionRegistryEntry } from '../../runtime/composition-registry';

export const PULSAR_INTRO_COMPOSITION_ID = 'pulsar-intro';

export const pulsarIntroComposition: CompositionManifest = [
  'pi-title',
  { id: 'pi-opener', behavior: { transition: { name: 'cut' } } },
  { id: 'pi-act-i', behavior: { transition: { name: 'hold-on-black', durationMs: 1100 } } },
  { id: 'pi-stat-bespoke', behavior: { transition: { name: 'dissolve' } } },
  { id: 'pi-bullets-pain', behavior: { transition: { name: 'dissolve' } } },
  { id: 'pi-act-ii', behavior: { transition: { name: 'hold-on-black', durationMs: 1100 } } },
  { id: 'pi-quote-thesis', behavior: { transition: { name: 'dissolve' } } },
  { id: 'pi-defs-layers', behavior: { transition: { name: 'push' } } },
  { id: 'pi-grid-templates', behavior: { transition: { name: 'dissolve' } } },
  { id: 'pi-outline-iii', behavior: { transition: { name: 'hard-slam' } } },
  { id: 'pi-stats-savings', behavior: { transition: { name: 'dissolve' } } },
  { id: 'pi-grid-stats', behavior: { transition: { name: 'push' } } },
  { id: 'pi-compare', behavior: { transition: { name: 'dissolve' } } },
  { id: 'pi-stack-design', behavior: { transition: { name: 'dissolve' } } },
  { id: 'pi-ticker-uptime', behavior: { transition: { name: 'dissolve' } } },
  { id: 'pi-centerpiece', behavior: { transition: { name: 'hold-on-black' } } },
  { id: 'pi-outro', behavior: { transition: { name: 'dissolve' } } },
];

export const pulsarIntroCompositionEntry: CompositionRegistryEntry = {
  id: PULSAR_INTRO_COMPOSITION_ID,
  manifest: pulsarIntroComposition,
};
