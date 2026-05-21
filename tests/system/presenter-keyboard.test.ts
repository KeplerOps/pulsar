// Pulsar L2 — presenter keyboard source unit tests.

import { describe, expect, it, vi } from 'vitest';
import type { PresenterCommand } from '../../src/runtime/presenter';
import { createPresenterController } from '../../src/runtime/presenter';
import {
  type MasterTimeline,
  createGsapCompositionTimeline,
  createTimelineEngine,
} from '../../src/runtime/timeline';
import {
  DEFAULT_KEYBOARD_BINDINGS,
  createKeyboardPresenterSource,
} from '../../src/system/presenter';

// EventTarget fake covering the addEventListener / removeEventListener /
// dispatchEvent surface the keyboard source uses. Vitest defaults to a
// Node environment with no `KeyboardEvent` global, so we build minimal
// keyboard-event-shaped objects and dispatch them through a plain
// `EventTarget` (which IS in Node).
const makeTarget = (): EventTarget => new EventTarget();

const fakeKey = (code: string, target: EventTarget | null = null): Event => {
  const e = new Event('keydown') as Event & {
    code?: string;
    key?: string;
    preventDefault: () => void;
  };
  Object.defineProperty(e, 'code', { value: code });
  Object.defineProperty(e, 'key', { value: code });
  if (target !== null) {
    Object.defineProperty(e, 'target', { value: target });
  }
  return e;
};

