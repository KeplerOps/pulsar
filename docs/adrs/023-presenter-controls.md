# ADR-023: Presenter Controls — Per-Navigation Command Source at the Loader/Runner Seam

## Status

Accepted

## Date

2026-05-10

## Context

ADR-007 names eight workbench modes: `present`, `standalone`, `loop`,
`paused`, `scrub`, `screenshot`, `prompter`, `rehearsal`. ADR-013 fixes the URL
grammar boundary that carries `mode=` to the runtime. ADR-016
(`mode=present`) records the present-mode contract boundary and names
PUL-F020 as one of the four facets that gates PUL-F013 ACTIVE
("PUL-F020 / PUL-F021 / PUL-F025 wiring presenter UI (advance, hold,
skip, pause / resume, master mute) to the AbortSignal seam"). ADR-017
through ADR-022 establish the precedent for landing each
mode-or-facet's contract layer plus seam tests while the dependent
input / rendering surfaces are still pending: PUL-F013 through
PUL-F019 all stayed DRAFT after their contract PRs because the four
named surfaces (chrome, audio, GSAP runner, presenter input) are not
yet implemented.

PUL-F020 specifies presenter input under `mode=present`:

> In `mode=present`, the runtime SHALL accept presenter input to
> advance to the next beat, hold the current beat, skip forward, and
> skip backward. Beat progression SHALL be interruptible without
> breaking timeline state.

The clauses decompose:

- "The runtime SHALL accept presenter input to advance / hold /
  skip-forward / skip-backward" — the runtime needs a way to receive
  these four named commands and route them to the timeline runner so
  the runner can translate each into a transport call (ADR-003: GSAP
  `play()` / `pause()` / `seek()` / `tweenTo()`). The runtime is the
  receiver; the input source (keyboard listener, on-screen controls,
  remote presenter protocol) lives at a workbench surface that has
  not yet landed.
- "In `mode=present`" — presenter input is scoped to `mode=present`.
  The other six modes have their own semantics (single-frame
  capture, hold at first frame, infinite loop, captions-only view,
  etc.) that presenter commands would corrupt.
- "Beat progression SHALL be interruptible without breaking timeline
  state" — a presenter-driven supersede mid-scene must run
  `cleanup(ctx)` on the in-flight scene exactly once (PUL-F006's
  mandatory-cleanup invariant). The dispatch path must not introduce
  a second cleanup pathway or skip cleanup on the abort branch.

The other five workbench-mode ADRs (ADR-017 through ADR-021) all use
runner-input *hints* — opaque flags (`repeat: 'until-aborted'`,
`hold: 'first-frame'`, `cueGate: 'monotonic-forward'`,
`screenshot: 'capture'`) the loader sets and the runner reads. That
shape is wrong for PUL-F020:

- A flag is one-shot per navigation; presenter commands are a stream
  of arrivals during a navigation.
- Flags are head-only because each named mode is single-scene; PUL-F020
  acts on whichever scene is currently active in the FULL composition
  slice mode=present runs.
- Flags can be string literals; presenter commands need a typed
  discriminator (`{ kind: 'advance' | 'hold' | 'skip-forward' |
  'skip-backward' }`) plus a subscription channel.

The cleanest seam is a per-navigation *controller* that the workbench
supplies via a long-lived *source*, similar in spirit to how
`SceneLoaderOptions.renderPrompter` is supplied (ADR-022). The
runner subscribes; the controller auto-detaches every subscription
when the per-navigation `AbortSignal` fires.

The question this ADR answers is: where does the presenter command
seam live, what shape does it take, and on what contract does
PUL-F020 transition to ACTIVE?

## Decision

### Scope: presenter is a runtime-side command receiver

PUL-F020 is the *runtime* side of presenter input. Its scope:

- Define a typed presenter command shape and a workbench-supplied
  source (`PresenterCommandSource`) for command arrivals.
