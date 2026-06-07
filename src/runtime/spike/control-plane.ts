// SPIKE (issue #162) — single imperative scene control plane.
//
// Throwaway-or-graduate proof for ADR-032. Lives under src/runtime/spike/
// so it is clearly isolated from the existing (master-timeline) L1 and can
// be deleted wholesale if the spike says "flip to nuke".
//
// The whole point: one clock, one owner of scene lifecycle. A scene is an
// async function. Cancellation is by THROW — `ctx.sleep` / `ctx.hold` /
// `ctx.runTimeline` reject with `SceneCancelled` when the scene ends
// (presenter advance OR navigation supersession). The body unwinds on its
// own; the run-loop catches the throw and runs deterministic teardown. No
// abort-polling, no `{ controller }` threading, no per-scene try/finally
// for runtime-owned resources — that is the ADR-032 promise made concrete.

import { clearAct, clearBrand, clearTitle, resetFlickers } from '../../system/chrome';
import type { ChromeSlots } from '../../system/chrome';
import type { AudioService } from '../audio';
import type { PresenterController } from '../presenter';

/** Thrown out of `sleep`/`hold`/`runTimeline` when the scene is ended. */
export class SceneCancelled extends Error {
  constructor() {
    super('scene cancelled');
    this.name = 'SceneCancelled';
  }
}

export const isSceneCancelled = (err: unknown): err is SceneCancelled =>
  err instanceof SceneCancelled ||
  (typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'SceneCancelled');

/** Minimal GSAP timeline shape the control plane drives + scenes author on. */
export interface ControllableTimeline {
  play(): unknown;
  kill(): unknown;
  eventCallback(type: 'onComplete', callback: (() => void) | null): unknown;
  to(
    target: unknown,
    vars: Record<string, unknown>,
    position?: number | string,
  ): ControllableTimeline;
  from(
    target: unknown,
    vars: Record<string, unknown>,
    position?: number | string,
  ): ControllableTimeline;
  set(
    target: unknown,
    vars: Record<string, unknown>,
    position?: number | string,
  ): ControllableTimeline;
}

/** Minimal GSAP entry the scene context exposes (per-scene animation only). */
export interface GsapLike {
  timeline(opts?: Record<string, unknown>): ControllableTimeline;
}

/**
 * The bounded context a scene body receives. Every time/animation/audio
 * primitive here is already end-bound — the scene never sees the abort
 * machinery.
 */
export interface SceneCtx {
  readonly chrome: ChromeSlots;
  readonly audio: AudioService | undefined;
  readonly gsap: GsapLike | undefined;
  /**
   * Fires when the scene ends (advance or supersession). Pass to L2
   * helpers that already accept an `AbortSignal` (`typeInto`, `typeNode`)
   * so they snap-complete cleanly. Scenes do NOT poll it.
   */
  readonly signal: AbortSignal;
  /** Dwell `ms`. Rejects `SceneCancelled` if the scene ends first. */
  sleep(ms: number): Promise<void>;
  /** Hold until the scene ends. Always rejects `SceneCancelled`. */
  hold(): Promise<never>;
  /** Play a per-scene GSAP timeline; resolve on its completion, reject on scene end. */
  runTimeline(tl: ControllableTimeline): Promise<void>;
  /** Fire-and-forget async (typing, topology). `SceneCancelled` is swallowed. */
  spawn(fn: () => Promise<void>): void;
  /** Register a teardown callback the control plane runs on scene exit (LIFO). */
  dispose(fn: () => void): void;
}

export interface SpikeScene {
  readonly id: string;
  run(ctx: SceneCtx): Promise<void>;
}

export interface RunDeps {
  readonly chrome: ChromeSlots;
  readonly audio?: AudioService;
  readonly gsap?: GsapLike;
  readonly presenter?: PresenterController;
  /** Navigation supersession signal (jump away / teardown the whole run). */
  readonly navSignal: AbortSignal;
  readonly onError?: (err: unknown) => void;
  /** Test seam for the post-fade audio stop; defaults to global setTimeout. */
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
}

type EndReason = 'advance' | 'superseded';

const report = (deps: RunDeps, err: unknown): void => {
  if (deps.onError !== undefined) {
    try {
      deps.onError(err);
    } catch {
      // a throwing sink must not break teardown
    }
  }
};

