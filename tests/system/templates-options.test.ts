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

interface FakeNode {
  className: string;
  textContent: string;
  innerHTML: string;
  childNodes: FakeNode[];
  attrs: Map<string, string>;
  dataset: Record<string, string>;
  parentElement: FakeNode | null;
  ownerDocument: FakeDoc;
  setAttribute(name: string, value: string): void;
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
  const node: FakeNode = {
    className: '',
    textContent: '',
    innerHTML: '',
    childNodes: [],
    attrs: new Map(),
    dataset: {},
    parentElement: null,
    ownerDocument: doc,
    setAttribute: (n, v) => {
      node.attrs.set(n, v);
      if (n === 'class') node.className = v;
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
    querySelector: () => null,
    querySelectorAll: () => [],
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

const runLifecycle = (scene: ReturnType<typeof titleSlam>, fakeCtx: unknown): void => {
  scene.create(fakeCtx);
  const tl = scene.timeline(fakeCtx);
  if (tl !== null && tl !== undefined) (tl as gsap.core.Timeline).kill();
  scene.cleanup(fakeCtx);
};

describe('L2 templates — optional-branch coverage', () => {
  it('titleSlam with subtitle + glitch + 5-word title (>4 word stagger)', () => {
    const scene = titleSlam('opt-title', {
      title: 'one two three four five',
      subtitle: 'a subtitle',
      glitch: true,
    });
    expect(() => assertSceneModule(scene)).not.toThrow();
    runLifecycle(scene, ctx(makeStage()));
  });

  it('outro with qrSrc + subtitle', () => {
    const scene = outro('opt-outro', {
      title: 'thanks',
      subtitle: 'sub',
      qrSrc: '/qr.png',
      qrAlt: 'qr',
    });
    expect(scene.assets).toEqual(['/qr.png']);
    runLifecycle(scene, ctx(makeStage()));
  });

  it('statRow / statPairGrid / definitionTable / quoteStack / bulletList with eyebrow', () => {
    runLifecycle(
      statRow('opt-stat-row', { eyebrow: 'eb', title: 't', rows: [['a', 'b']] }),
      ctx(makeStage()),
    );
    runLifecycle(
      statPairGrid('opt-pair', { eyebrow: 'eb', title: 't', pairs: [['1', 'one']] }),
      ctx(makeStage()),
    );
    runLifecycle(
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
    runLifecycle(
      quoteStack('opt-qstack', {
        eyebrow: 'eb',
        title: 't',
        quotes: [{ text: 'a' }, { text: 'b', attribution: 'x' }],
      }),
      ctx(makeStage()),
    );
    runLifecycle(
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
    runLifecycle(
      introGrid('opt-intro', {
        title: 't',
        roles: [{ logoSrc: '/a.png', logoAlt: 'a', role: 'lead', primary: true }, { role: 'co' }],
      }),
      ctx(makeStage()),
    );
  });

  it('compare with headline', () => {
    runLifecycle(
      compare('opt-compare', { headline: 'vs', left: 'a', right: 'b' }),
      ctx(makeStage()),
    );
  });

  it('screenshotCallouts with multiple callouts', () => {
    runLifecycle(
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
    scene.create(ctx(stage));
    scene.cleanup(ctx(stage)); // should stop the interval
  });

  it('terminal exercises every script step kind', () => {
    runLifecycle(
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
    runLifecycle(placard('opt-pl', { line1: 'solo' }), ctx(makeStage()));
    runLifecycle(quote('opt-q', { text: 'lone' }), ctx(makeStage()));
    runLifecycle(centerpiece('opt-cp', { quote: 'lonely' }), ctx(makeStage()));
  });

  it('actHeader + outlineTitle with custom prefix', () => {
    runLifecycle(actHeader('opt-ah', { act: 'X', section: 'Late' }), ctx(makeStage()));
    runLifecycle(
      outlineTitle('opt-ot', { index: 99, title: 'Beyond', prefix: 'Chapter' }),
      ctx(makeStage()),
    );
    runLifecycle(outlineTitle('opt-ot2', { index: 5, title: 'Mid' }), ctx(makeStage()));
  });
});
