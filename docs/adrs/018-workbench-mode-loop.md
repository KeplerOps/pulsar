# ADR-018: Workbench Mode `loop` — Runner Repeat Hint at the Loader/Runner Seam

## Status

Accepted

## Date

2026-05-09

## Context

ADR-007 names eight workbench modes: `present`, `standalone`, `loop`,
`paused`, `scrub`, `screenshot`, `prompter`, `rehearsal`. ADR-013 fixes the URL
grammar boundary that carries `mode=` to the runtime. ADR-014 fixes the
scene navigation dispatch layer. ADR-015 fixes URL beat positioning.
ADR-016 establishes the precedent for landing a mode's contract while
the dependent rendering surfaces are still pending: PUL-F013 stayed
DRAFT because chrome / audio / GSAP runner / presenter input surfaces
are not yet implemented. ADR-017 follows the same precedent for
PUL-F014 (`mode=standalone`): single-scene execution at the loader
ships materially, the seam (`ctx.mode === 'standalone'`) is pinned, and
the requirement stays DRAFT until each named suppression facet has a
real surface that actively conforms.

PUL-F015 specifies `mode=loop`:

> In `mode=loop`, the runtime SHALL run the addressed scene's timeline
> and restart it on completion.

The non-trivial parts of that statement decompose this way:

- "Run the addressed scene's timeline" — already structurally true
  via `loadSceneNavigationTarget()` and the runner adapter
  (`SceneTimelineRunner`). No new code required for that clause.
- "Restart it on completion" — a runner-side contract: the timeline
  runner repeats the timeline until the navigation aborts or
  disposes. ADR-003's GSAP runner does not yet exist; the placeholder
  runner in `src/main.ts` has no real timeline (`scene.timeline(ctx)`
  returns `null`) and parks until abort. With no natural completion
  to fire, "restart on completion" is vacuously satisfied today —
  but vacuous truth is not enforcement.

The question this ADR answers is: where does the loader → runner
contract for `mode=loop` live, and on what contract does PUL-F015
transition to ACTIVE?

## Decision

`mode=loop` is dispatched at the loader (`src/runtime/scene-loader.ts`)
as a runner-input field forwarded to the timeline-runner adapter on
the head scene's run input only. When `effectiveMode(target) === 'loop'`
the loader passes `repeat: 'until-aborted'` through
`loadSceneNavigationTarget()` and the resolver to
`SceneTimelineRunInput.repeat`. The runner is responsible for honoring
the hint — ADR-003's future GSAP runner will use GSAP's native repeat
(e.g. `timeline.repeat(-1)`) rather than a polling / `setInterval` /
recursive-`handle()` loop the loader would have had to invent.

The hint is **head-only**. Under composition targets the slice's first
entry is the addressed scene; following composition entries never
receive `repeat`. This scoping is structural: a looping head's
timeline never naturally completes, so following entries cannot run.
Forwarding `repeat` to non-head scenes would imply a following entry
could itself loop, which contradicts the requirement's "the addressed
scene's timeline" scoping. The plumbing is parallel to PUL-F011 /
ADR-015's `headBeat` head-only forwarding — same shape, different
field.

`SceneTimelineRunInput.repeat` is declared as a literal-typed field
(`'until-aborted'`) rather than a boolean so future repeat semantics
(e.g. a fixed-iteration variant) can extend the union without breaking
existing runners. A runner that ignores the field, or that only
recognizes `'until-aborted'`, gracefully degrades to no-repeat
behavior. The resolver and bridge do not interpret the value.

The slice IS **truncated** under `mode=loop` to the addressed head
entry — the same shape transform `mode=standalone` applies (ADR-017).
This was contested in pre-push review: the original draft of this ADR
relied on the runner's repeat behavior alone for "no following entries
run." Codex's pre-push pass flagged the foot-gun: if the runner
ignores `input.repeat` (a placeholder, a buggy GSAP wiring, a future
test runner), the resolver advances to the next composition entry and
loop silently degrades into normal composition playback. That violates
the documented loop guarantee.

Truncating the slice makes "no following entries run" a structural
guarantee that does not depend on runner conformance. The two single-
scene-execution modes (`standalone` and `loop`) share the same slice
transform; they differ only in whether the head's timeline repeats —
a runner-side concern via `input.repeat`. Conflating the two modes
into one shape transform is appropriate because the SHAPE is
identical; the SEMANTIC difference (timeline repeat) lives at the
runner contract where it belongs.

