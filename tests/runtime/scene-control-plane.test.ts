// @vitest-environment happy-dom
//
// Permanent guard for the single imperative scene control plane (ADR-032,
// issue #162). Self-contained — inline scenes only, no deck dependency — so
// it stays green on a fresh clone. Proves the invariants the control plane
// exists to guarantee:
//   - ordered sequencing (advance moves to the next scene)
//   - runtime-owned chrome reset between scenes (no scene `finally`)
//   - deterministic teardown: disposers run, spawned async dies (no
//     resurrection), all on advance — with no abort-polling in the scene
//   - `runTimeline` resolves on timeline completion and the body continues
//   - navigation supersession stops the whole run and still tears down

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PresenterCommand, createPresenterController } from '../../src/runtime/presenter';
import {
  type ControllableTimeline,
  type GsapLike,
  type SpikeScene,
  runScenes,
} from '../../src/runtime/spike/control-plane';
import { mountChromeSlots } from '../../src/system/chrome';

const makeFakeGsap = (): GsapLike => ({
  timeline: () => {
    let onComplete: (() => void) | null = null;
    const tl: ControllableTimeline = {
      from: () => tl,
      to: () => tl,
      set: () => tl,
      eventCallback: (_type, cb) => {
        onComplete = cb;
        return tl;
      },
      play: () => {
        setTimeout(() => onComplete?.(), 0);
        return tl;
      },
      kill: () => tl,
    };
    return tl;
  },
});

function setup() {
  const surface = document.createElement('div');
  document.body.appendChild(surface);
  const chrome = mountChromeSlots({ surface, ownerDocument: document });
  const navController = new AbortController();
  let handler: ((cmd: PresenterCommand) => void) | null = null;
  const source = {
    subscribe(h: (cmd: PresenterCommand) => void) {
      handler = h;
      return () => {
        if (handler === h) handler = null;
      };
    },
  };
  const presenter = createPresenterController(source, navController.signal, () => {});
  const deps = {
    chrome,
    gsap: makeFakeGsap(),
    presenter,
    navSignal: navController.signal,
    onError: () => {},
  };
  return {
    chrome,
    navController,
    deps,
    emit: (kind: PresenterCommand['kind']) => handler?.({ kind }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('scene control plane', () => {
  it('advances between scenes, resets chrome, and tears down spawned async', async () => {
    const trace = { disposed: 0, ticks: 0 };
    const sceneA: SpikeScene = {
      id: 'a',
      run: async (ctx) => {
        ctx.chrome.title.innerHTML = '<h1>A</h1>';
        ctx.dispose(() => {
          trace.disposed++;
        });
        ctx.spawn(async () => {
          // No abort-polling: advance throws out of ctx.sleep and ends this.
          while (true) {
            await ctx.sleep(10);
            trace.ticks++;
          }
        });
        await ctx.hold();
      },
    };
    const sceneB: SpikeScene = {
      id: 'b',
      run: async (ctx) => {
        ctx.chrome.title.innerHTML = '<h1>B</h1>';
        await ctx.hold();
      },
    };

    const ctx = setup();
    const done = runScenes([sceneA, sceneB], ctx.deps);

    await vi.advanceTimersByTimeAsync(35);
    expect(ctx.chrome.title.innerHTML).toContain('A');
    expect(trace.ticks).toBeGreaterThan(0);

    ctx.emit('advance');
    await vi.advanceTimersByTimeAsync(5);

    // runtime ran the disposer and reset chrome; scene B is now live
    expect(trace.disposed).toBe(1);
    expect(ctx.chrome.title.innerHTML).toContain('B');

    // the spawned loop is dead — a stranded loop would keep ticking
    const frozen = trace.ticks;
    await vi.advanceTimersByTimeAsync(500);
    expect(trace.ticks).toBe(frozen);

    ctx.navController.abort();
    await vi.advanceTimersByTimeAsync(5);
    await done;
  });

  it('runTimeline resolves on completion and the body continues', async () => {
    const sceneC: SpikeScene = {
      id: 'c',
      run: async (ctx) => {
        const tl = ctx.gsap?.timeline();
        if (tl === undefined) return;
        tl.from({}, { opacity: 0 });
        await ctx.runTimeline(tl);
        ctx.chrome.title.innerHTML = '<h1>C-done</h1>';
      },
    };

    const ctx = setup();
    const done = runScenes([sceneC], ctx.deps);

    await vi.advanceTimersByTimeAsync(5);
    expect(ctx.chrome.title.innerHTML).toContain('C-done');

    ctx.navController.abort();
    await vi.advanceTimersByTimeAsync(5);
    await done;
  });

  it('supersession stops the run and still tears down', async () => {
    const trace = { disposed: 0 };
    const sceneA: SpikeScene = {
      id: 'a',
      run: async (ctx) => {
        ctx.chrome.title.innerHTML = '<h1>A</h1>';
        ctx.dispose(() => {
          trace.disposed++;
        });
        await ctx.hold();
      },
    };
    const sceneB: SpikeScene = {
      id: 'b',
      run: async (ctx) => {
        ctx.chrome.title.innerHTML = '<h1>B</h1>';
        await ctx.hold();
      },
    };

    const ctx = setup();
    const done = runScenes([sceneA, sceneB], ctx.deps);

    await vi.advanceTimersByTimeAsync(10);
    ctx.navController.abort();
    await vi.advanceTimersByTimeAsync(5);
    await done; // resolves — run stopped

    expect(trace.disposed).toBe(1);
    expect(ctx.chrome.title.innerHTML).not.toContain('B');
  });
});
