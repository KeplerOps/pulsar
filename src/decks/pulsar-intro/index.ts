// Pulsar reference deck — public surface for workbench-graph.
//
// Side-effect imports here pull the deck's bespoke CSS and the variable
// fonts the deck depends on into the bundle. The workbench-graph
// re-exports the scenes + composition entry; the side effects ride
// along whenever this module is imported.

import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/source-serif-4';
import './styles.css';

export {
  PULSAR_INTRO_COMPOSITION_ID,
  pulsarIntroComposition,
  pulsarIntroCompositionEntry,
} from './composition';
export { PULSAR_INTRO_SCENES } from './content';
