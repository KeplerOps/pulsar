# ADR-010: Issue Tag Taxonomy

## Status

Accepted

## Date

2026-05-03

## Context

Pulsar's GitHub issue tracker now carries one issue per Ground Control
requirement (52 DRAFT + 3 ACTIVE = 55 issues at time of writing) plus
ad-hoc bug, chore, and documentation work. The repo's GitHub labels are
the unmodified upstream defaults (`bug`, `enhancement`, `documentation`,
`duplicate`, `good first issue`, `help wanted`, `invalid`, `question`,
`wontfix`) and none of them have been applied. Without a deliberate
taxonomy:

- Filtering by requirement series (functional / quality / architectural
  constraint / policy) requires reading every title.
- Filtering by subsystem (scene, navigation, audio, …) is impossible.
- Wave / priority / requirement-vs-bug distinctions live only inside
  the issue body, not on the issue list view.
- Triage decisions (which work to grab next from a given area) are
  expensive.

Ground Control already records every requirement's `priority`, `wave`,
`requirement_type`, and UID series. GitHub does not surface those in
its UI without labels mirroring them. Mirroring is acceptable: the
Ground Control record is the source of truth, and the labels are a
denormalized index for browsability. Drift is bounded — a single
script can rebuild every label from the Ground Control export.

## Decision

Adopt a multi-dimensional, namespaced label taxonomy on
`KeplerOps/pulsar`. Every label outside the upstream GitHub default set
uses `<dimension>:<value>` so the dimension is visible at a glance.

### Dimensions

**1. Type** — what kind of work the issue represents. Exactly one per
issue. Reuses upstream GitHub defaults plus two additions.

| Label | Meaning |
|-------|---------|
| `requirement` | Issue derives from a Ground Control requirement (see Series / Priority / Wave). |
| `bug` | Defect in shipped code. |
| `enhancement` | Improvement to an existing feature that is not itself a Ground Control requirement. |
| `documentation` | Documentation-only work (ADRs, READMEs, guides). |
| `chore` | Maintenance: dependency bumps, refactors, tooling, repo hygiene. |

**2. Series** — for `requirement` issues only. Mirrors the `PUL-<F\|Q\|A\|P>NNN` UID prefix and the requirement's GC `requirement_type`.

| Label | UID prefix | GC `requirement_type` |
|-------|-----------|------------------------|
| `series:functional`     | `PUL-F` | `FUNCTIONAL` |
| `series:quality`        | `PUL-Q` | `NON_FUNCTIONAL` |
| `series:architecture`   | `PUL-A` | `CONSTRAINT` (architectural) |
| `series:policy`         | `PUL-P` | `CONSTRAINT` (policy/process) |

**3. Priority** — for `requirement` issues only. Mirrors GC's
MoSCoW `priority` field.

| Label | GC priority |
|-------|-------------|
| `priority:must`   | `MUST` |
| `priority:should` | `SHOULD` |
| `priority:could`  | `COULD` |
| `priority:wont`   | `WONT` |

**4. Wave** — for `requirement` issues only. Mirrors GC's `wave`
field. Today's range is 0–3; extend by adding new `wave:N` labels as
new waves appear.

| Label | GC wave |
|-------|---------|
| `wave:0` | 0 |
| `wave:1` | 1 |
| `wave:2` | 2 |
| `wave:3` | 3 |

**5. Area** — subsystem the issue touches. Multi-select: an issue may
carry zero, one, or several `area:*` labels. Use the *primary*
subsystem(s) only — every issue technically touches "scene" but only
issues whose work centers on the scene module / registry / cleanup
contract get `area:scene`.

