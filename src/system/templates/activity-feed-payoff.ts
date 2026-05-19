// Pulsar L2 template — activityFeedPayoff.
//
// Two-phase reveal: a streaming agent-activity feed on the left
// (search / read / think entries with `[[ ]]` glow markers), then a
// payoff table on the right that fills in row by row once the feed
// completes. Used by OSINT-recon scenes that show an agent gathering
// info, then the synthesized dossier.

import type { SceneModule } from '../../runtime/scene';
import { aSleep, markedTextHtml, typeNode } from '../helpers';
import {
  buildTemplateScene,
  buildTemplateTimeline,
  findTemplateRoot,
  isTemplateCtx,
  mountTemplateRoot,
} from './_shared';

export interface ActivityEntry {
  /** Kind of activity — keys the `.feed__entry--<type>` class + icon. */
  readonly type: 'search' | 'read' | 'think';
  readonly text: string;
  /** Optional dwell after this entry in ms. */
  readonly afterMs?: number;
}

export interface PayoffRow {
  readonly label: string;
  readonly value: string;
}

export interface ActivityFeedPayoffContent {
  readonly eyebrow?: string;
  readonly headline?: string;
  readonly feed: readonly ActivityEntry[];
  readonly payoff: { readonly title?: string; readonly rows: readonly PayoffRow[] };
  readonly typeBaseMs?: number;
}

const sessions = new Map<string, { abortedFlag: { aborted: boolean } }>();

export const activityFeedPayoff = (id: string, content: ActivityFeedPayoffContent): SceneModule =>
  buildTemplateScene({
    id,
    title: 'Activity feed → payoff',
    captions: content.feed.map((e, i) => ({ at: `feed-${i}`, text: e.text })),
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'activity-feed-payoff',
        buildChildren: (root, ownerDoc) => {
          if (content.eyebrow !== undefined || content.headline !== undefined) {
            const head = ownerDoc.createElement('header');
            head.setAttribute('class', 'afp__head');
            if (content.eyebrow !== undefined) {
              const eb = ownerDoc.createElement('p');
              eb.setAttribute('class', 'afp__eyebrow');
              eb.textContent = content.eyebrow;
              head.appendChild?.(eb);
            }
            if (content.headline !== undefined) {
              const h = ownerDoc.createElement('h2');
              h.setAttribute('class', 'afp__headline');
              h.textContent = content.headline;
              head.appendChild?.(h);
            }
            root.appendChild?.(head);
          }
          const grid = ownerDoc.createElement('div');
          grid.setAttribute('class', 'afp__grid');
          const feed = ownerDoc.createElement('ol');
          feed.setAttribute('class', 'afp__feed');
          feed.setAttribute('data-afp-feed', '');
          grid.appendChild?.(feed);
          const payoff = ownerDoc.createElement('div');
          payoff.setAttribute('class', 'afp__payoff');
          if (content.payoff.title !== undefined) {
            const pt = ownerDoc.createElement('h3');
            pt.setAttribute('class', 'afp__payoff-title');
            pt.textContent = content.payoff.title;
            payoff.appendChild?.(pt);
          }
          const table = ownerDoc.createElement('dl');
          table.setAttribute('class', 'afp__payoff-table');
          table.setAttribute('data-afp-payoff', '');
          payoff.appendChild?.(table);
          grid.appendChild?.(payoff);
          root.appendChild?.(grid);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.4,
        buildSegments: (innerTl) => {
          innerTl.addLabel('afp-in', 0);
          innerTl.call(() => {
            if (isTemplateCtx(ctx) && ctx.stage !== null) play(id, ctx, content);
          });
          innerTl.to({}, { duration: 1 });
        },
      }),
    cleanup: (ctx) => {
      const s = sessions.get(id);
      if (s !== undefined) {
        s.abortedFlag.aborted = true;
        sessions.delete(id);
      }
      const root = findTemplateRoot(ctx, id);
      if (root !== null && typeof root.remove === 'function') root.remove();
    },
  });

const play = (id: string, ctx: unknown, content: ActivityFeedPayoffContent): void => {
  if (!isTemplateCtx(ctx) || ctx.stage === null) return;
  const root = findTemplateRoot(ctx, id) as { querySelector?: (s: string) => unknown } | null;
  if (root === null || typeof root.querySelector !== 'function') return;
  const feed = root.querySelector('[data-afp-feed]') as HTMLElement | null;
  const payoff = root.querySelector('[data-afp-payoff]') as HTMLElement | null;
  if (feed === null || payoff === null) return;
  const ownerDoc = feed.ownerDocument;
  if (ownerDoc === null) return;
  const base = content.typeBaseMs ?? 18;
  const session = { abortedFlag: { aborted: false } };
  sessions.set(id, session);
  void (async (): Promise<void> => {
    for (const entry of content.feed) {
      if (session.abortedFlag.aborted) return;
      const li = ownerDoc.createElement('li');
      li.className = `afp__entry afp__entry--${entry.type}`;
      feed.appendChild(li);
      await typeNode(li, entry.text, { base });
      await aSleep(entry.afterMs ?? 240);
    }
    // Payoff fills in after feed completes, row by row.
    for (const row of content.payoff.rows) {
      if (session.abortedFlag.aborted) return;
      const dt = ownerDoc.createElement('dt');
      dt.className = 'afp__payoff-key';
      dt.textContent = row.label;
      const dd = ownerDoc.createElement('dd');
      dd.className = 'afp__payoff-value';
      dd.innerHTML = markedTextHtml(row.value);
      payoff.appendChild(dt);
      payoff.appendChild(dd);
      await aSleep(180);
    }
  })();
};
