// Pulsar L2 template — splitPaneTerminalDoc.
//
// Split-pane: scripted terminal on the left, canted/document image
// on the right. The terminal types its script (via `typeNode` so
// `[[ ]]` markers glow red), the right panel cross-fades in once
// the terminal is rolling. Used by chatbot-recreation scenes where
// the audience needs to read the agent transcript while seeing the
// source document the agent referenced.

import type { SceneModule } from '../../runtime/scene';
import { aSleep, typeNode } from '../helpers';
import {
  buildTemplateScene,
  buildTemplateTimeline,
  findTemplateRoot,
  isTemplateCtx,
  mountTemplateRoot,
} from './_shared';

export interface SplitTerminalLine {
  /** Role marker — drives the `.ph-line--<role>` CSS class. */
  readonly role: 'user' | 'agent' | 'tool' | 'output';
  readonly text: string;
  /** Per-line type-base override (ms/char). */
  readonly base?: number;
  /** Optional dwell after this line before the next types. */
  readonly afterMs?: number;
}

export interface SplitDocSpec {
  readonly imgSrc: string;
  readonly imgAlt?: string;
  /** Optional caption beneath the doc. */
  readonly caption?: string;
  /** Degrees of cant (rotation), default 0. */
  readonly cantDegrees?: number;
}

export interface SplitPaneTerminalDocContent {
  readonly leftScript: readonly SplitTerminalLine[];
  readonly rightDoc: SplitDocSpec;
  readonly typeBaseMs?: number;
  /** Optional eyebrow line above the panes. */
  readonly eyebrow?: string;
  /** Optional headline above the panes. */
  readonly headline?: string;
}

interface SessionRefs {
  abortedFlag: { aborted: boolean };
}

const sessions = new Map<string, SessionRefs>();

export const splitPaneTerminalDoc = (
  id: string,
  content: SplitPaneTerminalDocContent,
): SceneModule =>
  buildTemplateScene({
    id,
    title: 'Split-pane terminal + doc',
    assets: [content.rightDoc.imgSrc],
    captions: content.leftScript.map((l, i) => ({ at: `line-${i}`, text: l.text })),
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'split-pane-terminal-doc',
        buildChildren: (root, ownerDoc) => {
          if (content.eyebrow !== undefined || content.headline !== undefined) {
            const head = ownerDoc.createElement('header');
            head.setAttribute('class', 'splitpane__head');
            if (content.eyebrow !== undefined) {
              const eb = ownerDoc.createElement('p');
              eb.setAttribute('class', 'splitpane__eyebrow');
              eb.textContent = content.eyebrow;
              head.appendChild?.(eb);
            }
            if (content.headline !== undefined) {
              const h = ownerDoc.createElement('h2');
              h.setAttribute('class', 'splitpane__headline');
              h.textContent = content.headline;
              head.appendChild?.(h);
            }
            root.appendChild?.(head);
          }
          const panes = ownerDoc.createElement('div');
          panes.setAttribute('class', 'splitpane__grid');
          const left = ownerDoc.createElement('pre');
          left.setAttribute('class', 'splitpane__terminal term');
          panes.appendChild?.(left);
          const right = ownerDoc.createElement('figure');
          right.setAttribute('class', 'splitpane__doc');
          if (content.rightDoc.cantDegrees !== undefined) {
            right.setAttribute('style', `transform: rotate(${content.rightDoc.cantDegrees}deg)`);
          }
          const img = ownerDoc.createElement('img');
          img.setAttribute('src', content.rightDoc.imgSrc);
          if (content.rightDoc.imgAlt !== undefined) img.setAttribute('alt', content.rightDoc.imgAlt);
          right.appendChild?.(img);
          if (content.rightDoc.caption !== undefined) {
            const cap = ownerDoc.createElement('figcaption');
            cap.textContent = content.rightDoc.caption;
            right.appendChild?.(cap);
          }
          panes.appendChild?.(right);
          root.appendChild?.(panes);
        },
      });
    },
    timeline: (ctx) => {
      const tl = buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.2,
        buildSegments: (innerTl) => {
          innerTl.addLabel('panes-in', 0);
          innerTl.to({}, { duration: 1 });
        },
      });
      if (isTemplateCtx(ctx) && ctx.stage !== null) playScript(id, ctx, content);
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

const playScript = (id: string, ctx: unknown, content: SplitPaneTerminalDocContent): void => {
  if (!isTemplateCtx(ctx) || ctx.stage === null) return;
  const root = findTemplateRoot(ctx, id) as { querySelector?: (s: string) => unknown } | null;
  if (root === null || typeof root.querySelector !== 'function') return;
  const term = root.querySelector('.splitpane__terminal') as HTMLElement | null;
  if (term === null) return;
  const ownerDoc = term.ownerDocument;
  if (ownerDoc === null) return;
  const baseDefault = content.typeBaseMs ?? 24;
  const session: SessionRefs = { abortedFlag: { aborted: false } };
  sessions.set(id, session);
  void (async (): Promise<void> => {
    for (const line of content.leftScript) {
      if (session.abortedFlag.aborted) break;
      const el = ownerDoc.createElement('span');
      el.className = `ph-line ph-line--${line.role}`;
      term.appendChild(el);
      await typeNode(el, line.text, { base: line.base ?? baseDefault });
      if (line.afterMs !== undefined) await aSleep(line.afterMs);
    }
  })();
};