describe('keyboard presenter source', () => {
  it('emits advance on ArrowRight and Space', () => {
    const target = makeTarget();
    const { source, dispose } = createKeyboardPresenterSource({ target });
    const cmds: PresenterCommand[] = [];
    source.subscribe((c) => cmds.push(c));
    target.dispatchEvent(fakeKey('ArrowRight'));
    target.dispatchEvent(fakeKey('Space'));
    expect(cmds.map((c) => c.kind)).toEqual(['advance', 'advance']);
    dispose();
  });

  it('emits skip-backward on ArrowLeft', () => {
    const target = makeTarget();
    const { source, dispose } = createKeyboardPresenterSource({ target });
    const cmds: PresenterCommand[] = [];
    source.subscribe((c) => cmds.push(c));
    target.dispatchEvent(fakeKey('ArrowLeft'));
    expect(cmds.map((c) => c.kind)).toEqual(['skip-backward']);
    dispose();
  });

  it('emits hold on KeyP and mute on KeyM', () => {
    const target = makeTarget();
    const { source, dispose } = createKeyboardPresenterSource({ target });
    const cmds: PresenterCommand[] = [];
    source.subscribe((c) => cmds.push(c));
    target.dispatchEvent(fakeKey('KeyP'));
    target.dispatchEvent(fakeKey('KeyM'));
    expect(cmds.map((c) => c.kind)).toEqual(['hold', 'toggle-master-mute']);
    dispose();
  });

  it('emits skip-forward on PageDown and skip-backward on PageUp', () => {
    const target = makeTarget();
    const { source, dispose } = createKeyboardPresenterSource({ target });
    const cmds: PresenterCommand[] = [];
    source.subscribe((c) => cmds.push(c));
    target.dispatchEvent(fakeKey('PageDown'));
    target.dispatchEvent(fakeKey('PageUp'));
    expect(cmds.map((c) => c.kind)).toEqual(['skip-forward', 'skip-backward']);
    dispose();
  });

  it('emits pause on KeyK and resume on KeyL', () => {
    const target = makeTarget();
    const { source, dispose } = createKeyboardPresenterSource({ target });
    const cmds: PresenterCommand[] = [];
    source.subscribe((c) => cmds.push(c));
    target.dispatchEvent(fakeKey('KeyK'));
    target.dispatchEvent(fakeKey('KeyL'));
    expect(cmds.map((c) => c.kind)).toEqual(['pause', 'resume']);
    dispose();
  });

  it('invokes onHome for Escape and does not emit a command', () => {
    const target = makeTarget();
    const onHome = vi.fn();
    const { source, dispose } = createKeyboardPresenterSource({ target, onHome });
    const cmds: PresenterCommand[] = [];
    source.subscribe((c) => cmds.push(c));
    target.dispatchEvent(fakeKey('Escape'));
    expect(onHome).toHaveBeenCalledTimes(1);
    expect(cmds).toEqual([]);
    dispose();
  });

  it('ignores keys not in the bindings map', () => {
    const target = makeTarget();
    const { source, dispose } = createKeyboardPresenterSource({ target });
    const cmds: PresenterCommand[] = [];
    source.subscribe((c) => cmds.push(c));
    target.dispatchEvent(fakeKey('KeyZ'));
    expect(cmds).toEqual([]);
    dispose();
  });

  it('does not emit commands when the event target is an editable element', () => {
    const target = makeTarget();
    const { source, dispose } = createKeyboardPresenterSource({ target });
    const cmds: PresenterCommand[] = [];
    source.subscribe((c) => cmds.push(c));
    const input = { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget;
    const textarea = { tagName: 'TEXTAREA', isContentEditable: false } as unknown as EventTarget;
    const editable = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget;
    target.dispatchEvent(fakeKey('ArrowRight', input));
    target.dispatchEvent(fakeKey('ArrowRight', textarea));
    target.dispatchEvent(fakeKey('ArrowRight', editable));
    expect(cmds).toEqual([]);
    dispose();
  });

  it('dispose() detaches the listener so further events do not emit', () => {
    const target = makeTarget();
    const { source, dispose } = createKeyboardPresenterSource({ target });
    const cmds: PresenterCommand[] = [];
    source.subscribe((c) => cmds.push(c));
    dispose();
    target.dispatchEvent(fakeKey('ArrowRight'));
    expect(cmds).toEqual([]);
  });

  it('supports custom bindings overrides', () => {
    const target = makeTarget();
    const { source, dispose } = createKeyboardPresenterSource({
      target,
      bindings: { ...DEFAULT_KEYBOARD_BINDINGS, KeyZ: 'pause' },
    });
    const cmds: PresenterCommand[] = [];
    source.subscribe((c) => cmds.push(c));
    target.dispatchEvent(fakeKey('KeyZ'));
    expect(cmds.map((c) => c.kind)).toEqual(['pause']);
    dispose();
  });
});

// End-to-end dispatch (issue #132 acceptance criterion): a real DOM
// keydown flows keyboard source → per-navigation presenter controller →
// GSAP runner → master timeline. Pins that the wired surface actually
// moves beat state, not just that the keyboard source emits a command.
describe('presenter keyboard → GSAP runner (PUL-F020 end-to-end dispatch)', () => {
  it('a real PageDown keydown drives the master timeline to the next scene segment', async () => {
    const engine = createTimelineEngine();
    const sceneTl = (seconds: number): InstanceType<typeof engine.gsap.core.Timeline> => {
      const tl = engine.gsap.timeline({ paused: true });
      tl.to({ v: 0 }, { v: 1, duration: seconds });
      return tl;
    };
    const target = makeTarget();
    const keyboard = createKeyboardPresenterSource({ target });
    const ctrl = new AbortController();
    const presenter = createPresenterController(keyboard.source, ctrl.signal);
    let captured: MasterTimeline | null = null;
    const adapter = createGsapCompositionTimeline({
      engine,
      onMaster: (m) => {
        captured = m;
      },
    });
    const settled = adapter.run(
      [
        { id: 'scene-a', timeline: sceneTl(20) },
        { id: 'scene-b', timeline: sceneTl(20) },
      ],
      { signal: ctrl.signal, presenter },
    );
    await new Promise((r) => setTimeout(r, 0));
    const master = ((): MasterTimeline => {
      if (captured === null) throw new Error('master not captured');
      return captured;
    })();
    // Real DOM keydown → keyboard source → controller → runner → master.
    target.dispatchEvent(fakeKey('PageDown'));
    expect(master.time()).toBeCloseTo(20, 0);
    ctrl.abort();
    keyboard.dispose();
    await settled;
  });
});
