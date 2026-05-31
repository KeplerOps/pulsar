// Runtime validation pass — PUL-F028 (ADR-008 #7).
//
// An inspection tool over the same declarative inputs the runtime
// consumes at boot, detecting four classes of structural breakage:
//   (a) composition scene ids missing from the registry,
//   (b) unresolvable scene assets,
//   (c) duplicate scene ids,
//   (d) scenes without a `cleanup` function.
//
// A pure orchestrator (no side effects — never runs lifecycle hooks,
// fetches, or touches the DOM/history/storage). Public inputs are typed
// `unknown` so callers can pass possibly-malformed data; narrowing reuses
// the boot-path gates (`assertSceneModule` / `assertCompositionManifest`)
// and helpers (`createIdRegistry` dup detection, `findUnregisteredEntries`)
// so there are no parallel implementations. Collects every finding (never
// fails fast) and returns a frozen `readonly Finding[]` for callers to render.

import { type AssetUrlPolicy, DEFAULT_ALLOWED_SCHEMES, resolveAssetUrl } from './asset-preloader';
import { type AudioBedDeclaration, assertAudioBedDeclaration } from './audio';
import {
  CompositionManifestError,
  assertCompositionManifest,
  findUnregisteredEntries,
} from './composition';
import { describeError } from './error';
import { createIdRegistry } from './id-registry';
import { isKebabIdentifier } from './identifier';
import { assertSceneModule } from './scene';

/**
 * One row of the validation output. `code` is a stable category;
 * `message` mirrors the existing subsystem error grammar so authors
 * don't learn a second envelope. Structured fields carry only ids,
 * indexes, asset strings, and bounded text — never raw scene objects,
 * captions, headers, cookies, or auth values.
 */
export interface Finding {
  readonly code: FindingCode;
  readonly message: string;
  readonly sceneId?: string;
  readonly compositionId?: string;
  readonly entryIndex?: number;
  readonly asset?: string;
  /**
   * PUL-Q005 — position of the offending scene record in the input
   * iterable. The only stable locator when the id is missing/invalid (a
   * malformed id cannot be repaired by synthesizing an identity).
   */
  readonly sceneIndex?: number;
}

/** Stable codes for the four PUL-F028 clauses + the clause-(a) manifest-shape pre-condition. */
export type FindingCode =
  // Clause (d) — the full PUL-F001 scene-schema envelope (covers missing cleanup).
  | 'scene-schema-invalid'
  // Clause (c) — duplicate scene ids (id-registry grammar).
  | 'duplicate-scene-id'
  // Clause (a) pre-condition — malformed manifest; reference check is skipped.
  | 'composition-manifest-invalid'
  // Clause (a) — composition scene id not in the registry (one per miss).
  | 'unknown-scene-reference'
  // Clause (b) — scene asset not resolvable via `resolveAssetUrl`.
  | 'asset-unresolvable'
  // PUL-F014 — malformed composition `audioBed` (via `assertAudioBedDeclaration`).
  | 'composition-audio-bed-invalid'
  // PUL-F014 / ADR-012 — composition audio bed source fails the asset URL policy.
  | 'composition-audio-bed-unresolvable';

/**
 * One composition registration as the validator sees it: `(id, manifest)`
 * matching `createCompositionRegistry`. `manifest` / `audioBed` are typed
 * `unknown` so callers feed raw boot declarations; the validator narrows
 * internally (no caller-side cast on the unsafe path).
 */
export interface ValidationCompositionInput {
  readonly id: string;
  readonly manifest: unknown;
  /** Optional composition audio bed (PUL-F014); `unknown` like `manifest`. */
  readonly audioBed?: unknown;
}

/**
 * Input bundle for {@link validateRuntime}. `scenes` is `Iterable<unknown>`
 * (the pass inspects possibly-malformed data); `compositions` is optional
 * (clauses a / manifest-shape become no-ops when omitted); `assets`
 * defaults to the preloader's (no `baseUrl`, {@link DEFAULT_ALLOWED_SCHEMES}).
 */
export interface ValidationInput {
  readonly scenes: Iterable<unknown>;
  readonly compositions?: Iterable<ValidationCompositionInput>;
  readonly assets?: AssetUrlPolicy;
}