- Build a per-navigation controller (`PresenterController`) under
  `mode=present` that proxies the source, validates incoming
  commands at the boundary, and auto-detaches all subscriptions
  when the navigation aborts.
- Forward the controller to every scene's run input via the bridge
  → resolver chain so the runner can subscribe.
- Pin the contract with seam tests covering all four kinds, the
  mode-scoping, the auto-cleanup, and the
  interruptibility/cleanup invariant.

What PUL-F020 does NOT include in this PR:

- Keyboard listener on `document` / `window`.
- On-screen presenter UI controls.
- Remote-presenter protocol (HTTP, WebSocket, etc.).
- GSAP runner that translates commands to transport calls
  (ADR-003 territory; the placeholder runner ignores commands and
  vacuously satisfies the seam — same shape as it ignores `repeat`
  / `hold` / `cueGate` / `screenshot` today).
- Pause / resume (PUL-F021 — separate requirement, separate PR).
- Master mute (PUL-F025 — separate requirement, separate PR).

The codex preflight named four broad anti-patterns that this scope
explicitly defends against: per-scene keyboard listeners, duplicate
command schemas, treating skip as scrub or arbitrary millisecond
seeking, and broadening hold into the separate pause/resume
requirement. The runtime side's narrow scope — receive typed
commands at a single boundary, route to the runner, auto-clean on
navigation end — sidesteps each anti-pattern by construction.

### Plumbing: loader-built per-navigation controller

`mode=present` continues to take the lifecycle-running dispatch path
(unlike `mode=prompter`, which bypasses the lifecycle entirely per
ADR-022). The presenter seam is added inline:

1. **Source on `SceneLoaderOptions`.** A new optional
   `presenterCommands?: PresenterCommandSource` field carries the
   workbench-supplied input source. The source is long-lived; the
   loader does not own or construct it. A workbench bootstrap that
   has not yet wired a presenter UI omits the field, and the loader
   gracefully degrades — runners see `input.presenter === undefined`
   and the seam is structurally inert until the workbench wires a
   real source.

2. **Per-navigation controller in `buildLoad`.** When BOTH
   `effectiveMode(target) === 'present'` AND
   `options.presenterCommands !== undefined`, `buildLoad`
   constructs a `PresenterController` via
   `createPresenterController(source, controller.signal, onError)`.
   The controller is bound to this navigation's `AbortController`
   so the abort listener (registered internally) detaches every
   runner subscription when the navigation aborts.

   The two scoping conditions are checked at the same call site so
   the rule "presenter input only under mode=present" is centralized.
   No other code path builds the controller.

3. **Bridge → resolver forwarding.** The controller flows through
   `LoadSceneNavigationTargetOptions.presenter` →
   `ResolveCompositionOptions.presenter` →
   `SceneTimelineRunInput.presenter`. The bridge does NOT truncate
   the slice when `presenter` is supplied — `presenter` is
   independent of the four head-only runner-input hints, every one
   of which corresponds to a single-scene-execution mode where
   truncation enforces "no following entries run." Mode=present has
   no such promise; truncating would silently drop tail-scene
   presenter handling.

4. **Resolver: not head-only.** Unlike `headBeat` / `headRepeat` /
   `headHold` / `headCueGate` / `headScreenshot`, `presenter` is
   forwarded to EVERY plan step (analogous to `signal`). Mode=present
   runs the FULL composition slice; presenter commands act on
   whichever scene is currently active in the resolver loop. A
   head-only forwarding here would silently drop presenter input for
   every scene after the head — exactly the failure mode the
   broader-scoping guarantees against.

5. **Runner contract.** The runner receives `input.presenter` (when
   present) and subscribes via `input.presenter.subscribe(handler)`.
   `subscribe` returns an unsubscribe callback the runner SHOULD
   invoke on its own scene-exit path; the controller's auto-detach
   on abort is a safety net, not a substitute. Translating each
   command into a transport call is the runner's contract per
   ADR-003 (advance → play to next beat, hold → pause, skip-forward
   / skip-backward → seek to next/prev beat). A runner that ignores
   `input.presenter` gracefully degrades — the placeholder runner
   does this today because it has no real timeline to drive.

