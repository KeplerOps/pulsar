// Pulsar L2 template — cardCarousel.
//
// A series of cards that auto-advance with a per-card dwell. Each
// card has a headline + optional sub + optional source mark. Used by
// "news cycle" / "headlines rolling" scenes.

import type { SceneModule } from '../../runtime/scene';
import { aSleep } from '../helpers';
import {
  buildTemplateScene,
  buildTemplateTimeline,
  findTemplateRoot,
  isTemplateCtx,
  mountTemplateRoot,
} from './_shared';

export interface CarouselCard {
  readonly headline: string;
  readonly sub?: string;
  readonly src?: string;
  /** Per-card dwell override (ms). */
  readonly dwellMs?: number;
}

export interface CardCarouselContent {
  readonly cards: readonly CarouselCard[];
  readonly dwellMs?: number;
  readonly eyebrow?: string;
}

const sessions = new Map<string, { abortedFlag: { aborted: boolean } }>();

export const cardCarousel = (id: string, content: CardCarouselContent): SceneModule =>
  buildTemplateScene({
    id,
    title: 'Card carousel',
    captions: content.cards.map((c, i) => ({ at: `card-${i}`, text: c.headline })),
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'card-carousel',
        buildChildren: (root, ownerDoc) => {
          if (content.eyebrow !== undefined) {
            const eb = ownerDoc.createElement('p');
            eb.setAttribute('class', 'cc__eyebrow');
            eb.textContent = content.eyebrow;
            root.appendChild?.(eb);
          }
          const stage = ownerDoc.createElement('div');
          stage.setAttribute('class', 'cc__stage');
          stage.setAttribute('data-cc-stage', '');
          root.appendChild?.(stage);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.4,
        buildSegments: (innerTl) => {
          innerTl.addLabel('cc-in', 0);
          // Gate carousel playback so the cards don't auto-advance
          // while the scene is still inactive in the composition.
          innerTl.call(() => {
            if (isTemplateCtx(ctx) && ctx.stage !== null) play(id, ctx, content);
          });
          const totalMs = content.cards.reduce(
            (sum, c) => sum + (c.dwellMs ?? content.dwellMs ?? 5000),
            0,
          );
          innerTl.to({}, { duration: Math.max(1, totalMs / 1000) });
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

const play = (id: string, ctx: unknown, content: CardCarouselContent): void => {
  if (!isTemplateCtx(ctx) || ctx.stage === null) return;
  const root = findTemplateRoot(ctx, id) as { querySelector?: (s: string) => unknown } | null;
  if (root === null || typeof root.querySelector !== 'function') return;
  const stage = root.querySelector('[data-cc-stage]') as HTMLElement | null;
  if (stage === null) return;
  const ownerDoc = stage.ownerDocument;
  if (ownerDoc === null) return;
  const session = { abortedFlag: { aborted: false } };
  sessions.set(id, session);
  void (async (): Promise<void> => {
    for (const card of content.cards) {
      if (session.abortedFlag.aborted) return;
      stage.innerHTML = '';
      const wrap = ownerDoc.createElement('article');
      wrap.className = 'cc__card cc__card--enter';
      const h = ownerDoc.createElement('h2');
      h.className = 'cc__headline';
      h.textContent = card.headline;
      wrap.appendChild(h);
      if (card.sub !== undefined) {
        const s = ownerDoc.createElement('p');
        s.className = 'cc__sub';
        s.textContent = card.sub;
        wrap.appendChild(s);
      }
      if (card.src !== undefined) {
        const sr = ownerDoc.createElement('p');
        sr.className = 'cc__src';
        sr.textContent = card.src;
        wrap.appendChild(sr);
      }
      stage.appendChild(wrap);
      await aSleep(card.dwellMs ?? content.dwellMs ?? 5000);
    }
  })();
};
