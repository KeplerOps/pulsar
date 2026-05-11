// Runtime validation pass — PUL-F028.
//
// PUL-F028 mandates that the runtime SHALL provide a validation pass
// that detects four classes of structural breakage:
//
//   (a) scene ids referenced in compositions but not present in the
//       scene registry,
//   (b) assets referenced in scene metadata but not resolvable,
//   (c) duplicate scene ids,
//   (d) scenes that do not export a `cleanup` function.
//
// ADR-008 #7 commits the runtime to a validation pass with this
// exact scope. The pass is an inspection tool agents and authors run
// over the same declarative inputs the runtime consumes at boot — raw
// scene modules plus composition registrations. It collects every
// finding rather than failing fast, so an author sees the whole
// picture before reaching for the throwing registry / resolver / preloader
// paths that already exist downstream.
//
// This module is a pure orchestrator over existing contracts. It does
// not introduce a new scene schema, composition schema, registry, asset
// inventory, URL parser, exception hierarchy, logging framework, or
// config surface. The four clauses are answered by composing helpers
// the runtime already owns — see the design preflight at
// `docs/design/pul-f028-validation-preflight.md`.
//
// Boundary typing (codex review cycle 1, class finding):
// public inputs are typed as `unknown` so callers can pass the
// possibly-malformed data this API exists to inspect WITHOUT unsafe
// casts. Internal narrowing happens through `assertSceneModule` and
// `assertCompositionManifest` — the same gates the runtime uses at
// boot — so there is one source of truth for "this is a valid scene
// module / composition manifest".
//
// Helper reuse (codex review cycle 1, class finding):
// duplicate scene-id detection reuses `createIdRegistry`'s
// `onDuplicate` collector hook (same error grammar as the runtime
// boot path); composition reference walking reuses
// `findUnregisteredEntries` (same iteration order the resolver
// uses). The validator is not allowed to maintain parallel
// implementations of these behaviors.
//
// Side-effect ban (preflight):
//  - never calls `scene.create`, `scene.timeline`, `scene.cleanup`;
//  - never `fetch`es, stream-drains, or `import()`s anything;
//  - does not touch the DOM, history, browser storage, cookies, the
//    audio engine, the preloader, the timeline adapter, or the
//    navigation dispatch;
//  - does not read process argv or environment variables.
//
// Collection is separate from rendering: the pass returns a frozen
// `readonly Finding[]`; callers format for the workbench error sink,
// a CI summary, or a JSON report.

import { DEFAULT_ALLOWED_SCHEMES, resolveAssetUrl } from './asset-preloader';
import { assertCompositionManifest, findUnregisteredEntries } from './composition';
import { describeError } from './error';
import { createIdRegistry } from './id-registry';
import { isKebabIdentifier } from './identifier';
import { assertSceneModule } from './scene';

/**
 * One row of the validation pass output. Each finding maps to a single
 * problem in the runtime inputs. `code` is a stable identifier so
 * callers can branch on category; `message` mirrors the existing
 * subsystem error grammar (`assertSceneModule`, `assertCompositionManifest`,
 * id-registry duplicate-id, `resolveAssetUrl`) so an author who is
 * already used to those messages does not learn a second envelope.
 *
 * Structured fields (`sceneId`, `compositionId`, `entryIndex`, `asset`)
 * are populated where applicable so renderers can group and filter
 * without parsing the message.
 *
 * Per the preflight error-envelope rule, findings carry only ids,
 * indexes, asset strings, and bounded diagnostic text — never raw
 * scene objects, full captions, request headers, cookies, or auth
 * values.
 */
export interface Finding {
  readonly code: FindingCode;
  readonly message: string;
  readonly sceneId?: string;
  readonly compositionId?: string;
  readonly entryIndex?: number;
  readonly asset?: string;
}

/**
 * Stable codes for the four clauses of PUL-F028 plus the manifest-
 * shape pre-condition for clause (a). The names map 1:1 onto the
 * requirement statement so traceability stays direct.
 */
