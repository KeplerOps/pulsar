// Pulsar L2 template — splitDialogueEmail.
//
// Left: scripted dialogue (handle + text rows that reveal staggered).
// Right: an email card (from / to / subject / body lines). Used by
// phishing-scenario scenes where you need to show the planning chat
// alongside the email it produced.

import type { SceneModule } from '../../runtime/scene';
import { aSleep, markedTextHtml, typeNode } from '../helpers';
import {
  buildTemplateScene,
  buildTemplateTimeline,
  findTemplateRoot,
  mountTemplateRoot,
} from './_shared';

export interface DialogueLine {
  readonly handle: string;
  readonly text: string;
  readonly afterMs?: number;
  readonly base?: number;
}

export interface EmailSpec {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  /** Body paragraphs. Each string is one paragraph; `[[ ]]` markers glow red. */
  readonly bodyParagraphs: readonly string[];
  readonly signoff?: string;
  /** Optional footer text under the email body (e.g. timestamp). */
  readonly footer?: string;
}

export interface SplitDialogueEmailContent {
  readonly eyebrow?: string;
  readonly headline?: string;
  readonly dialogue: readonly DialogueLine[];
  readonly email: EmailSpec;
  readonly typeBaseMs?: number;
  /** Dwell after the dialogue completes before the email fades in (ms). */
  readonly emailRevealAfterMs?: number;
}

const sessions = new Map<string, { abortedFlag: { aborted: boolean } }>();

export const splitDialogueEmail = (id: string, content: SplitDialogueEmailContent): SceneModule =>
  buildTemplateScene({
    id,
    title: 'Split dialogue + email',
    captions: content.dialogue.map((d, i) => ({ at: `line-${i}`, text: `${d.handle}: ${d.text}` })),
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'split-dialogue-email',
        buildChildren: (root, ownerDoc) => {
          appendHeader(root, ownerDoc, content);
          const grid = ownerDoc.createElement('div');
          grid.setAttribute('class', 'sde__grid');
          const dialogue = ownerDoc.createElement('ol');
          dialogue.setAttribute('class', 'sde__dialogue');
          dialogue.dataset.sdeDialogue = '';
          grid.appendChild(dialogue);
          grid.appendChild(buildEmail(ownerDoc, content.email));
          root.appendChild(grid);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.6,
        buildSegments: (innerTl) => {
          innerTl.addLabel('sde-in', 0);
          innerTl.call(() => play(id, ctx, content));
          innerTl.to({}, { duration: 1 });
        },
      }),
    cleanup: (ctx) => {
      const s = sessions.get(id);
      if (s !== undefined) {
        s.abortedFlag.aborted = true;
        sessions.delete(id);
      }
      findTemplateRoot(ctx, id)?.remove();
    },
  });

const appendHeader = (
  root: HTMLElement,
  ownerDoc: Document,
  content: SplitDialogueEmailContent,
): void => {
  if (content.eyebrow === undefined && content.headline === undefined) return;
  const head = ownerDoc.createElement('header');
  head.setAttribute('class', 'sde__head');
  if (content.eyebrow !== undefined) {
    const eb = ownerDoc.createElement('p');
    eb.setAttribute('class', 'sde__eyebrow');
    eb.textContent = content.eyebrow;
    head.appendChild(eb);
  }
  if (content.headline !== undefined) {
    const h = ownerDoc.createElement('h2');
    h.setAttribute('class', 'sde__headline');
    h.textContent = content.headline;
    head.appendChild(h);
  }
  root.appendChild(head);
};

const buildEmail = (ownerDoc: Document, email: EmailSpec): HTMLElement => {
  const article = ownerDoc.createElement('article');
  article.setAttribute('class', 'sde__email');
  article.dataset.sdeEmail = '';
  article.setAttribute('style', 'opacity:0');
  article.appendChild(buildEmailMeta(ownerDoc, email));
  article.appendChild(buildEmailBody(ownerDoc, email));
  if (email.footer !== undefined) {
    const ft = ownerDoc.createElement('footer');
    ft.setAttribute('class', 'sde__email-footer');
    ft.textContent = email.footer;
    article.appendChild(ft);
  }
  return article;
};

const buildEmailMeta = (ownerDoc: Document, email: EmailSpec): HTMLElement => {
  const meta = ownerDoc.createElement('header');
  meta.setAttribute('class', 'sde__email-meta');
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['From', email.from],
    ['To', email.to],
    ['Subject', email.subject],
  ];
  for (const [label, value] of rows) {
    const row = ownerDoc.createElement('p');
    row.setAttribute('class', 'sde__email-row');
    const k = ownerDoc.createElement('span');
    k.setAttribute('class', 'sde__email-k');
    k.textContent = `${label}:`;
    const v = ownerDoc.createElement('span');
    v.setAttribute('class', 'sde__email-v');
    v.textContent = value;
    row.appendChild(k);
    row.appendChild(v);
    meta.appendChild(row);
  }
  return meta;
};

const buildEmailBody = (ownerDoc: Document, email: EmailSpec): HTMLElement => {
  const body = ownerDoc.createElement('div');
  body.setAttribute('class', 'sde__email-body');
  for (const para of email.bodyParagraphs) {
    const p = ownerDoc.createElement('p');
    p.innerHTML = markedTextHtml(para);
    body.appendChild(p);
  }
  if (email.signoff !== undefined) {
    const so = ownerDoc.createElement('p');
    so.setAttribute('class', 'sde__email-signoff');
    so.innerHTML = markedTextHtml(email.signoff);
    body.appendChild(so);
  }
  return body;
};

const play = (id: string, ctx: unknown, content: SplitDialogueEmailContent): void => {
  const root = findTemplateRoot(ctx, id);
  if (root === null) return;
  const dialogue = root.querySelector<HTMLElement>('[data-sde-dialogue]');
  const email = root.querySelector<HTMLElement>('[data-sde-email]');
  if (dialogue === null || email === null) return;
  const ownerDoc = dialogue.ownerDocument;
  const baseDefault = content.typeBaseMs ?? 22;
  const session = { abortedFlag: { aborted: false } };
  sessions.set(id, session);
  void (async (): Promise<void> => {
    for (const line of content.dialogue) {
      if (session.abortedFlag.aborted) return;
      const li = ownerDoc.createElement('li');
      li.className = 'sde__line';
      const handle = ownerDoc.createElement('span');
      handle.className = 'sde__handle';
      handle.textContent = line.handle;
      li.appendChild(handle);
      const text = ownerDoc.createElement('span');
      text.className = 'sde__text';
      li.appendChild(text);
      dialogue.appendChild(li);
      await typeNode(text, line.text, { base: line.base ?? baseDefault });
      if (line.afterMs !== undefined) await aSleep(line.afterMs);
    }
    await aSleep(content.emailRevealAfterMs ?? 400);
    if (session.abortedFlag.aborted) return;
    email.classList.add('sde__email--in');
    email.setAttribute('style', 'opacity:1');
  })();
};
