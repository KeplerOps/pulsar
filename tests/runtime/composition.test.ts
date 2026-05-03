import { describe, expect, it } from 'vitest';
import {
  type CompositionEntry,
  type CompositionEntryOverride,
  type CompositionManifest,
  type SubRange,
  assertCompositionManifest,
  isCompositionManifest,
} from '../../src/runtime/composition';

// ADR-002 §Composition manifests example fixtures, kept literally so
// that any drift between the validator and the canonical examples
// surfaces immediately.
const adr002FullTalk = ['scene-a', 'scene-b', 'scene-c', 'scene-d'] as const;
const adr002ShortTalk = ['scene-a', 'scene-c'] as const;
const adr002Trailer = [
  { id: 'scene-a', range: ['intro', 'hook'] as const },
  { id: 'scene-c', range: 'payoff' },
] as const;

describe('CompositionManifest format (PUL-F003)', () => {
  describe('clause C1 — declarative ordered list (top-level shape)', () => {
    it('accepts the empty array — the format does not preclude empty manifests', () => {
      expect(() => assertCompositionManifest([])).not.toThrow();
    });

    it('accepts a single bare-string entry', () => {
      expect(() => assertCompositionManifest(['scene-a'])).not.toThrow();
    });

    it('accepts an array of multiple entries (ADR-002 fullTalk fixture)', () => {
      expect(() => assertCompositionManifest([...adr002FullTalk])).not.toThrow();
    });

    it.each<[string, unknown]>([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'scene-a'],
      ['a number', 42],
      ['a boolean', true],
      ['a plain object', { id: 'scene-a' }],
      ['a Set', new Set(['scene-a'])],
      ['a Map', new Map()],
    ])('rejects %s as a manifest (must be an array)', (_label, value) => {
      expect(() => assertCompositionManifest(value)).toThrow(
        /^composition manifest is invalid: must be an array/,
      );
    });

    it('reports the top-level error without an entry index', () => {
      expect(() => assertCompositionManifest('not an array')).toThrow(
        /^composition manifest is invalid:/,
      );
      expect(() => assertCompositionManifest('not an array')).not.toThrow(/entry \[/);
    });
  });

  describe('clause C2 — bare scene id string entries', () => {
    describe('valid kebab-case ids', () => {
      it.each(['a', 'scene-a', 'cold-open', 'a-b-c', 'intro1', '1', 'a1-b2', '9-9'])(
        'accepts %j',
        (id) => {
          expect(() => assertCompositionManifest([id])).not.toThrow();
        },
      );
    });

    describe('invalid bare-string entries are rejected', () => {
      it.each<[string, string]>([
        ['empty string', ''],
        ['uppercase letter', 'Scene-a'],
        ['fully uppercase', 'SCENE-A'],
        ['underscore separator', 'scene_a'],
        ['leading hyphen', '-scene'],
        ['trailing hyphen', 'scene-'],
        ['consecutive hyphens', 'a--b'],
        ['internal whitespace', 'scene a'],
        ['leading whitespace', ' scene-a'],
        ['trailing whitespace', 'scene-a '],
        ['newline', 'scene-a\n'],
        ['punctuation', 'scene.a'],
        ['slash', 'scene/a'],
        ['colon', 'scene:a'],
        ['non-ASCII', 'séance'],
      ])('rejects %s (%j) with a kebab-case condition', (_label, id) => {
        expect(() => assertCompositionManifest([id])).toThrow(
          /^composition entry \[0\] is invalid: id must be a non-empty lowercase kebab-case string/,
        );
      });
    });

    it('rejects when the failing entry is in the middle of the manifest, reporting its index and field', () => {
      const manifest = ['scene-a', 'scene-b', 'Bad-Entry', 'scene-c'];
      expect(() => assertCompositionManifest(manifest)).toThrow(
        /^composition entry \[2\] is invalid: id must be a non-empty lowercase kebab-case string/,
      );
    });

    it('rejects when the failing entry is the last entry', () => {
      const manifest = ['scene-a', 'scene-b', ''];
      expect(() => assertCompositionManifest(manifest)).toThrow(
        /^composition entry \[2\] is invalid: id must be a non-empty lowercase kebab-case string/,
      );
    });
  });

  describe('clause C3 — object entries with overrides', () => {
    describe('id field', () => {
      it('accepts the minimal { id } object entry', () => {
        expect(() => assertCompositionManifest([{ id: 'scene-a' }])).not.toThrow();
      });

      it('rejects when id is missing', () => {
        expect(() => assertCompositionManifest([{}])).toThrow(
          /^composition entry \[0\] is invalid: id must be present/,
        );
      });

      it.each<[string, unknown]>([
        ['null', null],
        ['undefined', undefined],
        ['a number', 42],
        ['an array', ['scene-a']],
        ['an object', { id: 'scene-a' }],
        ['empty string', ''],
        ['Uppercase', 'Scene-A'],
        ['underscore_id', 'scene_a'],
      ])('rejects when id is %s (%j)', (_label, badId) => {
        expect(() => assertCompositionManifest([{ id: badId }])).toThrow(
          /^composition entry \[0\] is invalid: id /,
        );
      });
    });

    describe('range override (sub-range — ADR-003 §Labels)', () => {
      it('accepts a single-string range (single beat label)', () => {
        expect(() => assertCompositionManifest([{ id: 'scene-a', range: 'payoff' }])).not.toThrow();
      });

      it('accepts a [start, end] tuple range', () => {
        expect(() =>
          assertCompositionManifest([{ id: 'scene-a', range: ['intro', 'hook'] }]),
        ).not.toThrow();
      });

      it('accepts ranges using single-segment kebab labels', () => {
        expect(() =>
          assertCompositionManifest([{ id: 'scene-a', range: ['act1', 'act2'] }]),
        ).not.toThrow();
      });

      it('accepts multi-segment kebab labels in ranges', () => {
        expect(() =>
          assertCompositionManifest([{ id: 'scene-a', range: ['cold-open', 'final-beat'] }]),
        ).not.toThrow();
      });

      it.each<[string, unknown]>([
        ['empty string', ''],
        ['uppercase', 'Intro'],
        ['underscore', 'in_tro'],
        ['leading hyphen', '-intro'],
        ['internal whitespace', 'in tro'],
      ])('rejects single-string range %s (%j)', (_label, range) => {
        expect(() => assertCompositionManifest([{ id: 'scene-a', range }])).toThrow(
          /^composition entry \[0\] is invalid: range /,
        );
      });

      it.each<[string, unknown]>([
        ['number', 42],
        ['boolean', true],
        ['null', null],
        ['plain object', { start: 'a', end: 'b' }],
        ['Set', new Set(['intro', 'hook'])],
      ])('rejects non-string non-array range value (%s)', (_label, range) => {
        expect(() => assertCompositionManifest([{ id: 'scene-a', range }])).toThrow(
          /^composition entry \[0\] is invalid: range /,
        );
      });

      it('rejects a length-1 range array', () => {
        expect(() => assertCompositionManifest([{ id: 'scene-a', range: ['intro'] }])).toThrow(
          /^composition entry \[0\] is invalid: range /,
        );
      });

      it('rejects a length-3 range array', () => {
        expect(() =>
          assertCompositionManifest([{ id: 'scene-a', range: ['intro', 'mid', 'hook'] }]),
        ).toThrow(/^composition entry \[0\] is invalid: range /);
      });

      it('rejects an empty range array', () => {
        expect(() => assertCompositionManifest([{ id: 'scene-a', range: [] }])).toThrow(
          /^composition entry \[0\] is invalid: range /,
        );
      });

      it.each<[string, unknown[]]>([
        ['number element', [42, 'hook']],
        ['null element', [null, 'hook']],
        ['nested array', [['intro'], 'hook']],
        ['object element', [{ label: 'intro' }, 'hook']],
        ['empty string element', ['', 'hook']],
        ['uppercase element', ['Intro', 'hook']],
        ['second element invalid', ['intro', 'Hook']],
      ])('rejects range array with %s', (_label, range) => {
        expect(() => assertCompositionManifest([{ id: 'scene-a', range }])).toThrow(
          /^composition entry \[0\] is invalid: range /,
        );
      });
    });

    describe('behavior override', () => {
      it('accepts an empty behavior object', () => {
        expect(() => assertCompositionManifest([{ id: 'scene-a', behavior: {} }])).not.toThrow();
      });

      it('accepts a behavior object with arbitrary keys (resolver-defined)', () => {
        expect(() =>
          assertCompositionManifest([
            { id: 'scene-a', behavior: { mute: true, speed: 1.5, label: 'rehearsal' } },
          ]),
        ).not.toThrow();
      });

      it('accepts an Object.create(null) behavior dictionary', () => {
        const behavior = Object.create(null) as Record<string, unknown>;
        behavior.mute = true;
        expect(() => assertCompositionManifest([{ id: 'scene-a', behavior }])).not.toThrow();
      });

      it.each<[string, unknown]>([
        ['null', null],
        ['undefined-tagged value', 'not-an-object'],
        ['number', 42],
        ['boolean', true],
        ['array', ['mute', true]],
      ])('rejects non-object behavior (%s)', (_label, behavior) => {
        expect(() => assertCompositionManifest([{ id: 'scene-a', behavior }])).toThrow(
          /^composition entry \[0\] is invalid: behavior must be a plain object/,
        );
      });

      // Class instances and built-in non-record objects must not satisfy
      // `behavior` — the contract is a serializable record, not an opaque
      // object instance (codex review, ADR-008 #1).
      it.each<[string, () => unknown]>([
        ['Date', () => new Date()],
        ['Map', () => new Map([['mute', true]])],
        ['Set', () => new Set(['mute'])],
        ['RegExp', () => /payoff/],
        ['Error', () => new Error('boom')],
        [
          'class instance',
          () => {
            class Override {
              mute = true;
            }
            return new Override();
          },
        ],
      ])('rejects %s as behavior (must be a plain object)', (_label, makeBehavior) => {
        expect(() =>
          assertCompositionManifest([{ id: 'scene-a', behavior: makeBehavior() }]),
        ).toThrow(/^composition entry \[0\] is invalid: behavior must be a plain object/);
      });

      it('does NOT inspect the contents of the behavior object', () => {
        expect(() =>
          assertCompositionManifest([
            { id: 'scene-a', behavior: { nested: { weird: () => 'fine' } } },
          ]),
        ).not.toThrow();
      });
    });

    describe('combined overrides', () => {
      it('accepts an entry carrying both range and behavior', () => {
        expect(() =>
          assertCompositionManifest([
            { id: 'scene-a', range: ['intro', 'hook'], behavior: { mute: true } },
          ]),
        ).not.toThrow();
      });
    });

    describe('unknown override keys are rejected (codex preflight guardrail)', () => {
      it('rejects an entry with an unknown override key', () => {
        expect(() => assertCompositionManifest([{ id: 'scene-a', typo: 1 }] as unknown[])).toThrow(
          /^composition entry \[0\] is invalid: unknown key "typo"/,
        );
      });

      it('rejects an entry with multiple unknown keys, naming one of them', () => {
        expect(() =>
          assertCompositionManifest([{ id: 'scene-a', label: 'x', mode: 'y' }] as unknown[]),
        ).toThrow(/^composition entry \[0\] is invalid: unknown key "/);
      });

      it('rejects an entry that mixes a known and an unknown override slot', () => {
        expect(() =>
          assertCompositionManifest([
            { id: 'scene-a', range: 'intro', duration: 1000 },
          ] as unknown[]),
        ).toThrow(/^composition entry \[0\] is invalid: unknown key "duration"/);
      });
    });

    describe('object entries — top-level shape rejections', () => {
      // Note: `null` and `undefined` would normally route through the
      // entry-shape branch (`!isPlainRecord`), but the validator's
      // bare-string branch only fires for typeof === 'string', so
      // these fall through to the same "entry must be ..." message.
      // Numbers/booleans/arrays do the same. Lock the message verbatim
      // so a regression that changes the field name (`entry`) or the
      // condition text gets caught.
      it.each<[string, unknown]>([
        ['null', null],
        ['undefined', undefined],
        ['number', 42],
        ['boolean', true],
        ['array', ['scene-a']],
      ])('rejects a non-plain-object entry (%s)', (_label, entry) => {
        expect(() => assertCompositionManifest([entry])).toThrow(
          /^composition entry \[0\] is invalid: entry must be a kebab-case scene id string or a \{ id, range\?, behavior\? \} object/,
        );
      });

      // Class instances and built-in non-record objects must not satisfy
      // the entry shape — same reasoning as for `behavior` (codex review,
      // ADR-008 #1: manifests are declarative data, not opaque objects).
      it.each<[string, () => unknown]>([
        ['Date', () => new Date()],
        ['Map', () => new Map()],
        ['Set', () => new Set()],
        ['RegExp', () => /scene-a/],
        ['Error', () => new Error('boom')],
        [
          'class instance',
          () => {
            class Entry {
              id = 'scene-a';
            }
            return new Entry();
          },
        ],
      ])('rejects %s as an entry (must be a plain { id, ... } object)', (_label, makeEntry) => {
        expect(() => assertCompositionManifest([makeEntry()])).toThrow(
          /^composition entry \[0\] is invalid: entry must be a kebab-case scene id string or a \{ id, range\?, behavior\? \} object/,
        );
      });
    });
  });

  describe('AC1 — bare and object entries can mix freely (ADR-002 trailer fixture)', () => {
    it('accepts the literal ADR-002 fullTalk example', () => {
      expect(() => assertCompositionManifest([...adr002FullTalk])).not.toThrow();
    });

    it('accepts the literal ADR-002 shortTalk example', () => {
      expect(() => assertCompositionManifest([...adr002ShortTalk])).not.toThrow();
    });

    it('accepts the literal ADR-002 trailer example (mixed object overrides)', () => {
      expect(() => assertCompositionManifest([...adr002Trailer])).not.toThrow();
    });

    it('accepts arbitrary mixes of bare strings and override objects', () => {
      const mixed: CompositionEntry[] = [
        'scene-a',
        { id: 'scene-b', range: 'hook' },
        'scene-c',
        { id: 'scene-d', range: ['intro', 'outro'], behavior: { speed: 1.25 } },
      ];
      expect(() => assertCompositionManifest(mixed)).not.toThrow();
    });

    it('reports the correct index when a bad entry sits among valid mixed entries', () => {
      const mixed = ['scene-a', { id: 'scene-b' }, 'Bad-Entry', { id: 'scene-d' }];
      expect(() => assertCompositionManifest(mixed)).toThrow(
        /^composition entry \[2\] is invalid:/,
      );
    });

    it('does not reject duplicate scene references — recomposition may reuse scenes', () => {
      // Per codex preflight guardrail: duplicate references are intentional.
      expect(() =>
        assertCompositionManifest(['scene-a', 'scene-b', 'scene-a', { id: 'scene-a' }]),
      ).not.toThrow();
    });
  });

  describe('AC2 — actionable error messages', () => {
    it('reports field name and human-readable condition for id', () => {
      expect(() => assertCompositionManifest([{ id: 'Scene-A' }])).toThrow(
        /id must be a non-empty lowercase kebab-case string/,
      );
    });

    it('reports field name and human-readable condition for range', () => {
      expect(() => assertCompositionManifest([{ id: 'scene-a', range: 42 }])).toThrow(
        /range must be a kebab-case beat label or a \[start, end\] tuple of kebab-case beat labels/,
      );
    });

    it('reports field name and human-readable condition for behavior', () => {
      expect(() => assertCompositionManifest([{ id: 'scene-a', behavior: 'no' }])).toThrow(
        /behavior must be a plain object/,
      );
    });

    it('stops at the first failing entry (does not aggregate)', () => {
      const manifest = ['Bad-One', 'Bad-Two'];
      // Should report index [0], not [1].
      expect(() => assertCompositionManifest(manifest)).toThrow(/entry \[0\]/);
      expect(() => assertCompositionManifest(manifest)).not.toThrow(/entry \[1\]/);
    });
  });

  describe('isCompositionManifest predicate', () => {
    it('returns true for valid manifests', () => {
      expect(isCompositionManifest([])).toBe(true);
      expect(isCompositionManifest([...adr002FullTalk])).toBe(true);
      expect(isCompositionManifest([...adr002Trailer])).toBe(true);
      expect(isCompositionManifest([{ id: 'scene-a', range: ['intro', 'hook'] }])).toBe(true);
    });

    it('returns false for invalid manifests without throwing', () => {
      expect(isCompositionManifest(null)).toBe(false);
      expect(isCompositionManifest('scene-a')).toBe(false);
      expect(isCompositionManifest([{ id: 'Bad-Id' }])).toBe(false);
      expect(isCompositionManifest([{ id: 'scene-a', range: 42 }])).toBe(false);
      expect(isCompositionManifest([{ id: 'scene-a', typo: 1 }])).toBe(false);
    });

    it('does not throw on any input', () => {
      const adversarial: unknown[] = [
        undefined,
        null,
        42,
        'string',
        {},
        [],
        [null],
        [{ id: 'x', range: 'y', extra: 'z' }],
      ];
      for (const input of adversarial) {
        expect(() => isCompositionManifest(input)).not.toThrow();
      }
    });
  });

  describe('exported types compile (smoke check)', () => {
    it('SubRange union covers string and tuple shapes', () => {
      const single: SubRange = 'intro';
      const tuple: SubRange = ['intro', 'hook'];
      expect([single, tuple]).toEqual(['intro', ['intro', 'hook']]);
    });

    it('CompositionEntryOverride permits id alone, with range, with behavior, or with both', () => {
      const a: CompositionEntryOverride = { id: 'scene-a' };
      const b: CompositionEntryOverride = { id: 'scene-a', range: 'hook' };
      const c: CompositionEntryOverride = { id: 'scene-a', behavior: { speed: 2 } };
      const d: CompositionEntryOverride = {
        id: 'scene-a',
        range: ['intro', 'hook'],
        behavior: { speed: 2 },
      };
      const manifest: CompositionManifest = [a, b, c, d];
      expect(manifest).toHaveLength(4);
    });
  });
});
