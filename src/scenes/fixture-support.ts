// Shared scaffolding for the GSAP-timeline workbench fixture scenes
// (`browser-support-fixture.ts`, `loop-fixture.ts`).
//
// Both fixtures validate the same `ctx` subset — `stage`, `mode`,
// `gsap` (PUL-F012 / PUL-F022 / ADR-003) — and both mount a single
// marked `<div>` allocated through the stage's owner document
// (ADR-008 #2: DOM allocation goes through the injected `ctx.stage`,
// never the ambient global `document`). Extracting that common shape
// here keeps the fixtures from re-implementing it scene by scene; a
// new GSAP fixture is then a `mountFixtureElement` / `findFixtureElement`
// / `removeFixtureElement` call plus its own `timeline(ctx)` body.
//
// The DOM/CSS accessibility fixture (`dom-css-accessibility-fixture.ts`)
// deliberately does NOT consume this module: it validates a different
// ctx subset (no `gsap`) and builds a multi-element accessibility tree
// rather than a single timeline target, so sharing here would couple
// two unrelated fixture shapes.

import { NAVIGATION_MODES } from '../runtime/navigation';
import type { WorkbenchSceneCtx } from '../runtime/scene-loader';

/** Minimal owner-document seam: the fixtures only call `createElement`. */
export interface FixtureDomFactory {
  createElement(tag: string): { setAttribute(name: string, value: string): void };
}

/** The fixture element once mounted — the subset the lifecycle hooks touch. */
export interface FixtureElement {
  setAttribute(name: string, value: string): void;
  remove?(): void;
}

/**
 * The stage subset a GSAP fixture reads. Real DOM elements expose
 * `ownerDocument`; the fixture allocates DOM through the injected
 * stage's owner document rather than the ambient global `document`
 * (ADR-008 #2). The optional members let off-DOM test harnesses
 * supply a bare stage without a document.
 */
export interface FixtureStageElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild?(node: unknown): unknown;
  querySelector?(selector: string): FixtureElement | null;
  readonly ownerDocument?: FixtureDomFactory | null;
}

/**
 * The ctx subset a GSAP fixture reads. A malformed ctx (no `stage`,
 * no `mode`, unknown `mode`, non-element `stage`, non-gsap `gsap`)
 * narrows out via {@link isFixtureCtx} so the lifecycle hooks no-op
 * rather than crash.
 */
export interface FixtureCtx {
  readonly stage: FixtureStageElement | null;
  readonly mode: WorkbenchSceneCtx['mode'];
  readonly gsap: WorkbenchSceneCtx['gsap'];
}

const isStageShape = (stage: unknown): stage is FixtureStageElement | null => {
  if (stage === null) return true;
  if (typeof stage !== 'object') return false;
  const candidate = stage as Partial<Record<'setAttribute' | 'removeAttribute', unknown>>;
  return (
    typeof candidate.setAttribute === 'function' && typeof candidate.removeAttribute === 'function'
  );
};

const isGsapShape = (gsap: unknown): gsap is WorkbenchSceneCtx['gsap'] => {
  if (gsap === null || typeof gsap !== 'object') return false;
  return typeof (gsap as { timeline?: unknown }).timeline === 'function';
};

/** Narrow an unknown lifecycle argument to the {@link FixtureCtx} subset. */
export const isFixtureCtx = (value: unknown): value is FixtureCtx => {
  if (typeof value !== 'object' || value === null) return false;
  if (!('stage' in value) || !('mode' in value) || !('gsap' in value)) return false;
  const { stage, mode, gsap } = value;
  if (!isStageShape(stage)) return false;
  if (typeof mode !== 'string' || !(NAVIGATION_MODES as readonly string[]).includes(mode)) {
    return false;
  }
  return isGsapShape(gsap);
};

/** Locate the mounted fixture element by its target attribute, or `null`. */
export const findFixtureElement = (
  stage: FixtureStageElement,
  targetAttr: string,
): FixtureElement | null => {
  if (typeof stage.querySelector !== 'function') return null;
  return stage.querySelector(`[${targetAttr}]`);
};

/**
 * `create(ctx)` body for a GSAP fixture: allocate a `<div>` through
 * the stage's owner document, mark it with `targetAttr`, apply the
 * `extraAttrs` initial-state attributes, and append it to the stage.
 * An invalid ctx, a null stage, a stage without `appendChild`, or a
 * missing owner document is a silent no-op (matching the defensive
 * pattern the fixtures use against injected dependencies).
 */
export const mountFixtureElement = (
  ctx: unknown,
  targetAttr: string,
  extraAttrs: ReadonlyArray<readonly [string, string]>,
): void => {
  if (!isFixtureCtx(ctx)) return;
  const stage = ctx.stage;
  if (stage === null) return;
  if (typeof stage.appendChild !== 'function') return;
  const ownerDoc = stage.ownerDocument;
  if (ownerDoc === undefined || ownerDoc === null) return;
  if (typeof ownerDoc.createElement !== 'function') return;
  const el = ownerDoc.createElement('div');
  el.setAttribute(targetAttr, '');
  for (const [name, value] of extraAttrs) {
    el.setAttribute(name, value);
  }
  stage.appendChild(el);
};

/**
 * `cleanup(ctx)` body for a GSAP fixture: remove the mounted fixture
 * element. An invalid ctx, a null stage, or a missing element is a
 * silent no-op.
 */
export const removeFixtureElement = (ctx: unknown, targetAttr: string): void => {
  if (!isFixtureCtx(ctx)) return;
  const stage = ctx.stage;
  if (stage === null) return;
  const el = findFixtureElement(stage, targetAttr);
  if (el !== null && typeof el.remove === 'function') {
    el.remove();
  }
};
