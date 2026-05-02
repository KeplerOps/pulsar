# Scene Author — Use Cases

| UID | Title |
|-----|-------|
| UC-A1 | Bootstrap a new scene |
| UC-A2 | Iterate on scene visuals and timing |
| UC-A3 | Add or edit a composition |
| UC-A4 | Tune a labeled beat inside a scene |
| UC-A5 | Author captions and prompter content |
| UC-A6 | Manage scene assets |
| UC-A7 | Review changes across multiple scenes |
| UC-A8 | Prepare and run a composition for presentation |

## UC-A1: Bootstrap a new scene

Author creates a new scene module satisfying the scene contract.
Registers it. Adds to a composition or runs standalone.

## UC-A2: Iterate on scene visuals and timing

Author edits a scene's `create` and `timeline`, reloads the workbench
in `paused` or `loop` mode, and adjusts until the scene matches
intent.

## UC-A3: Add or edit a composition

Author adds a scene id to an existing composition manifest, or
creates a new manifest (full talk, short cut, trailer). Verifies
ordering by loading the composition.

## UC-A4: Tune a labeled beat inside a scene

Author addresses a labeled beat via `?scene=...&beat=...` and adjusts
timing, motion, or content for that beat.

## UC-A5: Author captions and prompter content

Author edits the scene's `captions` metadata and verifies via
`mode=prompter`.

## UC-A6: Manage scene assets

Author updates a scene's declared assets list. Verifies preloading
and runtime behavior; replaces or removes obsolete assets.

## UC-A7: Review changes across multiple scenes

Author opens each modified scene in `mode=screenshot` to verify
visual diffs.

## UC-A8: Prepare and run a composition for presentation

Author runs the composition end to end in `mode=present` to verify
audio, transitions, and presenter controls.
