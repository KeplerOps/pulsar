// Prompter captions aggregation — PUL-F019 / ADR-022.
//
// Pure function over a {@link SceneNavigationTarget} (already validated
// by `resolveSceneNavigation` per PUL-F008 / ADR-014). Produces a
// {@link PrompterScript} carrying the captions metadata of the
// addressed scene or composition slice. The future captions/script UI
// surface consumes this shape; the scene loader hands it to a
// {@link PrompterRenderer} adapter without interpreting it.
//
// Why prompter is structurally different from `mode=loop` /
// `mode=paused` / `mode=scrub` / `mode=screenshot` (ADR-018 through
// ADR-021): those modes alter how the scene RUNS visually — the
// resolver lifecycle still mounts the scene, and the runner reads a
// hint to alter its behavior. PUL-F019 says "visual rendering of the
// scene SHALL be suppressed." The cleanest structural defense is to
// bypass the resolver lifecycle entirely under `mode=prompter` (no
// preload, no `create`, no `timeline`, no `cleanup`) — see
// `src/runtime/scene-loader.ts`. This module is the captions data path
// that runs INSTEAD of the lifecycle.
//
// References:
//  - PUL-F019 — `mode=prompter` SHALL render a script/caption view
//    derived from the captions metadata of the addressed scene or
//    composition; visual rendering SHALL be suppressed.
//  - ADR-022 — workbench mode `prompter`: loader-side lifecycle
//    bypass + captions aggregation seam.
//  - ADR-002 §Scene module — `captions: [{ at, text }]` is the
//    canonical caption metadata shape.
//  - ADR-007 — workbench modes; `prompter` is the script/caption
//    view mode.

import type { BehaviorOverride, SubRange } from './composition';
import { deepFreeze } from './object';
import type { Caption, SceneModule } from './scene';
import type { SceneNavigationTarget } from './scene-navigation';

/**
 * One scene's contribution to the prompter script. Carries the scene
 * module's identity (`sceneId`, `title`) and its caption metadata
 * verbatim.
 *
 * `range` / `behavior` mirror the per-occurrence overrides from the
 * composition manifest entry (ADR-002 / PUL-F003 — object-form
 * `{ id, range, behavior }`). The captions themselves are copied
 * from the scene module's full metadata regardless of `range` (the
 * runner is the only consumer that resolves named beats to
 * timeline positions; the captions data path has no timeline to
 * filter against). The manifest overrides are carried here so a
 * captions UI can communicate "this entry plays the `midpoint`
 * sub-range" or "this entry has a `behavior.hold` override" to the
 * reviewer, even though the captions array is the scene's full
 * caption list. Bare-string composition entries and direct-scene
 * navigation targets leave both fields absent.
 */
export interface PrompterScriptEntry {
  readonly sceneId: string;
  readonly title: string;
  readonly captions: readonly Caption[];
  readonly range?: SubRange;
  readonly behavior?: BehaviorOverride;
}

/**
 * The aggregated captions view derived from a navigation target's
 * resolved slice. `composition` is absent for single-scene addressing
 * (`SceneNavigationTarget.composition === undefined`) and present for
 * any composition locator. `entries` is the slice in dispatch order
 * — for composition targets, this is the FULL slice the dispatcher
 * snapshotted (PUL-F008), NOT truncated to the head, because the
 * captions view's purpose is to show every scene's captions in
 * manifest order under the addressed composition.
 */
export interface PrompterScript {
  readonly composition?: { readonly id: string };
  readonly entries: readonly PrompterScriptEntry[];
}

/**
 * Cleanup callback the renderer returns when it has mounted
 * persistent state (DOM, event listeners, timers, etc.). The loader
 * holds the callback and invokes it when the per-navigation
 * `AbortSignal` fires (the next navigation enqueues, dispose() runs,
 * etc.) — the renderer does NOT have to register its own abort
 * listener. Returning a callback is how the renderer tells the
 * loader "I mounted state that needs to be torn down later."
 *
 * The callback may be sync or async; the loader awaits the
 * returned value before the prompter dispatch settles, so async
 * teardown (e.g. waiting for a CSS transition before removing the
 * captions panel) flows through naturally.
 */
export type PrompterDispose = () => void | Promise<void>;

/**
 * Adapter the workbench bootstrap supplies to render the prompter
 * script visually. Receives a {@link PrompterScript} and the
 * per-navigation `AbortSignal`.
 *
 * **Lifecycle contract** (enforced by the loader, not by
 * documentation): the renderer's return value tells the loader
 * whether persistent state was mounted.
 *
 *  - Return `void` (or `undefined`): no persistent state was
 *    mounted; nothing to tear down. The dispatch is fully complete.
 *    Use for trivial / no-DOM renderers (test stubs, the placeholder
 *    that ships before the captions UI lands).
 *  - Return a {@link PrompterDispose} callback: persistent state was
 *    mounted. The loader holds the callback and invokes it AFTER
 *    `signal.aborted` fires. The renderer does NOT need to register
 *    its own abort listener; the loader sequences the teardown.
 *  - Return `Promise<void>` or `Promise<PrompterDispose>`: same
 *    semantics, async render. The loader awaits the promise to
 *    obtain the dispose callback (if any), then proceeds.
 *
 * A renderer can ALSO use the older parking-until-abort pattern
 * (return a `Promise<void>` that resolves on `signal.aborted`,
 * with cleanup in the abort listener), which the placeholder under
 * `mode=present` uses for the timeline runner. Both patterns
 * satisfy the contract; the dispose-return pattern is preferred
 * for renderers that mount DOM because the loader OWNS the abort
 * sequencing — there is no documentation-only "you must keep your
 * promise pending" convention for the renderer to forget.
 *
 * Optional on {@link import('./scene-loader').SceneLoaderOptions}: a
 * workbench bootstrap that has not yet wired a captions UI omits the
 * field and the loader dispatches `mode=prompter` without invoking any
 * renderer (visual rendering is still structurally suppressed because
 * the resolver lifecycle is bypassed). Production bootstrap supplies a
 * concrete renderer when the UI surface lands.
 */