/**
 * Generic chrome reset between scenes — the control plane owns it so no
 * scene hand-writes a `finally` to wipe title/brand/act/center. Idempotent.
 */
const resetChrome = (chrome: ChromeSlots): void => {
  clearTitle(chrome);
  clearBrand(chrome);
  clearAct(chrome);
  resetFlickers(chrome);
  chrome.center.classList.remove('show');
  chrome.center.innerHTML = '';
};

/** Run one scene to its end and tear it down. Returns why it ended. */
async function runScene(scene: SpikeScene, deps: RunDeps): Promise<EndReason> {
  const end = new AbortController();
  let reason: EndReason | null = null;
  const finish = (r: EndReason): void => {
    if (reason !== null) return;
    reason = r;
    end.abort();
  };

  const unsub = deps.presenter?.subscribe((cmd) => {
    if (cmd.kind === 'advance' || cmd.kind === 'skip-forward') finish('advance');
  });
  const onNav = (): void => finish('superseded');
  if (deps.navSignal.aborted) finish('superseded');
  else deps.navSignal.addEventListener('abort', onNav, { once: true });

  const disposers: Array<() => void> = [];
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms)); // PUL-Q001-allow: control-plane dwell timer; screenshot mode is removed under ADR-032 and never runs scenes through this path.

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (end.signal.aborted) {
        reject(new SceneCancelled());
        return;
      }
      const timer = setTimer(() => {
        end.signal.removeEventListener('abort', onEnd);
        resolve();
      }, ms) as ReturnType<typeof setTimeout>;
      const onEnd = (): void => {
        clearTimeout(timer);
        reject(new SceneCancelled());
      };
      end.signal.addEventListener('abort', onEnd, { once: true });
    });

  const hold = (): Promise<never> =>
    new Promise<never>((_resolve, reject) => {
      if (end.signal.aborted) {
        reject(new SceneCancelled());
        return;
      }
      end.signal.addEventListener('abort', () => reject(new SceneCancelled()), { once: true });
    });

  const runTimeline = (tl: ControllableTimeline): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (end.signal.aborted) {
        tl.kill();
        reject(new SceneCancelled());
        return;
      }
      const onEnd = (): void => {
        tl.kill();
        reject(new SceneCancelled());
      };
      tl.eventCallback('onComplete', () => {
        end.signal.removeEventListener('abort', onEnd);
        resolve();
      });
      end.signal.addEventListener('abort', onEnd, { once: true });
      tl.play();
    });

  const spawn = (fn: () => Promise<void>): void => {
    void fn().catch((err) => {
      if (!isSceneCancelled(err)) report(deps, err);
    });
  };

  const dispose = (fn: () => void): void => {
    disposers.push(fn);
  };

  const ctx: SceneCtx = {
    chrome: deps.chrome,
    audio: deps.audio,
    gsap: deps.gsap,
    signal: end.signal,
    sleep,
    hold,
    runTimeline,
    spawn,
    dispose,
  };

  try {
    await scene.run(ctx);
    // Body completed on its own → hold at the scene boundary until the
    // presenter advances (or navigation supersedes).
    if (reason === null) {
      await new Promise<void>((resolve) => {
        end.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  } catch (err) {
    if (!isSceneCancelled(err)) report(deps, err);
  } finally {
    unsub?.();
    deps.navSignal.removeEventListener('abort', onNav);
    // Teardown LIFO; one throwing disposer must not skip the rest.
    for (let i = disposers.length - 1; i >= 0; i--) {
      try {
        (disposers[i] as () => void)();
      } catch (err) {
        report(deps, err);
      }
    }
    resetChrome(deps.chrome);
  }

  return reason ?? 'advance';
}

/**
 * Sequence an ordered scene list through one control plane. This replaces
 * `composeMasterTimeline` + advance-gate sequencing: run scene → await end
 * → tear down → next. A supersession stops the whole run.
 */
export async function runScenes(scenes: readonly SpikeScene[], deps: RunDeps): Promise<void> {
  for (const scene of scenes) {
    if (deps.navSignal.aborted) return;
    const reason = await runScene(scene, deps);
    if (reason === 'superseded') return;
  }
}
