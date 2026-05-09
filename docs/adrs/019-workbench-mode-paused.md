# ADR-019: Workbench Mode `paused` — Runner Hold-at-First-Frame Hint at the Loader/Runner Seam

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
and ADR-018 (`mode=loop`) establish the precedent for landing a
mode's contract layer plus seam tests while the dependent rendering
surfaces are still pending: PUL-F013, PUL-F014, and PUL-F015 all
stayed DRAFT after their respective contract PRs because chrome /
audio / GSAP runner / presenter input surfaces are not yet
implemented.

PUL-F016 specifies `mode=paused`:

> In `mode=paused`, the runtime SHALL mount the addressed scene and
> hold it at its first frame without advancing the timeline.

The non-trivial parts of that statement decompose this way:

- "Mount the addressed scene" — already structurally true via
  `loadSceneNavigationTarget()` and the existing scene-loader path.
  `scene.create(ctx)` runs normally; preload runs normally;
  `scene.timeline(ctx)` resolves to whatever the scene returns. No
  new code required for that clause.
- "Hold it at its first frame without advancing the timeline" — a
  runner-side contract: under `paused`, the timeline runner MUST
  render frame 0 and not advance. ADR-003's GSAP runner does not yet
  exist; the placeholder runner in `src/main.ts` has no real
  timeline (`scene.timeline(ctx)` returns `null`) and parks until
  abort. With no real timeline to advance, "hold at first frame
  without advancing" is vacuously satisfied today — but vacuous truth
  is not enforcement.

The question this ADR answers is: where does the loader → runner
contract for `mode=paused` live, and on what contract does PUL-F016
transition to ACTIVE?

## Decision

`mode=paused` is dispatched at the loader (`src/runtime/scene-loader.ts`)
as a runner-input field forwarded to the timeline-runner adapter on
the head scene's run input only. When `effectiveMode(target) === 'paused'`
the loader passes `hold: 'first-frame'` through
`loadSceneNavigationTarget()` and the resolver to
`SceneTimelineRunInput.hold`. The runner is responsible for honoring
the hint — ADR-003's future GSAP runner will seek to time 0 and call
`timeline.pause()` rather than allowing the timeline to advance, AND
will keep its returned promise pending until the per-navigation
`AbortSignal` fires.

The pending-until-abort part of the runner contract is structurally
load-bearing. `resolveComposition()` awaits `runTimeline()` and then
runs `cleanup(ctx)` (PUL-F006 / ADR-011 mandatory cleanup). A runner
that observes `input.hold === 'first-frame'`, calls
`timeline.seek(0)` + `timeline.pause()`, and resolves the promise
synchronously would cause the resolver to advance to cleanup one
turn after the scene mounted — the scene would unmount immediately,
contradicting the requirement's "hold." The placeholder runner
today already parks until abort (it has no timeline to advance and
no completion event to fire), so the placeholder's shape is the
correct stand-in. The GSAP runner's hold contract is therefore a
two-part rule: (1) under `hold === 'first-frame'`, freeze the
timeline at time 0 via the engine's native API, and (2) keep the
runner's promise pending until the navigation aborts (parallel to
how the placeholder treats every navigation today). End-to-end tests
in the GSAP runner PR will pin both clauses.

The hint is **head-only**. Under composition targets the slice's
first entry is the addressed scene; following composition entries
never receive `hold`. This scoping is structural: a paused head's
timeline never advances, so following entries cannot run. Forwarding
`hold` to non-head scenes would imply a following entry could itself
be held at frame 0, which contradicts the requirement's "the
addressed scene" scoping. The plumbing is parallel to PUL-F011 /
ADR-015's `headBeat` and PUL-F015 / ADR-018's `headRepeat` head-only
forwarding — same shape, different field.

`SceneTimelineRunInput.hold` is declared as a literal-typed field
(`'first-frame'`) rather than a boolean so future hold semantics
(e.g. `'final-frame'` for end-of-scene inspection, or a
deterministic-frame variant for screenshot mode) can extend the
union without breaking existing runners. A runner that ignores the
field, or that only recognizes `'first-frame'`, gracefully degrades
to no-hold behavior. The resolver and bridge do not interpret the
value.

The slice IS **truncated** under `mode=paused` to the addressed head
entry — the same shape transform `mode=standalone` (ADR-017) and
`mode=loop` (ADR-018) apply. Without truncation, a runner that
ignores `input.hold` (a placeholder, a buggy GSAP wiring, a future
test runner) would let the resolver advance to the next composition
entry and paused-mode would silently degrade into normal composition
playback. That violates the documented paused guarantee.

