# Coding Agent — User Stories

## UC-G1: Discover scenes in the registry

- As a Coding Agent, I list registered scenes and their metadata so
  that I can target the correct one.

## UC-G2: Read the scene contract

- As a Coding Agent, I read the scene contract specification so that
  my edits conform to it.

## UC-G3: Edit a scene

- As a Coding Agent, I modify a scene's `create`/`timeline`/`captions`
  while preserving `cleanup` so that no resource leaks.
- As a Coding Agent, I avoid touching unrelated scenes so that scoped
  changes stay scoped.

## UC-G4: Add a new scene

- As a Coding Agent, I add a scene module that satisfies the contract
  and register it so that it is addressable by URL.

## UC-G5: Update a composition manifest

- As a Coding Agent, I update a composition manifest so that the new
  scene is included where requested.

## UC-G6: Run validation

- As a Coding Agent, I run validation and observe actionable errors
  so that I fix them before reporting completion.

## UC-G7: Capture a screenshot for verification

- As a Coding Agent, I load `mode=screenshot` for the affected scene
  so that visual output is captured deterministically.

## UC-G8: Report a change with a workbench URL

- As a Coding Agent, I report a workbench URL targeting the changed
  scene so that the human can inspect the change without manual
  navigation.
