// Pulsar L2 — chrome extras (clock, popout, slamBrand, fadeOutAll,
// flicker reset) coverage tests.

import { describe, expect, it } from 'vitest';
import {
  clearTag,
  fadeOutAll,
  firePopout,
  fireScreenFlash,
  flickerOutAll,
  mountChromeSlots,
  renderAct,
  resetFlickers,
  setTag,
  shake,
  slamBrand,
  slamBrandClean,
  startClock,
} from '../../src/system/chrome';

// Hoisted out of the inline querySelector closure so the closure's
// cognitive complexity stays under the Biome gate.
const findByClass = (root: HTMLElement, selector: string): HTMLElement | null => {
  const cm = selector.match(/^\.([\w-]+)$/);
  if (cm === null) return null;
  const cls = cm[1] ?? '';
  if ((root.className ?? '').split(' ').includes(cls)) return root;
  for (const c of (root as unknown as { childNodes: HTMLElement[] }).childNodes) {
    const f = findByClass(c, selector);
    if (f !== null) return f;
  }
  return null;
};

// jsdom-free stage fake (smaller than the chrome-slots test fake).
const makeFakeDom = (): {
  doc: Document;
  body: HTMLElement;
} => {
  const elFor = (doc: Document): HTMLElement => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const children: HTMLElement[] = [];
    const el = {
      tagName: 'DIV',
      className: '',
      classList: {
        add: (n: string) => {
          classes.add(n);
          el.className = [...classes].join(' ');
        },
        remove: (n: string) => {
          classes.delete(n);
          el.className = [...classes].join(' ');
        },
        contains: (n: string) => classes.has(n),
      },
      innerHTML: '',
      textContent: null as string | null,
      ownerDocument: doc,
      childNodes: children,
      parentElement: null as HTMLElement | null,
      offsetWidth: 0,
      get firstChild() {
        return children[0] ?? null;
      },
      setAttribute: (n: string, v: string) => {
        attrs.set(n, v);
      },
      getAttribute: (n: string) => attrs.get(n) ?? null,
      appendChild: (child: HTMLElement) => {
        (child as { parentElement: HTMLElement | null }).parentElement =
          el as unknown as HTMLElement;
        children.push(child);
        return child;
      },
      removeChild: (child: HTMLElement) => {
        const i = children.indexOf(child);
        if (i >= 0) children.splice(i, 1);
        return child;
      },
      remove: () => {
        const p = (el as unknown as HTMLElement).parentElement;
        if (p !== null) p.removeChild(el as unknown as HTMLElement);
      },
      querySelector: (selector: string): HTMLElement | null =>
        findByClass(el as unknown as HTMLElement, selector),
    };
    return el as unknown as HTMLElement;
  };
  const doc = {
    createElement: () => elFor(doc as unknown as Document),
  } as unknown as Document;
  const body = elFor(doc);
  return { doc, body };
};

describe('chrome extras coverage', () => {
  it('startClock mounts and tearable handle', () => {
    const { doc, body } = makeFakeDom();
    const handle = startClock({ ownerDocument: doc, parent: body });
    expect(handle.element).toBeDefined();
    expect(body.childNodes.length).toBe(1);
    handle.tick();
    handle.freeze();
    handle.stop();
    handle.stop(); // idempotent
  });

  it('firePopout mounts then schedules removal', async () => {
    const { doc, body } = makeFakeDom();
    const handle = firePopout({ ownerDocument: doc, parent: body }, 'BOOM');
    expect(body.childNodes.length).toBe(1);
    handle.remove();
    expect(body.childNodes.length).toBe(0);
    handle.remove(); // idempotent
  });

  it('slamBrand / slamBrandClean / setTag / clearTag mutate slot text', () => {
    const { doc, body } = makeFakeDom();
    const slots = mountChromeSlots({ surface: body, ownerDocument: doc });
    slamBrand(slots, '<span>PAN</span>');
    expect((slots.brand as unknown as { innerHTML: string }).innerHTML).toContain('PAN');
    slamBrandClean(slots, '<span>CTX</span>');
    expect((slots.brand as unknown as { innerHTML: string }).innerHTML).toContain('CTX');
    setTag(slots, 'TLP:RED');
    expect((slots.tag as unknown as { textContent: string | null }).textContent).toBe('TLP:RED');
    clearTag(slots);
    expect((slots.tag as unknown as { textContent: string | null }).textContent).toBe('');
  });

  it('shake / fireScreenFlash / renderAct exercise reflow path', () => {
    const { doc, body } = makeFakeDom();
    const slots = mountChromeSlots({ surface: body, ownerDocument: doc });
    shake(slots);
    expect((slots.stage as unknown as HTMLElement).classList.contains('shake')).toBe(true);
    fireScreenFlash(slots);
    expect((slots.flash as unknown as HTMLElement).classList.contains('fire')).toBe(true);
    renderAct(slots, '<p>hi</p>');
    expect((slots.actFrame as unknown as { innerHTML: string }).innerHTML).toBe('<p>hi</p>');
  });

  it('fadeOutAll / flickerOutAll / resetFlickers cycle the slot classes', async () => {
    const { doc, body } = makeFakeDom();
    const slots = mountChromeSlots({ surface: body, ownerDocument: doc });
    fadeOutAll(slots);
    expect((slots.title as unknown as HTMLElement).classList.contains('fade-out-clean')).toBe(true);
    flickerOutAll(slots);
    await new Promise((r) => setTimeout(r, 280));
    expect((slots.title as unknown as HTMLElement).classList.contains('flicker-out-a')).toBe(true);
    resetFlickers(slots);
    expect((slots.title as unknown as HTMLElement).classList.contains('flicker-out-a')).toBe(false);
    expect((slots.title as unknown as HTMLElement).classList.contains('fade-out-clean')).toBe(
      false,
    );
  });
});
