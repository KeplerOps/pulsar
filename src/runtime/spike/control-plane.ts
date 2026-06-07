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
import type { SceneModule } from '../scene';

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

const report = (deps: { readonly onError?: (err: unknown) => void }, err: unknown): void => {
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

interface EndGate {
  /** Fires when the scene ends (presenter advance OR navigation supersession). */
  readonly signal: AbortSignal;
  getReason(): EndReason;
  /** Detach presenter + navigation listeners. Call in teardown. */
  unwire(): void;
}

/** Wire presenter advance + navigation supersession into a single end signal. */
function createEndGate(deps: {
  readonly presenter?: PresenterController;
  readonly navSignal: AbortSignal;
}): EndGate {
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
  return {
    signal: end.signal,
    getReason: () => reason ?? 'advance',
    unwire: () => {
      unsub?.();
      deps.navSignal.removeEventListener('abort', onNav);
    },
  };
}

/** Resolve when the scene's end signal fires — the post-completion advance hold. */
const holdUntilEnd = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });

/** Play `tl` to natural completion; reject `SceneCancelled` when the scene ends first. */
const playUntilEnd = (tl: ControllableTimeline, endSignal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (endSignal.aborted) {
      tl.kill();
      reject(new SceneCancelled());
      return;
    }
    const onEnd = (): void => {
      tl.kill();
      reject(new SceneCancelled());
    };
    tl.eventCallback('onComplete', () => {
      endSignal.removeEventListener('abort', onEnd);
      resolve();
    });
    endSignal.addEventListener('abort', onEnd, { once: true });
    tl.play();
  });

/** Run one async-body (spike) scene to its end and tear it down. */
async function runScene(scene: SpikeScene, deps: RunDeps): Promise<EndReason> {
  const gate = createEndGate(deps);
  const disposers: Array<() => void> = [];
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms)); // PUL-Q001-allow: control-plane dwell timer; screenshot mode is removed under ADR-032 and never runs scenes through this path.

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (gate.signal.aborted) {
        reject(new SceneCancelled());
        return;
      }
      const timer = setTimer(() => {
        gate.signal.removeEventListener('abort', onEnd);
        resolve();
      }, ms) as ReturnType<typeof setTimeout>;
      const onEnd = (): void => {
        clearTimeout(timer);
        reject(new SceneCancelled());
      };
      gate.signal.addEventListener('abort', onEnd, { once: true });
    });

  const hold = (): Promise<never> =>
    new Promise<never>((_resolve, reject) => {
      if (gate.signal.aborted) {
        reject(new SceneCancelled());
        return;
      }
      gate.signal.addEventListener('abort', () => reject(new SceneCancelled()), { once: true });
    });

  const spawn = (fn: () => Promise<void>): void => {
    void fn().catch((err) => {
      if (!isSceneCancelled(err)) report(deps, err);
    });
  };

  const ctx: SceneCtx = {
    chrome: deps.chrome,
    audio: deps.audio,
    gsap: deps.gsap,
    signal: gate.signal,
    sleep,
    hold,
    runTimeline: (tl) => playUntilEnd(tl, gate.signal),
    spawn,
    dispose: (fn) => {
      disposers.push(fn);
    },
  };

  try {
    await scene.run(ctx);
    // Body completed on its own → hold at the boundary until advance / supersede.
    await holdUntilEnd(gate.signal);
  } catch (err) {
    if (!isSceneCancelled(err)) report(deps, err);
  } finally {
    gate.unwire();
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

  return gate.getReason();
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

// ---------------------------------------------------------------------------
// Real SceneModule driver — runs the EXISTING create/timeline/cleanup contract
// through the same imperative loop, no master timeline. The committed decks
// (pulsar-intro, aces) and every `buildTemplateScene` ride on this unchanged:
// per scene we mount via create(), play the per-scene GSAP timeline standalone
// and await its completion, hold for advance, then cleanup() and reset chrome.
// ---------------------------------------------------------------------------

/** A SceneModule's `timeline(ctx)` value is playable when it quacks like a GSAP timeline. */
const asPlayableTimeline = (value: unknown): ControllableTimeline | null => {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as ControllableTimeline).play === 'function' &&
    typeof (value as ControllableTimeline).kill === 'function' &&
    typeof (value as ControllableTimeline).eventCallback === 'function'
  ) {
    return value as ControllableTimeline;
  }
  return null;
};

export interface RunModuleDeps {
  /** L2 chrome slots reset between scenes; omit in non-DOM/headless runs. */
  readonly chrome?: ChromeSlots;
  readonly audio?: AudioService;
  readonly presenter?: PresenterController;
  /** Navigation supersession signal (jump away / teardown the whole run). */
  readonly navSignal: AbortSignal;
  readonly onError?: (err: unknown) => void;
  /** Build the per-scene ctx (e.g. WorkbenchSceneCtx) the SceneModule hooks consume. `index` is the scene's position in the slice (disambiguates repeated scene ids). */
  readonly buildCtx: (scene: SceneModule, index: number) => unknown;
  /** Optional per-scene asset preload, awaited before the scene mounts. */
  readonly preload?: (scene: SceneModule) => void | Promise<void>;
}

/** Mount the scene, play its standalone timeline to completion, then hold for advance. */
async function playModuleBody(
  scene: SceneModule,
  ctx: unknown,
  endSignal: AbortSignal,
): Promise<void> {
  await Promise.resolve(scene.create(ctx));
  if (endSignal.aborted) return;
  const tl = asPlayableTimeline(scene.timeline(ctx));
  if (tl !== null) {
    try {
      await playUntilEnd(tl, endSignal);
    } catch (err) {
      if (!isSceneCancelled(err)) throw err;
    }
  }
  // Scene content done → hold at the boundary until advance / supersession.
  await holdUntilEnd(endSignal);
}

/** Run one real SceneModule to its end and tear it down. Returns why it ended. */
async function runOneModule(
  scene: SceneModule,
  index: number,
  deps: RunModuleDeps,
): Promise<EndReason> {
  const gate = createEndGate(deps);
  const ctx = deps.buildCtx(scene, index);
  try {
    if (deps.preload !== undefined) await deps.preload(scene);
    await playModuleBody(scene, ctx, gate.signal);
  } catch (err) {
    if (!isSceneCancelled(err)) report(deps, err);
  } finally {
    gate.unwire();
    try {
      await Promise.resolve(scene.cleanup(ctx));
    } catch (err) {
      report(deps, err);
    }
    if (deps.chrome !== undefined) resetChrome(deps.chrome);
  }
  return gate.getReason();
}

/**
 * Sequence an ordered list of real SceneModules through the control plane.
 * Drop-in replacement for `composeMasterTimeline` sequencing: run scene →
 * await its end → tear down → next; supersession stops the whole run.
 */
export async function runSceneModules(
  scenes: readonly SceneModule[],
  deps: RunModuleDeps,
): Promise<void> {
  for (let index = 0; index < scenes.length; index++) {
    if (deps.navSignal.aborted) return;
    const reason = await runOneModule(scenes[index] as SceneModule, index, deps);
    if (reason === 'superseded') return;
  }
}