6. **Per-scene wrapping inside the resolver.** The navigation-level
   controller's auto-detach fires on navigation abort — but a
   `mode=present` composition runs every scene under one
   navigation, so a runner that subscribes during scene-A and
   forgets to unsubscribe at scene-A's exit would keep receiving
   commands during scene-B. The resolver's `runScene` defends
   against this by wrapping the navigation controller in a
   per-scene child controller: a fresh `AbortController` per scene,
   a `createPresenterController(navController, perSceneSignal)`
   call, and `perSceneAbort.abort()` after the scene's `cleanup(ctx)`
   completes. The runner sees the per-scene wrapper as
   `input.presenter`, not the navigation controller directly. Two
   safety properties layer cleanly: navigation-end abort cascades
   through every scene's wrapper (the wrapper's source IS the
   navigation controller, so when the navigation tears down its
   source-side subscriptions every wrapper's emissions stop), and
   per-scene-end abort releases that scene's runner subscriptions
   before the next scene's runner starts. The wrapper is built
   only when the navigation controller exists, so non-present-mode
   navigations pay zero per-scene cost.

### Command shape and validation

`PresenterCommand` is a discriminated union frozen to four kinds:

```
type PresenterCommandKind = 'advance' | 'hold' | 'skip-forward' | 'skip-backward';
interface PresenterCommand {
  readonly kind: PresenterCommandKind;
}
```

`PRESENTER_COMMAND_KINDS` is the single source of truth for the
allowlist (frozen tuple, parallel to `NAVIGATION_MODES`). The type
guard `isPresenterCommand` is the sole boundary validator the
controller applies. Unknown kinds are dropped at the controller —
the handler is not invoked, and an `Error` is surfaced through the
`onError` sink the loader already injects. No throw, no scene
unmount; the boundary error is a diagnostic, not a navigation
failure.

Handler exceptions are isolated per-handler so a buggy subscriber
cannot poison emissions for siblings — the controller wraps each
handler in a try/catch that routes thrown errors through `onError`.
Without isolation, the source's emission loop would propagate the
throw through every later handler.

### Why a per-navigation controller, not the source directly

A direct hand-off of the source to the runner has two failure modes:

- **Subscription leaks across navigations.** A runner that subscribes
  and forgets to unsubscribe attaches a handler to the long-lived
  source for the workbench's lifetime. The next navigation's runner
  sees double-deliveries, then triple, etc. The per-navigation
  controller's auto-detach on abort makes the leak structurally
  impossible.
- **No boundary validation.** A misbehaving programmatic source
  (test harness, future remote-presenter bridge) can emit malformed
  values. The controller's `isPresenterCommand` check at the
  emission boundary drops them before the runner sees them.

These two properties are what make the contract layer worth landing
ahead of the UI surface: the seam's safety properties are testable
today even though no real input source exists yet.

### Boundary

The presenter seam lives at the loader because:

- The loader already derives `effectiveMode(target)` for `ctx.mode`
  (ADR-007 / PUL-F012). Reusing the same derivation for the
  presenter scoping keeps mode-aware dispatch in one place.
- The composition resolver MUST stay mode-opaque (ADR-011 — pure
  orchestrator, no adapter knowledge). Pushing the mode-scoping
  into the resolver would force the resolver to inspect a runtime
  detail that has no place in the orchestrator.
- The bridge (`loadSceneNavigationTarget`) is mode-opaque by
  design — it forwards options to the resolver without
  interpretation. The presenter forwarding here mirrors the
  signal/beat/repeat/hold/cueGate/screenshot pass-through.

### What this PR does not do

- No keyboard listener on `document` / `window`. ADR-007's URL-only
  rule applies to mode dispatch; presenter input is a workbench-
  supplied stream, not a global side-effecting listener. The future
  presenter UI module owns the keyboard listener; production main.ts
  omits the `presenterCommands` field today.
