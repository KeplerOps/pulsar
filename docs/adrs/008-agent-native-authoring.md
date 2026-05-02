# ADR-008: Agent-Native Authoring as a First-Class Architectural Constraint

## Status

Proposed

## Date

2026-04-30

## Context

The collaboration model Pulsar is designed for is **human-directed,
agent-implemented**: a human describes the intent of a scene, a coding
agent implements (or modifies) the scene module, and the human reviews
the result in the browser. This is structurally different from:

- **Pixel-pushing tools** (Canva, Gamma, Tome, Pitch, Keynote) where a
  human drags shapes on a canvas.
- **Code-only frameworks** (reveal.js, Spectacle, Motion Canvas, raw
  Three.js apps) where a human writes the code directly.
- **AI deck generators** where an LLM produces an entire artifact in
  one shot.

The Pulsar loop is iterative, scoped, and conversational. The agent
makes a small, well-scoped change to one scene; the human inspects that
specific scene; the cycle repeats. For that loop to be fast and safe,
the runtime must be **structurally legible to coding agents**, not
just runnable.

Concretely, agent-native ergonomics require:

- Stable, addressable identifiers — scene ids that don't change just
  because their position in a composition did.
- Explicit, declarative manifests an agent can read and edit safely
  (registry of scenes, list of compositions) rather than implicit
  behavior buried in flow control.
- A small, well-defined scene contract (`create`, `timeline`,
  `cleanup`, plus declared `assets` / `captions` / `tags` /
  metadata) so an agent can produce a new scene without reading the
  rest of the runtime.
- Separation of concerns across narrative, visual, audio, timing, and
  asset layers so scoped changes stay scoped.
- Asset inventories so agents and humans can both see what's being
  loaded.
- Named timeline beats (vs. raw millisecond offsets) so the agent and
  the human refer to the same moment.
- Validation: a runtime/CLI check that catches missing scenes in a
  composition, dangling asset references, or duplicate ids before the
  human has to.
- Screenshot regression hooks so an agent can verify a change didn't
  break unrelated scenes.
- Prompter and presenter views generated from the same scene/composition
  source, so the agent only has to update one place.
- Clear lifecycle contracts (`cleanup` is mandatory, not optional) so
  scoped agent edits don't leak state into other scenes.
- Direct browser URLs (see [ADR-007](007-browser-workbench.md)) so the
  agent can report a change with a verifiable inspection target.

These are not optional polish items. They are what make the
human/agent loop tractable at speed. Without them, every change risks
either being too small (agent makes a trivial edit, human still has to
manually navigate) or too large (agent guesses at structure, breaks
something unrelated).

Structural legibility for coding agents is Pulsar's central design
commitment (see `docs/design/positioning-and-landscape.md`).
Agent-native ergonomics are a constraint on every architectural
choice, not a roadmap aspiration.

## Decision

Agent-native authoring is a **first-class architectural constraint**
in Pulsar. Every architectural decision must satisfy structural
legibility for coding agents in addition to its functional purpose.
Specifically:

1. **Stable, declarative identity.** Scenes, compositions, beats, and
   assets have stable, kebab-case ids. Renaming is a deliberate
   operation, not a side effect of refactoring.

2. **Manifests over flow control.** Scene registries and composition
   manifests are the source of truth for what exists and how it is
   arranged. Implicit ordering via `if/else` or hand-rolled dispatch
   is rejected.

3. **Small scene contract.** A scene is `{ id, title, duration, tags,
   assets, captions, defaultNext, standalone, trailerSafe, create,
   timeline, cleanup }`. New surface area must justify itself; we
   prefer scenes to be writable from a clear template.

4. **Separation of layers.** Narrative (captions), visual (DOM/canvas),
   audio (Howler), timing (GSAP), and assets (declared list) are
   distinct surfaces a scene composes — not entangled in one blob.
   This makes scoped agent edits possible.

