// Workbench-owned chrome surface — PUL-F031 / ADR-031 (ADR-007 / ADR-016).
//
// `main.ts` builds the chrome root and wires this controller into the
// loader via `SceneLoaderOptions.chrome`; the loader calls `applyMode`
// once per navigation before lifecycle work. Chrome is workbench-owned
// (scenes never see a handle) and mounted ONCE — persistence across
// scene navigations is structural, `applyMode` only flips visibility on
// the existing element. The factory shape keeps the DOM behavior testable
// against fakes.

import { profileFor } from './mode-profile';
import { NAVIGATION_MODES, type NavigationMode } from './navigation';

/** Minimal `HTMLElement`-like surface the chrome adapter writes to (real in prod, fake in tests). */
export interface WorkbenchChromeElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hidden: boolean;
  remove(): void;
}

/**
 * Mount callback that attaches the chrome surface, decoupled from a
 * specific `Node` / `appendChild` shape so tests can pass a fake.
 */
export type WorkbenchChromeMount = (element: WorkbenchChromeElement) => void;

/**
 * Inputs to {@link createDomWorkbenchChrome}. `mount` / `createSurface`
 * are each called exactly once during construction — chrome MUST exist
 * before the first navigation event.
 */
export interface WorkbenchChromeHost {
  readonly mount: WorkbenchChromeMount;
  readonly createSurface: () => WorkbenchChromeElement;
}

/**
 * Returned by {@link createDomWorkbenchChrome} and wired into
 * `SceneLoaderOptions.chrome`. `dispose()` removes the surface and
 * silences later `applyMode` calls (run from HMR cleanup).
 */
export interface WorkbenchChromeController {
  /**
   * Apply the effective mode to the surface (visibility attr + `hidden`),
   * a forced-visibility override winning over the mode mapping. Inert post-dispose.
   */
  applyMode(mode: NavigationMode): void;
  /**
   * Override mode-derived visibility for chrome-opted-out compositions
   * (`behavior.chrome: 'hidden'`); `null` clears it. The loader sets it
   * BEFORE `applyMode` each navigation.
   */
  setForcedVisibility(visibility: 'hidden' | null): void;
  /** Enable/disable composition-scoped atmospheric chrome (opt-in per deck). */
  setAtmosphere(atmosphere: 'cinematic' | null): void;
  /** Remove the surface and make later `applyMode` calls no-ops. Idempotent. */
  dispose(): void;
}

/**
 * Pure mapping from workbench mode to chrome visibility (PUL-F031):
 * `present` shows chrome, `standalone` / `screenshot` hide it, others
 * default to visible. The extensibility seam — a new mode extends the
 * mode profile, not scenes / manifests / the resolver.
 */
export function chromeVisibilityFor(mode: NavigationMode): 'visible' | 'hidden' {
  return profileFor(mode).chromeVisibility;
}

const VISIBILITY_ATTR = 'data-pulsar-chrome-visibility';
const ATMOSPHERE_ATTR = 'data-pulsar-chrome-atmosphere';

/**
 * Build a {@link WorkbenchChromeController} over a DOM-shaped surface.
 * Eager: `createSurface()` then `mount()` run before returning, so chrome
 * exists before the first navigation (PUL-F031). `applyMode` only flips
 * visibility on the same element, so the surface persists across navigations.
 */
export function createDomWorkbenchChrome(host: WorkbenchChromeHost): WorkbenchChromeController {
  const element = host.createSurface();
  host.mount(element);
  let disposed = false;
  let forced: 'hidden' | null = null;
  return {
    applyMode(mode: NavigationMode): void {
      if (disposed) return;
      if (!(NAVIGATION_MODES as readonly string[]).includes(mode)) {
        throw new Error(
          `workbench chrome: unknown mode "${String(mode)}" — allowed: ${NAVIGATION_MODES.join(', ')}`,
        );
      }
      const visibility = forced ?? chromeVisibilityFor(mode);
      element.setAttribute(VISIBILITY_ATTR, visibility);
      element.hidden = visibility === 'hidden';
    },
    setForcedVisibility(visibility: 'hidden' | null): void {
      if (disposed) return;
      forced = visibility;
    },
    setAtmosphere(atmosphere: 'cinematic' | null): void {
      if (disposed) return;
      if (atmosphere === null) {
        element.removeAttribute(ATMOSPHERE_ATTR);
        return;
      }
      element.setAttribute(ATMOSPHERE_ATTR, atmosphere);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      element.remove();
    },
  };
}
