// Presenter controls — PUL-F020 / PUL-F021 / PUL-F025 / ADR-023 / ADR-024.
//
// Defines the runtime-side contract layer for accepting presenter
// commands under `mode=present`. The runtime does not own the input
// surface (keyboard, on-screen controls, remote presenter); a future
// workbench bootstrap supplies a {@link PresenterCommandSource} that
// the loader wraps in a per-navigation {@link PresenterController}
// before forwarding it to the timeline runner via
// {@link import('./composition-resolver').SceneTimelineRunInput.presenter}.
//
// The runner — not this module — translates a command into a timeline
// operation (ADR-003: GSAP `play()` / `pause()` / `seek()` /
// `tweenTo()`). For PUL-F021, `pause` maps to the active timeline's
// native pause (preserving the current playhead) and `resume` maps to
// native playback from that preserved position — the "same point"
// semantics. `pause` / `resume` form a transport-freeze gate that is
// orthogonal to the PUL-F020 beat-pacing commands (`hold` / `advance`
// / `skip-forward` / `skip-backward`): `pause` snapshots beat-pacing
// state and `resume` restores it without clearing a prior `hold`, and
// only `resume` unfreezes transport — a beat-pacing command received
// while paused never implicitly resumes. ADR-024 *Cross-command
// precedence* is the binding runner contract for this composition;
// the seam below only delivers the kinds, it does not enforce it.
// Duplicate `pause` while already paused and duplicate `resume` while
// already playing are idempotent no-ops at the runner. Pause/resume
// MUST NOT abort the navigation, call `cleanup(ctx)`, remount the
// scene, rewrite URL/history, or persist the playhead; they are
// runner-owned transport state on the same command seam, not a new
// mode or lifecycle path (ADR-024). The keyboard presenter source
// (`src/system/presenter/keyboard-source.ts`) and the present-mode
// transport seam `applyPresenterCommandToMaster`
// (`src/runtime/presenter-transport.ts`, wired onto the master only when
// `mode=present` forwards a controller) now deliver and honor these
// commands end to end — PUL-F020 / PUL-F021 are ACTIVE (issue #132).
//
// PUL-F025 (master mute) composes ADR-004 with this same seam by
// adding the `toggle-master-mute` kind to the allowlist below. The
// command is a *fact* ("presenter pressed mute"), not a target state:
// the loader's audio handler reads the engine's current master mute
// at command receipt time and flips it via
// `AudioService.mute(!AudioService.isMuted())`. The handler lives
// where both the per-navigation `PresenterController` and the
// per-navigation `AudioService` are in scope — `src/runtime/scene-loader.ts`
// (`buildLoad`) — and never imports Howler, touches the master
// timeline, aborts the navigation, calls `cleanup(ctx)`, or mutates
// URL / history. Master mute is engine-level runtime state, so it
// survives scene cleanup and navigation completion (the existing
// `AudioService.stopAll()` does not reset it). The keyboard presenter
// source emits `toggle-master-mute` (KeyM) end-to-end — PUL-F025 is
// ACTIVE (issue #132).
//
// References:
//  - PUL-F020 — runtime SHALL accept presenter input under
//    `mode=present` for advance / hold / skip-forward / skip-backward;
//    beat progression SHALL be interruptible without breaking
//    timeline state.
//  - PUL-F021 — runtime SHALL accept presenter input to pause the
//    active timeline and SHALL accept input to resume from the same
//    point. Extends this seam with the `pause` / `resume` command
//    kinds; transport behavior is the runner's contract (ADR-024).
//  - PUL-F025 — runtime SHALL accept presenter input to toggle
//    master mute. Master mute SHALL silence audio without altering
//    timeline state. Extends this seam with the `toggle-master-mute`
//    kind; the audio dispatch lives in `scene-loader.ts` and
//    composes `AudioService.mute()` / `isMuted()` per ADR-004.
//  - ADR-023 — workbench presenter controls: command source +
//    per-navigation controller seam.
//  - ADR-024 — presenter pause/resume: runner-owned transport state
//    on the existing presenter command seam (no new mode/source/
//    controller/schema; `pause` / `resume` join `PRESENTER_COMMAND_KINDS`).
//  - ADR-003 — GSAP timeline engine. The runner consumes
//    {@link PresenterCommand} and dispatches via GSAP's transport API.
//  - ADR-004 — Howler audio engine; master mute is engine-level
//    runtime state and the audio service exposes it via `mute()` /
//    `isMuted()`. PUL-F025's audio handler calls those methods only.
//  - ADR-007 — workbench mode dispatch; presenter input is scoped to
//    `mode=present`.
//  - ADR-016 — names PUL-F020 / PUL-F021 / PUL-F025 as the presenter
//    facets of `mode=present` that gate PUL-F013 ACTIVE.