Truncating the slice makes "no following entries run" a structural
guarantee that does not depend on runner conformance. The three
single-scene-execution modes (`standalone`, `loop`, and `paused`)
share the same slice transform; they differ only in the head's
runner-side semantic — standalone plays normally, loop sets
`input.repeat = 'until-aborted'`, paused sets
`input.hold = 'first-frame'`. The shape transform is shared because
the structural promise ("no following entries run") is identical;
the runner-side behaviors live where they belong.

The slice is **truncated, not flattened.** Replacing the resolved
target with `{ scene }` (no composition) would lose the head entry's
per-entry `range` / `behavior` overrides (object-form entries per
ADR-002 / ADR-011), turning paused into direct-scene flattening —
same foot-gun ADR-017 / ADR-018 call out. The truncated
`manifestSlice` (length 1) continues through the composition branch
in `loadSceneNavigationTarget()`, and the existing runner-input
plumbing forwards `range` / `behavior` per ADR-011.

PUL-F016 stays DRAFT after this PR lands, mirroring the ADR-016 /
PUL-F013, ADR-017 / PUL-F014, and ADR-018 / PUL-F015 precedent. This
PR ships:

- The loader → runner-input contract: `hold: 'first-frame'` reaches
  the head scene's run input under `effectiveMode === 'paused'`.
- The seam: `ctx.mode === 'paused'` reaches every lifecycle hook of
  the head scene through the existing PUL-F012 plumbing.
- Tests pinning the seam, the head-only scoping, the
  no-other-mode contamination, and the existing invariants under
  `paused` (composition validation still runs; no
  `data-pulsar-mode-*` attribute; beat forwarding preserved;
  `range` / `behavior` overrides preserved).

What it does NOT yet ship is the active *hold-at-first-frame*
behavior:

- ADR-003's GSAP runner is not implemented. The placeholder runner
  has no real timeline to hold; it returns `null` from
  `scene.timeline(ctx)` and parks until abort. With no frame ever
  rendered, the placeholder vacuously satisfies "hold at first frame
  without advancing" but cannot exercise it. When the GSAP runner
  lands, it MUST read `input.hold === 'first-frame'` and seek to
  time 0 + pause the timeline (or equivalent native API).
  End-to-end tests of "the timeline does not advance" are gated on
  that surface landing.

PUL-F016 transitions DRAFT → ACTIVE when ADR-003's GSAP runner lands
AND it actively reads `input.hold === 'first-frame'` and pins the
timeline at time 0, with an end-to-end test alongside the seam tests
in this PR. Until then, the issue ↔ requirement link stays as
`DOCUMENTS` and the status stays DRAFT — matching how ADR-016 /
PUL-F013, ADR-017 / PUL-F014, and ADR-018 / PUL-F015 record "land
the contract layer; keep the requirement DRAFT until the dependent
subsystems land."

### Boundary

The hold hint flows from the loader because:

- The loader already derives `effectiveMode(target)` for `ctx.mode`
  (ADR-007 / PUL-F012). Reusing the same derivation for `hold`
  keeps mode-aware logic in one place — no second `target.mode`
  inspection on a different layer.
- The composition resolver MUST stay mode-opaque (ADR-011 — pure
  orchestrator, no adapter knowledge). The resolver plumbs
  `headHold` exactly the way it plumbs `headBeat` and `headRepeat`:
  as an opaque forwarding field with no semantics it interprets.
  The loader is the only thing that maps `effectiveMode === 'paused'`
  to `hold: 'first-frame'`.
- `resolveSceneNavigation()` MUST run validation regardless of mode:
  unregistered compositions, unknown member scenes, ambiguous
  `composition+scene` locators, out-of-range indexes, and empty
  compositions still surface as navigation errors under
  `mode=paused`. No silent fallback to direct scene lookup.
- `loadSceneNavigationTarget()` already plumbs head-only options
  (`beat` / `onBeatMissing` / `repeat`); adding `hold` to that list
  reuses the same shape rather than inventing a new bridge surface.

### Stage attribute behavior

`data-pulsar-scene-target` (head scene id) AND
`data-pulsar-composition-target` (composition id) are both set on
the stage when the URL named a composition under `mode=paused`. The
attrs communicate "what was addressed," not "what's running" — same
invariant as `mode=standalone` (ADR-017) and `mode=loop` (ADR-018).
No `data-pulsar-mode-*` suppression attribute is preemptively
written under `paused` (parity with ADR-016 / ADR-017 / ADR-018);
future workbench surfaces are free to use that namespace if they
actually need a stage-level signal.