/** Per-record metadata from phase 1 for phases 2/4; fields `null` when not locally valid. */
interface Inspected {
  readonly id: string | null;
  readonly assets: readonly string[] | null;
  /** PUL-Q005 — iteration index, the locator when the scene id is unusable. */
  readonly sceneIndex: number;
}

/**
 * Run the structural validation pass: a frozen, deterministically-ordered
 * `readonly Finding[]` (scene-schema → duplicate-id → composition →
 * asset, each in input order), empty when every PUL-F028 clause holds.
 * Never throws under any input shape.
 */
export function validateRuntime(input: ValidationInput): readonly Finding[] {
  const findings: Finding[] = [];
  const inspected = runSceneShapePhase(input.scenes, findings);
  const validIds = runDuplicateIdPhase(inspected, findings);
  runCompositionPhase(input.compositions, validIds, input.assets, findings);
  runAssetPhase(inspected, input.assets, findings);
  return Object.freeze(findings);
}

/**
 * Phase 1 — per-record inspection (clause d). The four clauses are
 * INDEPENDENT: a schema-failing scene may still carry a locally-valid id
 * or assets whose duplicate / bad URL are their own findings. So we walk
 * each record once — run `assertSceneModule` for the schema finding AND
 * extract the minimal fields phases 2/4 need (reusing `isKebabIdentifier`
 * and the same `string[]` predicate), never gating one clause on another.
 */
function runSceneShapePhase(scenes: Iterable<unknown>, findings: Finding[]): readonly Inspected[] {
  const inspected: Inspected[] = [];
  let sceneIndex = 0;
  for (const scene of scenes) {
    const shapeFinding = checkSceneShape(scene, sceneIndex);
    if (shapeFinding !== null) findings.push(shapeFinding);
    inspected.push(inspectScene(scene, sceneIndex));
    sceneIndex += 1;
  }
  return inspected;
}

/**
 * Phase 2 — duplicate scene ids (clause c). Reuses the boot-path
 * `createIdRegistry` with its `onDuplicate` collector (accumulate, not
 * throw) so uniqueness semantics + error grammar are shared; first
 * occurrence stays canonical. Returns the unique-id set for phase 3.
 */
function runDuplicateIdPhase(
  inspected: readonly Inspected[],
  findings: Finding[],
): ReadonlySet<string> {
  // PUL-Q005: each entry's `value` is its `sceneIndex`, round-tripped via
  // `onDuplicate` so a finding identifies the duplicate occurrence (not the
  // canonical first) while keeping the registry's canonical message grammar.
  const sceneIdRegistry = createIdRegistry<number>(idEntries(inspected), {
    label: 'scene registry',
    subject: 'scene',
    // Phase 1 already ran `isKebabIdentifier`; the registry's check is redundant.
    validateId: () => undefined,
    onDuplicate: (entry) => {
      // Append ` (scenes[<index>])` so two duplicate findings for one id
      // stay textually distinct in the AggregateError consumer.
      findings.push({
        code: 'duplicate-scene-id',
        message: `scene registry: duplicate id "${entry.id}" (scenes[${entry.value}])`,
        sceneId: entry.id,
        sceneIndex: entry.value,
      });
    },
  });
  return new Set<string>(sceneIdRegistry.ids());
}

/**
 * Yield `{id, value: <sceneIndex>}` for every record with a kebab id, so
 * the `onDuplicate` hook can record the offending `sceneIndex` (PUL-Q005).
 */
function* idEntries(inspected: readonly Inspected[]): Iterable<{ id: string; value: number }> {
  for (const item of inspected) {
    if (item.id === null) continue;
    yield { id: item.id, value: item.sceneIndex };
  }
}

/**
 * Phase 3 — composition references (clause a + manifest shape). A bad
 * manifest emits one `composition-manifest-invalid` and skips the
 * reference check (walking a bad shape would mislead); otherwise
 * `findUnregisteredEntries` (the resolver's helper) aggregates the misses.
 */