// `void` in this union is intentional: the "no cleanup obligation"
// half of the contract must accept implicit-return arrow functions
// like `(script) => { sideEffect(script); }` (TypeScript types
// those as `() => void`, not `() => undefined`). `PrompterDispose`
// is the cleanup-callback half. The two suppressions below disable
// the `noConfusingVoidType` rule on the two `void` occurrences (the
// sync return and the awaited promise return); the trade-off is
// documented in `PrompterRenderer`'s JSDoc above and ADR-022.
// `void` in the sync half of the union is intentional: implicit-
// return arrow functions like `(script) => { sideEffect(script); }`
// are typed as `() => void`, not `() => undefined`, and the
// no-cleanup contract must accept them. The Promise half uses
// `undefined` (biome's preferred shape inside generics) — async
// renderers explicitly return `undefined` or a `PrompterDispose`
// callback.
// biome-ignore lint/suspicious/noConfusingVoidType: implicit-return arrows.
type PrompterRenderSync = void | PrompterDispose;
type PrompterRenderAsync = undefined | PrompterDispose;

export type PrompterRenderer = (
  script: PrompterScript,
  signal: AbortSignal,
) => PrompterRenderSync | Promise<PrompterRenderAsync>;

/**
 * Build a {@link PrompterScript} from a resolved
 * {@link SceneNavigationTarget}. Pure — does not read the registries,
 * does not mutate the source scene modules, returns a deep-frozen
 * structure so a misbehaving renderer cannot corrupt the next
 * navigation's view.
 *
 *  - For a single-scene target (`target.composition === undefined`):
 *    one entry, no `composition` field.
 *  - For a composition target: one entry per scene in
 *    `target.composition.sceneSlice`, in dispatch order. The slice is
 *    NOT truncated — the dispatcher already snapshotted it from the
 *    addressed scene onward (PUL-F008 / ADR-014), and the captions
 *    view consumes it as-is.
 *
 * Captions are deep-copied — both the array AND each individual
 * `Caption` object — so freezing the script does not propagate back
 * to the registered scene module's `captions` field or to any
 * `Caption` objects shared with it. Without per-object cloning,
 * `deepFreeze` would walk the spread array and freeze every
 * `Caption` it found, which would then propagate back through
 * shared references to the source scene module's caption objects;
 * production code that legitimately mutates a `Caption` elsewhere
 * (a future caption editor, test fixture rebuilding, etc.) would
 * crash silently. The clone is structural (`{ ...c }`) so any
 * fields PUL-F001's `Caption` shape gains in the future flow
 * through unchanged — there is no parallel `{ at, text }` schema
 * here.
 */
export function buildPrompterScript(target: SceneNavigationTarget): PrompterScript {
  const scenes: readonly SceneModule[] = target.composition?.sceneSlice ?? [target.scene];
  const manifestSlice = target.composition?.manifestSlice;
  const entries: PrompterScriptEntry[] = scenes.map((scene, index) => {
    const captions = scene.captions.map((c) => ({ ...c }));
    const entry: { -readonly [K in keyof PrompterScriptEntry]: PrompterScriptEntry[K] } = {
      sceneId: scene.id,
      title: scene.title,
      captions,
    };
    // Carry the manifest entry's per-occurrence overrides (range,
    // behavior) on the script entry as optional metadata so a
    // captions UI can render "[midpoint only]" hints, filter
    // captions by sub-range when it can resolve named beats, or
    // surface behavior overrides to the reviewer. The captions
    // themselves come from the registered scene's full metadata
    // (range/behavior do not alter caption content — they are
    // runner-side timeline knobs per ADR-002 / ADR-011), but
    // dropping the manifest metadata entirely would leave the UI
    // unable to communicate that the addressed composition runs
    // a sub-range. Bare-string entries have no overrides; the
    // optional fields stay absent.
    const manifestEntry = manifestSlice?.[index];
    if (typeof manifestEntry === 'object') {
      if (manifestEntry.range !== undefined) entry.range = manifestEntry.range;
      if (manifestEntry.behavior !== undefined) entry.behavior = manifestEntry.behavior;
    }
    return entry;
  });

  const script: { -readonly [K in keyof PrompterScript]: PrompterScript[K] } = { entries };
  if (target.composition !== undefined) {
    script.composition = { id: target.composition.id };
  }
  return deepFreeze(script) as PrompterScript;
}