### Beat semantics

There are two contracts here, owned by two layers:

**Loader contract.** `beat=` under `mode=paused` is forwarded to the
head scene's runner unchanged. The loader does NOT strip `beat`
when `mode=paused` is set — coupling those two URL parameters at
the loader would prevent a scene-author tool from reusing the same
beat parameter across `present` (full playback), `paused` (layout
review), and `scrub` (beat-targeted hold) without rewriting the
URL between modes. The runner sees both `input.beat` and
`input.hold` on the same input bundle.

**Runner contract.** ADR-019's runner-side policy is **first frame
wins**: when both `hold === 'first-frame'` and `beat` are present,
the runner SHOULD hold the timeline at frame 0 and SHOULD NOT seek
to the named label. Paused is a layout/styling-inspection mode,
not a beat-targeting mode. For beat-targeted timeline inspection,
`mode=scrub` is the appropriate mode; for deterministic frame
output for visual regression, `mode=screenshot` is the appropriate
mode. A hold-first runner therefore does not attempt label
resolution under paused, and consequently does NOT invoke
`onBeatMissing` even for an unknown beat — there is no
"missing-label" event because no seek was attempted. This means a
URL like `?scene=x&beat=does-not-exist&mode=paused` produces no
beat diagnostic from a conformant GSAP runner, by design. ADR-015's
"missing-label diagnostics surface non-fatally" applies to runners
that DO attempt label resolution; a runner that legitimately
chooses hold-over-seek does not have a missing-label event to
report.

Today's placeholder runner has no real timeline at all and does
invoke `onBeatMissing` for any supplied beat (because every label
is "missing" in a no-label timeline). That is honest within the
placeholder's no-real-timeline world but is not the contract the
GSAP runner will follow: when the GSAP runner lands, it will read
`hold` first and skip beat resolution under paused. Tests under
this PR forward `beat` and `hold` together to prove the loader
forwards both unchanged; they do not pin the runner-side
hold-wins policy because the placeholder runner does not implement
it. The GSAP runner PR will add tests for the runner-side policy
alongside its end-to-end paused tests.

### Composition slice behavior

Truncated to the addressed head entry, parallel to `mode=standalone`
(ADR-017) and `mode=loop` (ADR-018). The single-scene-execution
helper at the loader is shared: `applySingleSceneSlice` runs for
all three modes (`standalone`, `loop`, `paused`). Following
composition entries do not run; the head scene's
`hold: 'first-frame'` reaches the runner input and the runner is
responsible for the actual hold-at-first-frame behavior.

The composition slice MUST be validated by `resolveSceneNavigation()`
BEFORE the truncation transform. Unregistered compositions, unknown
member scenes, ambiguous `composition+scene` locators, and
out-of-range indexes still surface as navigation errors under
`mode=paused` — the same invariant ADR-017 / ADR-018 hold for
standalone and loop.

The bridge ALSO truncates a composition slice when `hold` is
supplied (`truncateToHead` shared with the `repeat` path) — a
structural defense layered with the loader's `applySingleSceneSlice`
so direct bridge callers (test harnesses, future export pipelines)
get the same paused-mode single-scene-execution guarantee. The two
truncations are idempotent.

## Consequences

### Positive

- Mode → runner-input plumbing lives at the loader, the same place
  PUL-F012 derives `ctx.mode` and PUL-F015 derives `repeat`. One
  mode dispatch site, not three.
- The resolver stays mode-opaque (ADR-011): `headHold` is plumbed
  the same way `headBeat` and `headRepeat` already are, with no new
  resolver semantics.
- The runner contract is a single optional input field
  (`hold?: 'first-frame'`). A runner that ignores it (placeholder,
  future non-paused test runners) gracefully degrades; a runner that
  honors it (future GSAP) reads one field instead of inferring
  paused semantics from `ctx.mode`.
- Following ADR-016 / ADR-017 / ADR-018's precedent keeps the DRAFT
  → ACTIVE bar consistent across mode requirements: ACTIVE means the
  named behavior is actively delivered end to end, not just
  structurally scaffolded.