function runCompositionPhase(
  compositions: Iterable<ValidationCompositionInput> | undefined,
  validIds: ReadonlySet<string>,
  policy: AssetUrlPolicy | undefined,
  findings: Finding[],
): void {
  if (compositions === undefined) return;
  for (const composition of compositions) {
    // PUL-F014 audio-bed shape check is independent of the manifest shape
    // — neither failure suppresses the other.
    appendCompositionAudioBedFindings(composition, policy, findings);
    const manifestFinding = checkCompositionShape(composition);
    if (manifestFinding !== null) {
      findings.push(manifestFinding);
      continue;
    }
    appendCompositionReferenceFindings(composition, validIds, findings);
  }
}

/**
 * PUL-F014 — when a composition declares an `audioBed`, validate its
 * shape through `assertAudioBedDeclaration` (the same gate the
 * composition registry and audio service use), then validate every
 * bed source through the same asset URL policy scene assets use.
 */
function appendCompositionAudioBedFindings(
  composition: ValidationCompositionInput,
  policy: AssetUrlPolicy | undefined,
  findings: Finding[],
): void {
  if (composition.audioBed === undefined) return;
  const bed = composition.audioBed;
  try {
    assertAudioBedDeclaration(bed);
  } catch (cause) {
    findings.push({
      code: 'composition-audio-bed-invalid',
      message: `composition "${composition.id}": ${describeError(cause)}`,
      compositionId: composition.id,
    });
    return;
  }
  const baseUrl = policy?.baseUrl;
  const allowedSchemes = policy?.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
  for (const source of audioBedSources(bed)) {
    const finding = checkCompositionAudioBedSource(composition.id, source, baseUrl, allowedSchemes);
    if (finding !== null) findings.push(finding);
  }
}

const audioBedSources = (bed: AudioBedDeclaration): readonly string[] =>
  typeof bed.src === 'string' ? [bed.src] : bed.src;

function checkCompositionAudioBedSource(
  compositionId: string,
  source: string,
  baseUrl: string | undefined,
  allowedSchemes: readonly string[],
): Finding | null {
  try {
    resolveAssetUrl(source, baseUrl, allowedSchemes);
    return null;
  } catch (cause) {
    return {
      code: 'composition-audio-bed-unresolvable',
      message: `composition "${compositionId}": audio bed source "${source}" is invalid: ${describeError(
        cause,
      )}`,
      compositionId,
      asset: source,
    };
  }
}

/**
 * After the composition's manifest has cleared shape validation, walk
 * its entries through `findUnregisteredEntries` and emit one
 * `unknown-scene-reference` finding per missing reference (clause a).
 */
