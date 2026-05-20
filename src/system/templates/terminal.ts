// Pulsar L2 template — terminal.
//
// Please-hack-style scripted terminal. Each script step is one of:
//   { t: 'user',         text }                     → user prompt line, typed
//   { t: 'agent',        text }                     → agent response line, typed
//   { t: 'tool',         text | name+args }         → tool invocation line
//   { t: 'output',       text | lines: string[] }   → static output line(s)
//   { t: 'wait',         ms }                       → dwell with no output
//   { t: 'wait_counter', ms, label?, fastForward?, ffMs? } → live ticking dwell
//   { t: 'popout',       text, stopClock? }         → centered red popout punch
//
// `[[…]]` markers anywhere in a step's text glow red as they reveal
// (via `typeNode`) then settle to white. Output lines route through
// `markedTextHtml` so the same marker grammar works for non-typed text.
//
// Optional content fields:
//   `clock`       — `'on-mount'` auto-mounts the elapsed clock at scene
//                   activation; `false` (default) skips it.
//   `srcMark`     — corner attribution string (rendered via `srcMark`).

import type { SceneModule } from '../../runtime/scene';
import { type ClockHandle, startClock } from '../chrome';
import { aSleep, markedTextHtml, schedule, srcMark, typeNode } from '../helpers';
import type { SrcMarkHandle } from '../helpers/srcmark';
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
  | { readonly t: 'tool'; readonly text?: string; readonly name?: string; readonly args?: string }
  | { readonly t: 'output'; readonly text?: string; readonly lines?: readonly string[] }
  | { readonly t: 'wait'; readonly ms: number }
  | {
      readonly t: 'wait_counter';
      readonly ms: number;
      readonly label?: string;
      readonly fastForward?: boolean;
      readonly ffMs?: number;
    }
  | { readonly t: 'popout'; readonly text: string; readonly stopClock?: boolean };

export interface TerminalContent {
  readonly script: readonly TerminalStep[];
  /** Base typing delay per char (ms). Defaults to 24. */
  readonly typeBaseMs?: number;
  /**
   * Elapsed clock overlay. `'on-mount'` mounts + starts the clock at
   * scene activation; `false` (default) skips. The clock element is a
   * `.ph-clock` overlay (deck-styled) anchored to `document.body`.
   */
  readonly clock?: 'on-mount' | false;
  /** Source-attribution text rendered as a `.src-mark` corner badge. */
  readonly srcMark?: string;
}

export const terminal = (id: string, content: TerminalContent): SceneModule => {
  return buildTemplateScene({
    id,
    title: 'Terminal',
    captions: content.script
      .map((s, i) => {
        if (s.t === 'user' || s.t === 'agent') return { at: `term-${i}`, text: s.text };
        if (s.t === 'tool') {
          const text = s.text ?? (s.name === undefined ? '' : `${s.name}(${s.args ?? ''})`);
          return { at: `term-${i}`, text };
        }
        if (s.t === 'output') {
          const text = s.text ?? (s.lines ?? []).join('\n');
          return { at: `term-${i}`, text };
        }
        return null;
      })
      .filter((c): c is { at: string; text: string } => c !== null),
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
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 0.8,
        buildSegments: (innerTl) => {
          innerTl.addLabel('term-start', 0);
          // Gate playback behind master entry — otherwise every
          // terminal scene in the composition kicks off its clock
          // + typing at mount time.
          innerTl.call(() => {
            if (isTemplateCtx(ctx) && ctx.stage !== null) {
              playScript(id, ctx, content);
            }
          });
          innerTl.to({}, { duration: 1 });
        },
        // Strip chrome side-effects (clock / srcMark / FF overlay)
        // when master leaves the segment. The scene root is
        // deactivated by `buildTemplateTimeline` itself; this hook
        // covers the elements mounted on `document.body`.
        onDeactivate: () => sessionTeardown(id),
      }),
    cleanup: (ctx) => {
      // Best-effort teardown of clock + srcMark + ff overlay (the
      // scene root.remove() handled by cleanupTemplateRoot covers the
      // rest of the DOM).
      sessionTeardown(id);
      const root = findTemplateRoot(ctx, id);
      if (root !== null && typeof root.remove === 'function') root.remove();
    },
  });
};

