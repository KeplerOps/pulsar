import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NAVIGATION_MODES,
  type NavigationMode,
  type NavigationSubscriptionOptions,
  type NavigationTarget,
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
    ])('accepts non-negative base-10 index %s', (encoded, expected) => {
      expect(parseNavigationSearch(`composition=t&index=${encoded}`).locator).toEqual({
        kind: 'composition-index',
        composition: 't',
        index: expected,
      });
    });

    it.each([
      ['negative', '-1'],
      ['leading zero', '01'],
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
});
