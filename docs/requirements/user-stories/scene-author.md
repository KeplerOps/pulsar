# Scene Author — User Stories

## UC-A1: Bootstrap a new scene

- As a Scene Author, I create a scene module that satisfies the scene
  contract so that no required field is missing.
- As a Scene Author, I register the new scene in the registry so that
  it is addressable by URL.

## UC-A2: Iterate on scene visuals and timing

- As a Scene Author, I load a scene in `mode=paused` so that I can
  inspect the first frame without motion.
- As a Scene Author, I load a scene in `mode=loop` so that I can tune
  motion and audio repeatedly.
- As a Scene Author, I load a scene in `mode=scrub` so that I can
  step through the timeline beat by beat.

## UC-A3: Add or edit a composition

- As a Scene Author, I add a scene id to a composition manifest so
  that the composition includes it in order.
- As a Scene Author, I create a new composition manifest so that I
  ship a different cut.

## UC-A4: Tune a labeled beat inside a scene

- As a Scene Author, I jump to a labeled beat via URL so that I
  avoid replaying earlier beats.

## UC-A5: Author captions and prompter content

- As a Scene Author, I edit a scene's captions metadata so that the
  prompter view reflects updated content.
- As a Scene Author, I verify captions via `mode=prompter` so that
  prompter content is correct before presentation.

## UC-A6: Manage scene assets

- As a Scene Author, I declare a scene's assets in metadata so that
  the runtime preloads them before the scene mounts.
- As a Scene Author, I see a missing-asset error so that I notice
  before presentation.

## UC-A7: Review changes across multiple scenes

- As a Scene Author, I open each modified scene in `mode=screenshot`
  so that I confirm visual changes are intentional.

## UC-A8: Prepare and run a composition for presentation

- As a Scene Author, I run the composition end to end in
  `mode=present` so that I rehearse the full flow.
- As a Scene Author, I run the composition in rehearsal mode so that
  audio is silenced or logged.
