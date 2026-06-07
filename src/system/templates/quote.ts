// Pulsar L2 template — quote.
//
// Pull quote centered. Lighter weight than `centerpiece` (no slow-
// grow), suitable for inline narrative quotes.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface QuoteContent {
  readonly text: string;
  readonly attribution?: string;
}

export const quote = (id: string, content: QuoteContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Quote — ${content.text.slice(0, 40)}…`,
    captions: [{ at: 'quote-in', text: content.text }],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'quote',
        buildChildren: (root, ownerDoc) => {
          const q = ownerDoc.createElement('blockquote');
          q.setAttribute('class', 'quote__text');
          q.textContent = content.text;
          root.appendChild(q);
          if (content.attribution !== undefined) {
            const attr = ownerDoc.createElement('p');
            attr.setAttribute('class', 'quote__attr');
            attr.textContent = `— ${content.attribution}`;
            root.appendChild(attr);
          }
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.6,
        buildSegments: (tl) => {
          tl.addLabel('quote-in', 0);
          tl.to({}, { duration: 1.4 });
        },
      }),
  });
