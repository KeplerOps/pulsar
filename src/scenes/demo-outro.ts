// Issue 98 — vertical-slice demo: closing card.
//
// The third (and final) scene in the demo composition. A short
// authored close — one named GSAP beat (`outro-out`), one caption
// anchored to it, no assets, no audio. Shared defensive helpers
// (ctx predicate, activation flip, scene-root query) live in
// `./demo-shared.ts`.

import type { SceneModule } from '../runtime/scene';
import {
  DEMO_ACTIVE_ATTR,
  DEMO_ROOT_ATTR,
  findDemoRoot,
  isDemoCtx,
  setDemoActive,
} from './demo-shared';

const ROOT_VALUE = 'demo-outro';
const STATE_ATTR = 'data-pulsar-demo-state';
const BEAT_OUTRO_OUT = 'outro-out';

const HEADLINE_TEXT = 'Thanks for watching.';
const BODY_TEXT = 'Reuse these scenes in another composition, or stretch them with new ones.';

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
    root.setAttribute(DEMO_ROOT_ATTR, ROOT_VALUE);
    root.setAttribute(STATE_ATTR, 'mounted');
    root.setAttribute(DEMO_ACTIVE_ATTR, 'false');
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
    const root = findDemoRoot(stage, ROOT_VALUE);
    const tl = ctx.gsap.timeline();
    tl.call(() => setDemoActive(root, true));
    tl.to({}, { duration: 1 });
    tl.addLabel(BEAT_OUTRO_OUT, 1);
    tl.to(
      {},
      {
        duration: 0.5,
        onComplete: () => {
          if (root !== null && typeof root.setAttribute === 'function') {
            root.setAttribute(STATE_ATTR, 'ran');
          }
          setDemoActive(root, false);
        },
      },
    );
    return tl;
  },
  cleanup: (ctx: unknown) => {
    if (!isDemoCtx(ctx)) return;
    const stage = ctx.stage;
    if (stage === null) return;
    const root = findDemoRoot(stage, ROOT_VALUE);
    if (root !== null && typeof root.remove === 'function') {
      root.remove();
    }
  },
};
