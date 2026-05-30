// Pulsar L2 template — chatTranscript.
//
// Scrolling message-by-message transcript (handle + text per row,
// staggered reveal). Optional `alert` flag highlights the row in red.
// Optional companion document image to the right of the transcript.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface ChatMessage {
  readonly handle: string;
  readonly text: string;
  readonly alert?: boolean;
  /** Optional dwell after this message before the next appears (ms). */
  readonly afterMs?: number;
}

export interface ChatDoc {
  readonly imgSrc: string;
  readonly imgAlt?: string;
  readonly caption?: string;
  /** Degrees of cant for the doc image (visual variety). */
  readonly cantDegrees?: number;
}

export interface ChatTranscriptContent {
  readonly title?: string;
  readonly messages: readonly ChatMessage[];
  readonly perBeatMs?: number;
  readonly doc?: ChatDoc;
}

export const chatTranscript = (id: string, content: ChatTranscriptContent): SceneModule =>
  buildTemplateScene({
    id,
    title: content.title ?? 'Chat transcript',
    assets: content.doc === undefined ? [] : [content.doc.imgSrc],
    captions: content.messages.map((m, i) => ({ at: `msg-${i}`, text: `${m.handle}: ${m.text}` })),
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'chat-transcript',
        buildChildren: (root, ownerDoc) => {
          const wrap = ownerDoc.createElement('div');
          wrap.setAttribute(
            'class',
            content.doc === undefined ? 'ct__grid' : 'ct__grid ct__grid--with-doc',
          );
          wrap.appendChild(buildFrame(ownerDoc, content));
          if (content.doc !== undefined) {
            wrap.appendChild(buildDoc(ownerDoc, content.doc));
          }
          root.appendChild(wrap);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.4,
        buildSegments: (tl) => {
          tl.addLabel('ct-in', 0);
          const totalMs = content.messages.length * (content.perBeatMs ?? 650);
          tl.to({}, { duration: Math.max(1, totalMs / 1000) });
        },
      }),
  });

const buildFrame = (ownerDoc: Document, content: ChatTranscriptContent): HTMLElement => {
  const frame = ownerDoc.createElement('div');
  frame.setAttribute('class', 'ct__frame');
  if (content.title !== undefined) {
    const t = ownerDoc.createElement('p');
    t.setAttribute('class', 'ct__title');
    t.textContent = content.title;
    frame.appendChild(t);
  }
  const list = ownerDoc.createElement('ol');
  list.setAttribute('class', 'ct__list');
  const stagger = content.perBeatMs ?? 650;
  content.messages.forEach((msg, i) => list.appendChild(buildMsg(ownerDoc, msg, i, stagger)));
  frame.appendChild(list);
  return frame;
};

const buildMsg = (
  ownerDoc: Document,
  msg: ChatMessage,
  i: number,
  stagger: number,
): HTMLElement => {
  const li = ownerDoc.createElement('li');
  li.setAttribute('class', `ct__msg${msg.alert === true ? ' ct__msg--alert' : ''}`);
  li.setAttribute('style', `--msg-delay: ${i * stagger}ms`);
  const handle = ownerDoc.createElement('span');
  handle.setAttribute('class', 'ct__handle');
  handle.textContent = msg.handle;
  li.appendChild(handle);
  const text = ownerDoc.createElement('span');
  text.setAttribute('class', 'ct__text');
  text.textContent = msg.text;
  li.appendChild(text);
  return li;
};

const buildDoc = (ownerDoc: Document, doc: ChatDoc): HTMLElement => {
  const fig = ownerDoc.createElement('figure');
  fig.setAttribute('class', 'ct__doc');
  if (doc.cantDegrees !== undefined) {
    fig.setAttribute('style', `transform: rotate(${doc.cantDegrees}deg)`);
  }
  const img = ownerDoc.createElement('img');
  img.setAttribute('src', doc.imgSrc);
  if (doc.imgAlt !== undefined) img.setAttribute('alt', doc.imgAlt);
  fig.appendChild(img);
  if (doc.caption !== undefined) {
    const cap = ownerDoc.createElement('figcaption');
    cap.textContent = doc.caption;
    fig.appendChild(cap);
  }
  return fig;
};
