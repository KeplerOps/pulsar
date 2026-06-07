// Pulsar L2 — typing-animation helpers.
//
// `typeNode` reveals text character-by-character into a node, with
// optional `[[glow]]` red-marker phrases. Pre-renders each character
// as an opacity-0 `<span class="ph-char">` so the line's wrap points
// are locked before reveal — keeps the cursor from skipping mid-word
// as the line fills. Abortable via `AbortSignal` so a presenter
// pressing advance reveals the remaining text instantly.
//
// `typeInto` is the simpler textContent-slicing variant used by chat
// scenes where reflow is acceptable.
//
// `markedTextHtml` is the synchronous flavor: render `[[glow]]`
// markers as `<span class="glow">` HTML without animation. Used by
// templates that want the glow styling but not the typewriter reveal.

export interface TypeNodeOptions {
  /** Base delay between characters (ms). */
  readonly base?: number;
  /** Random jitter added on top of base (ms). */
  readonly jitter?: number;
  /** Optional abort signal — fires reveal-all and resolves on abort. */
  readonly signal?: AbortSignal;
}

/**
 * Reveal `text` into `node` character-by-character. Resolves when the
 * reveal completes naturally or when `signal` fires (in which case any
 * remaining characters are shown instantly so the line is not left
 * partially revealed). `[[...]]` marker pairs in the text wrap glowing
 * characters (`.glow` class); the markers themselves are stripped.
 *
 * The node must expose `appendChild`. Each character is rendered as a
 * `<span class="ph-char">` (or `ph-char glow`) so the layer's
 * `.show` styling can opacity-fade them individually.
 */
export const typeNode = (
  node: ParentNode,
  text: string,
  opts: TypeNodeOptions = {},
): Promise<void> => {
  const base = opts.base ?? 24;
  const jitter = opts.jitter ?? 14;
  const signal = opts.signal;
  const ownerDoc = (node as Element).ownerDocument;
  if (ownerDoc === null) return Promise.resolve();
  // Wipe existing content.
  (node as Element).textContent = '';
  const chars: HTMLElement[] = [];
  let glow = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' && text[i + 1] === '[') {
      glow = true;
      i++;
      continue;
    }
    if (text[i] === ']' && text[i + 1] === ']') {
      glow = false;
      i++;
      continue;
    }
    const span = ownerDoc.createElement('span');
    span.className = glow ? 'ph-char glow' : 'ph-char';
    span.textContent = text[i] as string;
    node.appendChild(span);
    chars.push(span);
  }
  return new Promise<void>((resolve) => {
    let j = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Reveal any remaining characters instantly on abort/end.
      for (let k = j; k < chars.length; k++) {
        (chars[k] as HTMLElement).classList.add('show');
      }
      resolve();
    };
    const onAbort = (): void => finish();
    if (signal?.aborted === true) {
      finish();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    const step = (): void => {
      if (done) return;
      if (j >= chars.length) {
        finish();
        return;
      }
      (chars[j] as HTMLElement).classList.add('show');
      j++;
      // Tiny linear-congruential offset for jitter — deterministic,
      // sourced from the character index so the sequence is stable
      // across reloads. Avoids `Math.random` (Q001 screenshot
      // nondeterminism) without losing the organic feel of variable
      // per-char delays.
      const tick = j;
      const offset = ((tick * 1103515245 + 12345) & 0x7fff) / 0x7fff; // 0..1, deterministic
      timer = setTimeout(step, base + offset * jitter); // PUL-Q001-allow: typewriter reveal; screenshot mode bypasses the scene lifecycle entirely so this helper never runs in a captured frame.
    };
    step();
  });
};

export interface TypeIntoOptions {
  readonly baseDelay?: number;
  readonly punctuationPauseMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Simpler typewriter: reveals `text` by slicing `el.textContent`. Used
 * for chat-bubble scenes where reflow on each character is acceptable
 * (and visually intended). Resolves on completion or abort.
 *
 * `punct` characters (`:` `—` `,` `.`) get an extra dwell so the line
 * has natural rhythm.
 */
export const typeInto = (
  el: { textContent: string | null },
  text: string,
  opts: TypeIntoOptions = {},
): Promise<void> => {
  const baseDelay = opts.baseDelay ?? 55;
  const punctMs = opts.punctuationPauseMs ?? 220;
  const signal = opts.signal;
  return new Promise<void>((resolve) => {
    let i = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Snap to full text on abort.
      el.textContent = text;
      resolve();
    };
    const onAbort = (): void => finish();
    if (signal?.aborted === true) {
      finish();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    const step = (): void => {
      if (done) return;
      if (i >= text.length) {
        finish();
        return;
      }
      el.textContent = text.slice(0, i + 1);
      i++;
      const last = text[i - 1] ?? '';
      const punct = /[:—,.]/.test(last) ? punctMs : 0;
      const tick = i;
      const offset = ((tick * 1103515245 + 12345) & 0x7fff) / 0x7fff; // 0..1, deterministic
      timer = setTimeout(step, baseDelay + offset * 38 + punct); // PUL-Q001-allow: typewriter chat reveal; screenshot mode bypasses the scene lifecycle entirely.
    };
    step();
  });
};

/**
 * Render `text` to HTML with `[[glow]]` markers converted to
 * `<span class="glow">…</span>`. Synchronous, no animation. Safe to
 * use as `innerHTML` because user text is escaped (`&`, `<`, `>`, `"`).
 */
export const markedTextHtml = (text: string): string => {
  const parts: string[] = [];
  let glow = false;
  let current = '';
  const escapeHtml = (value: string): string =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const flush = (): void => {
    if (current.length === 0) return;
    const safe = escapeHtml(current);
    parts.push(glow ? `<span class="glow">${safe}</span>` : safe);
    current = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' && text[i + 1] === '[') {
      flush();
      glow = true;
      i++;
      continue;
    }
    if (text[i] === ']' && text[i + 1] === ']') {
      flush();
      glow = false;
      i++;
      continue;
    }
    current += text[i];
  }
  flush();
  return parts.join('');
};
