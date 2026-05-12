// DOM-backed workbench audio-unlock adapter — PUL-F030 / ADR-029.
//
// `src/main.ts` (the production browser bootstrap) wires the
// `AudioUnlockAdapter` the loader invokes BEFORE preload + scene
// `create(ctx)` + scene `timeline(ctx)` + master timeline playback
// for present-mode compositions that declare audio. The adapter mounts
// a single button on the workbench stage, awaits the user's click,
// calls `gate.unlock()` to satisfy the browser autoplay policy through
// the audio engine, removes the button, and resolves the promise. On
// navigation supersession / dispose / popstate, the gate's signal
// aborts: the adapter rejects, removes the button, and the loader's
// existing catch-and-surface path runs.
//
// The factory shape (rather than an inline function in `main.ts`) is
// what makes the workbench DOM behaviors actually testable — the
// `cycle-3 codex review` flagged that the inline adapter in
// `src/main.ts` was not covered by the gate test suite. Injecting
// `mount` (the stage) and `createButton` (the gesture surface) keeps
// the adapter logic — click wiring, abort race, button removal,
// failure-path cleanup — testable against fakes while production
// `main.ts` supplies real `document.createElement` and the `#stage`
// element.

import type { AudioUnlockAdapter, AudioUnlockContext } from './scene-loader';

/**
 * Minimal `HTMLElement`-like surface the adapter writes to. Production
 * `main.ts` passes a real `HTMLElement`; tests pass a fake. Click
 * dispatch / removal happens through these methods.
 */
export interface UnlockButtonElement {
  addEventListener(event: 'click', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(event: 'click', listener: () => void): void;
  /**
   * Remove this element from its parent. Production: `Element.remove()`.
   * Tests: a no-op or a flag setter to verify cleanup.
   */
  remove(): void;
}

/**
 * Mount callback the adapter invokes to attach the gesture surface to
 * the workbench. Decoupling the mount from a specific `Element` /
 * `appendChild` shape lets the production wiring stay compatible with
 * the real DOM (`(b) => stage.appendChild(b as unknown as Node)`) while
 * tests pass a fake that records the appended button — without forcing
 * the factory to know about `Node` or jsdom.
 */
export type UnlockMount = (button: UnlockButtonElement) => void;

/**
 * Inputs to {@link createDomAudioUnlockAdapter}.
 *
 *  - `mount` is the callback that attaches the gesture surface to the
 *    workbench. When `null`, the adapter rejects with a clear
 *    navigation-level error (the gate IS the structural defense for
 *    PUL-F030; an inert seam would silently violate the requirement).
 *  - `createButton` builds the gesture surface. The adapter wires
 *    one click listener and one signal-abort listener; the factory
 *    is responsible for any pre-wiring (label, attributes, type).
 *    Production `main.ts` builds a `<button data-pulsar-audio-
 *    unlock="gesture">Start presentation</button>`; tests build a
 *    minimal fake with an `addEventListener` / `remove` shape.
 */
export interface DomAudioUnlockHost {
  readonly mount: UnlockMount | null;
  readonly createButton: () => UnlockButtonElement;
}

/**
 * Build a {@link AudioUnlockAdapter} that collects an explicit user
 * click through the workbench DOM, satisfies the autoplay policy via
 * `gate.unlock()`, and resolves so the present-mode composition can
 * proceed.
 *
 * Contract (verified by `tests/runtime/audio-unlock-dom.test.ts`):
 *
 *  - `mount === null` → reject immediately with a clear error.
 *  - Signal already aborted on entry → reject immediately, no button
 *    mounted.
 *  - Otherwise → mount the button, install one click listener
 *    (`{ once: true }`) and one signal-abort listener. On click,
 *    call `gate.unlock()`; on the unlock's resolve, remove the
 *    button and resolve the adapter; on the unlock's reject or on
 *    a signal-abort, remove the button and reject the adapter.
 *  - The `settled` flag is set only AFTER `gate.unlock()` settles,
 *    so a supersession during `AudioContext.resume()` propagates
 *    promptly (cycle-1 review fix). The unlock then-callback bails
 *    on `settled` if abort ran first.
 *  - The adapter never receives raw scene objects, source URLs, or
 *    Howler handles — only the bounded {@link AudioUnlockContext}.
 */
/**
 * Per-invocation state the gate keeps so the click/abort race stays
 * coherent across the async `gate.unlock()` await. Hoisted to module
 * scope so the gate adapter's nested-function depth stays under
 * Sonar's S2004 4-level limit.
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

// Codex review cycle 1 (one-off "abort after the click no longer
// cancels the unlock adapter"): do NOT set `settled = true` inside
// `onClick` — keep the abort race active across the `gate.unlock()`
// await so a supersession during `AudioContext.resume()` rejects
// promptly. The unlock resolution callback bails on `settled` and
// never resolves the navigation that has already been superseded.
function onClickFired(state: GateState): void {
  if (state.settled) return;
  state.gate.unlock().then(
    () => onUnlockResolved(state),
    (err: unknown) => onUnlockRejected(state, err),
  );
}

export function createDomAudioUnlockAdapter(host: DomAudioUnlockHost): AudioUnlockAdapter {
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
