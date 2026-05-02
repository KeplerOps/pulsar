# Coding Agent — Use Cases

| UID | Title |
|-----|-------|
| UC-G1 | Discover scenes in the registry |
| UC-G2 | Read the scene contract |
| UC-G3 | Edit a scene |
| UC-G4 | Add a new scene |
| UC-G5 | Update a composition manifest |
| UC-G6 | Run validation |
| UC-G7 | Capture a screenshot for verification |
| UC-G8 | Report a change with a workbench URL |

## UC-G1: Discover scenes in the registry

Agent reads the registry and enumerates scene ids and metadata
(title, tags, duration, standalone/trailer flags).

## UC-G2: Read the scene contract

Agent reads `docs/requirements/conventions.md`, the scene contract,
and ADRs (ADR-002, ADR-008) to know what shape a scene must conform
to.

## UC-G3: Edit a scene

Agent modifies a scene's `create`, `timeline`, `captions`, or
`assets` to satisfy a scoped intent. Preserves cleanup invariants.

## UC-G4: Add a new scene

Agent creates a new scene module satisfying the scene contract and
registers it.

## UC-G5: Update a composition manifest

Agent adds, removes, or reorders scene ids in a composition. Does
not silently fork compositions.

## UC-G6: Run validation

Agent runs validation locally, observes errors (missing scenes,
dangling assets, duplicate ids, undeclared cleanup), and fixes them
before reporting.

## UC-G7: Capture a screenshot for verification

Agent loads a workbench URL with `mode=screenshot` and records the
output for visual comparison.

## UC-G8: Report a change with a workbench URL

Agent reports the change as a workbench URL the human can paste
directly into a browser.
