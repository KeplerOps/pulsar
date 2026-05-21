// PUL-P002 — validation runs in CI on every pull request.
//
// `validateRuntime` (PUL-F028) already executes during workbench
// bootstrap (`src/main.ts`), but Vite's build step does not run the
// bootstrap — CI never sees those findings. This test is the CI gate:
// it runs the canonical PUL-F028 pass over the *same* scene and
// composition declarations the workbench is wired to, so any
// structural breakage introduced by a future scene or composition
// fails CI before merge.
//
// The single source of truth for the registered graph is
// `src/workbench-graph.ts` (the composition-root layer next to
// `main.ts`, NOT under `src/runtime/`); both this test and
// `src/main.ts` import from it. A scene that is added to the registry
// path without being added here would also be invisible to the
// bootstrap validation (codex preflight: "preserve the single-source
// property").
//
// The fault-injection stanzas cover EVERY clause of PUL-F028 — scene
// schema (d), duplicate scene id (c), unknown composition reference
// (a), unresolvable asset (b), and the composition-manifest-invalid
// pre-condition for (a) — so a regression that silently no-op'd any
// phase of `validateRuntime` would surface here. A negative case for
// only clause (d) would have stayed green if `runDuplicateIdPhase`,
// `runCompositionPhase`, or `runAssetPhase` were accidentally removed
// because the registered workbench graph happens to be clean on those
// three axes today.

import { describe, expect, it } from 'vitest';
import { validateRuntime } from '../../src/runtime/validation';
import { WORKBENCH_COMPOSITIONS, WORKBENCH_SCENES } from '../../src/workbench-graph';

