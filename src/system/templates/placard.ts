// Pulsar L2 template — placard.
//
// Centered quote card (rule + title + optional subtitle). Used as a
// cold-open style beat header.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface PlacardContent {
  readonly line1: string;
  readonly line2?: string;
}

export const placard = (id: string, content: PlacardContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Placard — ${content.line1}`,
    captions: [{ at: 'placard-in', text: content.line1 }],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'placard',
        buildChildren: (root, ownerDoc) => {
          const inner = ownerDoc.createElement('div');
          inner.setAttribute('class', 'placard');
          const rule = ownerDoc.createElement('span');
          rule.setAttribute('class', 'placard__rule');
          inner.appendChild(rule);
          const title = ownerDoc.createElement('h2');
          title.setAttribute('class', 'placard__title');
          title.textContent = content.line1;
          inner.appendChild(title);
          if (content.line2 !== undefined) {
            const sub = ownerDoc.createElement('p');
            sub.setAttribute('class', 'placard__sub');
            sub.textContent = content.line2;
            inner.appendChild(sub);
          }
          root.appendChild(inner);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.4,
        buildSegments: (tl) => {
          tl.addLabel('placard-in', 0);
          tl.to({}, { duration: 1.2 });
        },
      }),
  });
