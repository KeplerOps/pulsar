// Pulsar L2 chrome — scrub-mode transport control coverage.
//
// PUL-F017 / ADR-020: the workbench scrub controls let the user scrub
// forward, backward, and to named beats. These tests pin the control
// bar against a fake `MasterTimeline` (jsdom-free, like the rest of the
// chrome suite): the buttons drive the master's transport API, the beat
// row is built from `master.beats()`, the seek slider seeks, and the
// readout tracks the playhead. The cue-gating behavior the controls
// ultimately exercise is covered by tests/runtime/scrub-cue-gating.test.ts.

import { describe, expect, it } from 'vitest';
import type { MasterBeat, MasterTimeline } from '../../src/runtime/timeline';
import { createScrubControls, formatScrubTime } from '../../src/system/chrome/scrub';

// ---------- jsdom-free DOM fake (with event dispatch) ----------

type Listener = () => void;

class FakeElement {
  tagName: string;
  className = '';
  textContent: string | null = '';
  title = '';
  type = '';
  hidden = false;
  min = '';
  max = '';
  step = '';
  value = '';
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly #attrs = new Map<string, string>();
  readonly #listeners = new Map<string, Listener[]>();
  parentNode: FakeElement | null = null;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.#attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.#attrs.get(name) ?? null;
  }
  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...kids: FakeElement[]): void {
    for (const k of kids) this.appendChild(k);
  }
  replaceChildren(...kids: FakeElement[]): void {
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
    for (const k of kids) this.appendChild(k);
  }
  remove(): void {
    if (this.parentNode === null) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  addEventListener(type: string, handler: Listener): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(handler);
    this.#listeners.set(type, list);
  }
  fire(type: string): void {
    for (const h of [...(this.#listeners.get(type) ?? [])]) h();
  }
}

const fakeDocument = (): Document =>
  ({ createElement: (tag: string) => new FakeElement(tag) }) as unknown as Document;

/** Recursively find the first descendant whose class list contains `cls`. */
const find = (root: FakeElement, cls: string): FakeElement | null => {
  for (const child of root.children) {
    if (child.className.split(' ').includes(cls)) return child;
    const nested = find(child, cls);
    if (nested !== null) return nested;
  }
  return null;
};
const must = (root: FakeElement, cls: string): FakeElement => {
  const el = find(root, cls);
  if (el === null) throw new Error(`fake element ".${cls}" not found`);
  return el;
};

// ---------- fake MasterTimeline (records transport calls) ----------

interface FakeMaster {
  readonly master: MasterTimeline;
  readonly calls: string[];
  paused: boolean;
  now: number;
}

const fakeMaster = (opts: { duration?: number; beats?: MasterBeat[] } = {}): FakeMaster => {
  const calls: string[] = [];
  const state = { paused: true, now: 0 };
  const beats = opts.beats ?? [];
  const master = {
    play: () => {
      calls.push('play');
      state.paused = false;
    },
    pause: () => {
      calls.push('pause');
      state.paused = true;
    },
    reverse: () => {
      calls.push('reverse');
      state.paused = false;
    },
    isPaused: () => state.paused,
    seek: (position: number | string) => {
      calls.push(`seek:${position}`);
      if (typeof position === 'number') state.now = position;
    },
    time: () => state.now,
    duration: () => opts.duration ?? 0,
    beats: () => beats,
  } as unknown as MasterTimeline;
  return {
    master,
    calls,
    get paused() {
      return state.paused;
    },
    set paused(v: boolean) {
      state.paused = v;
    },
    get now() {
      return state.now;
    },
    set now(v: number) {
      state.now = v;
    },
  };
};

const beat = (label: string, time: number): MasterBeat => ({
  scene: 'scene-a',
  occurrence: 0,
  label,
  name: `scene-a:${label}`,
  time,
});

describe('formatScrubTime', () => {
  it('formats seconds as m:ss and clamps negatives / non-finite to 0:00', () => {
    expect(formatScrubTime(0)).toBe('0:00');
    expect(formatScrubTime(7)).toBe('0:07');
    expect(formatScrubTime(75)).toBe('1:15');
    expect(formatScrubTime(-4)).toBe('0:00');
    expect(formatScrubTime(Number.NaN)).toBe('0:00');
  });
});

describe('createScrubControls (PUL-F017 / ADR-020)', () => {
  const setup = () => {
    const doc = fakeDocument();
    const parent = new FakeElement('div');
    const controls = createScrubControls({
      ownerDocument: doc,
      parent: parent as unknown as HTMLElement,
    });
    return { parent, controls, root: controls.element as unknown as FakeElement };
  };

  it('mounts into the parent and starts hidden until a master is attached', () => {
    const { parent, root } = setup();
    expect(parent.children).toHaveLength(1);
    expect(root.hidden).toBe(true);
    expect(root.getAttribute('role')).toBe('group');
    expect(root.getAttribute('aria-label')).toBe('timeline scrub controls');
  });

  it('reveals the controls on attach and hides them again on detach', () => {
    const { controls, root } = setup();
    const fm = fakeMaster({ duration: 12 });
    controls.attach(fm.master);
    expect(root.hidden).toBe(false);
    controls.detach();
    expect(root.hidden).toBe(true);
  });

  it('sets the seek slider range from the master duration on attach', () => {
    const { controls, root } = setup();
    controls.attach(fakeMaster({ duration: 8.5 }).master);
    expect(must(root, 'pulsar-scrub__seek').max).toBe('8.5');
  });

  it('toggles play / pause through the master transport', () => {
    const { controls, root } = setup();
    const fm = fakeMaster({ duration: 10 });
    controls.attach(fm.master);
    const playPause = must(root, 'pulsar-scrub__play');
    playPause.fire('click'); // paused → play
    expect(fm.calls).toEqual(['play']);
    expect(playPause.textContent).toBe('❚❚');
    playPause.fire('click'); // playing → pause
    expect(fm.calls).toEqual(['play', 'pause']);
    expect(playPause.textContent).toBe('▶');
  });

  it('plays backward through the master when the reverse control is used', () => {
    const { controls, root } = setup();
    const fm = fakeMaster({ duration: 10 });
    controls.attach(fm.master);
    must(root, 'pulsar-scrub__reverse').fire('click');
    expect(fm.calls).toEqual(['reverse']);
  });

  it('seeks the master when the slider is dragged (scrub forward / backward)', () => {
    const { controls, root } = setup();
    const fm = fakeMaster({ duration: 10 });
    controls.attach(fm.master);
    const seek = must(root, 'pulsar-scrub__seek');
    seek.value = '6.25';
    seek.fire('input');
    expect(fm.calls).toEqual(['seek:6.25']);
  });

  it('renders one jump button per named beat and seeks to the beat label on click', () => {
    const { controls, root } = setup();
    const fm = fakeMaster({
      duration: 10,
      beats: [beat('hook', 2), beat('reveal', 6)],
    });
    controls.attach(fm.master);
    const beatRow = must(root, 'pulsar-scrub__beats');
    expect(beatRow.children).toHaveLength(2);
    expect(beatRow.children.map((b) => b.textContent)).toEqual(['hook', 'reveal']);
    beatRow.children[1]?.fire('click');
    expect(fm.calls).toEqual(['seek:scene-a:reveal']);
  });

  it('clears the beat buttons on detach', () => {
    const { controls, root } = setup();
    controls.attach(fakeMaster({ duration: 10, beats: [beat('hook', 2)] }).master);
    expect(must(root, 'pulsar-scrub__beats').children).toHaveLength(1);
    controls.detach();
    expect(must(root, 'pulsar-scrub__beats').children).toHaveLength(0);
  });

  it('sync() refreshes the playhead readout from the master', () => {
    const { controls, root } = setup();
    const fm = fakeMaster({ duration: 30 });
    controls.attach(fm.master);
    fm.now = 12;
    fm.paused = false;
    controls.sync();
    expect(must(root, 'pulsar-scrub__seek').value).toBe('12');
    expect(must(root, 'pulsar-scrub__time').textContent).toBe('0:12 / 0:30');
    expect(must(root, 'pulsar-scrub__play').textContent).toBe('❚❚');
  });

  it('sync() does not fight an in-progress drag (no playhead write-back while scrubbing)', () => {
    const { controls, root } = setup();
    const fm = fakeMaster({ duration: 30 });
    controls.attach(fm.master);
    const seek = must(root, 'pulsar-scrub__seek');
    seek.fire('pointerdown'); // user grabs the slider
    fm.now = 20;
    controls.sync();
    expect(seek.value).not.toBe('20'); // drag not overwritten
    seek.fire('pointerup'); // user releases
    controls.sync();
    expect(seek.value).toBe('20');
  });

  it('sync() is inert when no master is attached', () => {
    const { controls } = setup();
    expect(() => controls.sync()).not.toThrow();
  });

  it('dispose() removes the control bar and renders subsequent calls inert', () => {
    const { parent, controls } = setup();
    const fm = fakeMaster({ duration: 10 });
    controls.dispose();
    expect(parent.children).toHaveLength(0);
    // Inert afterwards — no throw, no mounting.
    expect(() => {
      controls.attach(fm.master);
      controls.sync();
      controls.detach();
      controls.dispose();
    }).not.toThrow();
    expect(parent.children).toHaveLength(0);
  });
});
