// DOM-backed workbench audio-unlock adapter — PUL-F030 / ADR-029.
//
// The workbench-layer `AudioUnlockAdapter` the loader invokes before
// preload + scene lifecycle for present-mode compositions that declare
// audio. Mounts a gesture button on the stage, awaits the click, calls
// `gate.unlock()` to satisfy autoplay policy through the audio engine,
// removes the button, and resolves. On navigation abort it rejects and
// removes the button. `mount` / `createButton` are injected so the DOM
// choreography is testable against fakes; production `main.ts` supplies
// the real `#stage` and `document.createElement`.

import type { AudioUnlockAdapter, AudioUnlockContext } from './scene-loader-guard';

/** Minimal `HTMLElement`-like surface the adapter writes to (real button in prod, fake in tests). */
export interface UnlockButtonElement {
  addEventListener(event: 'click', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(event: 'click', listener: () => void): void;
  /** Remove this element from its parent. Production: `Element.remove()`. */
  remove(): void;
}

/** Mount callback that attaches the gesture surface to the workbench. */
export type UnlockMount<B extends UnlockButtonElement = UnlockButtonElement> = (button: B) => void;

/**
 * Inputs to {@link createDomAudioUnlockAdapter}, generic over the concrete
 * button type so production passes a real `HTMLButtonElement` (no cast).
 * A `null` mount rejects at navigation time — the gate IS the structural
 * defense for PUL-F030, so an inert seam would silently violate it.
 */
export interface DomAudioUnlockHost<B extends UnlockButtonElement = UnlockButtonElement> {
  readonly mount: UnlockMount<B> | null;
  readonly createButton: () => B;
}

/**
 * Per-invocation state the click/abort handlers share across the async
 * `gate.unlock()` await: the button, resolvers, listeners, and the
 * `settled` once-guard.
 */
interface GateState {
  readonly button: UnlockButtonElement;
  readonly gate: AudioUnlockContext;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
  readonly onClick: () => void;
  readonly onAbort: () => void;
  settled: boolean;
}

function cleanup(state: GateState): void {
  state.button.removeEventListener('click', state.onClick);
  state.gate.signal.removeEventListener('abort', state.onAbort);
  state.button.remove();
}

function onUnlockResolved(state: GateState): void {
  if (state.settled) return;
  state.settled = true;
  cleanup(state);
  state.resolve();
}

function onUnlockRejected(state: GateState, err: unknown): void {
  if (state.settled) return;
  state.settled = true;
  cleanup(state);
  state.reject(err instanceof Error ? err : new Error(String(err)));
}

function onAbortFired(state: GateState): void {
  if (state.settled) return;
  state.settled = true;
  cleanup(state);
  state.reject(new Error('audio unlock gate: navigation aborted before unlock completed'));
}

// Do NOT set `settled` here: the abort race must stay live across the
// `gate.unlock()` await so a supersession during `AudioContext.resume()`
// still rejects promptly. The unlock callbacks bail on `settled`.
function onClickFired(state: GateState): void {
  if (state.settled) return;
  state.gate.unlock().then(
    () => onUnlockResolved(state),
    (err: unknown) => onUnlockRejected(state, err),
  );
}

/**
 * Build an {@link AudioUnlockAdapter} that collects a user click, calls
 * `gate.unlock()`, and resolves. `mount === null` or an already-aborted
 * signal rejects immediately (no button mounted); otherwise a click
 * triggers `gate.unlock()` whose settlement removes the button and
 * resolves/rejects. A signal abort before settlement rejects.
 * Contract verified by `tests/runtime/audio-unlock-dom.test.ts`.
 */
export function createDomAudioUnlockAdapter<B extends UnlockButtonElement>(
  host: DomAudioUnlockHost<B>,
): AudioUnlockAdapter {
  return (gate: AudioUnlockContext) =>
    new Promise<void>((resolve, reject) => {
      if (host.mount === null) {
        reject(
          new Error('audio unlock gate: workbench has no mount element for the gesture surface'),
        );
        return;
      }
      if (gate.signal.aborted) {
        reject(new Error('audio unlock gate: navigation aborted before user gesture'));
        return;
      }
      const button = host.createButton();
      const state: GateState = {
        button,
        gate,
        resolve,
        reject,
        settled: false,
        onClick: () => onClickFired(state),
        onAbort: () => onAbortFired(state),
      };
      button.addEventListener('click', state.onClick, { once: true });
      gate.signal.addEventListener('abort', state.onAbort, { once: true });
      host.mount(button);
    });
}
