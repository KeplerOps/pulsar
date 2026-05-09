# PUL-F020 Presenter Controls Preflight

PUL-F020 specifies the runtime-side acceptance of presenter input
under `mode=present`: advance to the next beat, hold the current
beat, skip forward, and skip backward, with beat progression
interruptible without breaking timeline state. It is one of the
four facets ADR-016 names as gating PUL-F013 ACTIVE; the visible
presenter UI surface and the GSAP runner that translates commands
to transport calls are out of scope for this requirement and are
the gating deliveries for PUL-F020 ACTIVE.

## Boundary

Presenter input must flow through the existing navigation /
lifecycle boundary:

- `src/runtime/navigation.ts` owns the `mode` URL grammar and the
  `NAVIGATION_MODES` allowlist. Presenter input is not a URL
  parameter; it is a workbench-supplied stream.
- `effectiveMode()` owns the absent-mode default to `present`. The
  loader uses this to scope presenter forwarding to mode=present
  (explicit OR absent).
- `src/runtime/scene-loader.ts` owns per-navigation mode dispatch,
  `ctx.mode` construction, AND the per-navigation
  `PresenterController` construction.
- `src/runtime/scene-navigation.ts` owns scene/composition target
  resolution and the lifecycle bridge; it forwards `presenter`
  without interpretation.
- `src/runtime/composition-resolver.ts` owns lifecycle ordering,
  abort propagation, and cleanup; it forwards `presenter` to every
  scene's run input.
- `src/runtime/presenter.ts` is the new pure module that defines
  the command shape, the source/controller interfaces, and the
  per-navigation controller factory.

Do not add a parallel keyboard listener at the runtime level, a
second cleanup pathway for presenter-driven aborts, or a
per-scene command pump. Mode dispatch and per-navigation
controller construction live at one seam (`buildLoad` in the
loader); subscriptions auto-detach via the existing
`AbortController.signal`.

## Required Reuse

Implementation must reuse these cross-cutting concerns:

- URL grammar and mode validation: `parseNavigationSearch()`,
  `NAVIGATION_MODES`, `effectiveMode()`. Do not introduce a
  parallel "is present" check or a duplicate mode allowlist.
- Lifecycle orchestration: `loadSceneNavigationTarget()` and
  `resolveComposition()`. Forward `presenter` through the existing
  spread-when-defined pattern parallel to `signal`.
- Abort and cleanup: one per-navigation `AbortController`. The
  presenter controller's auto-detach binds to the same signal that
  drives lifecycle cleanup; no separate cleanup wiring.
- Error rendering: the loader's `onError` sink. Boundary
  diagnostics from the controller (unknown command kind, handler
  exception) flow through the same channel as every other
  runtime-level error.
- Frozen invariants: `Object.freeze` for the command-kind allowlist
  and the command discriminator object so a misbehaving runner
  cannot mutate them post-emission. `deepFreeze` is not needed
  (commands are flat).
- Identifier validation: `src/runtime/identifier.ts` is not used
  here (commands are kind-based, not id-based).

## Guardrails

- Presenter input is scoped to `mode=present`. The loader builds
  the controller only when `effectiveMode(target) === 'present'`
  AND `presenterCommands` is supplied. No leak into standalone /
  loop / paused / scrub / screenshot / prompter.
- Commands are translated to timeline operations by the runner,
  not the runtime core. ADR-003 names GSAP `play()` / `pause()` /
  `seek()` / `tweenTo()` as the legitimate transport calls. No
  `setTimeout` / `setInterval` polling for command arrivals.
- The runtime does not attach keyboard listeners. The future
  presenter UI module (a workbench surface) attaches listeners,
  translates them to `PresenterCommand`s, and emits via a
  `PresenterCommandSource`. ADR-007's "URL is the only source for
  mode" rule extends here: the runtime does not look at
  `window.location` or any global to decide whether commands are
  active; the workbench-supplied source IS the gate.
- The controller's auto-detach is a safety net, not a substitute
  for runner hygiene. A runner that subscribes SHOULD still call
  the returned unsubscribe on its own scene-exit path; the abort-
  driven detach catches the runner that forgets.
- Boundary validation drops unknown command kinds. The runner does
  not see malformed commands; the diagnostic flows through
  `onError`. Do not throw from the boundary; do not unmount the
  scene to report a malformed command.
- The interruptibility clause ("beat progression SHALL be
  interruptible without breaking timeline state") is satisfied by
  the existing PUL-F006 mandatory-cleanup invariant. Do not
  introduce a second cleanup path or skip cleanup on the abort
  branch.

## Non-Goals

PUL-F020 should not implement:

- Pause / resume (PUL-F021 — separate requirement).
- Master mute (PUL-F025 — separate requirement).
- Scene-level skip ("jump to next/prev scene"). The four named
  commands are beat-level navigation within the active scene;
  scene-level navigation is a URL-grammar concern (PUL-F008 / PUL-F011).
- Scrub controls (PUL-F017 / `mode=scrub`). Skip is a discrete
  beat jump, not a continuous millisecond seek.
- A remote-presenter protocol (HTTP, WebSocket, etc.). The source
  is workbench-supplied; how it gathers input (keyboard, on-screen
  controls, future remote-presenter bridge) is the source's
  concern.
- The visible presenter UI surface (keyboard listener, on-screen
  controls). PUL-F020 ACTIVE depends on this surface; the
  contract layer ships first per the ADR-016 / ADR-017 / ADR-018 /
  ADR-019 / ADR-020 / ADR-021 / ADR-022 precedent.
- The GSAP runner that translates commands to transport calls
  (ADR-003 territory). PUL-F020 ACTIVE depends on this runner.

## Anti-Patterns

- Attaching keyboard listeners at the scene level. Scenes receive
  commands through the runner's `input.presenter` subscription
  (when the runner needs that signal); they do not run their own
  input pumps.
- Duplicating `PRESENTER_COMMAND_KINDS` or re-validating command
  shapes inside the runner. The controller's `isPresenterCommand`
  check is the single boundary; the runner sees only well-formed
  commands.
- Treating skip as scrub. Skip is a beat-level jump; scrub is a
  continuous-seek interaction model owned by `mode=scrub`.
- Treating hold as pause. Hold pauses the current beat (timeline
  paused at the current position); pause / resume is a separate
  full-composition transport state owned by PUL-F021.
- Building a long-lived controller that survives across
  navigations. The controller is per-navigation; subscriptions
  auto-detach when the navigation aborts. A long-lived controller
  re-introduces the leak failure mode the per-navigation design
  defends against.
- Reading mode from `window.location` to decide whether to subscribe
  inside the runner. The runner subscribes when `input.presenter`
  is present; the loader's mode-scoping decides presence.
- Building a second exception hierarchy for presenter errors. The
  controller's boundary diagnostics use the existing `onError`
  sink with plain `Error` objects. Callers pattern-match on the
  prefix `presenter command rejected:` if they need to (the
  message naming follows the resolver's `composition resolution
  failed:` envelope precedent — same prefix-style diagnostic
  surface, no separate type).
- Using `setTimeout` / polling to schedule command arrivals. The
  source emits synchronously; the controller forwards
  synchronously; the runner translates to GSAP transport calls
  that are themselves frame-aligned (ADR-003).
- Creating a `data-pulsar-mode-*` suppression attribute under
  `mode=present` to gate the runner's subscription. ADR-016 forbids
  preemptive suppression attributes under `mode=present`. The
  runner's behavior is gated by `input.presenter`'s presence, not
  by stage-attribute introspection.
