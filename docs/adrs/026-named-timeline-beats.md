# ADR-026: Named Timeline Beats — Scene-Local Kebab Labels, Validated at Compose Time, Referenced Through the Master

## Status

Accepted

## Date

2026-05-10

## Context

[ADR-008](008-agent-native-authoring.md) names *named timeline beats*
(versus raw millisecond offsets) as one of the things that make the
human/agent loop tractable: "so the agent and the human refer to the
same moment." [ADR-003](003-gsap-timeline-engine.md) decided that the
GSAP timeline's first-class **labels** are how those beats are
expressed, and that trailer-friendly subranges and presenter beats are
labels inside a scene's timeline. [ADR-015](015-url-beat-positioning.md)
established that the URL `beat=<label>` parameter is timeline-runner
state — label existence and seeking belong to the timeline boundary,
not to URL parsing, the scene registry, or composition-manifest
validation — and that scene metadata must **not** carry a parallel
`beats` list that could drift from the timeline.

PUL-F022 / [ADR-025](025-timeline-adapter-boundary.md) then shipped the
GSAP timeline adapter (`src/runtime/timeline.ts`). It already nests the
active composition slice's scene timelines into one master GSAP
timeline, copies each scene's labels into the master under a
deterministic namespace (`<scene>:<label>`, disambiguated to
`<scene>#<n>:<label>` when a composition reuses a scene id — ADR-002
permits repeated entries), exposes the master through a `MasterTimeline`
transport surface (`labels`, `hasLabel`, `seek`, `labelFor`, …), and
resolves the URL `beat=` head hint against it with the non-fatal
`onBeatMissing` fallback PUL-F011 / ADR-015 require.

PUL-F023 is the requirement that *names and finalizes* that contract:

> Scene timelines SHALL support named labels (beats) referenceable by
> URL, presenter input, and other runtime subsystems.

Two things were still loose:

1. **A scene-authored timeline label was not validated as a beat.**
   ADR-008 #1 makes kebab-case binding on scenes, compositions, **beats**,
   and assets; the runtime validates scene ids, composition entry ids,
   and asset URLs and rejects loudly, but `composeMasterTimeline` copied
   *any* GSAP label string into the master. A scene that did
   `tl.addLabel('My Beat')` produced a master label that the kebab-only
   URL `beat=` grammar can never address — a silent dead end in exactly
   the agent loop ADR-008 is about.
2. **There was no canonical way to enumerate or parse beats.** A
   subsystem holding a master label name had only `master.labels` (every
   label, including the automatic segment-start anchors) and would have
   to re-derive the `:` / `#` namespace grammar itself. Future scrub
   controls (PUL-F017 — "scrub … to named beats"), a presenter HUD
   (PUL-F020), beat pickers, and automation each reinventing that
   parsing is the failure this requirement exists to prevent.

## Decision

**A scene's GSAP timeline labels *are* its beats.** There is no `beats`
or `labels` field on `SceneModule` (ADR-015) and there will not be one
unless a future ADR supersedes this — the labels in the timeline
returned by `timeline(ctx)` are the single source of truth.