function appendCompositionReferenceFindings(
  composition: ValidationCompositionInput,
  validIds: ReadonlySet<string>,
  findings: Finding[],
): void {
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

/**
 * Phase 4 — asset resolvability (clause b). Iterates EVERY record with a
 * locally-valid `assets` array (independent of schema status, and
 * including duplicate-id occurrences) through `resolveAssetUrl` — the
 * canonical gate the preloader and audio service share.
 */
function runAssetPhase(
  inspected: readonly Inspected[],
  policy: ValidationInput['assets'],
  findings: Finding[],
): void {
  const baseUrl = policy?.baseUrl;
  const allowedSchemes = policy?.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
  for (const item of inspected) {
    if (item.assets === null) continue;
    for (const asset of item.assets) {
      const finding = checkAssetResolvable(item, asset, baseUrl, allowedSchemes);
      if (finding !== null) findings.push(finding);
    }
  }
}

/**
 * Resolve one asset URL, returning an `asset-unresolvable` finding or
 * `null`. The message prepends the scene id (or `scenes[<index>]` when the
 * id is unusable) so two scenes sharing one asset URL stay distinguishable.
 */
function checkAssetResolvable(
  item: Inspected,
  asset: string,
  baseUrl: string | undefined,
  allowedSchemes: readonly string[],
): Finding | null {
  try {
    resolveAssetUrl(asset, baseUrl, allowedSchemes);
    return null;
  } catch (cause) {
    const detail = describeError(cause);
    const id = item.id;
    // PUL-Q005: carry `sceneIndex` + a locating prefix — canonical
    // `scene "<id>":` when usable, else `scenes[<index>]:`.
    if (id === null) {
      return {
        code: 'asset-unresolvable',
        message: `scenes[${item.sceneIndex}]: ${detail}`,
        asset,
        sceneIndex: item.sceneIndex,
      };
    }
    return {
      code: 'asset-unresolvable',
      message: `scene "${id}": ${detail}`,
      sceneId: id,
      asset,
      sceneIndex: item.sceneIndex,
    };
  }
}

/**
 * Extract the minimal locally-valid fields phases 2/4 need, independent
 * of the full schema gate: `id` only when `isKebabIdentifier` accepts it,
 * `assets` only when it is a string array (the same predicates the schema
 * uses). `null` otherwise, so each valid field still yields its findings.
 */
function inspectScene(scene: unknown, sceneIndex: number): Inspected {
  if (scene === null || typeof scene !== 'object') return { id: null, assets: null, sceneIndex };
  const rec = scene as Record<string, unknown>;
  const id = isKebabIdentifier(rec.id) ? rec.id : null;
  const rawAssets = rec.assets;
  const assets =
    Array.isArray(rawAssets) && rawAssets.every((a) => typeof a === 'string')
      ? (rawAssets as readonly string[])
      : null;
  return { id, assets, sceneIndex };
}

/**
 * Throw an {@link AggregateError} (one `Error` per finding) when the list
 * is non-empty — a fail-loud convenience over {@link validateRuntime}. The
 * wrapping message marks it a PUL-F028 failure for origin matching.
 */
export function assertNoValidationFindings(findings: readonly Finding[]): void {
  if (findings.length === 0) return;
  throw new AggregateError(
    findings.map((finding) => new Error(finding.message)),
    `runtime validation failed: ${findings.length} finding(s)`,
  );
}

/**
 * Run {@link assertSceneModule} against `scene`, returning the
 * `scene-schema-invalid` finding (message preserved verbatim) or `null`.
 * `sceneId` is attached only when the record carries a string `id`.
 */
function checkSceneShape(scene: unknown, sceneIndex: number): Finding | null {
  try {
    assertSceneModule(scene);
    return null;
  } catch (cause) {
    const rawMessage = describeError(cause);
    // PUL-Q005: rewrite the schema gate's `scene ?` "no usable id"
    // placeholder to `scenes[<index>]` (a deterministic replacement, not
    // arbitrary message parsing); `sceneIndex` is always populated.
    const usableSceneId = readUsableSceneId(scene);
    if (usableSceneId === null) {
      return {
        code: 'scene-schema-invalid',
        message: rawMessage.replace(/^scene \?/, `scenes[${sceneIndex}]`),
        sceneIndex,
      };
    }
    return {
      code: 'scene-schema-invalid',
      message: rawMessage,
      sceneId: usableSceneId,
      sceneIndex,
    };
  }
}

/**
 * Read a scene record's `id` when it is a string — mirroring the schema
 * gate's `scene "<id>"` vs `scene ?` framing decision (a string-presence
 * check, NOT kebab validation, so `{ id: "Not-Kebab" }` keeps its id framing).
 */
function readUsableSceneId(scene: unknown): string | null {
  if (scene === null || typeof scene !== 'object') return null;
  const id = (scene as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

/**
 * Run {@link assertCompositionManifest} against the registration,
 * returning a `composition-manifest-invalid` finding (id prepended so
 * multiple registrations stay distinguishable) or `null`.
 */
function checkCompositionShape(composition: ValidationCompositionInput): Finding | null {
  try {
    assertCompositionManifest(composition.manifest);
    return null;
  } catch (cause) {
    // PUL-Q005: carry the offending entry index from `CompositionManifestError`
    // structurally (omitted on shape failures, never a fake index).
    const entryIndex = cause instanceof CompositionManifestError ? cause.entryIndex : undefined;
    const finding: Finding = {
      code: 'composition-manifest-invalid',
      message: `composition "${composition.id}": ${describeError(cause)}`,
      compositionId: composition.id,
    };
    return entryIndex === undefined ? finding : { ...finding, entryIndex };
  }
}
