# ADR-016: Workbench Mode `present` — Contract Boundary and Adapter Seams

## Status

Accepted

## Date

2026-05-06

## Context

PUL-F013 specifies `mode=present` behavior:

> In `mode=present`, the runtime SHALL render full chrome, audio, and
> inter-scene transitions, and SHALL respond to presenter input.

`present` is one of the eight workbench modes ADR-007 defines, and it
is the default selected by `effectiveMode()` when the URL omits
`mode=`. Other modes (`standalone`, `loop`, `paused`, `scrub`,
`screenshot`, `prompter`, `rehearsal`) suppress some subset of the
four facets PUL-F013 names — for example, `standalone` suppresses
chrome, inter-scene transitions, and the audio bed (PUL-F014);
`screenshot` suppresses audio and animation (PUL-F018); `rehearsal`
suppresses audible playback (silenced or logged as cues —
PUL-F026 / ADR-004).

At the time this ADR was accepted, each of the four facets PUL-F013
names depended on a surface that had not yet landed in this repo. The
update sections below record the later deliveries.

| Facet | Surface that delivers it | Status |
|-------|--------------------------|--------|
| Render full chrome | PUL-F031 / ADR-031 workbench chrome surface plus L2 chrome slots | delivered — `src/runtime/workbench-chrome.ts`, `src/system/chrome/*`, and `src/main.ts` mount a workbench-owned surface and slot DOM before navigation. |
| Render audio | Audio service per ADR-004 (Howler.js) plus the PUL-F030 / ADR-029 unlock gate | delivered — `src/runtime/audio.ts`, `src/runtime/audio-unlock-dom.ts`, and `src/runtime/scene-loader.ts` build per-navigation audio with mode policy, source allowlists, unlock, cleanup, and master mute. |
| Render inter-scene transitions | GSAP composition master per ADR-003 / ADR-025 plus transition registry | delivered — `src/runtime/timeline.ts` invokes registered `Transition`s between composition segments, and `src/system/transitions/*` ships the default implementations. |
| Respond to presenter input | Presenter controls per PUL-F020 / F021 / F025 / ADR-023 / ADR-024 | delivered at runtime seam — `src/runtime/presenter.ts`, `src/runtime/scene-loader.ts`, `src/runtime/timeline.ts`, and `src/system/presenter/*` validate commands, bind keyboard / bridge sources, drive master transport, and toggle master mute. |

PUL-F013's natural ACTIVE state is "all four facets are rendered /
accepting input under `mode=present` end to end." It was not testable
when this ADR first landed, so the original decision was to pin the
contract seams and defer ACTIVE. That historical decision remains
below because it explains why the seams exist before their surfaces.

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

## Initial Decision (2026-05-06)

Take option 3. PUL-F013 today delivers:

1. **This ADR**, recording the present-mode contract boundary and
   identifying which seams future surfaces will plug into.
2. **Test pinning of the seams** under `mode=present` — see
   `tests/runtime/scene-loader.test.ts` block
   `'present-mode adapter seams (PUL-F013 boundary, NOT a PUL-F013 implementation)'`. The tests pin:
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

- PUL-F013 stays DRAFT until every facet PUL-F013's statement names
  (chrome, audio, inter-scene transitions, presenter input) lands as
  a real rendering / input surface that adds its own end-to-end test.
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

- `tests/runtime/scene-loader.test.ts` — `'present-mode adapter
  seams (PUL-F013 boundary, NOT a PUL-F013 implementation)'`
  describe block pinning multi-scene lifecycle order, AbortSignal
  forwarding, abort-to-cleanup connectedness, `ctx.mode ===
  'present'` end-to-end propagation, and the
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

## Update — 2026-05-18 (PUL-F031 lands)

PUL-F031 ships the workbench chrome surface — see ADR-031. The
"Render full chrome" facet in the table above is now structurally
delivered: chrome is workbench-owned, mounted before the first
navigation, mode-governed (`present` → visible; `standalone` /
`screenshot` → hidden), and persistent across scene navigations
within a composition. The chrome surface itself ships empty;
PUL-F020 / F021 / F025 land the presenter controls that populate it.