export type FindingCode =
  // Clause (d) — scenes that do not export a cleanup function. Also
  // covers the rest of the PUL-F001 scene-schema envelope so the
  // missing-cleanup case stays inside its existing grammar
  // (`scene "<id>" is invalid: cleanup ...`) instead of growing a
  // `CleanupError`.
  | 'scene-schema-invalid'
  // Clause (c) — duplicate scene ids. Mirrors the id-registry
  // duplicate-id rule (`scene registry: duplicate id "<id>"`).
  | 'duplicate-scene-id'
  // Pre-condition for clause (a) — a malformed composition manifest
  // cannot be walked for unknown references without producing
  // misleading misses. Emitted once per composition; the reference
  // check is skipped on that composition.
  | 'composition-manifest-invalid'
  // Clause (a) — scene ids referenced in compositions but not present
  // in the registry. One finding per missing reference; the resolver's
  // single-aggregate message stays untouched at the resolver boundary.
  | 'unknown-scene-reference'
  // Clause (b) — assets referenced in scene metadata but not
  // resolvable. Resolvability uses the same `resolveAssetUrl` rule
  // the preloader and audio service consume, so tightening the
  // allowlist tightens validation automatically.
  | 'asset-unresolvable';

/**
 * One composition registration as the validator sees it. Matches the
 * `(id, manifest)` shape that `createCompositionRegistry` accepts;
 * inputs may be sourced directly from the same module declarations
 * the workbench bundles at boot.
 *
 * `manifest` is typed as `unknown` at the boundary so callers can
 * hand the validator the same raw declarations the runtime gets at
 * boot, before `assertCompositionManifest` has been run. The
 * validator narrows internally — there is no caller-side cast on the
 * unsafe path.
 */
export interface ValidationCompositionInput {
  readonly id: string;
  readonly manifest: unknown;
}

/**
 * Input bundle for {@link validateRuntime}.
 *
 *  - `scenes` — every scene module the runtime intends to register.
 *    Typed as `Iterable<unknown>` because the whole point of the pass
 *    is to inspect possibly-malformed data; calling code should not
 *    have to cast to `SceneModule` to feed a value the validator is
 *    going to reject anyway.
 *  - `compositions` — optional list of composition registrations. When
 *    omitted, clauses (a) / manifest-shape are no-ops.
 *  - `assets` — optional asset-policy block mirroring the preloader's
 *    `baseUrl` / `allowedSchemes` options. Defaults match the
 *    preloader: no `baseUrl`, {@link DEFAULT_ALLOWED_SCHEMES}.
 */
export interface ValidationInput {
  readonly scenes: Iterable<unknown>;
  readonly compositions?: Iterable<ValidationCompositionInput>;
  readonly assets?: {
    readonly baseUrl?: string;
    readonly allowedSchemes?: readonly string[];
  };
}

/**
 * Run the structural validation pass over the supplied inputs.
 *
 * Returns a frozen array of findings — empty when the inputs satisfy
 * every clause of PUL-F028. The pass is pure: it does not throw under
 * any input shape, does not invoke scene lifecycle hooks, and does not
 * touch the network, filesystem, DOM, history, audio engine, timeline
 * adapter, or navigation dispatch.
 *
 * Order is deterministic: scene-schema findings precede duplicate-id
 * findings, which precede composition findings, which precede asset
 * findings. Within each category, findings appear in iteration order
 * of the underlying input.
 */
