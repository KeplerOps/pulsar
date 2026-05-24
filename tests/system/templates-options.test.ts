// Pulsar L2 — template optional-branch coverage tests.
//
// templates.test.ts exercises the smoke path (minimal valid content
// per template). This file exercises the OPTIONAL branches each
// template factory has: subtitle / eyebrow / glow / qrSrc / mod /
// headline / etc. Each branch flips a piece of DOM the template
// otherwise wouldn't render.

import { gsap } from 'gsap';
import { describe, expect, it } from 'vitest';
import { type SceneModule, assertSceneModule } from '../../src/runtime/scene';
import {
  actHeader,
  activityFeedPayoff,
  bulletList,
  cardCarousel,
  centerpiece,
  chatPickList,
  chatTranscript,
  compare,
  definitionTable,
  dropList,
  haulCitations,
  incidentPlate,
  introGrid,
  metricTicker,
  operatorDossier,
  outlineTitle,
  outro,
  placard,
  quote,
  quoteStack,
  screenshotCallouts,
  splitDialogueEmail,
  splitPaneTerminalDoc,
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

// Kebab-cases a `dataset` key the way the DOM does (`fooBar` →
// `foo-bar`) so the proxy below mirrors `el.dataset.fooBar` onto the
// `data-foo-bar` attribute.
const datasetKebab = (key: string): string => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

// A `dataset` surface that writes through to the attribute map, so a
// template's `el.dataset.fooBar = ''` is observable via
// `querySelector('[data-foo-bar]')` exactly as in a real browser.
const makeDataset = (attrs: Map<string, string>): Record<string, string> =>
  new Proxy({} as Record<string, string>, {
    get: (_t, p) => (typeof p === 'string' ? attrs.get(`data-${datasetKebab(p)}`) : undefined),
    set: (_t, p, v) => {
      if (typeof p === 'string') attrs.set(`data-${datasetKebab(p)}`, String(v));
      return true;
    },
    has: (_t, p) => typeof p === 'string' && attrs.has(`data-${datasetKebab(p)}`),
    deleteProperty: (_t, p) => {
      if (typeof p === 'string') attrs.delete(`data-${datasetKebab(p)}`);
      return true;
    },
  });

const makeNode = (doc: FakeDoc): FakeNode => {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const node: FakeNode = {
    className: '',
    textContent: '',
    innerHTML: '',
    childNodes: [],
    attrs,
    dataset: makeDataset(attrs),
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

const hasClass = (node: FakeNode, className: string): boolean =>
  node.className.split(/\s+/).includes(className);

const findAll = (root: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode[] => {
  const out: FakeNode[] = [];
  const search = (node: FakeNode): void => {
    if (predicate(node)) out.push(node);
    for (const child of node.childNodes) search(child);
  };
  search(root);
  return out;
};

const findByClass = (root: FakeNode, className: string): FakeNode | null =>
  findAll(root, (node) => hasClass(node, className))[0] ?? null;

const findAllByClass = (root: FakeNode, className: string): FakeNode[] =>
  findAll(root, (node) => hasClass(node, className));

const findByAttr = (root: FakeNode, attr: string, value?: string): FakeNode | null =>
  findAll(root, (node) => {
    const actual = node.getAttribute(attr);
    return actual !== null && (value === undefined || actual === value);
  })[0] ?? null;

const requireNode = (node: FakeNode | null | undefined, message: string): FakeNode => {
  expect(node).toBeDefined();
  expect(node).not.toBeNull();
  if (node === null || node === undefined) throw new Error(message);
  return node;
};

const renderRoot = (scene: SceneModule, rootValue: string): FakeNode => {
  const stage = makeStage();
  scene.create(ctx(stage));
  return requireNode(
    stage.querySelector(`[data-pulsar-template="${rootValue}"]`),
    `expected ${rootValue} root`,
  );
};

const expectClassText = (root: FakeNode, className: string, text: string): FakeNode => {
  const node = requireNode(findByClass(root, className), `expected .${className}`);
  expect(node.textContent).toBe(text);
  return node;
};

describe('L2 templates — optional-branch coverage', () => {
  it('titleSlam with subtitle + glitch + 5-word title (>4 word stagger)', () => {
    const scene = titleSlam('opt-title', {
      title: 'one two three four five',
      subtitle: 'a subtitle',
      glitch: true,
    });
    expect(() => assertSceneModule(scene)).not.toThrow();
    const root = renderRoot(scene, 'opt-title');
    expect(findAllByClass(root, 'word')).toHaveLength(5);
    expect(findAllByClass(root, 'pulsar-glitch')).toHaveLength(5);
    expectClassText(root, 'pulsar-title__subtitle', 'a subtitle');
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('titleSlam assigns glitch data-text without parsing word content as HTML', () => {
    const token = 'bad"onclick=<b>';
    const stage = makeStage();
    const scene = titleSlam('opt-title-escape', {
      title: token,
      glitch: true,
    });
    scene.create(ctx(stage));

    const root = stage.querySelector('[data-pulsar-template="opt-title-escape"]');
    expect(root).not.toBeNull();
    if (root === null) throw new Error('expected titleSlam root');

    const titleEl = root.childNodes[0];
    expect(titleEl).toBeDefined();
    if (titleEl === undefined) throw new Error('expected title element');

    expect(titleEl.childNodes).toHaveLength(1);
    const word = titleEl.childNodes[0];
    expect(word).toBeDefined();
    if (word === undefined) throw new Error('expected word span');

    expect(word.className).toBe('word pulsar-glitch');
    expect(word.textContent).toBe(token);
    expect(word.getAttribute('data-text')).toBe(token);
    expect(word.getAttribute('onclick')).toBeNull();
    expect(word.attrs.has('b')).toBe(false);
    const injectedAttrs = [...word.attrs.keys()].filter(
      (name) => name !== 'class' && name !== 'data-text',
    );
    expect(injectedAttrs).toEqual([]);
    expect(word.childNodes).toHaveLength(0);
  });

  it('outro with qrSrc + subtitle', () => {
    const scene = outro('opt-outro', {
      title: 'thanks',
      subtitle: 'sub',
      qrSrc: '/qr.png',
      qrAlt: 'qr',
    });
    expect(scene.assets).toEqual(['/qr.png']);
    const root = renderRoot(scene, 'opt-outro');
    expectClassText(root, 'outro__subtitle', 'sub');
    const qr = requireNode(findByClass(root, 'outro__qr'), 'expected outro QR image');
    expect(qr.getAttribute('src')).toBe('/qr.png');
    expect(qr.getAttribute('alt')).toBe('qr');
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('statRow / statPairGrid / definitionTable / quoteStack / bulletList with eyebrow', () => {
    const row = statRow('opt-stat-row', { eyebrow: 'eb', title: 't', rows: [['a', 'b']] });
    expectClassText(renderRoot(row, 'opt-stat-row'), 'eyebrow', 'eb');
    assertLifecycle(row, ctx(makeStage()));

    const pair = statPairGrid('opt-pair', {
      eyebrow: 'eb',
      title: 't',
      pairs: [['1', 'one']],
    });
    expectClassText(renderRoot(pair, 'opt-pair'), 'eyebrow', 'eb');
    assertLifecycle(pair, ctx(makeStage()));

    const defs = definitionTable('opt-defs', {
      eyebrow: 'eb',
      title: 't',
      rows: [
        { cat: 'A', rule: 'r', mod: 'red' },
        { cat: 'B', rule: 'r', mod: 'amber' },
        { cat: 'C', rule: 'r', mod: 'green' },
        { cat: 'D', rule: 'r', mod: 'clear' },
      ],
    });
    const defsRoot = renderRoot(defs, 'opt-defs');
    expectClassText(defsRoot, 'eyebrow', 'eb');
    expect(findByClass(defsRoot, 'mod-red')).not.toBeNull();
    expect(findByClass(defsRoot, 'mod-amber')).not.toBeNull();
    expect(findByClass(defsRoot, 'mod-green')).not.toBeNull();
    expect(findByClass(defsRoot, 'mod-clear')).not.toBeNull();
    assertLifecycle(defs, ctx(makeStage()));

    const stack = quoteStack('opt-qstack', {
      eyebrow: 'eb',
      title: 't',
      quotes: [{ text: 'a' }, { text: 'b', attribution: 'x' }],
    });
    const stackRoot = renderRoot(stack, 'opt-qstack');
    expectClassText(stackRoot, 'eyebrow', 'eb');
    expect(findAll(stackRoot, (node) => node.textContent === 'x')).toHaveLength(1);
    assertLifecycle(stack, ctx(makeStage()));

    const bullets = bulletList('opt-bullets', {
      eyebrow: 'eb',
      title: 't',
      bullets: ['x', 'y'],
      staggerMs: 200,
    });
    const bulletsRoot = renderRoot(bullets, 'opt-bullets');
    expectClassText(bulletsRoot, 'eyebrow', 'eb');
    expect(
      findAll(bulletsRoot, (node) => node.getAttribute('style') === '--bullet-delay: 700ms'),
    ).toHaveLength(1);
    assertLifecycle(bullets, ctx(makeStage()));
  });

  it('introGrid roles with logos and primary flag', () => {
    const scene = introGrid('opt-intro', {
      title: 't',
      roles: [{ logoSrc: '/a.png', logoAlt: 'a', role: 'lead', primary: true }, { role: 'co' }],
    });
    expect(scene.assets).toEqual(['/a.png']);
    const root = renderRoot(scene, 'opt-intro');
    expect(findAllByClass(root, 'primary')).toHaveLength(1);
    const logo = requireNode(findByAttr(root, 'src', '/a.png'), 'expected intro logo');
    expect(logo.getAttribute('alt')).toBe('a');
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('compare with headline', () => {
    const scene = compare('opt-compare', { headline: 'vs', left: 'a', right: 'b' });
    expectClassText(renderRoot(scene, 'opt-compare'), 'headline', 'vs');
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('screenshotCallouts with multiple callouts', () => {
    const scene = screenshotCallouts('opt-shot', {
      imageSrc: '/img.png',
      imageAlt: 'alt',
      callouts: [
        { x: 10, y: 20, text: 'a' },
        { x: 30, y: 40, text: 'b' },
      ],
    });
    expect(scene.assets).toEqual(['/img.png']);
    const root = renderRoot(scene, 'opt-shot');
    const image = requireNode(findByAttr(root, 'src', '/img.png'), 'expected screenshot image');
    expect(image.getAttribute('alt')).toBe('alt');
    expect(findAllByClass(root, 'callout').map((node) => node.textContent)).toEqual(['a', 'b']);
    assertLifecycle(scene, ctx(makeStage()));
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
    const root = requireNode(
      stage.querySelector('[data-pulsar-template="opt-ticker"]'),
      'ticker root',
    );
    expectClassText(root, 'eyebrow', 'eb');
    expect(
      findAll(root, (node) => node.getAttribute('data-metric') !== null).map(
        (node) => node.textContent,
      ),
    ).toEqual(['1', '$100k']);
    expect(() => scene.cleanup(ctx(stage))).not.toThrow(); // should stop the interval
  });

  it('terminal exercises every script step kind', () => {
    const scene = terminal('opt-term', {
      script: [
        { t: 'user', text: 'ls' },
        { t: 'agent', text: 'ok' },
        { t: 'tool', text: 'curl' },
        { t: 'output', text: 'two\nlines' },
        { t: 'wait', ms: 50 },
        { t: 'popout', text: 'BOOM' },
      ],
      typeBaseMs: 1,
    });
    expect(renderRoot(scene, 'opt-term').querySelector('.term')).not.toBeNull();
    expect(scene.captions.map((caption) => caption.text)).toEqual([
      'ls',
      'ok',
      'curl',
      'two\nlines',
    ]);
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('placard with no subtitle + quote with no attribution + centerpiece with no attr', () => {
    const pl = placard('opt-pl', { line1: 'solo' });
    const plRoot = renderRoot(pl, 'opt-pl');
    expectClassText(plRoot, 'placard__title', 'solo');
    expect(findByClass(plRoot, 'placard__sub')).toBeNull();
    assertLifecycle(pl, ctx(makeStage()));

    const q = quote('opt-q', { text: 'lone' });
    const qRoot = renderRoot(q, 'opt-q');
    expectClassText(qRoot, 'quote__text', 'lone');
    expect(findByClass(qRoot, 'quote__attr')).toBeNull();
    assertLifecycle(q, ctx(makeStage()));

    const cp = centerpiece('opt-cp', { quote: 'lonely' });
    const cpRoot = renderRoot(cp, 'opt-cp');
    expectClassText(cpRoot, 'centerpiece__quote', 'lonely');
    expect(findByClass(cpRoot, 'centerpiece__attr')).toBeNull();
    assertLifecycle(cp, ctx(makeStage()));
  });

  it('actHeader + outlineTitle with custom prefix', () => {
    const ah = actHeader('opt-ah', { act: 'X', section: 'Late' });
    expectClassText(renderRoot(ah, 'opt-ah'), 'act__numeral', 'Act X');
    assertLifecycle(ah, ctx(makeStage()));

    const custom = outlineTitle('opt-ot', { index: 99, title: 'Beyond', prefix: 'Chapter' });
    expectClassText(renderRoot(custom, 'opt-ot'), 'outline__index', 'Chapter 99');
    assertLifecycle(custom, ctx(makeStage()));

    const roman = outlineTitle('opt-ot2', { index: 5, title: 'Mid' });
    expectClassText(renderRoot(roman, 'opt-ot2'), 'outline__index', 'Section V');
    assertLifecycle(roman, ctx(makeStage()));
  });

  it('incidentPlate with bg + sub', () => {
    const scene = incidentPlate('opt-ip', {
      time: '03:14 UTC',
      headline: 'BRIDGE COLLAPSE',
      sub: 'no casualties yet',
      bgSrc: '/bg.png',
      bgAlt: 'bridge',
    });
    expect(scene.assets).toEqual(['/bg.png']);
    const root = renderRoot(scene, 'opt-ip');
    const bg = requireNode(findByClass(root, 'incident-plate__bg'), 'expected incident bg');
    expect(bg.getAttribute('style')).toBe('background-image: url(/bg.png)');
    expect(bg.getAttribute('aria-label')).toBe('bridge');
    expectClassText(root, 'incident-plate__sub', 'no casualties yet');
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('operatorDossier renders all rows', () => {
    const scene = operatorDossier('opt-od', {
      handle: '@drift',
      rows: [
        { k: 'origin', v: 'unknown' },
        { k: 'first seen', v: '2025-04' },
        { k: 'reach', v: 'global' },
      ],
    });
    const root = renderRoot(scene, 'opt-od');
    expectClassText(root, 'dossier__handle', '@drift');
    expect(findAllByClass(root, 'dossier__row')).toHaveLength(3);
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('splitPaneTerminalDoc with eyebrow + headline + canted doc + caption', () => {
    const scene = splitPaneTerminalDoc('opt-sptd', {
      eyebrow: 'EB',
      headline: 'CHATBOT',
      leftScript: [
        { role: 'user', text: 'q' },
        { role: 'agent', text: 'a' },
        { role: 'tool', text: 'curl', base: 5 },
        { role: 'output', text: 'ok', afterMs: 5 },
      ],
      rightDoc: { imgSrc: '/d.png', imgAlt: 'd', caption: 'cap', cantDegrees: 4 },
      typeBaseMs: 1,
    });
    expect(scene.assets).toEqual(['/d.png']);
    const root = renderRoot(scene, 'opt-sptd');
    expectClassText(root, 'splitpane__eyebrow', 'EB');
    expectClassText(root, 'splitpane__headline', 'CHATBOT');
    expectClassText(root, 'splitpane__doc', '');
    const doc = requireNode(findByClass(root, 'splitpane__doc'), 'expected splitpane doc');
    expect(doc.getAttribute('style')).toBe('transform: rotate(4deg)');
    const img = requireNode(findByAttr(root, 'src', '/d.png'), 'expected splitpane image');
    expect(img.getAttribute('alt')).toBe('d');
    expect(findAll(root, (node) => node.textContent === 'cap')).toHaveLength(1);
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('activityFeedPayoff with eyebrow + headline + all entry types + payoff title', () => {
    const scene = activityFeedPayoff('opt-afp', {
      eyebrow: 'EB',
      headline: 'OSINT',
      feed: [
        { type: 'search', text: 'who is X' },
        { type: 'read', text: 'wiki', afterMs: 5 },
        { type: 'think', text: 'reasoning' },
      ],
      payoff: {
        title: 'Dossier',
        rows: [
          { label: 'name', value: 'X' },
          { label: 'role', value: '[[CEO]]' },
        ],
      },
      typeBaseMs: 1,
    });
    const root = renderRoot(scene, 'opt-afp');
    expectClassText(root, 'afp__eyebrow', 'EB');
    expectClassText(root, 'afp__headline', 'OSINT');
    expectClassText(root, 'afp__payoff-title', 'Dossier');
    expect(findByAttr(root, 'data-afp-feed')).not.toBeNull();
    expect(findByAttr(root, 'data-afp-payoff')).not.toBeNull();
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('haulCitations with eyebrow + headline + hot row mod + citation title', () => {
    const scene = haulCitations('opt-hc', {
      eyebrow: 'EB',
      headline: 'HAUL',
      haul: [
        { count: '12,847', label: 'records', mod: 'hot' },
        { count: '100%', label: 'coverage' },
      ],
      citations: {
        title: 'Sources',
        rows: [
          { source: 'foo.com', quote: 'breach' },
          { source: 'bar.com', quote: 'leaked' },
        ],
      },
      staggerMs: 100,
    });
    const root = renderRoot(scene, 'opt-hc');
    expectClassText(root, 'hc__eyebrow', 'EB');
    expectClassText(root, 'hc__headline', 'HAUL');
    expectClassText(root, 'hc__citations-title', 'Sources');
    const hot = requireNode(findByClass(root, 'hc__row--hot'), 'expected hot haul row');
    expect(hot.getAttribute('style')).toBe('--row-delay: 0ms');
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('chatTranscript with title + alert flag + doc', () => {
    const scene = chatTranscript('opt-ct', {
      title: 'Signal export',
      messages: [
        { handle: '@a', text: 'safe' },
        { handle: '@b', text: 'unsafe', alert: true, afterMs: 5 },
      ],
      perBeatMs: 50,
      doc: { imgSrc: '/d.png', imgAlt: 'd', caption: 'doc', cantDegrees: -3 },
    });
    expect(scene.assets).toEqual(['/d.png']);
    const root = renderRoot(scene, 'opt-ct');
    expectClassText(root, 'ct__title', 'Signal export');
    expect(findByClass(root, 'ct__msg--alert')).not.toBeNull();
    const doc = requireNode(findByClass(root, 'ct__doc'), 'expected transcript doc');
    expect(doc.getAttribute('style')).toBe('transform: rotate(-3deg)');
    const img = requireNode(findByAttr(root, 'src', '/d.png'), 'expected transcript image');
    expect(img.getAttribute('alt')).toBe('d');
    expect(findAll(root, (node) => node.textContent === 'doc')).toHaveLength(1);
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('cardCarousel with eyebrow + sub + src + per-card dwell', () => {
    const scene = cardCarousel('opt-cc', {
      eyebrow: 'EB',
      dwellMs: 50,
      cards: [
        { headline: 'A', sub: 'subA', src: 'src.com' },
        { headline: 'B', dwellMs: 25 },
      ],
    });
    expectClassText(renderRoot(scene, 'opt-cc'), 'cc__eyebrow', 'EB');
    expect(scene.captions.map((caption) => caption.text)).toEqual(['A', 'B']);
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('splitDialogueEmail with eyebrow + headline + signoff + footer + base override', () => {
    const scene = splitDialogueEmail('opt-sde', {
      eyebrow: 'EB',
      headline: 'PHISH',
      dialogue: [
        { handle: '@a', text: 'plan it' },
        { handle: '@b', text: 'go', base: 5, afterMs: 5 },
      ],
      email: {
        from: 'a@x',
        to: 'b@x',
        subject: 'urgent',
        bodyParagraphs: ['line one', 'line [[two]]'],
        signoff: '— [[alex]]',
        footer: 'sent 09:12 MDT',
      },
      typeBaseMs: 1,
      emailRevealAfterMs: 10,
    });
    const root = renderRoot(scene, 'opt-sde');
    expectClassText(root, 'sde__eyebrow', 'EB');
    expectClassText(root, 'sde__headline', 'PHISH');
    expectClassText(root, 'sde__email-footer', 'sent 09:12 MDT');
    expectClassText(root, 'sde__email-signoff', '');
    expect(findByAttr(root, 'data-sde-dialogue')).not.toBeNull();
    expect(findByAttr(root, 'data-sde-email')).not.toBeNull();
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('dropList with eyebrow + headline + sub + hot mod', () => {
    const scene = dropList('opt-dl', {
      eyebrow: 'EB',
      headline: 'UPGRADES',
      staggerMs: 50,
      items: [{ label: 'fast', sub: 'really fast', mod: 'hot' }, { label: 'cheap' }],
    });
    const root = renderRoot(scene, 'opt-dl');
    expectClassText(root, 'dl__eyebrow', 'EB');
    expectClassText(root, 'dl__headline', 'UPGRADES');
    expectClassText(root, 'dl__sub', 'really fast');
    const hot = requireNode(findByClass(root, 'dl__item--hot'), 'expected hot drop item');
    expect(hot.getAttribute('style')).toBe('--drop-delay: 0ms');
    assertLifecycle(scene, ctx(makeStage()));
  });

  it('chatPickList with promptHandle + sub + pickCaption', () => {
    const scene = chatPickList('opt-cpl', {
      promptHandle: '@orch',
      promptMessage: 'pick one',
      items: [{ label: 'A', sub: 'option A' }, { label: 'B' }, { label: 'C' }],
      pickIndex: 2,
      staggerMs: 25,
      pickAfterMs: 25,
      pickCaption: 'committed',
    });
    const root = renderRoot(scene, 'opt-cpl');
    expectClassText(root, 'cpl__prompt-handle', '@orch');
    expectClassText(root, 'cpl__sub', 'option A');
    expectClassText(root, 'cpl__pick-caption', 'committed');
    expect(findAll(root, (node) => node.getAttribute('data-cpl-index') !== null)).toHaveLength(3);
    expect(findByAttr(root, 'data-cpl-caption')).not.toBeNull();
    assertLifecycle(scene, ctx(makeStage()));
  });
});