- No `data-pulsar-mode-*` suppression attribute under `mode=present`.
  ADR-016's invariant holds: this PR does not introduce any
  preemptive stage attribute under the suppression namespace.
- No second cleanup path. Presenter-driven aborts route through the
  existing `AbortController`; the resolver's mandatory-cleanup
  invariant (PUL-F006) runs `cleanup(ctx)` on the in-flight scene
  exactly once, just as it does for popstate-driven aborts today.

PUL-F020 stays DRAFT after this PR lands, mirroring the
ADR-016 / PUL-F013, ADR-017 / PUL-F014, ADR-018 / PUL-F015,
ADR-019 / PUL-F016, ADR-020 / PUL-F017, ADR-021 / PUL-F018, and
ADR-022 / PUL-F019 precedent. This PR ships:

- The contract layer: `PresenterCommand`, `PresenterCommandSource`,
  `PresenterController`, `createPresenterController`,
  `isPresenterCommand`.
- The plumbing: loader → bridge → resolver → runner, mode=present
  only, forwarded to every scene.
- The seam tests: every command kind, mode-scoping (positive and
  negative for all six non-present modes), auto-cleanup on abort,
  cleanup-before-handoff across a presenter-driven supersede, and
  the boundary-validation drop path.

What it does NOT yet ship is the visible presenter UI surface and
the runner that translates commands to GSAP transport calls. The
placeholder timeline runner ignores `input.presenter`. PUL-F020
transitions DRAFT → ACTIVE when:

1. A presenter UI module (keyboard listener, on-screen controls,
   or both) lands and surfaces user input as `PresenterCommand`s
   through a `PresenterCommandSource`.
2. The GSAP runner (or an equivalent runner with real transport
   semantics) ships and translates each command kind into a
   timeline operation that visibly affects beat state.
3. End-to-end tests confirm advance / hold / skip-forward /
   skip-backward actually move beat state without breaking the
   timeline (no leaked listeners, no double-cleanup, no missed
   commands across the supersede boundary).
4. Ground Control traceability has the presenter UI module AND the
   runner module linked as `IMPLEMENTS` PUL-F020 alongside the
   runtime-side modules' existing `IMPLEMENTS` links.

Until those surfaces land, the issue ↔ requirement link stays as
`DOCUMENTS` and PUL-F020 stays DRAFT — matching how ADR-016 /
PUL-F013 through ADR-022 / PUL-F019 record "land the contract layer;
keep the requirement DRAFT until the dependent surfaces land."

## Consequences

### Positive

- The seam is testable today as a pure module plus a loader-level
  dispatch test. Both contracts can be pinned without depending on
  a real keyboard surface or a real timeline runner.
- Per-navigation auto-cleanup is a safety property the runner
  cannot violate by forgetting to unsubscribe — the controller's
  abort listener detaches every outstanding handler on navigation
  end. Subscription leaks are structurally impossible.
- Boundary validation is centralized at the controller. A
  misbehaving programmatic source cannot push malformed commands
  past the boundary; the runner only sees well-formed
  `PresenterCommand`s. Adding new kinds is a one-place edit
  (`PRESENTER_COMMAND_KINDS`) — the validator and the discriminated
  union both follow.
- Mode-scoping at the loader keeps the rule "presenter input only
  under mode=present" in a single line. No code path builds the
  controller for any other mode; the runner sees absent
  `input.presenter` for every other mode.
- The contract surface (`presenterCommands?: PresenterCommandSource`
  on `SceneLoaderOptions`) is parallel to `renderPrompter` (ADR-022)
  and `runTimeline`. A future workbench bootstrap plugs in the same
  way the future captions UI plugs into `renderPrompter`.
- Following ADR-016 through ADR-022's precedent keeps the DRAFT →
  ACTIVE bar consistent across mode-and-facet requirements: ACTIVE
  means the named user-visible behavior is actively delivered end
  to end, not just structurally scaffolded.

