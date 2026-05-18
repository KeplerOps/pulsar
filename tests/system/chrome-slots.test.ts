// Pulsar L2 — chrome slot mount tests.
//
// Verifies the chrome pack builds the expected slot DOM, exposes
// stable refs, and the effect helpers operate on those refs without
// reaching for ambient document/window globals.

import { describe, expect, it } from 'vitest';
import {
  clearAct,
  clearBrand,
  clearTag,
  clearTitle,
  disposeChromeSlots,
  fadeOutAll,
  fireScreenFlash,
  flickerOutAll,
  mountChromeSlots,
  renderAct,
  resetFlickers,
  setTag,
  shake,
  slamBrand,
  slamTitle,
} from '../../src/system/chrome';

// ---------- jsdom-free DOM fake ----------

interface FakeAttrMap {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}

interface FakeElement extends FakeAttrMap {
  tagName: string;
  className: string;
  classList: { add(n: string): void; remove(n: string): void; contains(n: string): boolean };
  innerHTML: string;
  textContent: string | null;
  ownerDocument: FakeDoc;
  childNodes: FakeElement[];
  firstChild: FakeElement | null;
  parentElement: FakeElement | null;
  offsetWidth: number;
  appendChild(child: FakeElement): FakeElement;
  removeChild(child: FakeElement): FakeElement;
  remove(): void;
  querySelector(selector: string): FakeElement | null;
}

interface FakeDoc {
  createElement(tag: string): FakeElement;
}

const makeDoc = (): FakeDoc => {
  const make = (tag: string, doc: FakeDoc): FakeElement => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const el: FakeElement = {
      tagName: tag.toUpperCase(),
      className: '',
      classList: {
        add: (n) => {
          classes.add(n);
          el.className = [...classes].join(' ');
        },
        remove: (n) => {
          classes.delete(n);
          el.className = [...classes].join(' ');
        },
        contains: (n) => classes.has(n),
      },
      innerHTML: '',
      textContent: null,
      ownerDocument: doc,
      childNodes: [],
      get firstChild() {
        return el.childNodes[0] ?? null;
      },
      parentElement: null,
      offsetWidth: 0,
      setAttribute: (n, v) => {
        attrs.set(n, v);
      },
      getAttribute: (n) => attrs.get(n) ?? null,
      appendChild: (child) => {
        child.parentElement = el;
        el.childNodes.push(child);
        return child;
      },
      removeChild: (child) => {
        const idx = el.childNodes.indexOf(child);
        if (idx >= 0) el.childNodes.splice(idx, 1);
        child.parentElement = null;
        return child;
      },
      remove: () => {
        if (el.parentElement !== null) {
          el.parentElement.removeChild(el);
        }
      },
      querySelector: () => null,
    };
    return el;
  };
  const doc: FakeDoc = {
    createElement: (tag) => make(tag, doc),
  };
  return doc;
};

const newHost = (): { surface: FakeElement; doc: FakeDoc } => {
  const doc = makeDoc();
  const surface = doc.createElement('div');
  surface.setAttribute('data-pulsar-chrome', 'surface');
  return { surface, doc };
};

// Cast helpers so tests can pass the fakes without TypeScript fighting
// the full HTMLElement interface.
const asSurface = (el: FakeElement): HTMLElement => el as unknown as HTMLElement;
const asDoc = (d: FakeDoc): Document => d as unknown as Document;

// ---------- tests ----------

describe('mountChromeSlots', () => {
  it('mounts the documented slot DOM and returns stable refs', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface: asSurface(surface), ownerDocument: asDoc(doc) });
    // Surface has the .pulsar-stage class for atmospheric backdrop.
    expect(surface.classList.contains('pulsar-stage')).toBe(true);
    // Every slot ref points at a child of the surface (except `stage` which IS the surface).
    expect(slots.stage).toBe(asSurface(surface));
    for (const key of ['title', 'brand', 'center', 'lowerThird', 'tag', 'flash'] as const) {
      expect((slots[key] as unknown as FakeElement).parentElement as unknown).toBe(surface);
    }
    // actFrame is nested inside the .pulsar-act wrapper.
    const actFrame = slots.actFrame as unknown as FakeElement;
    expect(actFrame.parentElement?.className).toMatch(/pulsar-act/);
  });

  it('is idempotent — a second call clears prior children before re-mounting', () => {
    const { surface, doc } = newHost();
    mountChromeSlots({ surface: asSurface(surface), ownerDocument: asDoc(doc) });
    const firstCount = surface.childNodes.length;
    const second = mountChromeSlots({ surface: asSurface(surface), ownerDocument: asDoc(doc) });
    // Same shape, same count — not accumulated.
    expect(surface.childNodes.length).toBe(firstCount);
    expect((second.title as unknown as FakeElement).parentElement as unknown).toBe(surface);
  });

  it('disposeChromeSlots removes every child and the .pulsar-stage class', () => {
    const { surface, doc } = newHost();
    mountChromeSlots({ surface: asSurface(surface), ownerDocument: asDoc(doc) });
    expect(surface.childNodes.length).toBeGreaterThan(0);
    disposeChromeSlots(asSurface(surface));
    expect(surface.childNodes.length).toBe(0);
    expect(surface.classList.contains('pulsar-stage')).toBe(false);
  });
});

