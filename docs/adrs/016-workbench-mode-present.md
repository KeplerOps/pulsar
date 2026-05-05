# ADR-016: Workbench Mode `present` — Contract Boundary and Adapter Seams

## Status

Accepted

## Date

2026-05-06

## Context

PUL-F013 specifies `mode=present` behavior:

> In `mode=present`, the runtime SHALL render full chrome, audio, and
> inter-scene transitions, and SHALL respond to presenter input.

`present` is one of the seven workbench modes ADR-007 defines, and it
is the default selected by `effectiveMode()` when the URL omits
`mode=`. Other modes (`standalone`, `loop`, `paused`, `scrub`,
`screenshot`, `prompter`) suppress some subset of the four facets
PUL-F013 names — for example, `standalone` suppresses chrome,
inter-scene transitions, and the audio bed (PUL-F014); `screenshot`
suppresses audio and animation (PUL-F018).

Each of the four facets PUL-F013 names depends on a surface that has
not yet landed in this repo:

| Facet | Surface that delivers it | Status |
|-------|--------------------------|--------|
| Render full chrome | Workbench-shell requirement (not yet drafted) | absent |
| Render audio | Audio service per ADR-004 (Howler.js); a future PUL-F* requirement will deliver the service | absent |
| Render inter-scene transitions | GSAP timeline runner per ADR-003; the runner's adapter slot exists in `composition-resolver.ts` but the GSAP implementation has not landed | absent (placeholder runner in `src/main.ts`) |
| Respond to presenter input | Presenter controls per PUL-F020 (advance / hold / skip), PUL-F021 (pause / resume), PUL-F025 (master mute) | absent |

PUL-F013's natural ACTIVE state — "all four facets are rendered /
accepting input under `mode=present` end to end" — is therefore not
currently testable. Three options exist:

1. **Pre-land an abstraction** (e.g., a `ModePolicy` record on `ctx`)
   so PUL-F013 has something to point at. Risk: the abstraction has
   no second consumer until PUL-F014 (standalone) lands; it would
   commit the runtime to a representation before any of the four
   future surfaces has stated what shape it actually needs to read.
2. **Defer PUL-F013 entirely** until at least one rendering surface
   lands. Risk: the present-mode contract is not pinned anywhere; a
   regression that disables a seam under `mode=present` (e.g., drops
   AbortSignal forwarding for the `present` value, or short-circuits
   the multi-scene lifecycle) would not be caught until a future
   PR touched the surface that depends on the seam.
3. **Land the contract layer + the seam tests now**, leave PUL-F013
   DRAFT, transition to ACTIVE when a rendering surface arrives.
   Mirrors ADR-015 / PUL-F011's precedent: the `beat` contract layer
   and the diagnostic path landed; PUL-F011 stays DRAFT pending the
   GSAP runner that will exercise label seeking end to end.

## Decision

Take option 3. PUL-F013 today delivers:

1. **This ADR**, recording the present-mode contract boundary and
   identifying which seams future surfaces will plug into.
2. **Test pinning of the seams** under `mode=present` — see
   `tests/runtime/scene-loader.test.ts` block
   `'present-mode contract (PUL-F013)'`. The tests pin:
   - The composition resolver's structural cleanup-before-next-create
     ordering across multiple scenes — the lifecycle hook ADR-003's
     GSAP runner will hang inter-scene transition rendering off.
   - The per-navigation `AbortSignal` reaches the timeline runner's
     `input.signal` for every scene under `mode=present` — the seam
     PUL-F020 will drive when actual presenter input arrives.
   - An in-flight abort under `mode=present` flips
     `signal.aborted` and triggers `cleanup(ctx)` on the in-flight
     scene — pins the abort-to-cleanup connectedness end to end.
   - `ctx.mode === 'present'` reaches every lifecycle hook in
     multi-scene navigations — the hint chrome and audio surfaces
     will read.
   - No `data-pulsar-mode-*` suppression attribute is preemptively
     written under `mode=present`.

PUL-F013 explicitly does **not** introduce a mode-suppression
representation today. No `ModePolicy` record, no
`data-pulsar-mode-*` stage attributes, no `ctx.suppressed` flag. The
shape of mode suppression is deferred to the requirement that has a
concrete second consumer demanding it (likely PUL-F014 standalone),
at which point the representation can be informed by an actual second
mode rather than guessed.

PUL-F013 stays **DRAFT**. The requirement statement names FOUR
facets under `mode=present` — chrome, audio, inter-scene transitions,
and presenter input — and ACTIVE requires every one of them to be
rendered / accepted end to end. The contract is "rendering /
responding," not "no suppression in absentia." A regression-resistant
seam under `mode=present` is necessary for ACTIVE; it is not by
itself sufficient. This PR explicitly does **not** satisfy PUL-F013;
it lands the boundary and the seams the four future surface PRs will
plug into.

## Consequences

### Positive

- No premature abstraction. `ModePolicy` lands when a second
  consumer (PUL-F014 standalone) needs it, with shape informed by
  an actual second mode rather than guessed.
- The seams are pinned. A future regression that disables the
  abort signal forwarding, collapses multi-scene lifecycles, or
  preemptively writes a `data-pulsar-mode-*` suppression attribute
  under `mode=present` is caught by the contract tests.
