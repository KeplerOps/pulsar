// Pulsar L2 template — compare.
//
// Two-column before/after / A-B layout with optional headline.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface CompareContent {
  readonly headline?: string;
  readonly left: string;
  readonly right: string;
}

export const compare = (id: string, content: CompareContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Compare — ${content.headline ?? 'A vs B'}`,
    captions: [
      { at: 'compare-in', text: content.headline ?? `${content.left} vs ${content.right}` },
    ],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'compare',
        buildChildren: (root, ownerDoc) => {
          if (content.headline !== undefined) {
            const h = ownerDoc.createElement('h2');
            h.setAttribute('class', 'headline');
            h.textContent = content.headline;
            root.appendChild(h);
          }
          const sides = ownerDoc.createElement('div');
          sides.setAttribute('class', 'sides');
          const left = ownerDoc.createElement('article');
          left.setAttribute('class', 'left');
          left.textContent = content.left;
          sides.appendChild(left);
          const right = ownerDoc.createElement('article');
          right.setAttribute('class', 'right');
          right.textContent = content.right;
          sides.appendChild(right);
          root.appendChild(sides);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.6,
        buildSegments: (tl) => {
          tl.addLabel('compare-in', 0);
          tl.to({}, { duration: 1.4 });
        },
      }),
  });
