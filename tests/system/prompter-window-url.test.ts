// Pulsar L2 — openPrompterWindow URL builder + window.open dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPrompterWindow } from '../../src/system/presenter';

describe('openPrompterWindow', () => {
  const realOpen = globalThis.window?.open ?? null;
  const originalWindow = globalThis.window;
  let opened: Array<{ url: string; target: string; features: string }> = [];
  let openedWindow: Window & { opener: unknown };

  beforeEach(() => {
    opened = [];
    openedWindow = { closed: false, opener: { source: 'presenter' } } as Window & {
      opener: unknown;
    };
    // Stub `window.open`. Vitest's default Node env has no window;
    // attach one minimally for this test.
    Object.defineProperty(globalThis, 'window', {
      value: {
        location: new URL('https://pulsar.test/workbench/current?composition=current'),
        open: (url: string, target: string, features: string) => {
          opened.push({ url, target, features });
          return openedWindow;
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
    expect(opened[0]?.url).toBe('https://pulsar.test/?composition=demo&mode=prompter');
  });

  it('appends mode=prompter to a URL with other params', () => {
    openPrompterWindow('/?composition=demo');
    expect(opened[0]?.url).toBe('https://pulsar.test/?composition=demo&mode=prompter');
  });

  it('uses ?mode=prompter for a URL with no query', () => {
    openPrompterWindow('/');
    expect(opened[0]?.url).toBe('https://pulsar.test/?mode=prompter');
  });

  it('does not rewrite query values containing mode=', () => {
    openPrompterWindow('/?composition=demo&note=has-mode=inside');
    expect(opened[0]?.url).toBe(
      'https://pulsar.test/?composition=demo&note=has-mode%3Dinside&mode=prompter',
    );
  });

  it('preserves hashes after the prompter mode query parameter', () => {
    openPrompterWindow('/deck?composition=demo#speaker-notes');
    expect(opened[0]?.url).toBe(
      'https://pulsar.test/deck?composition=demo&mode=prompter#speaker-notes',
    );
  });

  it('resolves relative URLs against the current window location', () => {
    openPrompterWindow('./notes?scene=intro');
    expect(opened[0]?.url).toBe('https://pulsar.test/workbench/notes?scene=intro&mode=prompter');
  });

  it('accepts absolute same-origin URLs', () => {
    openPrompterWindow('https://pulsar.test/presenter?composition=demo&mode=loop#notes');
    expect(opened[0]?.url).toBe(
      'https://pulsar.test/presenter?composition=demo&mode=prompter#notes',
    );
  });

  it('does not open cross-origin URLs', () => {
    const result = openPrompterWindow('https://external.example/?composition=demo');
    expect(result).toBeNull();
    expect(opened).toEqual([]);
  });

  it('forwards custom features arg', () => {
    openPrompterWindow('/', 'width=400');
    const features = opened[0]?.features.split(',').map((feature) => feature.trim());
    expect(features).toEqual(expect.arrayContaining(['width=400', 'noopener', 'noreferrer']));
  });

  it('isolates the opened window from the opener', () => {
    const result = openPrompterWindow('/');
    expect(result).toBe(openedWindow);
    expect(opened[0]?.target).toBe('_blank');
    expect(openedWindow.opener).toBeNull();
  });
});
