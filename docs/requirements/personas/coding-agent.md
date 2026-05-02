# Coding Agent

## Role

LLM-based agent making scoped scene edits within a session under
direction from the Scene Author.

## Goals

- Read the scene contract and existing scenes accurately enough to
  make correct, scoped edits.
- Add new scenes to the registry and to compositions without breaking
  existing scenes.
- Verify changes via deterministic workbench URLs (especially
  `mode=screenshot`) without driving a GUI.
- Report each change with a URL the human can paste directly.
- Run validation and surface failures.

## Constraints

- No persistent memory across sessions.
- Cannot drive a GUI; relies on stable file structure, naming, URL
  contract, and CLI/MCP outputs.
- Bound to small, well-scoped changes; large refactors require
  human-in-the-loop deliberation.

## Touchpoints

- Scene module files and registry.
- Composition manifests.
- Validation surface.
- Workbench URLs.
- Ground Control records (requirements, ADRs) for context.

## Out of scope

- Authorial intent (set by the Scene Author).
- Merging PRs.
- Operating the live runtime at presentation time.
