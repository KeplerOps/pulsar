// Pulsar L2 chrome — effect helpers.
//
// Port of the demo_thoughts chrome.js effect helpers, rewritten so
// each function takes the slot refs explicitly rather than reading
// module-level mutable globals. Pulsar templates compose these against
// the `ChromeSlots` returned by `mountChromeSlots`.

import type { ChromeSlots } from './slots';

/** Read the `.pulsar-act` wrapper that hosts `actFrame`. */
const actWrapper = (slots: ChromeSlots): HTMLElement => {
  const parent = slots.actFrame.parentElement;
  if (parent === null) {
    throw new Error(
      'pulsar chrome: actFrame has no parent — was the slot disposed before this call?',
    );
  }
  return parent;
};

/**
 * Retrigger the shake keyframe on the stage. The remove-then-reflow-
 * then-add dance forces the browser to restart the CSS animation even
 * if the class was already present.
 */
export const shake = (slots: ChromeSlots): void => {
  slots.stage.classList.remove('shake');
  // Force a reflow so the next class-add is observed as a state
  // change. getBoundingClientRect() flushes layout the same way an
  // `offsetWidth` read does, but as a method call rather than a
  // discarded property-access expression.
  slots.stage.getBoundingClientRect();
  slots.stage.classList.add('shake');
};

/**
 * Retrigger the screen-flash keyframe. Same reflow trick as `shake`.
 */
export const fireScreenFlash = (slots: ChromeSlots): void => {
  slots.flash.classList.remove('fire');
  slots.flash.getBoundingClientRect();
  slots.flash.classList.add('fire');
};

/**
 * Stagger-fade the title, brand, and act layers offline. Each layer
 * goes on its own rhythm (90 / 230 / 140 ms) so they don't visibly
 * sync. Call `resetFlickers` to clear before re-mounting content.
 */
export const flickerOutAll = (slots: ChromeSlots): void => {
  const act = actWrapper(slots);
  setTimeout(() => slots.title.classList.add('flicker-out-a'), 90); // PUL-Q001-allow: stagger-out kickoff; never runs under mode=screenshot.
  setTimeout(() => slots.brand.classList.add('flicker-out-b'), 230); // PUL-Q001-allow: stagger-out kickoff; never runs under mode=screenshot.
  setTimeout(() => act.classList.add('flicker-out-c'), 140); // PUL-Q001-allow: stagger-out kickoff; never runs under mode=screenshot.
};

/**
 * Clear flicker-out classes from every layer so the next mount starts
 * clean.
 */
export const resetFlickers = (slots: ChromeSlots): void => {
  const act = actWrapper(slots);
  slots.title.classList.remove('flicker-out-a');
  slots.brand.classList.remove('flicker-out-b');
  act.classList.remove('flicker-out-c');
  slots.title.classList.remove('fade-out-clean');
  slots.brand.classList.remove('fade-out-clean');
  act.classList.remove('fade-out-clean');
};

/**
 * Clean (non-flicker) fade-out on every layer. Used when transitioning
 * between scenes that share the same chrome but don't need the glitchy
 * thriller exit.
 */
export const fadeOutAll = (slots: ChromeSlots): void => {
  const act = actWrapper(slots);
  slots.title.classList.add('fade-out-clean');
  slots.brand.classList.add('fade-out-clean');
  act.classList.add('fade-out-clean');
};

// ----- act-frame mounting -------------------------------------------------

/** Set the inner HTML of the act-frame slot. */
export const renderAct = (slots: ChromeSlots, html: string): void => {
  slots.actFrame.innerHTML = html;
};

/** Clear the act-frame slot. */
export const clearAct = (slots: ChromeSlots): void => {
  slots.actFrame.innerHTML = '';
};

// ----- title slot mounting ------------------------------------------------

/**
 * Set the title slot's HTML. Decks/templates pass a small structure
 * such as `<h1 class="title__h"><span class="word">…</span>…</h1>` to
 * exercise the word-in stagger animation.
 */
export const slamTitle = (slots: ChromeSlots, html: string): void => {
  slots.title.innerHTML = html;
};

/** Clear the title slot. */
export const clearTitle = (slots: ChromeSlots): void => {
  slots.title.innerHTML = '';
};

// ----- brand slot mounting ------------------------------------------------

/** Set the brand slot's HTML (typically two logo images + separator). */
export const slamBrand = (slots: ChromeSlots, html: string): void => {
  slots.brand.classList.remove('brandmark--clean');
  slots.brand.innerHTML = html;
};

/**
 * Clean fade-in (no glitch) — used on slides where the logos should
 * arrive cleanly rather than the cold-open's glitchy entrance.
 */
export const slamBrandClean = (slots: ChromeSlots, html: string): void => {
  slots.brand.classList.add('brandmark--clean');
  slots.brand.innerHTML = html;
};

/** Clear the brand slot. */
export const clearBrand = (slots: ChromeSlots): void => {
  slots.brand.classList.remove('brandmark--clean');
  slots.brand.innerHTML = '';
};

// ----- tag slot mounting --------------------------------------------------

/** Set the top-right watermark text (e.g., `TLP:AMBER`, deck label). */
export const setTag = (slots: ChromeSlots, text: string): void => {
  slots.tag.textContent = text;
};

/** Clear the tag slot. */
export const clearTag = (slots: ChromeSlots): void => {
  slots.tag.textContent = '';
};