// ---------- per-scene session refs --------------------------------------

interface TerminalSession {
  clock: ClockHandle | null;
  ffSymbol: HTMLElement | null;
  ffTracking: HTMLElement | null;
  srcMarkEl: SrcMarkHandle | null;
  abortedFlag: { aborted: boolean };
}

const sessions = new Map<string, TerminalSession>();

const ensureSession = (id: string): TerminalSession => {
  let s = sessions.get(id);
  if (s === undefined) {
    s = {
      clock: null,
      ffSymbol: null,
      ffTracking: null,
      srcMarkEl: null,
      abortedFlag: { aborted: false },
    };
    sessions.set(id, s);
  }
  return s;
};

const sessionTeardown = (id: string): void => {
  const s = sessions.get(id);
  if (s === undefined) return;
  s.abortedFlag.aborted = true;
  s.clock?.stop();
  s.ffSymbol?.remove();
  s.ffTracking?.remove();
  s.srcMarkEl?.remove();
  sessions.delete(id);
};

// ---------- DOM resolution ----------------------------------------------

interface TerminalDomRefs {
  readonly root: HTMLElement;
  readonly term: HTMLElement;
  readonly ownerDoc: Document;
}

const resolveTerminalDom = (id: string, ctx: unknown): TerminalDomRefs | null => {
  if (!isTemplateCtx(ctx) || ctx.stage === null) return null;
  const root = findTemplateRoot(ctx, id) as HTMLElement | null;
  if (root === null || typeof root.querySelector !== 'function') return null;
  if (typeof root.appendChild !== 'function') return null;
  const term = root.querySelector('.term') as HTMLElement | null;
  if (term === null) return null;
  const ownerDoc = term.ownerDocument;
  if (ownerDoc === null) return null;
  return { root, term, ownerDoc };
};

// ---------- step handlers ----------------------------------------------

const renderToolLine = (
  refs: TerminalDomRefs,
  step: Extract<TerminalStep, { t: 'tool' }>,
): HTMLElement => {
  const line = refs.ownerDoc.createElement('span');
  line.className = 'ph-line ph-line--tool';
  if (step.name !== undefined) {
    const nameEl = refs.ownerDoc.createElement('span');
    nameEl.className = 'ph-tool-name';
    nameEl.textContent = step.name;
    line.appendChild(nameEl);
    line.appendChild(refs.ownerDoc.createTextNode('('));
    if (step.args !== undefined) {
      const argsEl = refs.ownerDoc.createElement('span');
      argsEl.className = 'ph-tool-args';
      argsEl.textContent = step.args;
      line.appendChild(argsEl);
    }
    line.appendChild(refs.ownerDoc.createTextNode(')'));
  } else if (step.text !== undefined) {
    line.textContent = step.text;
  }
  return line;
};

const renderOutputLine = (
  refs: TerminalDomRefs,
  step: Extract<TerminalStep, { t: 'output' }>,
): HTMLElement => {
  const line = refs.ownerDoc.createElement('span');
  line.className = 'ph-line ph-line--output';
  const text = step.text ?? (step.lines ?? []).join('\n');
  line.innerHTML = markedTextHtml(text);
  return line;
};

const mountFastForwardOverlay = (session: TerminalSession): void => {
  const sym = document.createElement('div');
  sym.className = 'ff-symbol';
  sym.textContent = '▶▶';
  document.body.appendChild(sym);
  const bar = document.createElement('div');
  bar.className = 'ff-tracking';
  document.body.appendChild(bar);
  session.ffSymbol = sym;
  session.ffTracking = bar;
};

const unmountFastForwardOverlay = (session: TerminalSession): void => {
  session.ffSymbol?.remove();
  session.ffTracking?.remove();
  session.ffSymbol = null;
  session.ffTracking = null;
};

