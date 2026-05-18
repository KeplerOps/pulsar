// Pulsar L2 — template optional-branch coverage tests.
//
// templates.test.ts exercises the smoke path (minimal valid content
// per template). This file exercises the OPTIONAL branches each
// template factory has: subtitle / eyebrow / glow / qrSrc / mod /
// headline / etc. Each branch flips a piece of DOM the template
// otherwise wouldn't render.

import { gsap } from 'gsap';
import { describe, expect, it } from 'vitest';
import { assertSceneModule } from '../../src/runtime/scene';
import {
  actHeader,
  bulletList,
  centerpiece,
  compare,
  definitionTable,
  introGrid,
  metricTicker,
  outlineTitle,
  outro,
  placard,
  quote,
  quoteStack,
  screenshotCallouts,
  statBig,
  statPairGrid,
  statRow,
  terminal,
  titleSlam,
} from '../../src/system/templates';

interface FakeClassList {
  add(name: string): void;
  remove(name: string): void;
  contains(name: string): boolean;
}

interface FakeNode {
  className: string;
  textContent: string;
  innerHTML: string;
  childNodes: FakeNode[];
  attrs: Map<string, string>;
  dataset: Record<string, string>;
  classList: FakeClassList;
  parentElement: FakeNode | null;
  ownerDocument: FakeDoc;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeNode): FakeNode;
  remove(): void;
  querySelector(selector: string): FakeNode | null;
  querySelectorAll(selector: string): FakeNode[];
}

interface FakeDoc {
  createElement(tag: string): FakeNode;
}

const makeNode = (doc: FakeDoc): FakeNode => {
  const classes = new Set<string>();
  const node: FakeNode = {
    className: '',
    textContent: '',
    innerHTML: '',
    childNodes: [],
    attrs: new Map(),
    dataset: {},
    classList: {
      add: (n) => {
        classes.add(n);
      },
      remove: (n) => {
        classes.delete(n);
      },
      contains: (n) => classes.has(n),
    },
    parentElement: null,
    ownerDocument: doc,
    setAttribute: (n, v) => {
      node.attrs.set(n, v);
      if (n === 'class') node.className = v;
    },
    removeAttribute: (n) => {
      node.attrs.delete(n);
      if (n === 'class') node.className = '';
    },
    getAttribute: (n) => node.attrs.get(n) ?? null,
    appendChild: (child) => {
      child.parentElement = node;
      node.childNodes.push(child);
      return child;
    },
    remove: () => {
      if (node.parentElement !== null) {
        const i = node.parentElement.childNodes.indexOf(node);
        if (i >= 0) node.parentElement.childNodes.splice(i, 1);
        node.parentElement = null;
      }
    },
    querySelector: (selector) => {
      const match = selector.match(/\[([^=\]]+)(=["']?([^"'\]]+)["']?)?\]/);
      if (match === null) {
        const cm = selector.match(/^\.([\w-]+)$/);
        if (cm === null) return null;
        const cls = cm[1] ?? '';
        const search = (n: FakeNode): FakeNode | null => {
          if (n.className.split(' ').includes(cls)) return n;
          for (const c of n.childNodes) {
            const f = search(c);
            if (f !== null) return f;
          }
          return null;
        };
        return search(node);
      }
      const attr = match[1] ?? '';
      const wanted = match[3];
      const search = (n: FakeNode): FakeNode | null => {
        const v = n.attrs.get(attr);
        if (v !== undefined && (wanted === undefined || v === wanted)) return n;
        for (const c of n.childNodes) {
          const f = search(c);
          if (f !== null) return f;
        }
        return null;
      };
      return search(node);
    },
    querySelectorAll: (selector) => {
      const out: FakeNode[] = [];
      const match = selector.match(/\[([^=\]]+)(=["']?([^"'\]]+)["']?)?\]/);
      if (match === null) return out;
      const attr = match[1] ?? '';
      const wanted = match[3];
      const search = (n: FakeNode): void => {
        const v = n.attrs.get(attr);
        if (v !== undefined && (wanted === undefined || v === wanted)) out.push(n);
        for (const c of n.childNodes) search(c);
      };
      search(node);
      return out;
    },
  };
  return node;
};

const makeStage = (): FakeNode => {
  const doc: FakeDoc = {
    createElement: (_tag) => makeNode(doc),
  };
  return makeNode(doc);
};

const ctx = (stage: FakeNode): unknown => ({ stage, mode: 'present', gsap });

const runLifecycle = (
  scene: ReturnType<typeof titleSlam>,
  fakeCtx: unknown,
): gsap.core.Timeline | null => {
  scene.create(fakeCtx);
  const tl = scene.timeline(fakeCtx);
  const out = tl === null || tl === undefined ? null : (tl as gsap.core.Timeline);
  if (out !== null) out.kill();
  scene.cleanup(fakeCtx);
  return out;
};

/** Asserts the scene's lifecycle ran successfully (returned a timeline). */
const assertLifecycle = (scene: ReturnType<typeof titleSlam>, fakeCtx: unknown): void => {
  const tl = runLifecycle(scene, fakeCtx);
  expect(tl).not.toBeNull();
};

