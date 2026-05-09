// Presenter controls — PUL-F020 / ADR-023.
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
// `tweenTo()`). PUL-F020 stays DRAFT until a real presenter UI lands
// AND end-to-end tests confirm advance / hold / skip-forward /
// skip-backward actually move beat state without breaking the
// timeline.
//
// References:
//  - PUL-F020 — runtime SHALL accept presenter input under
//    `mode=present` for advance / hold / skip-forward / skip-backward;
//    beat progression SHALL be interruptible without breaking
//    timeline state.
//  - ADR-023 — workbench presenter controls: command source +
//    per-navigation controller seam.
//  - ADR-003 — GSAP timeline engine. The runner consumes
//    {@link PresenterCommand} and dispatches via GSAP's transport API.
//  - ADR-007 — workbench mode dispatch; presenter input is scoped to
//    `mode=present`.
//  - ADR-016 — ADR-016 names PUL-F020 as one of the four facets that
//    gates PUL-F013 ACTIVE.

/**
 * The four command kinds PUL-F020 names. Centralized as a single
 * source of truth so the validator and the discriminated-union type
 * cannot drift. Frozen so a misbehaving caller cannot mutate the
 * allowlist at runtime.
 */
export const PRESENTER_COMMAND_KINDS = Object.freeze([
  'advance',
  'hold',
  'skip-forward',
  'skip-backward',
] as const);

/** Element type of {@link PRESENTER_COMMAND_KINDS}. */
export type PresenterCommandKind = (typeof PRESENTER_COMMAND_KINDS)[number];

/**
 * One presenter command. Discriminated by `kind` so future extensions
 * (e.g., timed advance with duration) can add fields per-kind without
 * breaking the existing four-shape contract.
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
  // source of truth for "this subscription is live" — both the
  // per-subscriber unsubscribe AND the abort-driven tearDownAll
  // check it before calling `sourceUnsub`, so a non-idempotent
  // source receives at most one unsubscribe per registration even
  // when both teardown paths fire (codex review: abort-then-runner-
  // unsubscribe and per-scene-after-nav-abort are real overlapping
  // paths). The wrapped handler also checks `active` before
  // forwarding, so post-abort emissions cannot reach the runner
  // even if a misbehaving source ignored or threw on its
  // unsubscribe.
  interface Subscription {
    active: boolean;
    sourceUnsub: () => void;
  }
  const subscriptions: Subscription[] = [];
  let aborted = signal.aborted;

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

  const tearDownSubscription = (sub: Subscription): void => {
    if (!sub.active) return;
    // Mark inactive BEFORE calling sourceUnsub so the wrapped
    // handler's `!sub.active` guard fires for any in-flight
    // emissions the source is still mid-iteration over (covers
    // sources whose unsubscribe is asynchronous-leaning or whose
    // accounting is non-idempotent).
    sub.active = false;
    try {
      sub.sourceUnsub();
    } catch (err) {
      // A misbehaving source could throw on unsubscribe; record
      // the diagnostic but keep tearing the rest down. Without
      // the catch a single bad source would strand the remaining
      // subscriptions.
      reportError(err);
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
      tearDownSubscription(sub);
    }
  };

  if (aborted) {
    // Signal already fired before construction. Nothing to wire;
    // subscribe will fall through to the aborted no-op below.
  } else {
    signal.addEventListener('abort', tearDownAll, { once: true });
  }

  const subscribe = (handler: (cmd: PresenterCommand) => void): (() => void) => {
    if (aborted) {
      // Post-abort subscribes are inert by contract — no source
      // attachment, no emissions, no leak.
      return () => undefined;
    }
    // Pre-allocate the subscription record so the wrapped handler
    // closure can capture it. `sourceUnsub` is patched in
    // immediately after `source.subscribe(wrapped)` returns.
    const sub: Subscription = { active: true, sourceUnsub: () => undefined };
    // Validate-and-forward wrapper. Five guards layer here:
    //   1. `!sub.active` — post-abort or post-unsubscribe emission
    //      from a misbehaving source whose own unsubscribe didn't
    //      actually detach. Without this, a bad source could
    //      deliver commands to a runner whose subscription was
    //      torn down. This is the leak-prevention invariant
    //      (codex review).
    //   2. `aborted` — controller-level abort guard. Same defense
    //      as `!sub.active` but cheaper to check (one bool).
    //   3. `isPresenterCommand` — boundary validation; unknown
    //      kinds are dropped with an `onError` diagnostic.
    //   4. Frozen defensive copy of the command — one subscriber
    //      cannot mutate `kind` and corrupt later subscribers'
    //      view of the same emission (the source emits ONE
    //      reference to every wrapped handler).
    //   5. Per-handler try/catch — a buggy subscriber cannot
    //      poison emissions for siblings; exceptions flow through
    //      `onError`.
    const wrapped = (cmd: unknown): void => {
      if (!sub.active || aborted) return;
      if (!isPresenterCommand(cmd)) {
        reportError(
          new Error(
            `presenter command rejected: payload does not match the PresenterCommand shape (allowed kinds: ${PRESENTER_COMMAND_KINDS.join(', ')})`,
          ),
        );
        return;
      }
      const safe: PresenterCommand = Object.freeze({ kind: cmd.kind });
      try {
        handler(safe);
      } catch (err) {
        reportError(err);
      }
    };
    sub.sourceUnsub = source.subscribe(wrapped);
    subscriptions.push(sub);
    return () => {
      // Idempotent: re-calling does nothing because
      // `tearDownSubscription` short-circuits on `!sub.active`.
      // Also covers the abort-then-runner-unsubscribe race where
      // the abort listener already drained this sub; the
      // remove-then-tear-down sequence handles either order
      // safely.
      const idx = subscriptions.indexOf(sub);
      if (idx >= 0) subscriptions.splice(idx, 1);
      tearDownSubscription(sub);
    };
  };

  return { subscribe };
}
