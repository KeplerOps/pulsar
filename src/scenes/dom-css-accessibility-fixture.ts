// PUL-Q008 / ADR-005 — DOM/CSS accessibility fixture scene.
//
// The fixture authors a small accessibility tree the Playwright spec
// at `tests-e2e/dom-css-accessibility.spec.ts` boots through the
// workbench URL grammar and assertions against in all three engines
// (chromium / firefox / webkit) the PUL-Q002 matrix runs.
//
// The fixture's job is purely structural: mount real DOM nodes whose
// presence and attributes prove the three PUL-Q008 clauses survive a
// scene-mount/cleanup round-trip.
//
//   Clause C1 (text remains selectable):
//     `<p data-pulsar-q008-text>` carries a deterministic phrase so
//     Playwright can triple-click the paragraph and read it back via
//     `window.getSelection().toString()`. The fixture authors no
//     `user-select: none` CSS (the PUL-Q008 source-policy gate
//     forbids it in scenes), and no `pointer-events: none`.
//
//   Clause C2 (focus order follows DOM order):
//     Two `<button>` elements appear in DOM order with stable
//     `data-pulsar-q008-button="alpha"` / `"beta"` markers and no
//     positive `tabindex`. Playwright presses Tab and asserts
//     `activeElement` matches the DOM order.
//
//   Clause C3 (ARIA attributes are not stripped by the runtime):
//     The fixture authors `aria-label`, `aria-describedby`,
//     `aria-labelledby`, and `role` attributes that the Playwright
//     spec inspects post-mount via `expect(locator).toHaveAttribute`
//     and via `page.accessibility.snapshot()`.
//
// The fixture follows the `browser-support-fixture.ts` defensiveness
// pattern: a narrow ctx predicate, allocation through
// `ctx.stage.ownerDocument.createElement` (NOT ambient `document`),
// and a `cleanup(ctx)` that removes the scene root if mounted.
// `standalone: true` — it does not assume surrounding composition
// context. `trailerSafe: false` — it has no trailer content.
//
// The fixture declares no assets, no audio, no captions. The asset
// preloader / audio service / prompter paths have their own unit
// tests; this fixture is scoped to the PUL-Q008 accessibility surface.

import { NAVIGATION_MODES } from '../runtime/navigation';
import type { SceneModule } from '../runtime/scene';
import type { WorkbenchSceneCtx } from '../runtime/scene-loader';

const ROOT_ATTR = 'data-pulsar-q008-root';
const TEXT_ATTR = 'data-pulsar-q008-text';
const BUTTON_ATTR = 'data-pulsar-q008-button';
const SENTINEL_ATTR = 'data-pulsar-q008-sentinel';
const LIFECYCLE_ATTR = 'data-pulsar-q008-lifecycle';

// The deterministic phrase the C1 selection assertion compares
// against. Static, non-secret, non-localised text — the fixture is a
// structural smoke target, not user-content.
export const SELECTABLE_PHRASE =
  'Pulsar preserves the browser accessibility tree for DOM/CSS scenes.';
const DESCRIPTION_TEXT = 'beta button description';
const REGION_LABEL = 'accessibility fixture surface';
const REGION_TEXT = 'Inside the labelled region.';

interface FixtureDomElement {
  setAttribute(name: string, value: string): void;
  appendChild?(node: unknown): unknown;
  textContent?: string;
}

interface FixtureDomFactory {
  createElement(tag: string): FixtureDomElement;
}

interface FixtureStageElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild?(node: unknown): unknown;
  querySelector?(selector: string): {
    remove?(): void;
  } | null;
  readonly ownerDocument?: FixtureDomFactory | null;
}

interface FixtureCtx {
  readonly stage: FixtureStageElement | null;
  readonly mode: WorkbenchSceneCtx['mode'];
}

const isStageShape = (stage: unknown): stage is FixtureStageElement | null => {
  if (stage === null) return true;
  if (typeof stage !== 'object') return false;
  const candidate = stage as Partial<Record<'setAttribute' | 'removeAttribute', unknown>>;
  return (
    typeof candidate.setAttribute === 'function' && typeof candidate.removeAttribute === 'function'
  );
};

const isFixtureCtx = (value: unknown): value is FixtureCtx => {
  if (typeof value !== 'object' || value === null) return false;
  if (!('stage' in value) || !('mode' in value)) return false;
  const { stage, mode } = value;
  if (!isStageShape(stage)) return false;
  if (typeof mode !== 'string' || !(NAVIGATION_MODES as readonly string[]).includes(mode)) {
    return false;
  }
  return true;
};

const findRoot = (stage: FixtureStageElement): { remove?(): void } | null => {
  if (typeof stage.querySelector !== 'function') return null;
  return stage.querySelector(`[${ROOT_ATTR}]`);
};