export function validateRuntime(input: ValidationInput): readonly Finding[] {
  const findings: Finding[] = [];

  // ── Phase 1: per-record inspection. ──────────────────────────────
  //
  // The four clauses of PUL-F028 are INDEPENDENT classes of breakage.
  // A scene that fails the full PUL-F001 schema gate (e.g. missing
  // `cleanup`) may still carry a locally-valid `id` or `assets` array
  // — and a duplicate of that id, or a bad asset URL it declares, are
  // their own findings the author needs to see. Gating phases 2–4 on
  // the full schema check would suppress those independent findings
  // (codex review cycle 2, class finding).
  //
  // So we walk every record once: run `assertSceneModule` to surface
  // the schema finding when applicable, AND independently extract the
  // minimal locally-valid fields needed by phases 2 / 4. The id check
  // reuses `isKebabIdentifier` — the shared identifier rule the scene
  // schema, registry, composition manifest, and URL parser already
  // share. The assets check is the same `Array<string>` predicate
  // `assertSceneModule` applies. No second schema, no parallel
  // contract — just minimal field extraction next to the canonical
  // gate.
  interface Inspected {
    readonly id: string | null;
    readonly assets: readonly string[] | null;
  }
  const inspected: Inspected[] = [];
  for (const scene of input.scenes) {
    const shapeFinding = checkSceneShape(scene);
    if (shapeFinding !== null) findings.push(shapeFinding);
    inspected.push(inspectScene(scene));
  }

  // ── Phase 2: duplicate scene ids (clause c). ─────────────────────
  //
  // Reuses the same `createIdRegistry` path that builds the scene
  // registry at runtime boot, with the new `onDuplicate` collector
  // hook that accumulates rather than throws. Single source of truth
  // for uniqueness semantics and the `<label>: duplicate id "<id>"`
  // error grammar. First occurrence remains canonical (the registry
  // does not register the duplicating entry — `ids()` mirrors what a
  // boot-time registry would have held). Iterates over every record
  // with a locally-valid id, regardless of full-schema status, so a
  // duplicate id on a cleanup-less scene still surfaces.
  const sceneIdRegistry = createIdRegistry<null>(
    (function* idEntries() {
      for (const item of inspected) {
        if (item.id !== null) yield { id: item.id, value: null };
      }
    })(),
    {
      label: 'scene registry',
      subject: 'scene',
      // `isKebabIdentifier` already accepted the id during phase 1
      // extraction; the id-registry's id-shape check would be
      // redundant here. Matches `createSceneRegistry`'s wiring.
      validateId: () => undefined,
      onDuplicate: (entry) => {
        findings.push({
          code: 'duplicate-scene-id',
          message: `scene registry: duplicate id "${entry.id}"`,
          sceneId: entry.id,
        });
      },
    },
  );
  const validIds = new Set<string>(sceneIdRegistry.ids());

  // ── Phase 3: composition references (clause a + manifest shape). ─
  //
  // A composition with a malformed manifest emits one
  // `composition-manifest-invalid` finding and is skipped for the
  // reference check — walking a bad shape would produce misleading
  // "missing scene" misses (preflight anti-pattern). `manifest` is
  // typed `unknown` on the input; `checkCompositionShape` narrows
  // through `assertCompositionManifest`.
  if (input.compositions !== undefined) {
    for (const composition of input.compositions) {
      const manifestFinding = checkCompositionShape(composition);
      if (manifestFinding !== null) {
        findings.push(manifestFinding);
        continue;
      }
      // After `assertCompositionManifest` has accepted the value,
      // `findUnregisteredEntries` walks every entry through `entryId`
      // and aggregates the misses in declaration order — the same
      // helper the resolver uses for its preflight pass (single
      // source of truth for the iteration shape).
      const validManifest = composition.manifest as Parameters<typeof findUnregisteredEntries>[0];
      const misses = findUnregisteredEntries(validManifest, (id) => validIds.has(id));
      for (const miss of misses) {
        findings.push({
          code: 'unknown-scene-reference',
          message: `composition "${composition.id}" entry [${miss.index}] references unknown scene id "${miss.id}"`,
          compositionId: composition.id,
          entryIndex: miss.index,
          sceneId: miss.id,
        });
      }
    }
  }

  // ── Phase 4: asset resolvability (clause b). ─────────────────────
  //
  // Iterates EVERY record with a locally-valid `assets` array,
  // regardless of full-schema status. A scene missing `cleanup` may
  // still declare an asset that fails resolution — reporting the
  // schema fault and the asset fault are independent concerns. Also
  // covers duplicate-id occurrences past the first: a duplicate
  // scene's `.assets` may differ from the canonical one, and clause
  // (b) covers "assets referenced in scene metadata".
  //
  // `resolveAssetUrl` is the canonical scheme + URL gate the preloader
  // and audio service already share. We reuse it verbatim — there is
  // ONE asset-policy rule for the runtime, parameterised by `baseUrl`
  // and `allowedSchemes`, defaulting to `DEFAULT_ALLOWED_SCHEMES`. A
  // future tightening of the preloader's allowlist flows here
  // automatically.
  const assetPolicy = input.assets;
  const baseUrl = assetPolicy?.baseUrl;
  const allowedSchemes = assetPolicy?.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
  for (const item of inspected) {
    if (item.assets === null) continue;
    for (const asset of item.assets) {
      try {
        resolveAssetUrl(asset, baseUrl, allowedSchemes);
      } catch (cause) {
        // Self-contained message: prepend the scene id when known so
        // the AggregateError thrown by `assertNoValidationFindings` and
        // the workbench's per-line `console.error` both identify which
        // declaration to edit. Multiple scenes pointing at the same
        // asset URL would otherwise produce indistinguishable lines
        // (codex review cycle 3).
        const detail = describeError(cause);
        const message = item.id !== null ? `scene "${item.id}": ${detail}` : detail;
        findings.push({
          code: 'asset-unresolvable',
          message,
          ...(item.id !== null ? { sceneId: item.id } : {}),
          asset,
        });
      }
    }
  }

  return Object.freeze(findings);
}

