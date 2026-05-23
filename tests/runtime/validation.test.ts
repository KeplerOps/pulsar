// PUL-F028 — structural runtime validation pass.
//
// Each `describe` block corresponds to one clause of the requirement
// statement; the structural / aggregate / `assertNoValidationFindings`
// blocks at the end pin invariants that span the whole module.
//
// Tests use raw scene-module / composition fixtures so the validator is
// exercised against the same declarative inputs the runtime consumes at
// boot, NOT against an already-built registry. The pass is the agent /
// author inspection tool that runs *before* the throwing registry path.

import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_SCHEMES } from '../../src/runtime/asset-preloader';
import type { CompositionManifest } from '../../src/runtime/composition';
import type { SceneModule } from '../../src/runtime/scene';
import {
  type Finding,
  type ValidationInput,
  assertNoValidationFindings,
  validateRuntime,
} from '../../src/runtime/validation';

// The validator's public input is `Iterable<unknown>` so callers
// hand it possibly-malformed data WITHOUT casts. Test fixtures
// follow the same shape — well-formed scenes use `SceneModule`,
// intentionally-broken scenes are plain records, both flow into
// `validateRuntime` directly.

// Shared scene fixture mirrors the other runtime test files
// (asset-preloader.test.ts / registry.test.ts) so a future change to
// the scene contract surfaces in one place.
const buildScene = (overrides: Partial<SceneModule> = {}): SceneModule => ({
  id: 'scene-a',
  title: 'Scene A',
  duration: 1000,
  tags: [],
  assets: [],
  captions: [],
  audio: [],
  defaultNext: null,
  standalone: false,
  trailerSafe: false,
  create: () => undefined,
  timeline: () => undefined,
  cleanup: () => undefined,
  ...overrides,
});

const findingCodes = (findings: readonly Finding[]): readonly string[] =>
  findings.map((f) => f.code);

