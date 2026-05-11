# ADR-007: Browser as the Default Workbench and Agent Collaboration Surface

## Status

Accepted

## Date

2026-04-30

## Context

Pulsar has two related but distinct jobs:

1. **Live presentation.** A presenter drives the runtime through a
   composition end-to-end, with audio, motion, prompter, and presenter
   controls.
2. **Authoring iteration.** A coding agent edits a specific scene (or
   beat inside a scene), and a human inspects the exact target without
   advancing through the whole talk.

Most presentation runtimes treat job (2) as a debug convenience —
something you do by reloading the deck and tabbing forward. That is too
slow when the authoring loop is *agent edits → human reviews → repeat*
many times per minute. The browser is already the easiest shared
display target for human/agent collaboration; the runtime should make
that loop a first-class supported workflow rather than an afterthought.

Concretely, the iteration loop wants:

- A stable, predictable URL grammar that targets any scene, beat, or
  composition position.
- Inspection modes that aren't just "play": looping for visual/audio
  tuning, paused-at-first-frame for layout review, scrub-with-controls
  for timeline debugging, deterministic screenshot mode for visual
  regression checks, and a prompter view for caption review.
- A standalone mode so a single scene can be exercised without the
  surrounding talk's chrome, audio bed, or transitions interfering.
- A contract a coding agent can rely on: "I changed scene X, you can
  inspect it at this URL," without the agent having to know how to
  drive the presenter UI.

URL parameters and mode flags are a small surface, but they need to be
specified up front. Otherwise modes get bolted on per scene, agents
build their own ad-hoc URL conventions, and screenshot regression has
to fight nondeterminism it could have avoided.

## Decision

The browser is Pulsar's **default workbench** and a **first-class
runtime feature**, not a debug convenience.

### URL grammar

The runtime accepts the following URL parameters (defined in
[ADR-002](002-scene-registry-and-compositions.md)):

- `scene=<scene-id>` — target a specific scene.
- `composition=<composition-id>` — target a composition.
- `index=<n>` — positional index inside a composition.
- `beat=<label>` — labeled point inside the target scene's timeline
  (see [ADR-003](003-gsap-timeline-engine.md)).
- `mode=<workbench-mode>` — one of the modes below.

URLs are stable: a given URL produces the same target state across
reloads, across machines, and (for screenshot mode) the same rendered
output frame for the same code revision.

### Workbench modes

The runtime supports the following modes:

| Mode | Purpose |
|------|---------|
| `present` | Default. Normal presenter-controlled runtime — full chrome, audio, transitions, presenter input. |
| `standalone` | Single scene, no surrounding talk flow. Chrome and inter-scene transitions suppressed; scene runs as if on its own page. |
| `loop` | Scene repeats indefinitely. For visual/audio tuning. |
| `paused` | Scene mounts at first frame and waits. For layout and styling review without motion. |
| `scrub` | Timeline controls are visible. For inspecting timing, easing, and beat alignment. |
| `screenshot` | Deterministic state, fixed seed for any randomness, no animation. For visual regression checks and exported stills. |
| `prompter` | Script/caption view for the selected scene or composition, regardless of visual rendering. |
| `rehearsal` | Author rehearsal — audio is silenced or logged as cues (PUL-F026 / ADR-004's `AudioOutputPolicy: 'log-cues'`). Timeline state, master timeline, and composition slice are unchanged from the equivalent non-rehearsal navigation. |

Modes are explicit, addressable, and orthogonal to navigation: any
scene + beat target works in any mode that makes sense for that target.

### Agent contract

Coding agents can rely on the URL grammar and modes as a stable
contract. A change to scene `scene-c` is reportable as
`?scene=scene-c&mode=standalone`, and the human can paste that URL
directly. Screenshot regression and visual checks can run against a
list of `mode=screenshot` URLs without the agent driving any
presenter UI.

### Implementation expectations

- The runtime parses URL parameters at startup and on `popstate`.
- The URL is the only source of workbench mode selection. When
  `mode` is absent, the runtime selects the effective mode `present`;
  it must not recover mode from localStorage, sessionStorage, cookies,
  `history.state`, or prior in-memory navigation state.
- Mode is dispatched in the runtime core, not per scene. Scenes do not
  know which mode they are running in unless they need to (e.g.
  audio-suppressing when `mode=screenshot`).
- The runtime exposes mode hints to scenes via `ctx.mode` so a scene
  can suppress autoplay audio in `screenshot` mode or extend itself
  in `loop` mode without re-implementing mode detection.
- Cleanup contracts are unchanged: `cleanup(ctx)` runs on every scene
  exit, in every mode.

## Consequences

### Positive

- Authoring iteration is fast: paste a URL, see the target.
- Coding agents have a stable contract to report changes against.
- Screenshot-based visual regression is straightforward: a list of
  `mode=screenshot` URLs, one per scene or beat.
- Prompter and standalone reviews don't compete with each other or
  with `present` — they live as separate addressable modes.
- Loop and paused modes let scene authors tune motion and layout
  without scripting a custom harness per scene.

### Negative

- More URL surface to maintain and document.
- Mode-specific code paths in the runtime core (and a few scenes) add
  test surface; the runtime must verify each mode behaves as specified.
- Modes and presenter behavior can drift if `present` is treated as the
  only "real" mode and the others are allowed to rot.

### Risks

| Risk | Mitigation |
|------|-----------|
| Modes accumulate scene-specific overrides until they aren't really modes | Hold the line: mode behavior is defined in the runtime core, not in individual scenes. Scene-specific behavior is rare and explicitly justified. |
| `screenshot` mode is non-deterministic in subtle ways (fonts, async asset load, RNG) | Provide deterministic seeding and a preflight that resolves all promised assets before "ready"; the runtime's screenshot mode treats nondeterminism as a runtime bug, not an acceptance of reality. |
| Agent reports URLs that depend on local state | URL parameters fully determine the targeted state; do not store inspection targets in localStorage or cookies. |
| A previous non-`present` mode leaks into a URL without `mode` | Treat omitted `mode` as a fresh `present` selection on every startup and `popstate`; do not cache the last effective mode. |
| Modes drift apart visually because each is touched independently | Audit each mode against `present` for the same target periodically; modes that diverge intentionally must say so in this ADR or its successor. |

## Related ADRs

- [ADR-001](001-custom-experience-runtime.md) — the workbench is part of
  what the custom runtime owns.
- [ADR-002](002-scene-registry-and-compositions.md) — defines the URL
  grammar that workbench modes consume.
- [ADR-003](003-gsap-timeline-engine.md) — defines the `beat` labels
  used in URLs.
- [ADR-008](008-agent-native-authoring.md) — the workbench is the
  primary surface where agent-native authoring happens.
