// Issue 98 — vertical-slice demo: closing card.
//
// The third (and final) scene in the demo composition. A short
// authored close — one named GSAP beat (`outro-out`), one caption
// anchored to it, no assets, no audio. Same defensive ctx-narrowing
// + ownerDocument allocation pattern as the other two demo scenes.

import { NAVIGATION_MODES } from '../runtime/navigation';
import type { SceneModule } from '../runtime/scene';
import type { WorkbenchSceneCtx } from '../runtime/scene-loader';

const ROOT_ATTR = 'data-pulsar-demo-scene';
const ROOT_VALUE = 'demo-outro';
const STATE_ATTR = 'data-pulsar-demo-state';
// See `demo-title.ts` for the rationale on timeline-owned activation.
const ACTIVE_ATTR = 'data-pulsar-demo-active';

const BEAT_OUTRO_OUT = 'outro-out';

const HEADLINE_TEXT = 'Thanks for watching.';
const BODY_TEXT = 'Reuse these scenes in another composition, or stretch them with new ones.';

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
    setAttribute?(name: string, value: string): void;
    remove?(): void;
  } | null;
  readonly ownerDocument?: FixtureDomFactory | null;
}

interface DemoCtx {
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

const isDemoCtx = (value: unknown): value is DemoCtx => {
  if (typeof value !== 'object' || value === null) return false;
  if (!('stage' in value) || !('mode' in value) || !('gsap' in value)) return false;
  const { stage, mode, gsap } = value;
  if (!isStageShape(stage)) return false;
  if (typeof mode !== 'string' || !(NAVIGATION_MODES as readonly string[]).includes(mode)) {
    return false;
  }
  return isGsapShape(gsap);
};

const findRoot = (
  stage: FixtureStageElement,
): {
  setAttribute?(name: string, value: string): void;
  remove?(): void;
} | null => {
  if (typeof stage.querySelector !== 'function') return null;
  return stage.querySelector(`[${ROOT_ATTR}="${ROOT_VALUE}"]`);
};

const setActive = (
  root: {
    setAttribute?(name: string, value: string): void;
  } | null,
  active: boolean,
): void => {
  if (root === null || typeof root.setAttribute !== 'function') return;
  root.setAttribute(ACTIVE_ATTR, active ? 'true' : 'false');
  root.setAttribute('style', active ? '' : 'display: none;');
};

export const demoOutroScene: SceneModule = {
  id: 'demo-outro',
  title: 'Demo — outro',
  // See `demo-title.ts` for the rationale: `null` until the timeline
  // becomes authoritative for prompter / export consumers.
  duration: null,
  tags: ['demo'],
  assets: [],
  captions: [{ at: BEAT_OUTRO_OUT, text: HEADLINE_TEXT }],
  audio: [],
  defaultNext: null,
  standalone: false,
  trailerSafe: true,
  create: (ctx: unknown) => {
    if (!isDemoCtx(ctx)) return;
    const stage = ctx.stage;
    if (stage === null) return;
    if (typeof stage.appendChild !== 'function') return;
    const ownerDoc = stage.ownerDocument;
    if (ownerDoc === undefined || ownerDoc === null) return;
    if (typeof ownerDoc.createElement !== 'function') return;

    const root = ownerDoc.createElement('section');
    root.setAttribute(ROOT_ATTR, ROOT_VALUE);
    root.setAttribute(STATE_ATTR, 'mounted');
    // Initially inactive — see demo-title.ts for the rationale.
    root.setAttribute(ACTIVE_ATTR, 'false');
    root.setAttribute('style', 'display: none;');
    if (typeof root.appendChild === 'function') {
      const heading = ownerDoc.createElement('h2');
      heading.setAttribute('data-pulsar-demo-headline', '');
      heading.textContent = HEADLINE_TEXT;
      root.appendChild(heading);
      const body = ownerDoc.createElement('p');
      body.setAttribute('data-pulsar-demo-body', '');
      body.textContent = BODY_TEXT;
      root.appendChild(body);
    }
    stage.appendChild(root);
  },
  timeline: (ctx: unknown) => {
    if (!isDemoCtx(ctx)) return null;
    const stage = ctx.stage;
    if (stage === null) return null;
    const root = findRoot(stage);
    const tl = ctx.gsap.timeline();
    tl.call(() => setActive(root, true));
    tl.to({}, { duration: 1 });
    tl.addLabel(BEAT_OUTRO_OUT, 1);
    // Trailing mutation rides on the last tween's `onComplete` — see
    // `src/scenes/demo-title.ts` for the rationale (last-entry master
    // boundary race).
    tl.to(
      {},
      {
        duration: 0.5,
        onComplete: () => {
          if (root !== null && typeof root.setAttribute === 'function') {
            root.setAttribute(STATE_ATTR, 'ran');
          }
          setActive(root, false);
        },
      },
    );
    return tl;
  },
  cleanup: (ctx: unknown) => {
    if (!isDemoCtx(ctx)) return;
    const stage = ctx.stage;
    if (stage === null) return;
    const root = findRoot(stage);
    if (root !== null && typeof root.remove === 'function') {
      root.remove();
    }
  },
};