### Negative

- PUL-F020 stays DRAFT until both a real presenter UI surface AND a
  real timeline runner land. A reviewer reading the requirement in
  isolation may expect ACTIVE on first delivery; the
  DRAFT-with-contract-and-seams state is intentional and matches the
  precedent.
- `PresenterController` is structurally identical to
  `PresenterCommandSource` (both have `subscribe(handler): () => void`).
  The two interfaces are intentionally distinct types so the loader's
  call site signals "wrap source in a per-navigation controller, then
  hand the controller to the runner" rather than "hand the source
  directly." A future contributor who collapses them would lose the
  per-navigation auto-cleanup and re-introduce the leak failure mode.
- Adding `presenter` widens both `SceneTimelineRunInput` and
  `LoadSceneNavigationTargetOptions`. Every direct caller (production
  bootstrap, test harnesses, future export pipelines) sees the new
  field. Optional makes the impact small: a caller that doesn't
  supply it gets graceful degradation.
- A test harness that supplies `presenterCommands` AND a non-present
  mode will see the seam structurally inert (the loader does not
  build the controller). That's correct behavior; a contributor
  debugging "why isn't my runner subscribing?" needs to verify the
  mode resolution.

### Risks

| Risk | Mitigation |
|------|-----------|
| A future runner forgets to unsubscribe on its own scene-exit path | Two layered safety nets fire on different boundaries. (1) Per-scene auto-detach: the resolver wraps the navigation controller in a per-scene child controller bound to a per-scene signal that fires after the scene's `cleanup(ctx)`. A subscription made during scene-A is released before scene-B's runner starts even if the runner never called the returned unsubscribe. (2) Navigation-level auto-detach: when the navigation aborts (next handle, dispose, popstate), every navigation-controller subscription is released, which cascades to every per-scene wrapper. Tests pin both: per-scene release between scenes within a single composition (resolver test), AND navigation-level release across a presenter-driven supersede (loader test). |
| A workbench bootstrap subscribes a global keyboard listener and emits commands while no scene is mounted | Source emissions with no controller subscribed are no-ops — the controller is only built for `mode=present` navigations. Tests pin that the source's `handlerCount` stays 0 under non-present modes. |
| A future code path calls `createPresenterController` outside the loader | The function is exported but has a single production caller (`buildLoad`). Codex preflight names "presenter input belongs to mode=present"; a second caller would need its own ADR justifying why mode-scoping should live in two places. |
| Unknown command kinds reach the runner from a misbehaving source | `isPresenterCommand` at the controller's emission boundary drops them with an `onError` diagnostic. Tests pin the drop and the diagnostic shape. The runner never sees malformed commands. The loader threads its own `onError` through both the navigation-level controller AND the resolver's per-scene wrapper (via `LoadSceneNavigationTargetOptions.onPresenterError` → `ResolveCompositionOptions.onPresenterError`), so a runner-handler exception caught by the per-scene wrapper still surfaces through the same diagnostic channel as every other navigation-level error. |
| A runner that subscribes mutates the command (`cmd.kind = 'corrupted'`) and corrupts later subscribers' view of the same emission | The wrapped handler forwards a frozen defensive copy (`Object.freeze({ kind: cmd.kind })`) to each subscriber. The source emits one reference, but every subscriber sees its own frozen object; mutation by one subscriber cannot reach another. |
| A non-idempotent source's unsubscribe is called twice (abort fires AND the runner explicitly unsubscribes after) | The controller tracks subscriptions through `Subscription` records carrying an `active` flag. Both the per-subscriber unsubscribe and the abort-driven `tearDownAll` check `active` before calling the source's unsubscribe; the second teardown is a no-op. Tests pin "abort then unsubscribe" runs the source's unsubscribe exactly once. |
| A misbehaving source's unsubscribe is a no-op (it doesn't actually detach) and post-abort emissions still reach the runner | The wrapped handler short-circuits on `!sub.active` BEFORE forwarding to the runner's handler. Even if the source keeps delivering after `tearDownAll` ran, the wrapper's `active` flag (cleared by `tearDownSubscription`) blocks the forward. Tests pin both "post-abort emission from a lying source" and "post-unsubscribe emission from a lying source" — the runner sees nothing. |
| A handler exception poisons the bus for sibling handlers | Per-handler try/catch isolates exceptions through `onError`. Tests pin that handler-A throwing does not prevent handler-B from receiving the same command. |
| A presenter-driven supersede leaks the previous scene's resources | The supersede flows through the existing `AbortController` path; the resolver's mandatory-cleanup invariant (PUL-F006) runs `cleanup(ctx)` on the in-flight scene exactly once. Tests pin the cleanup invariant under presenter-driven aborts. The "interruptible without breaking timeline state" clause is satisfied by the existing PUL-F006 invariant; PUL-F020 inherits it. |
| A reviewer expects skip to jump multiple beats / scenes / frames | PUL-F020 names exactly four commands; "skip forward" / "skip backward" is the runner's interpretation of "navigate by one beat without natural advance." Behaviors like "jump to next scene" or "scrub by N seconds" are scrub-mode (PUL-F017) or future requirements, not extensions of PUL-F020. |
| A future PR adds a "presenter command" that bypasses the controller (e.g., a scene-side `ctx.advanceBeat()` shortcut) | ADR-007 / PUL-F012 record `ctx.mode` as a read-only seam, not an action surface. A second action surface would need its own ADR; codex review at the PR boundary catches the divergence. |