| Label | Subsystem |
|-------|-----------|
| `area:scene`        | Scene module contract, registry, lifecycle, id format. |
| `area:composition`  | Composition manifests, resolution, recomposition. |
| `area:navigation`   | URL grammar, workbench mode dispatch, browser routing. |
| `area:timeline`     | Timeline orchestration, named beats, scrub control. |
| `area:audio`        | Audio service, mute, autoplay unlock, sprite playback. |
| `area:rendering`    | DOM/CSS rendering surface, browser support, accessibility. |
| `area:export`       | Remotion-shaped export pipeline and the metadata bridge. |
| `area:prompter`     | Prompter view, caption-derived script. |
| `area:presenter`    | Presenter controls, advance/hold/skip, pause/resume. |
| `area:assets`       | Asset declaration, preload, failure surfacing. |
| `area:validation`   | Validation pass, actionable errors, CI gate. |
| `area:process`      | Workflow rules, ADR discipline, requirement lifecycle. |

### Application rules

- Every requirement-derived issue carries exactly one of each of
  `requirement`, `series:*`, `priority:*`, `wave:*`, plus one or more
  `area:*` labels.
- Non-requirement issues (bug / enhancement / documentation / chore)
  carry their type label and any applicable `area:*` labels. They do
  NOT carry `series:*`, `priority:*`, or `wave:*` — those dimensions
  are GC-derived and meaningful only for requirements.
- The labels are GC-mirrored, not GC-authoritative. When a requirement's
  priority or wave changes in GC, the issue's labels SHOULD be updated
  to match.
- A future automation MAY rebuild every requirement-issue's labels
  from a GC export. The ADR does not require automation today; manual
  application is the baseline.

### Color conventions

For consistency in label-list views: each dimension uses a coherent
color family. Exact hex values are an implementation detail captured in
the label-creation script, not a contract.

| Dimension | Color family |
|-----------|--------------|
| Type      | Mirror upstream GitHub colors where the label is upstream; `requirement` uses purple. |
| Series    | One distinct color per series. |
| Priority  | Stoplight: must=red, should=amber, could=light blue, wont=gray. |
| Wave      | Neutral gray, lightening as wave increases. |
| Area      | Single muted blue across all `area:*` labels. |

## Consequences

### Positive

- Browsing `is:issue label:area:audio` or
  `is:issue label:wave:0 label:priority:must` becomes a one-click
  triage operation in GitHub's UI.
- The label set survives independently of Ground Control reachability —
  a contributor without GC access can still filter the tracker.
- Namespaced labels (`series:`, `priority:`, `wave:`, `area:`) are
  self-describing; no separate cheat-sheet is required.
- Adding a new requirement series, wave, or subsystem is a one-label
  change.

### Negative

- Mirrored data drifts. Updating a requirement's priority or wave in
  Ground Control is now two operations (GC + issue label).
- 29 new labels is a large initial dump that contributors have to
  internalize.
- The `area:*` mapping is judgment-based. Edge cases (a navigation
  issue that primarily reshapes the scene contract) may be tagged
  inconsistently across contributors.

### Risks

| Risk | Mitigation |
|------|-----------|
| Labels rot as requirements transition through DRAFT → ACTIVE → DEPRECATED | The label set tracks GC's current state. A periodic sync (manual or scripted) reconciles. |
| Contributors invent ad-hoc labels outside the taxonomy | Namespaced labels make ad-hoc additions visible (`adhoc:foo` jumps out). PR review can catch them. |
| Wave labels accumulate as new waves are added | Trivial: add `wave:N` labels on demand. Old wave labels remain valid history. |

## Related ADRs

- [ADR-008](008-agent-native-authoring.md) — agent-native legibility
  motivates explicit, browsable taxonomies over implicit conventions.
- [ADR-009](009-repo-layout-and-build-tooling.md) — repo-shape
  decisions; this ADR sits alongside as an issue-tracker shape
  decision.

## Related Requirements

- `PUL-P004` — requirement lifecycle. Wave / priority labels track GC
  state per this lifecycle.
- `PUL-P005` — ADR linkage discipline. This ADR is itself recorded in
  Ground Control via `gc_create_adr`.
