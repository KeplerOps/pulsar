# ADR-017: Workbench Mode `standalone` — Single-Scene Execution at the Loader

## Status

Accepted

## Date

2026-05-09

## Context

ADR-007 names eight workbench modes: `present`, `standalone`, `loop`,
`paused`, `scrub`, `screenshot`, `prompter`, `rehearsal`. ADR-013 fixes the URL
grammar boundary that carries `mode=` to the runtime. ADR-014 fixes
the scene navigation dispatch layer that turns a `NavigationTarget`
into a runnable scene/slice. ADR-015 fixes URL beat positioning.
ADR-016 establishes the pattern for landing a mode's contract while
the dependent rendering surfaces are still pending: PUL-F013 stayed
DRAFT because chrome / audio / GSAP runner / presenter input
surfaces are not yet implemented.

PUL-F014 specifies `mode=standalone`: in this mode the runtime
SHALL render a single scene with surrounding chrome, inter-scene
transitions, and audio bed suppressed; the scene SHALL run as if no
surrounding composition existed.

The non-trivial parts of that statement are operational *today* —
unlike PUL-F013, which depends on subsystems that do not yet exist
to render the suppressed facets.

- "Render a single scene" — the loader can already drive a one-entry
  manifest through the existing single-scene branch in
  `loadSceneNavigationTarget`.
- "Inter-scene transitions suppressed" — the runtime has no inter-
  scene-transition rendering today (ADR-003 reserves the GSAP runner
  for that). Under standalone there is no second scene in the
  navigation queue, so no transition runs. The suppression is
  *structural* — it follows from single-scene execution rather than
  from a runner flag.
- "Run as if no surrounding composition existed" — the loader drops
  the validated composition slice and runs only the addressed head
  scene's lifecycle.
- "Surrounding chrome suppressed" / "audio bed suppressed" — neither
  surface exists in this repo today. A future workbench-shell
  requirement and a future audio-service requirement (per ADR-004)
  will land them. They will read `ctx.mode` at their own seam to
  decide whether to render. Today there is nothing to suppress.

The question this ADR answers is: where does `mode=standalone`
slice from a composition target down to a single-scene execution,
and on what contract does PUL-F014 transition to ACTIVE?

## Decision

`mode=standalone` is dispatched at the loader (`src/runtime/scene-loader.ts`)
as a slice transform on the already-validated `SceneNavigationTarget`
produced by `resolveSceneNavigation()`. When `effectiveMode(target) ===
'standalone'` and the resolved target carries a composition slice, the
loader **truncates** the slice to a single entry — the addressed head —
before constructing the in-flight load. The truncated slice preserves
the original head entry verbatim (object-form `{ id, range, behavior }`
entries stay object-form; bare-string entries stay bare strings) so the
runner receives the head entry's `range` / `behavior` overrides
unchanged. Following entries are dropped from the slice, so no
inter-scene transition runs and no later scene's lifecycle fires.

The slice is **truncated, not flattened.** Replacing the resolved
target with `{ scene: resolved.scene }` (no composition) would lose
the head entry's per-entry overrides, turning standalone into
direct-scene flattening — which would contradict ADR-002 / ADR-011's
"manifest entries carry overrides; the runner consumes them" contract
and would silently break URLs whose head entry is object-form. The
truncated `manifestSlice` (length 1) therefore continues through the
composition branch in `loadSceneNavigationTarget()`, and the existing
runner-input plumbing forwards `range` / `behavior` per ADR-011.

PUL-F014 stays DRAFT after this PR lands, mirroring the PUL-F013
precedent in ADR-016. This PR ships:

- The single-scene execution mechanism (slice truncation at the
  loader) — the structural form of "the scene SHALL run as if no
  surrounding composition existed," which IS materially implemented.
- The seam — `ctx.mode === 'standalone'` reaches every lifecycle
  hook of the head scene through the existing PUL-F012 plumbing.
- Tests pinning the seam and the slice-truncation behavior.

What it does NOT yet ship is the active *suppression* of the three
named surfaces under standalone:

- Surrounding chrome rendering does not exist anywhere in the repo.
  When a future workbench-shell requirement lands chrome, it MUST
  read `ctx.mode === 'standalone'` from the seam this PR pinned and
  SUPPRESS. Today nothing renders chrome, so the suppression clause
  is vacuously true — but vacuous truth is not enforcement.
- Audio-bed playback does not exist (ADR-004's Howler audio service
  is not implemented). When the future audio service lands, it MUST
  read the seam and suppress the surrounding audio bed under
  standalone. The "audio bed" qualifier is intentional: scene-owned
  sound effects are a separate behavior the audio service decides at
  its own contract.
- Inter-scene transition rendering does not exist (ADR-003's GSAP
  runner is a placeholder). Under standalone, single-scene execution
  ensures no second scene runs, so no transition fires structurally
  — but when the runner lands and starts scheduling transitions, it
  MUST read the seam and suppress the leaving-transition out of the
  head scene under standalone.

Following the ADR-016 precedent, PUL-F014 transitions DRAFT → ACTIVE
when each of the three rendering surfaces above lands AND its
implementation explicitly reads `ctx.mode === 'standalone'` and
suppresses the named facet, with an end-to-end test alongside the
seam tests in this PR. Until then, the issue ↔ requirement link
stays as `DOCUMENTS` and the status stays DRAFT — matching how
ADR-016 / PUL-F013 records "land the contract layer; keep the
requirement DRAFT until the dependent subsystems land."

### Boundary

The slice drop happens at the loader because:

- The loader is the dispatch point that already derives `effectiveMode`
  for `ctx.mode` (ADR-007 / PUL-F012). Adding the slice transform here
  keeps mode-aware logic in one place.
- The composition resolver MUST stay mode-opaque (ADR-011 — pure
  orchestrator, no adapter knowledge). Slicing in the resolver would
  give it knowledge of mode semantics it deliberately does not own.
- `resolveSceneNavigation()` MUST run validation regardless of mode:
  unregistered compositions, unknown member scenes, ambiguous
  `composition+scene` locators, out-of-range indexes, and empty
  compositions still surface as navigation errors under
  `mode=standalone`. The slice drop runs *after* validation, so a
  malformed standalone target does not silently fall back to a direct
  scene lookup.
- `loadSceneNavigationTarget()` already has a clean single-scene
  branch. Reusing it removes the need for a "standalone-only" code
  path through the lifecycle.

### Stage attribute behavior

`data-pulsar-scene-target` (head scene id) AND
`data-pulsar-composition-target` (composition id) are both set on the
stage when the URL named a composition under `mode=standalone`.
The attrs communicate "what was addressed," not "what's running."
Removing the composition attr would lose useful inspection signal for
agents and screenshot tooling. No `data-pulsar-mode-*` suppression
attribute is preemptively written under `standalone` (parity with
ADR-016's invariant for `mode=present`); future chrome / audio
adapters are free to use that namespace if they actually need a
stage-level signal.

### Beat semantics

`beat=` under `mode=standalone` is forwarded to the head scene's
runner unchanged. Missing-label diagnostics surface via the existing
non-fatal `onBeatMissing` path (ADR-015), keeping single-scene
authoring/inspection's primary use case — landing on a specific beat
to inspect — fully supported.

## Consequences

### Positive

- The single-scene execution mechanism is materially shipped: the
  loader truncates the validated composition slice to one entry,
  preserving object-form `range` / `behavior` overrides. That
  satisfies the "run as if no surrounding composition existed"
  clause in code, not just in documentation.
- Following ADR-016's precedent keeps the DRAFT → ACTIVE bar
  consistent across mode requirements: ACTIVE means every facet the
  statement names has a real surface that actively conforms.
  Future authors reading the requirement set will see one rule, not
  two.
- The slice-truncation helper (`applyStandaloneSlice`) is one pure
  function in `runTarget`. The lifecycle path, resolver, registry,
  and beat plumbing are unchanged. Surface area for regressions is
  small.
- Future chrome / audio / runner adapters inherit `ctx.mode ===
  'standalone'` for free — they read the same hint they already plan
  to read for `present`, no new wiring required. When they conform,
  PUL-F014 transitions to ACTIVE.
- Composition validation is preserved: standalone is single-scene
  *execution*, not single-scene *lookup*. A malformed composition
  target fails the same way it does in any other mode.

### Negative

- The stage attrs say "this URL addressed composition X" while only
  one scene runs. Agents inspecting the runtime see a coherent record
  of the URL but must know `mode=standalone` to understand why the
  rest of the composition did not execute. The mode parameter is in
  the same URL the agent sees, so this is a small disambiguation cost
  — but it is non-zero. The alternative (dropping the composition
  attr) would lose more useful information than it would save.
- `composition+scene` and `composition+index` look slightly
  redundant under `mode=standalone`: both resolve to the same
  single-scene execution as direct `scene=` would. They remain
  accepted because they preserve composition context for the head
  scene's lookup (range / behavior overrides on the head entry are
  still respected) and because rejecting them would force authors to
  rewrite URLs when toggling between modes.

