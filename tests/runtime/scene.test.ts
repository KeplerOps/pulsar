import { describe, expect, it } from 'vitest';
import {
  type Caption,
  type SceneModule,
  assertSceneModule,
  defineScene,
  isSceneModule,
  sceneDeclaresAudio,
} from '../../src/runtime/scene';
import { type FuzzField, runValidatorFuzz } from './validator-fuzz';

const validScene = (): SceneModule => ({
  id: 'scene-a',
  title: 'Scene A',
  duration: 5000,
  tags: ['act-i'],
  assets: [],
  captions: [],
  audio: [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  create: () => undefined,
  timeline: () => undefined,
  cleanup: () => undefined,
});

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

// Every required field and its expected kind, driving the property
// fuzz below. `captions` and `audio` are validated by the dedicated
// indexed-message / cross-field suites, so they are fuzzed there.
const SCENE_FIELDS: readonly FuzzField[] = [
  { name: 'id', kind: 'kebab-id', omittable: true },
  { name: 'title', kind: 'string', omittable: true },
  { name: 'duration', kind: 'nonneg-int-or-null', omittable: true },
  { name: 'tags', kind: 'string-array', omittable: true },
  { name: 'assets', kind: 'string-array', omittable: true },
  { name: 'defaultNext', kind: 'kebab-id-or-null', omittable: true },
  { name: 'standalone', kind: 'boolean', omittable: true },
  { name: 'trailerSafe', kind: 'boolean', omittable: true },
  { name: 'create', kind: 'function', omittable: true },
  { name: 'timeline', kind: 'function', omittable: true },
  { name: 'cleanup', kind: 'function', omittable: true },
];

describe('SceneModule contract (PUL-F001)', () => {
  it('accepts a valid minimal scene module', () => {
    expect(() => assertSceneModule(validScene())).not.toThrow();
  });

  describe('top-level shape', () => {
    it.each<[string, unknown]>([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'not an object'],
      ['a number', 42],
      ['an array', []],
    ])('rejects %s (must be a non-null object)', (_label, value) => {
      expect(() => assertSceneModule(value)).toThrow(/object/i);
    });
  });

  // Property fuzz over every required field and the four malformed-
  // input classes (omission, wrong type, out-of-range number, non-
  // kebab id), replacing the former per-value `it.each` enumerations.
  // Each draw is guaranteed-invalid for its field kind and the
  // validator must name the offending field. Seeded so a failure
  // reproduces.
  it('rejects every required field across the malformed-input space (property fuzz)', () => {
    runValidatorFuzz({
      seed: 'scene-module',
      valid: () => ({ ...validScene() }),
      fields: SCENE_FIELDS,
      assert: assertSceneModule,
    });
  });

  describe('field-value boundaries (representative asserts)', () => {
    it('accepts duration 0, a positive integer, and null', () => {
      expect(() => assertSceneModule(withDuration(0))).not.toThrow();
      expect(() => assertSceneModule(withDuration(5000))).not.toThrow();
      expect(() => assertSceneModule(withDuration(null))).not.toThrow();
    });

    it('accepts a kebab-case string defaultNext', () => {
      expect(() => assertSceneModule(withField('defaultNext', 'next-scene'))).not.toThrow();
    });

    it('rejects a non-array captions field, naming captions', () => {
      expect(() => assertSceneModule(withField('captions', 'not-an-array'))).toThrow(/captions/);
    });
  });

  describe('caption element shape (PUL-F027)', () => {
    // PUL-F027 widens `Caption.at` from `number` to `number | string`,
    // where the string is a kebab-case beat label sharing the existing
    // ADR-008 #1 identifier grammar. The numeric branch tightens to
    // "finite, non-negative integer milliseconds" — the values the
    // existing scene-module contract documents but did not gate.
    const captionScene = (caption: unknown): Record<string, unknown> =>
      withField('captions', [caption]);

    it('accepts a valid numeric caption', () => {
      const cap: Caption = { at: 1000, text: 'hello' };
      expect(() => assertSceneModule(captionScene(cap))).not.toThrow();
    });

    it('accepts at: 0 (frame zero)', () => {
      expect(() => assertSceneModule(captionScene({ at: 0, text: 'hi' }))).not.toThrow();
    });

    it('accepts a kebab-case beat-label "at" (PUL-F027 string branch)', () => {
      // ADR-008 #1: scenes, compositions, beats, and assets share one
      // identifier grammar. A caption pinned to a named beat uses the
      // same kebab-case string a timeline label uses.
      expect(() =>
        assertSceneModule(captionScene({ at: 'midpoint', text: 'pivotal line' })),
      ).not.toThrow();
    });

    it('accepts mixed numeric and beat-label captions in one scene', () => {
      expect(() =>
        assertSceneModule(
          withField('captions', [
            { at: 0, text: 'opening hook' },
            { at: 'hook', text: 'named beat caption' },
            { at: 4000, text: 'first payoff' },
            { at: 'midpoint-stinger', text: 'multi-segment label' },
          ]),
        ),
      ).not.toThrow();
    });

    it('rejects a non-integer numeric "at"', () => {
      expect(() => assertSceneModule(captionScene({ at: 1.5, text: 'hi' }))).toThrow(/captions/);
    });

    it('rejects a negative "at"', () => {
      expect(() => assertSceneModule(captionScene({ at: -1, text: 'hi' }))).toThrow(/captions/);
    });

    it('rejects NaN "at"', () => {
      expect(() => assertSceneModule(captionScene({ at: Number.NaN, text: 'hi' }))).toThrow(
        /captions/,
      );
    });

    it('rejects Infinity "at"', () => {
      expect(() =>
        assertSceneModule(captionScene({ at: Number.POSITIVE_INFINITY, text: 'hi' })),
      ).toThrow(/captions/);
      expect(() =>
        assertSceneModule(captionScene({ at: Number.NEGATIVE_INFINITY, text: 'hi' })),
      ).toThrow(/captions/);
    });

    it('rejects an empty-string "at"', () => {
      expect(() => assertSceneModule(captionScene({ at: '', text: 'hi' }))).toThrow(/captions/);
    });

    it('rejects a non-kebab-case label "at"', () => {
      // The preflight names every shape the kebab regex rejects.
      expect(() => assertSceneModule(captionScene({ at: 'Bad Label', text: 'hi' }))).toThrow(
        /captions/,
      );
      expect(() => assertSceneModule(captionScene({ at: 'midpoint!', text: 'hi' }))).toThrow(
        /captions/,
      );
      expect(() => assertSceneModule(captionScene({ at: '--mid', text: 'hi' }))).toThrow(
        /captions/,
      );
      expect(() => assertSceneModule(captionScene({ at: 'a--b', text: 'hi' }))).toThrow(/captions/);
      expect(() => assertSceneModule(captionScene({ at: 'scene_a', text: 'hi' }))).toThrow(
        /captions/,
      );
    });

    it('accepts a digit-only beat-label "at" (it satisfies the shared kebab grammar)', () => {
      // Codex review, cycle 1: caption beat labels share the ONE
      // identifier grammar ADR-008 #1 reserves for scenes,
      // compositions, beats, and assets. The shared kebab regex
      // accepts purely-digit labels (`[a-z0-9]+`), and a caption
      // label MUST NOT carry a stricter sub-grammar — a timeline
      // label of `"1000"` is valid, a URL `beat=1000` is valid, a
      // composition `range: ["1000", ...]` is valid, so the caption
      // schema is consistent. A string `at` value is interpreted
      // as a beat label, not as a coerced number; if the author
      // wants 1000ms they write `at: 1000`.
      expect(() => assertSceneModule(captionScene({ at: '1000', text: 'hi' }))).not.toThrow();
    });

    it('reports the offending caption index and field on a multi-caption scene (codex review, cycle 1)', () => {
      // The validator must identify the caption index and the
      // failing field — not collapse to a generic "captions must be
      // an array of ..." message — so a scene author with twenty
      // captions can find the broken one.
      expect(() =>
        assertSceneModule(
          withField('captions', [
            { at: 0, text: 'good first' },
            { at: 'good-label', text: 'good middle' },
            { at: -5, text: 'bad third' },
          ]),
        ),
      ).toThrow(/captions\[2\]\.at/);
    });

    it('reports the offending caption index and field for a non-string text', () => {
      expect(() =>
        assertSceneModule(
          withField('captions', [
            { at: 0, text: 'good' },
            { at: 100, text: 42 },
          ]),
        ),
      ).toThrow(/captions\[1\]\.text/);
    });

    it('reports the offending caption index when the entry is not an object', () => {
      expect(() =>
        assertSceneModule(withField('captions', [{ at: 0, text: 'good' }, 'not-a-caption'])),
      ).toThrow(/captions\[1\]/);
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
        audio: ['assets/audio/stinger.mp3'],
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

  // PUL-F030 / ADR-029: a static audio-declaration field on the scene
  // schema. The loader/workbench unlock gate, the validation pass
  // (PUL-F028), and future authoring lints all read this one
  // predicate, so "this scene declares audio" never depends on file
  // extension sniffing, MIME guesses, or runtime observation of
  // `ctx.audio.load()`. Per the preflight, every entry must be in
  // `scene.assets` so the preloader (PUL-F005) warms it and the audio
  // service's allowlist accepts it (ADR-008 #5 — `scene.assets` is
  // the only asset inventory).
  describe('audio field (PUL-F030 / ADR-029)', () => {
    it('accepts an empty audio array (scene declares no audio)', () => {
      expect(() => assertSceneModule(withField('audio', []))).not.toThrow();
    });

    it('accepts audio entries that are members of scene.assets', () => {
      const scene = {
        ...validScene(),
        assets: ['assets/audio/stinger.mp3', 'assets/img/title.png'],
        audio: ['assets/audio/stinger.mp3'],
      };
      expect(() => assertSceneModule(scene)).not.toThrow();
    });

    it('rejects a non-array audio field', () => {
      expect(() => assertSceneModule(withField('audio', 'assets/audio/stinger.mp3'))).toThrow(
        /audio/,
      );
    });

    it('rejects non-string elements in audio', () => {
      expect(() => assertSceneModule(withField('audio', [42]))).toThrow(/audio/);
    });

    it('rejects an audio entry that is not in scene.assets', () => {
      const scene = {
        ...validScene(),
        assets: ['assets/audio/stinger.mp3'],
        audio: ['assets/audio/bed.mp3'],
      };
      expect(() => assertSceneModule(scene)).toThrow(/audio/);
      expect(() => assertSceneModule(scene)).toThrow(/scene\.assets/);
    });

    it('reports the offending audio entry by index', () => {
      const scene = {
        ...validScene(),
        assets: ['assets/audio/stinger.mp3'],
        audio: ['assets/audio/stinger.mp3', 'assets/audio/missing.mp3'],
      };
      expect(() => assertSceneModule(scene)).toThrow(/audio\[1\]/);
    });

    it('requires audio to be present', () => {
      expect(() => assertSceneModule(omitField('audio'))).toThrow(/\baudio\b/);
    });
  });

  describe('sceneDeclaresAudio predicate (PUL-F030 / ADR-029)', () => {
    it('returns false when audio is empty', () => {
      expect(sceneDeclaresAudio({ ...validScene(), audio: [] })).toBe(false);
    });

    it('returns true when audio has one entry', () => {
      const scene: SceneModule = {
        ...validScene(),
        assets: ['assets/audio/stinger.mp3'],
        audio: ['assets/audio/stinger.mp3'],
      };
      expect(sceneDeclaresAudio(scene)).toBe(true);
    });

    it('returns true when audio has multiple entries', () => {
      const scene: SceneModule = {
        ...validScene(),
        assets: ['assets/audio/stinger.mp3', 'assets/audio/bed.mp3'],
        audio: ['assets/audio/stinger.mp3', 'assets/audio/bed.mp3'],
      };
      expect(sceneDeclaresAudio(scene)).toBe(true);
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

describe('defineScene (authoring normalizer)', () => {
  it('requires only id, title, create, and timeline', () => {
    const scene = defineScene({
      id: 'minimal',
      title: 'Minimal',
      create: () => undefined,
      timeline: () => undefined,
    });
    expect(isSceneModule(scene)).toBe(true);
  });

  it('defaults every optional metadata field', () => {
    const scene = defineScene({
      id: 'minimal',
      title: 'Minimal',
      create: () => undefined,
      timeline: () => undefined,
    });
    expect(scene.duration).toBeNull();
    expect(scene.tags).toEqual([]);
    expect(scene.assets).toEqual([]);
    expect(scene.captions).toEqual([]);
    expect(scene.audio).toEqual([]);
    expect(scene.defaultNext).toBeNull();
    expect(scene.standalone).toBe(false);
    expect(scene.trailerSafe).toBe(false);
  });

  it('defaults cleanup to a callable no-op (mandatory cleanup, PUL-P001)', () => {
    const scene = defineScene({
      id: 'minimal',
      title: 'Minimal',
      create: () => undefined,
      timeline: () => undefined,
    });
    expect(typeof scene.cleanup).toBe('function');
    expect(() => scene.cleanup(undefined)).not.toThrow();
  });

  it('preserves supplied values over defaults', () => {
    const captions: Caption[] = [{ at: 0, text: 'hook' }];
    const scene = defineScene({
      id: 'rich',
      title: 'Rich',
      duration: 4200,
      tags: ['act-i'],
      assets: ['assets/a.mp3'],
      audio: ['assets/a.mp3'],
      captions,
      defaultNext: 'next-scene',
      standalone: true,
      trailerSafe: true,
      create: () => undefined,
      timeline: () => undefined,
    });
    expect(scene.duration).toBe(4200);
    expect(scene.tags).toEqual(['act-i']);
    expect(scene.audio).toEqual(['assets/a.mp3']);
    expect(scene.captions).toEqual(captions);
    expect(scene.defaultNext).toBe('next-scene');
    expect(scene.standalone).toBe(true);
    expect(scene.trailerSafe).toBe(true);
  });

  it('validates the normalized result and throws on a malformed field', () => {
    expect(() =>
      defineScene({
        id: 'Bad Id',
        title: 'Bad',
        create: () => undefined,
        timeline: () => undefined,
      }),
    ).toThrow(/scene "Bad Id" is invalid: id/);
  });

  it('enforces the audio-subset-of-assets cross-field invariant (PUL-F030)', () => {
    expect(() =>
      defineScene({
        id: 'audio-leak',
        title: 'Audio Leak',
        audio: ['assets/undeclared.mp3'],
        create: () => undefined,
        timeline: () => undefined,
      }),
    ).toThrow(/audio\[0\].*must be a member of scene\.assets/);
  });
});