describe('workbench graph validation (PUL-P002)', () => {
  it('reports zero findings against the registered scenes and compositions', () => {
    const findings = validateRuntime({
      scenes: WORKBENCH_SCENES,
      compositions: WORKBENCH_COMPOSITIONS,
    });
    // Empty array = clean graph. A non-empty array is a CI failure:
    // print every finding so the build log identifies the offender.
    if (findings.length > 0) {
      const detail = findings.map((f) => `[${f.code}] ${f.message}`).join('\n');
      throw new Error(`workbench graph validation failed:\n${detail}`);
    }
    expect(findings).toEqual([]);
  });

  // A well-formed scene used as the duplicate-id and asset fixtures'
  // canonical shape. Defined here, not imported from a shared helper,
  // so the test reads top-to-bottom and the fault each stanza injects
  // is the only field that differs from the canonical record.
  const wellFormedScene = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    id: 'fixture',
    title: 'Fixture',
    duration: 0,
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

  it('surfaces clause (d) — scene-schema-invalid — when a scene omits cleanup', () => {
    // The broken record omits `cleanup`, so `assertSceneModule`
    // rejects it. The validator's input is `Iterable<unknown>` so
    // we widen the composed array at this boundary rather than
    // casting the broken record into a SceneModule shape it does
    // not satisfy.
    const broken = wellFormedScene({ id: 'broken-cleanup-fixture' });
    // biome-ignore lint/performance/noDelete: structural delete used to drop the field cleanly
    delete broken.cleanup;
    const scenes: readonly unknown[] = [...WORKBENCH_SCENES, broken];
    const findings = validateRuntime({
      scenes,
      compositions: WORKBENCH_COMPOSITIONS,
    });
    expect(findings.map((f) => f.code)).toContain('scene-schema-invalid');
    // Filter on BOTH `code` and `sceneId` so a regression that
    // emitted a different code against the same fixture (e.g., a
    // future schema-extension landed `duplicate-scene-id` on a
    // collision in the same record) cannot grab the wrong row and
    // pass an unrelated message check.
    const offender = findings.find(
      (f) => f.code === 'scene-schema-invalid' && f.sceneId === 'broken-cleanup-fixture',
    );
    expect(offender).toBeDefined();
    expect(offender?.message).toMatch(/cleanup/);
  });

  it('surfaces clause (c) — duplicate-scene-id — when two scenes share an id', () => {
    // The clean graph has `placeholder` as its only scene. Appending
    // a second scene with the same id forces `runDuplicateIdPhase` to
    // emit a finding. A regression that no-op'd that phase would
    // leave this test green only if THIS test were also silent — the
    // toContain check guarantees the finding code is actually
    // present in the output. Asserting the message matches the
    // documented `scene registry: duplicate id "<id>"` grammar (from
    // `createIdRegistry`'s `onDuplicate` collector hook) catches a
    // regression that emitted the finding with an empty message, a
    // wrong quoted id, or a different label prefix — none of which
    // the structured `sceneId` field alone would surface.
    const duplicate = wellFormedScene({ id: 'placeholder', title: 'Duplicate placeholder' });
    const scenes: readonly unknown[] = [...WORKBENCH_SCENES, duplicate];
    const findings = validateRuntime({
      scenes,
      compositions: WORKBENCH_COMPOSITIONS,
    });
    expect(findings.map((f) => f.code)).toContain('duplicate-scene-id');
    const offender = findings.find((f) => f.code === 'duplicate-scene-id');
    expect(offender?.sceneId).toBe('placeholder');
    // PUL-Q005: the duplicate-id finding's message embeds the
    // duplicate occurrence's scene record position so the user-facing
    // AggregateError consumer can identify which declaration to edit
    // even when both occurrences share the same id. The id-registry's
    // canonical `<label>: duplicate id "<id>"` grammar remains the
    // prefix; the validator appends ` (scenes[<index>])`.
    expect(offender?.message).toMatch(
      /^scene registry: duplicate id "placeholder" \(scenes\[\d+\]\)$/,
    );
    expect(typeof offender?.sceneIndex).toBe('number');
  });

  it('surfaces clause (a) — unknown-scene-reference — when a composition names a missing scene', () => {
    // Appending a composition that references a scene id not in the
    // registry forces `runCompositionPhase` to emit a finding. The
    // canonical workbench composition (`default`) is preserved so
    // every other phase still has clean input.
    // `ValidationCompositionInput.manifest` is typed `unknown` at the
    // validator boundary; we widen at the test boundary rather than
    // casting the fixture into the strict `CompositionRegistryEntry`
    // shape, mirroring how the loader hands the validator the raw
    // workbench-bound declarations.
    const compositions: readonly { id: string; manifest: unknown }[] = [
      ...WORKBENCH_COMPOSITIONS,
      { id: 'broken-comp', manifest: ['not-a-registered-scene'] },
    ];
    const findings = validateRuntime({
      scenes: WORKBENCH_SCENES,
      compositions,
    });
    expect(findings.map((f) => f.code)).toContain('unknown-scene-reference');
    const offender = findings.find((f) => f.code === 'unknown-scene-reference');
    expect(offender?.compositionId).toBe('broken-comp');
    expect(offender?.sceneId).toBe('not-a-registered-scene');
    // Asserts the resolver-aligned message envelope so a regression
    // that emitted the finding without the composition id, entry
    // index, or referenced scene id would fail here.
    expect(offender?.message).toBe(
      'composition "broken-comp" entry [0] references unknown scene id "not-a-registered-scene"',
    );
    expect(offender?.entryIndex).toBe(0);
  });

  it('surfaces the composition-manifest-invalid pre-condition for clause (a)', () => {
    // A malformed manifest (a number instead of an array) is rejected
    // by `assertCompositionManifest` before the reference walk runs.
    // The reference check is then skipped on that composition so
    // misleading "missing scene" misses are not emitted. The
    // pre-condition emits its own finding code so the gate fails
    // loudly even when no scene reference would be checkable.
    const compositions: readonly { id: string; manifest: unknown }[] = [
      ...WORKBENCH_COMPOSITIONS,
      { id: 'malformed-comp', manifest: 42 },
    ];
    const findings = validateRuntime({
      scenes: WORKBENCH_SCENES,
      compositions,
    });
    expect(findings.map((f) => f.code)).toContain('composition-manifest-invalid');
    const offender = findings.find((f) => f.code === 'composition-manifest-invalid');
    expect(offender?.compositionId).toBe('malformed-comp');
    // Asserts the composition-id-prefixed message envelope from
    // `checkCompositionShape`. The `must be an array` substring comes
    // from `assertCompositionManifest`'s top-level shape check; a
    // regression that prefixed the wrong id or dropped the prefix
    // would fail here, distinguishing this finding from a sibling
    // composition's identical error.
    expect(offender?.message).toMatch(/^composition "malformed-comp": .*must be an array/);
  });

  it('surfaces clause (b) — asset-unresolvable — when a scene declares a bad asset URL', () => {
    // The asset uses the `file:` scheme which is not in
    // `DEFAULT_ALLOWED_SCHEMES`, so `resolveAssetUrl` (and therefore
    // `runAssetPhase`) rejects it. The fixture's id is kebab-valid so
    // the asset phase reaches it; the cleanup field is present so the
    // schema check passes for this record (we want the asset phase to
    // run, not be short-circuited).
    const broken = wellFormedScene({
      id: 'bad-asset-fixture',
      assets: ['file:///etc/passwd'],
    });
    const scenes: readonly unknown[] = [...WORKBENCH_SCENES, broken];
    const findings = validateRuntime({
      scenes,
      compositions: WORKBENCH_COMPOSITIONS,
    });
    expect(findings.map((f) => f.code)).toContain('asset-unresolvable');
    const offender = findings.find((f) => f.code === 'asset-unresolvable');
    expect(offender?.sceneId).toBe('bad-asset-fixture');
    expect(offender?.asset).toBe('file:///etc/passwd');
    // The message is prepended with the scene id by
    // `checkAssetResolvable` so two scenes pointing at the same bad
    // URL stay distinguishable; the suffix comes from the shared
    // `resolveAssetUrl` rejection grammar. Asserting the structured
    // prefix catches a regression that dropped the scene id from the
    // message.
    expect(offender?.message).toMatch(/^scene "bad-asset-fixture": /);
  });
});
