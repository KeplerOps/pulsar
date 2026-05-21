// Workbench-owned chrome surface — PUL-F031 / ADR-031.
//
// `src/main.ts` (the production browser bootstrap) builds a chrome DOM
// root next to the scene `#stage` and wires this factory's controller
// into the scene loader via `SceneLoaderOptions.chrome`. The loader
// calls `applyMode(effectiveMode(target))` once per navigation, before
// any lifecycle work, so chrome visibility tracks the addressed
// workbench mode without scenes ever owning chrome state.
//
// Per ADR-007 / ADR-016 / the PUL-F031 preflight:
//   - Chrome is workbench-owned. Scenes receive `ctx.stage`, never a
//     chrome handle, selector, or event bus.
//   - Chrome is mounted ONCE at workbench bootstrap, before the first
//     navigation event. Persistence across scene navigations is
//     structural — `applyMode` only flips visibility on the existing
//     element; it never re-mounts or re-creates the surface.
//   - The chrome visibility decision is a chrome-specific policy, not
//     a generic `ModePolicy`. A future mode that needs compact /
//     reviewer / presenter chrome variants extends the literal-union
//     return type at this one helper, not by editing scenes,
//     manifests, the resolver, or the URL parser beyond adding the
//     mode itself.
//
// The factory shape (mirroring `audio-unlock-dom.ts`) keeps every
// observable DOM behavior — mount-once, visibility flip, dispose
// removal — testable against fakes while production `main.ts` supplies
// real `document.createElement` and the live mount point.

import { NAVIGATION_MODES, type NavigationMode } from './navigation';

/**
 * Minimal `HTMLElement`-like surface the chrome adapter writes to.
 * Production `main.ts` passes a real `HTMLElement`; tests pass a fake.
 * The chrome surface only needs `setAttribute` / `removeAttribute` /
 * the boolean `hidden` IDL property / `remove()` — everything else
 * (children, layout, content) is the workbench's own concern and is
 * out of scope for PUL-F031's structural defense.
 */
export interface WorkbenchChromeElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hidden: boolean;
  remove(): void;
}

/**
 * Mount callback the factory invokes to attach the chrome surface to
 * the workbench. Decoupling the mount from a specific `Element` /
 * `appendChild` shape lets the production wiring stay compatible with
 * the real DOM (`(el) => document.body.appendChild(el as unknown as
 * Node)`) while tests pass a fake that records the appended element —
 * without forcing the factory to know about `Node` or jsdom.
 */
export type WorkbenchChromeMount = (element: WorkbenchChromeElement) => void;

/**
 * Inputs to {@link createDomWorkbenchChrome}.
 *
 *  - `mount` attaches the chrome surface to the workbench. Called
 *    exactly once, during factory construction — chrome MUST exist
 *    before the first navigation event fires.
 *  - `createSurface` builds the chrome DOM root. Called exactly once,
 *    during factory construction. Production `main.ts` builds a
 *    `<div data-pulsar-chrome="surface" role="complementary"
 *    aria-label="workbench chrome">`; tests build a minimal fake.
 */
export interface WorkbenchChromeHost {
  readonly mount: WorkbenchChromeMount;
  readonly createSurface: () => WorkbenchChromeElement;
}

/**
 * Returned by {@link createDomWorkbenchChrome}. The workbench wires the
 * controller into `SceneLoaderOptions.chrome`; the loader calls
 * `applyMode` once per navigation. `dispose()` removes the chrome
 * surface from the workbench and silences any subsequent `applyMode`
 * calls — invoked from the workbench bootstrap's HMR cleanup so a
 * re-evaluated entry module does not accumulate chrome surfaces.
 */
export interface WorkbenchChromeController {
  /**
   * Apply the effective workbench mode to the chrome surface. Maps the
   * mode through {@link chromeVisibilityFor} and updates the
   * `data-pulsar-chrome-visibility` attribute plus the boolean `hidden`
   * IDL property. Inert post-dispose.
   *
   * When a forced-visibility override is set via {@link setForcedVisibility},
   * the override wins over the mode mapping.
   */
  applyMode(mode: NavigationMode): void;
  /**
   * Override the mode-derived visibility for compositions that opt out
   * of pulsar's chrome (e.g. a deck that owns its own atmospherics via
   * `behavior.chrome: 'hidden'` on a composition entry). Pass `null` to
   * clear the override and resume mode-driven visibility on the next
   * `applyMode` call. The loader sets the override BEFORE `applyMode`
   * on each navigation so the chrome flips correctly when the user
   * moves between a chrome-on and chrome-hidden composition.
   */
  setForcedVisibility(visibility: 'hidden' | null): void;
  /**
   * Tear down the chrome surface. Removes the element from the
   * workbench and makes subsequent `applyMode` calls no-ops.
   * Idempotent: a second `dispose()` does not re-remove or throw.
   */
  dispose(): void;
}

/**
 * Pure mapping from workbench mode to chrome visibility.
 *
 * PUL-F031 statement: chrome SHALL be governed by the active mode —
 * `present` renders chrome fully; modes that explicitly suppress
 * chrome (`standalone`, `screenshot`) SHALL hide it.
 *
 * Preflight policy: "Other modes keep their existing ADR-defined
 * behavior unless their own requirement explicitly suppresses chrome."
 * No requirement names chrome suppression for `loop`, `paused`,
 * `scrub`, `prompter`, or `rehearsal`, so they default to visible.
 *
 * The exhaustive `switch` over `NavigationMode` is the extensibility
 * seam the preflight names: a future mode that needs compact /
 * reviewer / presenter chrome variants extends the literal union here
 * (and updates the gate test), not by editing scenes, manifests, or
 * the resolver.
 */
export function chromeVisibilityFor(mode: NavigationMode): 'visible' | 'hidden' {
  switch (mode) {
    case 'standalone':
    case 'screenshot':
      return 'hidden';
    case 'present':
    case 'loop':
    case 'paused':
    case 'scrub':
    case 'prompter':
    case 'rehearsal':
      return 'visible';
  }
}

const VISIBILITY_ATTR = 'data-pulsar-chrome-visibility';

/**
 * Build a {@link WorkbenchChromeController} backed by a DOM-shaped
 * chrome surface.
 *
 * Construction is eager:
 *   1. `createSurface()` is called exactly once to build the chrome
 *      DOM root.
 *   2. `mount(element)` attaches it to the workbench.
 *
 * Both run synchronously before this function returns, so chrome
 * exists before the workbench bootstrap calls `bootstrapNavigation()`
 * — the "mounted before the first scene navigation" clause of
 * PUL-F031 is satisfied structurally by call order in `main.ts`.
 *
 * `applyMode` flips visibility on the same element instance every
 * call — the chrome surface is never re-created or re-mounted, which
 * is how "chrome SHALL persist across scene navigations within a
 * composition" is honored structurally.
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      element.remove();
    },
  };
}