// Allocate a child element via the stage's owner document and apply
// attributes + text content in one call so the lifecycle hooks stay
// declarative. Returns `null` when the factory does not implement
// `createElement` (off-DOM test harness); callers treat this as a
// silent no-op (matching the browser-support fixture's pattern).
const allocateElement = (
  factory: FixtureDomFactory,
  tag: string,
  attrs: ReadonlyArray<readonly [string, string]>,
  text: string,
): FixtureDomElement | null => {
  if (typeof factory.createElement !== 'function') return null;
  const el = factory.createElement(tag);
  for (const [name, value] of attrs) {
    el.setAttribute(name, value);
  }
  if (text.length > 0) {
    el.textContent = text;
  }
  return el;
};

export const domCssAccessibilityFixtureScene: SceneModule = {
  id: 'dom-css-accessibility-fixture',
  title: 'DOM/CSS accessibility fixture',
  duration: null,
  tags: ['fixture', 'accessibility'],
  assets: [],
  captions: [],
  audio: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  create: (ctx: unknown) => {
    if (!isFixtureCtx(ctx)) return;
    const stage = ctx.stage;
    if (stage === null) return;
    if (typeof stage.appendChild !== 'function') return;
    const ownerDoc = stage.ownerDocument;
    if (ownerDoc === undefined || ownerDoc === null) return;
    if (typeof ownerDoc.createElement !== 'function') return;

    const root = allocateElement(ownerDoc, 'div', [[ROOT_ATTR, '']], '');
    if (root === null) return;
    if (typeof root.appendChild !== 'function') {
      // The stage's `createElement` returned an object without
      // `appendChild`; we cannot author child nodes. Attach the bare
      // root so cleanup still observes the marker, but skip nested
      // authoring (off-DOM harness path).
      stage.appendChild(root);
      return;
    }

    // Focus sentinel — placed FIRST in DOM order so the C2 browser
    // gate can focus a known anchor, press Tab once, and assert
    // alpha receives focus (proving alpha is the next focusable in
    // DOM order). Without this anchor, the test could only assert
    // "focus advances from alpha to beta" — which a regression that
    // skipped alpha entirely on the initial Tab could still pass.
    const sentinel = allocateElement(
      ownerDoc,
      'button',
      [
        [SENTINEL_ATTR, ''],
        ['type', 'button'],
        ['aria-label', 'focus sentinel'],
      ],
      'Sentinel',
    );
    if (sentinel !== null) root.appendChild(sentinel);

    const para = allocateElement(ownerDoc, 'p', [[TEXT_ATTR, '']], SELECTABLE_PHRASE);
    if (para !== null) root.appendChild(para);

    const alpha = allocateElement(
      ownerDoc,
      'button',
      [
        [BUTTON_ATTR, 'alpha'],
        ['type', 'button'],
        ['aria-label', 'alpha button'],
      ],
      'First',
    );
    if (alpha !== null) root.appendChild(alpha);

    const beta = allocateElement(
      ownerDoc,
      'button',
      [
        [BUTTON_ATTR, 'beta'],
        ['type', 'button'],
        ['aria-describedby', 'pul-q008-desc'],
        ['aria-labelledby', 'pul-q008-beta-label'],
      ],
      'Second',
    );
    if (beta !== null) root.appendChild(beta);

    const betaLabel = allocateElement(
      ownerDoc,
      'span',
      [
        ['id', 'pul-q008-beta-label'],
        ['data-pulsar-q008-beta-label', ''],
      ],
      'beta button',
    );
    if (betaLabel !== null) root.appendChild(betaLabel);

    const description = allocateElement(
      ownerDoc,
      'span',
      [
        ['id', 'pul-q008-desc'],
        ['role', 'note'],
      ],
      DESCRIPTION_TEXT,
    );
    if (description !== null) root.appendChild(description);

    const region = allocateElement(
      ownerDoc,
      'div',
      [
        ['role', 'region'],
        ['aria-label', REGION_LABEL],
        ['data-pulsar-q008-region', ''],
      ],
      REGION_TEXT,
    );
    if (region !== null) root.appendChild(region);

    stage.appendChild(root);
  },
  timeline: (ctx: unknown) => {
    // The fixture has no GSAP animation surface (the browser-support
    // fixture covers that path). Tag the stage with a lifecycle
    // marker so the composition resolver's `timeline(ctx)` invocation
    // is observable — the `placeholder` scene uses the same pattern
    // with its own `data-pulsar-scene-lifecycle` marker. Invalid ctx
    // returns null; valid ctx falls through to an implicit
    // `undefined` after the side effect. The master-timeline
    // composer treats both as "no timeline contribution"
    // (`src/runtime/timeline.ts` null/undefined branch), so the two
    // exit shapes are semantically identical to the composer; the
    // structural difference keeps the function honest under
    // SonarCloud's invariant-return rule.
    if (!isFixtureCtx(ctx)) return null;
    const stage = ctx.stage;
    if (stage !== null) {
      stage.setAttribute(LIFECYCLE_ATTR, 'timeline');
    }
  },
  cleanup: (ctx: unknown) => {
    if (!isFixtureCtx(ctx)) return;
    const stage = ctx.stage;
    if (stage === null) return;
    stage.removeAttribute(LIFECYCLE_ATTR);
    const root = findRoot(stage);
    if (root !== null && typeof root.remove === 'function') {
      root.remove();
    }
  },
};
