L2 template/scene authoring now uses real `lib.dom` types. The
structural fake-DOM types (`TemplateDomElement` / `TemplateDomFactory`
/ `TemplateStageElement`) and the per-call defensive ctx narrowing
(`isTemplateCtx` / `isStageShape` / `isGsapShape`) are gone; templates
take `HTMLElement` / `Document` directly and read `ctx` through one
`asTemplateCtx` view that checks only the genuine off-DOM
(`stage === null`) path. Every `as unknown as HTMLElement|Document`
cast in templates and decks is removed. Decks reference a shared
`TemplateTimeline` type instead of re-declaring a structural timeline
subset. The deck-only templates `operatorDossier`, `incidentPlate`,
and `haulCitations` moved into `src/decks/local-calgary-v2/templates/`
(with their CSS) since no other deck uses them. DOM-touching template
tests opt into `happy-dom` per file and assert against real rendering;
the runtime fake-stage suites stay node-env and unchanged.
