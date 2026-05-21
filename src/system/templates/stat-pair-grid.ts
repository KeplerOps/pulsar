// Pulsar L2 template — statPairGrid.
//
// 3-up / 4-up auto-fit grid of (a, b) pairs. `a` renders as a hero
// number; `b` as the descriptor below.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export type StatPair = readonly [a: string, b: string];

export interface StatPairGridContent {
  readonly eyebrow?: string;
  readonly title: string;
  readonly pairs: readonly StatPair[];
}

export const statPairGrid = (id: string, content: StatPairGridContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Pair grid — ${content.title}`,
    captions: [{ at: 'grid-in', text: content.title }],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'stat-pair-grid',
        buildChildren: (root, ownerDoc) => {
          if (content.eyebrow !== undefined) {
            const eb = ownerDoc.createElement('div');
            eb.setAttribute('class', 'eyebrow');
            eb.textContent = content.eyebrow;
            root.appendChild?.(eb);
          }
          const h = ownerDoc.createElement('h2');
          h.setAttribute('class', 'heading');
          h.textContent = content.title;
          root.appendChild?.(h);
          const grid = ownerDoc.createElement('div');
          grid.setAttribute('class', 'pair-grid');
          content.pairs.forEach(([a, b], i) => {
            const art = ownerDoc.createElement('article');
            art.setAttribute('style', `--pair-delay: ${400 + i * 180}ms`);
            const av = ownerDoc.createElement('span');
            av.setAttribute('class', 'stat-pair__a');
            av.textContent = a;
            art.appendChild?.(av);
            const bv = ownerDoc.createElement('span');
            bv.setAttribute('class', 'stat-pair__b');
            bv.textContent = b;
            art.appendChild?.(bv);
            grid.appendChild?.(art);
          });
          root.appendChild?.(grid);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.8,
        buildSegments: (tl) => {
          tl.addLabel('grid-in', 0.5);
          tl.to({}, { duration: 0.6 + content.pairs.length * 0.18 });
        },
      }),
  });
