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
import { createDomFake } from '../support/fakes';

const newHost = (): { surface: HTMLElement; doc: Document } => {
  const { doc, createElement } = createDomFake();
  const surface = createElement('div');
  surface.setAttribute('data-pulsar-chrome', 'surface');
  return { surface, doc };
};

describe('mountChromeSlots', () => {
  it('mounts the documented slot DOM and returns stable refs', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface, ownerDocument: doc });
    // Surface has the .pulsar-stage class for atmospheric backdrop.
    expect(surface.classList.contains('pulsar-stage')).toBe(true);
    // Every slot ref points at a child of the surface (except `stage` which IS the surface).
    expect(slots.stage).toBe(surface);
    for (const key of ['title', 'brand', 'center', 'lowerThird', 'tag', 'flash'] as const) {
      expect(slots[key].parentElement).toBe(surface);
    }
    // actFrame is nested inside the .pulsar-act wrapper.
    expect(slots.actFrame.parentElement?.className).toMatch(/pulsar-act/);
  });

  it('is idempotent — a second call clears prior children before re-mounting', () => {
    const { surface, doc } = newHost();
    mountChromeSlots({ surface, ownerDocument: doc });
    const firstCount = surface.childNodes.length;
    const second = mountChromeSlots({ surface, ownerDocument: doc });
    // Same shape, same count — not accumulated.
    expect(surface.childNodes.length).toBe(firstCount);
    expect(second.title.parentElement).toBe(surface);
  });

  it('disposeChromeSlots removes every child and the .pulsar-stage class', () => {
    const { surface, doc } = newHost();
    mountChromeSlots({ surface, ownerDocument: doc });
    expect(surface.childNodes.length).toBeGreaterThan(0);
    disposeChromeSlots(surface);
    expect(surface.childNodes.length).toBe(0);
    expect(surface.classList.contains('pulsar-stage')).toBe(false);
  });
});

describe('chrome effect helpers', () => {
  it('shake toggles the .shake class through a reflow read', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface, ownerDocument: doc });
    shake(slots);
    expect(slots.stage.classList.contains('shake')).toBe(true);
  });

  it('fireScreenFlash toggles the .fire class on the flash slot', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface, ownerDocument: doc });
    fireScreenFlash(slots);
    expect(slots.flash.classList.contains('fire')).toBe(true);
  });

  it('renderAct / clearAct mutate innerHTML on the act-frame slot', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface, ownerDocument: doc });
    renderAct(slots, '<p>act content</p>');
    expect(slots.actFrame.innerHTML).toBe('<p>act content</p>');
    clearAct(slots);
    expect(slots.actFrame.innerHTML).toBe('');
  });

  it('slam/clear title and brand mutate the slot innerHTML', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface, ownerDocument: doc });
    slamTitle(slots, '<h1>X</h1>');
    expect(slots.title.innerHTML).toBe('<h1>X</h1>');
    clearTitle(slots);
    expect(slots.title.innerHTML).toBe('');
    slamBrand(slots, '<img />');
    expect(slots.brand.innerHTML).toBe('<img />');
    clearBrand(slots);
    expect(slots.brand.innerHTML).toBe('');
  });

  it('setTag / clearTag mutate textContent on the tag slot', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface, ownerDocument: doc });
    setTag(slots, 'TLP:AMBER');
    expect(slots.tag.textContent).toBe('TLP:AMBER');
    clearTag(slots);
    expect(slots.tag.textContent).toBe('');
  });

  it('fadeOutAll adds fade-out-clean to title/brand/act wrappers', () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface, ownerDocument: doc });
    fadeOutAll(slots);
    expect(slots.title.classList.contains('fade-out-clean')).toBe(true);
    expect(slots.brand.classList.contains('fade-out-clean')).toBe(true);
    const act = slots.actFrame.parentElement as HTMLElement;
    expect(act.classList.contains('fade-out-clean')).toBe(true);
  });

  it('flickerOutAll + resetFlickers cleanly toggle the flicker classes', async () => {
    const { surface, doc } = newHost();
    const slots = mountChromeSlots({ surface, ownerDocument: doc });
    flickerOutAll(slots);
    // Stagger uses setTimeout — wait for the longest delay (230ms).
    await new Promise((r) => setTimeout(r, 280));
    expect(slots.title.classList.contains('flicker-out-a')).toBe(true);
    expect(slots.brand.classList.contains('flicker-out-b')).toBe(true);
    const act = slots.actFrame.parentElement as HTMLElement;
    expect(act.classList.contains('flicker-out-c')).toBe(true);
    resetFlickers(slots);
    expect(slots.title.classList.contains('flicker-out-a')).toBe(false);
    expect(slots.brand.classList.contains('flicker-out-b')).toBe(false);
    expect(act.classList.contains('flicker-out-c')).toBe(false);
  });
});