describe('validateRuntime (PUL-F028)', () => {
  describe('clause d — scenes that do not export a cleanup function', () => {
    it('reports scene-schema-invalid when cleanup is missing', () => {
      const broken: Record<string, unknown> = { ...buildScene({ id: 'no-cleanup' }) };
      // biome-ignore lint/performance/noDelete: structural delete used to mirror PUL-F001 test
      delete broken.cleanup;
      const findings = validateRuntime({
        scenes: [broken],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('scene-schema-invalid');
      expect(findings[0]?.sceneId).toBe('no-cleanup');
      expect(findings[0]?.message).toMatch(/cleanup/);
    });

    it('reports scene-schema-invalid when cleanup is not a function', () => {
      const broken: Record<string, unknown> = { ...buildScene({ id: 'bad-cleanup' }) };
      broken.cleanup = 'nope';
      const findings = validateRuntime({
        scenes: [broken],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('scene-schema-invalid');
      expect(findings[0]?.sceneId).toBe('bad-cleanup');
      expect(findings[0]?.message).toMatch(/cleanup .*function/);
    });

    it('does not surface a scene-schema finding for a valid scene', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'ok' })],
      });
      expect(findings).toEqual([]);
    });
  });

  describe('clause c — duplicate scene ids', () => {
    it('reports duplicate-scene-id for the second occurrence', () => {
      const findings = validateRuntime({
        scenes: [
          buildScene({ id: 'shared' }),
          buildScene({ id: 'shared', title: 'Different title' }),
        ],
      });
      expect(findingCodes(findings)).toEqual(['duplicate-scene-id']);
      expect(findings[0]?.sceneId).toBe('shared');
      expect(findings[0]?.message).toMatch(/duplicate id "shared"/);
    });

    it('reports each duplicate occurrence past the first', () => {
      const findings = validateRuntime({
        scenes: [
          buildScene({ id: 'shared' }),
          buildScene({ id: 'shared' }),
          buildScene({ id: 'shared' }),
        ],
      });
      const dupes = findings.filter((f) => f.code === 'duplicate-scene-id');
      expect(dupes).toHaveLength(2);
      for (const finding of dupes) {
        expect(finding.sceneId).toBe('shared');
      }
    });

    it('treats the first occurrence as canonical (no self-duplicate)', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'only-once' })],
      });
      expect(findings.some((f) => f.code === 'duplicate-scene-id')).toBe(false);
    });

    it('still reports duplicate-scene-id even when the duplicate scene is schema-invalid', () => {
      // The four clauses are independent classes of breakage. A
      // second occurrence with a valid `id` still counts as a
      // duplicate even if its broader scene shape (e.g. missing
      // `cleanup`) is invalid. Both findings surface so the author
      // sees the full picture (codex review cycle 2).
      const broken: Record<string, unknown> = { ...buildScene({ id: 'shared' }) };
      broken.cleanup = undefined;
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'shared' }), broken],
      });
      const codes = findingCodes(findings);
      expect(codes).toContain('scene-schema-invalid');
      expect(codes).toContain('duplicate-scene-id');
    });

    it('does not enter duplicate detection when the id itself is malformed', () => {
      // Independent field validity: a scene record with `id: 42`
      // fails BOTH `assertSceneModule` AND the `isKebabIdentifier`
      // gate — there is no kebab id to count, so duplicate detection
      // has no signal. Only the schema finding surfaces.
      const broken: Record<string, unknown> = { ...buildScene({ id: 'real' }) };
      broken.id = 42;
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' }), broken],
      });
      const codes = findingCodes(findings);
      expect(codes).toContain('scene-schema-invalid');
      expect(codes).not.toContain('duplicate-scene-id');
    });

    it('still validates the assets of a duplicate-id second occurrence', () => {
      // Reporting "this id is a duplicate" and "this asset is
      // unresolvable" are independent concerns. A shape-valid
      // duplicate's `.assets` array is still trustworthy metadata
      // and clause (b) covers it; the second occurrence may declare
      // a different (and broken) asset that the first does not.
      const findings = validateRuntime({
        scenes: [
          buildScene({ id: 'dup', assets: [] }),
          buildScene({ id: 'dup', assets: ['file:///etc/passwd'] }),
        ],
      });
      const codes = findingCodes(findings);
      expect(codes).toContain('duplicate-scene-id');
      expect(codes).toContain('asset-unresolvable');
      const assetFinding = findings.find((f) => f.code === 'asset-unresolvable');
      expect(assetFinding?.sceneId).toBe('dup');
      expect(assetFinding?.asset).toBe('file:///etc/passwd');
    });
  });

  describe('clause a — scene ids referenced in compositions but not registered', () => {
    it('reports unknown-scene-reference per missing entry', () => {
      const manifest: CompositionManifest = ['ghost'];
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [{ id: 'opener', manifest }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        code: 'unknown-scene-reference',
        compositionId: 'opener',
        entryIndex: 0,
        sceneId: 'ghost',
      });
      expect(findings[0]?.message).toMatch(/composition "opener".*entry \[0\].*"ghost"/);
    });

    it('reports every miss in declaration order — no fail-on-first', () => {
      const manifest: CompositionManifest = ['real', 'ghost-a', 'real', 'ghost-b'];
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [{ id: 'mixed', manifest }],
      });
      const misses = findings.filter((f) => f.code === 'unknown-scene-reference');
      expect(misses).toHaveLength(2);
      expect(misses[0]).toMatchObject({ entryIndex: 1, sceneId: 'ghost-a' });
      expect(misses[1]).toMatchObject({ entryIndex: 3, sceneId: 'ghost-b' });
    });

    it('reads object-form entries through entryId (range/behavior not dropped)', () => {
      // Object-form entries with `range` / `behavior` keys must still
      // resolve their scene-id reference through `entryId`. This
      // guards against re-flattening to bare strings (preflight anti-
      // pattern).
      const manifest: CompositionManifest = [{ id: 'ghost', range: ['intro', 'hook'] as const }];
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [{ id: 'trailer', manifest }],
      });
      const misses = findings.filter((f) => f.code === 'unknown-scene-reference');
      expect(misses).toHaveLength(1);
      expect(misses[0]).toMatchObject({
        entryIndex: 0,
        sceneId: 'ghost',
      });
    });

    it('reports composition-manifest-invalid for malformed manifest shape', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [{ id: 'broken', manifest: 'not an array' }],
      });
      expect(findingCodes(findings)).toEqual(['composition-manifest-invalid']);
      expect(findings[0]?.compositionId).toBe('broken');
      expect(findings[0]?.message).toMatch(/composition manifest is invalid/);
      // Self-contained location: composition id is prepended to the
      // message so the AggregateError + console.error path identifies
      // which registration to edit (codex review cycle 3).
      expect(findings[0]?.message).toMatch(/^composition "broken":/);
    });

    it('reports composition-manifest-invalid for bad entry shape and skips reference check', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [
          {
            id: 'broken',
            manifest: [{ id: 'real', extraneous: 1 }],
          },
        ],
      });
      // Exactly one finding: the manifest-shape diagnostic. The
      // validator does not pretend a malformed entry is a missing
      // reference (preflight: "Do not silently accept malformed
      // composition manifests and then report missing scenes from bad
      // shapes.").
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('composition-manifest-invalid');
      expect(findings[0]?.compositionId).toBe('broken');
    });

    it('produces no finding when every entry resolves', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'a' }), buildScene({ id: 'b' })],
        compositions: [{ id: 'opener', manifest: ['a', 'b', 'a'] }],
      });
      expect(findings).toEqual([]);
    });
  });

  describe('clause b — assets referenced in scene metadata but not resolvable', () => {
    it('accepts data: assets under the default scheme allowlist', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'has-data', assets: ['data:text/plain,hi'] })],
      });
      expect(findings).toEqual([]);
    });

    it('rejects file: assets under the default scheme allowlist', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'bad-scheme', assets: ['file:///etc/passwd'] })],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        code: 'asset-unresolvable',
        sceneId: 'bad-scheme',
        asset: 'file:///etc/passwd',
      });
      expect(findings[0]?.message).toMatch(/scheme "file:" not in allowed list/);
      // Self-contained location: scene id is prepended so the
      // AggregateError + console.error path identifies which scene
      // owns the bad asset when multiple scenes share asset URLs
      // (codex review cycle 3).
      expect(findings[0]?.message).toMatch(/^scene "bad-scheme":/);
    });

    it('rejects protocol-relative asset without baseUrl', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'proto-rel', assets: ['//cdn.example.com/asset.png'] })],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        code: 'asset-unresolvable',
        sceneId: 'proto-rel',
        asset: '//cdn.example.com/asset.png',
      });
      expect(findings[0]?.message).toMatch(/protocol-relative URL requires/);
    });

    it('passes relative path through unchanged when no baseUrl is supplied', () => {
      // resolveAssetUrl returns the asset string verbatim and does not
      // scheme-check it (the browser resolves against document.baseURI
      // at fetch time). PUL-F028 mirrors that exactly — no stricter
      // sub-rule for static validation.
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'rel', assets: ['./img.png', 'images/x.svg'] })],
      });
      expect(findings).toEqual([]);
    });

    it('resolves relative paths against baseUrl', () => {
      // No `allowedSchemes` override — the resolver normalizes
      // `./img.png` against `http://example.com/`, the resolved scheme
      // is `http:`, and the default allowlist accepts it.
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'rel-base', assets: ['./img.png'] })],
        assets: { baseUrl: 'http://example.com/' },
      });
      expect(findings).toEqual([]);
    });

    it('rejects http: when allowedSchemes is restricted to https:', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'http-only', assets: ['http://example.com/x.png'] })],
        assets: { allowedSchemes: ['https:'] },
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        code: 'asset-unresolvable',
        sceneId: 'http-only',
        asset: 'http://example.com/x.png',
      });
      expect(findings[0]?.message).toMatch(/not in allowed list/);
    });

    it('rejects a URL that cannot be parsed against the baseUrl', () => {
      // The URL constructor accepts most strings as path components, so
      // we force a real parse failure by passing a non-string-ish
      // baseUrl that the URL constructor will reject. Use a known
      // bad pair: an empty asset against an unparseable baseUrl.
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'bad-url', assets: ['http://[bad'] })],
        assets: { baseUrl: 'http://example.com/' },
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        code: 'asset-unresolvable',
        sceneId: 'bad-url',
        asset: 'http://[bad',
      });
      expect(findings[0]?.message).toMatch(/invalid URL relative to baseUrl/);
    });

    it('uses DEFAULT_ALLOWED_SCHEMES when no allowedSchemes override is given', () => {
      // Sanity check: the canonical default actually accepts http/https.
      // Pinning this stops a drift in DEFAULT_ALLOWED_SCHEMES from
      // turning validation into a silent net-new rejection.
      expect(DEFAULT_ALLOWED_SCHEMES).toContain('http:');
      expect(DEFAULT_ALLOWED_SCHEMES).toContain('https:');
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'http-default', assets: ['http://example.com/a.png'] })],
      });
      expect(findings).toEqual([]);
    });

    it('still runs asset checks against a schema-invalid scene when assets is a valid array', () => {
      // Schema-failure and asset-failure are independent findings.
      // A scene missing `cleanup` but carrying a valid string-array
      // `assets` field still has its assets checked — the author
      // needs to see BOTH findings to fix both classes of breakage
      // (codex review cycle 2).
      const broken: Record<string, unknown> = {
        ...buildScene({ id: 'bad-shape', assets: ['file:///etc/passwd'] }),
      };
      broken.cleanup = undefined;
      const findings = validateRuntime({ scenes: [broken] });
      const codes = findingCodes(findings);
      expect(codes).toContain('scene-schema-invalid');
      expect(codes).toContain('asset-unresolvable');
      const assetFinding = findings.find((f) => f.code === 'asset-unresolvable');
      expect(assetFinding?.sceneId).toBe('bad-shape');
      expect(assetFinding?.asset).toBe('file:///etc/passwd');
    });

    it('does not run asset checks when the assets field itself is not a string array', () => {
      // Independent field validity: if `assets` is not `string[]`,
      // there is nothing to validate at the asset boundary. Only
      // the schema finding surfaces (the schema gate catches the
      // bad shape).
      const broken: Record<string, unknown> = { ...buildScene({ id: 'no-array' }) };
      broken.assets = 'not an array';
      const findings = validateRuntime({ scenes: [broken] });
      const codes = findingCodes(findings);
      expect(codes).toEqual(['scene-schema-invalid']);
    });
  });

  describe('composite + structural invariants', () => {
    it('returns an empty (frozen) array for empty input', () => {
      const findings = validateRuntime({ scenes: [] });
      expect(findings).toEqual([]);
      expect(Object.isFrozen(findings)).toBe(true);
    });

    it('returns an empty (frozen) array for a valid graph', () => {
      const scenes: SceneModule[] = [
        buildScene({ id: 'a', assets: ['data:text/plain,hi'] }),
        buildScene({ id: 'b' }),
      ];
      const findings = validateRuntime({
        scenes,
        compositions: [{ id: 'full', manifest: ['a', 'b'] }],
      });
      expect(findings).toEqual([]);
      expect(Object.isFrozen(findings)).toBe(true);
    });

    it('aggregates findings across all four clauses in one pass', () => {
      const broken: Record<string, unknown> = { ...buildScene({ id: 'no-cleanup' }) };
      // biome-ignore lint/performance/noDelete: structural delete
      delete broken.cleanup;
      const scenes: unknown[] = [
        buildScene({ id: 'dup' }),
        buildScene({ id: 'dup' }),
        buildScene({ id: 'bad-asset', assets: ['file:///x'] }),
        broken,
      ];
      const findings = validateRuntime({
        scenes,
        compositions: [{ id: 'cmp', manifest: ['dup', 'ghost'] }],
      });
      const codes = findingCodes(findings);
      expect(codes).toContain('scene-schema-invalid');
      expect(codes).toContain('duplicate-scene-id');
      expect(codes).toContain('unknown-scene-reference');
      expect(codes).toContain('asset-unresolvable');
      // One scene-schema (no-cleanup), one duplicate (second `dup`),
      // one asset (bad-asset), one unknown-scene-reference (`ghost`).
      expect(findings).toHaveLength(4);
    });

    it('never throws on otherwise pathological input', () => {
      // Several malformed scenes, malformed manifest, and an unknown
      // composition entry. The validator must collect, not throw.
      const inputs: ValidationInput = {
        scenes: [null, undefined, 'not a scene'],
        compositions: [{ id: 'broken-manifest', manifest: 5 }],
      };
      expect(() => validateRuntime(inputs)).not.toThrow();
      const findings = validateRuntime(inputs);
      // 3 schema findings + 1 manifest finding = 4
      expect(findings).toHaveLength(4);
    });

    it('does not invoke scene lifecycle hooks during validation', () => {
      // Pure-static guarantee — the four clauses are answerable from
      // metadata alone. Wiring asserts the validator never calls
      // create / timeline / cleanup (the lifecycle ban from the
      // preflight).
      let called = 0;
      const spy: SceneModule = buildScene({
        id: 'no-side-effects',
        create: () => {
          called += 1;
          return undefined;
        },
        timeline: () => {
          called += 1;
          return undefined;
        },
        cleanup: () => {
          called += 1;
          return undefined;
        },
      });
      validateRuntime({ scenes: [spy] });
      expect(called).toBe(0);
    });
  });

  describe('compositions input is optional', () => {
    it('runs without a compositions block', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'a' })],
      });
      expect(findings).toEqual([]);
    });
  });
});

