// Pulsar L2 — template factory shape + smoke tests.
//
// Table-driven: every template factory is instantiated with a minimal
// content payload and verified to produce a valid SceneModule whose
// lifecycle hooks run without throwing against a jsdom-free stage
// fake. The reference deck and Playwright specs cover the actual
// visual behavior; this suite catches structural regressions.

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

// ---------- jsdom-free stage fake ----------

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
  const attrs = new Map<string, string>();
  const node: FakeNode = {
    className: '',
    textContent: '',
    innerHTML: '',
    childNodes: [],
    attrs,
    dataset: makeDataset(attrs),
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
    querySelector: (selector) => {
      const match = selector.match(/\[([^=\]]+)(=["']?([^"'\]]+)["']?)?\]/);
      if (match === null) {
        // simple class selector .pulsar-template--<x>
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

const makeDoc = (): FakeDoc => {
  const doc: FakeDoc = {
    createElement: (_tag) => makeNode(doc),
  };
  return doc;
};

const makeStage = (): FakeNode => {
  const doc = makeDoc();
  const stage = makeNode(doc);
  return stage;
};

const makeCtx = (
  stage: FakeNode,
  mode: 'present' | 'paused' | 'standalone' = 'present',
): unknown => ({
  stage,
  mode,
  gsap,
});

// ---------- table-driven smoke test ----------

interface TemplateCase {
  readonly id: string;
  readonly build: (id: string) => SceneModule;
}

const CASES: readonly TemplateCase[] = [
  { id: 'title-slam-smoke', build: (id) => titleSlam(id, { title: 'Pulsar' }) },
  { id: 'act-header-smoke', build: (id) => actHeader(id, { act: 'I', section: 'Foundations' }) },
  {
    id: 'centerpiece-smoke',
    build: (id) => centerpiece(id, { quote: 'Composition is the product.', attribution: 'pulsar' }),
  },
  {
    id: 'outro-smoke',
    build: (id) => outro(id, { title: 'Thanks.', subtitle: 'Reuse, recompose, remix.' }),
  },
  { id: 'stat-big-smoke', build: (id) => statBig(id, { value: '99', label: 'percent' }) },
  {
    id: 'stat-row-smoke',
    build: (id) =>
      statRow(id, {
        eyebrow: 'about',
        title: 'numbers',
        rows: [
          ['count', 'three'],
          ['size', 'big'],
        ],
      }),
  },
  {
    id: 'stat-pair-grid-smoke',
    build: (id) =>
      statPairGrid(id, {
        title: 'matrix',
        pairs: [
          ['1', 'one'],
          ['2', 'two'],
          ['3', 'three'],
        ],
      }),
  },
  { id: 'quote-smoke', build: (id) => quote(id, { text: 'a quote', attribution: 'someone' }) },
  {
    id: 'quote-stack-smoke',
    build: (id) =>
      quoteStack(id, {
        title: 'stack',
        quotes: [{ text: 'a' }, { text: 'b', attribution: 'x' }],
      }),
  },
  {
    id: 'bullet-list-smoke',
    build: (id) => bulletList(id, { title: 'bullets', bullets: ['one', 'two', 'three'] }),
  },
  {
    id: 'intro-grid-smoke',
    build: (id) =>
      introGrid(id, {
        title: 'team',
        roles: [{ role: 'speaker', primary: true }, { role: 'other' }],
      }),
  },
  {
    id: 'definition-table-smoke',
    build: (id) =>
      definitionTable(id, {
        title: 'tlp',
        rows: [
          { cat: 'TLP:RED', rule: 'a', mod: 'red' },
          { cat: 'TLP:AMBER', rule: 'b', mod: 'amber' },
        ],
      }),
  },
  { id: 'compare-smoke', build: (id) => compare(id, { left: 'before', right: 'after' }) },
  {
    id: 'screenshot-callouts-smoke',
    build: (id) =>
      screenshotCallouts(id, {
        imageSrc: '/assets/screenshot.png',
        callouts: [{ x: 20, y: 30, text: 'here' }],
      }),
  },
  {
    id: 'metric-ticker-smoke',
    build: (id) =>
      metricTicker(id, {
        title: 'ticker',
        metrics: [{ label: 'count', direction: 'up', start: 1, step: 1 }],
      }),
  },
  {
    id: 'terminal-smoke',
    build: (id) =>
      terminal(id, {
        script: [
          { t: 'user', text: 'ls' },
          { t: 'output', text: 'file1\nfile2' },
        ],
      }),
  },
  { id: 'placard-smoke', build: (id) => placard(id, { line1: 'PLACARD', line2: 'subtitle' }) },
  { id: 'outline-title-smoke', build: (id) => outlineTitle(id, { index: 3, title: 'Detection' }) },
  {
    id: 'incident-plate-smoke',
    build: (id) => incidentPlate(id, { time: '14:32 MDT', headline: 'INCIDENT' }),
  },
  {
    id: 'operator-dossier-smoke',
    build: (id) =>
      operatorDossier(id, {
        handle: '@operator',
        rows: [
          { k: 'origin', v: 'unknown' },
          { k: 'first seen', v: '2025-04-01' },
        ],
      }),
  },
  {
    id: 'split-pane-terminal-doc-smoke',
    build: (id) =>
      splitPaneTerminalDoc(id, {
        leftScript: [{ role: 'user', text: 'go' }],
        rightDoc: { imgSrc: '/img.png' },
      }),
  },
  {
    id: 'activity-feed-payoff-smoke',
    build: (id) =>
      activityFeedPayoff(id, {
        feed: [{ type: 'search', text: 'who is X' }],
        payoff: { rows: [{ label: 'name', value: 'X' }] },
      }),
  },
  {
    id: 'haul-citations-smoke',
    build: (id) =>
      haulCitations(id, {
        haul: [{ count: '12k', label: 'records' }],
        citations: { rows: [{ source: 'src', quote: 'q' }] },
      }),
  },
  {
    id: 'chat-transcript-smoke',
    build: (id) =>
      chatTranscript(id, {
        messages: [
          { handle: '@a', text: 'hello' },
          { handle: '@b', text: 'world' },
        ],
      }),
  },
  {
    id: 'card-carousel-smoke',
    build: (id) =>
      cardCarousel(id, {
        cards: [{ headline: 'A' }, { headline: 'B' }],
        dwellMs: 100,
      }),
  },
  {
    id: 'split-dialogue-email-smoke',
    build: (id) =>
      splitDialogueEmail(id, {
        dialogue: [{ handle: '@a', text: 'lets do it' }],
        email: {
          from: 'a@x',
          to: 'b@x',
          subject: 'hi',
          bodyParagraphs: ['line one'],
        },
      }),
  },
  {
    id: 'drop-list-smoke',
    build: (id) => dropList(id, { items: [{ label: 'one' }, { label: 'two' }] }),
  },
  {
    id: 'chat-pick-list-smoke',
    build: (id) =>
      chatPickList(id, {
        promptMessage: 'pick one',
        items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        pickIndex: 1,
      }),
  },
];

describe('L2 templates — shape + smoke (Batch E)', () => {
  it.each(CASES)('"$id" satisfies the SceneModule contract', (testCase) => {
    const scene = testCase.build(testCase.id);
    expect(() => assertSceneModule(scene)).not.toThrow();
  });

  it.each(CASES)('"$id" create + timeline + cleanup runs without throwing', (testCase) => {
    const scene = testCase.build(testCase.id);
    const stage = makeStage();
    const ctx = makeCtx(stage);
    expect(() => scene.create(ctx)).not.toThrow();
    const tl = scene.timeline(ctx);
    if (tl !== null && tl !== undefined) {
      expect(typeof (tl as gsap.core.Timeline).addLabel).toBe('function');
      (tl as gsap.core.Timeline).kill();
    }
    expect(() => scene.cleanup(ctx)).not.toThrow();
  });

  it('every template id is unique', () => {
    const ids = new Set(CASES.map((c) => c.id));
    expect(ids.size).toBe(CASES.length);
  });

  it('covers all 28 shipped templates', () => {
    expect(CASES.length).toBe(28);
  });
});
