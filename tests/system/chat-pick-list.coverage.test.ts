/** @vitest-environment happy-dom */
// Pulsar L2 — chatPickList behavioral coverage.
//
// templates-options.test.ts asserts the static DOM chatPickList mounts
// (prompt handle, item subs, caption node). It does NOT exercise the
// runtime `play` behavior the template ships for: the timeline-driven
// pick highlight / dim cascade, the caption opacity reveal, the
// per-navigation abort (onDeactivate), or session teardown on cleanup.
//
// These tests drive the real GSAP timeline + the real abortable
// `aSleep` dwell (via fake timers) against the real happy-dom document
// so a regression in the pick logic, the stagger maths, the caption
// reveal, the abort flag, or the cleanup teardown FAILS the suite.

import { gsap } from 'gsap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSceneModule } from '../../src/runtime/scene';
import { chatPickList } from '../../src/system/templates/chat-pick-list';

const makeStage = (): HTMLElement => document.createElement('div');
const ctx = (stage: HTMLElement): unknown => ({ stage, mode: 'present', gsap });

const requireNode = (node: HTMLElement | null | undefined, message: string): HTMLElement => {
  expect(node, message).toBeTruthy();
  if (node === null || node === undefined) throw new Error(message);
  return node;
};

const mount = (
  scene: ReturnType<typeof chatPickList>,
): { stage: HTMLElement; root: HTMLElement; fakeCtx: unknown } => {
  const stage = makeStage();
  const fakeCtx = ctx(stage);
  scene.create(fakeCtx);
  const root = requireNode(
    stage.querySelector<HTMLElement>('[data-pulsar-template]'),
    'expected mounted chat-pick-list root',
  );
  return { stage, root, fakeCtx };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('chatPickList — static DOM surface', () => {
  it('mounts a chat-pick-list root with prompt handle, prompt text, and a stagger-indexed list', () => {
    const scene = chatPickList('cpl-static', {
      promptHandle: '@orchestrator',
      promptMessage: 'Pick a target',
      items: [
        { label: 'Alpha', sub: 'primary node' },
        { label: 'Bravo' },
        { label: 'Charlie', sub: 'fallback' },
      ],
      pickIndex: 1,
      staggerMs: 100,
    });
    expect(() => assertSceneModule(scene)).not.toThrow();

    const { root } = mount(scene);

    // template-kind class + queryable root attribute.
    expect(root.tagName.toLowerCase()).toBe('section');
    expect(root.classList.contains('pulsar-template--chat-pick-list')).toBe(true);
    expect(root.getAttribute('data-pulsar-template')).toBe('cpl-static');
    expect(root.dataset.pulsarTemplateActive).toBe('false');

    // Prompt bubble: handle span (line 55-59) + prompt text (line 61-64).
    const handle = requireNode(
      root.querySelector<HTMLElement>('.cpl__prompt-handle'),
      'expected prompt handle',
    );
    expect(handle.tagName.toLowerCase()).toBe('span');
    expect(handle.textContent).toBe('@orchestrator');
    const promptText = requireNode(
      root.querySelector<HTMLElement>('.cpl__prompt-text'),
      'expected prompt text',
    );
    expect(promptText.tagName.toLowerCase()).toBe('p');
    expect(promptText.textContent).toBe('Pick a target');

    // List container (line 66-68): an <ol> carrying the data-cpl-list marker.
    const list = requireNode(root.querySelector<HTMLElement>('.cpl__list'), 'expected ol list');
    expect(list.tagName.toLowerCase()).toBe('ol');
    expect(list.getAttribute('data-cpl-list')).toBe('');

    // Items (line 70-86): one <li> per item, indexed + stagger-delayed.
    const items = [...root.querySelectorAll<HTMLElement>('[data-cpl-index]')];
    expect(items).toHaveLength(3);
    expect(items.map((li) => li.getAttribute('data-cpl-index'))).toEqual(['0', '1', '2']);
    expect(items.map((li) => li.tagName.toLowerCase())).toEqual(['li', 'li', 'li']);
    // staggerMs=100 -> --cpl-delay = i*100ms.
    expect(items.map((li) => li.getAttribute('style'))).toEqual([
      '--cpl-delay: 0ms',
      '--cpl-delay: 100ms',
      '--cpl-delay: 200ms',
    ]);
    // Labels render verbatim.
    expect(items.map((li) => li.querySelector('.cpl__label')?.textContent)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
    // Sub renders only for items that supply one (line 79-84).
    expect(items.map((li) => li.querySelector('.cpl__sub')?.textContent ?? null)).toEqual([
      'primary node',
      null,
      'fallback',
    ]);
  });

  it('omits the prompt handle span when promptHandle is not supplied', () => {
    const scene = chatPickList('cpl-no-handle', {
      promptMessage: 'Decide',
      items: [{ label: 'Only' }],
      pickIndex: 0,
    });
    const { root } = mount(scene);
    expect(root.querySelector('.cpl__prompt-handle')).toBeNull();
    // Prompt text still renders.
    expect(root.querySelector('.cpl__prompt-text')?.textContent).toBe('Decide');
  });

  it('omits the pick-caption node when pickCaption is not supplied', () => {
    const scene = chatPickList('cpl-no-caption', {
      promptMessage: 'Decide',
      items: [{ label: 'A' }, { label: 'B' }],
      pickIndex: 0,
    });
    const { root } = mount(scene);
    expect(root.querySelector('[data-cpl-caption]')).toBeNull();
    expect(root.querySelector('.cpl__pick-caption')).toBeNull();
  });

  it('renders an initially-hidden pick-caption when pickCaption is supplied (line 88-95)', () => {
    const scene = chatPickList('cpl-caption-dom', {
      promptMessage: 'Decide',
      items: [{ label: 'A' }, { label: 'B' }],
      pickIndex: 0,
      pickCaption: 'Committed to A',
    });
    const { root } = mount(scene);
    const cap = requireNode(
      root.querySelector<HTMLElement>('.cpl__pick-caption'),
      'expected pick caption',
    );
    expect(cap.tagName.toLowerCase()).toBe('p');
    expect(cap.getAttribute('data-cpl-caption')).toBe('');
    expect(cap.textContent).toBe('Committed to A');
    // Starts hidden; play() flips opacity later.
    expect(cap.getAttribute('style')).toBe('opacity:0');
    expect(cap.classList.contains('cpl__pick-caption--in')).toBe(false);
  });

  it('exposes prompt + per-item captions (line 43-45) in authored order', () => {
    const scene = chatPickList('cpl-captions', {
      promptMessage: 'Pick',
      items: [{ label: 'First' }, { label: 'Second' }],
      pickIndex: 0,
    });
    expect(scene.captions.map((c) => ({ at: c.at, text: c.text }))).toEqual([
      { at: 'prompt', text: 'Pick' },
      { at: 'item-0', text: 'First' },
      { at: 'item-1', text: 'Second' },
    ]);
  });
});

describe('chatPickList — timeline authoring', () => {
  it('returns a real timeline carrying the cpl-in label and a non-zero duration', () => {
    const scene = chatPickList('cpl-tl-labels', {
      promptMessage: 'Pick',
      items: [{ label: 'A' }, { label: 'B' }],
      pickIndex: 0,
    });
    const { fakeCtx } = mount(scene);
    const tl = scene.timeline(fakeCtx) as gsap.core.Timeline;
    try {
      expect(tl).not.toBeNull();
      expect(typeof tl.duration).toBe('function');
      // Authored beat label is present (buildSegments, line 105).
      expect(tl.labels['cpl-in']).toBe(0);
      // Leading activation call + the 1.2s play dwell give the timeline its
      // duration. ADR-032: no trailing suffix tween / advance gate is added.
      expect(tl.duration()).toBeGreaterThanOrEqual(1.2);
    } finally {
      tl.kill();
    }
  });

  it('returns null when the runtime has no stage', () => {
    const scene = chatPickList('cpl-no-stage', {
      promptMessage: 'Pick',
      items: [{ label: 'A' }],
      pickIndex: 0,
    });
    const stagelessCtx = { stage: null, mode: 'present', gsap };
    scene.create(stagelessCtx);
    expect(scene.timeline(stagelessCtx)).toBeNull();
  });
});

describe('chatPickList — play() pick/dim cascade (timeline-driven)', () => {
  it('marks the pick index and dims the rest after stagger + dwell, then reveals the caption', async () => {
    vi.useFakeTimers();
    const scene = chatPickList('cpl-play', {
      promptMessage: 'Pick a target',
      items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      pickIndex: 2,
      staggerMs: 100,
      pickAfterMs: 300,
      pickCaption: 'Locked',
    });
    const { root, fakeCtx } = mount(scene);
    const tl = scene.timeline(fakeCtx) as gsap.core.Timeline;
    try {
      const items = [...root.querySelectorAll<HTMLElement>('[data-cpl-index]')];
      const caption = requireNode(
        root.querySelector<HTMLElement>('[data-cpl-caption]'),
        'expected caption',
      );

      // Drive the leading play() call without reaching the trailing
      // onComplete (which would abort the session). Seek mid-timeline.
      tl.seek(0.5, false);

      // Before the stagger window elapses: no pick/dim classes yet.
      expect(items.some((li) => li.classList.contains('cpl__item--pick'))).toBe(false);
      expect(items.some((li) => li.classList.contains('cpl__item--dim'))).toBe(false);

      // play() awaits total*stagger (3*100=300ms) then pickAfter (300ms)
      // before applying classes. Advance just short of the threshold.
      await vi.advanceTimersByTimeAsync(300 + 300 - 1);
      expect(items.some((li) => li.classList.contains('cpl__item--pick'))).toBe(false);

      // Cross the threshold: pick at index 2, dim everyone else.
      await vi.advanceTimersByTimeAsync(1);
      expect(items[0]?.classList.contains('cpl__item--dim')).toBe(true);
      expect(items[1]?.classList.contains('cpl__item--dim')).toBe(true);
      expect(items[2]?.classList.contains('cpl__item--pick')).toBe(true);
      expect(items[2]?.classList.contains('cpl__item--dim')).toBe(false);
      expect(items[0]?.classList.contains('cpl__item--pick')).toBe(false);

      // Caption stays hidden until a further 220ms dwell elapses.
      expect(caption.getAttribute('style')).toBe('opacity:0');
      await vi.advanceTimersByTimeAsync(219);
      expect(caption.getAttribute('style')).toBe('opacity:0');
      await vi.advanceTimersByTimeAsync(1);
      expect(caption.getAttribute('style')).toBe('opacity:1');
      expect(caption.classList.contains('cpl__pick-caption--in')).toBe(true);
    } finally {
      tl.kill();
    }
  });

  it('uses the default 600ms pickAfter dwell when pickAfterMs is omitted', async () => {
    vi.useFakeTimers();
    const scene = chatPickList('cpl-default-dwell', {
      promptMessage: 'Pick',
      items: [{ label: 'A' }, { label: 'B' }],
      pickIndex: 0,
      staggerMs: 100,
    });
    const { root, fakeCtx } = mount(scene);
    const tl = scene.timeline(fakeCtx) as gsap.core.Timeline;
    try {
      const items = [...root.querySelectorAll<HTMLElement>('[data-cpl-index]')];
      tl.seek(0.5, false);
      // total*stagger = 2*100 = 200ms, default pickAfter = 600ms -> 800ms.
      await vi.advanceTimersByTimeAsync(799);
      expect(items.some((li) => li.classList.contains('cpl__item--pick'))).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(items[0]?.classList.contains('cpl__item--pick')).toBe(true);
      expect(items[1]?.classList.contains('cpl__item--dim')).toBe(true);
    } finally {
      tl.kill();
    }
  });

  it('does not throw and applies no caption mutation when there is no pickCaption', async () => {
    vi.useFakeTimers();
    const scene = chatPickList('cpl-no-cap-play', {
      promptMessage: 'Pick',
      items: [{ label: 'A' }, { label: 'B' }],
      pickIndex: 1,
      staggerMs: 50,
      pickAfterMs: 50,
    });
    const { root, fakeCtx } = mount(scene);
    const tl = scene.timeline(fakeCtx) as gsap.core.Timeline;
    try {
      const items = [...root.querySelectorAll<HTMLElement>('[data-cpl-index]')];
      tl.seek(0.5, false);
      await vi.advanceTimersByTimeAsync(2 * 50 + 50 + 500);
      expect(items[1]?.classList.contains('cpl__item--pick')).toBe(true);
      expect(items[0]?.classList.contains('cpl__item--dim')).toBe(true);
      // No caption node was ever rendered, so no caption mutation occurs.
      expect(root.querySelector('[data-cpl-caption]')).toBeNull();
    } finally {
      tl.kill();
    }
  });
});

describe('chatPickList — abort & teardown', () => {
  it('cleanup aborts an in-flight pick so the highlight is never applied', async () => {
    vi.useFakeTimers();
    const scene = chatPickList('cpl-abort', {
      promptMessage: 'Pick',
      items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      pickIndex: 1,
      staggerMs: 100,
      pickAfterMs: 300,
      pickCaption: 'Locked',
    });
    const { root, fakeCtx } = mount(scene);
    const tl = scene.timeline(fakeCtx) as gsap.core.Timeline;
    try {
      const items = [...root.querySelectorAll<HTMLElement>('[data-cpl-index]')];

      // Start the play() chain.
      tl.seek(0.5, false);
      // Advance partway through the stagger window but BEFORE the pick fires.
      await vi.advanceTimersByTimeAsync(100);

      // ADR-032: the run-loop calls cleanup on scene exit; that sets the
      // session abort flag (the timeline no longer fires it on complete).
      tl.kill();
      scene.cleanup(fakeCtx);

      // Drain any remaining dwell; the aborted chain must bail out and
      // leave the DOM untouched.
      await vi.advanceTimersByTimeAsync(5000);

      expect(items.some((li) => li.classList.contains('cpl__item--pick'))).toBe(false);
      expect(items.some((li) => li.classList.contains('cpl__item--dim'))).toBe(false);
      const caption = root.querySelector<HTMLElement>('[data-cpl-caption]');
      expect(caption?.getAttribute('style')).toBe('opacity:0');
    } finally {
      tl.kill();
    }
  });

  it('cleanup removes the scene root and aborts any in-flight pick', async () => {
    vi.useFakeTimers();
    const scene = chatPickList('cpl-cleanup', {
      promptMessage: 'Pick',
      items: [{ label: 'A' }, { label: 'B' }],
      pickIndex: 0,
      staggerMs: 100,
      pickAfterMs: 300,
      pickCaption: 'Locked',
    });
    const { stage, root, fakeCtx } = mount(scene);
    const tl = scene.timeline(fakeCtx) as gsap.core.Timeline;
    try {
      const items = [...root.querySelectorAll<HTMLElement>('[data-cpl-index]')];
      tl.seek(0.5, false);
      await vi.advanceTimersByTimeAsync(100);

      // Root present before cleanup.
      expect(stage.querySelector('[data-pulsar-template="cpl-cleanup"]')).not.toBeNull();

      scene.cleanup(fakeCtx);

      // Root removed (line 120).
      expect(stage.querySelector('[data-pulsar-template="cpl-cleanup"]')).toBeNull();
      expect(root.isConnected).toBe(false);

      // The detached items must never receive pick/dim classes since the
      // session was aborted + deleted (line 115-119).
      await vi.advanceTimersByTimeAsync(5000);
      expect(items.some((li) => li.classList.contains('cpl__item--pick'))).toBe(false);
      expect(items.some((li) => li.classList.contains('cpl__item--dim'))).toBe(false);
    } finally {
      tl.kill();
    }
  });

  it('cleanup is a safe no-op when no session was ever started', () => {
    const scene = chatPickList('cpl-cleanup-nosession', {
      promptMessage: 'Pick',
      items: [{ label: 'A' }],
      pickIndex: 0,
    });
    const { stage, fakeCtx } = mount(scene);
    // No timeline driven -> no session registered. cleanup still removes
    // the root without throwing.
    expect(() => scene.cleanup(fakeCtx)).not.toThrow();
    expect(stage.querySelector('[data-pulsar-template="cpl-cleanup-nosession"]')).toBeNull();
  });
});
