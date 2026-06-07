// Pulsar L2 template — bulletList.
//
// Eyebrow + title + staggered bullet reveal.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface BulletListContent {
  readonly eyebrow?: string;
  readonly title: string;
  readonly bullets: readonly string[];
  /** ms between bullet reveals. Defaults to 350. */
  readonly staggerMs?: number;
}

export const bulletList = (id: string, content: BulletListContent): SceneModule => {
  const stagger = content.staggerMs ?? 350;
  return buildTemplateScene({
    id,
    title: `Bullets — ${content.title}`,
    captions: content.bullets.map((b, i) => ({ at: `bullet-${i}`, text: b })),
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'bullet-list',
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
          const ul = ownerDoc.createElement('ul');
          ul.setAttribute('class', 'bullets');
          content.bullets.forEach((b, i) => {
            const li = ownerDoc.createElement('li');
            li.setAttribute('style', `--bullet-delay: ${500 + i * stagger}ms`);
            li.textContent = b;
            ul.appendChild(li);
          });
          root.appendChild(ul);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.6,
        buildSegments: (tl) => {
          content.bullets.forEach((_b, i) => {
            tl.addLabel(`bullet-${i}`, 0.5 + (i * stagger) / 1000);
          });
          tl.to({}, { duration: 0.6 + (content.bullets.length * stagger) / 1000 });
        },
      }),
  });
};
