// Pulsar L2 template — chatPickList.
//
// Header chat-bubble prompt followed by a list of pickable items.
// One item is the "pick" — it highlights after a delay, while the
// others dim. Used by target-selection / hostage-shortlist scenes
// where an agent presents options and then commits to one.

import type { SceneModule } from '../../runtime/scene';
import { aSleep } from '../helpers';
import {
  buildTemplateScene,
  buildTemplateTimeline,
  findTemplateRoot,
  isTemplateCtx,
  mountTemplateRoot,
} from './_shared';

export interface PickItem {
  readonly label: string;
  readonly sub?: string;
}

export interface ChatPickListContent {
  /** Prompt bubble at the top. */
  readonly promptHandle?: string;
  readonly promptMessage: string;
  readonly items: readonly PickItem[];
  /** Zero-based index of the item to highlight as the pick. */
  readonly pickIndex: number;
  /** Stagger between items being listed (ms). Default 220. */
  readonly staggerMs?: number;
  /** Dwell after all items are listed before the pick highlights (ms). */
  readonly pickAfterMs?: number;
  /** Optional caption that appears beneath the pick when selected. */
  readonly pickCaption?: string;
}

const sessions = new Map<string, { abortedFlag: { aborted: boolean } }>();

export const chatPickList = (id: string, content: ChatPickListContent): SceneModule =>
  buildTemplateScene({
    id,
    title: 'Chat pick list',
    captions: [
      { at: 'prompt', text: content.promptMessage },
      ...content.items.map((it, i) => ({ at: `item-${i}`, text: it.label })),
    ],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'chat-pick-list',
        buildChildren: (root, ownerDoc) => {
          const prompt = ownerDoc.createElement('div');
          prompt.setAttribute('class', 'cpl__prompt');
          if (content.promptHandle !== undefined) {
            const h = ownerDoc.createElement('span');
            h.setAttribute('class', 'cpl__prompt-handle');
            h.textContent = content.promptHandle;
            prompt.appendChild?.(h);
          }
          const p = ownerDoc.createElement('p');
          p.setAttribute('class', 'cpl__prompt-text');
          p.textContent = content.promptMessage;
          prompt.appendChild?.(p);
          root.appendChild?.(prompt);
          const list = ownerDoc.createElement('ol');
          list.setAttribute('class', 'cpl__list');
          list.setAttribute('data-cpl-list', '');
          const stagger = content.staggerMs ?? 220;
          content.items.forEach((item, i) => {
            const li = ownerDoc.createElement('li');
            li.setAttribute('class', 'cpl__item');
            li.setAttribute('data-cpl-index', String(i));
            li.setAttribute('style', `--cpl-delay: ${i * stagger}ms`);
            const lab = ownerDoc.createElement('span');
            lab.setAttribute('class', 'cpl__label');
            lab.textContent = item.label;
            li.appendChild?.(lab);
            if (item.sub !== undefined) {
              const sub = ownerDoc.createElement('span');
              sub.setAttribute('class', 'cpl__sub');
              sub.textContent = item.sub;
              li.appendChild?.(sub);
            }
            list.appendChild?.(li);
          });
          root.appendChild?.(list);
          if (content.pickCaption !== undefined) {
            const cap = ownerDoc.createElement('p');
            cap.setAttribute('class', 'cpl__pick-caption');
            cap.setAttribute('data-cpl-caption', '');
            cap.setAttribute('style', 'opacity:0');
            cap.textContent = content.pickCaption;
            root.appendChild?.(cap);
          }
        },
      });
    },
    timeline: (ctx) => {
      const tl = buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.4,
        buildSegments: (innerTl) => {
          innerTl.addLabel('cpl-in', 0);
          innerTl.to({}, { duration: 1.2 });
        },
      });
      if (isTemplateCtx(ctx) && ctx.stage !== null) play(id, ctx, content);
      return tl;
    },
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

const play = (id: string, ctx: unknown, content: ChatPickListContent): void => {
  if (!isTemplateCtx(ctx) || ctx.stage === null) return;
  const root = findTemplateRoot(ctx, id) as {
    querySelector?: (s: string) => unknown;
    querySelectorAll?: (s: string) => unknown;
  } | null;
  if (root === null || typeof root.querySelectorAll !== 'function') return;
  const itemsRaw = root.querySelectorAll('[data-cpl-index]');
  const items = (itemsRaw as unknown as { length: number; item(i: number): HTMLElement }) ?? null;
  if (items === null) return;
  const stagger = content.staggerMs ?? 220;
  const pickAfter = content.pickAfterMs ?? 600;
  const caption = root.querySelector?.('[data-cpl-caption]') as HTMLElement | null;
  const session = { abortedFlag: { aborted: false } };
  sessions.set(id, session);
  void (async (): Promise<void> => {
    const total = items.length;
    await aSleep(total * stagger);
    if (session.abortedFlag.aborted) return;
    await aSleep(pickAfter);
    if (session.abortedFlag.aborted) return;
    for (let i = 0; i < total; i += 1) {
      const el = items.item(i);
      if (i === content.pickIndex) {
        el.classList.add('cpl__item--pick');
      } else {
        el.classList.add('cpl__item--dim');
      }
    }
    if (caption !== null) {
      await aSleep(220);
      if (session.abortedFlag.aborted) return;
      caption.setAttribute('style', 'opacity:1');
      caption.classList.add('cpl__pick-caption--in');
    }
  })();
};
