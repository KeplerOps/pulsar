// Prompter captions aggregation — PUL-F019 / ADR-022.
//
// Pure function over a (validated) {@link SceneNavigationTarget}, producing
// a {@link PrompterScript} of the addressed slice's captions metadata. The
// loader hands it to a {@link PrompterRenderer} without interpreting it.
// PUL-F019 suppresses visual rendering by bypassing the resolver lifecycle
// entirely under `mode=prompter`; this module is the captions data path
// that runs INSTEAD of it.

import type { BehaviorOverride, SubRange } from './composition';
import { deepFreeze } from './object';
import type { Caption, SceneModule } from './scene';
import type { SceneNavigationTarget } from './scene-navigation';

/**
 * One scene's contribution to the prompter script: identity + full caption
 * metadata, plus the manifest entry's `range` / `behavior` overrides (so a
 * captions UI can surface them — they do not filter the caption list).
 * Both absent for bare-string entries and direct-scene targets.
 */
export interface PrompterScriptEntry {
  readonly sceneId: string;
  readonly title: string;
  readonly captions: readonly Caption[];
  readonly range?: SubRange;
  readonly behavior?: BehaviorOverride;
}

/**
 * The aggregated captions view. `composition` is absent for single-scene
 * addressing. `entries` is the FULL slice in dispatch order (NOT truncated
 * to the head — the view shows every scene's captions).
 */
export interface PrompterScript {
  readonly composition?: { readonly id: string };
  readonly entries: readonly PrompterScriptEntry[];
}

/**
 * Cleanup callback a renderer returns when it mounted persistent state.
 * The loader holds it and invokes it when the navigation `AbortSignal`
 * fires (the renderer registers no abort listener of its own). Sync or
 * async — the loader awaits it before the dispatch settles.
 */
export type PrompterDispose = () => void | Promise<void>;

/**
 * Adapter the workbench supplies to render the prompter script. The
 * return value tells the loader (which OWNS abort sequencing) whether
 * persistent state was mounted: `void` / `undefined` = nothing to tear
 * down; a {@link PrompterDispose} = invoke it after `signal.aborted`;
 * a `Promise` of either = same, async. Optional — when omitted, the
 * loader still dispatches `mode=prompter` (lifecycle stays suppressed).
 */
// `void` in the sync half is intentional: implicit-return arrows
// (`(script) => { sideEffect(script); }`) are typed `() => void`, and the
// no-cleanup contract must accept them. The Promise half uses `undefined`
// (biome's preferred generic shape).
// biome-ignore lint/suspicious/noConfusingVoidType: implicit-return arrows.
type PrompterRenderSync = void | PrompterDispose;
type PrompterRenderAsync = undefined | PrompterDispose;

export type PrompterRenderer = (
  script: PrompterScript,
  signal: AbortSignal,
) => PrompterRenderSync | Promise<PrompterRenderAsync>;

/**
 * Build a {@link PrompterScript} from a resolved
 * {@link SceneNavigationTarget}. Pure and deep-frozen so a misbehaving
 * renderer cannot corrupt the next view. One entry per slice scene (the
 * slice is NOT truncated). Captions are deep-COPIED (array + each object)
 * so the freeze does not propagate back to the source scene module.
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
    // Carry the manifest entry's `range` / `behavior` as optional metadata
    // for a captions UI; they do not alter caption content (runner-side
    // knobs). Bare-string entries leave both absent.
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