- The integration boundary is explicit. Future workbench-shell,
  audio, and presenter-UI requirements know that `mode=present` is
  the rendering / accepting baseline and that mode suppression
  lives at their adapter boundary, not in the runtime core.

### Negative

- PUL-F013 stays DRAFT until at least one rendering surface lands.
  A reviewer reading the requirement in isolation may expect ACTIVE
  on first delivery; the DRAFT-with-contract-and-seams state is
  intentional and matches the PUL-F011 / ADR-015 precedent.
- The seam tests are necessary but not sufficient: they prove the
  hooks exist and behave correctly under `mode=present`, but they
  do not prove that future rendering surfaces will plug in
  correctly. Each surface PR is responsible for adding its own
  end-to-end "X renders under `mode=present`" tests.
- The "no-suppression" invariant is enforced narrowly (no
  `data-pulsar-mode-*` attribute) rather than broadly. A
  workbench-shell PR that adds a non-`data-pulsar-mode-*`
  attribute is not constrained by this ADR; its own ADR / tests
  must establish the present-mode contract for that attribute.

### Risks

| Risk | Mitigation |
|------|-----------|
| A future PR adds a `ModePolicy` abstraction without a second consumer demanding it | Cross-cutting reviewer step (`gc_codex_review`) flags duplicate-mode-validation patterns. Future-mode requirement plans must justify the suppression representation against the actual surface they are gating. |
| `present` mode acquires a hidden suppression vector under a different stage-attribute namespace when the workbench shell lands | The contract test in this PR is scoped to `data-pulsar-mode-*`; subsequent surface PRs must add their own present-mode contract assertions for any new namespace they introduce. |
| PUL-F014–F019 each invent a different suppression representation | When the second mode (likely PUL-F014 standalone) lands, that PR creates the suppression representation. Subsequent modes reuse it. The decision is deferred to the requirement that has a concrete need, not made speculatively here. |
| PUL-F013 lingers DRAFT forever because chrome / audio / GSAP runner / presenter UI keep slipping | DRAFT status is a feature here: it tells reviewers the present-mode contract is partly delivered (boundary + seams) and gates ACTIVE on actual rendering. Each surface PR that lands a facet is the natural trigger to revisit PUL-F013's status. |

## Current state (2026-05-06)

This PR delivers the contract boundary and seam-pinning layer:

- `tests/runtime/scene-loader.test.ts` — `'present-mode contract
  (PUL-F013)'` describe block pinning multi-scene lifecycle order,
  AbortSignal forwarding, abort-to-cleanup connectedness,
  `ctx.mode === 'present'` end-to-end propagation, and the
  no-`data-pulsar-mode-*` invariant.
- `docs/design/pul-f013-present-mode-preflight.md` — the codex
  preflight design context naming the four facets and the
  cross-cutting concerns to reuse.
- This ADR.

PUL-F013 remains DRAFT. Issue #22 links to PUL-F013 via `DOCUMENTS`.
This PR is **not** an implementation of PUL-F013 — it lands the
contract boundary and the seams. The ACTIVE transition is gated on
**every** facet PUL-F013's statement names landing as a real
rendering / input surface AND adding its own end-to-end
"X renders / responds under `mode=present`" test alongside the seam
tests in this PR. The four required deliverables are:

- A workbench-shell requirement that lands chrome rendering (a
  future PUL-F* requirement; not yet drafted).
- An audio-service requirement that lands `ctx.audio` per ADR-004
  (a future PUL-F* requirement; PUL-F030 audio-unlock interaction
  is related but not the audio service itself).
- ADR-003's GSAP runner replacing the placeholder in `src/main.ts`
  with timeline-driven inter-scene transitions.
- PUL-F020 / PUL-F021 / PUL-F025 wiring presenter UI (advance,
  hold, skip, pause / resume, master mute) to the AbortSignal seam.

When all four arrive, PUL-F013 transitions to ACTIVE and the issue
↔ requirement link upgrades from `DOCUMENTS` to `IMPLEMENTS`. Until
then, treating this PR as satisfying PUL-F013 would be a
traceability/status mismatch.

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) — the timeline runner is
  the seam through which inter-scene transitions and presenter
  input flow.
- [ADR-004](004-howler-audio-engine.md) — `ctx.audio` is the seam
  through which audio rendering will flow.
- [ADR-007](007-browser-workbench.md) — defines the seven workbench
  modes and the URL-only-source invariant for mode selection.
- [ADR-008](008-agent-native-authoring.md) — manifests-over-flow-
  control underpins the no-mode-suppression-in-resolver constraint.
- [ADR-011](011-composition-resolver-orchestration.md) — the
  resolver is opaque to mode; mode-derived behavior lives at the
  adapters it forwards to.
- [ADR-013](013-url-navigation-grammar-boundary.md) — the parser
  preserves absent `mode` as absent so the dispatch boundary
  (`effectiveMode()`) owns the default-to-`present` rule.
- [ADR-014](014-url-scene-target-selection.md) — scene navigation
  dispatch is mode-blind; it resolves the active slice and hands
  off to the loader.
- [ADR-015](015-url-beat-positioning.md) — precedent for "deliver
  the contract layer; keep the requirement DRAFT until the
  dependent subsystem lands."
