// Pulsar L2 chrome — slot mounting.
//
// The runtime's `WorkbenchChromeController` already mounts a single
// `<div data-pulsar-chrome="surface">` into the workbench before
// navigation begins (PUL-F031). This module POPULATES that surface
// with the L2 chrome slot DOM (atmospheric overlays, title slot,
// brand slot, centerpiece slot, lower-third, tag, act-frame, flash)
// and returns refs scenes can mount into.
//
// The slot refs are stable for the lifetime of the workbench — the
// chrome surface is never re-mounted, so a single `mountChromeSlots`
// call at bootstrap is sufficient. `disposeChromeSlots` exists for
// HMR cleanup so a re-evaluated entry module does not accumulate
// duplicate slot DOM.

/**
 * Element refs the L2 chrome installs into the workbench chrome
 * surface. Each is a stable element scenes can mount content into or
 * read attributes from. Slot ownership rules:
 *
 *  - `title` — scene templates that own the headline slot (title-slam,
 *    act-header, outro). Set `innerHTML` to render.
 *  - `brand` — bottom-left brand mark. Decks set this once at bootstrap
 *    via a per-deck chrome override; templates do not touch it.
 *  - `center` — centerpiece slot. Helpers like `fadeInCenter` mutate
 *    its `innerHTML` and `.classList`.
 *  - `lowerThird` — presenter HUD slot (practice notes, captions).
 *    Practice/prompter renderers populate it.
 *  - `tag` — top-right watermark (TLP, classification, deck label).
 *    Decks set this once at bootstrap.
 *  - `actFrame` — right-panel scene mount area. Templates that author
 *    a full scene root (terminal, screenshotCallouts) append into it.
 *  - `flash` — screen-flash overlay. `fireScreenFlash` toggles its
 *    `.fire` class to retrigger the keyframe.
 *  - `stage` — the workbench chrome surface element itself. The shake
 *    effect adds/removes `.shake` on it.
 */
export interface ChromeSlots {
  readonly stage: HTMLElement;
  readonly title: HTMLElement;
  readonly brand: HTMLElement;
  readonly center: HTMLElement;
  readonly lowerThird: HTMLElement;
  readonly tag: HTMLElement;
  readonly actFrame: HTMLElement;
  readonly flash: HTMLElement;
}

/**
 * Inputs to {@link mountChromeSlots}.
 *
 *  - `surface`: the workbench chrome surface element (from
 *    `WorkbenchChromeController`).
 *  - `ownerDocument`: the document used to allocate slot DOM. Threaded
 *    through explicitly so tests pass a fake document — chrome stays
 *    pure of ambient `document` lookups.
 */
export interface MountChromeSlotsHost {
  readonly surface: HTMLElement;
  readonly ownerDocument: Document;
}

/**
 * Internal element-creation helper. Builds an element with the given
 * tag name and CSS class, optionally with extra attributes.
 */
const makeEl = (
  doc: Document,
  tag: string,
  className: string,
  attrs?: Readonly<Record<string, string>>,
): HTMLElement => {
  const el = doc.createElement(tag);
  el.className = className;
  if (attrs !== undefined) {
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  }
  return el;
};

/**
 * Mount the L2 chrome slot DOM into the workbench chrome surface and
 * return refs for scene templates / helpers to use.
 *
 * Idempotent on the same surface: a second call removes the prior slot
 * DOM before re-mounting. This lets `main.ts` call once at bootstrap
 * and HMR re-evaluate without accumulating overlays.
 */
export const mountChromeSlots = (host: MountChromeSlotsHost): ChromeSlots => {
  const { surface, ownerDocument } = host;
  // Clear any prior slot DOM (HMR safety).
  while (surface.firstChild !== null) {
    surface.removeChild(surface.firstChild);
  }
  // The surface itself gets the .pulsar-stage class for atmospheric
  // backdrop + shake animation host.
  surface.classList.add('pulsar-stage');

  const vignette = makeEl(ownerDocument, 'div', 'pulsar-vignette', { 'aria-hidden': 'true' });
  const scanlines = makeEl(ownerDocument, 'div', 'pulsar-scanlines', { 'aria-hidden': 'true' });
  const grain = makeEl(ownerDocument, 'div', 'pulsar-grain', { 'aria-hidden': 'true' });
  const bars = makeEl(ownerDocument, 'div', 'pulsar-bars', { 'aria-hidden': 'true' });
  const flash = makeEl(ownerDocument, 'div', 'pulsar-flash', { 'aria-hidden': 'true' });
  const tag = makeEl(ownerDocument, 'aside', 'pulsar-tag');
  const title = makeEl(ownerDocument, 'section', 'pulsar-title');
  const brand = makeEl(ownerDocument, 'aside', 'pulsar-brand', { 'aria-hidden': 'true' });
  const center = makeEl(ownerDocument, 'section', 'pulsar-center');
  const lowerThird = makeEl(ownerDocument, 'aside', 'pulsar-lower-third');
  const act = makeEl(ownerDocument, 'section', 'pulsar-act');
  const actFrame = makeEl(ownerDocument, 'div', 'pulsar-act__frame');
  act.appendChild(actFrame);

  // Mount order matches the z-stack documented in tokens.css:
  // atmospherics first (vignette, scanlines, grain), then bars,
  // then slots and flash on top.
  surface.appendChild(vignette);
  surface.appendChild(scanlines);
  surface.appendChild(grain);
  surface.appendChild(act);
  surface.appendChild(title);
  surface.appendChild(brand);
  surface.appendChild(center);
  surface.appendChild(lowerThird);
  surface.appendChild(tag);
  surface.appendChild(bars);
  surface.appendChild(flash);

  return { stage: surface, title, brand, center, lowerThird, tag, actFrame, flash };
};

/**
 * Tear down chrome slot DOM. Removes every child from the surface and
 * the `.pulsar-stage` class. Idempotent.
 */
export const disposeChromeSlots = (surface: HTMLElement): void => {
  surface.classList.remove('pulsar-stage');
  while (surface.firstChild !== null) {
    surface.removeChild(surface.firstChild);
  }
};
