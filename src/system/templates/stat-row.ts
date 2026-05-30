// Pulsar L2 template — statRow.
//
// Eyebrow + title + alternating two-column rows of (metric, text).

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export type StatRowEntry = readonly [metric: string, text: string];

export interface StatRowContent {
  readonly eyebrow?: string;
  readonly title: string;
  readonly rows: readonly StatRowEntry[];
}

export const statRow = (id: string, content: StatRowContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Stat row — ${content.title}`,
    captions: [{ at: 'rows-in', text: content.title }],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'stat-row',
        buildChildren: (root, ownerDoc) => {
          if (content.eyebrow !== undefined) {
            const eb = ownerDoc.createElement('div');
            eb.setAttribute('class', 'eyebrow');
            eb.textContent = content.eyebrow;
            root.appendChild(eb);
          }
          const h = ownerDoc.createElement('h2');
          h.setAttribute('class', 'heading');
          h.textContent = content.title;
          root.appendChild(h);
          const grid = ownerDoc.createElement('div');
          grid.setAttribute('class', 'row-grid');
          content.rows.forEach(([metric, text], i) => {
            const m = ownerDoc.createElement('span');
            m.setAttribute('class', 'metric');
            m.setAttribute('style', `--row-delay: ${400 + i * 160}ms`);
            m.textContent = metric;
            grid.appendChild(m);
            const t = ownerDoc.createElement('span');
            t.setAttribute('class', 'text');
            t.setAttribute('style', `--row-delay: ${480 + i * 160}ms`);
            t.textContent = text;
            grid.appendChild(t);
          });
          root.appendChild(grid);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.8,
        buildSegments: (tl) => {
          tl.addLabel('rows-in', 0.5);
          tl.to({}, { duration: 0.6 + content.rows.length * 0.16 });
        },
      }),
  });
