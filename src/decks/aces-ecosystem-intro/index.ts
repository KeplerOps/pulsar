// ACES ecosystem intro deck — public surface for workbench-graph.
//
// Side-effect imports pull this deck's bespoke CSS and the variable
// fonts the briefing register depends on into the bundle. The
// workbench-graph re-exports the scenes + composition entry; the side
// effects ride along whenever this module is imported.

import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/source-serif-4';
import './styles.css';

export {
  ACES_ECOSYSTEM_INTRO_COMPOSITION_ID,
  acesEcosystemIntroComposition,
  acesEcosystemIntroCompositionEntry,
} from './composition';
export { ACES_ECOSYSTEM_INTRO_SCENES } from './content';