The slice is **truncated, not flattened.** Replacing the resolved
target with `{ scene }` (no composition) would lose the head entry's
per-entry `range` / `behavior` overrides (object-form entries per
ADR-002 / ADR-011), turning loop into direct-scene flattening — same
foot-gun ADR-017 calls out for standalone. The truncated
`manifestSlice` (length 1) continues through the composition branch
in `loadSceneNavigationTarget()`, and the existing runner-input
plumbing forwards `range` / `behavior` per ADR-011.

PUL-F015 stays DRAFT after this PR lands, mirroring the ADR-016 /
PUL-F013 and ADR-017 / PUL-F014 precedent. This PR ships:

- The loader → runner-input contract: `repeat: 'until-aborted'`
  reaches the head scene's run input under `effectiveMode === 'loop'`.
- The seam: `ctx.mode === 'loop'` reaches every lifecycle hook of the
  head scene through the existing PUL-F012 plumbing.
- Tests pinning the seam, the head-only scoping, the no-other-mode
  contamination, and the existing invariants under `loop` (composition
  validation still runs; no `data-pulsar-mode-*` attribute; beat
  forwarding preserved; `range` / `behavior` overrides preserved).

What it does NOT yet ship is the active *restart-on-completion*
behavior:

- ADR-003's GSAP runner is not implemented. The placeholder runner
  has no real timeline to repeat; it returns `null` from
  `scene.timeline(ctx)` and parks until abort. With no natural
  completion event, the placeholder vacuously satisfies "restart on
  completion" but cannot exercise it. When the GSAP runner lands, it
  MUST read `input.repeat === 'until-aborted'` and apply the engine's
  native repeat semantics. End-to-end tests of "the timeline does
  restart" are gated on that surface landing.

PUL-F015 transitions DRAFT → ACTIVE when ADR-003's GSAP runner lands
AND it actively reads `input.repeat === 'until-aborted'` and restarts
the timeline, with an end-to-end test alongside the seam tests in this
PR. Until then, the issue ↔ requirement link stays as `DOCUMENTS` and
the status stays DRAFT — matching how ADR-016 / PUL-F013 records "land
the contract layer; keep the requirement DRAFT until the dependent
subsystems land."

### Boundary

The repeat hint flows from the loader because:

- The loader already derives `effectiveMode(target)` for `ctx.mode`
  (ADR-007 / PUL-F012). Reusing the same derivation for `repeat`
  keeps mode-aware logic in one place — no second `target.mode`
  inspection on a different layer.
- The composition resolver MUST stay mode-opaque (ADR-011 — pure
  orchestrator, no adapter knowledge). The resolver plumbs
  `headRepeat` exactly the way it plumbs `headBeat`: as an opaque
  forwarding field with no semantics it interprets. The loader is
  the only thing that maps `effectiveMode === 'loop'` to
  `repeat: 'until-aborted'`.
- `resolveSceneNavigation()` MUST run validation regardless of mode:
  unregistered compositions, unknown member scenes, ambiguous
  `composition+scene` locators, out-of-range indexes, and empty
  compositions still surface as navigation errors under `mode=loop`.
  No silent fallback to direct scene lookup.
- `loadSceneNavigationTarget()` already plumbs head-only options
  (`beat` / `onBeatMissing`); adding `repeat` to that list reuses
  the same shape rather than inventing a new bridge surface.

### Stage attribute behavior

`data-pulsar-scene-target` (head scene id) AND
`data-pulsar-composition-target` (composition id) are both set on the
stage when the URL named a composition under `mode=loop`. The attrs
communicate "what was addressed," not "what's running" — same
invariant as `mode=standalone` (ADR-017). No `data-pulsar-mode-*`
suppression attribute is preemptively written under `loop` (parity
with ADR-016 / ADR-017); future workbench surfaces are free to use
that namespace if they actually need a stage-level signal.

### Beat semantics

`beat=` under `mode=loop` is forwarded to the head scene's runner
unchanged. The runner sees both `input.beat` and `input.repeat` on
the same input bundle and is free to honor them independently — for a
GSAP runner, that is "seek to label, then play with repeat(-1)."
Missing-label diagnostics surface via the existing non-fatal
`onBeatMissing` path (ADR-015).

### Composition slice behavior

