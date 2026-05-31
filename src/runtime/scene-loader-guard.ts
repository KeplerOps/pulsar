// Scene-loader navigation guards — PUL-F008.
//
// Navigation trust seams the loader delegates to, re-deriving inputs from
// the resolved target rather than cached state:
//  - present-mode audio unlock-gate predicate + builder (PUL-F030 / ADR-029);
//  - composition-scoped chrome dispatch policy (PUL-F031 / ADR-031).

import type { CompositionRegistry } from './composition-registry';
import { type NavigationMode, effectiveMode } from './navigation';
import type { NavigationTarget } from './navigation';
import type { SceneRegistry } from './registry';
import { sceneDeclaresAudio } from './scene';
import { type SceneNavigationTarget, resolveSceneNavigation } from './scene-navigation';

/**
 * PUL-F030 / ADR-029: internal gate-prelude the loader awaits BEFORE the
 * lifecycle. Closes over the semantic composition context, leaving only
 * `signal` + `unlock` supplied at invocation.
 */
export type UnlockGate = (env: {
  readonly signal: AbortSignal;
  readonly unlock: () => Promise<void>;
}) => Promise<void>;

/** PUL-F030 / ADR-029: the unlock adapter's bounded semantic context. */
export interface AudioUnlockContext {
  readonly compositionId: string;
  readonly sceneIds: readonly string[];
  readonly signal: AbortSignal;
  readonly unlock: () => Promise<void>;
}

/** PUL-F030 / ADR-029: signature of the workbench-supplied unlock adapter. */
export type AudioUnlockAdapter = (gate: AudioUnlockContext) => Promise<void>;

/**
 * PUL-F030 / ADR-029: decide whether the present-mode unlock gate applies
 * and, if so, build it. `null` = does not apply (not present / no
 * composition / no audio); `'fail-loud'` = applies but no adapter (the gate
 * IS the defense); `UnlockGate` = a closure giving the adapter bounded
 * context only (ids, signal, unlock — never scene objects or URLs).
 */
export function resolveUnlockGate(
  adapter: AudioUnlockAdapter | undefined,
  target: NavigationTarget,
  resolved: SceneNavigationTarget,
): UnlockGate | 'fail-loud' | null {
  if (effectiveMode(target) !== 'present') return null;
  const composition = resolved.composition;
  if (composition === undefined) return null;
  if (!composition.sceneSlice.some(sceneDeclaresAudio)) return null;
  if (adapter === undefined) return 'fail-loud';
  const compositionId = composition.id;
  const sceneIds = Object.freeze(composition.sceneSlice.map((scene) => scene.id));
  return ({ signal, unlock }) => adapter({ compositionId, sceneIds, signal, unlock });
}

/**
 * PUL-F031 / ADR-031: workbench-supplied chrome controller surface. The
 * loader only needs to apply a validated mode + composition overrides.
 */
export interface WorkbenchChromeAdapter {
  applyMode(mode: NavigationMode): void;
  setForcedVisibility?(visibility: 'hidden' | null): void;
  setAtmosphere?(atmosphere: 'cinematic' | null): void;
}

/** The registries {@link applyChromeForTarget} resolves the chrome policy against. */
export interface ChromeResolveDeps {
  readonly scenes: SceneRegistry;
  readonly compositions: CompositionRegistry;
}

function chromeBehaviorForTarget(deps: ChromeResolveDeps, target: NavigationTarget): unknown {
  let head: unknown;
  try {
    const resolved = resolveSceneNavigation(target, {
      scenes: deps.scenes,
      compositions: deps.compositions,
    });
    head = resolved?.composition?.manifestSlice[0];
  } catch {
    return undefined;
  }
  if (head === null || typeof head !== 'object') return undefined;
  return (head as { readonly behavior?: { readonly chrome?: unknown } }).behavior?.chrome;
}

/**
 * Composition-level chrome policy: the head manifest entry's
 * `behavior.chrome` may force visibility hidden or opt into cinematic
 * atmosphere. Defaults reset explicitly (`null`/`null`) so navigating
 * away clears state immediately. Forced visibility is applied BEFORE
 * `applyMode` so chrome hides before serialized scene cleanup drains.
 */
export function applyChromeForTarget(
  chrome: WorkbenchChromeAdapter,
  deps: ChromeResolveDeps,
  target: NavigationTarget,
): void {
  const chromeBehavior = chromeBehaviorForTarget(deps, target);
  const forcedVisibility = chromeBehavior === 'hidden' ? 'hidden' : null;
  const atmosphere =
    typeof chromeBehavior === 'object' &&
    chromeBehavior !== null &&
    (chromeBehavior as { readonly atmosphere?: unknown }).atmosphere === 'cinematic'
      ? 'cinematic'
      : null;
  chrome.setForcedVisibility?.(forcedVisibility);
  chrome.setAtmosphere?.(atmosphere);
  chrome.applyMode(effectiveMode(target));
}
