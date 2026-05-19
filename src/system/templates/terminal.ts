// Pulsar L2 template — terminal.
//
// Please-hack-style scripted terminal. Each script step is one of:
//   { t: 'user',   text }          → user prompt line, typed
//   { t: 'agent',  text }          → agent response line, typed
//   { t: 'tool',   text }          → tool invocation line, typed
//   { t: 'output', text }          → static output line, no typing
//   { t: 'wait',   ms }            → dwell with no output
//   { t: 'popout', text }          → centered popout punch (no terminal line)
//
// Uses `typeNode` from helpers for per-character reveal with
// `[[glow]]` markers. Lines are appended to the terminal element
// inside the scene root.

import type { SceneModule } from '../../runtime/scene';
import { aSleep, markedTextHtml, schedule, typeNode } from '../helpers';
import {
  buildTemplateScene,
  buildTemplateTimeline,
  findTemplateRoot,
  isTemplateCtx,
  mountTemplateRoot,
} from './_shared';

export type TerminalStep =
  | { readonly t: 'user'; readonly text: string }
  | { readonly t: 'agent'; readonly text: string }
  | { readonly t: 'tool'; readonly text: string }
  | { readonly t: 'output'; readonly text: string }
  | { readonly t: 'wait'; readonly ms: number }
  | { readonly t: 'popout'; readonly text: string };

export interface TerminalContent {
  readonly script: readonly TerminalStep[];
  /** Base typing delay per char (ms). Defaults to 24. */
  readonly typeBaseMs?: number;
}

export const terminal = (id: string, content: TerminalContent): SceneModule => {
  return buildTemplateScene({
    id,
    title: 'Terminal',
    captions: content.script
      .filter(
        (s): s is { readonly t: 'user' | 'agent' | 'tool' | 'output'; readonly text: string } =>
          s.t === 'user' || s.t === 'agent' || s.t === 'tool' || s.t === 'output',
      )
      .map((s, i) => ({ at: `term-${i}`, text: s.text })),
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'terminal',
        buildChildren: (root, ownerDoc) => {
          const pre = ownerDoc.createElement('pre');
          pre.setAttribute('class', 'term');
          root.appendChild?.(pre);
        },
      });
      // The actual script playback happens in timeline(); the create
      // hook just mounts the empty terminal frame.
    },
    timeline: (ctx) => {
      // Don't use the standard buildTemplateTimeline — we need to
      // play the script asynchronously after activation. Build a
      // minimal timeline that flips activation, then run the script
      // off-timeline using helpers + setTimeout. The trailing tween's
      // onComplete deactivates.
      const tl = buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 0.8,
        buildSegments: (innerTl) => {
          innerTl.addLabel('term-start', 0);
          innerTl.to({}, { duration: 1 });
        },
      });
      // Drive the script outside the timeline so type-on speeds stay
      // independent of master playback. Cleanup is via the abort
      // signal — handled implicitly when the scene root is removed.
      if (isTemplateCtx(ctx) && ctx.stage !== null) {
        playScript(id, ctx, content);
      }
      return tl;
    },
  });
};

interface TerminalDomRefs {
  readonly root: { appendChild: (n: unknown) => unknown };
  readonly term: { appendChild: (n: unknown) => unknown };
  readonly ownerDoc: Document;
}

const resolveTerminalDom = (id: string, ctx: unknown): TerminalDomRefs | null => {
  if (!isTemplateCtx(ctx) || ctx.stage === null) return null;
  const root = findTemplateRoot(ctx, id) as {
    querySelector?: (sel: string) => unknown;
    appendChild?: (n: unknown) => unknown;
  } | null;
  if (root === null || typeof root.querySelector !== 'function') return null;
  if (typeof root.appendChild !== 'function') return null;
  const term = root.querySelector('.term') as {
    ownerDocument?: Document | null;
    appendChild?: (el: unknown) => unknown;
  } | null;
  if (term === null || typeof term.appendChild !== 'function') return null;
  const ownerDoc = term.ownerDocument ?? null;
  if (ownerDoc === null) return null;
  return {
    root: root as { appendChild: (n: unknown) => unknown },
    term: term as { appendChild: (n: unknown) => unknown },
    ownerDoc,
  };
};

const runStep = async (refs: TerminalDomRefs, step: TerminalStep, base: number): Promise<void> => {
  if (step.t === 'wait') {
    await aSleep(step.ms);
    return;
  }
  if (step.t === 'popout') {
    const wrap = refs.ownerDoc.createElement('div');
    wrap.className = 'ph-popout';
    const txt = refs.ownerDoc.createElement('div');
    txt.className = 'ph-popout__text';
    txt.textContent = step.text;
    wrap.appendChild(txt);
    refs.root.appendChild(wrap);
    schedule(() => wrap.remove(), 2600);
    await aSleep(900);
    return;
  }
  const line = refs.ownerDoc.createElement('span');
  line.className = `ph-line ph-line--${step.t}`;
  refs.term.appendChild(line);
  if (step.t === 'output') {
    // Strip `[[...]]` markers + glow the wrapped chars, mirroring
    // typeNode's per-char span treatment so output and typed lines
    // share the same accent styling.
    line.innerHTML = markedTextHtml(step.text);
  } else {
    await typeNode(line, step.text, { base });
  }
  await aSleep(160);
};

const playScript = (id: string, ctx: unknown, content: TerminalContent): void => {
  const refs = resolveTerminalDom(id, ctx);
  if (refs === null) return;
  const base = content.typeBaseMs ?? 24;
  void (async (): Promise<void> => {
    for (const step of content.script) {
      await runStep(refs, step, base);
    }
  })();
};