## Current state (2026-05-10)

This PR delivers the contract boundary and seam-pinning layer:

- `src/runtime/presenter.ts` — new module exporting
  `PRESENTER_COMMAND_KINDS`, `PresenterCommand`, `PresenterCommandKind`,
  `PresenterCommandSource`, `PresenterController`,
  `isPresenterCommand`, and `createPresenterController`. Pure
  module — no DOM, no global listeners, no mode coupling. The
  controller's auto-detach on abort and per-handler exception
  isolation are pinned as separate tests.
- `src/runtime/composition-resolver.ts` —
  `SceneTimelineRunInput` gains optional `presenter?: PresenterController`
  (NOT head-only); `ResolveCompositionOptions` gains optional
  `presenter?: PresenterController`; `buildRunInput` and `runScene`
  pass it through. `runScene` builds a per-scene child controller via
  `createPresenterController(navController, perSceneSignal)` and
  fires `perSceneAbort.abort()` after the scene's `cleanup(ctx)` so
  a runner that forgets to unsubscribe at scene-exit cannot leak
  into the next scene's runner.
- `src/runtime/scene-navigation.ts` —
  `LoadSceneNavigationTargetOptions` gains optional `presenter?: PresenterController`,
  forwarded to `resolveComposition` via the existing
  spread-when-defined pattern. The bridge does NOT truncate the
  slice when `presenter` is supplied.
- `src/runtime/scene-loader.ts` — `SceneLoaderOptions` gains
  optional `presenterCommands?: PresenterCommandSource`. `buildLoad`
  builds a per-navigation controller via
  `createPresenterController(source, controller.signal, onError)`
  when `effectiveMode === 'present'` AND the source is supplied.
  Other modes never see the controller.
- `src/main.ts` — placeholder behavior: omits `presenterCommands`.
  Production reaches the graceful-degradation path; runners see
  `input.presenter === undefined`. ADR-023 records the DRAFT →
  ACTIVE bar (presenter UI module + runner that translates
  commands to GSAP).
- `tests/runtime/presenter.test.ts` — pure-module tests for
  `PRESENTER_COMMAND_KINDS`, `isPresenterCommand`, and
  `createPresenterController`: every kind, validation rejection
  surface, source-forwarding, unsubscribe, abort-tied teardown,
  pre-aborted signal, post-abort no-op subscribe, unknown-kind
  drop with onError diagnostic, no-source-handler emission, sibling
  isolation under handler exception.
