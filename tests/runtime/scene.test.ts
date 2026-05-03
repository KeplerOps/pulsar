import { describe, expect, it } from 'vitest';
import {
  type Caption,
  type SceneModule,
  assertSceneModule,
  isSceneModule,
} from '../../src/runtime/scene';

const validScene = (): SceneModule => ({
  id: 'scene-a',
  title: 'Scene A',
  duration: 5000,
  tags: ['act-i'],
  assets: [],
  captions: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  create: () => undefined,
  timeline: () => undefined,
  cleanup: () => undefined,
});

const REQUIRED_FIELDS = [
  'id',
  'title',
  'duration',
  'tags',
  'assets',
  'captions',
  'defaultNext',
  'standalone',
  'trailerSafe',
  'create',
  'timeline',
  'cleanup',
] as const;

const omitField = <K extends keyof SceneModule>(field: K): Record<string, unknown> => {
  const scene: Record<string, unknown> = { ...validScene() };
  delete scene[field as string];
  return scene;
};

const withField = (field: string, value: unknown): Record<string, unknown> => ({
  ...validScene(),
  [field]: value,
});

const withDuration = (duration: unknown): Record<string, unknown> =>
  withField('duration', duration);

describe('SceneModule contract (PUL-F001)', () => {
  describe('required fields are present', () => {
    it('accepts a valid minimal scene module', () => {
      expect(() => assertSceneModule(validScene())).not.toThrow();
    });

    it.each(REQUIRED_FIELDS)('rejects when "%s" is missing', (field) => {
      expect(() => assertSceneModule(omitField(field))).toThrow(new RegExp(`\\b${field}\\b`));
    });

    it('rejects null input', () => {
      expect(() => assertSceneModule(null)).toThrow(/object/i);
    });

    it('rejects undefined input', () => {
      expect(() => assertSceneModule(undefined)).toThrow(/object/i);
    });

    it('rejects a string input', () => {
      expect(() => assertSceneModule('not an object')).toThrow(/object/i);
    });

    it('rejects a number input', () => {
      expect(() => assertSceneModule(42)).toThrow(/object/i);
    });

    it('rejects an array input', () => {
      expect(() => assertSceneModule([])).toThrow(/object/i);
    });
  });

  describe('duration rules', () => {
    it('accepts 0', () => {
      expect(() => assertSceneModule(withDuration(0))).not.toThrow();
    });

    it('accepts a positive integer (5000)', () => {
      expect(() => assertSceneModule(withDuration(5000))).not.toThrow();
    });

    it('accepts null (open-ended / interrupt-driven)', () => {
      expect(() => assertSceneModule(withDuration(null))).not.toThrow();
    });

    it('rejects a negative integer', () => {
      expect(() => assertSceneModule(withDuration(-1))).toThrow(/duration/);
    });

    it('rejects a float', () => {
      expect(() => assertSceneModule(withDuration(1.5))).toThrow(/duration/);
    });

    it('rejects NaN', () => {
      expect(() => assertSceneModule(withDuration(Number.NaN))).toThrow(/duration/);
    });

    it('rejects Infinity', () => {
      expect(() => assertSceneModule(withDuration(Number.POSITIVE_INFINITY))).toThrow(/duration/);
    });

    it('rejects -Infinity', () => {
      expect(() => assertSceneModule(withDuration(Number.NEGATIVE_INFINITY))).toThrow(/duration/);
    });

    it('rejects undefined value', () => {
      expect(() => assertSceneModule(withDuration(undefined))).toThrow(/duration/);
    });

    it('rejects a string', () => {
      expect(() => assertSceneModule(withDuration('5000'))).toThrow(/duration/);
    });

    it('rejects boolean', () => {
      expect(() => assertSceneModule(withDuration(true))).toThrow(/duration/);
    });
  });

  describe('field types', () => {
    it('rejects non-string id', () => {
      expect(() => assertSceneModule(withField('id', 42))).toThrow(/id/);
    });

    it('rejects non-string title', () => {
      expect(() => assertSceneModule(withField('title', 42))).toThrow(/title/);
    });

    it('rejects non-array tags', () => {
      expect(() => assertSceneModule(withField('tags', 'not-an-array'))).toThrow(/tags/);
    });

    it('rejects non-string elements in tags', () => {
      expect(() => assertSceneModule(withField('tags', [42]))).toThrow(/tags/);
    });

    it('rejects non-array assets', () => {
      expect(() => assertSceneModule(withField('assets', 'not-an-array'))).toThrow(/assets/);
    });

    it('rejects non-string elements in assets', () => {
      expect(() => assertSceneModule(withField('assets', [42]))).toThrow(/assets/);
    });

    it('rejects non-array captions', () => {
      expect(() => assertSceneModule(withField('captions', 'not-an-array'))).toThrow(/captions/);
    });

    it('rejects non-(string|null) defaultNext (number)', () => {
      expect(() => assertSceneModule(withField('defaultNext', 42))).toThrow(/defaultNext/);
    });

    it('rejects non-(string|null) defaultNext (undefined value)', () => {
      expect(() => assertSceneModule(withField('defaultNext', undefined))).toThrow(/defaultNext/);
    });

    it('accepts kebab-case string defaultNext', () => {
      expect(() => assertSceneModule(withField('defaultNext', 'next-scene'))).not.toThrow();
    });

    it.each<[string, string]>([
      ['empty string', ''],
      ['uppercase', 'Scene-B'],
      ['underscore', 'scene_b'],
      ['leading hyphen', '-scene-b'],
      ['trailing hyphen', 'scene-b-'],
      ['consecutive hyphens', 'scene--b'],
      ['whitespace', 'scene b'],
      ['punctuation', 'scene.b'],
      ['non-ASCII', 'séance'],
    ])(
      'rejects non-kebab-case defaultNext (%s) — defaultNext is a scene id reference (PUL-A007)',
      (_label, value) => {
        expect(() => assertSceneModule(withField('defaultNext', value))).toThrow(/defaultNext/);
      },
    );

    it('rejects non-boolean standalone', () => {
      expect(() => assertSceneModule(withField('standalone', 'yes'))).toThrow(/standalone/);
    });

    it('rejects non-boolean trailerSafe', () => {
      expect(() => assertSceneModule(withField('trailerSafe', 1))).toThrow(/trailerSafe/);
    });

    it('rejects non-function create', () => {
      expect(() => assertSceneModule(withField('create', null))).toThrow(/create/);
    });

    it('rejects non-function timeline', () => {
      expect(() => assertSceneModule(withField('timeline', null))).toThrow(/timeline/);
    });

    it('rejects non-function cleanup', () => {
      expect(() => assertSceneModule(withField('cleanup', null))).toThrow(/cleanup/);
    });
  });

  describe('caption element shape', () => {
    const captionScene = (caption: unknown): Record<string, unknown> =>
      withField('captions', [caption]);

    it('accepts a valid caption', () => {
      const cap: Caption = { at: 1000, text: 'hello' };
      expect(() => assertSceneModule(captionScene(cap))).not.toThrow();
    });

    it('accepts multiple captions', () => {
      expect(() =>
        assertSceneModule(
          withField('captions', [
            { at: 0, text: 'opening hook' },
            { at: 4000, text: 'first payoff' },
          ]),
        ),
      ).not.toThrow();
    });

    it('rejects caption with non-number "at"', () => {
      expect(() => assertSceneModule(captionScene({ at: '1000', text: 'hi' }))).toThrow(/captions/);
    });

    it('rejects caption with non-string "text"', () => {
      expect(() => assertSceneModule(captionScene({ at: 1000, text: 42 }))).toThrow(/captions/);
    });

    it('rejects caption that is not an object', () => {
      expect(() => assertSceneModule(captionScene('not-a-caption'))).toThrow(/captions/);
    });

    it('rejects caption that is null', () => {
      expect(() => assertSceneModule(captionScene(null))).toThrow(/captions/);
    });
  });

  describe('happy path', () => {
    it('accepts a scene with duration=0', () => {
      expect(() => assertSceneModule({ ...validScene(), duration: 0 })).not.toThrow();
    });

    it('accepts a scene with duration=null', () => {
      expect(() => assertSceneModule({ ...validScene(), duration: null })).not.toThrow();
    });

    it('accepts a scene with defaultNext set to a sibling id', () => {
      expect(() => assertSceneModule({ ...validScene(), defaultNext: 'scene-b' })).not.toThrow();
    });

    it('accepts a scene with all metadata populated', () => {
      const scene: SceneModule = {
        id: 'cold-open',
        title: 'Cold Open',
        duration: 12000,
        tags: ['act-i', 'theme'],
        assets: ['assets/cold-open/blackout.jpg', 'assets/audio/stinger.mp3'],
        captions: [
          { at: 0, text: 'Opening hook.' },
          { at: 4000, text: 'First payoff.' },
        ],
        defaultNext: 'scene-a',
        standalone: true,
        trailerSafe: true,
        create: () => undefined,
        timeline: () => undefined,
        cleanup: () => undefined,
      };
      expect(() => assertSceneModule(scene)).not.toThrow();
    });
  });

  describe('isSceneModule predicate', () => {
    it('returns true for a valid scene', () => {
      expect(isSceneModule(validScene())).toBe(true);
    });

    it('returns false for an invalid scene', () => {
      expect(isSceneModule({ ...validScene(), duration: -1 })).toBe(false);
    });

    it('returns false for null', () => {
      expect(isSceneModule(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isSceneModule(undefined)).toBe(false);
    });
  });

  describe('scene id format (PUL-A007)', () => {
    describe('valid kebab-case ids', () => {
      it.each(['a', 'scene-a', 'cold-open', 'a-b-c', 'intro1', '1', 'a1-b2', '9-9'])(
        'accepts %j',
        (id) => {
          expect(() => assertSceneModule(withField('id', id))).not.toThrow();
        },
      );
    });

    describe('invalid id formats are rejected', () => {
      it.each<[string, string]>([
        ['empty string', ''],
        ['uppercase letter', 'Scene-a'],
        ['all uppercase', 'SCENE'],
        ['mixed case in segment', 'a-A'],
        ['underscore separator', 'scene_a'],
        ['leading underscore', '_scene'],
        ['underscore in segment', 'a_b'],
        ['leading hyphen', '-scene'],
        ['trailing hyphen', 'scene-'],
        ['consecutive hyphens', 'a--b'],
        ['leading consecutive hyphens', '--scene'],
        ['hyphen only', '-'],
        ['double hyphen only', '--'],
        ['internal space', 'scene a'],
        ['leading space', ' scene'],
        ['trailing tab', 'scene\t'],
        ['period', 'scene.a'],
        ['slash', 'scene/a'],
        ['at sign', 'scene@a'],
        ['accented latin', 'séance'],
        ['cedilla', 'café'],
        ['CJK characters', '你好'],
      ])('rejects %s (%j)', (_label, id) => {
        expect(() => assertSceneModule(withField('id', id))).toThrow(/\bid\b/);
      });
    });

    describe('error messages on bad ids', () => {
      it('includes the offending id value when it is a string', () => {
        expect(() => assertSceneModule(withField('id', 'Scene-A'))).toThrow(
          /scene "Scene-A" is invalid: id /,
        );
      });

      it('keys on the empty-string id when surfacing the error', () => {
        expect(() => assertSceneModule(withField('id', ''))).toThrow(/scene "" is invalid: id /);
      });
    });
  });

  describe('error messages identify the offending entity and condition', () => {
    it('includes the scene id when known', () => {
      expect(() => assertSceneModule({ ...validScene(), duration: -1 })).toThrow(
        /scene "scene-a" is invalid/,
      );
    });

    it('uses "?" for the entity when id is missing', () => {
      expect(() => assertSceneModule(omitField('id'))).toThrow(/scene \? is invalid/);
    });

    it('names the offending field', () => {
      expect(() => assertSceneModule({ ...validScene(), tags: 'oops' })).toThrow(/tags/);
    });

    it('describes the failing condition', () => {
      expect(() => assertSceneModule({ ...validScene(), duration: 1.5 })).toThrow(
        /non-negative integer/,
      );
    });
  });
});
