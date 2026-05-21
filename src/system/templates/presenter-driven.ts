// Pulsar L2 template — presenter-driven scene.
//
// A scene shape for decks where each slide is a `while (!advance) { ... }`
// body rather than a fixed-duration GSAP timeline. Calgary-style.
//
// Usage:
//   presenterDrivenScene('cv2-cold-open', {
//     title: 'Cold open',
//     run: async ({ presenter, signal, chrome, audio, gsap }) => {
//       while (!await advanced(presenter, signal)) {
//         // beats — slamTitle, renderAct, aSleep, fireScreenFlash, etc.
//       }
//     },
//   });
//
// Behind the scenes:
//   - timeline(ctx) returns a child timeline with a leading 0.1s spacer
//     and a trailing `addAdvanceGate(tl)` label. composeMasterTimeline
//     turns the gate label into a master `addPause` (existing PUL-Bx2
//     wiring), so master halts at the end of this scene's segment
//     until the user advances. The scene's segment is functionally
//     "indefinite" from the master's POV — exactly what calgary's loop
//     pattern needs.
//   - create(ctx) kicks off `run(ctx)` as a side-effect async; the body
//     drives its own pacing via `aSleep({ controller })` /
//     `holdUntilAdvance(controller)`, both of which subscribe to the
//     same `PresenterController` and resolve on `advance`.
//   - cleanup(ctx) flips an abort flag that the body can read between
//     beats so a navigation-superseded scene tears down promptly.
//
// The template owns lifecycle scaffolding; the deck owns the body.
// Every chrome / audio / pacing call inside the body goes through
// existing L2 helpers — no `document.getElementById`, no
// `new Audio()`, no inline DOM in the template itself.

import { gsap as gsapDefault } from 'gsap';
import type { PresenterController } from '../../runtime/presenter';
import { type Caption, type SceneModule, assertSceneModule } from '../../runtime/scene';
import type { ChromeSlots } from '../chrome';
import { addAdvanceGate } from '../helpers/timing';

/**
 * Subset of `WorkbenchSceneCtx` the presenter-driven body is contracted
 * to consume. Surfaces only what's safe + necessary:
 *  - `presenter` — for `aSleep({ controller })` / `holdUntilAdvance(controller)`
 *  - `signal` — a deck-author-facing flag the template sets `true` on
 *    cleanup. Body checks it between beats: `if (signal.aborted) return;`
 *  - `chrome` — non-optional in this shape; the body asserts it on entry
 *  - `audio`, `gsap`, `stage` — passed through for direct access
 */
export interface PresenterDrivenCtx {
  readonly presenter: PresenterController;
  readonly signal: { aborted: boolean };
  readonly chrome: ChromeSlots;
  readonly audio?: unknown;
  readonly gsap?: unknown;
  readonly stage: unknown;
}

export interface PresenterDrivenContent {
  readonly title: string;
  readonly assets?: readonly string[];
  readonly audio?: readonly string[];
  readonly captions?: readonly Caption[];
  readonly tags?: readonly string[];
  readonly run: (ctx: PresenterDrivenCtx) => Promise<void>;
  readonly cleanup?: () => void;
}

interface RawCtx {
  readonly presenter?: PresenterController;
  readonly chrome?: ChromeSlots;
  readonly audio?: unknown;
  readonly gsap?: { timeline(opts?: unknown): unknown };
  readonly stage?: unknown;
}

const isRawCtx = (value: unknown): value is RawCtx => typeof value === 'object' && value !== null;

interface ActiveRun {
  readonly signal: { aborted: boolean };
}

/**
 * Build a presenter-driven scene. Decks call this from their slide
 * files; the returned SceneModule is registered in the composition
 * manifest just like any other scene.
 */
export const presenterDrivenScene = (id: string, content: PresenterDrivenContent): SceneModule => {
  // One active run record per scene id. The loader serializes scene
  // lifecycle, so a scene cannot be active twice at once — but a
  // navigation-superseded re-entry must wipe the prior record.
  let active: ActiveRun | null = null;
  // Captured at create() time, consumed by timeline()'s leading
  // tl.call() when master enters the segment. Decouples body kick-
  // off from mount so all scenes don't fire bodies concurrently.
  let pendingCtx: PresenterDrivenCtx | null = null;

  const scene: SceneModule = {
    id,
    title: content.title,
    duration: null,
    tags: content.tags ?? ['presenter-driven'],
    assets: content.assets ?? [],
    captions: content.captions ?? [],
    audio: content.audio ?? [],
    defaultNext: null,
    standalone: true,
    trailerSafe: false,
    create: (rawCtx) => {
      // The body only runs once the master timeline reaches this
      // scene's segment (gated by `tl.call(startBody)` in `timeline()`
      // below). Firing it from `create()` would race every
      // presenter-driven scene's body at composition load — all decks
      // mount every scene's create() up front. Stash the ctx and a
      // freshly-armed abort signal so `timeline()` can wire the
      // gated kickoff and `cleanup()` can flip the signal.
      if (!isRawCtx(rawCtx)) return;
      const presenter = rawCtx.presenter;
      const chrome = rawCtx.chrome;
      if (presenter === undefined || chrome === undefined) return;
      if (active !== null) active.signal.aborted = true;
      const signal = { aborted: false };
      active = { signal };
      pendingCtx = {
        presenter,
        signal,
        chrome,
        audio: rawCtx.audio,
        gsap: rawCtx.gsap,
        stage: rawCtx.stage,
      };
    },
    timeline: (rawCtx) => {
      if (!isRawCtx(rawCtx)) return null;
      const gsapApi = rawCtx.gsap ?? gsapDefault;
      const tl = (gsapApi as { timeline(opts?: unknown): unknown }).timeline() as ReturnType<
        typeof gsapDefault.timeline
      >;
      // Leading kick-off — fires the body only when master enters
      // this segment, not when the scene is mounted. The body still
      // runs externally (off the timeline tick) and paces itself via
      // aSleep / holdUntilAdvance against the presenter controller.
      tl.call(() => {
        const ctxToRun = pendingCtx;
        if (ctxToRun === null) return;
        pendingCtx = null;
        void (async (): Promise<void> => {
          try {
            await content.run(ctxToRun);
          } catch (err) {
            console.error(`presenterDrivenScene[${id}] body error:`, err);
          }
        })();
      });
      // Tiny leading spacer so the segment has non-zero duration on
      // master (composeMasterTimeline positions following segments at
      // the new end via '>').
      tl.to({}, { duration: 0.1 });
      // Trailing advance gate. composeMasterTimeline detects the
      // `_advance-gate` label and inserts a master.addPause at the
      // corresponding master-time. Master halts here until the user
      // advances; advance also wakes any holdUntilAdvance/aSleep the
      // body is parked in, so the body exits in lockstep.
      addAdvanceGate(tl);
      // Trailing 0.1s tween so the segment continues past the gate
      // after advance fires — covers the fade-out window for any
      // cleanup work.
      tl.to({}, { duration: 0.1 });
      return tl;
    },
    cleanup: () => {
      if (active !== null) {
        active.signal.aborted = true;
        active = null;
      }
      if (content.cleanup !== undefined) {
        try {
          content.cleanup();
        } catch (err) {
          console.error(`presenterDrivenScene[${id}] cleanup error:`, err);
        }
      }
    },
  };
  assertSceneModule(scene);
  return scene;
};