Truncated to the addressed head entry, parallel to `mode=standalone`
(ADR-017). The single-scene-execution helper at the loader is shared:
`applySingleSceneSlice` runs for both `effectiveMode === 'standalone'`
and `effectiveMode === 'loop'`. Following composition entries do not
run; the head scene's `repeat: 'until-aborted'` reaches the runner
input and the runner is responsible for the actual restart-on-
completion behavior.

The composition slice MUST be validated by `resolveSceneNavigation()`
BEFORE the truncation transform. Unregistered compositions, unknown
member scenes, ambiguous `composition+scene` locators, and out-of-
range indexes still surface as navigation errors under `mode=loop` —
the same invariant ADR-017 holds for standalone.

## Consequences

### Positive

- Mode → runner-input plumbing lives at the loader, the same place
  PUL-F012 derives `ctx.mode`. One mode dispatch site, not two.
- The resolver stays mode-opaque (ADR-011): `headRepeat` is plumbed
  the same way `headBeat` already is, with no new resolver semantics.
- The runner contract is a single optional input field (`repeat?:
  'until-aborted'`). A runner that ignores it (placeholder, future
  non-loop test runners) gracefully degrades; a runner that honors it
  (future GSAP) reads one field instead of inferring loop semantics
  from `ctx.mode`.
- Following ADR-016 / ADR-017's precedent keeps the DRAFT → ACTIVE
  bar consistent across mode requirements: ACTIVE means the named
  behavior is actively delivered end to end, not just structurally
  scaffolded.
- No premature abstraction. No `ModePolicy` record, no shared
  mode-hint type, no policy table. When a future mode needs a
  different shape of runner hint, it adds its own field; if multiple
  modes converge on a shared representation, that representation
  lands then with at least two consumers informing its shape.

### Negative

- PUL-F015 stays DRAFT until ADR-003's GSAP runner lands. A reviewer
  reading the requirement in isolation may expect ACTIVE on first
  delivery; the DRAFT-with-contract-and-seams state is intentional
  and matches the PUL-F011 / PUL-F013 / PUL-F014 precedent.
- Adding `repeat` to `SceneTimelineRunInput` widens the runner
  adapter surface. Every runner adapter (placeholder today, future
  GSAP, test harnesses) sees the new field. Test runners that don't
  care about loop semantics ignore it; this is the cost of
  extending the input shape. The alternative (a separate runner
  parameter) would be larger surface, not smaller.
- The seam tests are necessary but not sufficient: they prove the
  hook exists and behaves correctly under `mode=loop`, but they do
  not prove that a future GSAP runner will plug in correctly. The
  surface PR that lands the GSAP runner is responsible for adding
  its own end-to-end "the timeline restarts under `mode=loop`" test.

### Risks

| Risk | Mitigation |
|------|-----------|
| A future runner ignores `input.repeat` and the regression goes unnoticed | The seam tests pin "loader sets `input.repeat = 'until-aborted'` under `mode=loop`." A runner that ignores the hint produces wrong runtime behavior (no loop). When the GSAP runner lands, its own end-to-end test proves the hint is honored. |
| `repeat` accumulates as a kitchen-sink field for unrelated repeat semantics | The literal-typed union (`'until-aborted'`) constrains valid values. Adding a new variant (`'twice'`, `{ count: 5 }`) is an explicit type extension, visible in code review. |
| Slice truncation flattens to direct-scene and loses object-form `range` / `behavior` overrides | The seam test "preserves the addressed head entry's `range` and `behavior` overrides under `mode=loop` (composition+index with object-form entry)" pins object-form head-entry plumbing through the truncated slice. A flatten-by-mistake would lose those overrides. |
| A runner that ignores `input.repeat` silently degrades loop into normal composition playback | Slice truncation makes "no following entries run" structural — a no-op runner under `mode=loop` runs the head's lifecycle once and then completes the navigation, rather than advancing to a tail entry that should not have run. |
| PUL-F015 lingers DRAFT forever because the GSAP runner keeps slipping | DRAFT is a feature here: it tells reviewers the loop-mode contract is partly delivered (boundary + seam) and gates ACTIVE on actual restart-on-completion. The GSAP runner PR (ADR-003) is the natural trigger to revisit PUL-F015's status. |
| A non-parser caller forges a `NavigationTarget` with `mode: 'loop'` mid-flight | The defense-in-depth check `validateModeGrammar` already rejects unknown modes at the loader boundary; `'loop'` is in the `NAVIGATION_MODES` allowlist, and `effectiveMode` is the only consumer of the field. |