**A beat must be a well-formed, reachable moment.** Each scene-authored
label must (a) be a kebab-case identifier — the same `isKebabIdentifier`
rule scenes, compositions, and assets obey (ADR-008 #1), because the URL
`beat=` grammar is kebab-only and a name it cannot express could never be
addressed — and (b) sit at a finite, non-negative time no later than the
scene timeline's own duration — a beat past or outside the scene's
content is not a usable moment, and `beats()` / label-based `seek` would
otherwise expose a clamped or out-of-range position as canonical. Both
are enforced by `assertSceneTimeline` when a scene timeline first enters
the runtime: `composeMasterTimeline` runs it over every segment before it
builds the master, so a non-conforming beat fails *before any timeline is
constructed* (and, on rejection, every GSAP timeline the adapter was
already handed is killed, so a default-playing or repeating scene
timeline cannot keep ticking after the resolver unmounts the scenes).
The failure is a `SceneTimelineLabelError` (a leaf of the existing
`TimelineError` hierarchy — no new exception family) whose message names
the scene id, the offending label, and (for a bad position) the time and
the duration (PUL-Q006). It is a **scene-contract violation**, surfaced
through the composition resolver's `composition timeline failed:`
envelope with mandatory cleanup of every mounted scene (ADR-025) — *not*
the non-fatal positioning diagnostic reserved for an *unknown URL beat*
(ADR-015): an authored beat that cannot be addressed is a bug in the
scene, not a navigation miss.

**Beats are namespaced into the master per ADR-025.** A scene-local
label `hook` on a scene `intro` appears on the master as `intro:hook`
(or `intro#1:hook` for the second `intro` in a composition). The
automatic per-segment start labels (`intro`, `intro#1`) are **transport
anchors**, not authored beats; they exist for sequencing, not as
agent-addressable moments, and are not surfaced as beats unless a future
requirement asks for scene-entry anchors explicitly.

**`MasterTimeline` is the canonical beat-query surface** every runtime
subsystem references beats through:

- `labels` — every master label (anchors + namespaced beats), names → times.
- `hasLabel(name)` — existence check.
- `seek(time | name)` — positioning; an unknown label or non-finite time throws.
- `labelFor(scene, label, occurrence?)` — the master name for a
  scene-local beat (a thin alias of `sceneTimelineLabel`).
- `beats()` — just the scene-authored beats, in playhead order, each as a
  `MasterBeat` (`{ scene, occurrence, label, name, time }`); a fresh,
  caller-owned array.

`sceneTimelineLabel(scene, label, occurrence?)` builds a namespaced
master beat name; `parseSceneTimelineLabel(name)` is the **one inverse**
— it returns `{ scene, occurrence, label }` for a namespaced beat or
`null` for a bare anchor / malformed name. No subsystem reparses the
`:` / `#` grammar locally.

**Consumers reference beats through this surface; they do not
re-implement label handling.** URL `beat=` (PUL-F011 / ADR-015) resolves
its head-scoped beat to `sceneTimelineLabel(headScene, beat)` and seeks
it via the master, with `onBeatMissing` for an unknown label. Presenter
input (PUL-F020 / ADR-023 / ADR-024) that targets a beat resolves it
against the active master through `hasLabel` / `labelFor` / `seek`; a
future presenter command that carries an explicit beat target extends
the `PresenterCommand` discriminated union in `src/runtime/presenter.ts`
and validates the beat payload there with `isKebabIdentifier` (no second
presenter event schema). Scrub controls (PUL-F017 / ADR-020) enumerate
`master.beats()` for their "scrub to named beats" affordance. None of
these own beat parsing, validation, or storage — `src/runtime/timeline.ts`
does.

## Consequences

### Positive

- A non-kebab beat label fails loudly at compose time with a scoped
  message, instead of silently producing an unaddressable label —
  closing the agent-loop footgun ADR-008 cares about.
- Beat handling stays in one module. URL, presenter, and scrub
  consumers share `MasterTimeline` + `sceneTimelineLabel` /
  `parseSceneTimelineLabel`; none re-derive the `:` / `#` grammar, so it
  cannot drift between subsystems.
- `beats()` gives future scrub / presenter-HUD / beat-picker / automation
  consumers a ready, ordered, parsed view — they do not filter
  `master.labels` by hand.
- Reuses the existing `isKebabIdentifier` / `KEBAB_IDENTIFIER_FORM`
  predicate, the existing `assertSceneTimeline` boundary, the existing
  `TimelineError` hierarchy, and the resolver's existing
  rejection-wrapping path. No new module, no scene-schema change, no
  duplicate regex.

### Negative

- Scenes that (today, with only the placeholder scene authoring no
  timeline) start using labels must pick kebab-case names. That is the
  same rule already in force for scene ids, composition entries, and
  assets, so the constraint is consistent, not new — but it is now
  enforced where before any string would have been silently accepted.
- `parseSceneTimelineLabel` and `beats()` add a small amount of surface
  to `timeline.ts` ahead of the first consumer (scrub / presenter are
  still DRAFT). The alternative — each consumer reinventing label
  parsing — is the named anti-pattern; the cost is one short parser plus
  one derived view.

### Risks

| Risk | Mitigation |
|------|------------|
| A scene author adds a parallel `beats` metadata list | Labels in the returned timeline are the single source of truth; `SceneModule` has no `beats` field and nothing in the runtime reads one, so a metadata list would be inert and drift-prone. ADR-015's risk table already records this. |
| A subsystem parses namespaced label strings its own way | `parseSceneTimelineLabel` is the one inverse of `sceneTimelineLabel`; `beats()` is the one enumeration. Code review keeps `:` / `#` string-splitting out of consumers. |
| The automatic segment-start anchors get treated as authored beats | `parseSceneTimelineLabel` returns `null` for a bare anchor, so `beats()` excludes them; the namespaced form (`scene:label`) is the only thing that parses as a beat. |
| A bad beat is reported like an unknown URL beat (non-fatal) and the scene stays mounted with a broken label | A non-kebab authored label throws `SceneTimelineLabelError` through the resolver's `composition timeline failed:` envelope with mandatory cleanup — it is a scene-contract failure, distinct from ADR-015's non-fatal "URL named a label that doesn't exist" path. |

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) — GSAP labels + seeking are the
  beat mechanism; `ctx.gsap`.
- [ADR-008](008-agent-native-authoring.md) — named beats as an
  agent-native ergonomic; #1 makes kebab-case binding on scenes,
  compositions, beats, and assets.
- [ADR-015](015-url-beat-positioning.md) — URL `beat=` is
  timeline-runner state; an *unknown* URL beat is a non-fatal positioning
  diagnostic (distinct from the *malformed authored beat* this ADR
  rejects); no parallel `beats` metadata.
- [ADR-025](025-timeline-adapter-boundary.md) — the timeline adapter,
  the composition master, and the namespaced master labels this ADR's
  beat-query surface is built on.
- [ADR-002](002-scene-registry-and-compositions.md) — compositions may
  reuse a scene id; that is why beats carry an occurrence.
- [ADR-020](020-workbench-mode-scrub.md) / [ADR-023](023-presenter-controls.md)
  / [ADR-024](024-presenter-pause-resume.md) — scrub and presenter
  consume the beat-query surface; they do not own beat handling.
