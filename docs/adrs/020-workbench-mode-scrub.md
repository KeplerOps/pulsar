# ADR-020: Workbench Mode `scrub` — Runner Cue-Gate Hint at the Loader/Runner Seam

## Status

Accepted

## Date

2026-05-09

## Context

ADR-007 names seven workbench modes: `present`, `standalone`, `loop`,
`paused`, `scrub`, `screenshot`, `prompter`. ADR-013 fixes the URL
grammar boundary that carries `mode=` to the runtime. ADR-014 fixes
the scene navigation dispatch layer. ADR-015 fixes URL beat
positioning. ADR-016 (`mode=present`), ADR-017 (`mode=standalone`),
ADR-018 (`mode=loop`), and ADR-019 (`mode=paused`) establish the
precedent for landing a mode's contract layer plus seam tests while
the dependent rendering surfaces are still pending: PUL-F013,
PUL-F014, PUL-F015, and PUL-F016 all stayed DRAFT after their
respective contract PRs because chrome / audio / GSAP runner /
presenter input surfaces are not yet implemented.

PUL-F017 specifies `mode=scrub`:

> In `mode=scrub`, the runtime SHALL display timeline controls
> allowing the user to scrub forward, backward, and to named beats.
> Audio cues SHALL fire only on monotonic forward playback.

The non-trivial parts of that statement decompose this way:

- "Display timeline controls allowing the user to scrub forward,
  backward, and to named beats" — a workbench chrome surface that
  does not yet exist (parallel to ADR-016's pending presenter chrome
  / audio surfaces). The controls UI needs a transport API on the
  timeline runner (seek, scrub, play/pause), which depends on
  ADR-003's GSAP runner. Today the placeholder runner has no
  transport API. Mounting the seam (`ctx.mode === 'scrub'` reaching
  every lifecycle hook of the head scene) is what makes the future
  controls UI implementable without further contract changes.
