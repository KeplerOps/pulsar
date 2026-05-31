/** @vitest-environment happy-dom */
// Pulsar L2 — behavioral coverage for splitPaneTerminalDoc.
//
// Exercises the uncovered surface of
// src/system/templates/split-pane-terminal-doc.ts:
//   - the factory (line 54) + scene metadata (assets, captions),
//   - appendHeader / buildDocFigure DOM branches (eyebrow, headline,
//     caption, cant-degrees transform, alt),
//   - the authored timeline (panes-in label, segment count, the
//     activation marker flipping on/off),
//   - playScript (147-165): the scripted terminal types each line into
//     a `ph-line ph-line--<role>` span, honouring per-line `base` and
//     `afterMs`,
//   - the abort path: onDeactivate (91-93) flips the session abort flag,
//   - cleanup (95-100): aborts + deletes the session and removes the root.
//
// Every assertion is against the real happy-dom document so a behavior
// regression fails the test.

import { gsap } from 'gsap';
import { afterEach, describe, expect, it } from 'vitest';
import { type SceneModule, assertSceneModule } from '../../src/runtime/scene';
import { splitPaneTerminalDoc } from '../../src/system/templates';

type Ctx = { stage: HTMLElement; mode: string; gsap: typeof gsap };

const makeStage = (): HTMLElement => document.createElement('div');
const ctx = (stage: HTMLElement): Ctx => ({ stage, mode: 'present', gsap });

const requireNode = <T extends Element>(node: T | null, message: string): T => {
  if (node === null) throw new Error(message);
  return node;
};

const findRoot = (stage: HTMLElement, id: string): HTMLElement =>
  requireNode(
    stage.querySelector<HTMLElement>(`[data-pulsar-template="${id}"]`),
    `expected root ${id}`,
  );

/** Resolve once `predicate` holds, polling real timers (typeNode/aSleep use setTimeout). */
const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
};

const killed: gsap.core.Timeline[] = [];
afterEach(() => {
  for (const tl of killed.splice(0)) tl.kill();
});