- No premature abstraction. No `ModePolicy` record, no shared
  mode-hint type, no policy table. When a future mode needs a
  different shape of runner hint, it adds its own field; if multiple
  modes converge on a shared representation, that representation
  lands then with at least two consumers informing its shape. The
  three single-scene-execution modes (standalone, loop, paused)
  share `applySingleSceneSlice` because they share a structural
  invariant, but they do NOT share a runner-input field — each owns
  its own (`repeat`, `hold`, none).

### Negative

- PUL-F016 stays DRAFT until ADR-003's GSAP runner lands. A
  reviewer reading the requirement in isolation may expect ACTIVE on
  first delivery; the DRAFT-with-contract-and-seams state is
  intentional and matches the PUL-F011 / PUL-F013 / PUL-F014 /
  PUL-F015 precedent.
- Adding `hold` to `SceneTimelineRunInput` widens the runner adapter
  surface. Every runner adapter (placeholder today, future GSAP,
  test harnesses) sees the new field. Test runners that don't care
  about paused semantics ignore it; this is the cost of extending
  the input shape. The alternative (a separate runner parameter)
  would be larger surface, not smaller.
- The seam tests are necessary but not sufficient: they prove the
  hook exists and behaves correctly under `mode=paused`, but they
  do not prove that a future GSAP runner will plug in correctly.
  The surface PR that lands the GSAP runner is responsible for
  adding its own end-to-end "the timeline does not advance under
  `mode=paused`" test.
- The documented "first frame wins" runner-side policy for
  `beat` × `hold` combinations is not exercised by any test in this
  PR — the placeholder runner has no real timeline and no real beat
  resolution, so the policy is an ADR-level contract that the
  future GSAP runner PR will pin with its own tests.

### Risks

| Risk | Mitigation |
|------|-----------|
| A future runner ignores `input.hold` and the regression goes unnoticed | The seam tests pin "loader sets `input.hold = 'first-frame'` under `mode=paused`." A runner that ignores the hint produces wrong runtime behavior (timeline advances). When the GSAP runner lands, its own end-to-end test proves the hint is honored. |
| `hold` accumulates as a kitchen-sink field for unrelated hold semantics | The literal-typed union (`'first-frame'`) constrains valid values. Adding a new variant (`'final-frame'`, `{ frame: N }`) is an explicit type extension, visible in code review. |
| Slice truncation flattens to direct-scene and loses object-form `range` / `behavior` overrides | The seam test "preserves the addressed head entry's `range` and `behavior` overrides under `mode=paused` (composition+index with object-form entry)" pins object-form head-entry plumbing through the truncated slice. A flatten-by-mistake would lose those overrides. |
| A runner that ignores `input.hold` silently degrades paused into normal composition playback | Slice truncation makes "no following entries run" structural — a no-op runner under `mode=paused` runs the head's lifecycle once and then completes the navigation, rather than advancing to a tail entry that should not have run. |
| PUL-F016 lingers DRAFT forever because the GSAP runner keeps slipping | DRAFT is a feature here: it tells reviewers the paused-mode contract is partly delivered (boundary + seam) and gates ACTIVE on actual hold-at-first-frame. The GSAP runner PR (ADR-003) is the natural trigger to revisit PUL-F016's status. |
| A non-parser caller forges a `NavigationTarget` with `mode: 'paused'` mid-flight | The defense-in-depth check `validateModeGrammar` already rejects unknown modes at the loader boundary; `'paused'` is in the `NAVIGATION_MODES` allowlist, and `effectiveMode` is the only consumer of the field. |
| `paused` and `screenshot` get conflated as "freeze the timeline" modes | ADR-019's beat-semantics section records the boundary: paused is layout/styling inspection (frame 0); screenshot is deterministic regression output (a specific frame chosen for determinism); scrub is beat-targeted timeline inspection. Each mode owns its own runner-input field and its own ADR. |

## Current state (2026-05-09)

This PR delivers the contract boundary and seam-pinning layer:

- `src/runtime/composition-resolver.ts` — `SceneTimelineRunInput`
  gains optional `hold?: 'first-frame'`;
  `ResolveCompositionOptions` gains optional `headHold?:
  'first-frame'`; the resolver forwards `headHold` to plan[0]'s
  run input only.
- `src/runtime/scene-navigation.ts` —
  `LoadSceneNavigationTargetOptions` gains optional `hold?:
  'first-frame'`; `loadSceneNavigationTarget()` forwards it to
  `resolveComposition` as `headHold`. The previous
  `truncateForRepeat` helper is renamed to a shared
  `truncateToHead` predicate that fires when EITHER `repeat` or
  `hold` is supplied — the shape transform is the same; the
  predicate is wider.
