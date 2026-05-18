// Pulsar L2 template — definitionTable.
//
// TLP-style rows of (category, rule). `mod` keys the color variant
// (`red`, `amber`, `green`, `clear`); defaults to no modifier.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface DefinitionRow {
  readonly cat: string;
  readonly rule: string;
  readonly mod?: 'red' | 'amber' | 'green' | 'clear';
}

export interface DefinitionTableContent {
  readonly eyebrow?: string;
  readonly title: string;
  readonly rows: readonly DefinitionRow[];
}

export const definitionTable = (id: string, content: DefinitionTableContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Defs — ${content.title}`,
    captions: [{ at: 'rows-in', text: content.title }],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'definition-table',
        buildChildren: (root, ownerDoc) => {
          if (content.eyebrow !== undefined) {
            const eb = ownerDoc.createElement('div');
            eb.setAttribute('class', 'eyebrow');
            eb.textContent = content.eyebrow;
            root.appendChild?.(eb);
          }
          const h = ownerDoc.createElement('h2');
          h.setAttribute('class', 'heading');
          h.textContent = content.title;
          root.appendChild?.(h);
          const rows = ownerDoc.createElement('div');
          rows.setAttribute('class', 'rows');
          content.rows.forEach((r, i) => {
            const art = ownerDoc.createElement('article');
            art.setAttribute('style', `--row-delay: ${500 + i * 200}ms`);
            const cat = ownerDoc.createElement('span');
            cat.setAttribute('class', `cat${r.mod !== undefined ? ` mod-${r.mod}` : ''}`);
            cat.textContent = r.cat;
            art.appendChild?.(cat);
            const rule = ownerDoc.createElement('span');
            rule.setAttribute('class', 'rule');
            rule.textContent = r.rule;
            art.appendChild?.(rule);
            rows.appendChild?.(art);
          });
          root.appendChild?.(rows);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.6,
        buildSegments: (tl) => {
          tl.addLabel('rows-in', 0.5);
          tl.to({}, { duration: 0.6 + content.rows.length * 0.2 });
        },
      }),
  });
