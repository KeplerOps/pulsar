# ADR-002: Scene Registry and Composition Manifests as the Core Abstraction

## Status

Accepted

## Date

2026-04-30

## Context

The natural unit of work in Pulsar is the **scene** — a timed,
self-contained beat with its own assets, captions, and rendering. The
natural unit of delivery is a **composition** — an arrangement of
scenes into a full talk, a short talk, a trailer, a cold-open demo, a
rehearsal cut, or any other recomposition of the same library.

A common failure mode in presentation runtimes is to treat the deck as
a linear file: one ordered list of slides, identified by position. That
makes the position the identity of the content. Position-as-identity
makes recomposition expensive: a "shorter version" or "trailer" must
either fork the deck (drift) or wrap it in conditional logic (rot).

Pulsar's needs explicitly include:

- Running the same scene inside a long talk and a short talk.
- Cutting trailers that pull a labeled subrange from one scene plus a
  whole second scene plus a labeled subrange from a third.
- Launching a single scene standalone for testing, rehearsal, or a
  demo.
- Reusing scene metadata (captions, assets, durations) across the live
  runtime, the prompter, the rehearsal view, and the export pipeline.

The runtime therefore needs a scene/composition model in which:

- Scenes are addressable by stable id, not by position.
- Scenes carry the metadata that downstream subsystems (prompter,
  exporter, rehearsal, asset preloader) need.
- Compositions are manifests of scene ids, separate from the scene
  modules themselves.
- Numeric or positional navigation, if used, is a derived view — not
  the source of truth.

## Decision

The core abstraction in Pulsar is a **scene** registered in a **scene
registry** and arranged into named **composition manifests**.

### Scene shape

Every scene exports a module with the following shape (illustrative):

```js
export const scene = {
  id: "string",          // stable, kebab-case, unique across the registry
  title: "string",
  duration: 0,           // ms, or null if open-ended/interrupt-driven
  tags: [],              // free-form labels (act, theme, surface kind, etc.)
  assets: [],            // images, audio, fonts, data, etc.
  captions: [],          // [{ at: ms, text }] for prompter and exporters
  defaultNext: "string", // optional: scene id to advance to by default
  standalone: false,     // safe to launch in isolation?
  trailerSafe: false,    // safe to use in a trailer cut without context?
  create(ctx)  { /* mount DOM/canvas/etc. */ },
  timeline(ctx){ /* return a timeline (see ADR-003) */ },
  cleanup(ctx) { /* remove listeners, stop audio, clear scene state */ },
};
```

### Scene registry

Scenes are registered by id in a single registry. The runtime's
navigation, presenter controls, and URL handling all dispatch through
this registry. There is no positional dispatch in the runtime core.

```js
export const scenes = {
  "scene-a": sceneA,
  "scene-b": sceneB,
  // ...
};
```

### Composition manifests

A composition is an array of scene ids (with optional per-entry overrides
for sub-ranges, durations, or behavior):

```js
export const fullTalk = ["scene-a", "scene-b", "scene-c", "scene-d"];

export const shortTalk = ["scene-a", "scene-c"];

export const trailer    = [
  { id: "scene-a", range: ["intro", "hook"] },
  { id: "scene-c", range: "payoff" },
];
```

Compositions are first-class artifacts. They can be discovered, listed,
diffed, and reasoned about independently of any individual scene.

### Resolution

The runtime resolves a composition by:

1. Validating that every referenced scene id exists.
2. Preloading assets declared by each scene's metadata.
3. Mounting each scene in turn via `create(ctx)`.
4. Running its timeline.
5. Tearing it down via `cleanup(ctx)` before mounting the next.

### Navigation

Navigation is in terms of (composition, scene, beat, mode) tuples. URL
parameters follow that model:

- `?scene=<scene-id>` — load a single scene with `mode=present`.
- `?scene=<scene-id>&mode=standalone` — load a single scene with no
  surrounding talk flow.
- `?composition=<composition-id>` — load a composition from the start.
- `?composition=<composition-id>&scene=<scene-id>` — load a composition
  and jump to the named scene.
- `?composition=<composition-id>&index=<n>` — positional jump within a
  composition (compatibility shim).
- `?scene=<scene-id>&beat=<label>` — jump to a labeled point inside a
  scene timeline (see [ADR-003](003-gsap-timeline-engine.md)).
- `?...&mode=<present|standalone|loop|paused|scrub|screenshot|prompter>`
  — select a workbench mode (see [ADR-007](007-browser-workbench.md)).

Numeric / positional navigation, if exposed, is a compatibility shim
implemented over composition position; scene id remains the source of
truth for identity.

## Consequences

### Positive

- Scenes are reusable assets, not hard-coded positions.
- Trailers, short cuts, and standalone demos are normal — not
  one-offs.
- Prompter, exporter, asset preloader, and rehearsal tooling can all
  read the same scene/composition metadata.
- Per-scene URL navigation works without bespoke routing per deck.
- Scene authors only have to satisfy a small contract
  (`create`/`timeline`/`cleanup` + metadata) to plug in.

### Negative

- An indirection layer exists between authoring and presenting: scene
  modules + registry + composition + runtime, instead of "edit slide N".
- Naming discipline is required — `id` collisions or inconsistent
  kebab-case will hurt later.
- Captions and other metadata that previously lived close to the
  rendering code now have a defined home.

### Risks

| Risk | Mitigation |
|------|-----------|
| Scene metadata drifts from actual rendering (e.g., `duration` lies) | Lint or test that timelines and metadata agree where it matters; have the prompter and exporter consume metadata so drift is loud. |
| Compositions diverge into copies that are almost-equal | Encourage "subrange" expressions inside a composition entry rather than scene forks; promote shared scene ids over near-duplicate scenes. |
| Standalone launches surface assumptions a scene quietly relied on | Make `standalone: true` an explicit assertion that the scene can run without prior context; add tests for that flag. |

## Related ADRs

- [ADR-001](001-custom-experience-runtime.md) — establishes that the
  runtime owns this model rather than delegating to a slide framework.
- [ADR-003](003-gsap-timeline-engine.md) — defines the timeline shape
  the scene's `timeline(ctx)` returns and the `beat` labels referenced
  in URLs.
- [ADR-006](006-remotion-export-path.md) — the export path consumes the
  same scene metadata and composition manifests.
- [ADR-007](007-browser-workbench.md) — workbench modes consume the
  same URL grammar.
- [ADR-008](008-agent-native-authoring.md) — stable scene ids and
  manifests are part of the agent-native authoring contract.
