/** @vitest-environment happy-dom */
// Pulsar L2 — template optional-branch coverage tests.
//
// templates.test.ts exercises the smoke path (minimal valid content
// per template). This file exercises the OPTIONAL branches each
// template factory has: subtitle / eyebrow / glow / qrSrc / mod /
// headline / etc. Each branch flips a piece of DOM the template
// otherwise wouldn't render. Assertions run against a real (happy-dom)
// document so the templates author against `lib.dom` types.

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

const makeStage = (): HTMLElement => document.createElement('div');

const ctx = (stage: HTMLElement): unknown => ({ stage, mode: 'present', gsap });

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

const findByClass = (root: HTMLElement, className: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`.${className}`);

const findAllByClass = (root: HTMLElement, className: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`.${className}`),
];

const findAll = (root: HTMLElement, predicate: (node: HTMLElement) => boolean): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('*')].filter(predicate);

const findByAttr = (root: HTMLElement, attr: string, value?: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(value === undefined ? `[${attr}]` : `[${attr}="${value}"]`);

const requireNode = (node: HTMLElement | null | undefined, message: string): HTMLElement => {
  expect(node).toBeDefined();
  expect(node).not.toBeNull();
  if (node === null || node === undefined) throw new Error(message);
  return node;
};

const renderRoot = (scene: SceneModule, rootValue: string): HTMLElement => {
  const stage = makeStage();
  scene.create(ctx(stage));
  return requireNode(
    stage.querySelector<HTMLElement>(`[data-pulsar-template="${rootValue}"]`),
    `expected ${rootValue} root`,
  );
};

const expectClassText = (root: HTMLElement, className: string, text: string): HTMLElement => {
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

    const root = stage.querySelector<HTMLElement>('[data-pulsar-template="opt-title-escape"]');
    expect(root).not.toBeNull();
    if (root === null) throw new Error('expected titleSlam root');

    const titleEl = root.children[0];
    expect(titleEl).toBeDefined();
    if (titleEl === undefined) throw new Error('expected title element');

    expect(titleEl.children).toHaveLength(1);
    const word = titleEl.children[0] as HTMLElement | undefined;
    expect(word).toBeDefined();
    if (word === undefined) throw new Error('expected word span');

    expect(word.className).toBe('word pulsar-glitch');
    expect(word.textContent).toBe(token);
    expect(word.getAttribute('data-text')).toBe(token);
    expect(word.getAttribute('onclick')).toBeNull();
    expect(word.hasAttribute('b')).toBe(false);
    const injectedAttrs = [...word.attributes]
      .map((a) => a.name)
      .filter((name) => name !== 'class' && name !== 'data-text');
    expect(injectedAttrs).toEqual([]);
    expect(word.children).toHaveLength(0);
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
      stage.querySelector<HTMLElement>('[data-pulsar-template="opt-ticker"]'),
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
    const doc = requireNode(findByClass(root, 'splitpane__doc'), 'expected splitpane doc');
    expect(doc.getAttribute('style')).toBe('transform: rotate(4deg)');
    const img = requireNode(findByAttr(root, 'src', '/d.png'), 'expected splitpane image');
    expect(img.getAttribute('alt')).toBe('d');
    expect(
      requireNode(doc.querySelector<HTMLElement>('figcaption'), 'expected caption').textContent,
    ).toBe('cap');
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
    expect(
      requireNode(doc.querySelector<HTMLElement>('figcaption'), 'expected doc caption').textContent,
    ).toBe('doc');
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
    // The signoff renders `[[alex]]` as a `.glow` marker span; real-DOM
    // textContent concatenates the rendered text.
    const signoff = requireNode(findByClass(root, 'sde__email-signoff'), 'expected signoff');
    expect(signoff.textContent).toBe('— alex');
    expectClassText(signoff, 'glow', 'alex');
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
