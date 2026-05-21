// Pulsar L2 template — haulCitations.
//
// Dual-column: a "haul" list on the left (rows that animate in
// staggered: count + label) + a citations card on the right with
// attributed quotes / data lines. Used by compromise / breakdown
// scenes that pair "what was taken" with "what the intel says."

import type { SceneModule } from '../../runtime/scene';
import {
  type TemplateDomElement,
  type TemplateDomFactory,
  buildTemplateScene,
  buildTemplateTimeline,
  mountTemplateRoot,
} from './_shared';

export interface HaulRow {
  /** Lead number / count (e.g. `12,847`, `100%`). */
  readonly count: string;
  /** Label beneath the count. */
  readonly label: string;
  /** Optional modifier (`hot`, `cold`, etc.) for per-row tinting. */
  readonly mod?: string;
}

export interface CitationRow {
  readonly source: string;
  readonly quote: string;
}

export interface HaulCitationsContent {
  readonly eyebrow?: string;
  readonly headline?: string;
  readonly haul: readonly HaulRow[];
  readonly citations: { readonly title?: string; readonly rows: readonly CitationRow[] };
  /** Stagger between haul rows (ms). Default 180. */
  readonly staggerMs?: number;
}

export const haulCitations = (id: string, content: HaulCitationsContent): SceneModule =>
  buildTemplateScene({
    id,
    title: 'Haul + citations',
    captions: content.haul.map((r, i) => ({ at: `haul-${i}`, text: `${r.count} ${r.label}` })),
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'haul-citations',
        buildChildren: (root, ownerDoc) => {
          appendHeader(root, ownerDoc, content);
          const grid = ownerDoc.createElement('div');
          grid.setAttribute('class', 'hc__grid');
          grid.appendChild?.(buildHaul(ownerDoc, content.haul, content.staggerMs ?? 180));
          grid.appendChild?.(buildCitations(ownerDoc, content.citations));
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
          tl.addLabel('hc-in', 0);
          tl.to({}, { duration: 1.4 });
        },
      }),
  });

const appendHeader = (
  root: TemplateDomElement,
  ownerDoc: TemplateDomFactory,
  content: HaulCitationsContent,
): void => {
  if (content.eyebrow === undefined && content.headline === undefined) return;
  const head = ownerDoc.createElement('header');
  head.setAttribute('class', 'hc__head');
  if (content.eyebrow !== undefined) {
    const eb = ownerDoc.createElement('p');
    eb.setAttribute('class', 'hc__eyebrow');
    eb.textContent = content.eyebrow;
    head.appendChild?.(eb);
  }
  if (content.headline !== undefined) {
    const h = ownerDoc.createElement('h2');
    h.setAttribute('class', 'hc__headline');
    h.textContent = content.headline;
    head.appendChild?.(h);
  }
  root.appendChild?.(head);
};

const buildHaul = (
  ownerDoc: TemplateDomFactory,
  rows: readonly HaulRow[],
  stagger: number,
): TemplateDomElement => {
  const haul = ownerDoc.createElement('ul');
  haul.setAttribute('class', 'hc__haul');
  rows.forEach((row, i) => haul.appendChild?.(buildHaulRow(ownerDoc, row, i, stagger)));
  return haul;
};

const buildHaulRow = (
  ownerDoc: TemplateDomFactory,
  row: HaulRow,
  i: number,
  stagger: number,
): TemplateDomElement => {
  const li = ownerDoc.createElement('li');
  const mod = row.mod === undefined ? '' : ` hc__row--${row.mod}`;
  li.setAttribute('class', `hc__row${mod}`);
  li.setAttribute('style', `--row-delay: ${i * stagger}ms`);
  const c = ownerDoc.createElement('span');
  c.setAttribute('class', 'hc__count');
  c.textContent = row.count;
  li.appendChild?.(c);
  const l = ownerDoc.createElement('span');
  l.setAttribute('class', 'hc__label');
  l.textContent = row.label;
  li.appendChild?.(l);
  return li;
};

const buildCitations = (
  ownerDoc: TemplateDomFactory,
  citations: HaulCitationsContent['citations'],
): TemplateDomElement => {
  const cits = ownerDoc.createElement('aside');
  cits.setAttribute('class', 'hc__citations');
  if (citations.title !== undefined) {
    const ct = ownerDoc.createElement('h3');
    ct.setAttribute('class', 'hc__citations-title');
    ct.textContent = citations.title;
    cits.appendChild?.(ct);
  }
  for (const cit of citations.rows) {
    const item = ownerDoc.createElement('blockquote');
    item.setAttribute('class', 'hc__citation');
    const q = ownerDoc.createElement('p');
    q.textContent = cit.quote;
    item.appendChild?.(q);
    const src = ownerDoc.createElement('cite');
    src.textContent = cit.source;
    item.appendChild?.(src);
    cits.appendChild?.(item);
  }
  return cits;
};
