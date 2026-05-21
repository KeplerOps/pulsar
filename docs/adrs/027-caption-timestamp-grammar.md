# ADR-027: Caption Timestamp Grammar — `at` Accepts a Millisecond Offset or a Beat Label, Validated at the Scene Schema Boundary

## Status

Accepted

## Date

2026-05-11

## Context

[ADR-002](002-scene-registry-and-compositions.md) §"Scene shape"
documents the canonical scene module shape, and its illustrative
example shows `captions: []` with the comment `[{ at: ms, text }]` —
millisecond-only `at` values for the prompter and exporter.
[ADR-022](022-workbench-mode-prompter.md) §"Captions data model"
similarly cites `Caption = { at: ms, text }` as the canonical scene
caption shape the prompter aggregates over.

[ADR-008](008-agent-native-authoring.md) #1 makes one identifier
grammar binding on scenes, compositions, beats, and assets:
kebab-case (`[a-z0-9]+(-[a-z0-9]+)*`). [ADR-015](015-url-beat-positioning.md)
applied that grammar to the URL `beat=` parameter, [ADR-002] /
[ADR-011](011-composition-resolver-orchestration.md) applied it to
composition `range` endpoints, and [ADR-026](026-named-timeline-beats.md)
applied it to scene-authored timeline labels with the bridge-level
`assertSceneTimeline()` gate. Wherever the runtime says "named beat"
it means *this* grammar.

PUL-F027 specifies the caption metadata shape:

> Each scene SHALL declare its captions in metadata as a list of
> `{ at, text }` entries, where `at` is a millisecond offset or a beat
> label. The runtime SHALL derive the prompter view from this same
> metadata.

That clause widens caption `at` beyond the millisecond-only shape
ADR-002 / ADR-022 illustrate. A caption author whose scene pins a
moment to a named beat (an existing GSAP label) wants
`at: 'midpoint-stinger'`, not a recomputed millisecond offset that
goes stale every time the beat moves. That is the same affordance
URL `beat=`, presenter `seek-to-beat`, and composition `range` give
the same author for the same beat.

The question this ADR answers is: where does the widened caption
grammar live, what predicate validates it, and how do downstream
consumers (the prompter, future exporter, future caption editor)
discriminate the two cases? It also records the policy decision so
ADR-002's `Caption = { at: ms, text }` and ADR-022's parallel claim
are refined here rather than mutated in place.

## Decision

### Type

`Caption.at` widens from `number` to `number | string`:

- A **number** value is a non-negative integer millisecond offset
  from the scene's start, the same shape ADR-002 / ADR-022 originally
  documented. The runtime now also rejects floats, negatives, `NaN`,
  and `±Infinity` at validation time (PUL-F027 is the first
  requirement that puts a tightened gate on the numeric branch; the
  loose `typeof v.at === 'number'` predicate predated this).
- A **string** value is a scene-local beat label sharing the **one**
  ADR-008 #1 kebab-case identifier grammar — the same predicate
  `isKebabIdentifier` validates scene ids, composition ids, timeline
  labels (ADR-026), URL `beat=` (ADR-015), composition `range`
  endpoints (ADR-002), and asset ids. Caption labels carry **no**
  caption-only sub-grammar; a digit-only label such as `"1000"` is
  valid here because it is valid everywhere else the shared grammar
  applies. A string `at` is **always** a beat label, never coerced
  to a number — if an author wants 1000 ms they write `at: 1000`.

The widened type lives at the single scene-schema boundary in
`src/runtime/scene.ts`. Consumers that need to discriminate the two
cases do so by `typeof at` at their own boundary; the caption schema
does not pre-classify or normalize for them.

### Validator

