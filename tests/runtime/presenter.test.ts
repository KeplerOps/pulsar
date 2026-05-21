// Presenter controls — PUL-F020 / PUL-F021 / PUL-F025 / ADR-023 / ADR-024.
//
// Pure tests for the presenter command boundary: the discriminator
// validator, the per-navigation controller's subscribe / unsubscribe
// semantics, and the abort-tied auto-cleanup that prevents
// subscriptions from leaking across navigations. The loader-side
// dispatch tests (including the PUL-F025 master-mute audio handler)
// live in `scene-loader-present.test.ts`.
//
// References:
//  - PUL-F020 — runtime SHALL accept presenter input under mode=present
//    (advance / hold / skip-forward / skip-backward).
//  - PUL-F021 — runtime SHALL accept presenter input to pause the
//    active timeline and resume from the same point. ADR-024 records
//    that PUL-F021 extends this same command seam by adding the
//    `pause` and `resume` kinds; "same point" playhead behavior is
//    the future GSAP runner's contract, so PUL-F021 stays DRAFT until
//    that runner lands.
//  - PUL-F025 — runtime SHALL accept presenter input to toggle master
//    mute. Master mute SHALL silence audio without altering timeline
//    state. Composes ADR-004 (master mute owned by the audio engine)
//    with the same command seam by adding the `toggle-master-mute`
//    kind; the engine-level mute mechanics already exist in
//    `src/runtime/audio.ts`. The loader-side dispatch (subscribe in
//    `buildLoad`, call `audio.mute(!audio.isMuted())`) is the
//    PUL-F025-specific wiring and is pinned in the scene-loader
//    suite. PUL-F025 stays DRAFT until a presenter UI surface lands
//    and emits the kind end-to-end, mirroring the PUL-F020 / PUL-F021
//    precedent.
//  - ADR-023 — presenter command source / per-navigation controller.
//  - ADR-024 — presenter pause/resume on the existing command seam.

import { describe, expect, it, vi } from 'vitest';
import {
  PRESENTER_COMMAND_KINDS,
  type PresenterCommand,
  type PresenterCommandSource,
  createPresenterController,
  isPresenterCommand,
} from '../../src/runtime/presenter';