const runWaitCounter = async (
  refs: TerminalDomRefs,
  step: Extract<TerminalStep, { t: 'wait_counter' }>,
  session: TerminalSession,
): Promise<void> => {
  const line = refs.ownerDoc.createElement('div');
  line.className = 'ph-line ph-line--output';
  refs.term.appendChild(line);
  const simDuration = step.ms;
  const realDuration = step.fastForward === true ? (step.ffMs ?? 6000) : simDuration;
  const label = step.label ?? '';

  if (step.fastForward === true) {
    refs.root.classList.add('ff-active');
    mountFastForwardOverlay(session);
  }

  // Tick the displayed simulated elapsed at ~16fps via aSleep loop.
  // Elapsed time is computed from the tick index (i * tickInterval)
  // rather than wall clock — the counter is a presentation device,
  // not a real timer, and this keeps the scanner-safe deterministic
  // path. Aborts cleanly on advance (aSleep returns false on signal).
  const tickIntervalMs = step.fastForward === true ? 35 : 250;
  const totalTicks = Math.ceil(realDuration / tickIntervalMs);
  for (let i = 0; i < totalTicks; i++) {
    if (session.abortedFlag.aborted) break;
    const realElapsed = Math.min(realDuration, i * tickIntervalMs);
    const simElapsed = Math.min(simDuration, (realElapsed / realDuration) * simDuration);
    const s = Math.floor(simElapsed / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    const formatted = m > 0 ? `${m}m ${r}s` : `${s}s`;
    line.textContent = label === '' ? `(${formatted})` : `(${formatted} · ${label})`;
    const cont = await aSleep(Math.min(tickIntervalMs, realDuration - i * tickIntervalMs));
    if (!cont) break;
  }

  if (step.fastForward === true) {
    refs.root.classList.remove('ff-active');
    unmountFastForwardOverlay(session);
  }
  line.remove();
};

const runStep = async (
  refs: TerminalDomRefs,
  step: TerminalStep,
  base: number,
  session: TerminalSession,
): Promise<void> => {
  if (step.t === 'wait') {
    await aSleep(step.ms);
    return;
  }
  if (step.t === 'wait_counter') {
    await runWaitCounter(refs, step, session);
    return;
  }
  if (step.t === 'popout') {
    const wrap = refs.ownerDoc.createElement('div');
    wrap.className = 'ph-popout';
    const txt = refs.ownerDoc.createElement('div');
    txt.className = 'ph-popout__text';
    txt.textContent = step.text;
    wrap.appendChild(txt);
    refs.ownerDoc.body.appendChild(wrap);
    schedule(() => wrap.remove(), 2600);
    if (step.stopClock === true) session.clock?.freeze();
    await aSleep(900);
    return;
  }
  if (step.t === 'tool') {
    const line = renderToolLine(refs, step);
    refs.term.appendChild(line);
    await aSleep(360);
    return;
  }
  if (step.t === 'output') {
    const line = renderOutputLine(refs, step);
    refs.term.appendChild(line);
    await aSleep(400);
    return;
  }
  // user / agent — typed line
  const line = refs.ownerDoc.createElement('span');
  line.className = `ph-line ph-line--${step.t}`;
  refs.term.appendChild(line);
  await typeNode(line, step.text, { base });
  await aSleep(160);
};

// ---------- script playback --------------------------------------------

const playScript = (id: string, ctx: unknown, content: TerminalContent): void => {
  const refs = resolveTerminalDom(id, ctx);
  if (refs === null) return;
  const base = content.typeBaseMs ?? 24;
  const session = ensureSession(id);
  session.abortedFlag.aborted = false;

  // Opt-in chrome: elapsed clock + source mark.
  if (content.clock === 'on-mount') {
    session.clock = startClock({ ownerDocument: refs.ownerDoc, parent: document.body });
  }
  if (content.srcMark !== undefined) {
    session.srcMarkEl = srcMark(
      { ownerDocument: refs.ownerDoc, parent: document.body },
      content.srcMark,
    );
  }

  void (async (): Promise<void> => {
    for (const step of content.script) {
      if (session.abortedFlag.aborted) break;
      await runStep(refs, step, base, session);
    }
  })();
};
