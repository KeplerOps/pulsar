// Issue 98 — vertical-slice demo: closing card.
//
// The third (and final) scene in the demo composition. A short
// authored close — one named GSAP beat (`outro-out`), one caption
// anchored to it, no assets, no audio. The shared lifecycle
// envelope lives in `./demo-shared.ts`; per-scene constants stay
// here.

import type { SceneModule } from '../runtime/scene';
import { buildDemoTimeline, cleanupDemoRoot, mountDemoRoot } from './demo-shared';

const ROOT_VALUE = 'demo-outro';
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
    mountDemoRoot(ctx, ROOT_VALUE, (root, ownerDoc) => {
      const heading = ownerDoc.createElement('h2');
      // `dataset.pulsarDemoX = ''` is the idiomatic data-* surface —
      // see `demo-title.ts` for the rationale.
      if (heading.dataset !== undefined) heading.dataset.pulsarDemoHeadline = '';
      heading.textContent = HEADLINE_TEXT;
      root.appendChild?.(heading);
      const body = ownerDoc.createElement('p');
      if (body.dataset !== undefined) body.dataset.pulsarDemoBody = '';
      body.textContent = BODY_TEXT;
      root.appendChild?.(body);
    });
  },
  timeline: (ctx: unknown) =>
    buildDemoTimeline(
      ctx,
      ROOT_VALUE,
      (tl) => {
        tl.to({}, { duration: 1 });
        tl.addLabel(BEAT_OUTRO_OUT, 1);
      },
      0.5,
    ),
  cleanup: cleanupDemoRoot(ROOT_VALUE),
};
