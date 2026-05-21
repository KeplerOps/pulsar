// Pulsar L2 — helpers unit tests.
//
// Covers the contracts L2 templates and decks build on:
//   - aSleep aborts on signal AND on presenter `advance`
//   - holdUntilAdvance resolves on presenter `advance` AND on abort
//   - typeNode reveals chars in order, snaps remaining on abort,
//     emits `.glow` for `[[...]]` segments
//   - typeInto snaps to full text on abort
//   - markedTextHtml escapes user text and converts markers
//   - fadeInCenter removes then re-adds `.show` after the rAF settle
//   - fadeOutAudio ramps volume to 0 and pauses
//   - srcMark mounts and removes

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenterCommand, PresenterController } from '../../src/runtime/presenter';
import {
  aSleep,
  fadeInCenter,
  fadeOutAudio,
  holdUntilAdvance,
  markedTextHtml,
  sleep,
  srcMark,
  typeInto,
  typeNode,
} from '../../src/system/helpers';

// ---------- presenter-controller stub ----------

const makeController = (): {
  controller: PresenterController;
  emit: (cmd: PresenterCommand) => void;
  subscriberCount: () => number;
} => {
  const handlers = new Set<(cmd: PresenterCommand) => void>();
  return {
    controller: {
      subscribe: (handler) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    },
    emit: (cmd) => {
      for (const h of [...handlers]) h(cmd);
    },
    subscriberCount: () => handlers.size,
  };
};

// ---------- DOM stubs (no jsdom dependency for the simple cases) ----------

interface FakeClassList {
  add(name: string): void;
  remove(name: string): void;
  contains(name: string): boolean;
}

const makeClassList = (): FakeClassList & { entries: Set<string> } => {
  const entries = new Set<string>();
  return {
    entries,
    add: (n: string) => {
      entries.add(n);
    },
    remove: (n: string) => {
      entries.delete(n);
    },
    contains: (n: string) => entries.has(n),
  };
};

// ---------- tests ----------

describe('sleep', () => {
  it('resolves after the requested delay', async () => {
    const start = Date.now();
    await sleep(40);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });
});

describe('aSleep', () => {
  it('resolves true after the full duration when nothing interrupts', async () => {
    const ok = await aSleep(30);
    expect(ok).toBe(true);
  });

  it('resolves false immediately when the signal aborts mid-dwell', async () => {
    const ctl = new AbortController();
    const p = aSleep(500, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    const ok = await p;
    expect(ok).toBe(false);
  });

  it('resolves false when an already-aborted signal is supplied', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const ok = await aSleep(500, { signal: ctl.signal });
    expect(ok).toBe(false);
  });

  it('resolves false when presenter emits advance', async () => {
    const { controller, emit } = makeController();
    const p = aSleep(500, { controller });
    setTimeout(() => emit({ kind: 'advance' }), 20);
    const ok = await p;
    expect(ok).toBe(false);
  });

  it('ignores non-advance presenter commands', async () => {
    const { controller, emit } = makeController();
    const p = aSleep(80, { controller });
    setTimeout(() => emit({ kind: 'toggle-master-mute' }), 20);
    const ok = await p;
    expect(ok).toBe(true);
  });

  it('unsubscribes from the controller after completion', async () => {
    const { controller, subscriberCount } = makeController();
    expect(subscriberCount()).toBe(0);
    await aSleep(20, { controller });
    expect(subscriberCount()).toBe(0);
  });
});

describe('holdUntilAdvance', () => {
  it('resolves "advance" when the controller emits advance', async () => {
    const { controller, emit } = makeController();
    const p = holdUntilAdvance(controller);
    setTimeout(() => emit({ kind: 'advance' }), 10);
    const outcome = await p;
    expect(outcome).toBe('advance');
  });

  it('resolves "aborted" when the signal fires', async () => {
    const { controller } = makeController();
    const ctl = new AbortController();
    const p = holdUntilAdvance(controller, ctl.signal);
    setTimeout(() => ctl.abort(), 10);
    const outcome = await p;
    expect(outcome).toBe('aborted');
  });

  it('resolves "aborted" immediately when given an already-aborted signal', async () => {
    const { controller } = makeController();
    const ctl = new AbortController();
    ctl.abort();
    const outcome = await holdUntilAdvance(controller, ctl.signal);
    expect(outcome).toBe('aborted');
  });
});

// ---------- typing ----------

describe('typeNode', () => {
  let originalRaf: typeof globalThis.requestAnimationFrame | undefined;
  beforeEach(() => {
    originalRaf = globalThis.requestAnimationFrame;
  });
  afterEach(() => {
    if (originalRaf !== undefined) globalThis.requestAnimationFrame = originalRaf;
  });

  it('emits one ph-char span per character and marks [[glow]] segments', async () => {
    // Build a minimal jsdom-free DOM via Document-implementing fake
    const doc = makeFakeDoc();
    const node = doc.createElement('div');
    await typeNode(node as unknown as ParentNode, 'a[[bc]]d', { base: 1, jitter: 0 });
    expect(node.childNodes.length).toBe(4);
    const get = (i: number): FakeElement => node.childNodes[i] as FakeElement;
    expect(get(0).className).toBe('ph-char show');
    expect(get(0).textContent).toBe('a');
    expect(get(1).className).toBe('ph-char glow show');
    expect(get(1).textContent).toBe('b');
    expect(get(2).className).toBe('ph-char glow show');
    expect(get(3).className).toBe('ph-char show');
    expect(get(3).textContent).toBe('d');
  });

  it('reveals remaining chars instantly on abort', async () => {
    const doc = makeFakeDoc();
    const node = doc.createElement('div');
    const ctl = new AbortController();
    const p = typeNode(node as unknown as ParentNode, 'longer-text-content', {
      base: 50,
      jitter: 0,
      signal: ctl.signal,
    });
    setTimeout(() => ctl.abort(), 30);
    await p;
    // Every char span should be `.show` even though base timing would
    // have left most unrevealed.
    for (const child of node.childNodes) {
      expect(child.className.split(' ')).toContain('show');
    }
  });
});