describe('L2 templates — optional-branch coverage', () => {
  it('titleSlam with subtitle + glitch + 5-word title (>4 word stagger)', () => {
    const scene = titleSlam('opt-title', {
      title: 'one two three four five',
      subtitle: 'a subtitle',
      glitch: true,
    });
    expect(() => assertSceneModule(scene)).not.toThrow();
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('outro with qrSrc + subtitle', () => {
    const scene = outro('opt-outro', {
      title: 'thanks',
      subtitle: 'sub',
      qrSrc: '/qr.png',
      qrAlt: 'qr',
    });
    expect(scene.assets).toEqual(['/qr.png']);
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('statRow / statPairGrid / definitionTable / quoteStack / bulletList with eyebrow', () => {
    assertLifecycle(
      statRow('opt-stat-row', { eyebrow: 'eb', title: 't', rows: [['a', 'b']] }),
      ctx(makeStage()),
    );
    assertLifecycle(
      statPairGrid('opt-pair', { eyebrow: 'eb', title: 't', pairs: [['1', 'one']] }),
      ctx(makeStage()),
    );
    assertLifecycle(
      definitionTable('opt-defs', {
        eyebrow: 'eb',
        title: 't',
        rows: [
          { cat: 'A', rule: 'r', mod: 'red' },
          { cat: 'B', rule: 'r', mod: 'amber' },
          { cat: 'C', rule: 'r', mod: 'green' },
          { cat: 'D', rule: 'r', mod: 'clear' },
        ],
      }),
      ctx(makeStage()),
    );
    assertLifecycle(
      quoteStack('opt-qstack', {
        eyebrow: 'eb',
        title: 't',
        quotes: [{ text: 'a' }, { text: 'b', attribution: 'x' }],
      }),
      ctx(makeStage()),
    );
    assertLifecycle(
      bulletList('opt-bullets', {
        eyebrow: 'eb',
        title: 't',
        bullets: ['x', 'y'],
        staggerMs: 200,
      }),
      ctx(makeStage()),
    );
  });

  it('introGrid roles with logos and primary flag', () => {
    assertLifecycle(
      introGrid('opt-intro', {
        title: 't',
        roles: [{ logoSrc: '/a.png', logoAlt: 'a', role: 'lead', primary: true }, { role: 'co' }],
      }),
      ctx(makeStage()),
    );
  });

  it('compare with headline', () => {
    assertLifecycle(
      compare('opt-compare', { headline: 'vs', left: 'a', right: 'b' }),
      ctx(makeStage()),
    );
  });

  it('screenshotCallouts with multiple callouts', () => {
    assertLifecycle(
      screenshotCallouts('opt-shot', {
        imageSrc: '/img.png',
        imageAlt: 'alt',
        callouts: [
          { x: 10, y: 20, text: 'a' },
          { x: 30, y: 40, text: 'b' },
        ],
      }),
      ctx(makeStage()),
    );
  });

  it('metricTicker create + cleanup tears down the interval', () => {
    const scene = metricTicker('opt-ticker', {
      eyebrow: 'eb',
      title: 't',
      metrics: [
        { label: 'a', direction: 'up', start: 1, step: 1 },
        { label: 'b', direction: 'down', start: 100, step: 2, prefix: '$', suffix: 'k' },
      ],
      tickMs: 50,
    });
    const stage = makeStage();
    expect(() => scene.create(ctx(stage))).not.toThrow();
    expect(() => scene.cleanup(ctx(stage))).not.toThrow(); // should stop the interval
  });

  it('terminal exercises every script step kind', () => {
    assertLifecycle(
      terminal('opt-term', {
        script: [
          { t: 'user', text: 'ls' },
          { t: 'agent', text: 'ok' },
          { t: 'tool', text: 'curl' },
          { t: 'output', text: 'two\nlines' },
          { t: 'wait', ms: 50 },
          { t: 'popout', text: 'BOOM' },
        ],
        typeBaseMs: 1,
      }),
      ctx(makeStage()),
    );
  });

  it('placard with no subtitle + quote with no attribution + centerpiece with no attr', () => {
    assertLifecycle(placard('opt-pl', { line1: 'solo' }), ctx(makeStage()));
    assertLifecycle(quote('opt-q', { text: 'lone' }), ctx(makeStage()));
    assertLifecycle(centerpiece('opt-cp', { quote: 'lonely' }), ctx(makeStage()));
  });

  it('actHeader + outlineTitle with custom prefix', () => {
    assertLifecycle(actHeader('opt-ah', { act: 'X', section: 'Late' }), ctx(makeStage()));
    assertLifecycle(
      outlineTitle('opt-ot', { index: 99, title: 'Beyond', prefix: 'Chapter' }),
      ctx(makeStage()),
    );
    assertLifecycle(outlineTitle('opt-ot2', { index: 5, title: 'Mid' }), ctx(makeStage()));
  });
});