const buildSource = (): {
  source: PresenterCommandSource;
  emit: (cmd: unknown) => void;
  handlers: Set<(cmd: PresenterCommand) => void>;
} => {
  const handlers = new Set<(cmd: PresenterCommand) => void>();
  const source: PresenterCommandSource = {
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  const emit = (cmd: unknown): void => {
    for (const h of handlers) h(cmd as PresenterCommand);
  };
  return { source, emit, handlers };
};

describe('PRESENTER_COMMAND_KINDS', () => {
  it('lists the eight kinds PUL-F020 + PUL-F021 + PUL-F025 + L2 presenter UX name', () => {
    // PUL-F020: advance / hold / skip-forward / skip-backward.
    // PUL-F021 (ADR-024): pause / resume extend the same allowlist.
    // PUL-F025: toggle-master-mute extends the same allowlist again.
    // L2 presenter UX: toggle-practice extends it again so the
    // speaker-notes overlay rides the same command bus as the rest of
    // the presenter surface (no second command schema, no second
    // controller, no second source).
    expect([...PRESENTER_COMMAND_KINDS]).toEqual([
      'advance',
      'hold',
      'skip-forward',
      'skip-backward',
      'pause',
      'resume',
      'toggle-master-mute',
      'toggle-practice',
    ]);
  });

  it('is frozen so callers cannot mutate the allowlist at runtime', () => {
    expect(Object.isFrozen(PRESENTER_COMMAND_KINDS)).toBe(true);
  });
});

describe('isPresenterCommand (PUL-F020 / PUL-F021 / PUL-F025 / ADR-023 / ADR-024)', () => {
  it('accepts every kind PUL-F020 + PUL-F021 + PUL-F025 name', () => {
    for (const kind of PRESENTER_COMMAND_KINDS) {
      expect(isPresenterCommand({ kind })).toBe(true);
    }
  });

  it('accepts the PUL-F021 pause and resume kinds explicitly', () => {
    // Pin the PUL-F021 contract clause directly: the boundary admits
    // `pause` (pause the active timeline) and `resume` (resume from
    // the same point) so the workbench command source can deliver
    // them to the runner. Independent of the loop above so a
    // regression that dropped only these two kinds is caught.
    expect(isPresenterCommand({ kind: 'pause' })).toBe(true);
    expect(isPresenterCommand({ kind: 'resume' })).toBe(true);
  });

  it('accepts the PUL-F025 toggle-master-mute kind explicitly', () => {
    // Pin the PUL-F025 contract clause directly: the boundary admits
    // `toggle-master-mute` so the workbench command source can
    // deliver presenter master-mute requests to the loader-side
    // audio handler. Independent of the loop above so a regression
    // that dropped only this kind is caught — and so a regression
    // that drifted the kind's spelling (e.g., to `mute` or
    // `master-mute`) is caught with a specific failure.
    expect(isPresenterCommand({ kind: 'toggle-master-mute' })).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(isPresenterCommand({ kind: 'rewind' })).toBe(false);
    expect(isPresenterCommand({ kind: '' })).toBe(false);
    expect(isPresenterCommand({ kind: 'ADVANCE' })).toBe(false);
    // `mode=paused` is a URL inspection mode (ADR-019), not a
    // presenter command — its name must not be admitted as a kind.
    expect(isPresenterCommand({ kind: 'paused' })).toBe(false);
    // PUL-F025 spelling defense: only the full `toggle-master-mute`
    // is admitted. Common drift candidates must remain rejected so
    // a misspelled workbench source cannot smuggle the kind in.
    expect(isPresenterCommand({ kind: 'mute' })).toBe(false);
    expect(isPresenterCommand({ kind: 'master-mute' })).toBe(false);
    expect(isPresenterCommand({ kind: 'unmute' })).toBe(false);
    expect(isPresenterCommand({ kind: 'toggle-mute' })).toBe(false);
  });

  it('rejects values that are not plain command objects', () => {
    expect(isPresenterCommand(null)).toBe(false);
    expect(isPresenterCommand(undefined)).toBe(false);
    expect(isPresenterCommand('advance')).toBe(false);
    expect(isPresenterCommand(42)).toBe(false);
    expect(isPresenterCommand([])).toBe(false);
    expect(isPresenterCommand({})).toBe(false);
  });

  it('rejects when "kind" is the wrong type even if present', () => {
    expect(isPresenterCommand({ kind: 1 })).toBe(false);
    expect(isPresenterCommand({ kind: null })).toBe(false);
    expect(isPresenterCommand({ kind: undefined })).toBe(false);
  });
});

describe('createPresenterController (PUL-F020 / PUL-F021 / PUL-F025 / ADR-023 / ADR-024)', () => {
  it('forwards every valid command from the source to the subscribed handler', () => {
    const { source, emit } = buildSource();
    const controller = new AbortController();
    const ctl = createPresenterController(source, controller.signal);
    const seen: PresenterCommand[] = [];
    ctl.subscribe((cmd) => seen.push(cmd));
    for (const kind of PRESENTER_COMMAND_KINDS) {
      emit({ kind });
    }
    expect(seen.map((c) => c.kind)).toEqual([
      'advance',
      'hold',
      'skip-forward',
      'skip-backward',
      'pause',
      'resume',
      'toggle-master-mute',
      'toggle-practice',
    ]);
  });

  it('forwards the PUL-F021 pause and resume commands to the runner (ADR-024)', () => {
    // PUL-F021 contract clause at the seam: a workbench-supplied
    // source emitting `pause` then `resume` reaches the runner's
    // handler in order. How the runner translates them — native
    // `pause()` / playhead-preserving `play()`, and how `pause` /
    // `resume` compose with the beat-pacing kinds (ADR-024
    // *Cross-command precedence*) — is the runner's contract, proved
    // by the future GSAP runner's tests; the controller's job here is
    // only to deliver the kinds, which is what this test pins.
    const { source, emit } = buildSource();
    const controller = new AbortController();
    const ctl = createPresenterController(source, controller.signal);
    const seen: PresenterCommand[] = [];
    ctl.subscribe((cmd) => seen.push(cmd));
    emit({ kind: 'pause' });
    emit({ kind: 'resume' });
    expect(seen.map((c) => c.kind)).toEqual(['pause', 'resume']);
  });

  it('forwards the PUL-F025 toggle-master-mute command to the subscriber', () => {
    // PUL-F025 contract clause at the seam: a workbench-supplied
    // source emitting `toggle-master-mute` reaches the subscribed
    // handler in order. The loader-side audio dispatch (call
    // `audio.mute(!audio.isMuted())`) is pinned by the
    // scene-loader-present suite; here we pin only that the kind
    // crosses the command boundary unchanged, independent of any
    // audio service.
    const { source, emit } = buildSource();
    const controller = new AbortController();
    const ctl = createPresenterController(source, controller.signal);
    const seen: PresenterCommand[] = [];
    ctl.subscribe((cmd) => seen.push(cmd));
    emit({ kind: 'toggle-master-mute' });
    emit({ kind: 'toggle-master-mute' });
    expect(seen.map((c) => c.kind)).toEqual(['toggle-master-mute', 'toggle-master-mute']);
  });

  it('returns an unsubscribe that detaches the handler from further emissions', () => {
    const { source, emit } = buildSource();
    const controller = new AbortController();
    const ctl = createPresenterController(source, controller.signal);
    const seen: PresenterCommand[] = [];
    const unsub = ctl.subscribe((cmd) => seen.push(cmd));
    emit({ kind: 'advance' });
    unsub();
    emit({ kind: 'hold' });
    expect(seen.map((c) => c.kind)).toEqual(['advance']);
  });

  it('auto-tears-down every outstanding subscription when the signal aborts', () => {
    const { source, emit, handlers } = buildSource();
    const controller = new AbortController();
    const ctl = createPresenterController(source, controller.signal);
    const seenA: PresenterCommand[] = [];
    const seenB: PresenterCommand[] = [];
    ctl.subscribe((cmd) => seenA.push(cmd));
    ctl.subscribe((cmd) => seenB.push(cmd));
    emit({ kind: 'advance' });
    controller.abort();
    emit({ kind: 'hold' });
    expect(seenA.map((c) => c.kind)).toEqual(['advance']);
    expect(seenB.map((c) => c.kind)).toEqual(['advance']);
    // The controller must remove its own source subscription too — a
    // controller that left handlers attached to the source would leak
    // memory across navigations even though emissions are blocked.
    expect(handlers.size).toBe(0);
  });

  it('subscribe-after-abort returns a no-op unsubscribe and never emits', () => {
    const { source, emit, handlers } = buildSource();
    const controller = new AbortController();
    const ctl = createPresenterController(source, controller.signal);
    controller.abort();
    const seen: PresenterCommand[] = [];
    const unsub = ctl.subscribe((cmd) => seen.push(cmd));
    emit({ kind: 'advance' });
    expect(seen).toEqual([]);
    expect(handlers.size).toBe(0);
    expect(() => unsub()).not.toThrow();
  });

  it('treats a signal that is already aborted at construction as fully torn down', () => {
    const { source, emit, handlers } = buildSource();
    const controller = new AbortController();
    controller.abort();
    const ctl = createPresenterController(source, controller.signal);
    const seen: PresenterCommand[] = [];
    ctl.subscribe((cmd) => seen.push(cmd));
    emit({ kind: 'advance' });
    expect(seen).toEqual([]);
    expect(handlers.size).toBe(0);
  });

  it('drops unknown command kinds at the controller boundary and reports via onError', () => {
    const { source, emit } = buildSource();
    const controller = new AbortController();
    const onError = vi.fn();
    const ctl = createPresenterController(source, controller.signal, onError);
    const seen: PresenterCommand[] = [];
    ctl.subscribe((cmd) => seen.push(cmd));
    emit({ kind: 'rewind' });
    emit({ kind: 'advance' });
    emit(null);
    emit({ kind: 'hold' });
    expect(seen.map((c) => c.kind)).toEqual(['advance', 'hold']);
    // Two diagnostics: one for `{ kind: 'rewind' }`, one for `null`.
    expect(onError).toHaveBeenCalledTimes(2);
    for (const call of onError.mock.calls) {
      expect(call[0]).toBeInstanceOf(Error);
      expect((call[0] as Error).message).toMatch(/presenter/i);
    }
  });

  it('reports a rejected emission ONCE regardless of subscriber count (centralized validation)', () => {
    // Codex review, post-PUL-F025: each PresenterController used
    // to attach a wrapped handler PER subscriber on the underlying
    // source. A malformed emission would therefore surface one
    // `onError` diagnostic per subscriber — observable noise that
    // grew quadratically with the number of runtime-owned
    // subscribers (loader's mute handler, the runner, any future
    // facets). The refactor centralizes validation: ONE source
    // wrapper validates each emission and fans a sanitized command
    // out to every subscriber, so the rejected-emission diagnostic
    // fires exactly once regardless of subscriber count.
    const { source, emit } = buildSource();
    const controller = new AbortController();
    const onError = vi.fn();
    const ctl = createPresenterController(source, controller.signal, onError);
    ctl.subscribe(() => undefined);
    ctl.subscribe(() => undefined);
    ctl.subscribe(() => undefined);
    emit({ kind: 'rewind' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/presenter/i);
  });

  it('contains a subscribe-time throw from the source and routes it through onError', () => {
    // Codex review, post-PUL-F025: the loader's PUL-F025 audio
    // handler subscribes during `buildLoad`, BEFORE the navigation
    // queue runs the lifecycle. A workbench-supplied
    // `PresenterCommandSource.subscribe` that throws on attach
    // used to escape past the loader's stage-attr rollback /
    // navigation-error envelope. Pin that the controller contains
    // the throw at its own boundary: `subscribe()` does not
    // propagate the source's error to the caller; instead the
    // diagnostic flows through `onError` and the call returns a
    // no-op unsubscribe so the caller's invariant ("subscribe
    // returns a usable unsubscribe function") is preserved.
    const throwingSource: PresenterCommandSource = {
      subscribe() {
        throw new Error('source subscribe failed');
      },
    };
    const controller = new AbortController();
    const onError = vi.fn();
    const ctl = createPresenterController(throwingSource, controller.signal, onError);
    let unsub: (() => void) | undefined;
    expect(() => {
      unsub = ctl.subscribe(() => undefined);
    }).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/source subscribe failed/);
    // The returned unsubscribe is callable and does not throw —
    // even though no source attachment ever happened.
    expect(() => unsub?.()).not.toThrow();
  });

  it('drops unknown commands silently when no onError sink is provided', () => {
    const { source, emit } = buildSource();
    const controller = new AbortController();
    const ctl = createPresenterController(source, controller.signal);
    const seen: PresenterCommand[] = [];
    ctl.subscribe((cmd) => seen.push(cmd));
    expect(() => emit({ kind: 'rewind' })).not.toThrow();
    expect(seen).toEqual([]);
  });

  it('does not crash when the source emits and no handler is subscribed', () => {
    const { source, emit } = buildSource();
    const controller = new AbortController();
    createPresenterController(source, controller.signal);
    expect(() => emit({ kind: 'advance' })).not.toThrow();
  });

  it('isolates subscribers — unsubscribing one does not detach another', () => {
    const { source, emit } = buildSource();
    const controller = new AbortController();
    const ctl = createPresenterController(source, controller.signal);
    const seenA: PresenterCommand[] = [];
    const seenB: PresenterCommand[] = [];
    const unsubA = ctl.subscribe((cmd) => seenA.push(cmd));
    ctl.subscribe((cmd) => seenB.push(cmd));
    emit({ kind: 'advance' });
    unsubA();
    emit({ kind: 'hold' });
    expect(seenA.map((c) => c.kind)).toEqual(['advance']);
    expect(seenB.map((c) => c.kind)).toEqual(['advance', 'hold']);
  });

  it('a handler that throws does not prevent later handlers from running', () => {
    // The controller MUST isolate handler exceptions so a buggy
    // subscriber cannot poison the bus for others. Without this, an
    // exception in handler A would propagate through the source's
    // emission loop and skip handler B.
    const { source, emit } = buildSource();
    const controller = new AbortController();
    const onError = vi.fn();
    const ctl = createPresenterController(source, controller.signal, onError);
    const seenB: PresenterCommand[] = [];
    ctl.subscribe(() => {
      throw new Error('handler-a explosion');
    });
    ctl.subscribe((cmd) => seenB.push(cmd));
    emit({ kind: 'advance' });
    expect(seenB.map((c) => c.kind)).toEqual(['advance']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/handler-a explosion/);
  });

  it('forwards a frozen defensive copy so a handler cannot mutate `kind` and corrupt sibling subscribers', () => {
    // Codex review (cycle 1): the source emits one command object
    // reference to every wrapped handler. Without per-handler
    // freezing, handler A could mutate `cmd.kind` and handler B
    // (called next in the source's emission loop) would observe the
    // mutated value. Pin that the controller hands each handler an
    // INDEPENDENT frozen copy.
    const { source, emit } = buildSource();
    const controller = new AbortController();
    const ctl = createPresenterController(source, controller.signal);
    const seenA: PresenterCommand[] = [];
    const seenB: PresenterCommand[] = [];
    ctl.subscribe((cmd) => {
      seenA.push(cmd);
      // Try to mutate. Frozen objects throw in strict mode; either
      // way, the next subscriber must not observe the corruption.
      try {
        (cmd as { kind: string }).kind = 'corrupted';
      } catch {
        // Object.freeze throws on assignment in strict mode; expected.
      }
    });
    ctl.subscribe((cmd) => seenB.push(cmd));
    emit({ kind: 'advance' });
    expect(seenA[0]?.kind).toBe('advance');
    expect(seenB[0]?.kind).toBe('advance');
  });

  it('calls a non-idempotent source unsubscribe at most once even when abort and runner-unsubscribe both fire', () => {
    // Codex review (cycle 2): a runner that calls its returned
    // unsubscribe AFTER the controller's signal already aborted
    // (or the per-scene wrapper aborts AFTER the navigation-level
    // wrapper aborted) would call source.unsubscribe a second time.
    // A non-idempotent source could corrupt its accounting. Pin
    // that the controller calls each source unsubscribe exactly
    // once.
    const handlers: ((cmd: PresenterCommand) => void)[] = [];
    let unsubCalls = 0;
    const source: PresenterCommandSource = {
      subscribe(handler) {
        handlers.push(handler);
        return () => {
          unsubCalls += 1;
        };
      },
    };
    const controller = new AbortController();
    const ctl = createPresenterController(source, controller.signal);
    const runnerUnsub = ctl.subscribe(() => undefined);
    controller.abort();
    runnerUnsub();
    runnerUnsub();
    expect(unsubCalls).toBe(1);
  });

  it('blocks emissions to a subscriber whose source unsubscribe failed to detach (post-abort emission guard)', () => {
    // Codex review (cycle 2): a misbehaving source whose own
    // unsubscribe doesn't actually remove the handler would still
    // deliver post-abort commands to the runner — the leak the
    // controller is supposed to prevent. Pin that the wrapped
    // handler's per-subscription `active` flag short-circuits
    // emissions even when the source is broken.
    const handlers: ((cmd: PresenterCommand) => void)[] = [];
    const source: PresenterCommandSource = {
      subscribe(handler) {
        handlers.push(handler);
        // Intentionally lie: don't actually remove the handler.
        return () => undefined;
      },
    };
    const controller = new AbortController();
    const ctl = createPresenterController(source, controller.signal);
    const seen: PresenterCommand[] = [];
    ctl.subscribe((cmd) => seen.push(cmd));
    controller.abort();
    // Source still delivers because its unsubscribe is a lie.
    for (const h of handlers) h({ kind: 'advance' });
    // The controller's per-subscription `active` flag must block
    // the wrapped handler from forwarding to the runner's handler.
    expect(seen).toEqual([]);
  });

  it('blocks emissions to a subscriber after its own unsubscribe even when the source still delivers', () => {
    // Mirror of the post-abort guard but driven by the runner's
    // explicit unsubscribe. A source whose unsubscribe is a no-op
    // would otherwise leak commands to a runner that explicitly
    // detached.
    const handlers: ((cmd: PresenterCommand) => void)[] = [];
    const source: PresenterCommandSource = {
      subscribe(handler) {
        handlers.push(handler);
        return () => undefined;
      },
    };
    const controller = new AbortController();
    const ctl = createPresenterController(source, controller.signal);
    const seen: PresenterCommand[] = [];
    const unsub = ctl.subscribe((cmd) => seen.push(cmd));
    unsub();
    for (const h of handlers) h({ kind: 'advance' });
    expect(seen).toEqual([]);
  });
});
