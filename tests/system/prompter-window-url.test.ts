// Pulsar L2 — openPrompterWindow URL builder + window.open dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPrompterWindow } from '../../src/system/presenter';

describe('openPrompterWindow', () => {
  const realOpen = globalThis.window?.open ?? null;
  const originalWindow = globalThis.window;
  let opened: Array<{ url: string; target: string; features: string }> = [];

  beforeEach(() => {
    opened = [];
    // Stub `window.open`. Vitest's default Node env has no window;
    // attach one minimally for this test.
    Object.defineProperty(globalThis, 'window', {
      value: {
        open: (url: string, target: string, features: string) => {
          opened.push({ url, target, features });
          return { closed: false } as unknown as Window;
        },
      },
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true });
    } else {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
    if (realOpen !== null && globalThis.window !== undefined) {
      globalThis.window.open = realOpen;
    }
    void vi;
  });

  it('replaces an existing mode= param', () => {
    openPrompterWindow('/?composition=demo&mode=present');
    expect(opened[0]?.url).toBe('/?composition=demo&mode=prompter');
  });

  it('appends mode=prompter to a URL with other params', () => {
    openPrompterWindow('/?composition=demo');
    expect(opened[0]?.url).toBe('/?composition=demo&mode=prompter');
  });

  it('uses ?mode=prompter for a URL with no query', () => {
    openPrompterWindow('/');
    expect(opened[0]?.url).toBe('/?mode=prompter');
  });

  it('forwards custom features arg', () => {
    openPrompterWindow('/', 'width=400');
    expect(opened[0]?.features).toBe('width=400');
  });
});
