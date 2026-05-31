// Workbench chrome — PUL-F031. Mounted once (persistence is structural);
// applyMode() only flips visibility on the existing element.

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
 * Inputs to {@link createDomWorkbenchChrome}, generic over the concrete
 * element type so production passes a real `HTMLElement` (no cast) and
 * tests pass a fake. `mount` / `createSurface` each run once at construction.
 */
export interface WorkbenchChromeHost<E extends WorkbenchChromeElement = WorkbenchChromeElement> {
  readonly mount: (element: E) => void;
  readonly createSurface: () => E;
}

/** Controller wired into `SceneLoaderOptions.chrome`; inert after `dispose()`. */
export interface WorkbenchChromeController {
  /** Apply mode visibility (forced override wins over the mode mapping). Inert post-dispose. */
  applyMode(mode: NavigationMode): void;
  /** Force visibility for chrome-opted-out compositions; loader sets it before `applyMode`. */
  setForcedVisibility(visibility: 'hidden' | null): void;
  /** Enable/disable composition-scoped atmospheric chrome (opt-in per deck). */
  setAtmosphere(atmosphere: 'cinematic' | null): void;
  /** Remove the surface and make later `applyMode` calls no-ops. Idempotent. */
  dispose(): void;
}

/**
 * Pure mode→visibility mapping (PUL-F031): `standalone` / `screenshot`
 * hide chrome, all other modes show it. A new mode extends the mode
 * profile, not scenes / manifests / the resolver.
 */
export function chromeVisibilityFor(mode: NavigationMode): 'visible' | 'hidden' {
  return profileFor(mode).chromeVisibility;
}

const VISIBILITY_ATTR = 'data-pulsar-chrome-visibility';
const ATMOSPHERE_ATTR = 'data-pulsar-chrome-atmosphere';

/**
 * Build a {@link WorkbenchChromeController} over a DOM-shaped surface.
 * Eager: `createSurface()` then `mount()` run before returning, so chrome
 * exists before the first navigation (PUL-F031).
 */
export function createDomWorkbenchChrome<E extends WorkbenchChromeElement>(
  host: WorkbenchChromeHost<E>,
): WorkbenchChromeController {
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