5. **Asset inventories.** Every scene declares the assets it needs in
   its metadata. The runtime preloads from that list. Agents can
   reason about asset cost without reading rendering code.

6. **Named beats, not raw offsets.** Timeline labels (per
   [ADR-003](003-gsap-timeline-engine.md)) are the canonical way to
   refer to moments inside a scene, in URLs, in trailers, and in
   conversation between human and agent.

7. **Validation as a runtime concern.** A validation pass catches
   missing scenes, dangling assets, duplicate ids, undeclared cleanup,
   and other structural breakage. It runs locally and in CI and
   produces actionable errors agents can fix.

8. **Screenshot regression hooks.** Scenes can be rendered in
   `mode=screenshot` (per [ADR-007](007-browser-workbench.md)) for
   visual regression. The runtime guarantees deterministic output for
   a given code revision.

9. **One source for prompter and presenter views.** Captions, scene
   titles, and beats feed both the prompter view and any presenter
   overlays from the same metadata. There is one place to edit them.

10. **Mandatory cleanup.** Every scene's `cleanup(ctx)` is called by
    the runtime on exit. Audio groups, listeners, and DOM mounts
    declared during `create` must be torn down. Lifecycle leaks are a
    runtime bug.

11. **Agent-addressable inspection.** Workbench URLs
    (per [ADR-007](007-browser-workbench.md)) are the agent's
    contract for "go look at what I changed."

This ADR is a binding constraint on future ADRs. A proposal that
makes structural legibility worse — for example, by hiding scene
identity behind dynamic registration, by introducing implicit
positional ordering, or by replacing manifests with imperative flow —
must explicitly justify the trade-off and supersede or amend this ADR.

## Consequences

### Positive

- The human/agent authoring loop is fast and scoped. Agents can edit
  one scene without reading the whole runtime.
- Scoped changes are safe by construction: cleanup is mandatory,
  assets are declared, identities are stable.
- Validation and screenshot regression catch structural breakage
  early, reducing the human's review burden.
- The runtime is legible to non-agent contributors as well — the same
  structural clarity that helps agents helps people.
- Differentiator vs adjacent OSS: existing creative tools and
  code-only frameworks do not optimize for this loop.

### Negative

- Discipline cost: contributors (human or agent) must keep manifests,
  asset declarations, and metadata in sync with rendering code.
- More structure to learn up front than a free-form HTML file.
- Validation surface needs to be built and maintained.

### Risks

| Risk | Mitigation |
|------|-----------|
| Structure becomes a cage; expressive one-off scenes get awkward | Keep escape hatches — a scene can drop down to raw DOM, raw Web Audio, or raw canvas — provided it still satisfies the small scene contract (declared assets, working cleanup, declared metadata). |
| Validation lags behind the runtime, so structural breakage isn't caught | Treat validation as a runtime feature, not a script; ship it in the OSS core from the start. |
| "Agent-native" devolves into "tolerant of LLM mistakes" instead of structural legibility | The bar is clarity for any reader, agent or human. A "fix-it for the LLM" hack that hurts human readability does not satisfy this ADR. |
| Pressure to introduce magical conventions ("agents will figure it out") | Conventions are explicit and documented; the runtime does not rely on undocumented LLM heuristics. |

## Related ADRs

- [ADR-001](001-custom-experience-runtime.md) — the custom runtime
  owns the structural legibility this ADR mandates.
- [ADR-002](002-scene-registry-and-compositions.md) — manifests and
  stable ids are the structural backbone.
- [ADR-003](003-gsap-timeline-engine.md) — named timeline beats are
  the agent-friendly time grammar.
- [ADR-004](004-howler-audio-engine.md) — declared audio assets +
  guaranteed cleanup keep agent edits scoped.
- [ADR-005](005-dom-css-default-rendering-surface.md) — DOM/CSS
  surfaces are the most legible default for both agents and humans.
- [ADR-007](007-browser-workbench.md) — the workbench is where
  agent-native authoring happens in practice.
