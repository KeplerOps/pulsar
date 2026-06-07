// Pulsar L2 template — centerpiece.
//
// Slow-grow quote with attribution. Use for the dramatic single-
// thought moment in an act. Styled via `.pulsar-template--centerpiece`.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface CenterpieceContent {
  readonly quote: string;
  readonly attribution?: string;
}

export const centerpiece = (id: string, content: CenterpieceContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Centerpiece — ${content.quote.slice(0, 40)}…`,
    captions: [{ at: 'centerpiece-grow', text: content.quote }],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'centerpiece',
        buildChildren: (root, ownerDoc) => {
          const q = ownerDoc.createElement('blockquote');
          q.setAttribute('class', 'centerpiece__quote');
          q.textContent = content.quote;
          root.appendChild(q);
          if (content.attribution !== undefined) {
            const attr = ownerDoc.createElement('p');
            attr.setAttribute('class', 'centerpiece__attr');
            attr.textContent = content.attribution;
            root.appendChild(attr);
          }
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 2.5,
        buildSegments: (tl) => {
          tl.addLabel('centerpiece-grow', 0);
          tl.to({}, { duration: 4.5 });
        },
      }),
  });
