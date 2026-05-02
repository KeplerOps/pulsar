# Scene Author

## Role

The human who designs scenes, arranges them into compositions, and
ships the result. May also be the Presenter at presentation time.

## Goals

- Author scene modules with intent, motion, audio, and captions.
- Arrange scenes into compositions (full talks, short cuts, trailers,
  standalone demos).
- Inspect work in progress at the scene/beat level without running
  the whole talk.
- Direct coding agents to make scoped scene changes.
- Ship a composition that runs reliably at presentation time.

## Constraints

- Single human directing one or more coding agents.
- Visual review must be fast; cannot tab through a long talk to
  inspect one scene change.
- Working knowledge of HTML/CSS/JS, not necessarily of every library
  the runtime composes.

## Touchpoints

- Scene module files.
- Scene registry.
- Composition manifests.
- Workbench URLs (all modes).
- Prompter view.
- Validation output.
- Ground Control records (requirements, ADRs) for context shared with
  agents.

## Out of scope

- Building or maintaining the runtime itself.
- General-purpose web app development.
- Multi-author workflows or shared editing.
