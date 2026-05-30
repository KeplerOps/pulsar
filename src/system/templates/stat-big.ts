// Pulsar L2 template — statBig.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface StatBigContent {
  readonly value: string;
  readonly label: string;
}

export const statBig = (id: string, content: StatBigContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Stat — ${content.value} ${content.label}`,
    captions: [{ at: 'stat-in', text: `${content.value} — ${content.label}` }],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'stat-big',
        buildChildren: (root, ownerDoc) => {
          const v = ownerDoc.createElement('div');
          v.setAttribute('class', 'stat__value');
          v.textContent = content.value;
          root.appendChild(v);
          const l = ownerDoc.createElement('div');
          l.setAttribute('class', 'stat__label');
          l.textContent = content.label;
          root.appendChild(l);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.5,
        buildSegments: (tl) => {
          tl.addLabel('stat-in', 0);
          tl.to({}, { duration: 1 });
        },
      }),
  });