## Current state (2026-05-09)

This PR delivers the contract boundary and seam-pinning layer:

- `src/runtime/composition-resolver.ts` — `SceneTimelineRunInput`
  gains optional `repeat?: 'until-aborted'`;
  `ResolveCompositionOptions` gains optional `headRepeat?:
  'until-aborted'`; the resolver forwards `headRepeat` to plan[0]'s
  run input only.
- `src/runtime/scene-navigation.ts` —
  `LoadSceneNavigationTargetOptions` gains optional `repeat?:
  'until-aborted'`; `loadSceneNavigationTarget()` forwards it to
  `resolveComposition` as `headRepeat`.
- `src/runtime/scene-loader.ts` — when `effectiveMode(target) ===
  'loop'`, the loader passes `repeat: 'until-aborted'` through the
  bridge; otherwise the key is omitted (key-presence semantics).
  The single-scene-execution helper that ADR-017 introduced is
  generalized (`applySingleSceneSlice`) and runs for both `standalone`
  and `loop` so the slice is truncated to the addressed head under
  either mode — the SHAPE transform is shared, the runner-side
  semantic difference (`input.repeat`) is what differentiates them.
- `tests/runtime/composition-resolver.test.ts` — new
  `'URL loop-mode runner repeat-hint forwarding (PUL-F015)'`
  describe block.
- `tests/runtime/scene-navigation.test.ts` — new `'URL loop-mode
  repeat forwarding (PUL-F015)'` describe block under
  `loadSceneNavigationTarget`.
- `tests/runtime/scene-loader.test.ts` — new `'loop-mode runner
  repeat-hint forwarding (PUL-F015)'` describe block.
- `docs/design/pul-f015-loop-mode-preflight.md` — codex
  architecture preflight design context (created by preflight,
  preserved here as the binding plan constraints for follow-on
  work).
- This ADR.

PUL-F015 remains DRAFT. Issue #24 links to PUL-F015 via `DOCUMENTS`.
This PR is **not** an implementation of PUL-F015's "restart on
completion" clause — it lands the contract boundary and the seam.
The ACTIVE transition is gated on ADR-003's GSAP runner replacing the
placeholder in `src/main.ts` AND actively reading `input.repeat ===
'until-aborted'` to drive timeline repeat semantics, with an
end-to-end test alongside these seam tests. Treating this PR as
satisfying PUL-F015 would be a traceability/status mismatch.

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) — the timeline runner is
  the seam through which restart-on-completion will flow when the
  GSAP runner lands. Today the runner is a placeholder, so loop
  behavior is structurally vacuous.
- [ADR-007](007-browser-workbench.md) — defines the eight workbench
  modes and the URL-only-source invariant for mode selection.
- [ADR-008](008-agent-native-authoring.md) — manifests-over-flow-
  control underpins the no-mode-suppression-in-resolver constraint.
- [ADR-011](011-composition-resolver-orchestration.md) — the
  resolver is opaque to mode; mode-derived behavior lives at the
  adapters it forwards to. The resolver plumbs `headRepeat`
  unchanged, the same way it plumbs `headBeat`.
- [ADR-013](013-url-navigation-grammar-boundary.md) — the parser
  preserves `mode` and forbids recovering it from any non-URL
  source.
- [ADR-014](014-url-scene-target-selection.md) — scene navigation
  dispatch is mode-blind; it resolves the active slice and hands
  off to the loader for mode dispatch.
- [ADR-015](015-url-beat-positioning.md) — precedent for "the
  resolver plumbs a head-only optional field; runner owns the
  semantics; loader fails fast at the paired-required boundary."
  ADR-018's `headRepeat` mirrors `headBeat`'s shape.
- [ADR-016](016-workbench-mode-present.md) — establishes the
  contract-layer-plus-seam-tests precedent. PUL-F013 stays DRAFT
  pending chrome / audio / GSAP runner / presenter input.
- [ADR-017](017-workbench-mode-standalone.md) — applies the same
  precedent to PUL-F014 with the slice-truncation seam. PUL-F015
  shares that slice-truncation transform — the loader runs
  `applySingleSceneSlice` for both `standalone` and `loop` so
  "no following entries run" is a structural guarantee, not
  runner-conformance-dependent. The two modes differ only in
  whether the head's timeline repeats (a runner-side concern via
  `input.repeat`).
