/** @vitest-environment happy-dom */
// Pulsar L2 — template factory shape + smoke tests.
//
// Table-driven: every template factory is instantiated with a minimal
// content payload and verified to produce a valid SceneModule whose
// lifecycle hooks run without throwing against a real (happy-dom)
// stage. The reference deck and Playwright specs cover the actual
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
  introGrid,
  metricTicker,
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

// ---------- real-DOM stage ----------

const makeStage = (): HTMLElement => document.createElement('div');

const makeCtx = (
  stage: HTMLElement,
  mode: 'present' | 'paused' | 'standalone' = 'present',
): unknown => ({ stage, mode, gsap });

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
    // create() mounts the scene root with the public template marker.
    expect(stage.querySelector(`[data-pulsar-template="${testCase.id}"]`)).not.toBeNull();
    const tl = scene.timeline(ctx);
    if (tl !== null && tl !== undefined) {
      expect(typeof (tl as gsap.core.Timeline).addLabel).toBe('function');
      (tl as gsap.core.Timeline).kill();
    }
    expect(() => scene.cleanup(ctx)).not.toThrow();
    // cleanup() removes the scene root from the stage.
    expect(stage.querySelector(`[data-pulsar-template="${testCase.id}"]`)).toBeNull();
  });

  it('every template id is unique', () => {
    const ids = new Set(CASES.map((c) => c.id));
    expect(ids.size).toBe(CASES.length);
  });

  it('covers all 25 shared shipped templates', () => {
    expect(CASES.length).toBe(25);
  });
});