- "Audio cues SHALL fire only on monotonic forward playback" — a
  runner-side contract: under `scrub`, the timeline runner MUST
  suppress audio cues whose time crossing was not produced by
  monotonic forward time progression. ADR-003's GSAP runner does
  not yet exist; the placeholder runner in `src/main.ts` has no real
  timeline (`scene.timeline(ctx)` returns `null`) and no audio
  engine (ADR-004's Howler integration is not yet implemented). With
  no cue ever fired, "audio cues fire only on monotonic forward
  playback" is vacuously satisfied today — but vacuous truth is not
  enforcement.

The question this ADR answers is: where does the loader → runner
contract for `mode=scrub` live, and on what contract does PUL-F017
transition to ACTIVE?

## Decision

### Scope: scrub is single-scene, explicitly

`mode=scrub` is **single-scene execution at the addressed head**, not
a composition-wide transport mode. PUL-F017's "the user can scrub
forward, backward, and to named beats" describes interaction with
ONE timeline; "named beats" are scene-scoped per ADR-015 and
PUL-F011. Composition-wide scrubbing (a unified transport across
multiple scenes' timelines) is explicitly out of scope: the runtime
has no cross-scene timeline abstraction, no cross-scene transport
API, and no manifest-level timeline aggregation — adding any of
those would be a wholly new architectural layer beyond what
PUL-F017 calls for. The user navigates to a specific scene to
scrub it.

The URL contract for "which scene to scrub" reuses the existing
PUL-F008 / ADR-014 locator shapes (PUL-F007 / ADR-013 grammar):

- `?scene=x&mode=scrub` — scrub scene `x` directly.
- `?composition=c&mode=scrub` — scrub the head scene of composition
  `c`.
- `?composition=c&scene=x&mode=scrub` — scrub scene `x` within
  composition `c`.
- `?composition=c&index=N&mode=scrub` — scrub the entry at index
  `N` within composition `c`.

To scrub a different scene in the same composition, the user
addresses that scene by id or index in a fresh URL — same pattern
the rest of the URL grammar uses for scene selection. The
composition context is preserved in `data-pulsar-composition-target`
so external observers (agents, screenshot tooling) see what URL
addressed, but execution stays scene-scoped because scrub's
interactive timeline does not hand off to following entries.

This single-scene scope is the same precedent ADR-019 already
establishes when it routes beat-targeted timeline inspection to
`mode=scrub` — beat is scene-scoped, so "scrub … to named beats" is
inherently scene-scoped too. The four single-scene-execution modes
(standalone / loop / paused / scrub) all share the same
slice-truncation transform because they all share the structural
"no following entries run" promise; they differ only in the head's
runner-side semantic.

### Plumbing

`mode=scrub` is dispatched at the loader (`src/runtime/scene-loader.ts`)
as a runner-input field forwarded to the timeline-runner adapter on
the head scene's run input only. When `effectiveMode(target) === 'scrub'`
the loader passes `cueGate: 'monotonic-forward'` through
`loadSceneNavigationTarget()` and the resolver to
`SceneTimelineRunInput.cueGate`.

The runner-side conformance bar is conditional but firm:

- A runner that schedules audio cues MUST fire each cue only on
  monotonic forward crossings of its trigger time when
  `input.cueGate === 'monotonic-forward'`. Backwards scrub,
  jump-to-beat, hydration, and direct seek MUST NOT produce
  cue-fire events. ADR-003's future GSAP runner enforces this by
  consulting GSAP's tween direction / progress delta / time-crossing
  semantics; the runtime-level SHALL in PUL-F017 ("audio cues SHALL
  fire only on monotonic forward playback") is delivered by
  combining loader mode dispatch + this runner-side MUST.
- A runner that does NOT have an audio-cue subsystem trivially
  satisfies the gate because no cues exist to fire. The placeholder
  timeline runner today is in this category — it has no real
  timeline and no audio engine, so "ignore the `cueGate` field" is
  correct conformance. ADR-004's audio engine PR is what introduces
  the consumer that activates the MUST.

This wording is intentionally tighter than ADR-018's `repeat` and
ADR-019's `hold` because PUL-F017's clause uses SHALL on a
behavior (cue firing) that has a concrete subsystem boundary
(audio). For `repeat` / `hold` every runner with a timeline can
honor the hint, so the conformance is uniform; for `cueGate`, only
runners with audio cues have a behavior to gate.

The "display timeline controls" clause is satisfied by a separate
workbench chrome surface beyond the runner. That surface reads
`ctx.mode === 'scrub'` (the seam established by PUL-F012 / ADR-007)
and renders forward / backward / named-beat controls that drive the
runner's transport API. The controls surface is gated on ADR-003's
GSAP runner landing AND that runner exposing a transport API the
controls can drive. Until both land, the seam is what this PR ships
to make the future controls surface implementable.

The hint is **head-only**. Under composition targets the slice's
first entry is the addressed scene; following composition entries
never receive `cueGate`. This scoping is structural: under scrub the
slice is truncated upstream so the head's interactive timeline does
not hand off to following entries. Forwarding `cueGate` to non-head
scenes would imply a following entry could itself run under scrub
semantics, which contradicts the requirement's single-timeline-
controls scoping. The plumbing is parallel to PUL-F011 / ADR-015's
`headBeat`, PUL-F015 / ADR-018's `headRepeat`, and PUL-F016 /
ADR-019's `headHold` head-only forwarding — same shape, different
field.

`SceneTimelineRunInput.cueGate` is declared as a literal-typed field
(`'monotonic-forward'`) rather than a boolean so future cue-gating
semantics (e.g., `'all-suppressed'` for deterministic frame capture
under `mode=screenshot`, or a future `'paused-aware'` variant) can
extend the union without breaking existing runners. A runner that
ignores the field, or that only recognizes `'monotonic-forward'`,
gracefully degrades to no-gating behavior (cues fire on every
crossing — i.e., default playback semantics). The resolver and
bridge do not interpret the value.

The slice IS **truncated** under `mode=scrub` to the addressed head
entry — the same shape transform `mode=standalone` (ADR-017),
`mode=loop` (ADR-018), and `mode=paused` (ADR-019) apply. Without
truncation, a runner that ignores `input.cueGate` (a placeholder, a
buggy GSAP wiring, a future test runner) would let the resolver
advance to the next composition entry and scrub-mode would silently
degrade into normal composition playback. That violates the
documented scrub guarantee: "timeline controls allowing the user to
scrub forward, backward, and to named beats" presupposes one
timeline; advancing to a following entry breaks that promise.

Truncating the slice makes "no following entries run" a structural
guarantee that does not depend on runner conformance. The four
single-scene-execution modes (`standalone`, `loop`, `paused`, and
`scrub`) share the same slice transform; they differ only in the
head's runner-side semantic — standalone plays normally, loop sets
`input.repeat = 'until-aborted'`, paused sets
`input.hold = 'first-frame'`, scrub sets
`input.cueGate = 'monotonic-forward'`. The shape transform is
shared because the structural promise ("no following entries run")
is identical; the runner-side behaviors live where they belong.

The slice is **truncated, not flattened.** Replacing the resolved
target with `{ scene }` (no composition) would lose the head entry's
per-entry `range` / `behavior` overrides (object-form entries per
ADR-002 / ADR-011), turning scrub into direct-scene flattening —
same foot-gun ADR-017 / ADR-018 / ADR-019 call out. The truncated
`manifestSlice` (length 1) continues through the composition branch
in `loadSceneNavigationTarget()`, and the existing runner-input
plumbing forwards `range` / `behavior` per ADR-011.

PUL-F017 stays DRAFT after this PR lands, mirroring the ADR-016 /
PUL-F013, ADR-017 / PUL-F014, ADR-018 / PUL-F015, and ADR-019 /
PUL-F016 precedent. This PR ships:

- The loader → runner-input contract: `cueGate: 'monotonic-forward'`
  reaches the head scene's run input under
  `effectiveMode === 'scrub'`.
- The seam: `ctx.mode === 'scrub'` reaches every lifecycle hook of
  the head scene through the existing PUL-F012 plumbing.
- Tests pinning the seam, the head-only scoping, the
  no-other-mode contamination, and the existing invariants under
  `scrub` (composition validation still runs; no
  `data-pulsar-mode-*` attribute; beat forwarding preserved;
  `range` / `behavior` overrides preserved).

What it does NOT yet ship is the active *monotonic-forward
cue-gating* behavior or the timeline-controls UI:

- ADR-003's GSAP runner is not implemented. The placeholder runner
  has no real timeline and no audio engine to gate cues against; it
  parks until abort. With no cue ever fired, the placeholder
  vacuously satisfies "audio cues fire only on monotonic forward
  playback" but cannot exercise the gate.
- ADR-004's Howler audio engine is not implemented. Audio cues
  themselves do not yet exist; the gate has no consumer.
- The workbench scrub-controls UI surface does not exist. The
  forward / backward / named-beat controls require a transport API
  on the runner that the GSAP runner has not yet exposed.

PUL-F017 transitions DRAFT → ACTIVE when ALL THREE hold:

1. ADR-003's GSAP runner lands AND it actively reads
   `input.cueGate === 'monotonic-forward'` and gates audio-cue
   firing by direction, with end-to-end tests showing backwards
   scrub, jump-to-beat, hydration, and direct seek do not fire
   cues while monotonic forward playback does.
2. ADR-004's audio engine lands so audio cues exist as a real
   subsystem the gate can constrain.
3. A workbench scrub-controls surface lands that reads
   `ctx.mode === 'scrub'` and renders forward / backward /
   named-beat controls driving the runner's transport API, with
   end-to-end tests of all three control modes.

Until all three land, the issue ↔ requirement link stays as
`DOCUMENTS` and PUL-F017 stays DRAFT — matching how ADR-016 /
PUL-F013, ADR-017 / PUL-F014, ADR-018 / PUL-F015, and ADR-019 /
PUL-F016 record "land the contract layer; keep the requirement
DRAFT until the dependent subsystems land."

### Boundary

The cue-gate hint flows from the loader because:

- The loader already derives `effectiveMode(target)` for `ctx.mode`
  (ADR-007 / PUL-F012). Reusing the same derivation for `cueGate`
  keeps mode-aware logic in one place — no second `target.mode`
  inspection on a different layer.
- The composition resolver MUST stay mode-opaque (ADR-011 — pure
  orchestrator, no adapter knowledge). The resolver plumbs
  `headCueGate` exactly the way it plumbs `headBeat`, `headRepeat`,
  and `headHold`: as an opaque forwarding field with no semantics
  it interprets. The loader is the only thing that maps
  `effectiveMode === 'scrub'` to `cueGate: 'monotonic-forward'`.
- `resolveSceneNavigation()` MUST run validation regardless of mode:
  unregistered compositions, unknown member scenes, ambiguous
  `composition+scene` locators, out-of-range indexes, and empty
  compositions still surface as navigation errors under
  `mode=scrub`. No silent fallback to direct scene lookup.
- `loadSceneNavigationTarget()` already plumbs head-only options
  (`beat` / `onBeatMissing` / `repeat` / `hold`); adding `cueGate`
  to that list reuses the same shape rather than inventing a new
  bridge surface.

### Stage attribute behavior

`data-pulsar-scene-target` (head scene id) AND
`data-pulsar-composition-target` (composition id) are both set on
the stage when the URL named a composition under `mode=scrub`. The
attrs communicate "what was addressed," not "what's running" — same
invariant as `mode=standalone` (ADR-017), `mode=loop` (ADR-018), and
`mode=paused` (ADR-019). No `data-pulsar-mode-*` suppression
attribute is preemptively written under `scrub` (parity with
ADR-016 / ADR-017 / ADR-018 / ADR-019); the future scrub-controls
UI surface is free to use that namespace if it actually needs a
stage-level signal.

### Beat semantics

`beat=` under `mode=scrub` is forwarded to the head scene's runner
unchanged. PUL-F017 explicitly names "to named beats" as part of
scrub's UX ("the user can scrub … to named beats"), so beat
forwarding is the natural scrub-to-beat path the future controls UI
will drive. The runner sees both `input.beat` and `input.cueGate`
on the same input bundle.

Unlike `mode=paused` — where ADR-019's runner-side policy is "first
frame wins" so the runner SHOULD ignore `input.beat` — `mode=scrub`
HONORS `input.beat` as the initial cursor position. The user's
first interaction with scrub controls is at that position;
subsequent forward / backward / jump-to-beat scrubbing replaces it.
The cue gate does not relax for the initial seek to the beat label:
the initial seek is a direct seek (not monotonic forward play), so
no cues fire even if the seek crossed cue trigger times. This is
the documented behavior the future GSAP runner pins.

Missing-label diagnostics surface via the existing non-fatal
`onBeatMissing` path (ADR-015): a URL like
`?scene=x&beat=does-not-exist&mode=scrub` does not unmount the
scene; the diagnostic appears on `data-pulsar-navigation-error` /
`onError` and the user lands at the timeline's first beat (the
default cursor position).

### Composition slice behavior

Truncated to the addressed head entry, parallel to `mode=standalone`
(ADR-017), `mode=loop` (ADR-018), and `mode=paused` (ADR-019). The
single-scene-execution helper at the loader is shared:
`applySingleSceneSlice` runs for all four modes (`standalone`,
`loop`, `paused`, `scrub`). Following composition entries do not
run; the head scene's `cueGate: 'monotonic-forward'` reaches the
runner input and the runner is responsible for the actual
monotonic-forward cue gating.

The composition slice MUST be validated by `resolveSceneNavigation()`
BEFORE the truncation transform. Unregistered compositions, unknown
member scenes, ambiguous `composition+scene` locators, and
out-of-range indexes still surface as navigation errors under
`mode=scrub` — the same invariant ADR-017 / ADR-018 / ADR-019 hold
for standalone, loop, and paused.

The bridge ALSO truncates a composition slice when `cueGate` is
supplied (`truncateToHead` shared with the `repeat` / `hold` paths)
— a structural defense layered with the loader's
`applySingleSceneSlice` so direct bridge callers (test harnesses,
future export pipelines) get the same scrub-mode single-scene-
execution guarantee. The two truncations are idempotent.

### UI controls scope

The "display timeline controls" clause IS in PUL-F017's scope — but
the controls UI is a workbench chrome surface that lives in a
follow-up PR alongside ADR-003's GSAP runner and ADR-004's audio
engine. Building the controls today against the placeholder runner
would either (a) build a chrome that does nothing because the
runner has no transport API to drive, or (b) add a runner transport
API ahead of ADR-003, which would constrain the future GSAP runner
to a contract chosen without a real timeline engine in front of us.

The seam (`ctx.mode === 'scrub'` reaching every lifecycle hook,
pinned by the seam test in this PR) is what makes the future
controls surface implementable. The chrome will read the seam,
mount its forward / backward / named-beat controls, and drive the
GSAP runner's transport API.

## Consequences

### Positive

- Mode → runner-input plumbing lives at the loader, the same place
  PUL-F012 derives `ctx.mode`, PUL-F015 derives `repeat`, and
  PUL-F016 derives `hold`. One mode dispatch site, not four.
- The resolver stays mode-opaque (ADR-011): `headCueGate` is plumbed
  the same way `headBeat`, `headRepeat`, and `headHold` already are,
  with no new resolver semantics.
- The runner contract is a single optional input field
  (`cueGate?: 'monotonic-forward'`). A runner that ignores it
  (placeholder, future non-scrub test runners) gracefully degrades;
  a runner that honors it (future GSAP) reads one field instead of
  inferring scrub semantics from `ctx.mode`.
- Following ADR-016 / ADR-017 / ADR-018 / ADR-019's precedent keeps
  the DRAFT → ACTIVE bar consistent across mode requirements:
  ACTIVE means the named behavior is actively delivered end to end,
  not just structurally scaffolded.
- No premature abstraction. No `ModePolicy` record, no shared
  mode-hint type, no policy table. When a future mode needs a
  different shape of runner hint, it adds its own field; if multiple
  modes converge on a shared representation, that representation
  lands then with at least two consumers informing its shape. The
  four single-scene-execution modes (standalone, loop, paused,
  scrub) share `applySingleSceneSlice` because they share a
  structural invariant, but they do NOT share a runner-input field
  — each owns its own (`repeat`, `hold`, `cueGate`, none).

### Negative

- PUL-F017 stays DRAFT until ADR-003's GSAP runner, ADR-004's audio
  engine, AND a scrub-controls UI surface all land. A reviewer
  reading the requirement in isolation may expect ACTIVE on first
  delivery; the DRAFT-with-contract-and-seams state is intentional
  and matches the PUL-F011 / PUL-F013 / PUL-F014 / PUL-F015 /
  PUL-F016 precedent.
- Adding `cueGate` to `SceneTimelineRunInput` widens the runner
  adapter surface. Every runner adapter (placeholder today, future
  GSAP, test harnesses) sees the new field. Test runners that don't
  care about scrub semantics ignore it; this is the cost of
  extending the input shape. The alternative (a separate runner
  parameter) would be larger surface, not smaller.
- The seam tests are necessary but not sufficient: they prove the
  hook exists and behaves correctly under `mode=scrub`, but they do
  not prove that a future GSAP runner will plug in correctly, that
  a future audio engine will respect the gate, or that a future
  controls UI will drive the runner correctly. The surface PRs
  that land each of those subsystems are responsible for adding
  their own end-to-end tests.

### Risks

| Risk | Mitigation |
|------|-----------|
| A future runner ignores `input.cueGate` and the regression goes unnoticed | The seam tests pin "loader sets `input.cueGate = 'monotonic-forward'` under `mode=scrub`." A runner that ignores the hint produces wrong runtime behavior (cues fire on backwards scrub). When the GSAP runner lands, its own end-to-end test proves the hint is honored. |
| `cueGate` accumulates as a kitchen-sink field for unrelated cue-gating semantics | The literal-typed union (`'monotonic-forward'`) constrains valid values. Adding a new variant (`'all-suppressed'`, `{ direction: 'forward', skipThreshold: 100 }`) is an explicit type extension, visible in code review. |
| Slice truncation flattens to direct-scene and loses object-form `range` / `behavior` overrides | The seam test "preserves the addressed head entry's `range` and `behavior` overrides on the runner input under `mode=scrub` (composition+index with object-form entry)" pins object-form head-entry plumbing through the truncated slice. A flatten-by-mistake would lose those overrides. |
| A runner that ignores `input.cueGate` silently degrades scrub into normal composition playback | Slice truncation makes "no following entries run" structural — a no-op runner under `mode=scrub` runs the head's lifecycle once and then completes the navigation, rather than advancing to a tail entry that should not have run. |
| PUL-F017 lingers DRAFT forever because the GSAP runner / audio engine / controls UI keep slipping | DRAFT is a feature here: it tells reviewers the scrub-mode contract is partly delivered (boundary + seam) and gates ACTIVE on actual cue gating + UI controls. The GSAP runner PR (ADR-003), the audio engine PR (ADR-004), and the future scrub-controls UI PR are the natural triggers to revisit PUL-F017's status. |
| A non-parser caller forges a `NavigationTarget` with `mode: 'scrub'` mid-flight | The defense-in-depth check `validateModeGrammar` already rejects unknown modes at the loader boundary; `'scrub'` is in the `NAVIGATION_MODES` allowlist, and `effectiveMode` is the only consumer of the field. |

## Current state (2026-05-09)

This PR delivers the contract boundary and seam-pinning layer:

- `src/runtime/composition-resolver.ts` — `SceneTimelineRunInput`
  gains optional `cueGate?: 'monotonic-forward'`;
  `ResolveCompositionOptions` gains optional `headCueGate?:
  'monotonic-forward'`; the resolver forwards `headCueGate` to
  plan[0]'s run input only.
- `src/runtime/scene-navigation.ts` —
  `LoadSceneNavigationTargetOptions` gains optional `cueGate?:
  'monotonic-forward'`; `loadSceneNavigationTarget()` forwards it to
  `resolveComposition` as `headCueGate`. The bridge truncates a
  composition slice when `cueGate` is supplied (the shared
  `truncateToHead` predicate fires when ANY of `repeat` / `hold` /
  `cueGate` is supplied).
- `src/runtime/scene-loader.ts` — when `effectiveMode(target) ===
  'scrub'`, the loader passes `cueGate: 'monotonic-forward'` through
  the bridge; otherwise the key is omitted (key-presence semantics).
  The single-scene-execution helper `applySingleSceneSlice` widens
  to include `'scrub'` so the slice is truncated to the addressed
  head under any of the four single-scene modes (standalone, loop,
  paused, scrub) — the SHAPE transform is shared, the runner-side
  semantic difference (`input.cueGate`) is what differentiates
  scrub from the others.
- `src/main.ts` — placeholder timeline runner docstring
  acknowledges `input.cueGate`. The placeholder ignores the hint;
  parking until abort vacuously satisfies "audio cues fire only on
  monotonic forward playback" because no cue ever fires. ADR-003's
  GSAP runner will read the hint and gate cues by direction.
- `tests/runtime/composition-resolver.test.ts` — new
  `'URL scrub-mode runner cue-gate-hint forwarding (PUL-F017)'`
  describe block.
- `tests/runtime/scene-navigation.test.ts` — new `'URL scrub-mode
  cue-gate forwarding (PUL-F017)'` describe block under
  `loadSceneNavigationTarget`.
- `tests/runtime/scene-loader.test.ts` — new `'scrub-mode runner
  cue-gate-hint forwarding (PUL-F017)'` describe block.
- `docs/design/pul-f017-scrub-mode-preflight.md` — codex
  architecture preflight design context (preserved from the
  preflight tool's returned summary; the codex sandbox failed to
  write design files during preflight, so the guardrails are
  reproduced verbatim — same handling pattern as
  `pul-f015-loop-mode-preflight.md` and
  `pul-f016-paused-mode-preflight.md`).
- This ADR.

PUL-F017 remains DRAFT. Issue #26 links to PUL-F017 via `DOCUMENTS`.
This PR is **not** an implementation of PUL-F017's "audio cues SHALL
fire only on monotonic forward playback" clause nor of the "display
timeline controls" clause — it lands the contract boundary and the
seam. The ACTIVE transition is gated on ADR-003's GSAP runner
honoring `input.cueGate`, ADR-004's audio engine providing real
cues, AND a workbench scrub-controls surface reading `ctx.mode ===
'scrub'` and driving the runner's transport API, each with
end-to-end tests alongside the seam tests in this PR. Treating this
PR as satisfying PUL-F017 would be a traceability/status mismatch.

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) — the timeline runner is
  the seam through which monotonic-forward cue gating will flow
  when the GSAP runner lands. Today the runner is a placeholder, so
  scrub behavior is structurally vacuous.
- [ADR-004](004-howler-audio-engine.md) — audio cues are the
  consumer of the cue gate. Today there is no audio engine, so the
  gate has no consumer.
- [ADR-007](007-browser-workbench.md) — defines the seven workbench
  modes and the URL-only-source invariant for mode selection.
  Specifically references `mode=scrub` as the timing/beat-alignment
  inspection mode.
- [ADR-008](008-agent-native-authoring.md) — manifests-over-flow-
  control underpins the no-mode-suppression-in-resolver constraint.
- [ADR-011](011-composition-resolver-orchestration.md) — the
  resolver is opaque to mode; mode-derived behavior lives at the
  adapters it forwards to. The resolver plumbs `headCueGate`
  unchanged, the same way it plumbs `headBeat`, `headRepeat`, and
  `headHold`.
- [ADR-013](013-url-navigation-grammar-boundary.md) — the parser
  preserves `mode` and forbids recovering it from any non-URL
  source.
- [ADR-014](014-url-scene-target-selection.md) — scene navigation
  dispatch is mode-blind; it resolves the active slice and hands
  off to the loader for mode dispatch.
- [ADR-015](015-url-beat-positioning.md) — precedent for "the
  resolver plumbs a head-only optional field; runner owns the
  semantics; loader fails fast at the paired-required boundary."
  ADR-020's `headCueGate` mirrors `headBeat`'s shape.
- [ADR-016](016-workbench-mode-present.md) — establishes the
  contract-layer-plus-seam-tests precedent. PUL-F013 stays DRAFT
  pending chrome / audio / GSAP runner / presenter input.
- [ADR-017](017-workbench-mode-standalone.md) — applies the same
  precedent to PUL-F014 with the slice-truncation seam.
- [ADR-018](018-workbench-mode-loop.md) — PUL-F015 shares the
  slice-truncation transform; runner-side semantic difference is
  `input.repeat`. ADR-020's `cueGate` is the same shape with a
  different literal value.
- [ADR-019](019-workbench-mode-paused.md) — PUL-F016 shares the
  slice-truncation transform; runner-side semantic difference is
  `input.hold`. ADR-019 explicitly names `mode=scrub` as the
  appropriate beat-targeting timeline-inspection mode (vs.
  paused's layout/styling inspection); PUL-F017's "to named beats"
  clause delivers on that delegation.
