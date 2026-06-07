// Pulsar L2 template — presenter-driven scene tests: ctx validation,
// the gated body kick-off + its error arm, and cleanup (signal flip,
// deck cleanup invocation, throwing-cleanup catch arm).

import { gsap } from 'gsap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChromeSlots } from '../../src/system/chrome';
import {
  type PresenterDrivenCtx,
  presenterDrivenScene,
} from '../../src/system/templates/presenter-driven';
import { noopPresenterController as noopPresenter } from '../support/fakes';

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const fakeChrome = {} as unknown as ChromeSlots;

const makeRawCtx = (): unknown => ({
  presenter: noopPresenter,
  chrome: fakeChrome,
  audio: { id: 'audio' },
  gsap,
  stage: { id: 'stage' },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('presenterDrivenScene', () => {
  it('produces a valid indefinite-duration SceneModule', () => {
    const scene = presenterDrivenScene('pd-shape', {
      title: 'Cold open',
      run: async () => {},
    });
    expect(scene.id).toBe('pd-shape');
    expect(scene.title).toBe('Cold open');
    expect(scene.duration).toBeNull();
    expect(scene.tags).toEqual(['presenter-driven']);
    expect(scene.standalone).toBe(true);
    expect(scene.trailerSafe).toBe(false);
  });

  it('honours explicit tags / assets / audio / captions', () => {
    const scene = presenterDrivenScene('pd-meta', {
      title: 'Meta',
      tags: ['custom'],
      assets: ['/a.png', '/a.mp3'],
      audio: ['/a.mp3'],
      captions: [{ at: 0, text: 'hi' }],
      run: async () => {},
    });
    expect(scene.tags).toEqual(['custom']);
    expect(scene.assets).toEqual(['/a.png', '/a.mp3']);
    expect(scene.audio).toEqual(['/a.mp3']);
    expect(scene.captions).toHaveLength(1);
  });

  it('create ignores a non-object ctx', () => {
    const scene = presenterDrivenScene('pd-bad-ctx', { title: 'T', run: async () => {} });
    expect(() => scene.create(null as unknown as Parameters<typeof scene.create>[0])).not.toThrow();
  });

  it('create ignores a ctx missing presenter or chrome', () => {
    const scene = presenterDrivenScene('pd-partial', { title: 'T', run: async () => {} });
    expect(() =>
      scene.create({ presenter: noopPresenter } as unknown as Parameters<typeof scene.create>[0]),
    ).not.toThrow();
    expect(() =>
      scene.create({ chrome: fakeChrome } as unknown as Parameters<typeof scene.create>[0]),
    ).not.toThrow();
  });

  it('timeline returns null for a non-object ctx', () => {
    const scene = presenterDrivenScene('pd-tl-bad', { title: 'T', run: async () => {} });
    expect(scene.timeline(null as unknown as Parameters<typeof scene.timeline>[0])).toBeNull();
  });

  it('runs the body once the master timeline reaches the segment', async () => {
    const run = vi.fn(async (ctx: PresenterDrivenCtx) => {
      expect(ctx.presenter).toBe(noopPresenter);
      expect(ctx.chrome).toBe(fakeChrome);
      expect(ctx.signal.aborted).toBe(false);
    });
    const scene = presenterDrivenScene('pd-run', { title: 'Run', run });
    scene.create(makeRawCtx() as Parameters<typeof scene.create>[0]);
    const tl = scene.timeline(
      makeRawCtx() as Parameters<typeof scene.timeline>[0],
    ) as gsap.core.Timeline;
    expect(tl).not.toBeNull();
    // Drive the leading `tl.call` so the gated body fires.
    tl.progress(1);
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(1);
    tl.kill();
  });

  it('logs but does not throw when the body rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scene = presenterDrivenScene('pd-throw', {
      title: 'Throw',
      run: async () => {
        throw new Error('body boom');
      },
    });
    scene.create(makeRawCtx() as Parameters<typeof scene.create>[0]);
    const tl = scene.timeline(
      makeRawCtx() as Parameters<typeof scene.timeline>[0],
    ) as gsap.core.Timeline;
    tl.progress(1);
    await flushMicrotasks();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('pd-throw'),
      expect.any(Error),
    );
    tl.kill();
  });

  it('aborts the prior run when create is called again', async () => {
    let capturedSignal: { aborted: boolean } | null = null;
    const scene = presenterDrivenScene('pd-reentry', {
      title: 'Reentry',
      run: async (ctx) => {
        capturedSignal = ctx.signal;
      },
    });
    scene.create(makeRawCtx() as Parameters<typeof scene.create>[0]);
    const tl = scene.timeline(
      makeRawCtx() as Parameters<typeof scene.timeline>[0],
    ) as gsap.core.Timeline;
    tl.progress(1);
    await flushMicrotasks();
    expect(capturedSignal).not.toBeNull();
    // A navigation-superseded re-entry must abort the prior run record.
    scene.create(makeRawCtx() as Parameters<typeof scene.create>[0]);
    expect((capturedSignal as unknown as { aborted: boolean }).aborted).toBe(true);
    tl.kill();
  });

  it('cleanup flips the abort signal and invokes the deck cleanup', async () => {
    let capturedSignal: { aborted: boolean } | null = null;
    const deckCleanup = vi.fn();
    const scene = presenterDrivenScene('pd-cleanup', {
      title: 'Cleanup',
      run: async (ctx) => {
        capturedSignal = ctx.signal;
      },
      cleanup: deckCleanup,
    });
    scene.create(makeRawCtx() as Parameters<typeof scene.create>[0]);
    const tl = scene.timeline(
      makeRawCtx() as Parameters<typeof scene.timeline>[0],
    ) as gsap.core.Timeline;
    tl.progress(1);
    await flushMicrotasks();
    scene.cleanup({} as Parameters<typeof scene.cleanup>[0]);
    expect((capturedSignal as unknown as { aborted: boolean }).aborted).toBe(true);
    expect(deckCleanup).toHaveBeenCalledTimes(1);
    tl.kill();
  });

  it('cleanup swallows a throwing deck cleanup', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scene = presenterDrivenScene('pd-cleanup-throw', {
      title: 'Cleanup throw',
      run: async () => {},
      cleanup: () => {
        throw new Error('cleanup boom');
      },
    });
    scene.create(makeRawCtx() as Parameters<typeof scene.create>[0]);
    expect(() => scene.cleanup({} as Parameters<typeof scene.cleanup>[0])).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('pd-cleanup-throw'),
      expect.any(Error),
    );
  });

  it('cleanup is safe with no active run and no deck cleanup', () => {
    const scene = presenterDrivenScene('pd-cleanup-inert', { title: 'T', run: async () => {} });
    expect(() => scene.cleanup({} as Parameters<typeof scene.cleanup>[0])).not.toThrow();
  });
});
