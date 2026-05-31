// Pulsar L2 — DOM keyboard presenter command source.
//
// Translates keyboard events on the document into PresenterCommands.
// The default mapping covers the documented presenter UX:
//
//   ArrowRight, PageDown → skip-forward (next scene)
//   ArrowLeft, PageUp   → skip-backward (previous scene)
//   Space               → advance (next beat / release hold)
//   KeyP               → hold (hold the current beat)
//   KeyK               → pause (freeze the active timeline — PUL-F021)
//   KeyL               → resume (resume from the same point — PUL-F021)
//   KeyM               → toggle-master-mute
//   KeyN               → toggle-practice (speaker-notes overlay)
//   Escape             → navigates to ?composition=default (home)
//
// `pause` / `resume` are deliberately separate keys, not one toggle
// key: the source maps one key to one command kind, and ADR-024 forbids
// a source-local hidden paused boolean. A future single toggle key
// belongs with a runner→workbench status surface (ADR-024, own design
// pass).
//
// Listeners are added on construction and removed by the returned
// `dispose()` so HMR replacement does not leak handlers. Keys
// inside `<input>` / `<textarea>` / `[contenteditable]` are passed
// through (no preventDefault, no command emission) so a future
// caption-edit textarea cannot lose its typing.

import type {
  PresenterCommand,
  PresenterCommandKind,
  PresenterCommandSource,
} from '../../runtime/presenter';

/** Mapping from `KeyboardEvent.code` (or `.key`) → command kind. */
export interface KeyboardPresenterBindings {
  readonly [keyCode: string]: PresenterCommandKind | 'home';
}

export const DEFAULT_KEYBOARD_BINDINGS: KeyboardPresenterBindings = {
  ArrowRight: 'skip-forward',
  Space: 'advance',
  PageDown: 'skip-forward',
  ArrowLeft: 'skip-backward',
  PageUp: 'skip-backward',
  KeyP: 'hold',
  KeyK: 'pause',
  KeyL: 'resume',
  KeyM: 'toggle-master-mute',
  KeyN: 'toggle-practice',
  Escape: 'home',
};

export interface KeyboardPresenterOptions {
  readonly target?: EventTarget;
  readonly bindings?: KeyboardPresenterBindings;
  /** Invoked when the special `home` action fires (Escape). */
  readonly onHome?: () => void;
}

export interface KeyboardPresenterHandle {
  readonly source: PresenterCommandSource;
  dispose(): void;
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (target === null) return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable === true) return true;
  return false;
};

/**
 * Build a DOM-keyboard `PresenterCommandSource`. Resolves bindings on
 * each keydown so a custom binding map can be passed without
 * pre-warming the runtime.
 */
export const createKeyboardPresenterSource = (
  opts: KeyboardPresenterOptions = {},
): KeyboardPresenterHandle => {
  const target = opts.target ?? globalThis;
  const bindings = opts.bindings ?? DEFAULT_KEYBOARD_BINDINGS;
  const handlers = new Set<(cmd: PresenterCommand) => void>();
  const source: PresenterCommandSource = {
    subscribe: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  const onKeyDown = (event: Event): void => {
    const e = event as KeyboardEvent;
    if (isEditableTarget(e.target)) return;
    // Prefer .code (layout-independent), fall back to .key.
    const action = bindings[e.code] ?? bindings[e.key];
    if (action === undefined) return;
    e.preventDefault();
    if (action === 'home') {
      opts.onHome?.();
      return;
    }
    // Snapshot so a handler that unsubscribes mid-loop can't skip a later one.
    const snapshot = Array.from(handlers);
    for (const h of snapshot) {
      h({ kind: action });
    }
  };
  target.addEventListener('keydown', onKeyDown);
  return {
    source,
    dispose: () => {
      target.removeEventListener('keydown', onKeyDown);
      handlers.clear();
    },
  };
};
