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
import { createDomFake } from '../support/fakes';

const newStage = (): { doc: Document; body: HTMLElement } => {
  const { doc, createElement } = createDomFake();
  return { doc, body: createElement('div') };
};

describe('chrome extras coverage', () => {
  it('startClock mounts and tearable handle', () => {
    const { doc, body } = newStage();
    const handle = startClock({ ownerDocument: doc, parent: body });
    expect(handle.element).toBeDefined();
    expect(body.childNodes.length).toBe(1);
    handle.tick();
    handle.freeze();
    handle.stop();
    handle.stop(); // idempotent
  });

  it('firePopout mounts then schedules removal', async () => {
    const { doc, body } = newStage();
    const handle = firePopout({ ownerDocument: doc, parent: body }, 'BOOM');
    expect(body.childNodes.length).toBe(1);
    handle.remove();
    expect(body.childNodes.length).toBe(0);
    handle.remove(); // idempotent
  });

  it('slamBrand / slamBrandClean / setTag / clearTag mutate slot text', () => {
    const { doc, body } = newStage();
    const slots = mountChromeSlots({ surface: body, ownerDocument: doc });
    slamBrand(slots, '<span>PAN</span>');
    expect(slots.brand.innerHTML).toContain('PAN');
    slamBrandClean(slots, '<span>CTX</span>');
    expect(slots.brand.innerHTML).toContain('CTX');
    setTag(slots, 'TLP:RED');
    expect(slots.tag.textContent).toBe('TLP:RED');
    clearTag(slots);
    expect(slots.tag.textContent).toBe('');
  });

  it('shake / fireScreenFlash / renderAct exercise reflow path', () => {
    const { doc, body } = newStage();
    const slots = mountChromeSlots({ surface: body, ownerDocument: doc });
    shake(slots);
    expect(slots.stage.classList.contains('shake')).toBe(true);
    fireScreenFlash(slots);
    expect(slots.flash.classList.contains('fire')).toBe(true);
    renderAct(slots, '<p>hi</p>');
    expect(slots.actFrame.innerHTML).toBe('<p>hi</p>');
  });

  it('fadeOutAll / flickerOutAll / resetFlickers cycle the slot classes', async () => {
    const { doc, body } = newStage();
    const slots = mountChromeSlots({ surface: body, ownerDocument: doc });
    fadeOutAll(slots);
    expect(slots.title.classList.contains('fade-out-clean')).toBe(true);
    flickerOutAll(slots);
    await new Promise((r) => setTimeout(r, 280));
    expect(slots.title.classList.contains('flicker-out-a')).toBe(true);
    resetFlickers(slots);
    expect(slots.title.classList.contains('flicker-out-a')).toBe(false);
    expect(slots.title.classList.contains('fade-out-clean')).toBe(false);
  });
});
