// Pulsar L2 templates — public surface.
//
// Factory functions that turn a content object into a SceneModule
// the runtime can mount. Each template takes `(id, content)` and
// returns a SceneModule with a unique id, captions auto-derived from
// content, and the canonical timeline activation envelope.

export { actHeader } from './act-header';
export type { ActHeaderContent } from './act-header';

export { activityFeedPayoff } from './activity-feed-payoff';
export type {
  ActivityEntry,
  ActivityFeedPayoffContent,
  PayoffRow,
} from './activity-feed-payoff';

export { bulletList } from './bullet-list';
export type { BulletListContent } from './bullet-list';

export { cardCarousel } from './card-carousel';
export type { CardCarouselContent, CarouselCard } from './card-carousel';

export { centerpiece } from './centerpiece';
export type { CenterpieceContent } from './centerpiece';

export { chatPickList } from './chat-pick-list';
export type { ChatPickListContent, PickItem } from './chat-pick-list';

export { chatTranscript } from './chat-transcript';
export type { ChatDoc, ChatMessage, ChatTranscriptContent } from './chat-transcript';

export { compare } from './compare';
export type { CompareContent } from './compare';

export { definitionTable } from './definition-table';
export type { DefinitionRow, DefinitionTableContent } from './definition-table';

export { dropList } from './drop-list';
export type { DropItem, DropListContent } from './drop-list';

export { haulCitations } from './haul-citations';
export type { CitationRow, HaulCitationsContent, HaulRow } from './haul-citations';

export { incidentPlate } from './incident-plate';
export type { IncidentPlateContent } from './incident-plate';

export { introGrid } from './intro-grid';
export type { IntroGridContent, IntroRole } from './intro-grid';

export { metricTicker } from './metric-ticker';
export type { MetricSpec, MetricTickerContent } from './metric-ticker';

export { operatorDossier } from './operator-dossier';
export type { DossierRow, OperatorDossierContent } from './operator-dossier';

export { outlineTitle } from './outline-title';
export type { OutlineTitleContent } from './outline-title';

export { outro } from './outro';
export type { OutroContent } from './outro';

export { placard } from './placard';
export type { PlacardContent } from './placard';

export { presenterDrivenScene } from './presenter-driven';
export type { PresenterDrivenContent, PresenterDrivenCtx } from './presenter-driven';

export { quote } from './quote';
export type { QuoteContent } from './quote';

export { quoteStack } from './quote-stack';
export type { QuoteStackContent, QuoteStackItem } from './quote-stack';

export { screenshotCallouts } from './screenshot-callouts';
export type { CalloutSpec, ScreenshotCalloutsContent } from './screenshot-callouts';

export { splitDialogueEmail } from './split-dialogue-email';
export type {
  DialogueLine,
  EmailSpec,
  SplitDialogueEmailContent,
} from './split-dialogue-email';

export { splitPaneTerminalDoc } from './split-pane-terminal-doc';
export type {
  SplitDocSpec,
  SplitPaneTerminalDocContent,
  SplitTerminalLine,
} from './split-pane-terminal-doc';

export { statBig } from './stat-big';
export type { StatBigContent } from './stat-big';

export { statPairGrid } from './stat-pair-grid';
export type { StatPair, StatPairGridContent } from './stat-pair-grid';

export { statRow } from './stat-row';
export type { StatRowContent, StatRowEntry } from './stat-row';

export { terminal } from './terminal';
export type { TerminalContent, TerminalStep } from './terminal';

export { titleSlam } from './title-slam';
export type { TitleSlamContent } from './title-slam';

// Shared envelope re-exports (templates use these; decks rarely do).
export {
  buildTemplateScene,
  buildTemplateTimeline,
  cleanupTemplateRoot,
  findTemplateRoot,
  isTemplateCtx,
  mountTemplateRoot,
  setTemplateActive,
  TEMPLATE_ROOT_ATTR,
} from './_shared';
export type {
  BuildTemplateSceneHost,
  BuildTemplateTimelineHost,
  MountTemplateRootHost,
  TemplateCtx,
  TemplateDomElement,
  TemplateDomFactory,
  TemplateStageElement,
} from './_shared';