/**
 * The presenter command kinds the runtime accepts under
 * `mode=present`. The first four are PUL-F020 (advance / hold /
 * skip-forward / skip-backward); `pause` and `resume` are PUL-F021
 * (ADR-024); `toggle-master-mute` is PUL-F025 (ADR-004), added to
 * this same allowlist rather than to a separate audio-specific
 * schema. Centralized as a single source of truth so the validator
 * and the discriminated-union type cannot drift. Frozen so a
 * misbehaving caller cannot mutate the allowlist at runtime.
 */
export const PRESENTER_COMMAND_KINDS = Object.freeze([
  'advance',
  'hold',
  'skip-forward',
  'skip-backward',
  'pause',
  'resume',
  'toggle-master-mute',
  'toggle-practice',
] as const);

/** Element type of {@link PRESENTER_COMMAND_KINDS}. */
export type PresenterCommandKind = (typeof PRESENTER_COMMAND_KINDS)[number];

/**
 * One presenter command. Discriminated by `kind` so future extensions
 * (e.g., timed advance with duration) can add fields per-kind without
 * breaking the existing flat-shape contract. The extension point is
 * `kind`: a future command that needs data extends this interface
 * into a discriminated union with kind-specific fields and updates
 * {@link isPresenterCommand} in the same module — not a second
 * command schema (ADR-024).
 */
export interface PresenterCommand {
  readonly kind: PresenterCommandKind;
}

/**
 * The workbench-supplied input surface for presenter commands.
 * Lives across navigations: the loader does not construct or own
 * the source; it merely subscribes to it for the lifetime of each
 * `mode=present` navigation through a per-navigation
 * {@link PresenterController}.
 *
 * `subscribe` returns an unsubscribe callback. Implementations
 * SHOULD invoke a handler synchronously when a command arrives so
 * the runner can correlate command receipt to the active scene's
 * timeline state without microtask gaps.
 */
export interface PresenterCommandSource {
  subscribe(handler: (cmd: PresenterCommand) => void): () => void;
}

/**
 * Per-navigation handle the timeline runner receives on
 * {@link import('./composition-resolver').SceneTimelineRunInput.presenter}.
 * Same `subscribe(handler): () => void` shape as
 * {@link PresenterCommandSource} but with two safety properties:
 *
 *  - **Auto-cleanup on abort.** Every subscription is registered with
 *    the per-navigation `AbortSignal`. When the navigation aborts
 *    (next handle, dispose, popstate, presenter-driven scene exit),
 *    every outstanding subscription is detached from the source and
 *    no further emissions reach the runner. A runner that forgets to
 *    unsubscribe cannot leak across navigations.
 *  - **Boundary validation.** Commands flowing through the controller
 *    are validated against {@link PRESENTER_COMMAND_KINDS}; unknown
 *    kinds are dropped without throwing and surfaced through the
 *    optional `onError` sink (parallel to the loader's error
 *    surface).
 *
 * The controller is constructed by the loader via
 * {@link createPresenterController} for each `mode=present`
 * navigation when the workbench supplied a source. Other modes
 * never see a controller.
 */
export interface PresenterController {
  subscribe(handler: (cmd: PresenterCommand) => void): () => void;
}