describe('splitPaneTerminalDoc — behavioral coverage', () => {
  it('is a valid SceneModule exposing the doc image asset and one caption per script line', () => {
    const scene: SceneModule = splitPaneTerminalDoc('sptd-meta', {
      leftScript: [
        { role: 'user', text: 'first' },
        { role: 'agent', text: 'second' },
      ],
      rightDoc: { imgSrc: '/doc.png' },
    });
    expect(() => assertSceneModule(scene)).not.toThrow();
    expect(scene.assets).toEqual(['/doc.png']);
    // One caption per left-script line, with the `line-<i>` cue label.
    expect(scene.captions).toEqual([
      { at: 'line-0', text: 'first' },
      { at: 'line-1', text: 'second' },
    ]);
  });

  it('builds the split-pane DOM: header eyebrow/headline, grid, terminal pre, canted doc figure + caption', () => {
    const scene = splitPaneTerminalDoc('sptd-dom', {
      eyebrow: 'CASE STUDY',
      headline: 'CHATBOT',
      leftScript: [{ role: 'user', text: 'hello' }],
      rightDoc: {
        imgSrc: '/source.png',
        imgAlt: 'source doc',
        caption: 'exhibit A',
        cantDegrees: 4,
      },
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sptd-dom');

    // Root carries the template-kind class.
    expect(root.classList.contains('pulsar-template--split-pane-terminal-doc')).toBe(true);
    // Initially inactive (mount-then-play visibility contract).
    expect(root.dataset.pulsarTemplateActive).toBe('false');

    // Header branch (appendHeader): eyebrow <p> + headline <h2>.
    const head = requireNode(root.querySelector('header.splitpane__head'), 'expected header');
    const eyebrow = requireNode(head.querySelector('.splitpane__eyebrow'), 'expected eyebrow');
    expect(eyebrow.tagName).toBe('P');
    expect(eyebrow.textContent).toBe('CASE STUDY');
    const headline = requireNode(head.querySelector('.splitpane__headline'), 'expected headline');
    expect(headline.tagName).toBe('H2');
    expect(headline.textContent).toBe('CHATBOT');

    // Grid with a <pre> terminal on the left.
    const grid = requireNode(root.querySelector('.splitpane__grid'), 'expected grid');
    const term = requireNode(grid.querySelector('.splitpane__terminal'), 'expected terminal');
    expect(term.tagName).toBe('PRE');
    expect(term.classList.contains('term')).toBe(true);

    // buildDocFigure: <figure> with cant transform, <img> w/ src+alt, <figcaption>.
    const figure = requireNode(grid.querySelector('figure.splitpane__doc'), 'expected doc figure');
    expect(figure.getAttribute('style')).toBe('transform: rotate(4deg)');
    const img = requireNode(figure.querySelector('img'), 'expected doc image');
    expect(img.getAttribute('src')).toBe('/source.png');
    expect(img.getAttribute('alt')).toBe('source doc');
    const caption = requireNode(figure.querySelector('figcaption'), 'expected figcaption');
    expect(caption.textContent).toBe('exhibit A');
  });

  it('omits the header when neither eyebrow nor headline given, and omits transform/alt/caption when not set', () => {
    const scene = splitPaneTerminalDoc('sptd-bare', {
      leftScript: [{ role: 'output', text: 'done' }],
      rightDoc: { imgSrc: '/bare.png' },
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sptd-bare');

    // No header at all (early return in appendHeader).
    expect(root.querySelector('header.splitpane__head')).toBeNull();
    // Figure with no cant transform, image with no alt, no figcaption.
    const figure = requireNode(root.querySelector('figure.splitpane__doc'), 'expected doc figure');
    expect(figure.hasAttribute('style')).toBe(false);
    const img = requireNode(figure.querySelector('img'), 'expected doc image');
    expect(img.getAttribute('src')).toBe('/bare.png');
    expect(img.hasAttribute('alt')).toBe(false);
    expect(figure.querySelector('figcaption')).toBeNull();
  });

  it('renders a negative cant transform verbatim', () => {
    const scene = splitPaneTerminalDoc('sptd-neg', {
      leftScript: [{ role: 'user', text: 'x' }],
      rightDoc: { imgSrc: '/n.png', cantDegrees: -2 },
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const figure = requireNode(
      findRoot(stage, 'sptd-neg').querySelector('figure.splitpane__doc'),
      'expected doc figure',
    );
    expect(figure.getAttribute('style')).toBe('transform: rotate(-2deg)');
  });

  it('authors a timeline with the panes-in label and a non-trivial duration; activation flips on then off', () => {
    const scene = splitPaneTerminalDoc('sptd-tl', {
      leftScript: [{ role: 'user', text: 'hi' }],
      rightDoc: { imgSrc: '/t.png' },
      typeBaseMs: 1,
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sptd-tl');

    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    expect(tl).not.toBeNull();
    killed.push(tl);

    // Authored beat label is present at position 0.
    const labels = tl.labels as Record<string, number>;
    expect(labels['panes-in']).toBeDefined();
    expect(labels['panes-in']).toBe(0);
    // Real timeline with the leading call + content + suffix tween.
    expect(tl.duration()).toBeGreaterThan(0);

    // Drive the timeline: leading tl.call activates the root. Pass
    // suppressEvents=false so the position-0 callbacks actually fire.
    tl.pause();
    tl.seek(0.001, false);
    expect(root.dataset.pulsarTemplateActive).toBe('true');

    // Seek past the end: the trailing suffix tween's onComplete deactivates.
    tl.seek(tl.duration() + 0.1, false);
    expect(root.dataset.pulsarTemplateActive).toBe('false');
  });

  it('playScript types each script line into a ph-line--<role> span honoring per-line base + afterMs', async () => {
    const scene = splitPaneTerminalDoc('sptd-play', {
      leftScript: [
        { role: 'user', text: 'who is alice' },
        { role: 'agent', text: 'searching', base: 1 },
        { role: 'tool', text: 'curl api', afterMs: 5 },
        { role: 'output', text: 'found' },
      ],
      rightDoc: { imgSrc: '/p.png' },
      typeBaseMs: 1,
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sptd-play');
    const term = requireNode(root.querySelector('.splitpane__terminal'), 'expected terminal');

    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    killed.push(tl);
    // Fire the panes-in tl.call → playScript starts the async type loop.
    tl.pause();
    tl.seek(0.001, false);

    // Wait until all four lines have been appended + fully typed.
    await waitFor(() => term.querySelectorAll('.ph-line').length === 4);

    const lines = [...term.querySelectorAll<HTMLElement>('.ph-line')];
    expect(lines.map((l) => l.tagName)).toEqual(['SPAN', 'SPAN', 'SPAN', 'SPAN']);
    // Each role drives its modifier class, in authored order.
    expect(lines.map((l) => l.className)).toEqual([
      'ph-line ph-line--user',
      'ph-line ph-line--agent',
      'ph-line ph-line--tool',
      'ph-line ph-line--output',
    ]);
    // typeNode renders one ph-char span per character; textContent reconstructs the line.
    await waitFor(() => lines[3]?.textContent === 'found');
    expect(lines.map((l) => l.textContent)).toEqual([
      'who is alice',
      'searching',
      'curl api',
      'found',
    ]);
    // typeNode pre-renders characters as ph-char spans.
    expect(lines[0]?.querySelectorAll('.ph-char').length).toBe('who is alice'.length);
  });

  it('onDeactivate aborts the running session so cleanup leaves no further lines, and removes the root', async () => {
    const scene = splitPaneTerminalDoc('sptd-abort', {
      leftScript: [
        { role: 'user', text: 'one' },
        { role: 'agent', text: 'two', afterMs: 3000 },
        { role: 'output', text: 'three' },
      ],
      rightDoc: { imgSrc: '/a.png' },
      typeBaseMs: 1,
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sptd-abort');
    const term = requireNode(root.querySelector('.splitpane__terminal'), 'expected terminal');

    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    killed.push(tl);
    tl.pause();
    tl.seek(0.001, false); // start playScript

    // Let line two type, then trip its long (3s) afterMs dwell — the loop
    // is now parked in aSleep before iteration three appends its span.
    await waitFor(() => term.querySelector('.ph-line--agent')?.textContent === 'two');
    expect(term.querySelectorAll('.ph-line').length).toBe(2);

    // Seek past the end → suffix onComplete fires onDeactivate → abort flag set
    // mid-dwell. suppressEvents=false so the onComplete actually runs.
    tl.seek(tl.duration() + 0.1, false);

    // Once the 3s dwell resolves, iteration three sees the abort flag and
    // breaks — the third (output) line is never appended.
    await new Promise<void>((resolve) => setTimeout(resolve, 3200));
    expect(term.querySelectorAll('.ph-line').length).toBe(2);
    expect(term.querySelector('.ph-line--output')).toBeNull();

    // cleanup deletes the session and removes the root from the stage.
    scene.cleanup(ctx(stage));
    expect(stage.querySelector('[data-pulsar-template="sptd-abort"]')).toBeNull();
  });

  it('cleanup is safe when called without a prior timeline/session and still removes the root', () => {
    const scene = splitPaneTerminalDoc('sptd-clean', {
      leftScript: [{ role: 'user', text: 'x' }],
      rightDoc: { imgSrc: '/c.png' },
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    expect(findRoot(stage, 'sptd-clean')).not.toBeNull();
    expect(() => scene.cleanup(ctx(stage))).not.toThrow();
    expect(stage.querySelector('[data-pulsar-template="sptd-clean"]')).toBeNull();
  });
});