describe('chrome effect helpers', () => {
  it('shake toggles the .shake class through a reflow read', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface: asSurface(surface), ownerDocument: asDoc(doc) });
    shake(slots);
    expect((slots.stage as unknown as FakeElement).classList.contains('shake')).toBe(true);
  });

  it('fireScreenFlash toggles the .fire class on the flash slot', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface: asSurface(surface), ownerDocument: asDoc(doc) });
    fireScreenFlash(slots);
    expect((slots.flash as unknown as FakeElement).classList.contains('fire')).toBe(true);
  });

  it('renderAct / clearAct mutate innerHTML on the act-frame slot', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface: asSurface(surface), ownerDocument: asDoc(doc) });
    renderAct(slots, '<p>act content</p>');
    expect((slots.actFrame as unknown as FakeElement).innerHTML).toBe('<p>act content</p>');
    clearAct(slots);
    expect((slots.actFrame as unknown as FakeElement).innerHTML).toBe('');
  });

  it('slam/clear title and brand mutate the slot innerHTML', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface: asSurface(surface), ownerDocument: asDoc(doc) });
    slamTitle(slots, '<h1>X</h1>');
    expect((slots.title as unknown as FakeElement).innerHTML).toBe('<h1>X</h1>');
    clearTitle(slots);
    expect((slots.title as unknown as FakeElement).innerHTML).toBe('');
    slamBrand(slots, '<img />');
    expect((slots.brand as unknown as FakeElement).innerHTML).toBe('<img />');
    clearBrand(slots);
    expect((slots.brand as unknown as FakeElement).innerHTML).toBe('');
  });

  it('setTag / clearTag mutate textContent on the tag slot', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface: asSurface(surface), ownerDocument: asDoc(doc) });
    setTag(slots, 'TLP:AMBER');
    expect((slots.tag as unknown as FakeElement).textContent).toBe('TLP:AMBER');
    clearTag(slots);
    expect((slots.tag as unknown as FakeElement).textContent).toBe('');
  });

  it('fadeOutAll adds fade-out-clean to title/brand/act wrappers', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface: asSurface(surface), ownerDocument: asDoc(doc) });
    fadeOutAll(slots);
    expect((slots.title as unknown as FakeElement).classList.contains('fade-out-clean')).toBe(true);
    expect((slots.brand as unknown as FakeElement).classList.contains('fade-out-clean')).toBe(true);
    const act = (slots.actFrame as unknown as FakeElement).parentElement as FakeElement;
    expect(act.classList.contains('fade-out-clean')).toBe(true);
  });

  it('flickerOutAll + resetFlickers cleanly toggle the flicker classes', async () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface: asSurface(surface), ownerDocument: asDoc(doc) });
    flickerOutAll(slots);
    // Stagger uses setTimeout — wait for the longest delay (230ms).
    await new Promise((r) => setTimeout(r, 280));
    expect((slots.title as unknown as FakeElement).classList.contains('flicker-out-a')).toBe(true);
    expect((slots.brand as unknown as FakeElement).classList.contains('flicker-out-b')).toBe(true);
    const act = (slots.actFrame as unknown as FakeElement).parentElement as FakeElement;
    expect(act.classList.contains('flicker-out-c')).toBe(true);
    resetFlickers(slots);
    expect((slots.title as unknown as FakeElement).classList.contains('flicker-out-a')).toBe(false);
    expect((slots.brand as unknown as FakeElement).classList.contains('flicker-out-b')).toBe(false);
    expect(act.classList.contains('flicker-out-c')).toBe(false);
  });
});
