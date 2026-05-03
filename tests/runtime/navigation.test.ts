import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NAVIGATION_MODES,
  type NavigationEventTarget,
  type NavigationMode,
  type NavigationSubscriptionOptions,
  type NavigationTarget,
  PULSAR_NAVIGATE_ERROR_EVENT_TYPE,
  PULSAR_NAVIGATE_EVENT_TYPE,
  bootstrapNavigation,
  parseNavigationSearch,
  subscribeNavigation,
} from '../../src/runtime/navigation';

// PUL-F007 — URL navigation grammar.
//
// The parser is a boundary adapter from URLSearchParams to a plain
// navigation target (ADR-013). It accepts only the five named keys
// (`scene`, `composition`, `index`, `beat`, `mode`), validates each
// in isolation, validates the combination shape, and rejects repeats
// of any named key. Unknown keys are ignored.
//
// `subscribeNavigation` wires startup parsing + `popstate` through the
// same parser path with the same error semantics — clause 2 of the
// requirement statement.
//
// Tests below are organized by clause:
//  - Clause 1: accepts and validates the five grammar keys.
//  - Clause 2: parses at startup and on `popstate`.
// Plus ADR-013 invariants (repeated keys rejected, unknown keys ignored,
// and the five valid + four invalid combination shapes).

const ALL_MODES: readonly NavigationMode[] = [
  'present',
  'standalone',
  'loop',
  'paused',
  'scrub',
  'screenshot',
  'prompter',
];

