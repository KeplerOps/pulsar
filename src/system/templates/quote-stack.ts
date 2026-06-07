// Pulsar L2 template — quoteStack.
//
// Staggered list of (text, attribution) quotes — each reveals on its
// own delay.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface QuoteStackItem {
  readonly text: string;
  readonly attribution?: string;
}

export interface QuoteStackContent {
  readonly eyebrow?: string;
  readonly title: string;
  readonly quotes: readonly QuoteStackItem[];
}

export const quoteStack = (id: string, content: QuoteStackContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Quote stack — ${content.title}`,
    captions: content.quotes.map((q, i) => ({ at: `quote-${i}`, text: q.text })),
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'quote-stack',
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
          const stack = ownerDoc.createElement('div');
          stack.setAttribute('class', 'stack');
          content.quotes.forEach((q, i) => {
            const art = ownerDoc.createElement('article');
            art.setAttribute('style', `--stack-delay: ${500 + i * 620}ms`);
            const bq = ownerDoc.createElement('blockquote');
            bq.textContent = q.text;
            art.appendChild(bq);
            if (q.attribution !== undefined) {
              const cite = ownerDoc.createElement('cite');
              cite.textContent = q.attribution;
              art.appendChild(cite);
            }
            stack.appendChild(art);
          });
          root.appendChild(stack);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.6,
        buildSegments: (tl) => {
          content.quotes.forEach((_q, i) => {
            tl.addLabel(`quote-${i}`, 0.5 + i * 0.62);
          });
          tl.to({}, { duration: 0.6 + content.quotes.length * 0.62 });
        },
      }),
  });
