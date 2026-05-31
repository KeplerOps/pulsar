/** @vitest-environment happy-dom */
// Pulsar L2 — splitDialogueEmail behavioral coverage.
//
// Exercises the whole intended surface of
// src/system/templates/split-dialogue-email.ts against a real
// (happy-dom) document:
//   - the SceneModule envelope (id/title/captions derived from dialogue)
//   - create()'s authored DOM: header eyebrow/headline branches, the
//     two-pane grid, email meta rows, body paragraphs with [[glow]]
//     markers, the optional signoff + footer branches
//   - timeline() labels/segments (sde-in beat, advance gate, duration)
//   - play()'s async reveal: dialogue <li> rows typed character-by-
//     character into .sde__text, then the email fading in
//     (sde__email--in + opacity:1)
//   - the abort/cleanup path: onDeactivate flips the session abort flag,
//     cleanup tears the session down and removes the scene root
//
// Each assertion targets observable DOM / timeline state so a behavioral
// regression in the template fails the test.

import { gsap } from 'gsap';
import { describe, expect, it, vi } from 'vitest';
import type { SceneModule } from '../../src/runtime/scene';
import { splitDialogueEmail } from '../../src/system/templates';

const makeStage = (): HTMLElement => document.createElement('div');

const ctx = (stage: HTMLElement): unknown => ({ stage, mode: 'present', gsap });

const requireNode = <T extends Element>(node: T | null, message: string): T => {
  expect(node, message).not.toBeNull();
  if (node === null) throw new Error(message);
  return node;
};

const findRoot = (stage: HTMLElement, id: string): HTMLElement =>
  requireNode(
    stage.querySelector<HTMLElement>(`[data-pulsar-template="${id}"]`),
    `expected ${id} root`,
  );

// Full content payload that flips every optional branch: eyebrow +
// headline header, per-line base override + afterMs dwell, body
// paragraphs (one plain, one with a [[glow]] marker), signoff (with
// glow), and footer.
const fullContent = () =>
  ({
    eyebrow: 'INTERCEPT',
    headline: 'PHISH KIT',
    dialogue: [
      { handle: '@alex', text: 'draft it' },
      { handle: '@sam', text: 'go now', base: 1, afterMs: 1 },
    ],
    email: {
      from: 'alex@corp.test',
      to: 'finance@corp.test',
      subject: 'Wire approval needed',
      bodyParagraphs: ['Plain paragraph.', 'Please wire to [[the new account]] today.'],
      signoff: '— [[Alex]], CFO',
      footer: 'sent 09:12 MDT',
    },
    typeBaseMs: 1,
    emailRevealAfterMs: 1,
  }) as const;