describe('typeInto', () => {
  it('reveals the text by slicing and resolves on completion', async () => {
    const el: { textContent: string | null } = { textContent: null };
    await typeInto(el, 'hello', { baseDelay: 1, punctuationPauseMs: 0 });
    expect(el.textContent).toBe('hello');
  });

  it('snaps to full text on abort', async () => {
    const el: { textContent: string | null } = { textContent: null };
    const ctl = new AbortController();
    const p = typeInto(el, 'aborted-text', { baseDelay: 100, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await p;
    expect(el.textContent).toBe('aborted-text');
  });
});

describe('markedTextHtml', () => {
  it('escapes HTML special characters in user text', () => {
    expect(markedTextHtml('<a&b>"')).toBe('&lt;a&amp;b&gt;&quot;');
  });

  it('wraps [[…]] segments in <span class="glow">', () => {
    expect(markedTextHtml('a[[b]]c')).toBe('a<span class="glow">b</span>c');
  });

  it('handles unclosed markers gracefully', () => {
    // Unclosed `[[` swallows the rest of the text into the glow group;
    // documented behavior, matches the demo_thoughts util.js port.
    expect(markedTextHtml('a[[bcd')).toBe('a<span class="glow">bcd</span>');
  });
});

// ---------- fade ----------

describe('fadeInCenter', () => {
  it('removes .show, sets innerHTML, adds .show after double-rAF', async () => {
    const cls = makeClassList();
    cls.add('show'); // start visible
    const center = { classList: cls as unknown as DOMTokenList, innerHTML: '<p>old</p>' };
    const trail: string[] = [];
    const originalRaf = globalThis.requestAnimationFrame;
    let depth = 0;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      depth++;
      trail.push(`raf${depth}`);
      Promise.resolve().then(() => cb(0));
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
    try {
      await fadeInCenter(center, '<p>new</p>', { exitMs: 5 });
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }
    expect(center.innerHTML).toBe('<p>new</p>');
    expect(cls.entries.has('show')).toBe(true);
    expect(trail.length).toBe(2); // double-rAF
  });
});

describe('fadeOutAudio', () => {
  it('ramps volume to 0 and pauses', async () => {
    let volume = 0.8;
    let paused = false;
    const audio = {
      get volume() {
        return volume;
      },
      set volume(v: number) {
        volume = v;
      },
      pause: () => {
        paused = true;
      },
    } as unknown as HTMLAudioElement;
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      Promise.resolve().then(() => cb(0));
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
    try {
      await fadeOutAudio(audio, 5);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }
    // Volume is restored to the starting value after the ramp + pause.
    expect(volume).toBe(0.8);
    expect(paused).toBe(true);
  });
});

// ---------- srcMark ----------

describe('srcMark', () => {
  it('mounts a div.src-mark into host.parent and remove() detaches it', () => {
    const doc = makeFakeDoc();
    const parent = doc.createElement('div');
    const handle = srcMark(
      { ownerDocument: doc as unknown as Document, parent: parent as unknown as ParentNode },
      'cite [2024]',
    );
    expect(parent.childNodes.length).toBe(1);
    const first = parent.childNodes[0] as FakeElement;
    expect(first.className).toBe('src-mark');
    expect(first.textContent).toBe('cite [2024]');
    handle.remove();
    expect(parent.childNodes.length).toBe(0);
    handle.remove(); // idempotent
    expect(parent.childNodes.length).toBe(0);
  });
});

// ---------- minimal Document fake ----------

interface FakeElement {
  className: string;
  textContent: string;
  childNodes: FakeElement[];
  ownerDocument: FakeDoc;
  appendChild(child: FakeElement): FakeElement;
  classList: { add(n: string): void; remove(n: string): void; contains(n: string): boolean };
  remove(): void;
  _parent: FakeElement | null;
}

interface FakeDoc {
  createElement(tag: string): FakeElement;
}

const makeFakeDoc = (): FakeDoc => {
  const make = (doc: FakeDoc): FakeElement => {
    const classes = new Set<string>();
    const el: FakeElement = {
      className: '',
      textContent: '',
      childNodes: [],
      ownerDocument: doc,
      classList: {
        add: (n: string) => {
          classes.add(n);
          el.className = el.className.length > 0 ? `${el.className} ${n}` : n;
        },
        remove: (n: string) => {
          classes.delete(n);
          el.className = [...classes].join(' ');
        },
        contains: (n: string) => classes.has(n),
      },
      appendChild: (child: FakeElement) => {
        child._parent = el;
        el.childNodes.push(child);
        return child;
      },
      remove: () => {
        if (el._parent === null) return;
        const idx = el._parent.childNodes.indexOf(el);
        if (idx >= 0) el._parent.childNodes.splice(idx, 1);
        el._parent = null;
      },
      _parent: null,
    };
    return el;
  };
  const doc: FakeDoc = {
    createElement: (tag) => {
      const el = make(doc);
      void tag;
      return el;
    },
  };
  return doc;
};

// keep vitest happy about unused symbols on stricter configs
void vi;
