// Pulsar L2 template — operatorDossier.
//
// Actor / operator profile card: silhouette + handle + definition
// list of `{ key, value }` rows. Generalizes "the operator" pattern
// (CTF handle + skill/budget/motivation/access rows) to any actor
// profile slide.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface DossierRow {
  readonly k: string;
  readonly v: string;
}

export interface OperatorDossierContent {
  /** Operator handle / call-sign (e.g. `DRIFT`). */
  readonly handle: string;
  /** Optional small eyebrow above the handle (defaults to `operator`). */
  readonly eyebrow?: string;
  /** Definition rows. */
  readonly rows: readonly DossierRow[];
}

export const operatorDossier = (
  id: string,
  content: OperatorDossierContent,
): SceneModule =>
  buildTemplateScene({
    id,
    title: `Operator — ${content.handle}`,
    captions: [{ at: 'dossier-in', text: `Operator profile: ${content.handle}.` }],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'operator-dossier',
        buildChildren: (root, ownerDoc) => {
          const grid = ownerDoc.createElement('div');
          grid.setAttribute('class', 'dossier__grid');
          const silhouette = ownerDoc.createElement('div');
          silhouette.setAttribute('class', 'dossier__silhouette');
          silhouette.setAttribute('aria-hidden', 'true');
          grid.appendChild?.(silhouette);
          const body = ownerDoc.createElement('div');
          body.setAttribute('class', 'dossier__body');
          const eyebrow = ownerDoc.createElement('div');
          eyebrow.setAttribute('class', 'dossier__eyebrow');
          eyebrow.textContent = content.eyebrow ?? 'operator';
          body.appendChild?.(eyebrow);
          const handle = ownerDoc.createElement('h2');
          handle.setAttribute('class', 'dossier__handle');
          handle.textContent = content.handle;
          body.appendChild?.(handle);
          const list = ownerDoc.createElement('dl');
          list.setAttribute('class', 'dossier__list');
          for (const row of content.rows) {
            const item = ownerDoc.createElement('div');
            item.setAttribute('class', 'dossier__row');
            const dt = ownerDoc.createElement('dt');
            dt.textContent = row.k;
            item.appendChild?.(dt);
            const dd = ownerDoc.createElement('dd');
            dd.textContent = row.v;
            item.appendChild?.(dd);
            list.appendChild?.(item);
          }
          body.appendChild?.(list);
          grid.appendChild?.(body);
          root.appendChild?.(grid);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.6,
        buildSegments: (tl) => {
          tl.addLabel('dossier-in', 0);
          tl.to({}, { duration: 1.2 });
        },
      }),
  });
