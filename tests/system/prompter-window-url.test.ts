// Pulsar L2 — openPrompterWindow URL builder + window.open dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESENTER_SESSION_QUERY_PARAM, openPrompterWindow } from '../../src/system/presenter';

describe('openPrompterWindow', () => {
  const realOpen = globalThis.window?.open ?? null;
  const originalWindow = globalThis.window;
  const presenterSessionId = 'session-a-123456';
  let opened: Array<{ url: string; target: string; features: string }> = [];
  let openedWindow: Window & { opener: unknown };

  const openScopedPrompterWindow = (baseUrl: string, features?: string): Window | null =>
    openPrompterWindow(baseUrl, features, { presenterSessionId });

  const expectPrompterUrl = (expected: string): void => {
    const url = new URL(opened[0]?.url ?? '');
    expect(url.searchParams.get(PRESENTER_SESSION_QUERY_PARAM)).toBe(presenterSessionId);
    expect(url.href).toBe(expected);
  };

  beforeEach(() => {
    opened = [];
    openedWindow = { closed: false, opener: { source: 'presenter' } } as Window & {
      opener: unknown;
    };
    // Stub `window.open`. Vitest's default Node env has no window;
    // attach one minimally for this test.
    Object.defineProperty(globalThis, 'window', {
      value: {
        location: new URL(
          'https://pulsar.test/workbench/current?composition=current&pulsar-presenter-session=opener-session-123456',
        ),
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
    openScopedPrompterWindow('/?composition=demo&mode=present');
    expectPrompterUrl(
      'https://pulsar.test/?composition=demo&mode=prompter&pulsar-presenter-session=session-a-123456',
    );
  });

  it('uses the current workbench presenter session scope by default', () => {
    openPrompterWindow('/?composition=demo');
    const url = new URL(opened[0]?.url ?? '');
    expect(url.searchParams.get(PRESENTER_SESSION_QUERY_PARAM)).toBe('opener-session-123456');
    expect(url.href).toBe(
      'https://pulsar.test/?composition=demo&mode=prompter&pulsar-presenter-session=opener-session-123456',
    );
  });

  it('appends mode=prompter to a URL with other params', () => {
    openScopedPrompterWindow('/?composition=demo');
    expectPrompterUrl(
      'https://pulsar.test/?composition=demo&mode=prompter&pulsar-presenter-session=session-a-123456',
    );
  });

  it('uses ?mode=prompter for a URL with no query', () => {
    openScopedPrompterWindow('/');
    expectPrompterUrl(
      'https://pulsar.test/?mode=prompter&pulsar-presenter-session=session-a-123456',
    );
  });

  it('does not rewrite query values containing mode=', () => {
    openScopedPrompterWindow('/?composition=demo&note=has-mode=inside');
    expectPrompterUrl(
      'https://pulsar.test/?composition=demo&note=has-mode%3Dinside&mode=prompter&pulsar-presenter-session=session-a-123456',
    );
  });

  it('preserves hashes after the prompter mode query parameter', () => {
    openScopedPrompterWindow('/deck?composition=demo#speaker-notes');
    expectPrompterUrl(
      'https://pulsar.test/deck?composition=demo&mode=prompter&pulsar-presenter-session=session-a-123456#speaker-notes',
    );
  });

  it('resolves relative URLs against the current window location', () => {
    openScopedPrompterWindow('./notes?scene=intro');
    expectPrompterUrl(
      'https://pulsar.test/workbench/notes?scene=intro&mode=prompter&pulsar-presenter-session=session-a-123456',
    );
  });

  it('accepts absolute same-origin URLs', () => {
    openScopedPrompterWindow('https://pulsar.test/presenter?composition=demo&mode=loop#notes');
    expectPrompterUrl(
      'https://pulsar.test/presenter?composition=demo&mode=prompter&pulsar-presenter-session=session-a-123456#notes',
    );
  });

  it('overwrites stale presenter session scope in the popout URL', () => {
    openScopedPrompterWindow('/?composition=demo&pulsar-presenter-session=session-stale-123456');
    expectPrompterUrl(
      'https://pulsar.test/?composition=demo&pulsar-presenter-session=session-a-123456&mode=prompter',
    );
  });

  it('does not open cross-origin URLs', () => {
    const result = openScopedPrompterWindow('https://external.example/?composition=demo');
    expect(result).toBeNull();
    expect(opened).toEqual([]);
  });

  it('does not open malformed URLs', () => {
    const result = openScopedPrompterWindow('http://[bad');
    expect(result).toBeNull();
    expect(opened).toEqual([]);
  });

  it('forwards custom features arg', () => {
    openScopedPrompterWindow('/', 'width=400');
    const features = opened[0]?.features.split(',').map((feature) => feature.trim());
    expect(features).toEqual(expect.arrayContaining(['width=400', 'noopener', 'noreferrer']));
  });

  it('isolates the opened window from the opener', () => {
    const result = openScopedPrompterWindow('/');
    expect(result).toBe(openedWindow);
    expect(opened[0]?.target).toBe('_blank');
    expect(openedWindow.opener).toBeNull();
  });

  it('still returns the opened window when opener mutation is blocked', () => {
    Object.defineProperty(openedWindow, 'opener', {
      configurable: true,
      get: () => ({ source: 'presenter' }),
      set: () => {
        throw new Error('blocked opener mutation');
      },
    });
    const result = openScopedPrompterWindow('/');
    expect(result).toBe(openedWindow);
  });
});