describe('parseNavigationSearch — clause 1: accepts the five grammar keys', () => {
  describe('input shape', () => {
    it('accepts a leading-? string', () => {
      expect(() => parseNavigationSearch('?scene=intro')).not.toThrow();
    });

    it('accepts a no-? string', () => {
      expect(() => parseNavigationSearch('scene=intro')).not.toThrow();
    });

    it('accepts a URLSearchParams instance', () => {
      const params = new URLSearchParams({ scene: 'intro' });
      expect(parseNavigationSearch(params).locator).toEqual({
        kind: 'scene',
        scene: 'intro',
      });
    });

    it('accepts the empty string', () => {
      expect(parseNavigationSearch('')).toEqual({ locator: { kind: 'none' } });
    });

    it('accepts the bare ?', () => {
      expect(parseNavigationSearch('?')).toEqual({ locator: { kind: 'none' } });
    });
  });

  describe('scene', () => {
    it.each(['intro', 'cold-open', 'a', 'a1-b2', 'scene-1', '1', '9-9'])(
      'accepts kebab-case scene id %j',
      (id) => {
        expect(parseNavigationSearch(`scene=${id}`).locator).toEqual({
          kind: 'scene',
          scene: id,
        });
      },
    );

    it.each([
      ['empty string', ''],
      ['uppercase', 'Scene-A'],
      ['underscore', 'scene_a'],
      ['leading hyphen', '-scene'],
      ['trailing hyphen', 'scene-'],
      ['consecutive hyphens', 'a--b'],
      ['internal whitespace (encoded)', 'scene%20a'],
      ['unicode', 'sc%C3%A9ne'],
    ])('rejects malformed scene id (%s)', (_label, encoded) => {
      expect(() => parseNavigationSearch(`scene=${encoded}`)).toThrow(
        /^navigation grammar is invalid:/,
      );
    });
  });

  describe('composition', () => {
    it('accepts a kebab-case composition id', () => {
      expect(parseNavigationSearch('composition=full-talk').locator).toEqual({
        kind: 'composition',
        composition: 'full-talk',
      });
    });

    it('rejects malformed composition id', () => {
      expect(() => parseNavigationSearch('composition=Full-Talk')).toThrow(
        /^navigation grammar is invalid: "composition"/,
      );
    });
  });

  describe('beat', () => {
    it('accepts a kebab-case beat label with a scene target', () => {
      expect(parseNavigationSearch('scene=intro&beat=hook')).toEqual({
        locator: { kind: 'scene', scene: 'intro' },
        beat: 'hook',
      });
    });

    it('accepts a beat with composition+scene', () => {
      expect(parseNavigationSearch('composition=full-talk&scene=intro&beat=hook')).toEqual({
        locator: { kind: 'composition-scene', composition: 'full-talk', scene: 'intro' },
        beat: 'hook',
      });
    });

    it('accepts a beat with composition+index', () => {
      expect(parseNavigationSearch('composition=full-talk&index=0&beat=hook')).toEqual({
        locator: { kind: 'composition-index', composition: 'full-talk', index: 0 },
        beat: 'hook',
      });
    });

    it('rejects a malformed beat label', () => {
      expect(() => parseNavigationSearch('scene=intro&beat=Hook')).toThrow(
        /^navigation grammar is invalid: "beat"/,
      );
    });
  });

  describe('index', () => {
    it.each([
      ['0', 0],
      ['1', 1],
      ['12', 12],
      ['123', 123],
      // ADR-013 defines `index` as base-10 / non-negative / safe
      // integer — it does not forbid leading zeros, so `01` parses
      // as 1 and `0007` parses as 7.
      ['01', 1],
      ['0007', 7],
    ])('accepts non-negative base-10 index %s', (encoded, expected) => {
      expect(parseNavigationSearch(`composition=t&index=${encoded}`).locator).toEqual({
        kind: 'composition-index',
        composition: 't',
        index: expected,
      });
    });

    it.each([
      ['negative', '-1'],
      ['decimal', '1.5'],
      ['hex', '0x1'],
      ['plus sign', '+1'],
      ['whitespace', ' 1 '],
      ['empty', ''],
      ['letters', 'one'],
      ['exponent', '1e2'],
    ])('rejects malformed index (%s)', (_label, encoded) => {
      expect(() =>
        parseNavigationSearch(`composition=t&index=${encodeURIComponent(encoded)}`),
      ).toThrow(/^navigation grammar is invalid: "index"/);
    });

    it('rejects an index above Number.MAX_SAFE_INTEGER', () => {
      const big = '9'.repeat(40);
      expect(() => parseNavigationSearch(`composition=t&index=${big}`)).toThrow(
        /^navigation grammar is invalid: "index"/,
      );
    });
  });

  describe('mode', () => {
    it.each(ALL_MODES)('accepts mode=%s', (mode) => {
      expect(parseNavigationSearch(`mode=${mode}`).mode).toBe(mode);
    });

    it('NAVIGATION_MODES is the public allowlist and is frozen', () => {
      expect([...NAVIGATION_MODES]).toEqual([...ALL_MODES]);
      expect(Object.isFrozen(NAVIGATION_MODES)).toBe(true);
    });

    it('rejects an unknown mode and names every allowed mode', () => {
      let caught: Error | undefined;
      try {
        parseNavigationSearch('mode=blah');
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect(caught?.message).toMatch(/^navigation grammar is invalid: "mode"/);
      for (const mode of ALL_MODES) {
        expect(caught?.message).toContain(mode);
      }
    });
  });
});

describe('parseNavigationSearch — ADR-013: combination shapes', () => {
  describe('valid target shapes', () => {
    it('no explicit target with no mode', () => {
      expect(parseNavigationSearch('')).toEqual({ locator: { kind: 'none' } });
    });

    it('no explicit target with optional mode', () => {
      expect(parseNavigationSearch('mode=screenshot')).toEqual({
        locator: { kind: 'none' },
        mode: 'screenshot',
      });
    });

    it('scene only', () => {
      expect(parseNavigationSearch('scene=intro')).toEqual({
        locator: { kind: 'scene', scene: 'intro' },
      });
    });

    it('scene with mode', () => {
      expect(parseNavigationSearch('scene=intro&mode=standalone')).toEqual({
        locator: { kind: 'scene', scene: 'intro' },
        mode: 'standalone',
      });
    });

    it('composition only', () => {
      expect(parseNavigationSearch('composition=full-talk')).toEqual({
        locator: { kind: 'composition', composition: 'full-talk' },
      });
    });

    it('composition with mode', () => {
      expect(parseNavigationSearch('composition=full-talk&mode=present')).toEqual({
        locator: { kind: 'composition', composition: 'full-talk' },
        mode: 'present',
      });
    });

    it('composition + scene', () => {
      expect(parseNavigationSearch('composition=full-talk&scene=intro')).toEqual({
        locator: { kind: 'composition-scene', composition: 'full-talk', scene: 'intro' },
      });
    });

    it('composition + scene + beat + mode', () => {
      expect(
        parseNavigationSearch('composition=full-talk&scene=intro&beat=hook&mode=scrub'),
      ).toEqual({
        locator: { kind: 'composition-scene', composition: 'full-talk', scene: 'intro' },
        beat: 'hook',
        mode: 'scrub',
      });
    });

    it('composition + index', () => {
      expect(parseNavigationSearch('composition=full-talk&index=2')).toEqual({
        locator: { kind: 'composition-index', composition: 'full-talk', index: 2 },
      });
    });

    it('composition + index + beat + mode', () => {
      expect(parseNavigationSearch('composition=full-talk&index=2&beat=hook&mode=loop')).toEqual({
        locator: { kind: 'composition-index', composition: 'full-talk', index: 2 },
        beat: 'hook',
        mode: 'loop',
      });
    });
  });

  describe('invalid combinations', () => {
    it('rejects scene + index together', () => {
      expect(() => parseNavigationSearch('scene=intro&index=0')).toThrow(
        /^navigation grammar is invalid: "scene" and "index" cannot be used together/,
      );
    });

    it('rejects scene + index even with composition', () => {
      expect(() => parseNavigationSearch('composition=t&scene=intro&index=0')).toThrow(
        /^navigation grammar is invalid: "scene" and "index" cannot be used together/,
      );
    });

    it('rejects index without composition', () => {
      expect(() => parseNavigationSearch('index=0')).toThrow(
        /^navigation grammar is invalid: "index" requires "composition"/,
      );
    });

    it('rejects beat with no target', () => {
      expect(() => parseNavigationSearch('beat=hook')).toThrow(
        /^navigation grammar is invalid: "beat"/,
      );
    });

    it('rejects beat with composition only (no scene-like target)', () => {
      expect(() => parseNavigationSearch('composition=t&beat=hook')).toThrow(
        /^navigation grammar is invalid: "beat"/,
      );
    });
  });
});

describe('parseNavigationSearch — ADR-013: repeated keys & unknown keys', () => {
  it.each(['scene', 'composition', 'index', 'beat', 'mode'])(
    'rejects repeated grammar key %s',
    (key) => {
      const search = `${key}=a&${key}=b`;
      expect(() => parseNavigationSearch(search)).toThrow(
        new RegExp(`^navigation grammar is invalid: repeated query parameter "${key}"`),
      );
    },
  );

  it('reports the first repeated grammar key it encounters', () => {
    expect(() => parseNavigationSearch('scene=a&scene=b&mode=loop&mode=present')).toThrow(
      /repeated query parameter "scene"/,
    );
  });

  it('ignores unknown query keys', () => {
    expect(parseNavigationSearch('scene=intro&random=1&another=2')).toEqual({
      locator: { kind: 'scene', scene: 'intro' },
    });
  });

  it('allows repeated unknown keys (unknown is ignored, including repeats)', () => {
    expect(parseNavigationSearch('scene=intro&random=a&random=b')).toEqual({
      locator: { kind: 'scene', scene: 'intro' },
    });
  });
});

describe('parseNavigationSearch — boundary discipline', () => {
  it('does NOT validate scene existence (resolution-layer concern)', () => {
    // ADR-013: composition + scene is id-based; existence/uniqueness in
    // a composition is resolution-layer work, not grammar.
    expect(() => parseNavigationSearch('composition=full-talk&scene=does-not-exist')).not.toThrow();
  });

  it('returns frozen targets so callers cannot mutate the parser output', () => {
    const target = parseNavigationSearch('composition=t&index=0&beat=hook&mode=loop');
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.locator)).toBe(true);
  });
});