PUL-F013 STILL stays DRAFT. Three facets remain absent (audio,
inter-scene transitions, presenter input). The ACTIVE bar is
unchanged — every facet must land as a real rendering / input
surface with end-to-end tests.

## Update — 2026-05-21 (PUL-F013 current state)

PUL-F013 is now an integration requirement over shipped runtime and L2
surfaces, not a placeholder for absent seams. The provided Ground
Control payload reports PUL-F013 as ACTIVE; this update supersedes the
historical DRAFT-state notes above.

Current canonical implementation boundaries:

- **Chrome:** `src/runtime/workbench-chrome.ts` owns the workbench
  surface and `chromeVisibilityFor()`. `src/main.ts` mounts it before
  navigation and `src/system/chrome/slots.ts` populates the L2 slots.
  The loader dispatches chrome synchronously at enqueue and applies
  the optional head-entry chrome override through
  `WorkbenchChromeAdapter.setForcedVisibility()`.
- **Audio:** `src/runtime/audio.ts` owns the Howler-backed engine,
  per-navigation `AudioService`, source allowlist, output policy, cue
  logging, master mute, and validation. `src/runtime/scene-loader.ts`
  builds the service once per navigation, enforces the present-mode
  audio unlock gate, forwards `ctx.audio`, and tears down groups /
  services through resolver cleanup hooks.
- **Transitions:** `src/runtime/timeline.ts` owns the
  `Transition` / `TransitionRegistry` contract and invokes registered
  transitions while composing the GSAP master timeline. Default L2
  transitions live in `src/system/transitions/*`; `src/main.ts` wires
  `defaultTransitions()` and a workbench-owned
  `[data-pulsar-transition="overlay"]` element.
- **Presenter input:** `src/runtime/presenter.ts` owns the command
  schema and boundary validator. The loader creates a per-navigation
  `PresenterController` only under `mode=present`, threads it into
  `ctx.presenter` and the timeline adapter, handles master mute at the
  audio seam, and aborts presenter subscriptions on navigation abort
  and normal completion. `src/system/presenter/keyboard-source.ts`
  and `src/system/presenter/bridge.ts` provide the local keyboard and
  same-origin cross-window sources that `src/main.ts` combines.

Current guardrails for follow-up work:

- Do not create a second present-mode controller, transition adapter,
  presenter schema, audio policy, chrome ownership model, validation
  pass, or error hierarchy.
- Keep the resolver mode-opaque. Mode-specific behavior remains in the
  loader, timeline adapter, audio service, chrome adapter, or L2
  workbench modules.
- Keep transition declarations adapter-owned under
  `behavior.transition`. Strengthen `durationMs` or future
  transition-parameter validation centrally before invoking
  transition implementations; do not add deck-local validators.
- Keep presenter input on the existing command stream. New commands
  extend `PRESENTER_COMMAND_KINDS`, `isPresenterCommand()`, and the
  timeline/audio dispatch sites. A future remote source must
  authenticate before emitting into `PresenterCommandSource`.
- Keep public diagnostics on `describeErrorDetailed()`, loader
  `onError`, and stage attributes. Never serialize raw causes, stacks,
  DOM nodes, scene objects, full captions, headers, cookies, env,
  auth values, source URLs beyond existing asset diagnostics, or
  engine handles.

The companion preflight note
`docs/design/pul-f013-present-mode-preflight.md` is the current
repo-wide guardrail summary for implementation work that touches
present mode.

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) — the timeline runner is
  the seam through which inter-scene transitions and presenter
  input flow.
- [ADR-004](004-howler-audio-engine.md) — `ctx.audio` is the seam
  through which audio rendering will flow.
- [ADR-007](007-browser-workbench.md) — defines the eight workbench
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
- [ADR-023](023-presenter-controls.md) — presenter command source and
  per-navigation controller seam.
- [ADR-024](024-presenter-pause-resume.md) — pause/resume as
  runner-owned transport state on the presenter command seam.
- [ADR-029](029-present-mode-audio-unlock-gate.md) — present-mode
  audio unlock before lifecycle work.
- [ADR-031](031-workbench-chrome-surface.md) — workbench-owned,
  mode-governed chrome surface.
