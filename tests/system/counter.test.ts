// Pulsar L2 chrome — live counter primitive coverage tests.
//
// Covers `formatHms` (including the negative-input clamp) and the full
// `createCounter` mount lifecycle: tick / setSpeed / freeze / stop and
// the post-stop no-op guards.

import { describe, expect, it } from 'vitest';
import { type CounterHost, createCounter, formatHms } from '../../src/system/chrome/counter';

// ---------- jsdom-free DOM fake (with a mutable `.style`) ----------

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string | null;
  style: Record<string, string>;
  childNodes: FakeEl[];
  parentElement: FakeEl | null;
  ownerDocument: FakeDoc;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeEl): FakeEl;
  removeChild(child: FakeEl): FakeEl;
  remove(): void;
}

interface FakeDoc {
  createElement(tag: string): FakeEl;
}

const makeEl = (doc: FakeDoc): FakeEl => {
  const attrs = new Map<string, string>();
  const el: FakeEl = {
    tagName: 'DIV',
    className: '',
    textContent: null,
    style: {},
    childNodes: [],
    parentElement: null,
    ownerDocument: doc,
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
      const i = el.childNodes.indexOf(child);
      if (i >= 0) el.childNodes.splice(i, 1);
      child.parentElement = null;
      return child;
    },
    remove: () => {
      if (el.parentElement !== null) el.parentElement.removeChild(el);
    },
  };
  return el;
};

const makeDoc = (): FakeDoc => {
  const doc = {} as FakeDoc;
  doc.createElement = () => makeEl(doc);
  return doc;
};

const byClass = (root: FakeEl, cls: string): FakeEl | null => {
  if (root.className.split(' ').includes(cls)) return root;
  for (const child of root.childNodes) {
    const found = byClass(child, cls);
    if (found !== null) return found;
  }
  return null;
};

const makeHost = (extra: Partial<CounterHost> = {}): { host: CounterHost; parent: FakeEl } => {
  const doc = makeDoc();
  const parent = makeEl(doc);
  const host = {
    ownerDocument: doc as unknown as Document,
    parent: parent as unknown as HTMLElement,
    ...extra,
  } as CounterHost;
  return { host, parent };
};

describe('formatHms', () => {
  it('formats whole seconds as HH:MM:SS', () => {
    expect(formatHms(0)).toBe('00:00:00');
    expect(formatHms(45)).toBe('00:00:45');
    expect(formatHms(3661)).toBe('01:01:01');
    expect(formatHms(86_399)).toBe('23:59:59');
  });

  it('rounds fractional seconds', () => {
    expect(formatHms(45.6)).toBe('00:00:46');
    expect(formatHms(45.2)).toBe('00:00:45');
  });

  it('clamps negative input to zero', () => {
    expect(formatHms(-5)).toBe('00:00:00');
    expect(formatHms(-9999)).toBe('00:00:00');
  });
});

describe('createCounter', () => {
  it('mounts a counter with the zeroed value and no label by default', () => {
    const { host, parent } = makeHost();
    const counter = createCounter(host);
    expect(parent.childNodes).toHaveLength(1);
    const root = counter.element as unknown as FakeEl;
    expect(root.className).toBe('pulsar-counter');
    expect(byClass(root, 'pulsar-counter__label')).toBeNull();
    expect(byClass(root, 'pulsar-counter__value')?.textContent).toBe('00:00:00');
  });

  it('renders an optional label', () => {
    const { host } = makeHost({ label: 'elapsed' });
    const root = createCounter(host).element as unknown as FakeEl;
    expect(byClass(root, 'pulsar-counter__label')?.textContent).toBe('elapsed');
  });

  it('applies each position preset to the root style attribute', () => {
    for (const position of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      const { host } = makeHost({ position });
      const root = createCounter(host).element as unknown as FakeEl;
      const side = position.split('-')[0] ?? '';
      expect(root.getAttribute('style')).toContain(`${side}:`);
    }
  });

  it('tick updates the rendered value', () => {
    const { host } = makeHost();
    const counter = createCounter(host);
    counter.tick(125);
    expect(
      byClass(counter.element as unknown as FakeEl, 'pulsar-counter__value')?.textContent,
    ).toBe('00:02:05');
  });

  it('setSpeed shows the fast-forward indicator off 1.0x', () => {
    const { host } = makeHost();
    const counter = createCounter(host);
    const speed = byClass(counter.element as unknown as FakeEl, 'pulsar-counter__speed');
    counter.setSpeed(2.5);
    expect(speed?.textContent).toBe('►► 2.5x');
    expect(speed?.style.opacity).toBe('1');
  });

  it('setSpeed hides the indicator at (or near) 1.0x', () => {
    const { host } = makeHost();
    const counter = createCounter(host);
    const speed = byClass(counter.element as unknown as FakeEl, 'pulsar-counter__speed');
    counter.setSpeed(2);
    counter.setSpeed(1);
    expect(speed?.style.opacity).toBe('0');
    counter.setSpeed(2);
    counter.setSpeed(1.005); // within the 0.01 tolerance
    expect(speed?.style.opacity).toBe('0');
  });

  it('freeze hides the speed indicator', () => {
    const { host } = makeHost();
    const counter = createCounter(host);
    const speed = byClass(counter.element as unknown as FakeEl, 'pulsar-counter__speed');
    counter.setSpeed(3);
    expect(speed?.style.opacity).toBe('1');
    counter.freeze();
    expect(speed?.style.opacity).toBe('0');
  });

  it('stop detaches the element and is idempotent', () => {
    const { host, parent } = makeHost();
    const counter = createCounter(host);
    counter.stop();
    expect(parent.childNodes).toHaveLength(0);
    expect(() => counter.stop()).not.toThrow();
  });

  it('tick / freeze / setSpeed are no-ops after stop', () => {
    const { host } = makeHost();
    const counter = createCounter(host);
    const root = counter.element as unknown as FakeEl;
    const value = byClass(root, 'pulsar-counter__value');
    const speed = byClass(root, 'pulsar-counter__speed');
    counter.tick(30);
    counter.setSpeed(3); // ►► 3.0x, opacity '1'
    counter.stop();
    counter.tick(999);
    counter.setSpeed(4);
    counter.freeze();
    // State frozen at the values set before stop.
    expect(value?.textContent).toBe('00:00:30');
    expect(speed?.textContent).toBe('►► 3.0x');
    expect(speed?.style.opacity).toBe('1');
  });
});