describe('subscribeNavigation — clause 2: parse at startup and on popstate', () => {
  interface FakeWindow {
    readonly addEventListener: ReturnType<typeof vi.fn>;
    readonly removeEventListener: ReturnType<typeof vi.fn>;
    readonly location: { search: string };
  }

  const buildFakeWindow = (search: string): FakeWindow => ({
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    location: { search },
  });

  const captureListener = (fake: FakeWindow): (() => void) => {
    expect(fake.addEventListener).toHaveBeenCalledTimes(1);
    const args = fake.addEventListener.mock.calls[0] as readonly unknown[];
    expect(args[0]).toBe('popstate');
    return args[1] as () => void;
  };

  let onNavigate: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onNavigate = vi.fn();
    onError = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const buildOptions = (fake: FakeWindow): NavigationSubscriptionOptions => ({
    window: fake,
    onNavigate,
    onError,
  });

  it('parses the URL once at startup and routes to onNavigate', () => {
    const fake = buildFakeWindow('?scene=intro');
    subscribeNavigation(buildOptions(fake));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({
      locator: { kind: 'scene', scene: 'intro' },
    } satisfies NavigationTarget);
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes startup parser errors to onError', () => {
    const fake = buildFakeWindow('?scene=Bad');
    subscribeNavigation(buildOptions(fake));

    expect(onNavigate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^navigation grammar is invalid:/);
  });

  it('parses again on every popstate using the current location.search', () => {
    const fake = buildFakeWindow('?scene=intro');
    subscribeNavigation(buildOptions(fake));
    onNavigate.mockClear();

    const handler = captureListener(fake);

    fake.location.search = '?scene=outro';
    handler();
    fake.location.search = '?composition=full-talk&index=2';
    handler();

    expect(onNavigate).toHaveBeenNthCalledWith(1, {
      locator: { kind: 'scene', scene: 'outro' },
    } satisfies NavigationTarget);
    expect(onNavigate).toHaveBeenNthCalledWith(2, {
      locator: { kind: 'composition-index', composition: 'full-talk', index: 2 },
    } satisfies NavigationTarget);
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes popstate parser errors to onError without throwing', () => {
    const fake = buildFakeWindow('?scene=intro');
    subscribeNavigation(buildOptions(fake));
    onNavigate.mockClear();

    const handler = captureListener(fake);
    fake.location.search = '?scene=Bad';
    expect(() => handler()).not.toThrow();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('uses the same parser path for startup and popstate (same error semantics)', () => {
    // Both checkpoints emit identical Error.message text for the same
    // malformed URL — the behavior ADR-013 names "same path, same
    // error semantics."
    const fake = buildFakeWindow('?scene=Bad');
    subscribeNavigation(buildOptions(fake));
    const startupErr = onError.mock.calls[0]?.[0] as Error;
    onError.mockClear();
    const handler = captureListener(fake);
    fake.location.search = '?scene=Bad';
    handler();
    const popstateErr = onError.mock.calls[0]?.[0] as Error;

    expect(popstateErr.message).toBe(startupErr.message);
  });

  it('disposer removes the popstate listener', () => {
    const fake = buildFakeWindow('');
    const dispose = subscribeNavigation(buildOptions(fake));
    const handler = captureListener(fake);

    dispose();

    expect(fake.removeEventListener).toHaveBeenCalledTimes(1);
    expect(fake.removeEventListener).toHaveBeenCalledWith('popstate', handler);
  });

  it('deferStartup + dispose() before microtask flush suppresses the queued startup', async () => {
    // Without the disposed flag, an HMR swap that disposes the old
    // subscription before its queued microtask runs would still
    // dispatch a stale startup event. Codex review (cycle 4) flagged
    // this race; this test pins the contract.
    const fake = buildFakeWindow('?scene=intro');
    const dispose = subscribeNavigation({
      window: fake,
      onNavigate,
      onError,
      deferStartup: true,
    });
    dispose();

    await Promise.resolve();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(fake.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('dispose() is idempotent — removeEventListener is called at most once', () => {
    const fake = buildFakeWindow('?scene=intro');
    const dispose = subscribeNavigation(buildOptions(fake));
    dispose();
    dispose();
    dispose();
    expect(fake.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('deferStartup: defers the startup parse to a microtask but registers popstate immediately', async () => {
    // Subscribers registered AFTER subscribeNavigation returns can
    // still observe the initial event when deferStartup is true. The
    // popstate listener is still added synchronously so an event that
    // fires between subscribe and the microtask flush is not missed.
    const fake = buildFakeWindow('?scene=intro');
    subscribeNavigation({
      window: fake,
      onNavigate,
      onError,
      deferStartup: true,
    });

    expect(fake.addEventListener).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({
      locator: { kind: 'scene', scene: 'intro' },
    } satisfies NavigationTarget);
  });

  it('removes the popstate listener if the startup user-callback throws', () => {
    // Without cleanup-on-startup-throw, the disposer never returns and
    // the popstate listener leaks for the entire window lifetime.
    // Codex review (cycle 2) caught this; this test pins the contract.
    const fake = buildFakeWindow('?scene=intro');
    const onNavigateThatThrows = vi.fn(() => {
      throw new Error('user callback bug');
    });
    expect(() =>
      subscribeNavigation({
        window: fake,
        onNavigate: onNavigateThatThrows,
        onError,
      }),
    ).toThrow('user callback bug');
    expect(onNavigateThatThrows).toHaveBeenCalledTimes(1);
    expect(fake.addEventListener).toHaveBeenCalledTimes(1);
    expect(fake.removeEventListener).toHaveBeenCalledTimes(1);
    const addArgs = fake.addEventListener.mock.calls[0];
    const removeArgs = fake.removeEventListener.mock.calls[0];
    expect(removeArgs?.[0]).toBe('popstate');
    expect(removeArgs?.[1]).toBe(addArgs?.[1]);
  });
});

describe('bootstrapNavigation — runtime entry wiring', () => {
  // Browser-shaped fake: a real `EventTarget` wrapped with the
  // `location.search` property the parser needs. Using a real
  // EventTarget (rather than vi.fn stubs) proves the popstate dispatch
  // flows through the helper end-to-end. The fake exposes its
  // underlying EventTarget so tests can register listeners for
  // 'pulsar:navigate' / 'pulsar:navigate-error' without fighting the
  // narrow popstate-only listener typing on NavigationEventTarget.
  interface FakeBrowser {
    readonly target: NavigationEventTarget;
    readonly events: EventTarget;
    setSearch(value: string): void;
    firePopstate(): void;
  }

  const buildFakeBrowser = (initial: string): FakeBrowser => {
    const events = new EventTarget();
    let search = initial;
    const target: NavigationEventTarget = {
      addEventListener: (event, listener) => {
        events.addEventListener(event, listener as EventListener);
      },
      removeEventListener: (event, listener) => {
        events.removeEventListener(event, listener as EventListener);
      },
      dispatchEvent: (event) => events.dispatchEvent(event),
      get location() {
        return { search };
      },
    };
    return {
      target,
      events,
      setSearch(value) {
        search = value;
      },
      firePopstate() {
        events.dispatchEvent(new Event('popstate'));
      },
    };
  };

  const collectNavigateEvents = (browser: FakeBrowser): CustomEvent<NavigationTarget>[] => {
    const out: CustomEvent<NavigationTarget>[] = [];
    browser.events.addEventListener(PULSAR_NAVIGATE_EVENT_TYPE, (evt) => {
      out.push(evt as CustomEvent<NavigationTarget>);
    });
    return out;
  };

  const collectErrorEvents = (browser: FakeBrowser): CustomEvent<Error>[] => {
    const out: CustomEvent<Error>[] = [];
    browser.events.addEventListener(PULSAR_NAVIGATE_ERROR_EVENT_TYPE, (evt) => {
      out.push(evt as CustomEvent<Error>);
    });
    return out;
  };

  // bootstrapNavigation defers the startup parse to a microtask; flush
  // it before asserting on the first event. Microtasks run before any
  // awaited promise resolves, so a single `await Promise.resolve()` is
  // enough.
  const flushMicrotasks = async (): Promise<void> => {
    await Promise.resolve();
  };

  it('defers the startup parse so subscribers can register before the first event', async () => {
    // The subscriber registered AFTER bootstrapNavigation returns must
    // still observe the initial event. Without microtask deferral this
    // would miss the startup dispatch.
    const browser = buildFakeBrowser('?scene=intro');
    bootstrapNavigation(browser.target);
    const navigate = collectNavigateEvents(browser);

    expect(navigate).toHaveLength(0); // not fired yet
    await flushMicrotasks();
    expect(navigate).toHaveLength(1);
    const evt = navigate[0];
    if (!evt) throw new Error('expected at least one navigate event');
    expect(evt.type).toBe('pulsar:navigate');
    expect(evt.detail).toEqual({
      locator: { kind: 'scene', scene: 'intro' },
    } satisfies NavigationTarget);
  });

  it('dispatches CustomEvent<NavigationTarget> on each popstate using the current search', async () => {
    const browser = buildFakeBrowser('?scene=intro');
    const navigate = collectNavigateEvents(browser);
    bootstrapNavigation(browser.target);
    await flushMicrotasks();
    navigate.length = 0; // discard startup event

    browser.setSearch('?scene=outro');
    browser.firePopstate();
    browser.setSearch('?composition=full-talk&index=2');
    browser.firePopstate();

    expect(navigate.map((evt) => evt.detail)).toEqual([
      { locator: { kind: 'scene', scene: 'outro' } },
      { locator: { kind: 'composition-index', composition: 'full-talk', index: 2 } },
    ]);
  });

  it('dispatches CustomEvent<Error> on parse failure (startup or popstate)', async () => {
    const browser = buildFakeBrowser('?scene=Bad');
    const errors = collectErrorEvents(browser);
    bootstrapNavigation(browser.target);
    await flushMicrotasks();

    expect(errors).toHaveLength(1);
    const startup = errors[0];
    if (!startup) throw new Error('expected at least one error event');
    expect(startup.type).toBe('pulsar:navigate-error');
    expect(startup.detail).toBeInstanceOf(Error);
    expect(startup.detail.message).toMatch(/^navigation grammar is invalid:/);

    errors.length = 0;
    browser.setSearch('?index=1');
    browser.firePopstate();
    expect(errors).toHaveLength(1);
    const popstateErr = errors[0];
    if (!popstateErr) throw new Error('expected popstate error event');
    expect(popstateErr.detail.message).toMatch(/^navigation grammar is invalid:/);
  });

  it('disposer stops further popstate dispatch', async () => {
    const browser = buildFakeBrowser('');
    const navigate = collectNavigateEvents(browser);
    const dispose = bootstrapNavigation(browser.target);
    await flushMicrotasks();
    navigate.length = 0;

    dispose();
    browser.setSearch('?scene=outro');
    browser.firePopstate();

    expect(navigate).toHaveLength(0);
  });

  it('event-type constants match the dispatched event types', () => {
    expect(PULSAR_NAVIGATE_EVENT_TYPE).toBe('pulsar:navigate');
    expect(PULSAR_NAVIGATE_ERROR_EVENT_TYPE).toBe('pulsar:navigate-error');
  });
});