### Risks

- A future requirement could mean to *also* suppress audio that the
  addressed scene owns (today the statement only suppresses the
  surrounding *audio bed*). When that requirement lands, audio surface
  authors will read `ctx.mode === 'standalone'` at their own seam
  rather than the loader gaining new logic. The seam is set; the
  behavior is the future surface's contract.
- A non-parser caller could construct a `NavigationTarget` whose
  `mode` field is forged. The defense-in-depth check
  `validateModeGrammar` already rejects unknown mode strings at the
  loader boundary. Slice transforms only run when the mode passes
  validation.
- Inter-scene transition rendering does not exist yet. When ADR-003's
  GSAP runner lands, the runner will see `ctx.mode === 'standalone'`
  at the seam and know not to schedule a transition out of the head
  scene — but until then, "no transition runs" is true because there
  is no transition code anywhere. A regression that *added* transition
  scheduling without consulting `ctx.mode` would re-introduce the
  facet PUL-F014 forbids; the seam test
  (`ctx.mode === 'standalone'` reaches every lifecycle hook of the
  head scene) is the structural defense against that.

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) — the timeline runner is the
  seam through which inter-scene transition rendering will flow when
  it lands; today the runner is a placeholder, so transition
  suppression under standalone is structural.
- [ADR-004](004-howler-audio-engine.md) — `ctx.audio` is the seam
  through which audio rendering will flow; the surrounding-audio-bed
  suppression clause maps onto a future audio surface reading
  `ctx.mode === 'standalone'`.
- [ADR-007](007-browser-workbench.md) — defines the eight workbench
  modes and the URL-only-source invariant for mode selection.
- [ADR-008](008-agent-native-authoring.md) — manifests-over-flow-
  control underpins the slice-drop-not-manifest-mutation choice.
- [ADR-011](011-composition-resolver-orchestration.md) — the resolver
  is opaque to mode; the slice transform happens at the loader, not
  inside the resolver.
- [ADR-013](013-url-navigation-grammar-boundary.md) — the parser
  preserves `mode` and forbids recovering it from any non-URL source.
- [ADR-014](014-url-scene-target-selection.md) — scene navigation
  dispatch is mode-blind; it resolves the active slice and hands off
  to the loader for mode dispatch.
- [ADR-015](015-url-beat-positioning.md) — beat semantics under
  standalone are unchanged: head-scope only, runner-side label
  resolution, non-fatal missing-label diagnostic.
- [ADR-016](016-workbench-mode-present.md) — establishes the
  precedent this ADR follows: land the contract layer plus seam
  tests, keep the requirement DRAFT until each named facet has a
  real rendering / input surface that actively conforms. PUL-F014's
  ACTIVE transition is gated on chrome, audio-bed, and
  inter-scene-transition surfaces all reading `ctx.mode ===
  'standalone'` and suppressing.