- `tests/runtime/composition-resolver.test.ts` — new
  `'URL present-mode runner presenter forwarding (PUL-F020)'`
  describe block: every-scene forwarding, omission when absent,
  runner-ignores graceful degradation, independence from
  `headBeat` / `headRepeat`.
- `tests/runtime/scene-navigation.test.ts` — new
  `'URL present-mode presenter forwarding (PUL-F020)'` describe
  block: single-scene + composition forwarding, no truncation,
  omission when absent.
- `tests/runtime/scene-loader.test.ts` — new
  `'presenter-controls dispatch (PUL-F020 / ADR-023)'` describe
  block: present-mode forwarding (single-scene + composition,
  every-scene), absent-mode (defaults to present), per-mode
  negative (every non-present mode), no-source graceful
  degradation, every-kind delivery, abort-detaches-subscription,
  cleanup-before-handoff across a presenter-driven supersede,
  unknown-kind drop with onError diagnostic, no preemptive
  `data-pulsar-mode-*` attribute.
- This ADR.

PUL-F020 remains DRAFT. Issue #29 links to PUL-F020 via `DOCUMENTS`.
This PR is **not** an implementation of PUL-F020's "accept presenter
input" clause end-to-end — the workbench bootstrap supplies no
source, no presenter UI module exists, and the placeholder timeline
runner ignores `input.presenter`. The ACTIVE transition is gated on
the presenter UI surface AND the runner's command-translation
behavior landing with end-to-end tests; treating this PR as
satisfying PUL-F020 would be a traceability/status mismatch.

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) — the timeline runner is
  the seam through which presenter commands are translated into
  transport calls (`play()` / `pause()` / `seek()` / `tweenTo()`).
- [ADR-004](004-howler-audio-engine.md) — `ctx.audio` is the seam
  through which audio cleanup will flow on presenter-driven scene
  exits when the audio service lands.
- [ADR-007](007-browser-workbench.md) — defines the eight workbench
  modes and the URL-only-source invariant for mode selection.
  Presenter input is scoped to `mode=present` here per ADR-007's
  mode dispatch.
- [ADR-008](008-agent-native-authoring.md) — manifests-over-flow-
  control underpins the no-mode-suppression-in-resolver constraint;
  the presenter seam is data, not a flow-control hook.
- [ADR-011](011-composition-resolver-orchestration.md) — the
  resolver is opaque to mode; presenter scoping lives at the loader.
- [ADR-013](013-url-navigation-grammar-boundary.md) — the parser
  preserves `mode` and forbids recovering it from any non-URL
  source. Presenter source attachment is workbench-supplied, not
  URL-supplied.
- [ADR-014](014-url-scene-target-selection.md) — scene navigation
  dispatch is mode-blind; the bridge forwards `presenter` without
  interpretation.
- [ADR-015](015-url-beat-positioning.md) — precedent for "deliver
  the contract layer; keep the requirement DRAFT until the
  dependent runner lands."
- [ADR-016](016-workbench-mode-present.md) — establishes the
  contract-layer-plus-seam-tests precedent for `mode=present` and
  names PUL-F020 / PUL-F021 / PUL-F025 as the gating presenter-UI
  deliveries for PUL-F013 ACTIVE.
- [ADR-017](017-workbench-mode-standalone.md) through
  [ADR-021](021-workbench-mode-screenshot.md) — runner-input hint
  pattern (`repeat` / `hold` / `cueGate` / `screenshot`); ADR-023
  takes a different shape because presenter is a stream, not a
  one-shot flag, and acts on every scene rather than just the head.
- [ADR-022](022-workbench-mode-prompter.md) — loader-side
  lifecycle bypass with adapter; ADR-023 is structurally similar
  in that the workbench supplies an optional source, but the
  lifecycle still runs end-to-end (presenter does not bypass
  anything; it adds a parallel command channel).