- `src/runtime/scene-loader.ts` — when `effectiveMode(target) ===
  'paused'`, the loader passes `hold: 'first-frame'` through the
  bridge; otherwise the key is omitted (key-presence semantics).
  The `applySingleSceneSlice` helper that ADR-017 introduced and
  ADR-018 extended is widened again to include `paused` so the
  slice is truncated to the addressed head under any of the three
  single-scene-execution modes — the SHAPE transform is shared, the
  runner-side semantic differences (`input.repeat` vs `input.hold`
  vs neither) are what differentiate them.
- `src/main.ts` — placeholder timeline runner docstring
  acknowledges `input.hold`. The placeholder ignores the hint;
  parking until abort vacuously satisfies "hold at first frame
  without advancing" because no frame ever advances. ADR-003's
  GSAP runner will read the hint and call `timeline.pause()`.
- `tests/runtime/composition-resolver.test.ts` — new
  `'URL paused-mode runner hold-hint forwarding (PUL-F016)'`
  describe block.
- `tests/runtime/scene-navigation.test.ts` — new `'URL paused-mode
  hold forwarding (PUL-F016)'` describe block under
  `loadSceneNavigationTarget`.
- `tests/runtime/scene-loader.test.ts` — new `'paused-mode runner
  hold-hint forwarding (PUL-F016)'` describe block.
- `docs/design/pul-f016-paused-mode-preflight.md` — codex
  architecture preflight design context (preserved here as the
  binding plan constraints for follow-on work).
- This ADR.

PUL-F016 remains DRAFT. Issue #25 links to PUL-F016 via `DOCUMENTS`.
This PR is **not** an implementation of PUL-F016's "hold at first
frame without advancing" clause — it lands the contract boundary
and the seam. The ACTIVE transition is gated on ADR-003's GSAP
runner replacing the placeholder in `src/main.ts` AND actively
reading `input.hold === 'first-frame'` to pin the timeline at time
0, with an end-to-end test alongside these seam tests. Treating
this PR as satisfying PUL-F016 would be a traceability/status
mismatch.

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) — the timeline runner is
  the seam through which hold-at-first-frame will flow when the
  GSAP runner lands. Today the runner is a placeholder, so paused
  behavior is structurally vacuous.
- [ADR-007](007-browser-workbench.md) — defines the seven workbench
  modes and the URL-only-source invariant for mode selection.
- [ADR-008](008-agent-native-authoring.md) — manifests-over-flow-
  control underpins the no-mode-suppression-in-resolver constraint.
- [ADR-011](011-composition-resolver-orchestration.md) — the
  resolver is opaque to mode; mode-derived behavior lives at the
  adapters it forwards to. The resolver plumbs `headHold`
  unchanged, the same way it plumbs `headBeat` and `headRepeat`.
- [ADR-013](013-url-navigation-grammar-boundary.md) — the parser
  preserves `mode` and forbids recovering it from any non-URL
  source.
- [ADR-014](014-url-scene-target-selection.md) — scene navigation
  dispatch is mode-blind; it resolves the active slice and hands
  off to the loader for mode dispatch.
- [ADR-015](015-url-beat-positioning.md) — precedent for "the
  resolver plumbs a head-only optional field; runner owns the
  semantics; loader fails fast at the paired-required boundary."
  ADR-019's `headHold` mirrors `headBeat`'s shape. ADR-019 also
  records the runner-side policy that `hold` wins over `beat` when
  both are supplied under `mode=paused`.
- [ADR-016](016-workbench-mode-present.md) — establishes the
  contract-layer-plus-seam-tests precedent. PUL-F013 stays DRAFT
  pending chrome / audio / GSAP runner / presenter input.
- [ADR-017](017-workbench-mode-standalone.md) — applies the same
  precedent to PUL-F014 with the slice-truncation seam. ADR-019
  shares that slice-truncation transform — the loader runs
  `applySingleSceneSlice` for all three of `standalone`, `loop`,
  and `paused` so "no following entries run" is a structural
  guarantee, not runner-conformance-dependent.
- [ADR-018](018-workbench-mode-loop.md) — applies the same
  precedent to PUL-F015 with the `repeat` runner-input hint and
  bridge-level slice truncation. ADR-019's `headHold` and the
  shared `truncateToHead` helper are direct extensions of the
  loop-mode contract.
