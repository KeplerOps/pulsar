// Pulsar L2 template — dropList.
//
// A vertical list whose items "drop in" one at a time (staggered
// reveal). Each item has a label and optional sub. Used by capability
// upgrade / power-up scenes where each new line lands with a beat.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface DropItem {
  readonly label: string;
  readonly sub?: string;
  /** Optional modifier (`hot`, `cold`, `mute`) for per-item tinting. */
  readonly mod?: string;
}

export interface DropListContent {
  readonly eyebrow?: string;
  readonly headline?: string;
  readonly items: readonly DropItem[];
  /** Stagger between items (ms). Default 280. */
  readonly staggerMs?: number;
}

export const dropList = (id: string, content: DropListContent): SceneModule =>
  buildTemplateScene({
    id,
    title: 'Drop list',
    captions: content.items.map((it, i) => ({ at: `drop-${i}`, text: it.label })),
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'drop-list',
        buildChildren: (root, ownerDoc) => {
          if (content.eyebrow !== undefined || content.headline !== undefined) {
            const head = ownerDoc.createElement('header');
            head.setAttribute('class', 'dl__head');
            if (content.eyebrow !== undefined) {
              const eb = ownerDoc.createElement('p');
              eb.setAttribute('class', 'dl__eyebrow');
              eb.textContent = content.eyebrow;
              head.appendChild?.(eb);
            }
            if (content.headline !== undefined) {
              const h = ownerDoc.createElement('h2');
              h.setAttribute('class', 'dl__headline');
              h.textContent = content.headline;
              head.appendChild?.(h);
            }
            root.appendChild?.(head);
          }
          const list = ownerDoc.createElement('ul');
          list.setAttribute('class', 'dl__list');
          const stagger = content.staggerMs ?? 280;
          content.items.forEach((item, i) => {
            const li = ownerDoc.createElement('li');
            li.setAttribute(
              'class',
              `dl__item${item.mod !== undefined ? ` dl__item--${item.mod}` : ''}`,
            );
            li.setAttribute('style', `--drop-delay: ${i * stagger}ms`);
            const lab = ownerDoc.createElement('span');
            lab.setAttribute('class', 'dl__label');
            lab.textContent = item.label;
            li.appendChild?.(lab);
            if (item.sub !== undefined) {
              const sub = ownerDoc.createElement('span');
              sub.setAttribute('class', 'dl__sub');
              sub.textContent = item.sub;
              li.appendChild?.(sub);
            }
            list.appendChild?.(li);
          });
          root.appendChild?.(list);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.2,
        buildSegments: (tl) => {
          tl.addLabel('dl-in', 0);
          const totalMs = content.items.length * (content.staggerMs ?? 280);
          tl.to({}, { duration: Math.max(1, totalMs / 1000) });
        },
      }),
  });