/**
 * Extract the minimum locally-valid fields phases 2 (duplicate-id)
 * and 4 (asset) need from a candidate scene, INDEPENDENT of whether
 * the full `assertSceneModule` gate passed for that record. Returns
 * `null` for absent / not-locally-valid fields so the caller can
 * still emit independent findings for each field that IS valid.
 *
 *  - `id` is populated only when `isKebabIdentifier` accepts the
 *    record's `id` field — the same predicate the scene schema,
 *    registry, composition manifest, and URL parser already share.
 *  - `assets` is populated only when the record's `assets` field is
 *    an array of strings — the same predicate `assertSceneModule`
 *    applies internally.
 *
 * No second scene schema, no parallel contract: just the minimal
 * field extraction the dependent phases need (codex review cycle 2).
 */
function inspectScene(scene: unknown): { id: string | null; assets: readonly string[] | null } {
  if (scene === null || typeof scene !== 'object') return { id: null, assets: null };
  const rec = scene as Record<string, unknown>;
  const id = isKebabIdentifier(rec.id) ? rec.id : null;
  const rawAssets = rec.assets;
  const assets =
    Array.isArray(rawAssets) && rawAssets.every((a) => typeof a === 'string')
      ? (rawAssets as readonly string[])
      : null;
  return { id, assets };
}

/**
 * Throw an {@link AggregateError} carrying one `Error` per finding
 * (in order) when the list is non-empty. The wrapping message
 * identifies the failure as a PUL-F028 validation failure so callers
 * pattern-matching on origin can tell it apart from the
 * composition-resolver's `composition resolution failed:` aggregate.
 *
 * Convenience for callers that want fail-loud semantics; the canonical
 * collection API is {@link validateRuntime}.
 */
export function assertNoValidationFindings(findings: readonly Finding[]): void {
  if (findings.length === 0) return;
  throw new AggregateError(
    findings.map((finding) => new Error(finding.message)),
    `runtime validation failed: ${findings.length} finding(s)`,
  );
}

/**
 * Run {@link assertSceneModule} against `scene` and return either the
 * finding for a shape failure or `null` when the scene is well-formed.
 * The thrown message is preserved verbatim (PUL-F001 envelope —
 * `scene "<id>" is invalid: <field> <condition>` or `scene ? is
 * invalid: value must be a non-null object`).
 *
 * `sceneId` is attached to the finding only when the candidate
 * carries a string `id` (regardless of whether the rest of the shape
 * validated): a scene that is `null`, a primitive, or missing `id`
 * does not surface a `sceneId`; the message still contains the
 * validator's `?` placeholder so the renderer can find the offending
 * position.
 */
function checkSceneShape(scene: unknown): Finding | null {
  try {
    assertSceneModule(scene);
    return null;
  } catch (cause) {
    const finding: Finding = {
      code: 'scene-schema-invalid',
      message: describeError(cause),
    };
    if (scene !== null && typeof scene === 'object') {
      const id = (scene as { id?: unknown }).id;
      if (typeof id === 'string') return { ...finding, sceneId: id };
    }
    return finding;
  }
}

/**
 * Run {@link assertCompositionManifest} against the registration and
 * return either the finding for a malformed manifest or `null` when
 * the shape is well-formed.
 *
 * The composition id is prepended to the message so the
 * AggregateError thrown by `assertNoValidationFindings` and the
 * workbench's per-line `console.error` both identify the offending
 * registration when multiple compositions are registered (codex
 * review cycle 3). The structured `compositionId` field remains for
 * callers that group / filter findings programmatically.
 */
function checkCompositionShape(composition: ValidationCompositionInput): Finding | null {
  try {
    assertCompositionManifest(composition.manifest);
    return null;
  } catch (cause) {
    return {
      code: 'composition-manifest-invalid',
      message: `composition "${composition.id}": ${describeError(cause)}`,
      compositionId: composition.id,
    };
  }
}