describe('splitDialogueEmail — behavioral coverage', () => {
  it('derives id/title/captions from the dialogue (line 47/51)', () => {
    const scene: SceneModule = splitDialogueEmail('sde-meta', fullContent());
    expect(scene.id).toBe('sde-meta');
    expect(scene.title).toBe('Split dialogue + email');
    // One caption per dialogue line, labelled line-<i>, "handle: text".
    expect(scene.captions).toEqual([
      { at: 'line-0', text: '@alex: draft it' },
      { at: 'line-1', text: '@sam: go now' },
    ]);
    // Template scenes default to the 'template' tag and standalone/trailer-safe.
    expect(scene.tags).toContain('template');
  });

  it('create() builds header + two-pane grid + email card with all optional branches', () => {
    const scene = splitDialogueEmail('sde-full', fullContent());
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sde-full');

    // Root carries the template-kind class and starts inactive.
    expect(root.classList.contains('pulsar-template')).toBe(true);
    expect(root.classList.contains('pulsar-template--split-dialogue-email')).toBe(true);
    expect(root.dataset.pulsarTemplateActive).toBe('false');

    // Header branch: both eyebrow and headline rendered.
    const head = requireNode(root.querySelector<HTMLElement>('.sde__head'), 'header');
    expect(head.tagName).toBe('HEADER');
    expect(requireNode(root.querySelector('.sde__eyebrow'), 'eyebrow').textContent).toBe(
      'INTERCEPT',
    );
    const headline = requireNode(root.querySelector('.sde__headline'), 'headline');
    expect(headline.tagName).toBe('H2');
    expect(headline.textContent).toBe('PHISH KIT');

    // Two-pane grid: dialogue <ol> (empty until play) + email <article>.
    const grid = requireNode(root.querySelector('.sde__grid'), 'grid');
    const dialogue = requireNode(
      grid.querySelector<HTMLElement>('ol.sde__dialogue'),
      'dialogue list',
    );
    expect(dialogue.hasAttribute('data-sde-dialogue')).toBe(true);
    expect(dialogue.children).toHaveLength(0);

    // Email card: starts hidden, carries the data hook for play() lookup.
    const email = requireNode(grid.querySelector<HTMLElement>('article.sde__email'), 'email');
    expect(email.hasAttribute('data-sde-email')).toBe(true);
    expect(email.getAttribute('style')).toBe('opacity:0');
    expect(email.classList.contains('sde__email--in')).toBe(false);

    // Email meta rows: From / To / Subject, in order, key + value split.
    const rows = [...email.querySelectorAll<HTMLElement>('.sde__email-meta .sde__email-row')];
    expect(rows).toHaveLength(3);
    const keys = rows.map((r) => r.querySelector('.sde__email-k')?.textContent);
    const values = rows.map((r) => r.querySelector('.sde__email-v')?.textContent);
    expect(keys).toEqual(['From:', 'To:', 'Subject:']);
    expect(values).toEqual(['alex@corp.test', 'finance@corp.test', 'Wire approval needed']);

    // Body paragraphs: plain paragraph stays plain; [[glow]] marker becomes
    // a .glow span with the marker text.
    const body = requireNode(root.querySelector<HTMLElement>('.sde__email-body'), 'email body');
    const paras = [...body.querySelectorAll<HTMLElement>('p:not(.sde__email-signoff)')];
    expect(paras).toHaveLength(2);
    expect(paras[0]?.textContent).toBe('Plain paragraph.');
    expect(paras[0]?.querySelector('.glow')).toBeNull();
    expect(paras[1]?.textContent).toBe('Please wire to the new account today.');
    const bodyGlow = requireNode(paras[1]?.querySelector('.glow') ?? null, 'body glow');
    expect(bodyGlow.textContent).toBe('the new account');

    // Signoff optional branch: rendered as .sde__email-signoff with a glow span.
    const signoff = requireNode(root.querySelector<HTMLElement>('.sde__email-signoff'), 'signoff');
    expect(signoff.textContent).toBe('— Alex, CFO');
    expect(requireNode(signoff.querySelector('.glow'), 'signoff glow').textContent).toBe('Alex');

    // Footer optional branch.
    const footer = requireNode(root.querySelector<HTMLElement>('.sde__email-footer'), 'footer');
    expect(footer.tagName).toBe('FOOTER');
    expect(footer.textContent).toBe('sent 09:12 MDT');

    scene.cleanup(ctx(stage));
  });

  it('create() escapes HTML in body paragraphs (markedTextHtml safety)', () => {
    const scene = splitDialogueEmail('sde-escape', {
      dialogue: [{ handle: '@a', text: 'hi' }],
      email: {
        from: 'a',
        to: 'b',
        subject: 's',
        bodyParagraphs: ['danger <img src=x onerror=boom> & "quote"'],
      },
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sde-escape');
    const para = requireNode(
      root.querySelector<HTMLElement>('.sde__email-body p'),
      'escaped paragraph',
    );
    // No injected <img> element: the markup was escaped, not parsed.
    expect(para.querySelector('img')).toBeNull();
    expect(para.children).toHaveLength(0);
    expect(para.textContent).toBe('danger <img src=x onerror=boom> & "quote"');
    scene.cleanup(ctx(stage));
  });

  it('create() omits the header when neither eyebrow nor headline is set', () => {
    const scene = splitDialogueEmail('sde-nohead', {
      dialogue: [{ handle: '@a', text: 'hi' }],
      email: { from: 'a', to: 'b', subject: 's', bodyParagraphs: ['body'] },
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sde-nohead');
    expect(root.querySelector('.sde__head')).toBeNull();
    expect(root.querySelector('.sde__eyebrow')).toBeNull();
    expect(root.querySelector('.sde__headline')).toBeNull();
    scene.cleanup(ctx(stage));
  });

  it('create() omits signoff/footer when not provided', () => {
    const scene = splitDialogueEmail('sde-minimal-email', {
      headline: 'ONLY HEADLINE',
      dialogue: [{ handle: '@a', text: 'hi' }],
      email: { from: 'a', to: 'b', subject: 's', bodyParagraphs: ['body'] },
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sde-minimal-email');
    // headline-only header still renders (one branch of appendHeader).
    expect(root.querySelector('.sde__headline')?.textContent).toBe('ONLY HEADLINE');
    expect(root.querySelector('.sde__eyebrow')).toBeNull();
    // signoff + footer branches not taken.
    expect(root.querySelector('.sde__email-signoff')).toBeNull();
    expect(root.querySelector('.sde__email-footer')).toBeNull();
    scene.cleanup(ctx(stage));
  });

  it('timeline() exposes the sde-in beat, an advance gate, and positive duration', () => {
    const scene = splitDialogueEmail('sde-tl', fullContent());
    const stage = makeStage();
    scene.create(ctx(stage));
    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    expect(tl).not.toBeNull();
    const labels = tl.labels;
    expect(Object.keys(labels)).toContain('sde-in');
    expect(labels['sde-in']).toBe(0);
    // The hold-for-advance gate is appended by the shared envelope.
    expect(Object.keys(labels)).toContain('_advance-gate');
    // Segment content + 1.6s suffix tween yields a real, positive duration.
    expect(tl.duration()).toBeGreaterThan(1.6);
    tl.kill();
    scene.cleanup(ctx(stage));
  });

  it('timeline() activation flips the root to active', async () => {
    const scene = splitDialogueEmail('sde-active', fullContent());
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sde-active');
    expect(root.dataset.pulsarTemplateActive).toBe('false');
    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    // The leading tl.call sets the root active; force it to fire.
    tl.progress(0.01);
    expect(root.dataset.pulsarTemplateActive).toBe('true');
    tl.kill();
    scene.cleanup(ctx(stage));
  });

  it('play() types each dialogue line into the DOM then reveals the email (176-206)', async () => {
    const scene = splitDialogueEmail('sde-play', fullContent());
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sde-play');
    const dialogue = requireNode(
      root.querySelector<HTMLElement>('[data-sde-dialogue]'),
      'dialogue',
    );
    const email = requireNode(root.querySelector<HTMLElement>('[data-sde-email]'), 'email');

    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    // Drive the timeline so the leading tl.call fires play().
    tl.progress(0.01);

    // The async reveal loop runs on real timers (typeBaseMs:1). Wait for
    // both dialogue lines to materialise and the email to fade in.
    await vi.waitFor(
      () => {
        expect(dialogue.querySelectorAll('li.sde__line')).toHaveLength(2);
        expect(email.classList.contains('sde__email--in')).toBe(true);
      },
      { timeout: 4000, interval: 10 },
    );

    const lines = [...dialogue.querySelectorAll<HTMLElement>('li.sde__line')];
    // Handles render verbatim into .sde__handle.
    expect(lines.map((li) => li.querySelector('.sde__handle')?.textContent)).toEqual([
      '@alex',
      '@sam',
    ]);
    // Text is typed character-by-character as .ph-char spans inside .sde__text;
    // the concatenated text equals the authored line text.
    const textSpans = lines.map((li) => li.querySelector<HTMLElement>('.sde__text'));
    expect(textSpans[0]?.querySelectorAll('.ph-char').length).toBe('draft it'.length);
    expect(textSpans[0]?.textContent).toBe('draft it');
    expect(textSpans[1]?.textContent).toBe('go now');

    // Email reveal: class added + style flipped to opaque.
    expect(email.getAttribute('style')).toBe('opacity:1');
    expect(email.classList.contains('sde__email--in')).toBe(true);

    tl.kill();
    scene.cleanup(ctx(stage));
    // Cleanup removed the scene root from the stage.
    expect(stage.querySelector('[data-pulsar-template="sde-play"]')).toBeNull();
  });

  it('onDeactivate aborts the play session so the email never reveals (80-83)', async () => {
    const scene = splitDialogueEmail('sde-abort', {
      dialogue: [
        // Long text so the typewriter is still running when we abort.
        { handle: '@a', text: 'this is a fairly long dialogue line that keeps typing' },
      ],
      email: { from: 'a', to: 'b', subject: 's', bodyParagraphs: ['body'] },
      typeBaseMs: 50,
      emailRevealAfterMs: 5,
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sde-abort');
    const email = requireNode(root.querySelector<HTMLElement>('[data-sde-email]'), 'email');

    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    tl.progress(0.01); // fires play()

    // Wait until play() has started building the dialogue line.
    await vi.waitFor(
      () => {
        expect(root.querySelectorAll('li.sde__line').length).toBeGreaterThan(0);
      },
      { timeout: 2000, interval: 5 },
    );

    // Fire the suffix tween's onComplete (onDeactivate) by jumping to the end.
    tl.progress(1);

    // Give the aborted async loop time to settle; it must NOT reveal the email.
    await new Promise((r) => setTimeout(r, 200));
    expect(email.classList.contains('sde__email--in')).toBe(false);
    expect(email.getAttribute('style')).toBe('opacity:0');

    tl.kill();
    scene.cleanup(ctx(stage));
  });

  it('play() uses default base/reveal delay when typeBaseMs/emailRevealAfterMs omitted (182, 201)', async () => {
    // No typeBaseMs and no emailRevealAfterMs -> base defaults to 22ms and
    // the email reveal dwell defaults to 400ms. Short single-char line so
    // the default-paced reveal still completes quickly.
    const scene = splitDialogueEmail('sde-defaults', {
      dialogue: [{ handle: '@a', text: 'x' }],
      email: { from: 'a', to: 'b', subject: 's', bodyParagraphs: ['body'] },
    });
    const stage = makeStage();
    scene.create(ctx(stage));
    const root = findRoot(stage, 'sde-defaults');
    const email = requireNode(root.querySelector<HTMLElement>('[data-sde-email]'), 'email');

    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    tl.progress(0.01);

    await vi.waitFor(
      () => {
        expect(root.querySelectorAll('li.sde__line')).toHaveLength(1);
        expect(email.classList.contains('sde__email--in')).toBe(true);
      },
      { timeout: 4000, interval: 10 },
    );
    expect(root.querySelector('.sde__text')?.textContent).toBe('x');
    expect(email.getAttribute('style')).toBe('opacity:1');

    tl.kill();
    scene.cleanup(ctx(stage));
  });

  it('play() returns early when its root is missing from the timeline ctx stage (177)', () => {
    const scene = splitDialogueEmail('sde-noroot', fullContent());
    const createStage = makeStage();
    scene.create(ctx(createStage));
    // Build the timeline against a DIFFERENT, empty stage. The leading
    // tl.call -> play() looks up the root in this stage, finds nothing,
    // and returns without throwing. The real root is untouched.
    const timelineStage = makeStage();
    const tl = scene.timeline(ctx(timelineStage)) as gsap.core.Timeline | null;
    // No stage root on timelineStage means buildTemplateTimeline still
    // returns a timeline (stage is non-null), and play() bails on null root.
    expect(tl).not.toBeNull();
    expect(() => (tl as gsap.core.Timeline).progress(0.01)).not.toThrow();
    expect(timelineStage.querySelector('li.sde__line')).toBeNull();
    (tl as gsap.core.Timeline).kill();
    scene.cleanup(ctx(createStage));
  });

  it('cleanup() removes the scene root and tears down the session (85-90)', () => {
    const scene = splitDialogueEmail('sde-cleanup', fullContent());
    const stage = makeStage();
    scene.create(ctx(stage));
    // Build + start the timeline so a session is registered.
    const tl = scene.timeline(ctx(stage)) as gsap.core.Timeline;
    tl.progress(0.01);
    expect(stage.querySelector('[data-pulsar-template="sde-cleanup"]')).not.toBeNull();

    tl.kill();
    scene.cleanup(ctx(stage));
    // Root removed.
    expect(stage.querySelector('[data-pulsar-template="sde-cleanup"]')).toBeNull();
    // A second cleanup is a no-op (session already deleted, root gone).
    expect(() => scene.cleanup(ctx(stage))).not.toThrow();
  });
});
