// Presenter controls — PUL-F020 / PUL-F021 / PUL-F025 (ADR-023 / ADR-024 / ADR-007).
//
// The runtime-side contract for presenter commands under `mode=present`.
// The runtime does not own the input surface; a workbench-supplied
// {@link PresenterCommandSource} is wrapped per-navigation into a
// {@link PresenterController} and forwarded to the timeline runner. This
// module only DELIVERS the command kinds (the allowlist below); the
// runner (`presenter-transport.ts`) honors them and the loader dispatches
// `toggle-master-mute` (PUL-F025) against the audio service.
//
// Command meanings (the runner's contract, not enforced here): beat
// pacing — `advance` / `hold` / `skip-forward` / `skip-backward`
// (PUL-F020); transport freeze — `pause` / `resume` from the same
// playhead (PUL-F021, orthogonal to beat pacing); `toggle-master-mute`
// is a fact the loader's audio handler flips (PUL-F025). None abort the
// navigation, call cleanup, or mutate URL/history.

/**
 * Presenter command kinds accepted under `mode=present` (PUL-F020 beat
 * pacing + PUL-F021 pause/resume + PUL-F025 master mute). The single
 * source of truth the validator and the type both derive from. Frozen.
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

/** One presenter command, discriminated by `kind` (the per-kind extension point — ADR-024). */
export interface PresenterCommand {
  readonly kind: PresenterCommandKind;
}

/**
 * Workbench-supplied input surface, living across navigations (the loader
 * only subscribes). `subscribe` returns an unsubscribe callback;
 * implementations SHOULD invoke handlers synchronously.
 */
export interface PresenterCommandSource {
  subscribe(handler: (cmd: PresenterCommand) => void): () => void;
}

/**
 * Per-navigation handle the runner receives, same shape as
 * {@link PresenterCommandSource} plus two guarantees: subscriptions
 * auto-detach on the navigation `AbortSignal` (no leak across
 * navigations), and commands are validated against
 * {@link PRESENTER_COMMAND_KINDS} (unknown kinds dropped via `onError`).
 */
export interface PresenterController {
  subscribe(handler: (cmd: PresenterCommand) => void): () => void;
}

/**
 * Type guard for {@link PresenterCommand}, dropping malformed values from
 * a programmatic source at the controller boundary.
 */
export function isPresenterCommand(value: unknown): value is PresenterCommand {
  if (typeof value !== 'object' || value === null) return false;
  // Reject arrays so `[]` cannot satisfy the `kind` shape check below.
  if (Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string') return false;
  return (PRESENTER_COMMAND_KINDS as readonly string[]).includes(kind);
}

/**
 * Build a {@link PresenterController} bound to `source` and `signal`:
 * proxy `subscribe`, validate commands, and detach every subscription
 * when `signal` aborts. `onError` defaults to a silent drop. On a
 * pre-aborted signal `subscribe` is an inert no-op (no source subscription).
 */
export function createPresenterController(
  source: PresenterCommandSource,
  signal: AbortSignal,
  onError?: (err: unknown) => void,
): PresenterController {
  // One record per subscription; `active` is the single live-check the
  // dispatch loop guards on, so a misbehaving source emitting after abort
  // or unsubscribe cannot reach the runner.
  interface Subscription {
    active: boolean;
    readonly handler: (cmd: PresenterCommand) => void;
  }
  const subscriptions: Subscription[] = [];
  let aborted = signal.aborted;
  // ONE wrapped handler on the source, fanning the sanitized command out to
  // every subscription, so validation + onError fire once per source event
  // (not once per subscriber) — no multiplied diagnostics.
  let sourceUnsub: (() => void) | null = null;

  const reportError = (err: unknown): void => {
    if (onError === undefined) return;
    try {
      onError(err);
    } catch {
      // A throwing error sink is swallowed — re-raising would propagate
      // through the source's emission loop and skip later handlers.
    }
  };

  // Centralized wrapper layering four guards: `aborted` (drops emissions
  // after navigation abort), `isPresenterCommand` (boundary validation,
  // diagnosed once), a frozen command copy (one subscriber cannot corrupt
  // siblings), and per-handler try/catch (one buggy subscriber cannot
  // poison siblings).
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
    // Drain into a local copy first so a re-entrant unsubscribe cannot
    // skip entries, and so later code sees an empty registry.
    const drained = subscriptions.splice(0, subscriptions.length);
    for (const sub of drained) {
      sub.active = false;
    }
    // Detach from the source exactly once (non-idempotent unsubscribes
    // must run at most once); a throwing unsubscribe is reported, not raised.
    if (sourceUnsub !== null) {
      const unsub = sourceUnsub;
      sourceUnsub = null;
      try {
        unsub();
      } catch (err) {
        reportError(err);
      }
    }
  };

  // Lazy source attachment on the first subscriber (a zero-subscriber
  // controller pays nothing). A throwing source `subscribe` is routed
  // through `onError` rather than escaping the loader's `buildLoad` — so
  // it cannot bypass the stage-attr rollback / navigation error envelope.
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
    // Attach on the first live subscription; a throwing source `subscribe`
    // rolls the subscription back so the caller still gets a usable unsub.
    if (!ensureSourceAttached()) {
      const idx = subscriptions.indexOf(sub);
      if (idx >= 0) subscriptions.splice(idx, 1);
      sub.active = false;
      return () => undefined;
    }
    return () => {
      // Idempotent: marking inactive is enough; the splice keeps the
      // active-count snapshot cheap.
      if (!sub.active) return;
      sub.active = false;
      const idx = subscriptions.indexOf(sub);
      if (idx >= 0) subscriptions.splice(idx, 1);
    };
  };

  return { subscribe };
}
