// Pulsar L2 — practice + prompter renderer coverage tests.

import { describe, expect, it } from 'vitest';
import {
  createChromePrompterRenderer,
  createPracticeRenderer,
  splitCaptionText,
} from '../../src/system/presenter';

// Minimal HTMLElement-shaped fake (jsdom-free).
const makeEl = (): HTMLElement => {
  const attrs = new Map<string, string>();
  const children: HTMLElement[] = [];
  let innerHTML = '';
  const el = {
    tagName: 'DIV',
    className: '',
    get innerHTML() {
      return innerHTML;
    },
    set innerHTML(v: string) {
      innerHTML = v;
      // Mirror real-DOM behavior: setting innerHTML clears children.
      children.length = 0;
    },
    textContent: null as string | null,
    childNodes: children,
    ownerDocument: undefined as unknown as Document,
    setAttribute: (n: string, v: string) => {
      attrs.set(n, v);
    },
    appendChild: (child: HTMLElement) => {
      children.push(child);
      return child;
    },
    remove: () => {},
  };
  return el as unknown as HTMLElement;
};

const makeDocWithBody = (): { doc: Document; body: HTMLElement } => {
  const body = makeEl();
  const doc = {
    createElement: () => {
      const child = makeEl();
      (child as { ownerDocument: Document }).ownerDocument = doc as unknown as Document;
      return child;
    },
  } as unknown as Document;
  (body as { ownerDocument: Document }).ownerDocument = doc;
  return { doc, body };
};

describe('splitCaptionText', () => {
  it('returns the whole string when shorter than chunkSize', () => {
    expect(splitCaptionText('short', 60)).toEqual(['short']);
  });

  it('wraps long input into chunkSize-bounded windows on word boundaries', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve';
    const chunks = splitCaptionText(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });
});

describe('practice renderer', () => {
  it('mounts notes on show, clears on hide, toggles state', () => {
    const { body } = makeDocWithBody();
    const renderer = createPracticeRenderer({ target: body });
    renderer.render([{ at: 0, text: 'first beat' }]);
    expect(body.childNodes.length).toBe(0);
    renderer.show();
    expect(body.childNodes.length).toBe(1);
    renderer.hide();
    expect(body.childNodes.length).toBe(0);
    expect(renderer.toggle()).toBe(true);
    expect(body.childNodes.length).toBe(1);
    expect(renderer.toggle()).toBe(false);
    renderer.dispose();
  });

  it('handles beat-label captions as well as ms-offset', () => {
    const { body } = makeDocWithBody();
    const renderer = createPracticeRenderer({ target: body });
    renderer.render([
      { at: 'title-in', text: 'beat label' },
      { at: 500, text: 'ms offset' },
    ]);
    renderer.show();
    expect(body.childNodes.length).toBe(1);
  });
});

describe('chrome prompter renderer', () => {
  it('mounts a script panel and returns a dispose callback', () => {
    const { body } = makeDocWithBody();
    const renderer = createChromePrompterRenderer(body);
    const result = renderer(
      {
        composition: { id: 'pulsar-intro' },
        entries: [
          { sceneId: 'a', title: 'A', captions: [{ at: 0, text: 'hello' }] },
          { sceneId: 'b', title: 'B', captions: [] },
        ],
      },
      new AbortController().signal,
    );
    expect(body.childNodes.length).toBe(1);
    expect(typeof result).toBe('function');
    if (typeof result === 'function') result();
  });

  it('returns undefined when the target getter returns null', () => {
    const renderer = createChromePrompterRenderer(() => null);
    const result = renderer({ entries: [] }, new AbortController().signal);
    expect(result).toBeUndefined();
  });
});