`assertSceneModule()` in `src/runtime/scene.ts` remains the only
runtime caption-shape check (preflight: "the registry validates scene
modules once and freezes snapshots"). The PUL-F027 refinement is
local to two helpers next to the `Caption` type:

- `isCaptionAt(v)` — returns `true` when `v` is a finite, non-negative
  integer OR a value satisfying `isKebabIdentifier`. Rejects every
  other shape.
- `describeCaptionFault(cap, index)` — returns the message the
  schema-error envelope should report (or `null`). Identifies the
  caption index and the failing field so a scene with twenty captions
  surfaces the offender as `captions[14].at must be ...`, matching
  the indexed style the composition-manifest validator
  (`assertCompositionManifest`) already uses. Caption `text` is
  **never** echoed in the message (preflight: avoid leaking caption
  content through diagnostics).

`assertSceneModule()` runs the array check via the existing
`FIELD_GUARDS` pass, then iterates captions and uses
`describeCaptionFault` for per-element diagnostics. The previous
boolean-collapsing `isCaptionArray` is removed; an orphaned
`isCaption` predicate that no longer routes through the indexed
validator is removed alongside it (codex review, cycle 3 — keeping
two caption-validation entry points weakens the single boundary).

### Prompter passthrough

`buildPrompterScript()` in `src/runtime/prompter.ts` already derives
the prompter view from the registered scene module's `captions` and
structurally copies each entry (`{ ...c }` — the spread carries any
PUL-F001 `Caption` field forward without a parallel schema). The
widened `at` flows through unchanged: numeric captions stay numeric,
beat-label captions stay strings, and the prompter performs **no**
coercion, sorting, dropping, or rewriting. The runtime SHALL-clause
"derive the prompter view from this same metadata" is therefore a
structural invariant pinned by the existing prompter tests plus a
new mixed-shape passthrough test.

### Boundaries

- **Schema gate** owns the union and the validation. No second caption
  schema exists in the prompter, exporter, registry, or composition
  layer.
- **Registry** continues to call `assertSceneModule()` once and freeze
  snapshots; it does not introduce a registry-local caption parser.
- **Timeline / beat boundary** owns label existence. The scene-schema
  gate validates label *shape*, not label *existence* on the scene's
  timeline — running `timeline(ctx)` from `assertSceneModule()` would
  move lifecycle side effects into metadata validation. A future
  authoring lint may cross-check caption labels against
  `MasterTimeline.beats()` through the existing timeline seam without
  changing this boundary.
- **Prompter aggregation** stays a pure structural copy. It does not
  resolve labels to milliseconds, drop labels that don't appear on the
  master, or normalize the union — those are consumer-side decisions
  the captions UI / exporter make with the discriminated `at` value
  the prompter hands them.
- **URL grammar** is unchanged. Caption metadata is not URL-addressable
  and adds no new query key.
- **Composition manifest** is unchanged. Caption text and `at` come
  from the registered scene module; object-form composition entries
  do **not** override captions (the existing `range` / `behavior`
  overrides are runner-side timeline knobs, not caption knobs).

### Relation to ADR-002 / ADR-022

This ADR **refines** the caption-shape clauses in ADR-002 §"Scene
shape" and ADR-022 §"Captions data model". The original ADRs are not
rewritten; they continue to describe the millisecond-only shape that
was the contract under PUL-F001 / PUL-F019. From PUL-F027 onward the
binding caption-shape rule is the one stated above, validated at the
single boundary named above. Future ADRs that reference caption shape
SHOULD cite ADR-027.

### What this ADR does NOT change

- The `Caption.text` shape (still `string`).
- The `captions` field placement (still on `SceneModule`, no
  composition override).
- The prompter contract (still structural derivation from scene
  metadata; the mode-prompter lifecycle bypass in ADR-022 is
  unchanged).
- The kebab-case identifier grammar (still the one ADR-008 #1
  predicate, used unchanged).
- The PUL-F019 / ADR-022 captions data path (still aggregates the
  full slice from the addressed scene onward; no caption truncation
  by composition `range`).

## Consequences

### Positive

- One caption-shape contract, one validator, one error envelope shape
  with indexed faults. The boundary that already owned `Caption`
  continues to own it.
- One identifier grammar across captions, timelines, URL `beat=`,
  composition `range`, and asset ids. An author who pins a caption
  to a named beat uses the same string they would write in any other
  beat-addressable surface.
- Future caption consumers (caption editor UI, exporter, beat-aware
  prompter scroll) discriminate `Caption.at` by `typeof` at their own
  boundary. No pre-classifier; no parallel `CaptionTime` /
  `CaptionRef` / `Cue` schema; no shared union helper landed
  speculatively before two consumers need it.
- The prompter contract did not have to change. The structural-copy
  invariant `buildPrompterScript` already enforced is what carries
  the widened `at` through unchanged.

### Negative

- Caption authors get a slightly larger set of valid inputs that the
  validator MUST reject loudly. The numeric-branch tightening (no
  floats, no NaN, no Infinity, no negatives) catches inputs the old
  loose `typeof === 'number'` accepted. That is a correctness
  improvement, but a caption library hand-rolled against the original
  laxer numeric check could need a one-time cleanup pass — surface as
  a clear `captions[N].at must be ...` error so the fix is local.
- The scene-schema gate is now two passes (FIELD_GUARDS broad check,
  then per-element loop). The split is the minimum required to get
  indexed errors on captions; the composition-manifest validator
  already uses the same two-pass pattern, so the cognitive cost is
  shared.

### Risks

| Risk | Mitigation |
|------|-----------|
| A consumer normalizes string `at` to milliseconds and drops the label | Prompter test pins mixed numeric + beat-label passthrough end to end. The contract is "structural copy"; a coercing consumer is a regression. |
| Caption labels diverge from the shared grammar (caption-only stricter rule, separate predicate copy) | The scene-schema validator routes through `isKebabIdentifier` directly; there is no caption-only regex. Codex review, cycle 2 caught and rejected an earlier draft that did invent a caption-only sub-grammar. |
| Per-element error messages echo caption text and leak script content | `describeCaptionFault` returns messages that mention only the index and the failing field. Tests pin index/field identification; no test or implementation echoes `text` in an error. |
| A future caption editor mutates the prompter script and corrupts the source scene | `buildPrompterScript` already deep-clones each caption (`{ ...c }`) and deep-freezes the script. Adding the union to `Caption.at` does not change those invariants — pinned by existing prompter tests. |
| Caption beat labels reference labels that don't exist on the scene's timeline | Out of scope here — beat *existence* belongs to the timeline boundary, not the schema gate. A future authoring lint may compare caption labels to `MasterTimeline.beats()` through the timeline seam without changing this ADR. |

## Related ADRs

- [ADR-002](002-scene-registry-and-compositions.md) — defines the
  scene module shape including the original millisecond-only
  `captions` example; refined here for `Caption.at`.
- [ADR-008](008-agent-native-authoring.md) — #1 names the one
  kebab-case identifier grammar reused for caption beat labels.
- [ADR-015](015-url-beat-positioning.md) — applies the same grammar
  to URL `beat=`; caption labels share that vocabulary.
- [ADR-022](022-workbench-mode-prompter.md) — defines the prompter
  captions data path; the structural-copy invariant is the seam this
  ADR's widening flows through unchanged.
- [ADR-026](026-named-timeline-beats.md) — validates scene-authored
  timeline labels as beats using the same grammar caption beat
  labels reuse.