describe('assertNoValidationFindings (PUL-F028)', () => {
  it('does not throw when findings is empty', () => {
    expect(() => assertNoValidationFindings([])).not.toThrow();
  });

  it('throws an AggregateError carrying every finding message', () => {
    const findings = validateRuntime({
      scenes: [
        buildScene({ id: 'dup' }),
        buildScene({ id: 'dup' }),
        buildScene({ id: 'bad-asset', assets: ['file:///x'] }),
      ],
    });
    let thrown: unknown = null;
    try {
      assertNoValidationFindings(findings);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    const agg = thrown as AggregateError;
    expect(agg.errors).toHaveLength(findings.length);
    for (let i = 0; i < findings.length; i++) {
      expect(agg.errors[i]).toBeInstanceOf(Error);
      expect((agg.errors[i] as Error).message).toBe(findings[i]?.message);
    }
    // The wrapping message identifies this as a validation failure so
    // a caller pattern-matching on origin can tell it apart from a
    // composition-resolution AggregateError.
    expect(agg.message).toMatch(/runtime validation failed/i);
  });
});

// PUL-Q005 — Validation actionability. Each error reported by the
// validation pass SHALL identify the offending entity (scene id, asset
// path, composition id) and the failing condition in human-readable
// form. The clauses are already largely satisfied by the existing
// PUL-F028 envelopes (`assertSceneModule`, `assertCompositionManifest`,
// `resolveAssetUrl`, id-registry duplicate grammar). PUL-Q005 closes
// the three remaining gaps the preflight named:
//
//   1. Scene records with no usable id (the `scene ?` placeholder
//      case) — the diagnostic must carry record position
//      (`scenes[<index>]`) in both the structured `sceneIndex` field
//      AND the human-readable message.
//   2. Duplicate-scene-id findings must carry the duplicate
//      occurrence's `sceneIndex` so the author can find the right
//      edit site quickly.
//   3. Asset-unresolvable findings on scene records with no usable
//      id must carry the declaring scene's record position
//      (`scenes[<index>]:` prefix + `sceneIndex` field).
describe('validateRuntime (PUL-Q005 — actionability)', () => {
  describe('scene-schema findings carry scene record position when the scene id is unusable', () => {
    it('rewrites `scene ? is invalid: ...` to `scenes[<index>] is invalid: ...` when the input record is null', () => {
      const findings = validateRuntime({ scenes: [null] });
      expect(findings).toHaveLength(1);
      const finding = findings[0];
      expect(finding?.code).toBe('scene-schema-invalid');
      expect(finding?.sceneIndex).toBe(0);
      expect(finding?.sceneId).toBeUndefined();
      // Human-readable locator is in the message text, not just the
      // structured field. AggregateError.errors[i].message must on its
      // own identify the offending record.
      expect(finding?.message).toMatch(/^scenes\[0\] is invalid:/);
      expect(finding?.message).not.toMatch(/scene \?/);
    });

    it('rewrites `scene ? is invalid: ...` when the input record is a primitive', () => {
      const findings = validateRuntime({ scenes: ['not a scene'] });
      expect(findings).toHaveLength(1);
      const finding = findings[0];
      expect(finding?.code).toBe('scene-schema-invalid');
      expect(finding?.sceneIndex).toBe(0);
      expect(finding?.message).toMatch(/^scenes\[0\] is invalid:/);
    });

    it('rewrites `scene ? is invalid: ...` when the input record is undefined', () => {
      const findings = validateRuntime({ scenes: [undefined] });
      expect(findings).toHaveLength(1);
      const finding = findings[0];
      expect(finding?.code).toBe('scene-schema-invalid');
      expect(finding?.sceneIndex).toBe(0);
      expect(finding?.message).toMatch(/^scenes\[0\] is invalid:/);
    });

    it('rewrites the message when the scene record is an object whose id field is missing', () => {
      const broken: Record<string, unknown> = { ...buildScene({ id: 'real' }) };
      // biome-ignore lint/performance/noDelete: structural delete used to drop the id field
      delete broken.id;
      const findings = validateRuntime({ scenes: [broken] });
      expect(findings).toHaveLength(1);
      const finding = findings[0];
      expect(finding?.code).toBe('scene-schema-invalid');
      expect(finding?.sceneIndex).toBe(0);
      expect(finding?.sceneId).toBeUndefined();
      expect(finding?.message).toMatch(/^scenes\[0\] is invalid:/);
    });

    it('uses the correct record index when the bad record is not first in the iterable', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'a' }), buildScene({ id: 'b' }), null, buildScene({ id: 'c' })],
      });
      const schemaFindings = findings.filter((f) => f.code === 'scene-schema-invalid');
      expect(schemaFindings).toHaveLength(1);
      expect(schemaFindings[0]?.sceneIndex).toBe(2);
      expect(schemaFindings[0]?.message).toMatch(/^scenes\[2\] is invalid:/);
    });

    it('still uses the canonical `scene "<id>" is invalid:` envelope when the record has a usable id', () => {
      // Negative test: pin the regression. A valid-id schema failure
      // (e.g. missing `cleanup`) MUST keep the canonical
      // `scene "<id>"` framing so existing consumers do not break.
      const broken: Record<string, unknown> = { ...buildScene({ id: 'has-id' }) };
      // biome-ignore lint/performance/noDelete: structural delete
      delete broken.cleanup;
      const findings = validateRuntime({ scenes: [broken] });
      expect(findings).toHaveLength(1);
      const finding = findings[0];
      expect(finding?.code).toBe('scene-schema-invalid');
      expect(finding?.sceneId).toBe('has-id');
      // sceneIndex is still populated for completeness — but the
      // human-readable envelope is the canonical id-anchored one.
      expect(finding?.sceneIndex).toBe(0);
      expect(finding?.message).toMatch(/^scene "has-id" is invalid:/);
      expect(finding?.message).not.toMatch(/^scenes\[/);
    });
  });

  describe('duplicate-scene-id findings carry the occurrence position', () => {
    it('records the duplicate occurrence (not the canonical first) in sceneIndex', () => {
      const findings = validateRuntime({
        scenes: [
          buildScene({ id: 'shared' }),
          buildScene({ id: 'other' }),
          buildScene({ id: 'shared' }),
        ],
      });
      const dupes = findings.filter((f) => f.code === 'duplicate-scene-id');
      expect(dupes).toHaveLength(1);
      expect(dupes[0]?.sceneId).toBe('shared');
      // The duplicate occurrence's index, not the canonical first.
      expect(dupes[0]?.sceneIndex).toBe(2);
      // PUL-Q005 (codex review cycle 1): the id-registry's
      // `<label>: duplicate id "<id>"` grammar stays the prefix, and
      // the validator appends ` (scenes[<index>])` so the
      // AggregateError consumer can identify the offending occurrence
      // from `Error.message` alone.
      expect(dupes[0]?.message).toBe('scene registry: duplicate id "shared" (scenes[2])');
    });

    it('records each subsequent duplicate occurrence with its own sceneIndex', () => {
      const findings = validateRuntime({
        scenes: [
          buildScene({ id: 'shared' }),
          buildScene({ id: 'shared' }),
          buildScene({ id: 'shared' }),
        ],
      });
      const dupes = findings.filter((f) => f.code === 'duplicate-scene-id');
      expect(dupes).toHaveLength(2);
      expect(dupes[0]?.sceneIndex).toBe(1);
      expect(dupes[1]?.sceneIndex).toBe(2);
    });
  });

  describe('asset-unresolvable findings carry the declaring record position when the scene id is unusable', () => {
    it('prepends `scenes[<index>]:` when the asset-bearing record has no usable id', () => {
      // A scene record with no `id` still has assets that must be
      // validated. The finding's message must on its own identify
      // which record (by position) declared the bad URL.
      const broken: Record<string, unknown> = {
        ...buildScene({ id: 'placeholder', assets: ['file:///etc/passwd'] }),
      };
      // biome-ignore lint/performance/noDelete: structural delete to drop id
      delete broken.id;
      const findings = validateRuntime({ scenes: [broken] });
      const assetFindings = findings.filter((f) => f.code === 'asset-unresolvable');
      expect(assetFindings).toHaveLength(1);
      const finding = assetFindings[0];
      expect(finding?.asset).toBe('file:///etc/passwd');
      expect(finding?.sceneId).toBeUndefined();
      expect(finding?.sceneIndex).toBe(0);
      expect(finding?.message).toMatch(/^scenes\[0\]:/);
    });

    it('uses the correct record index when the asset-bearing record is not first', () => {
      const broken: Record<string, unknown> = {
        ...buildScene({ id: 'placeholder', assets: ['file:///x'] }),
      };
      // biome-ignore lint/performance/noDelete: structural delete to drop id
      delete broken.id;
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'a' }), buildScene({ id: 'b' }), broken],
      });
      const assetFindings = findings.filter((f) => f.code === 'asset-unresolvable');
      expect(assetFindings).toHaveLength(1);
      expect(assetFindings[0]?.sceneIndex).toBe(2);
      expect(assetFindings[0]?.message).toMatch(/^scenes\[2\]:/);
    });

    it('still uses the canonical `scene "<id>":` envelope when the record has a usable id', () => {
      // Negative test: pin the regression. A valid-id asset failure
      // MUST keep the canonical `scene "<id>"` framing.
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'has-id', assets: ['file:///x'] })],
      });
      const assetFindings = findings.filter((f) => f.code === 'asset-unresolvable');
      expect(assetFindings).toHaveLength(1);
      expect(assetFindings[0]?.sceneId).toBe('has-id');
      expect(assetFindings[0]?.sceneIndex).toBe(0);
      expect(assetFindings[0]?.message).toMatch(/^scene "has-id":/);
      expect(assetFindings[0]?.message).not.toMatch(/^scenes\[/);
    });
  });

  describe('composition-manifest-invalid carries the offending entryIndex (codex review cycle 1)', () => {
    it('populates entryIndex when a manifest entry fails schema validation', () => {
      // Preflight: "Carry context from the validation phase that
      // already has it." `assertCompositionManifest` throws a
      // `CompositionManifestError` whose `entryIndex` field carries
      // the offending entry index; the validator narrows on the
      // class and populates `Finding.entryIndex` programmatically.
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [{ id: 'broken', manifest: ['real', { id: 'real', extraneous: 1 }] }],
      });
      expect(findings).toHaveLength(1);
      const finding = findings[0];
      expect(finding?.code).toBe('composition-manifest-invalid');
      expect(finding?.compositionId).toBe('broken');
      // The offending entry is at index 1.
      expect(finding?.entryIndex).toBe(1);
    });

    it('populates entryIndex for a bad bare-string entry', () => {
      // A bare string that fails `isKebabIdentifier` raises through
      // `validateBareString`, which uses `failEntry(index, ...)`.
      // `entryIndex` must reach the finding.
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [{ id: 'broken', manifest: ['real', 'NotKebab'] }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('composition-manifest-invalid');
      expect(findings[0]?.entryIndex).toBe(1);
    });

    it('leaves entryIndex undefined when the manifest itself is not an array', () => {
      // `failManifest` throws without an entry index — there is no
      // offending entry to point at. The validator does NOT
      // synthesize a fake index; the field stays undefined and the
      // composition id is the locator.
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [{ id: 'broken', manifest: 'not an array' }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('composition-manifest-invalid');
      expect(findings[0]?.entryIndex).toBeUndefined();
    });
  });

  describe('every well-formed finding name is self-contained for AggregateError consumers', () => {
    // Preflight: "A reader seeing only one `Error.message` from
    // `AggregateError.errors` must still know which declaration to
    // edit and why it failed." Round-trip the every-clause-aggregate
    // fixture through `assertNoValidationFindings` and assert each
    // wrapped `Error.message` independently carries a usable locator
    // AND a condition phrase.
    it('each AggregateError.errors[i].message identifies an entity AND a failing condition', () => {
      const noIdScene: Record<string, unknown> = {
        ...buildScene({ id: 'placeholder', assets: ['file:///etc/passwd'] }),
      };
      // biome-ignore lint/performance/noDelete: structural delete
      delete noIdScene.id;
      const findings = validateRuntime({
        scenes: [
          buildScene({ id: 'dup' }),
          buildScene({ id: 'dup' }),
          buildScene({ id: 'with-id-bad-asset', assets: ['file:///etc/shadow'] }),
          noIdScene,
        ],
        compositions: [
          { id: 'opener', manifest: ['ghost'] },
          { id: 'broken', manifest: 'not an array' as unknown },
        ],
      });
      // Sanity: cover every clause.
      const codes = findings.map((f) => f.code);
      expect(codes).toContain('duplicate-scene-id');
      expect(codes).toContain('asset-unresolvable');
      expect(codes).toContain('unknown-scene-reference');
      expect(codes).toContain('composition-manifest-invalid');
      // Round-trip every message through the AggregateError contract.
      let thrown: unknown = null;
      try {
        assertNoValidationFindings(findings);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      const agg = thrown as AggregateError;
      // Every wrapped message must contain at least one of the
      // approved entity locator forms: `scene "<id>"`,
      // `scenes[<index>]`, `composition "<id>"`. Falls back to scene
      // record position so the no-id branch still satisfies the
      // contract.
      const entityLocator =
        /^(scene "[^"]+"|scenes\[\d+\]|composition "[^"]+"|scene registry: duplicate id "[^"]+")/;
      for (const err of agg.errors) {
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        expect(message).toMatch(entityLocator);
      }
    });
  });

  describe('PUL-F014 — composition audio bed shape', () => {
    it('reports composition-audio-bed-invalid for a bed missing its src', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [{ id: 'deck', manifest: ['real'], audioBed: { volume: 0.5 } }],
      });
      expect(findingCodes(findings)).toEqual(['composition-audio-bed-invalid']);
      expect(findings[0]?.compositionId).toBe('deck');
      // Self-contained location: composition id is prepended to the
      // message, parallel to the manifest-shape finding.
      expect(findings[0]?.message).toMatch(/^composition "deck":/);
      expect(findings[0]?.message).toMatch(/audio bed/);
    });

    it('reports composition-audio-bed-invalid for a non-object bed', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [{ id: 'deck', manifest: ['real'], audioBed: 'oops' }],
      });
      expect(findingCodes(findings)).toEqual(['composition-audio-bed-invalid']);
    });

    it('reports the bed finding independently of a malformed manifest', () => {
      // A bad bed must not suppress the manifest diagnostic, and a bad
      // manifest must not suppress the bed diagnostic.
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [{ id: 'deck', manifest: 'not an array', audioBed: { volume: 1 } }],
      });
      const codes = findingCodes(findings);
      expect(codes).toContain('composition-audio-bed-invalid');
      expect(codes).toContain('composition-manifest-invalid');
    });

    it('produces no finding for a well-formed audio bed', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [
          { id: 'deck', manifest: ['real'], audioBed: { src: '/audio/bed.webm', volume: 0.5 } },
        ],
      });
      expect(findings).toEqual([]);
    });

    it.each([
      ['http:', 'http://cdn.example.test/bed.webm'],
      ['data:', 'data:audio/webm;base64,AAAA'],
      ['blob:', 'blob:https://app.example.test/bed'],
      ['file:', 'file:///tmp/bed.webm'],
      ['ftp:', 'ftp://cdn.example.test/bed.webm'],
    ] as const)(
      'reports composition-audio-bed-unresolvable for a string src with disallowed %s policy',
      (_scheme, src) => {
        const findings = validateRuntime({
          scenes: [buildScene({ id: 'real' })],
          compositions: [{ id: 'deck', manifest: ['real'], audioBed: { src } }],
          assets: { baseUrl: 'https://app.example.test/', allowedSchemes: ['https:'] },
        });
        expect(findingCodes(findings)).toEqual(['composition-audio-bed-unresolvable']);
        expect(findings[0]).toMatchObject({
          compositionId: 'deck',
          asset: src,
        });
        expect(findings[0]?.message).toMatch(/^composition "deck": audio bed source/);
      },
    );

    it('reports only the disallowed member of an audioBed.src array', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [
          {
            id: 'deck',
            manifest: ['real'],
            audioBed: {
              src: ['https://cdn.example.test/bed.webm', 'http://cdn.example.test/bed.webm'],
            },
          },
        ],
        assets: { baseUrl: 'https://app.example.test/', allowedSchemes: ['https:'] },
      });
      expect(findingCodes(findings)).toEqual(['composition-audio-bed-unresolvable']);
      expect(findings[0]?.asset).toBe('http://cdn.example.test/bed.webm');
    });

    it('keeps the permissive default bed source policy when no production policy is supplied', () => {
      const findings = validateRuntime({
        scenes: [buildScene({ id: 'real' })],
        compositions: [
          {
            id: 'deck',
            manifest: ['real'],
            audioBed: { src: ['http://cdn.example.test/bed.webm', 'data:audio/webm;base64,AAAA'] },
          },
        ],
      });
      expect(findings).toEqual([]);
    });
  });
});
