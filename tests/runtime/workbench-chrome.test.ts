// Tests for the workbench-owned chrome surface — PUL-F031 / ADR-031.
//
// Mirrors the `audio-unlock-dom` factory pattern (PUL-F030 / ADR-029):
// the factory takes injected `mount` + `createSurface` hooks so the
// chrome contract (mount once at construction, flip visibility on
// `applyMode`, no DOM writes after `dispose`) is testable against
// fakes while `main.ts` supplies real `document.createElement` and the
// production mount.

import { describe, expect, it } from 'vitest';

import { NAVIGATION_MODES, type NavigationMode } from '../../src/runtime/navigation';
import {
  type WorkbenchChromeElement,
  chromeVisibilityFor,
  createDomWorkbenchChrome,
} from '../../src/runtime/workbench-chrome';

interface FakeChromeElement extends WorkbenchChromeElement {
  readonly attrs: ReadonlyMap<string, string>;
  readonly isHidden: () => boolean;
  readonly removeCount: () => number;
}

const buildFakeElement = (): FakeChromeElement => {
  const attrs = new Map<string, string>();
  let hidden = false;
  let removeCount = 0;
  return {
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: (name) => attrs.delete(name),
    set hidden(value: boolean) {
      hidden = value;
    },
    get hidden(): boolean {
      return hidden;
    },
    remove: () => {
      removeCount += 1;
    },
    attrs,
    isHidden: () => hidden,
    removeCount: () => removeCount,
  };
};

describe('chromeVisibilityFor (PUL-F031)', () => {
  it.each([['standalone'], ['screenshot']] as const)(
    "maps mode='%s' to 'hidden' (requirement statement: chrome SHALL hide)",
    (mode) => {
      expect(chromeVisibilityFor(mode)).toBe('hidden');
    },
  );

  it.each([['present'], ['loop'], ['paused'], ['scrub'], ['prompter'], ['rehearsal']] as const)(
    "maps mode='%s' to 'visible' (statement only names standalone/screenshot as hidden)",
    (mode) => {
      expect(chromeVisibilityFor(mode)).toBe('visible');
    },
  );

  it('covers every NAVIGATION_MODES member', () => {
    // Future-proofing: when ADR-007 adds a ninth mode the helper MUST
    // either return a literal visibility for it (extending the table
    // above) or the policy file forces the author to think about it.
    // A missing case would default to TypeScript `never` and surface
    // here.
    for (const mode of NAVIGATION_MODES) {
      const visibility = chromeVisibilityFor(mode);
      expect(['visible', 'hidden']).toContain(visibility);
    }
  });
});

describe('createDomWorkbenchChrome (PUL-F031 / ADR-031)', () => {
  it('mounts the chrome surface synchronously on construction (before the first navigation can fire)', () => {
    const mounted: WorkbenchChromeElement[] = [];
    const element = buildFakeElement();
    createDomWorkbenchChrome({
      mount: (el) => {
        mounted.push(el);
      },
      createSurface: () => element,
    });
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toBe(element);
  });

  it("applyMode('present') marks chrome visible (data-pulsar-chrome-visibility=visible, hidden=false)", () => {
    const element = buildFakeElement();
    const chrome = createDomWorkbenchChrome({
      mount: () => undefined,
      createSurface: () => element,
    });
    chrome.applyMode('present');
    expect(element.attrs.get('data-pulsar-chrome-visibility')).toBe('visible');
    expect(element.isHidden()).toBe(false);
  });

  it.each([['standalone'], ['screenshot']] as const)(
    "applyMode('%s') hides chrome (data-pulsar-chrome-visibility=hidden + hidden=true)",
    (mode) => {
      const element = buildFakeElement();
      const chrome = createDomWorkbenchChrome({
        mount: () => undefined,
        createSurface: () => element,
      });
      chrome.applyMode(mode);
      expect(element.attrs.get('data-pulsar-chrome-visibility')).toBe('hidden');
      expect(element.isHidden()).toBe(true);
    },
  );

  it.each([['loop'], ['paused'], ['scrub'], ['prompter'], ['rehearsal']] as const)(
    "applyMode('%s') leaves chrome visible (other modes default to visible per preflight)",
    (mode) => {
      const element = buildFakeElement();
      const chrome = createDomWorkbenchChrome({
        mount: () => undefined,
        createSurface: () => element,
      });
      chrome.applyMode(mode);
      expect(element.attrs.get('data-pulsar-chrome-visibility')).toBe('visible');
      expect(element.isHidden()).toBe(false);
    },
  );

  it('toggles deterministically across multiple applyMode calls (persistence across navigations)', () => {
    // PUL-F031 clause: chrome SHALL persist across scene navigations
    // within a composition without being torn down between scenes.
    // Persistence is structural — the element is the same instance,
    // just with visibility flipped — so toggling MUST NOT recreate or
    // re-mount the surface.
    let mountCalls = 0;
    let createSurfaceCalls = 0;
    const element = buildFakeElement();
    const chrome = createDomWorkbenchChrome({
      mount: () => {
        mountCalls += 1;
      },
      createSurface: () => {
        createSurfaceCalls += 1;
        return element;
      },
    });
    chrome.applyMode('present');
    expect(element.isHidden()).toBe(false);
    chrome.applyMode('standalone');
    expect(element.isHidden()).toBe(true);
    chrome.applyMode('screenshot');
    expect(element.isHidden()).toBe(true);
    chrome.applyMode('present');
    expect(element.isHidden()).toBe(false);
    // The same element instance — never re-created or re-mounted.
    expect(mountCalls).toBe(1);
    expect(createSurfaceCalls).toBe(1);
    expect(element.removeCount()).toBe(0);
  });

  it('dispose removes the element from the workbench and silences subsequent applyMode calls', () => {
    const element = buildFakeElement();
    const chrome = createDomWorkbenchChrome({
      mount: () => undefined,
      createSurface: () => element,
    });
    chrome.applyMode('present');
    expect(element.attrs.get('data-pulsar-chrome-visibility')).toBe('visible');
    chrome.dispose();
    expect(element.removeCount()).toBe(1);

    // Post-dispose applyMode MUST be inert — no DOM writes, no
    // throws. Capture the attrs snapshot to assert nothing changed.
    const snapshot = new Map(element.attrs);
    const hiddenSnapshot = element.isHidden();
    chrome.applyMode('screenshot');
    expect(new Map(element.attrs)).toEqual(snapshot);
    expect(element.isHidden()).toBe(hiddenSnapshot);
  });

  it('dispose is idempotent — calling it twice does not throw or double-remove', () => {
    const element = buildFakeElement();
    const chrome = createDomWorkbenchChrome({
      mount: () => undefined,
      createSurface: () => element,
    });
    chrome.dispose();
    chrome.dispose();
    // Element removed exactly once — a second remove would be a
    // workbench teardown bug (HMR cleanup runs more than once).
    expect(element.removeCount()).toBe(1);
  });

  it('applyMode validates the mode against NAVIGATION_MODES (defense in depth against a forged mode)', () => {
    // The loader already validates `target.mode` via
    // `validateModeGrammar` before calling chrome.applyMode, but
    // chrome is exported and a non-loader caller could pass a forged
    // string. Treat that as a programming error rather than silently
    // applying an unknown visibility.
    const element = buildFakeElement();
    const chrome = createDomWorkbenchChrome({
      mount: () => undefined,
      createSurface: () => element,
    });
    expect(() => chrome.applyMode('unknown-mode' as unknown as NavigationMode)).toThrow(
      /workbench chrome: unknown mode/,
    );
  });
});
