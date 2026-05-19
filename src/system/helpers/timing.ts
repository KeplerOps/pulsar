// Pulsar L2 — timing helpers.
//
// Authored decks pace beats and dwells through a small set of timing
// primitives that integrate with the runtime's per-navigation
// `AbortSignal` (the navigation supersession surface every loader hook
// already receives) and with `PresenterController`'s `advance` command.
//
// These replace the ambient `state.advanceSignal` boolean used by the
// hand-rolled demo_thoughts decks. The signal-and-controller surface
// is what the runtime already publishes; helpers thread it through
// explicitly instead of reaching for a module-level mutable.

import type { PresenterCommand, PresenterController } from '../../runtime/presenter';
import { ADVANCE_GATE_LABEL, ADVANCE_GATE_PREFIX } from '../../runtime/timeline';

/**
 * Minimal GSAP-timeline shape `addAdvanceGate` writes against. Avoids a
 * direct dependency on `gsap.core.Timeline` here so the helper is
 * importable from unit tests with plain object stubs.
 */
interface AdvanceGateTimeline {
  addLabel(name: string, time?: number): unknown;
  duration?(): number;
}

/**
 * Mark "wait for the presenter to advance" at the current end of a
 * scene's timeline (or at an explicit `time`). When the master is
 * composed from this scene's timeline, the gate becomes a `master.addPause`
 * at the corresponding master-time; the presenter `advance` command
 * resumes playback.
 *
 * Pass `name` to author multiple gates per scene — each becomes a
 * unique `_advance-gate:<name>` label.
 */
export const addAdvanceGate = (
  tl: AdvanceGateTimeline,
  options: { readonly name?: string; readonly time?: number } = {},
): void => {
  const labelBase =
    options.name === undefined ? ADVANCE_GATE_LABEL : ADVANCE_GATE_PREFIX + options.name;
  const at = options.time ?? tl.duration?.();
  if (at === undefined) {
    tl.addLabel(labelBase);
  } else {
    tl.addLabel(labelBase, at);
  }
};

/**
 * Promise-returning `setTimeout` wrapper. Not abortable — for abortable
 * dwells use {@link aSleep}.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms); // PUL-Q001-allow: authoring-time pacing helper; screenshot mode pauses the master at frame 0 before scenes invoke this.
  });

/**
 * Options for {@link aSleep}.
 *
 *  - `signal`: the per-navigation `AbortSignal`; the dwell resolves
 *    immediately when fired (returning `false`).
 *  - `controller`: a `PresenterController`; the dwell resolves immediately
 *    when an `advance` command is emitted (returning `false`).
 *
 * Either, both, or neither can be supplied. With neither, behavior
 * degrades to a plain `sleep(ms)` that always resolves `true`.
 */
export interface ASleepOptions {
  readonly signal?: AbortSignal;
  readonly controller?: PresenterController;
}

/**
 * Abortable dwell.
 *
 * Resolves `true` when the full duration elapses. Resolves `false`
 * early when the per-navigation `AbortSignal` fires or the
 * `PresenterController` emits an `advance` command. Used inside scene
 * action sequences so a long dwell does not block a presenter who
 * pressed the advance key mid-beat.
 *
 * Uses a single `setTimeout` plus event subscriptions — no polling.
 */
export const aSleep = (ms: number, opts: ASleepOptions = {}): Promise<boolean> => {
  const { signal, controller } = opts;
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    const finish = (completed: boolean): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      if (unsubscribe !== null) unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const onCommand = (cmd: PresenterCommand): void => {
      if (cmd.kind === 'advance') finish(false);
    };
    timer = setTimeout(() => finish(true), ms); // PUL-Q001-allow: abortable dwell; screenshot mode pauses the master at frame 0 before scenes invoke this.
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
    if (controller !== undefined) unsubscribe = controller.subscribe(onCommand);
  });
};

/**
 * Start a recurring callback every `intervalMs`, returning a stop
 * handle. Used by scene templates that drive ambient updates (metric
 * tickers, animated clocks). The handle's `stop()` is idempotent.
 *
 * Pulled into this helper module so the scanner-level
 * `PUL-Q001-allow:` exemption stays in one well-known place rather
 * than per template.
 */
export const startInterval = (callback: () => void, intervalMs: number): { stop(): void } => {
  const handle = setInterval(callback, intervalMs); // PUL-Q001-allow: shared authoring-time interval helper; scenes that use this never run under mode=screenshot.
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
    },
  };
};

/**
 * Schedule a one-shot callback after `delayMs`. Returns a cancel
 * handle. Pulled into helpers for the same single-exemption reason
 * as {@link startInterval}.
 */
export const schedule = (callback: () => void, delayMs: number): { cancel(): void } => {
  const handle = setTimeout(callback, delayMs); // PUL-Q001-allow: shared authoring-time scheduler; scenes that use this never run under mode=screenshot.
  let cancelled = false;
  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(handle);
    },
  };
};

/**
 * Resolve on the next `advance` command from the presenter controller,
 * OR when the per-navigation `AbortSignal` fires. Used by scene
 * functions that have nothing visual left to do but need to wait for
 * the presenter before advancing the composition.
 *
 * Returns `'advance'` when an advance command was received,
 * `'aborted'` when the navigation was superseded.
 *
 * Unlike `holdUntilAdvance` in the demo_thoughts decks, this does not
 * poll a global flag; it subscribes to the controller exactly once.
 */
export const holdUntilAdvance = (
  controller: PresenterController,
  signal?: AbortSignal,
): Promise<'advance' | 'aborted'> => {
  if (signal?.aborted === true) return Promise.resolve('aborted');
  return new Promise<'advance' | 'aborted'>((resolve) => {
    let done = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (outcome: 'advance' | 'aborted'): void => {
      if (done) return;
      done = true;
      if (unsubscribe !== null) unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish('aborted');
    const onCommand = (cmd: PresenterCommand): void => {
      if (cmd.kind === 'advance') finish('advance');
    };
    unsubscribe = controller.subscribe(onCommand);
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
  });
};
