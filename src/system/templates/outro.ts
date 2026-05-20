// Pulsar L2 template — outro.
//
// Close card with title, optional subtitle, and optional QR image.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface OutroContent {
  readonly title: string;
  readonly subtitle?: string;
  readonly qrSrc?: string;
  readonly qrAlt?: string;
}

export const outro = (id: string, content: OutroContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Outro — ${content.title}`,
    captions: [{ at: 'outro-in', text: content.title }],
    assets: content.qrSrc === undefined ? [] : [content.qrSrc],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'outro',
        buildChildren: (root, ownerDoc) => {
          const title = ownerDoc.createElement('h2');
          title.setAttribute('class', 'outro__title');
          title.textContent = content.title;
          root.appendChild?.(title);
          if (content.subtitle !== undefined) {
            const sub = ownerDoc.createElement('p');
            sub.setAttribute('class', 'outro__subtitle');
            sub.textContent = content.subtitle;
            root.appendChild?.(sub);
          }
          if (content.qrSrc !== undefined) {
            const img = ownerDoc.createElement('img');
            img.setAttribute('class', 'outro__qr');
            img.setAttribute('src', content.qrSrc);
            img.setAttribute('alt', content.qrAlt ?? '');
            root.appendChild?.(img);
          }
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 2,
        buildSegments: (tl) => {
          tl.addLabel('outro-in', 0);
          tl.to({}, { duration: 1.5 });
        },
      }),
  });
