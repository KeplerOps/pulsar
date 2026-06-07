// Pulsar L2 — practice (speaker-notes) renderer.
//
// Renders the active scene's captions into the chrome lower-third slot,
// wrapped to ~60-char chunks and scrollable. Toggled via the workbench's
// `KeyN` binding; visibility is a state field on the returned handle.

import type { Caption } from '../../runtime/scene';

export interface PracticeRendererHost {
  /** The chrome `.pulsar-lower-third` slot (or any container element). */
  readonly target: HTMLElement;
}

export interface PracticeRendererHandle {
  /** Set the captions for the currently-addressed scene/slice. */
  render(captions: readonly Caption[]): void;
  /** Show the rendered notes. */
  show(): void;
  /** Hide the rendered notes. */
  hide(): void;
  /** Toggle show/hide; returns the new visibility state. */
  toggle(): boolean;
  /** Tear down — clears the slot and detaches event handlers. */
  dispose(): void;
}

/** Caption split into ~chunkSize-char windows for line-wrapped reading. */
export const splitCaptionText = (text: string, chunkSize = 60): readonly string[] => {
  if (text.length <= chunkSize) return [text];
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let current = '';
  for (const w of words) {
    const next = current.length === 0 ? w : `${current} ${w}`;
    if (next.length > chunkSize) {
      if (current.length > 0) chunks.push(current);
      current = w;
    } else {
      current = next;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

const formatCaption = (caption: Caption): string => {
  const at = typeof caption.at === 'string' ? caption.at : `${caption.at}ms`;
  return `[${at}] ${caption.text}`;
};

/** Build the practice renderer over a target chrome slot. */
export const createPracticeRenderer = (host: PracticeRendererHost): PracticeRendererHandle => {
  const { target } = host;
  let visible = false;
  let captions: readonly Caption[] = [];

  const repaint = (): void => {
    target.innerHTML = '';
    if (!visible || captions.length === 0) return;
    const doc = target.ownerDocument;
    const panel = doc.createElement('div');
    panel.className = 'pulsar-practice';
    panel.setAttribute(
      'style',
      'padding: 16px 24px; max-height: 35vh; overflow-y: auto; background: rgba(8,9,12,0.86); border-top: 1px solid var(--pulsar-color-fg-hair); font-family: var(--pulsar-type-mono); font-size: var(--pulsar-type-caption-size); color: var(--pulsar-color-fg-soft); line-height: 1.5;',
    );
    for (const c of captions) {
      const chunks = splitCaptionText(formatCaption(c));
      for (const chunk of chunks) {
        const line = doc.createElement('div');
        line.textContent = chunk;
        line.setAttribute('style', 'margin: 4px 0;');
        panel.appendChild(line);
      }
      const sep = doc.createElement('div');
      sep.setAttribute('style', 'height: 12px;');
      panel.appendChild(sep);
    }
    target.appendChild(panel);
  };

  return {
    render: (next) => {
      captions = next;
      if (visible) repaint();
    },
    show: () => {
      visible = true;
      repaint();
    },
    hide: () => {
      visible = false;
      repaint();
    },
    toggle: () => {
      visible = !visible;
      repaint();
      return visible;
    },
    dispose: () => {
      target.innerHTML = '';
    },
  };
};