/**
 * Type guard for {@link PresenterCommand}. Used at the controller's
 * boundary to drop malformed values from a programmatic source
 * (test harness, future remote-presenter bridge, etc.) before they
 * reach the runner. Pure function — no closure captures.
 */
export function isPresenterCommand(value: unknown): value is PresenterCommand {
  if (typeof value !== 'object' || value === null) return false;
  // Reject arrays explicitly so `[]` does not satisfy the
  // `'kind' in value` shape check below by virtue of an inherited
  // `kind` property (none today, but defensive against future
  // prototype pollution).
  if (Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string') return false;
  return (PRESENTER_COMMAND_KINDS as readonly string[]).includes(kind);
}

/**
 * Build a {@link PresenterController} bound to `source` and
 * `signal`. The controller proxies `subscribe` through the source,
 * tracks every outstanding subscription, validates incoming
 * commands, and detaches all subscriptions when the signal aborts.
 *
 * Parameters:
 *  - `source` — the long-lived workbench command source.
 *  - `signal` — the per-navigation `AbortSignal` from the loader's
 *    `AbortController`. Aborting this signal tears down every
 *    subscription this controller created.
 *  - `onError` — optional sink for boundary diagnostics (unknown
 *    command kind, handler exception). Defaults to a silent drop
 *    so test harnesses without an error sink do not need to wire
 *    one. The loader passes its own `onError` so production
 *    diagnostics flow through the same channel as every other
 *    runtime-level error.
 *
 * Idempotent on a pre-aborted signal: when `signal.aborted` is
 * true at construction time, `subscribe` is a no-op that returns
 * a no-op unsubscribe. No source subscription is created.
 */
export function createPresenterController(
  source: PresenterCommandSource,
  signal: AbortSignal,
  onError?: (err: unknown) => void,
): PresenterController {
  // One record per active subscription. `active` is the single
  // source of truth for "this subscription is live" — the per-
  // subscriber unsubscribe AND the abort-driven tearDownAll BOTH
  // set it to false. The dispatch loop checks `active` before
  // forwarding so post-abort or post-unsubscribe emissions from a
  // misbehaving source whose unsubscribe ignored or threw still
  // cannot reach the runner.
  interface Subscription {
    active: boolean;
    readonly handler: (cmd: PresenterCommand) => void;
  }
  const subscriptions: Subscription[] = [];
  let aborted = signal.aborted;
  // The single source subscription's unsubscribe handle (codex
  // review, post-PUL-F025: validation and onError emission MUST
  // happen once per source event, not once per controller
  // subscriber — otherwise adding a second runtime-owned subscriber
  // would multiply diagnostic noise. The controller therefore
  // registers ONE wrapped handler on the source and fans the
  // sanitized command out to every active subscription, so adding
  // the loader's PUL-F025 audio handler does not double up
  // diagnostics for malformed kinds).
  let sourceUnsub: (() => void) | null = null;

  const reportError = (err: unknown): void => {
    if (onError === undefined) return;
    try {
      onError(err);
    } catch {
      // The error sink itself threw. There is no further surface
      // to surface that on, and re-raising would propagate through
      // the source's emission loop (potentially skipping later
      // handlers — same failure mode the per-handler isolation
      // below defends against). Swallow; the boundary already did
      // its job by dropping the malformed command.
    }
  };

  // Single centralized wrapper. Four guards layer here:
  //   1. `aborted` — controller-level abort guard. Drops every
  //      emission after the navigation aborts even if a
  //      misbehaving source kept emitting after its unsubscribe.
  //   2. `isPresenterCommand` — boundary validation; unknown kinds
  //      are dropped ONCE with an `onError` diagnostic regardless
  //      of how many subscribers are attached.
  //   3. Frozen defensive copy of the command — one subscriber
  //      cannot mutate `kind` and corrupt sibling subscribers'
  //      view of the same emission. The freeze runs once here
  //      and the same frozen object is fanned out to every
  //      subscriber.
  //   4. Per-handler try/catch — a buggy subscriber cannot poison
  //      emissions for siblings; exceptions flow through
  //      `onError`.
  const centralWrapped = (cmd: unknown): void => {
    if (aborted) return;
    if (!isPresenterCommand(cmd)) {
      reportError(
        new Error(
          `presenter command rejected: payload does not match the PresenterCommand shape (allowed kinds: ${PRESENTER_COMMAND_KINDS.join(', ')})`,
        ),
      );
      return;
    }
    const safe: PresenterCommand = Object.freeze({ kind: cmd.kind });
    // Snapshot to a local copy so a subscriber that unsubscribes
    // (or subscribes) mid-fan-out doesn't perturb iteration.
    const active = subscriptions.filter((s) => s.active);
    for (const sub of active) {
      // Re-check `active` in case a sibling handler unsubscribed
      // this sub during this same emission's fan-out.
      if (!sub.active) continue;
      try {
        sub.handler(safe);
      } catch (err) {
        reportError(err);
      }
    }
  };

  const tearDownAll = (): void => {
    aborted = true;
    // Drain into a local copy so concurrent mutation (an
    // unsubscribe callback that triggers another unsubscribe)
    // cannot skip entries. Splice-clear the live array first so
    // any later code path sees an empty registry.
    const drained = subscriptions.splice(0, subscriptions.length);
    for (const sub of drained) {
      sub.active = false;
    }
    // Detach from the source exactly once (codex review history:
    // non-idempotent unsubscribes must run at most once).
    if (sourceUnsub !== null) {
      const unsub = sourceUnsub;
      sourceUnsub = null;
      try {
        unsub();
      } catch (err) {
        // A misbehaving source could throw on unsubscribe; record
        // the diagnostic but do not propagate — the boundary's job
        // is to detach what it can and surface the rest.
        reportError(err);
      }
    }
  };

  // Lazy source attachment: register the central wrapper on the
  // source the first time a subscriber attaches. A controller with
  // zero subscribers (e.g., a timeline runner that ignores
  // `input.presenter`) does not pay a source registration.
  // Subscribe-time failures from the workbench-supplied source are
  // routed through `onError` here rather than escaping the loader's
  // `buildLoad` (codex review, post-PUL-F025: a throwing source
  // subscribe used to bypass the loader's stage-attr rollback and
  // navigation error envelope; routing through `onError` keeps
  // setup failures contained at the boundary the source owns).
  const ensureSourceAttached = (): boolean => {
    if (sourceUnsub !== null) return true;
    try {
      sourceUnsub = source.subscribe(centralWrapped);
    } catch (err) {
      reportError(err);
      return false;
    }
    return true;
  };

  if (!aborted) {
    signal.addEventListener('abort', tearDownAll, { once: true });
  }

  const subscribe = (handler: (cmd: PresenterCommand) => void): (() => void) => {
    if (aborted) {
      // Post-abort subscribes are inert by contract — no source
      // attachment, no emissions, no leak.
      return () => undefined;
    }
    const sub: Subscription = { active: true, handler };
    subscriptions.push(sub);
    // Attach the source wrapper on the first live subscription.
    // If the source's `subscribe` throws (a misbehaving workbench
    // bridge, an early-failure stub), the failure is reported
    // through `onError` and the subscription is rolled back so the
    // caller's invariant ("subscribe returns a usable unsub") is
    // preserved.
    if (!ensureSourceAttached()) {
      const idx = subscriptions.indexOf(sub);
      if (idx >= 0) subscriptions.splice(idx, 1);
      sub.active = false;
      return () => undefined;
    }
    return () => {
      // Idempotent: marking inactive is enough — the next dispatch
      // skips this sub. We remove from the registry to keep the
      // active-count snapshot cheap for steady-state.
      if (!sub.active) return;
      sub.active = false;
      const idx = subscriptions.indexOf(sub);
      if (idx >= 0) subscriptions.splice(idx, 1);
    };
  };

  return { subscribe };
}
