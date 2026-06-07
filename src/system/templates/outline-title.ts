// Pulsar L2 template — outlineTitle.
//
// Numbered outline slide ("Section 4 — Detection"). Used to mark
// the start of an outline section in long talks.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface OutlineTitleContent {
  readonly index: number;
  readonly title: string;
  readonly prefix?: string; // e.g. "Section", "Chapter" — defaults to "Section"
}

const ROMAN: readonly string[] = [
  '0',
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
  'XI',
  'XII',
  'XIII',
  'XIV',
  'XV',
];

export const outlineTitle = (id: string, content: OutlineTitleContent): SceneModule => {
  const prefix = content.prefix ?? 'Section';
  const numeral = ROMAN[content.index] ?? String(content.index);
  return buildTemplateScene({
    id,
    title: `Outline — ${content.title}`,
    captions: [{ at: 'outline-in', text: `${prefix} ${numeral}: ${content.title}` }],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'outline-title',
        buildChildren: (root, ownerDoc) => {
          const idx = ownerDoc.createElement('div');
          idx.setAttribute('class', 'outline__index');
          idx.textContent = `${prefix} ${numeral}`;
          root.appendChild(idx);
          const t = ownerDoc.createElement('h2');
          t.setAttribute('class', 'outline__title');
          t.textContent = content.title;
          root.appendChild(t);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.4,
        buildSegments: (tl) => {
          tl.addLabel('outline-in', 0);
          tl.to({}, { duration: 1.2 });
        },
      }),
  });
};
