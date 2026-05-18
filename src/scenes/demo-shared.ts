// Issue 98 — shared helpers for the vertical-slice demo scenes.
//
// The codex preflight at
// `docs/design/issue-098-vertical-slice-demo-preflight.md` is
// explicit: "Promote a shared scene helper only when multiple demo
// scenes need the same non-trivial DOM/context narrowing; do not
// introduce a demo framework on the first pass." The three demo
// scenes (`demo-title.ts`, `demo-feature.ts`, `demo-outro.ts`) each
// need the same defensive ctx-narrowing predicate, the same
// timeline-owned activation helper, and the same root-finding query;
// keeping the helpers inline in each scene was triggering Sonar's
// duplicated-lines gate (32% on the diff under the 3% bar) AND was
// the kind of copy-paste drift the preflight names. Extracting THESE
// helpers — and nothing else — is the minimum shared surface that
// closes the duplication without becoming a "demo framework": per-
// scene constants (beat names, selectors, asset paths, copy text)
// still live next to the scene that owns them, and each scene's
// lifecycle hooks are still authored in the scene file.
//
// This module is intentionally NOT a runtime abstraction: it does
// not extend the scene schema, the composition model, or the
// validator. The runtime sees only `SceneModule` instances; this
// file is authoring infrastructure for the three demo scenes.

import { NAVIGATION_MODES } from '../runtime/navigation';
import type { WorkbenchSceneCtx } from '../runtime/scene-loader';

/**
 * The minimal shape the demo lifecycle hooks need from any element
 * they allocate via `ctx.stage.ownerDocument.createElement`. The
 * `appendChild` / `textContent` members are optional so off-DOM test
 * harnesses can supply bare records without those fields.
 */
export interface DemoDomElement {
  setAttribute(name: string, value: string): void;
  appendChild?(node: unknown): unknown;
  textContent?: string;
}

/** The factory `ctx.stage.ownerDocument` exposes to the demo scenes. */
export interface DemoDomFactory {
  createElement(tag: string): DemoDomElement;
}

/**
 * The stage subset the demo scenes use. Matches the
 * `FixtureStageElement` shape `browser-support-fixture.ts` and
 * `dom-css-accessibility-fixture.ts` declare locally, with the
 * `setAttribute?` extension on the queryselector result so the
 * timeline-owned activation pattern can mutate found nodes.
 */
export interface DemoStageElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild?(node: unknown): unknown;
  querySelector?(selector: string): {
    setAttribute?(name: string, value: string): void;
    remove?(): void;
  } | null;
  readonly ownerDocument?: DemoDomFactory | null;
}

/**
 * The ctx narrowing every demo scene uses. Reading three of
 * `WorkbenchSceneCtx`'s fields (`stage`, `mode`, `gsap`); a
 * malformed ctx (no stage, unknown mode, non-gsap engine) is a
 * silent no-op — same defensive pattern the existing fixture scenes
 * use.
 */
export interface DemoCtx {
  readonly stage: DemoStageElement | null;
  readonly mode: WorkbenchSceneCtx['mode'];
  readonly gsap: WorkbenchSceneCtx['gsap'];
}

const isStageShape = (stage: unknown): stage is DemoStageElement | null => {
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

/**
 * Identical narrowing predicate every demo scene uses. Returns true
 * iff `value` exposes `stage` / `mode` / `gsap` with the documented
 * shapes; lifecycle hooks treat a `false` return as a silent no-op
 * to match the existing fixture scenes' defensive contract.
 */
export const isDemoCtx = (value: unknown): value is DemoCtx => {
  if (typeof value !== 'object' || value === null) return false;
  if (!('stage' in value) || !('mode' in value) || !('gsap' in value)) return false;
  const { stage, mode, gsap } = value;
  if (!isStageShape(stage)) return false;
  if (typeof mode !== 'string' || !(NAVIGATION_MODES as readonly string[]).includes(mode)) {
    return false;
  }
  return isGsapShape(gsap);
};

/**
 * The DOM marker every demo scene root carries. Per-scene constants
 * stay scene-local (each scene defines its own `ROOT_VALUE` so the
 * scene id and the marker value share one source of truth in that
 * file); the attribute name is shared because the e2e spec queries
 * by `[data-pulsar-demo-scene="<id>"]` regardless of which scene
 * mounted the root.
 */
export const DEMO_ROOT_ATTR = 'data-pulsar-demo-scene';

/**
 * The activation marker every demo scene's timeline flips at the
 * start and end of its own segment. The composition resolver mounts
 * every scene's root BEFORE the master timeline runs (PUL-F004 /
 * ADR-025), so a scene that is visible from `create(ctx)` would
 * render simultaneously with every other scene. Setting this marker
 * to `"false"` (and the inline `display: none;` companion below) in
 * `create(ctx)` and flipping to `"true"` inside the scene's own
 * timeline segment keeps the composition sequential.
 */
export const DEMO_ACTIVE_ATTR = 'data-pulsar-demo-active';

/**
 * Flip a scene root's `data-pulsar-demo-active` marker AND its
 * inline `display` style in one call so the start-of-segment and
 * end-of-segment activation/deactivation stays symmetric.
 *
 * `null` root is a no-op (off-DOM test harness path matching the
 * existing fixture scenes' silent-on-missing contract). Inline
 * `style` mutation instead of relying on production CSS, because the
 * workbench currently ships no CSS and relying on an external rule
 * would leave the demo visually layered even when the marker said
 * "inactive".
 */
export const setDemoActive = (
  root: {
    setAttribute?(name: string, value: string): void;
  } | null,
  active: boolean,
): void => {
  if (root === null || typeof root.setAttribute !== 'function') return;
  root.setAttribute(DEMO_ACTIVE_ATTR, active ? 'true' : 'false');
  root.setAttribute('style', active ? '' : 'display: none;');
};

/**
 * Locate a scene's root via `[data-pulsar-demo-scene="<rootValue>"]`.
 * Returns `null` when the stage does not expose `querySelector` (off-
 * DOM test harness path).
 */
export const findDemoRoot = (
  stage: DemoStageElement,
  rootValue: string,
): {
  setAttribute?(name: string, value: string): void;
  remove?(): void;
} | null => {
  if (typeof stage.querySelector !== 'function') return null;
  return stage.querySelector(`[${DEMO_ROOT_ATTR}="${rootValue}"]`);
};
