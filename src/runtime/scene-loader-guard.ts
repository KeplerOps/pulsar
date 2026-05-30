// Scene-loader navigation guards — PUL-F008.
//
// Pure / near-pure decision helpers `createSceneLoader` delegates to so
// `runTarget` and `enqueue` stay within the cognitive-complexity budget:
//  - the present-mode audio unlock-gate predicate + builder (PUL-F030);
//  - the composition-scoped chrome dispatch policy (PUL-F031).
//
// These are the navigation "trust seams" — they re-derive their inputs
// from the resolved target rather than trusting cached state.
//
// References:
//  - PUL-F030 / ADR-029 — present-mode audio unlock gate.
//  - PUL-F031 / ADR-031 — composition-scoped chrome dispatch.

import type { CompositionRegistry } from './composition-registry';
import { type NavigationMode, effectiveMode } from './navigation';
import type { NavigationTarget } from './navigation';
import type { SceneRegistry } from './registry';
import { sceneDeclaresAudio } from './scene';
import { type SceneNavigationTarget, resolveSceneNavigation } from './scene-navigation';

/**
 * PUL-F030 / ADR-029: the internal gate-prelude callback the loader
 * awaits BEFORE the resolver lifecycle. The public-facing
 * `AudioUnlockAdapter` receives the semantic composition context; this
 * helper closes over that context, leaving only the navigation-bound
 * `signal` + engine-bound `unlock` supplied at gate-invocation time.
 */
export type UnlockGate = (env: {
  readonly signal: AbortSignal;
  readonly unlock: () => Promise<void>;
}) => Promise<void>;

/**
 * PUL-F030 / ADR-029: the workbench-supplied unlock adapter's bounded
 * semantic context. Declared here (and re-exported from `scene-loader.ts`)
 * so the gate predicate and the adapter signature share one definition.
 */
export interface AudioUnlockContext {
  readonly compositionId: string;
  readonly sceneIds: readonly string[];
  readonly signal: AbortSignal;
  readonly unlock: () => Promise<void>;
}

/** PUL-F030 / ADR-029: signature of the workbench-supplied unlock adapter. */
export type AudioUnlockAdapter = (gate: AudioUnlockContext) => Promise<void>;

/**
 * PUL-F030 / ADR-029: decide whether the present-mode audio unlock gate
 * applies to this navigation, and if so build it. Returns:
 *  - `null` — the gate does not apply (mode is not present, no
 *    composition slice, or no scene in the slice declares audio).
 *  - `'fail-loud'` — the gate applies but no adapter is supplied
 *    (workbench-bootstrap defect; the gate IS the structural defense).
 *  - `UnlockGate` — a closure that invokes the adapter with the
 *    bounded composition context (id, scene ids, signal, unlock); the
 *    lifecycle awaits it before preload / `create` / `timeline` /
 *    master playback. The adapter receives no scene objects, source
 *    URLs, asset payloads, or Howler handles (ADR-029 guardrail).
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

function chromeBehaviorFromResolved(resolved: SceneNavigationTarget | null): unknown {
  const head = resolved?.composition?.manifestSlice[0];
  if (head === null || typeof head !== 'object') return undefined;
  return (head as { readonly behavior?: { readonly chrome?: unknown } }).behavior?.chrome;
}

function chromeBehaviorForTarget(deps: ChromeResolveDeps, target: NavigationTarget): unknown {
  try {
    return chromeBehaviorFromResolved(
      resolveSceneNavigation(target, { scenes: deps.scenes, compositions: deps.compositions }),
    );
  } catch {
    return undefined;
  }
}

/**
 * Composition-level chrome policy: the head manifest entry's
 * `behavior.chrome` can force visibility hidden or opt into cinematic
 * atmosphere. The default is explicit reset (`forcedVisibility=null`,
 * `atmosphere=null`) so a navigation away from an atmospheric deck
 * clears that state immediately, before serialized scene cleanup. The
 * forced-visibility application precedes `applyMode` so chrome hides
 * before any cleanup drains (codex review, cycle 1).
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
