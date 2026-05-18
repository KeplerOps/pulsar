import { readFileSync, statSync } from 'node:fs';
import { join, posix as pathPosix, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  REPO_ROOT,
  SRC_ROOT,
  type SourceFinding,
  collectLineExemptions,
  lineText,
  parseSource,
  walkTsFiles,
} from './source-policy';

// PUL-A010 — Live and export share scene metadata.
//
// Statement: "Any export pipeline SHALL consume the same scene
// metadata and composition manifests as the live runtime.
// Export-specific metadata SHALL NOT replace live-runtime metadata."
//
// Clause C1 (export shares the canonical scene + composition shape)
// is structurally satisfied today by ADR-006 (Remotion as a parallel
// path consuming the same metadata), PUL-A004's runtime-core import
// ban on Remotion (already enforced by
// `tests/runtime/policy-a004-export-pipeline.test.ts`), and the
// single declaration sites for `SceneModule` (in
// `src/runtime/scene.ts`), `CompositionManifest`, `CompositionEntry`,
// and `CompositionEntryOverride` (in `src/runtime/composition.ts`).
//
// Clause C2 (export-specific metadata SHALL NOT replace live-runtime
// metadata) is the negation form. Without a structural gate a future
// PR can silently land a parallel scene/composition shape or an
// export-only authoring field on the canonical surfaces. This gate
// adds the defense in depth so a regression fails at CI rather than
// only at code review.
//
// Three sub-rules, modeled on the existing PUL-A001..A006 / A008 /
// A009 source-scan family and sharing the helpers in
// `source-policy.ts`:
//
//   1. **Forbidden export-side authoring fields on the scene-module
//      and composition-entry INTERFACES.** AST-walk the canonical
//      scene and composition modules; flag any `PropertySignature` or
//      `MethodSignature` member whose name is in
//      {exportMetadata, remotionMetadata, renderManifest,
//      exportCaptions, exportAssets, exportAudio, videoDuration}.
//      Property-name extraction covers identifier, string-literal,
//      and computed-string-literal forms (`['exportMetadata']`) so a
//      computed-key bypass cannot escape.
//
//   2. **Forbidden parallel scene/composition schema declarations
//      anywhere in `src/`.** Flag `interface`, `type`, `const`,
//      `let`, `var`, `class`, `function`, `enum`, destructured-
//      binding, for-loop-header, and `import` declarations whose
//      name is in {ExportScene, RenderScene, SceneDTO,
//      ExportComposition, RenderManifest, ExportSceneSchema,
//      ExportCompositionSchema, ExportSceneDTO, ExportCompositionDTO,
//      ExportSceneInput, ExportCompositionInput,
//      ExportCompositionManifest, SceneModule, CompositionManifest,
//      CompositionEntry, CompositionEntryOverride}. The canonical
//      names (`SceneModule`, `CompositionManifest`,
//      `CompositionEntry`, `CompositionEntryOverride`) carry
//      path-AND-kind exemptions for their canonical declarations
//      (`interface SceneModule` at `src/runtime/scene.ts`; `type
//      CompositionManifest`, `type CompositionEntry`, and `interface
//      CompositionEntryOverride` at `src/runtime/composition.ts`).
//      Consumer-side imports of a canonical name whose specifier
//      path-resolves to the canonical declaration site are exempt;
//      imports from any other path are flagged.
//
//   3. **Forbidden export-side authoring fields on scene-module and
//      composition-entry OBJECT LITERALS** under `src/scenes/**/*.ts`
//      and `src/compositions/**/*.ts`. `assertSceneModule()` accepts
//      unknown keys at the value level (the preflight rules out a
//      runtime implementation change), so a scene module can carry a
//      forbidden export-shaped sibling field today and pass the
//      schema gate AND rule 1. Rule 3 AST-walks every object literal
//      annotated, asserted, or `satisfies`-bound as `SceneModule` or
//      `CompositionEntryOverride` (with file-local alias resolution),
//      plus every literal inside a `CompositionManifest` array
//      binding, plus literals returned from a function whose return
//      type resolves to a scene-shaped name. Flag any property
//      assignment, shorthand assignment, or method declaration whose
//      key resolves to a name in the forbidden set rule 1 uses.
//      Spreads (`{ ...extra }`) and opaque computed keys (`{ [key]:
//      ... }` where `key` is not a static literal) inside a scene-
//      shaped literal are structurally banned because their forbidden-
//      key content cannot be statically classified — same shape as
//      PUL-A009 rule 4.
//
// Each rule supports a line-scoped `// PUL-A010-allow: <reason>`
// exemption via the shared `collectLineExemptions` helper. Empty /
// whitespace-only rationales are rejected; markers hidden inside
// string literals are rejected; the marker applies only to its own
// line.

const ALLOW_TAG = 'PUL-A010-allow';

/**
 * Resolve a static string name for a `PropertyName` — covering identifier
 * forms (`exportMetadata`), string-literal forms (`'exportMetadata'`),
 * and computed forms whose inner expression resolves to a static string
 * (`['exportMetadata']`, `` [`exportMetadata`] ``). Returns `undefined`
 * for any dynamic, computed-non-literal, or numeric form. Shared across
 * rule 1 (interface members) and rule 3 (object-literal properties) so a
 * regression that hides a forbidden key behind `['exportMetadata']`
 * cannot escape either gate.
 */
function getStaticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteralLike(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression;
    if (ts.isStringLiteralLike(expr)) return expr.text;
  }
  return undefined;
}

// --- Rule 1: forbidden export fields on SceneModule / CompositionEntryOverride ---

const FORBIDDEN_SCENE_FIELDS: ReadonlySet<string> = new Set([
  'exportMetadata',
  'remotionMetadata',
  'renderManifest',
  'exportCaptions',
  'exportAssets',
  'exportAudio',
  'videoDuration',
]);

const SCENE_LIKE_INTERFACES: ReadonlySet<string> = new Set([
  'SceneModule',
  'CompositionEntryOverride',
]);

function scanForbiddenSceneFields(sourceFile: ts.SourceFile): readonly SourceFinding[] {
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const findings: SourceFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && SCENE_LIKE_INTERFACES.has(node.name.text)) {
      for (const member of node.members) {
        // Index signatures (`[key: string]: unknown`) on the
        // canonical scene interfaces admit unbounded fields and so
        // open an unbounded export-metadata authoring slot that the
        // scanner cannot statically classify. Same opacity concern
        // as opaque computed keys; structurally banned. Codex review
        // cycle 2 class finding (index-signature bypass).
        if (ts.isIndexSignatureDeclaration(member)) {
          const idxStart = member.getStart(sourceFile);
          const { line: idxLine } = sourceFile.getLineAndCharacterOfPosition(idxStart);
          if (exempted.has(idxLine)) continue;
          findings.push({
            file: sourceFile.fileName,
            line: idxLine + 1,
            text: lineText(sourceFile, idxLine).trim(),
            label: `index signature on ${node.name.text} interface — export-metadata vector cannot be statically classified`,
          });
          continue;
        }
        // Both PropertySignature (`exportMetadata: ...`) and
        // MethodSignature (`exportMetadata(): ...`) members are
        // parallel-authoring surfaces because `SceneModule` accepts
        // unknown keys at the value level. Both forms are in scope.
        if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
        const start = member.getStart(sourceFile);
        const { line } = sourceFile.getLineAndCharacterOfPosition(start);
        // Opaque computed keys on the canonical interface — same
        // opacity rule that bans opaque computed keys in scene-shaped
        // object literals (rule 3). A `const FIELD = 'exportMetadata'
        // as const; interface SceneModule { [FIELD]: unknown }` would
        // install the forbidden member while the computed expression
        // is an identifier reference (NOT a static string literal),
        // so `getStaticPropertyName` would return undefined and the
        // member would silently skip the rule. Codex review cycle 1
        // class finding (computed-key bypass on the interface). The
        // structural ban gives rule 1 the same defense in depth rule
        // 3 already had.
        if (ts.isComputedPropertyName(member.name)) {
          const expr = member.name.expression;
          if (!ts.isStringLiteralLike(expr)) {
            if (exempted.has(line)) continue;
            findings.push({
              file: sourceFile.fileName,
              line: line + 1,
              text: lineText(sourceFile, line).trim(),
              label: `opaque computed key on ${node.name.text} interface — export-metadata vector cannot be statically classified`,
            });
            continue;
          }
        }
        const propName = getStaticPropertyName(member.name);
        if (propName === undefined) continue;
        if (!FORBIDDEN_SCENE_FIELDS.has(propName)) continue;
        if (exempted.has(line)) continue;
        const memberKind = ts.isMethodSignature(member) ? 'method' : 'field';
        findings.push({
          file: sourceFile.fileName,
          line: line + 1,
          text: lineText(sourceFile, line).trim(),
          label: `parallel export-metadata ${memberKind} "${propName}" on ${node.name.text}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// --- Rule 2: forbidden parallel scene/composition schema declarations ---

const FORBIDDEN_SCHEMA_NAMES: ReadonlySet<string> = new Set([
  'ExportScene',
  'RenderScene',
  'SceneDTO',
  'ExportComposition',
  'RenderManifest',
  'ExportSceneSchema',
  'ExportCompositionSchema',
  'ExportSceneDTO',
  'ExportCompositionDTO',
  'ExportSceneInput',
  'ExportCompositionInput',
  'ExportCompositionManifest',
  // Canonical names — path-AND-kind sensitive. A parallel declaration
  // of any of these outside the canonical site is the same hazard as
  // declaring a new `ExportScene`.
  'SceneModule',
  'CompositionManifest',
  'CompositionEntry',
  'CompositionEntryOverride',
]);

type DeclarationKind =
  | 'interface'
  | 'type'
  | 'const'
  | 'let'
  | 'var'
  | 'class'
  | 'function'
  | 'enum'
  | 'destructured'
  | 'import';

interface CanonicalDeclarationRule {
  readonly path: string;
  readonly allowedKinds: ReadonlySet<DeclarationKind>;
}

// Canonical declaration sites. A declaration of the named identifier
// at this path whose kind is in `allowedKinds` is the canonical
// declaration this gate is protecting — exempt. Every other
// declaration kind, AND every declaration at any other path, is
// flagged. Value-level `SceneModule` (`const SceneModule = ...`,
// `class SceneModule { ... }`) is the same parallel-surface hazard
// even at the canonical path, so the exemption is kind-scoped to the
// interface / type form.
const CANONICAL_DECLARATION_PATHS: ReadonlyMap<string, CanonicalDeclarationRule> = new Map([
  [
    'SceneModule',
    {
      path: 'src/runtime/scene.ts',
      allowedKinds: new Set<DeclarationKind>(['interface', 'type']),
    },
  ],
  [
    'CompositionManifest',
    {
      path: 'src/runtime/composition.ts',
      allowedKinds: new Set<DeclarationKind>(['interface', 'type']),
    },
  ],
  [
    'CompositionEntry',
    {
      path: 'src/runtime/composition.ts',
      allowedKinds: new Set<DeclarationKind>(['interface', 'type']),
    },
  ],
  [
    'CompositionEntryOverride',
    {
      path: 'src/runtime/composition.ts',
      allowedKinds: new Set<DeclarationKind>(['interface', 'type']),
    },
  ],
]);

// The preflight bans "a second scene metadata schema, composition
// DTO, validation stack, exception hierarchy, logging surface,
// persistence layer, workflow controller, or registry abstraction
// for export." Type-level declarations are one form, but the same
// forbidden names can also land as VALUE-level declarations or as
// destructured bindings. The visitor below classifies every
// declaration-introducing form onto one rule table so renaming the
// storage shape cannot escape the gate.
function scanForbiddenSchemas(sourceFile: ts.SourceFile): readonly SourceFinding[] {
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const findings: SourceFinding[] = [];
  const record = (node: ts.Node, declName: string, kind: DeclarationKind): void => {
    if (!FORBIDDEN_SCHEMA_NAMES.has(declName)) return;
    // Path- AND kind-aware exemption for canonical declarations.
    // Match on either the exact stored path OR a path ending in
    // `/` + the canonical path so absolute-path callers behave
    // identically to repo-relative-path callers — the same idiom the
    // existing `isInBoundary` helper in `source-policy.ts` uses.
    const canonical = CANONICAL_DECLARATION_PATHS.get(declName);
    if (canonical !== undefined) {
      const file = sourceFile.fileName;
      const pathMatches = file === canonical.path || file.endsWith(`/${canonical.path}`);
      if (pathMatches && canonical.allowedKinds.has(kind)) return;
    }
    const start = node.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    if (exempted.has(line)) return;
    findings.push({
      file: sourceFile.fileName,
      line: line + 1,
      text: lineText(sourceFile, line).trim(),
      label: `parallel scene/composition ${kind} "${declName}" (PUL-A010)`,
    });
  };
  // Walk a binding pattern (object / array destructuring) and record
  // every local identifier whose name is in the forbidden set.
  // `const { ExportSceneSchema } = external` introduces a local
  // forbidden binding whose underlying declaration lives outside
  // `src/`; without this walk a parallel surface could land via
  // destructuring and pass the gate.
  const walkBindingPattern = (pattern: ts.BindingPattern): void => {
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const binding = element.name;
      if (ts.isIdentifier(binding)) {
        record(element, binding.text, 'destructured');
      } else {
        walkBindingPattern(binding);
      }
    }
  };
  // Walk a `VariableDeclarationList` (top-level `VariableStatement`,
  // `for (const x of ...)`, `for (let x = 0; ...)`, `for (var x in
  // ...)`) and record every binding the list introduces.
  // Classifying loop-header declarations identically catches the
  // "smuggle through a loop header" regression.
  const walkVariableDeclarationList = (list: ts.VariableDeclarationList): void => {
    const flags = list.flags;
    const kind: 'const' | 'let' | 'var' =
      (flags & ts.NodeFlags.Const) !== 0
        ? 'const'
        : (flags & ts.NodeFlags.Let) !== 0
          ? 'let'
          : 'var';
    for (const decl of list.declarations) {
      if (ts.isIdentifier(decl.name)) {
        record(decl, decl.name.text, kind);
      } else {
        walkBindingPattern(decl.name);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      record(node, node.name.text, 'interface');
    } else if (ts.isTypeAliasDeclaration(node)) {
      record(node, node.name.text, 'type');
    } else if (ts.isClassDeclaration(node) && node.name !== undefined) {
      record(node, node.name.text, 'class');
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      record(node, node.name.text, 'function');
    } else if (ts.isEnumDeclaration(node)) {
      record(node, node.name.text, 'enum');
    } else if (ts.isVariableStatement(node)) {
      walkVariableDeclarationList(node.declarationList);
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node)) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      walkVariableDeclarationList(node.initializer);
    } else if (
      ts.isImportDeclaration(node) &&
      node.importClause !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      // `import { CompositionManifest } from '@pkg/anywhere'`
      // introduces a local `CompositionManifest` binding from a
      // source outside `src/**`. Default and namespace shapes are
      // the same hazard.
      //
      // Canonical-source exemption: an import of a forbidden name
      // whose specifier path-resolves to that name's canonical
      // declaration path is the consumer-side of the canonical
      // declaration and must be allowed (otherwise every legitimate
      // consumer of `SceneModule` / `CompositionManifest` would
      // flag itself). Resolution joins `dirname(sourceFile) +
      // specifier + .ts` and compares against the canonical path.
      const specifier = node.moduleSpecifier.text;
      // The canonical-source consumer exemption applies ONLY when the
      // import installs the canonical name UN-renamed AND the specifier
      // path-resolves to the canonical declaration site. Any rename —
      // `import { Foo as SceneModule } from '../runtime/scene'` — is a
      // local-shadow: the local `SceneModule` binding points at whatever
      // `Foo` is exported as from that path, not at the canonical type.
      // Default and namespace bindings have no source name (the local
      // binding IS the only handle), so renaming does not apply — they
      // are exempt iff the specifier resolves to the canonical path.
      const recordImport = (
        target: ts.Node,
        localName: string,
        sourceName: string | undefined,
      ): void => {
        const canonical = CANONICAL_DECLARATION_PATHS.get(localName);
        if (canonical !== undefined) {
          const importingDir = pathPosix.dirname(sourceFile.fileName);
          const resolved = `${pathPosix.normalize(pathPosix.join(importingDir, specifier))}.ts`;
          const matchesCanonical =
            resolved === canonical.path || resolved.endsWith(`/${canonical.path}`);
          const isRename = sourceName !== undefined && sourceName !== localName;
          if (matchesCanonical && !isRename) return;
        }
        record(target, localName, 'import');
      };
      const clause = node.importClause;
      if (clause.name !== undefined) {
        // Default import — no source name; the LOCAL binding is the only handle.
        recordImport(clause, clause.name.text, undefined);
      }
      if (clause.namedBindings !== undefined) {
        const bindings = clause.namedBindings;
        if (ts.isNamespaceImport(bindings)) {
          // Namespace import — no source name; the LOCAL binding is the only handle.
          recordImport(bindings, bindings.name.text, undefined);
        } else if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            // For named imports, the LOCAL identifier is what enters
            // file scope as a binding. `import { Foo as ExportScene }`
            // installs `ExportScene` locally — that is the hazard. The
            // SOURCE identifier (`element.propertyName`) is the
            // package's export name; when source != local, the
            // canonical-path exemption does not apply even from the
            // canonical specifier — the local binding shadows the
            // canonical name with whatever Foo was exported as.
            const sourceName = element.propertyName?.text ?? element.name.text;
            recordImport(element, element.name.text, sourceName);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// --- Rule 3: forbidden export fields on scene-module object literals ---
//
// Rule 1 inspects the TypeScript `SceneModule` /
// `CompositionEntryOverride` INTERFACE declarations. The actual
// authoring data lives in object literals under `src/scenes/**/*.ts`
// (and per-composition overrides under `src/compositions/**/*.ts`).
// Because `assertSceneModule()` does NOT reject unknown keys, a scene
// module export can carry a forbidden export-shaped sibling field
// today and pass both the schema gate AND rule 1. Rule 3 closes the
// category at the authoring boundary by scanning every object literal
// that is annotated, asserted, or `satisfies`-bound as `SceneModule`
// or `CompositionEntryOverride` (with file-local alias resolution),
// plus every literal inside a `CompositionManifest` array binding,
// plus literals returned from a function whose return type resolves
// to a scene-shaped name. Flags any property whose key resolves to a
// name in the forbidden set rule 1 uses.

const SCENE_LIKE_TYPE_NAMES: ReadonlySet<string> = SCENE_LIKE_INTERFACES;
const COMPOSITION_MANIFEST_TYPE_NAMES: ReadonlySet<string> = new Set(['CompositionManifest']);
const SCENE_MODULE_AUTHORING_ROOTS: readonly string[] = ['scenes', 'compositions'];

/**
 * Resolve every type name a TypeNode structurally references. Returns
 * an array because intersection types (`SceneModule & Extra`)
 * introduce multiple references, any of which can identify the
 * structural shape the gate cares about. Wrappers (`parenthesized`,
 * `as ... satisfies ...`) unwrap. Unsupported nodes return `[]`.
 *
 * The result is bounded to direct identifier-style references —
 * function types, union types, mapped types, etc. cannot statically
 * identify the canonical scene shape and conservatively return no
 * names.
 */
/**
 * Source-aware resolution context. Built per source file by
 * `collectSceneShapedAliases`. Qualified-name and import-type
 * references must clear this context before they are treated as
 * canonical:
 *
 *   - `canonicalNamespaces` records every local `import * as Name
 *     from '<spec>'` whose `<spec>` path-resolves to a canonical
 *     declaration site. `Runtime.SceneModule` is canonical only when
 *     `Runtime` is in this map; `External.SceneModule` (where
 *     `External` is unrelated) is not. PUL-A010 codex review cycle 2
 *     class finding (qualified canonical-name detection used only
 *     the leaf identifier and was source-insensitive).
 *   - `sourceFilePath` (the source file's repo-relative or absolute
 *     path) is consulted by `import('./mod').SceneModule` type-
 *     position references — only canonical when the specifier path-
 *     resolves to the canonical site.
 */
interface ScenicResolutionContext {
  readonly canonicalNamespaces: ReadonlyMap<string, ReadonlySet<string>>;
  readonly sourceFilePath: string;
}

function getReferencedTypeNames(
  typeNode: ts.TypeNode | undefined,
  ctx: ScenicResolutionContext = {
    canonicalNamespaces: new Map(),
    sourceFilePath: '',
  },
): readonly string[] {
  if (typeNode === undefined) return [];
  if (ts.isTypeReferenceNode(typeNode)) {
    const tn = typeNode.typeName;
    if (ts.isIdentifier(tn)) return [tn.text];
    // Qualified-name references — `Runtime.SceneModule`, where
    // `Runtime` is a namespace import. Source-aware: only treat as
    // canonical when the leaf identifier is a canonical name AND
    // the namespace root is bound to the canonical declaration
    // site. PUL-A010 codex review cycle 2 class finding
    // (source-insensitive leaf collapsing).
    if (ts.isQualifiedName(tn)) {
      let leftCursor: ts.EntityName = tn;
      while (ts.isQualifiedName(leftCursor.left)) {
        leftCursor = leftCursor.left;
      }
      const root = ts.isQualifiedName(leftCursor) ? leftCursor.left : leftCursor;
      if (!ts.isIdentifier(root)) return [];
      const rootName = root.text;
      const namespaceCanonicalSet = ctx.canonicalNamespaces.get(rootName);
      if (namespaceCanonicalSet === undefined) return [];
      let leaf: ts.EntityName = tn;
      while (ts.isQualifiedName(leaf)) leaf = leaf.right;
      if (!ts.isIdentifier(leaf)) return [];
      const leafName = leaf.text;
      return namespaceCanonicalSet.has(leafName) ? [leafName] : [];
    }
    return [];
  }
  // Import-type references — `import('../runtime/scene').SceneModule`.
  // Source-aware: only canonical when the argument string path-
  // resolves to the canonical declaration site for the leaf name.
  if (ts.isImportTypeNode(typeNode)) {
    if (typeNode.qualifier === undefined) return [];
    let leaf: ts.EntityName = typeNode.qualifier;
    while (ts.isQualifiedName(leaf)) leaf = leaf.right;
    if (!ts.isIdentifier(leaf)) return [];
    const leafName = leaf.text;
    const canonical = CANONICAL_DECLARATION_PATHS.get(leafName);
    if (canonical === undefined) return [];
    const argLiteral = ts.isLiteralTypeNode(typeNode.argument)
      ? typeNode.argument.literal
      : undefined;
    if (argLiteral === undefined || !ts.isStringLiteralLike(argLiteral)) return [];
    const specifier = argLiteral.text;
    const importingDir = pathPosix.dirname(ctx.sourceFilePath);
    const resolved = `${pathPosix.normalize(pathPosix.join(importingDir, specifier))}.ts`;
    const matchesCanonical = resolved === canonical.path || resolved.endsWith(`/${canonical.path}`);
    return matchesCanonical ? [leafName] : [];
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return getReferencedTypeNames(typeNode.type, ctx);
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    const names: string[] = [];
    for (const t of typeNode.types) {
      names.push(...getReferencedTypeNames(t, ctx));
    }
    return names;
  }
  return [];
}

/**
 * Collect file-local aliases for the canonical scene-shaped type names
 * (`SceneModule`, `CompositionEntryOverride`) AND the composition-
 * manifest array type (`CompositionManifest`). Three alias sources are
 * honored:
 *
 *   1. `import { SceneModule as Module } from '...'` — Module is an
 *      alias for SceneModule for the rest of the file.
 *   2. `type Module = SceneModule` — alias declaration.
 *   3. Intersection-type aliases — `type X = SceneModule & Extra`
 *      classifies X as a scene-shaped binding.
 *
 * Chained aliases (`type A = SceneModule; type B = A;`) resolve via
 * fixed-point iteration; out-of-order declarations work too.
 *
 * Returns a map of LOCAL identifier name → canonical type name. The
 * canonical names themselves map to themselves so callers can do one
 * lookup instead of a membership-then-alias-lookup dance.
 */
interface CollectedAliases {
  readonly aliases: ReadonlyMap<string, string>;
  readonly ctx: ScenicResolutionContext;
}

function collectSceneShapedAliases(sourceFile: ts.SourceFile): CollectedAliases {
  const aliases = new Map<string, string>();
  const canonicalNamespaces = new Map<string, Set<string>>();
  for (const canonical of SCENE_LIKE_TYPE_NAMES) {
    aliases.set(canonical, canonical);
  }
  for (const canonical of COMPOSITION_MANIFEST_TYPE_NAMES) {
    aliases.set(canonical, canonical);
  }
  const visitImports = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const specifier = node.moduleSpecifier.text;
      if (clause.namedBindings !== undefined) {
        const bindings = clause.namedBindings;
        if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const sourceName = element.propertyName?.text ?? element.name.text;
            if (
              SCENE_LIKE_TYPE_NAMES.has(sourceName) ||
              COMPOSITION_MANIFEST_TYPE_NAMES.has(sourceName)
            ) {
              aliases.set(element.name.text, sourceName);
            }
          }
        } else if (ts.isNamespaceImport(bindings)) {
          // `import * as Runtime from '<spec>'` — register the local
          // namespace identifier ONLY when the specifier path-
          // resolves to a canonical declaration site for at least
          // one canonical name. `Runtime.SceneModule` then resolves
          // via `getReferencedTypeNames` to canonical iff
          // `Runtime` is in this map. PUL-A010 codex review cycle 2
          // class finding (source-insensitive leaf collapsing).
          const localName = bindings.name.text;
          const canonicalSet = new Set<string>();
          const importingDir = pathPosix.dirname(sourceFile.fileName);
          const resolved = `${pathPosix.normalize(pathPosix.join(importingDir, specifier))}.ts`;
          for (const [canonName, rule] of CANONICAL_DECLARATION_PATHS) {
            if (resolved === rule.path || resolved.endsWith(`/${rule.path}`)) {
              canonicalSet.add(canonName);
            }
          }
          if (canonicalSet.size > 0) {
            canonicalNamespaces.set(localName, canonicalSet);
          }
        }
      }
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(sourceFile);

  const ctx: ScenicResolutionContext = {
    canonicalNamespaces,
    sourceFilePath: sourceFile.fileName,
  };

  type TypeAlias = { readonly name: string; readonly init: ts.TypeNode };
  const typeAliases: TypeAlias[] = [];
  const visitTypeAliases = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node)) {
      typeAliases.push({ name: node.name.text, init: node.type });
    }
    ts.forEachChild(node, visitTypeAliases);
  };
  visitTypeAliases(sourceFile);

  const tryRegisterAlias = (alias: TypeAlias): boolean => {
    if (aliases.has(alias.name)) return false;
    for (const referenced of getReferencedTypeNames(alias.init, ctx)) {
      const resolved = aliases.get(referenced);
      if (resolved !== undefined) {
        aliases.set(alias.name, resolved);
        return true;
      }
    }
    return false;
  };
  for (let pass = 0; pass < typeAliases.length + 1; pass += 1) {
    let changed = false;
    for (const alias of typeAliases) {
      if (tryRegisterAlias(alias)) changed = true;
    }
    if (!changed) break;
  }

  return { aliases, ctx };
}

/**
 * Resolve `typeNode` to its canonical scene-shaped name by walking the
 * alias map collected per-file. Returns the canonical name when any
 * branch resolves, or `null` for unrelated types. Intersection types
 * resolve to the first scene-shaped branch.
 */
function resolveSceneShapedType(
  typeNode: ts.TypeNode | undefined,
  aliases: ReadonlyMap<string, string>,
  ctx: ScenicResolutionContext,
): string | null {
  for (const name of getReferencedTypeNames(typeNode, ctx)) {
    const canonical = aliases.get(name);
    if (canonical !== undefined) return canonical;
  }
  return null;
}

/**
 * Walk up from `node` through any chain of `ParenthesizedExpression`
 * wrappers and return the first non-parenthesized parent. Handles
 * `(literal) as X`, `((literal)) as X`, etc. uniformly: the binding
 * shape that authors actually write is on the outer side of the
 * parens, not nested inside them.
 */
function getEffectiveParent(node: ts.Node): ts.Node | undefined {
  let cursor: ts.Node | undefined = node.parent;
  while (cursor !== undefined && ts.isParenthesizedExpression(cursor)) {
    cursor = cursor.parent;
  }
  return cursor;
}

/**
 * Strip any chain of `ParenthesizedExpression` wrappers from `expr`
 * and return the inner expression. Used by binding-shape checks so
 * `parent.expression === objectLiteral` works equivalently when the
 * literal sits inside parens.
 */
function unwrapParens(expr: ts.Expression): ts.Expression {
  let cursor: ts.Expression = expr;
  while (ts.isParenthesizedExpression(cursor)) {
    cursor = cursor.expression;
  }
  return cursor;
}

/**
 * True when `objectLiteral`'s context binds it to one of the canonical
 * scene-shaped types (resolved through the file-local alias map).
 * Several binding shapes are honored — each is the way an author can
 * produce a value of that type structurally without quoting the type
 * name:
 *
 *   - `const x: SceneModule = { ... }` — variable initializer.
 *   - `({ ... }) as SceneModule` — `as` cast.
 *   - `({ ... }) satisfies SceneModule` — `satisfies` expression.
 *   - `<SceneModule>{ ... }` — legacy type assertion.
 *   - `const m: CompositionManifest = [{ ... }]` — array-entry shape;
 *     every element is a `CompositionEntryOverride`.
 *   - `function makeScene(): SceneModule { return { ... } }` and
 *     arrow `(): SceneModule => ({ ... })` — function-return shape.
 *
 * Intersection types (`SceneModule & Extra`) are honored at every
 * level above through `resolveSceneShapedType`. Parenthesized
 * wrappers are transparent via `getEffectiveParent` + `unwrapParens`.
 */
/**
 * Walk up the parent chain through transparent expression wrappers,
 * resolving every `AsExpression` / `SatisfiesExpression` /
 * `TypeAssertionExpression` site against the alias map. Returns the
 * canonical name when ANY wrapper in the chain resolves to a scene-
 * shaped type, or `null` when the chain terminates without one.
 *
 * Codex review cycle 1 class finding: the prior implementation
 * treated the immediate `AsExpression` as terminal, so
 * `({...} as const) satisfies SceneModule` slipped through — the
 * inner `as const` is NOT scene-shaped, but the outer `satisfies
 * SceneModule` IS. Walking up gives every wrapper a chance to
 * classify the value.
 *
 * Returns the matched canonical name on success (`'SceneModule'`,
 * `'CompositionEntryOverride'`, `'CompositionManifest'`) so the
 * array-entry case can require `'CompositionManifest'` specifically.
 * The argument `pred` lets callers restrict matches further (e.g.
 * "only match `CompositionManifest`" for the array-binding climb).
 */
function findScenicWrapperBinding(
  start: ts.Node,
  aliases: ReadonlyMap<string, string>,
  ctx: ScenicResolutionContext,
  pred: (canonical: string) => boolean = () => true,
): { node: ts.Node; canonical: string } | null {
  let cursor: ts.Node = start;
  while (true) {
    const parent: ts.Node | undefined = cursor.parent;
    if (parent === undefined) return null;
    if (
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent)
    ) {
      const canonical = resolveSceneShapedType(parent.type, aliases, ctx);
      if (canonical !== null && pred(canonical)) {
        return { node: parent, canonical };
      }
      cursor = parent;
      continue;
    }
    if (ts.isParenthesizedExpression(parent)) {
      cursor = parent;
      continue;
    }
    return null;
  }
}

/**
 * Strip transparent expression wrappers (`ParenthesizedExpression`,
 * `AsExpression`, `SatisfiesExpression`, `TypeAssertionExpression`)
 * to find the inner runtime-value expression. Used so a parent's
 * `initializer` / `expression` slot still equates to the wrapped
 * value even when the wrapper chain is several layers deep
 * (e.g. `(x as const) satisfies Y`).
 */
function unwrapTypeAssertions(node: ts.Node): ts.Node {
  let cursor: ts.Node = node;
  while (
    ts.isParenthesizedExpression(cursor) ||
    ts.isAsExpression(cursor) ||
    ts.isSatisfiesExpression(cursor) ||
    ts.isTypeAssertionExpression(cursor)
  ) {
    cursor = cursor.expression;
  }
  return cursor;
}

/**
 * Skip past any chain of transparent expression wrappers above
 * `node`, returning the first non-transparent ancestor. The dual of
 * `unwrapTypeAssertions` for the parent direction.
 */
function ascendThroughWrappers(node: ts.Node): ts.Node | undefined {
  let cursor: ts.Node | undefined = node.parent;
  while (
    cursor !== undefined &&
    (ts.isParenthesizedExpression(cursor) ||
      ts.isAsExpression(cursor) ||
      ts.isSatisfiesExpression(cursor) ||
      ts.isTypeAssertionExpression(cursor))
  ) {
    cursor = cursor.parent;
  }
  return cursor;
}

function isSceneShapedObjectLiteral(
  objectLiteral: ts.ObjectLiteralExpression,
  aliases: ReadonlyMap<string, string>,
  ctx: ScenicResolutionContext,
): boolean {
  const wrapper = findScenicWrapperBinding(objectLiteral, aliases, ctx);
  if (wrapper !== null) return true;

  const parent = ascendThroughWrappers(objectLiteral);
  if (parent === undefined) return false;

  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer !== undefined &&
    unwrapTypeAssertions(parent.initializer) === objectLiteral
  ) {
    return resolveSceneShapedType(parent.type, aliases, ctx) !== null;
  }
  if (ts.isArrayLiteralExpression(parent)) {
    const arrayWrapper = findScenicWrapperBinding(
      parent,
      aliases,
      ctx,
      (canonical) => canonical === 'CompositionManifest',
    );
    if (arrayWrapper !== null) return true;
    const arrayParent = ascendThroughWrappers(parent);
    if (arrayParent === undefined) return false;
    if (
      ts.isVariableDeclaration(arrayParent) &&
      arrayParent.initializer !== undefined &&
      unwrapTypeAssertions(arrayParent.initializer) === parent
    ) {
      return resolveSceneShapedType(arrayParent.type, aliases, ctx) === 'CompositionManifest';
    }
    if (ts.isReturnStatement(arrayParent) || ts.isArrowFunction(arrayParent)) {
      let fnCursor: ts.Node | undefined = arrayParent;
      while (fnCursor !== undefined) {
        if (
          ts.isFunctionDeclaration(fnCursor) ||
          ts.isFunctionExpression(fnCursor) ||
          ts.isMethodDeclaration(fnCursor) ||
          ts.isArrowFunction(fnCursor)
        ) {
          const fn = fnCursor as ts.SignatureDeclaration;
          return resolveSceneShapedType(fn.type, aliases, ctx) === 'CompositionManifest';
        }
        fnCursor = fnCursor.parent;
      }
    }
    return false;
  }
  if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) {
    let fnCursor: ts.Node | undefined = parent;
    while (fnCursor !== undefined) {
      if (
        ts.isFunctionDeclaration(fnCursor) ||
        ts.isFunctionExpression(fnCursor) ||
        ts.isMethodDeclaration(fnCursor) ||
        ts.isArrowFunction(fnCursor)
      ) {
        const fn = fnCursor as ts.SignatureDeclaration;
        return resolveSceneShapedType(fn.type, aliases, ctx) !== null;
      }
      fnCursor = fnCursor.parent;
    }
    return false;
  }
  return false;
}

function scanForbiddenSceneObjectFields(sourceFile: ts.SourceFile): readonly SourceFinding[] {
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const { aliases, ctx } = collectSceneShapedAliases(sourceFile);
  const findings: SourceFinding[] = [];
  const recordOn = (target: ts.Node, label: string): void => {
    const start = target.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    if (exempted.has(line)) return;
    findings.push({
      file: sourceFile.fileName,
      line: line + 1,
      text: lineText(sourceFile, line).trim(),
      label,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && isSceneShapedObjectLiteral(node, aliases, ctx)) {
      for (const property of node.properties) {
        // `SpreadAssignment` carries an opaque source whose keys we
        // cannot statically classify without resolving and re-walking
        // the spread target. We structurally ban spreads in scene-
        // shaped literals; an author who needs composition can spell
        // the keys out or use the line-allow exemption.
        if (ts.isSpreadAssignment(property)) {
          recordOn(
            property,
            'spread in scene-module object literal — export-metadata vector cannot be statically classified',
          );
          continue;
        }
        if (
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property) ||
          ts.isMethodDeclaration(property) ||
          ts.isGetAccessorDeclaration(property) ||
          ts.isSetAccessorDeclaration(property)
        ) {
          // Opaque computed keys (`{ [key]: ... }` where `key` is not
          // a static literal) cannot be statically classified — same
          // opacity rule that bans spreads.
          if (ts.isComputedPropertyName(property.name)) {
            const expr = property.name.expression;
            if (!ts.isStringLiteralLike(expr)) {
              recordOn(
                property,
                'opaque computed key in scene-module object literal — export-metadata vector cannot be statically classified',
              );
              continue;
            }
          }
          const propName = getStaticPropertyName(property.name);
          if (propName === undefined) continue;
          if (!FORBIDDEN_SCENE_FIELDS.has(propName)) continue;
          // Distinguish accessors / methods from plain assignments so
          // the finding label points at the actual member kind. Get/
          // set accessors are flagged separately from methods because
          // they install a property whose access expression (`x.exportMetadata`)
          // reads exactly like a plain field assignment — same hazard
          // shape as the codex review cycle 2 accessor-bypass finding.
          const memberKind = ts.isGetAccessorDeclaration(property)
            ? 'getter'
            : ts.isSetAccessorDeclaration(property)
              ? 'setter'
              : ts.isMethodDeclaration(property)
                ? 'method'
                : 'field';
          recordOn(
            property,
            `parallel export-metadata ${memberKind} "${propName}" on scene-module object literal`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// --- Rule 4: exported authoring declarations under authoring roots
//             must carry a canonical type binding ----------------
//
// Codex review cycle 2 class finding (annotation-dependent
// detection): rule 3's scene-shaped literal detection requires an
// explicit annotation, `as`, or `satisfies` binding. Without one,
// `export const myScene = { ...required scene fields..., exportMetadata: {} }`
// at `src/scenes/fake-scene.ts` is structurally a scene module but
// the detector cannot classify the value. Rule 4 closes the
// category at authoring time: under `src/scenes/` and
// `src/compositions/`, every top-level `export const X = <object-
// literal>` and `export const X = <array-literal>` MUST carry a
// type annotation OR be wrapped in `as` / `satisfies`. Authors
// declaring a scene/composition without a binding are flagged so
// rule 3's analyzer has data to classify.
//
// The constraint is narrowly scoped to literal initializers — string
// / number / call-expression / function exports are exempt (they
// are not authoring artifacts).

function scanUnannotatedAuthoringDeclarations(sourceFile: ts.SourceFile): readonly SourceFinding[] {
  const fileName = sourceFile.fileName;
  const isAuthoringRoot =
    /(^|\/)src\/scenes\//.test(fileName) || /(^|\/)src\/compositions\//.test(fileName);
  if (!isAuthoringRoot) return [];
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const findings: SourceFinding[] = [];
  // Only top-level `export const X = <literal>` is in scope. Local
  // helpers and inner-scope declarations don't escape the file as
  // authoring artifacts. `for (...) const X = ...` and module-
  // internal `const X = ...` (no `export` modifier) are out of
  // scope.
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const hasExport = (stmt.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (decl.initializer === undefined) continue;
      const inner = unwrapTypeAssertions(decl.initializer);
      // The constraint applies only when the initializer is a
      // literal — object or array. String / number / call /
      // function / etc. exports are not authoring artifacts and
      // remain exempt without an annotation.
      if (!ts.isObjectLiteralExpression(inner) && !ts.isArrayLiteralExpression(inner)) continue;
      // Acceptable bindings: variable annotation, `as`/`satisfies`/
      // legacy `<X>` somewhere in the initializer chain.
      const hasAnnotation = decl.type !== undefined;
      let hasAssertion = false;
      let cursor: ts.Expression = decl.initializer;
      while (cursor !== inner) {
        if (
          ts.isAsExpression(cursor) ||
          ts.isSatisfiesExpression(cursor) ||
          ts.isTypeAssertionExpression(cursor)
        ) {
          hasAssertion = true;
        }
        if (
          ts.isParenthesizedExpression(cursor) ||
          ts.isAsExpression(cursor) ||
          ts.isSatisfiesExpression(cursor) ||
          ts.isTypeAssertionExpression(cursor)
        ) {
          cursor = cursor.expression;
          continue;
        }
        break;
      }
      if (hasAnnotation || hasAssertion) continue;
      const start = decl.getStart(sourceFile);
      const { line } = sourceFile.getLineAndCharacterOfPosition(start);
      if (exempted.has(line)) continue;
      const literalKind = ts.isObjectLiteralExpression(inner) ? 'object' : 'array';
      findings.push({
        file: sourceFile.fileName,
        line: line + 1,
        text: lineText(sourceFile, line).trim(),
        label: `unannotated exported ${literalKind}-literal authoring declaration "${decl.name.text}" — must carry \`: SceneModule\` / \`: CompositionManifest\` (or equivalent \`as\` / \`satisfies\` wrapper) so PUL-A010 rule 3 can classify forbidden export-metadata fields`,
      });
    }
  }
  return findings;
}

// --- Helpers for inline-source self-tests ----------------------------

function rule1FindingsOf(source: string, file = 'src/runtime/scene.ts'): readonly SourceFinding[] {
  return scanForbiddenSceneFields(parseSource(source, file));
}

function rule2FindingsOf(
  source: string,
  file = 'src/runtime/example.ts',
): readonly SourceFinding[] {
  return scanForbiddenSchemas(parseSource(source, file));
}

function rule3FindingsOf(
  source: string,
  file = 'src/scenes/fake-scene.ts',
): readonly SourceFinding[] {
  return scanForbiddenSceneObjectFields(parseSource(source, file));
}

function rule4FindingsOf(
  source: string,
  file = 'src/scenes/fake-scene.ts',
): readonly SourceFinding[] {
  return scanUnannotatedAuthoringDeclarations(parseSource(source, file));
}

// --- Tests -----------------------------------------------------------

describe('PUL-A010 — live and export share scene metadata (source scan)', () => {
  describe('rule 1 — forbidden export fields on SceneModule / CompositionEntryOverride', () => {
    it.each([
      ['exportMetadata'],
      ['remotionMetadata'],
      ['renderManifest'],
      ['exportCaptions'],
      ['exportAssets'],
      ['exportAudio'],
      ['videoDuration'],
    ])('flags `%s` on the SceneModule interface', (field) => {
      const src = [
        'export interface SceneModule {',
        '  id: string;',
        `  ${field}: readonly unknown[];`,
        '  captions: readonly { at: number; text: string }[];',
        '}',
      ].join('\n');
      const findings = rule1FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(`parallel export-metadata field "${field}" on SceneModule`);
      expect(findings[0]?.line).toBe(3);
    });

    it.each([['exportMetadata'], ['renderManifest'], ['videoDuration'], ['exportCaptions']])(
      'flags `%s` on the CompositionEntryOverride interface',
      (field) => {
        const src = [
          'export interface CompositionEntryOverride {',
          '  readonly id: string;',
          `  readonly ${field}?: readonly unknown[];`,
          '}',
        ].join('\n');
        const findings = rule1FindingsOf(src, 'src/runtime/composition.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.label).toBe(
          `parallel export-metadata field "${field}" on CompositionEntryOverride`,
        );
      },
    );

    it('does NOT flag canonical SceneModule fields (`captions`, `assets`, `audio`, `tags`)', () => {
      const src = [
        'export interface SceneModule {',
        '  id: string;',
        '  tags: readonly string[];',
        '  assets: readonly string[];',
        '  audio: readonly string[];',
        '  captions: readonly { at: number; text: string }[];',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag a forbidden field name on an UNRELATED interface', () => {
      // The rule's contract is "no parallel export-metadata source on
      // the scene-module / composition-entry surfaces." An
      // `exportMetadata` field on a router config, a test fixture, or
      // a totally unrelated type is out of scope. Scoping the scan to
      // the two named interfaces is what makes the gate false-positive-
      // resistant.
      const src = [
        'export interface VideoExportPlan {',
        '  exportMetadata: string;',
        '  videoDuration: number;',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toEqual([]);
    });

    it('flags forbidden field names declared as METHOD signatures', () => {
      const src = [
        'export interface SceneModule {',
        '  exportMetadata(ctx: unknown): void;',
        '}',
      ].join('\n');
      const findings = rule1FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata method "exportMetadata" on SceneModule',
      );
    });

    it('honors `// PUL-A010-allow: <reason>` on the offending line', () => {
      const src = [
        'export interface SceneModule {',
        '  id: string;',
        '  exportMetadata: readonly unknown[]; // PUL-A010-allow: experimental, gated',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toEqual([]);
    });

    it('rejects an empty allow-tag rationale', () => {
      const src = [
        'export interface SceneModule {',
        '  id: string;',
        '  exportMetadata: readonly unknown[]; // PUL-A010-allow:',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toHaveLength(1);
    });

    it('rejects an allow-tag hidden inside a string literal', () => {
      const src = [
        'const note = "PUL-A010-allow: not a real exemption";',
        'export interface SceneModule {',
        '  exportMetadata: readonly unknown[];',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toHaveLength(1);
    });

    it('flags every forbidden field independently in a multi-field declaration', () => {
      const src = [
        'export interface SceneModule {',
        '  exportMetadata: readonly unknown[];',
        '  renderManifest: readonly unknown[];',
        '  videoDuration: number;',
        '}',
      ].join('\n');
      const findings = rule1FindingsOf(src);
      expect(findings).toHaveLength(3);
      expect(findings.map((f) => f.label)).toEqual([
        'parallel export-metadata field "exportMetadata" on SceneModule',
        'parallel export-metadata field "renderManifest" on SceneModule',
        'parallel export-metadata field "videoDuration" on SceneModule',
      ]);
    });

    it.each([
      ["['exportMetadata']", 'exportMetadata'],
      ['[`videoDuration`]', 'videoDuration'],
      ["['renderManifest']", 'renderManifest'],
    ])('flags computed-string-literal key `%s` on SceneModule', (key, fieldName) => {
      const src = ['export interface SceneModule {', `  ${key}: readonly unknown[];`, '}'].join(
        '\n',
      );
      const findings = rule1FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        `parallel export-metadata field "${fieldName}" on SceneModule`,
      );
    });

    // Codex review cycle 1 class finding (computed-key bypass on the
    // canonical interface): an opaque computed key whose expression
    // is an identifier — e.g. `const FIELD = 'exportMetadata' as
    // const; interface SceneModule { [FIELD]: unknown }` — can carry
    // a forbidden member that the static name extractor cannot
    // resolve. Rule 1 now applies the same opacity ban rule 3 had
    // for object literals.
    it('structurally bans opaque computed keys on the SceneModule interface', () => {
      const src = [
        "const FIELD = 'exportMetadata';",
        'export interface SceneModule {',
        '  [FIELD]: unknown;',
        '}',
      ].join('\n');
      const findings = rule1FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'opaque computed key on SceneModule interface — export-metadata vector cannot be statically classified',
      );
    });

    it('structurally bans opaque computed keys on the CompositionEntryOverride interface', () => {
      const src = [
        "const FIELD = 'renderManifest';",
        'export interface CompositionEntryOverride {',
        '  [FIELD]: unknown;',
        '}',
      ].join('\n');
      const findings = rule1FindingsOf(src, 'src/runtime/composition.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'opaque computed key on CompositionEntryOverride interface — export-metadata vector cannot be statically classified',
      );
    });

    it('honors `// PUL-A010-allow: <reason>` on an opaque computed interface key', () => {
      const src = [
        "const FIELD = 'exportMetadata';",
        'export interface SceneModule {',
        '  [FIELD]: unknown; // PUL-A010-allow: dynamic-key authoring helper under review',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toEqual([]);
    });

    // Codex review cycle 2 class finding (index-signature bypass):
    // an index signature `[key: string]: unknown` on the canonical
    // scene interface admits unbounded fields → unbounded export-
    // metadata authoring slot. Same opacity concern as opaque
    // computed keys; structurally banned.
    it('structurally bans index signatures on the SceneModule interface', () => {
      const src = [
        'export interface SceneModule {',
        '  id: string;',
        '  [key: string]: unknown;',
        '}',
      ].join('\n');
      const findings = rule1FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'index signature on SceneModule interface — export-metadata vector cannot be statically classified',
      );
    });

    it('structurally bans index signatures on the CompositionEntryOverride interface', () => {
      const src = [
        'export interface CompositionEntryOverride {',
        '  readonly id: string;',
        '  readonly [key: string]: unknown;',
        '}',
      ].join('\n');
      const findings = rule1FindingsOf(src, 'src/runtime/composition.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'index signature on CompositionEntryOverride interface — export-metadata vector cannot be statically classified',
      );
    });

    it('honors `// PUL-A010-allow: <reason>` on an index signature', () => {
      const src = [
        'export interface SceneModule {',
        '  [key: string]: unknown; // PUL-A010-allow: bounded-index-signature proposal under review',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toEqual([]);
    });
  });

  describe('rule 2 — forbidden parallel scene/composition schema declarations', () => {
    it.each([
      ['ExportScene'],
      ['RenderScene'],
      ['SceneDTO'],
      ['ExportComposition'],
      ['RenderManifest'],
      ['ExportSceneSchema'],
      ['ExportCompositionSchema'],
      ['ExportSceneDTO'],
      ['ExportCompositionDTO'],
      ['ExportSceneInput'],
      ['ExportCompositionInput'],
      ['ExportCompositionManifest'],
    ])('flags `interface %s { ... }`', (name) => {
      const src = `export interface ${name} { id: string }`;
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(`parallel scene/composition interface "${name}" (PUL-A010)`);
    });

    it.each([['ExportScene'], ['SceneDTO'], ['RenderManifest'], ['ExportSceneDTO']])(
      'flags `type %s = ...`',
      (name) => {
        const src = `export type ${name} = { id: string };`;
        const findings = rule2FindingsOf(src);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.label).toBe(`parallel scene/composition type "${name}" (PUL-A010)`);
      },
    );

    it('does NOT flag the canonical `SceneModule` interface at `src/runtime/scene.ts`', () => {
      const src = 'export interface SceneModule { id: string }';
      expect(rule2FindingsOf(src, 'src/runtime/scene.ts')).toEqual([]);
    });

    it('does NOT flag the canonical `type CompositionManifest` at `src/runtime/composition.ts`', () => {
      const src = 'export type CompositionManifest = readonly string[];';
      expect(rule2FindingsOf(src, 'src/runtime/composition.ts')).toEqual([]);
    });

    it('does NOT flag the canonical `type CompositionEntry` at `src/runtime/composition.ts`', () => {
      const src = 'export type CompositionEntry = string;';
      expect(rule2FindingsOf(src, 'src/runtime/composition.ts')).toEqual([]);
    });

    it('does NOT flag the canonical `interface CompositionEntryOverride` at `src/runtime/composition.ts`', () => {
      const src = 'export interface CompositionEntryOverride { id: string }';
      expect(rule2FindingsOf(src, 'src/runtime/composition.ts')).toEqual([]);
    });

    it('flags a parallel `SceneModule` interface declared OUTSIDE `src/runtime/scene.ts`', () => {
      const src = 'export interface SceneModule { id: string }';
      const findings = rule2FindingsOf(src, 'src/runtime/shadow-scene.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel scene/composition interface "SceneModule" (PUL-A010)',
      );
    });

    it('flags a value-level `SceneModule` AT the canonical path (kind exemption is scoped)', () => {
      // The path-AND-kind exemption allows `interface SceneModule`
      // and `type SceneModule` at `src/runtime/scene.ts` only. A
      // value-level `const SceneModule = ...` or `class SceneModule
      // {}` at the same path is the same parallel-surface hazard and
      // is flagged.
      const src = 'const SceneModule = { id: "x" };';
      const findings = rule2FindingsOf(src, 'src/runtime/scene.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel scene/composition const "SceneModule" (PUL-A010)');
    });

    it('flags `class ExportScene` (value-level declaration)', () => {
      const src = 'export class ExportScene {}';
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel scene/composition class "ExportScene" (PUL-A010)');
    });

    it('flags `function ExportScene()` (value-level declaration)', () => {
      const src = 'export function ExportScene() {}';
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel scene/composition function "ExportScene" (PUL-A010)',
      );
    });

    it('flags `const ExportSceneSchema = ...`', () => {
      const src = 'export const ExportSceneSchema = { id: "x" };';
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel scene/composition const "ExportSceneSchema" (PUL-A010)',
      );
    });

    it('flags `let ExportScene = ...` and `var ExportScene = ...`', () => {
      const srcLet = 'export let ExportScene = { id: "x" };';
      const lf = rule2FindingsOf(srcLet);
      expect(lf).toHaveLength(1);
      expect(lf[0]?.label).toBe('parallel scene/composition let "ExportScene" (PUL-A010)');

      const srcVar = 'var ExportScene = { id: "x" };';
      const vf = rule2FindingsOf(srcVar);
      expect(vf).toHaveLength(1);
      expect(vf[0]?.label).toBe('parallel scene/composition var "ExportScene" (PUL-A010)');
    });

    it('flags `enum ExportScene { ... }`', () => {
      const src = 'export enum ExportScene { A, B }';
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel scene/composition enum "ExportScene" (PUL-A010)');
    });

    it('flags destructured-binding `const { ExportSceneSchema } = external`', () => {
      const src = 'declare const external: any; const { ExportSceneSchema } = external;';
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel scene/composition destructured "ExportSceneSchema" (PUL-A010)',
      );
    });

    it('flags loop-header `for (const ExportScene of arr)`', () => {
      const src = 'declare const arr: any[]; for (const ExportScene of arr) { void ExportScene; }';
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel scene/composition const "ExportScene" (PUL-A010)');
    });

    it('flags `import { ExportSceneSchema } from "@pkg/anywhere"`', () => {
      const src = "import { ExportSceneSchema } from '@pkg/anywhere';";
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel scene/composition import "ExportSceneSchema" (PUL-A010)',
      );
    });

    it('flags `import { Foo as ExportScene } from "@pkg/anywhere"` (local-alias rename)', () => {
      const src = "import { Foo as ExportScene } from '@pkg/anywhere';";
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel scene/composition import "ExportScene" (PUL-A010)');
    });

    it('flags default import `import ExportScene from "@pkg/anywhere"`', () => {
      const src = "import ExportScene from '@pkg/anywhere';";
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel scene/composition import "ExportScene" (PUL-A010)');
    });

    it('flags namespace import `import * as ExportScene from "@pkg/anywhere"`', () => {
      const src = "import * as ExportScene from '@pkg/anywhere';";
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel scene/composition import "ExportScene" (PUL-A010)');
    });

    it('does NOT flag canonical-source consumer imports of `SceneModule`', () => {
      // `import type { SceneModule } from '../runtime/scene'` from a
      // consumer at `src/scenes/x.ts` resolves to the canonical
      // declaration site and is the legitimate consumer-side of the
      // canonical type. Flagging it would block every consumer.
      const src = "import type { SceneModule } from '../runtime/scene';";
      const findings = rule2FindingsOf(src, 'src/scenes/fake.ts');
      expect(findings).toEqual([]);
    });

    it('does NOT flag canonical-source consumer imports of `CompositionManifest`', () => {
      const src = "import type { CompositionManifest } from '../runtime/composition';";
      const findings = rule2FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toEqual([]);
    });

    it('flags `import { SceneModule } from "@pkg/shadow"` (NON-canonical source)', () => {
      const src = "import { SceneModule } from '@pkg/shadow';";
      const findings = rule2FindingsOf(src, 'src/scenes/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel scene/composition import "SceneModule" (PUL-A010)');
    });

    it('flags `import { Foo as SceneModule } from "../runtime/scene"` (local-shadow at canonical path)', () => {
      // The local-shadow case: the source name is `Foo`, but the
      // LOCAL binding is `SceneModule`. Even though the specifier
      // resolves to the canonical path, the consumer is installing a
      // `SceneModule` binding that is NOT the canonical one. Flag it.
      const src = "import { Foo as SceneModule } from '../runtime/scene';";
      const findings = rule2FindingsOf(src, 'src/scenes/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel scene/composition import "SceneModule" (PUL-A010)');
    });

    it('flags every forbidden name independently in one file', () => {
      const src = [
        'export interface ExportScene { id: string }',
        'export type SceneDTO = { id: string };',
        'export class RenderManifest {}',
      ].join('\n');
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(3);
      expect(findings.map((f) => f.label)).toEqual([
        'parallel scene/composition interface "ExportScene" (PUL-A010)',
        'parallel scene/composition type "SceneDTO" (PUL-A010)',
        'parallel scene/composition class "RenderManifest" (PUL-A010)',
      ]);
    });

    it('honors `// PUL-A010-allow: <reason>` on the offending line', () => {
      const src =
        'export interface ExportScene { id: string } // PUL-A010-allow: serialization-format proposal under review';
      expect(rule2FindingsOf(src)).toEqual([]);
    });
  });

  describe('rule 3 — forbidden export fields on scene-module object literals', () => {
    it.each([
      ['exportMetadata'],
      ['remotionMetadata'],
      ['renderManifest'],
      ['exportCaptions'],
      ['exportAssets'],
      ['exportAudio'],
      ['videoDuration'],
    ])('flags `%s` on a `: SceneModule` annotated literal', (field) => {
      const src = [
        'declare const x: unknown;',
        'export const myScene: SceneModule = {',
        `  id: 'fake',`,
        `  ${field}: x,`,
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        `parallel export-metadata field "${field}" on scene-module object literal`,
      );
    });

    it('flags forbidden field on `({...}) as SceneModule`', () => {
      const src = [
        'declare const x: unknown;',
        'export const myScene = ({',
        "  id: 'fake',",
        '  exportMetadata: x,',
        '}) as SceneModule;',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportMetadata" on scene-module object literal',
      );
    });

    it('flags forbidden field on `({...}) satisfies SceneModule`', () => {
      const src = [
        'declare const x: unknown;',
        'export const myScene = ({',
        "  id: 'fake',",
        '  renderManifest: x,',
        '}) satisfies SceneModule;',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "renderManifest" on scene-module object literal',
      );
    });

    it('flags forbidden field on `<SceneModule>{ ... }` legacy type assertion', () => {
      const src = [
        'declare const x: unknown;',
        'export const myScene = <SceneModule>{',
        "  id: 'fake',",
        '  videoDuration: 30,',
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "videoDuration" on scene-module object literal',
      );
    });

    it('flags forbidden field on a CompositionManifest array entry literal', () => {
      const src = [
        'export const m: CompositionManifest = [',
        "  { id: 'fake-scene', exportMetadata: { fps: 30 } },",
        '];',
      ].join('\n');
      const findings = rule3FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportMetadata" on scene-module object literal',
      );
    });

    it('flags forbidden field on a literal returned from `(): SceneModule`', () => {
      const src = [
        'export function makeScene(): SceneModule {',
        '  return {',
        "    id: 'fake',",
        '    exportMetadata: {},',
        '  };',
        '}',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportMetadata" on scene-module object literal',
      );
    });

    it('flags forbidden field on an arrow-return `(): SceneModule => ({ ... })`', () => {
      const src = [
        'export const makeScene = (): SceneModule => ({',
        "  id: 'fake',",
        '  exportCaptions: [],',
        '});',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportCaptions" on scene-module object literal',
      );
    });

    it('flags forbidden field on a `SceneModule & Extra` intersection-typed variable', () => {
      const src = [
        'interface Extra { customMeta: string }',
        'export const myScene: SceneModule & Extra = {',
        "  id: 'fake',",
        "  customMeta: 'meta',",
        '  exportAudio: [],',
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportAudio" on scene-module object literal',
      );
    });

    it('flags via type-alias of an intersection (`type X = SceneModule & Extra`)', () => {
      const src = [
        'interface Extra { customMeta: string }',
        'type X = SceneModule & Extra;',
        'export const myScene: X = {',
        "  id: 'fake',",
        "  customMeta: 'meta',",
        '  exportAssets: [],',
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportAssets" on scene-module object literal',
      );
    });

    it('flags via aliased SceneModule import `import { SceneModule as Module }`', () => {
      const src = [
        "import type { SceneModule as Module } from '../runtime/scene';",
        'export const myScene: Module = {',
        "  id: 'fake',",
        '  remotionMetadata: {},',
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "remotionMetadata" on scene-module object literal',
      );
    });

    it('flags via aliased CompositionManifest binding `import { CompositionManifest as Manifest }`', () => {
      const src = [
        "import type { CompositionManifest as Manifest } from '../runtime/composition';",
        'export const m: Manifest = [',
        "  { id: 'fake-scene', exportMetadata: {} },",
        '];',
      ].join('\n');
      const findings = rule3FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportMetadata" on scene-module object literal',
      );
    });

    it('flags forbidden method on a scene-shaped literal', () => {
      const src = [
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        '  exportMetadata() { return null; },',
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata method "exportMetadata" on scene-module object literal',
      );
    });

    it('flags computed-string-literal key on a scene-shaped literal', () => {
      const src = [
        'declare const x: unknown;',
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        "  ['exportMetadata']: x,",
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportMetadata" on scene-module object literal',
      );
    });

    it('structurally bans `...extra` spreads inside a scene-shaped literal', () => {
      const src = [
        'declare const extra: object;',
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        '  ...extra,',
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'spread in scene-module object literal — export-metadata vector cannot be statically classified',
      );
    });

    it('structurally bans opaque computed keys inside a scene-shaped literal', () => {
      const src = [
        'declare const key: string;',
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        '  [key]: null,',
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'opaque computed key in scene-module object literal — export-metadata vector cannot be statically classified',
      );
    });

    it('honors `// PUL-A010-allow: <reason>` on the offending line', () => {
      const src = [
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        '  exportMetadata: {}, // PUL-A010-allow: trailer prototype, gated',
        '};',
      ].join('\n');
      expect(rule3FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag a literal that is NOT scene-shaped', () => {
      // Object literal annotated as an unrelated type — out of scope.
      const src = [
        'interface ExportPlan { exportMetadata: object }',
        'export const plan: ExportPlan = { exportMetadata: { fps: 30 } };',
      ].join('\n');
      expect(rule3FindingsOf(src)).toEqual([]);
    });

    // Codex review cycle 1 class finding (`as const satisfies`
    // bypass): the prior detector treated the immediate `as`
    // expression as terminal, so `({...} as const) satisfies
    // SceneModule` slipped through — the inner `as const` is not
    // scene-shaped, but the outer `satisfies SceneModule` is. The
    // detector now walks up through transparent assertion wrappers
    // and checks each binding site.
    it('flags forbidden field on `({...} as const) satisfies SceneModule`', () => {
      const src = [
        'export const myScene = ({',
        "  id: 'fake',",
        '  exportMetadata: {},',
        '} as const) satisfies SceneModule;',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportMetadata" on scene-module object literal',
      );
    });

    it('flags forbidden field on `({...} as const) satisfies CompositionEntryOverride`', () => {
      const src = [
        'export const entry = ({',
        "  id: 'fake-scene',",
        '  renderManifest: {},',
        '} as const) satisfies CompositionEntryOverride;',
      ].join('\n');
      const findings = rule3FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "renderManifest" on scene-module object literal',
      );
    });

    it('flags forbidden field on `([{...} as const]) satisfies CompositionManifest`', () => {
      const src = [
        'export const m = ([',
        '  {',
        "    id: 'fake-scene',",
        '    videoDuration: 30,',
        '  } as const,',
        ']) satisfies CompositionManifest;',
      ].join('\n');
      const findings = rule3FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "videoDuration" on scene-module object literal',
      );
    });

    // Codex review cycle 1 class finding (qualified canonical type
    // references invisible): a namespace import + qualified type
    // reference — `import type * as Runtime from '../runtime/scene';
    // const s: Runtime.SceneModule = {...}` — bypassed the detector
    // because `Runtime.SceneModule` is a `QualifiedName`, not an
    // `Identifier`. `getReferencedTypeNames` now walks qualified
    // names to the leaf identifier.
    it('flags forbidden field on a `Runtime.SceneModule` namespace-qualified annotation', () => {
      const src = [
        "import type * as Runtime from '../runtime/scene';",
        'export const myScene: Runtime.SceneModule = {',
        "  id: 'fake',",
        '  exportMetadata: {},',
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportMetadata" on scene-module object literal',
      );
    });

    it('flags forbidden field on a `Runtime.CompositionManifest` array annotation', () => {
      const src = [
        "import type * as Runtime from '../runtime/composition';",
        'export const m: Runtime.CompositionManifest = [',
        "  { id: 'fake-scene', exportMetadata: {} },",
        '];',
      ].join('\n');
      const findings = rule3FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportMetadata" on scene-module object literal',
      );
    });

    it('flags forbidden field on an `import("./scene").SceneModule` type-position dynamic import', () => {
      const src = [
        "export const myScene: import('../runtime/scene').SceneModule = {",
        "  id: 'fake',",
        '  exportAudio: [],',
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportAudio" on scene-module object literal',
      );
    });

    // Codex review cycle 2 class finding (qualified-name detection
    // was source-insensitive): a namespace import from a NON-
    // canonical path should not be treated as the canonical
    // `SceneModule`. `External.SceneModule` from `@pkg/shadow` is
    // not the canonical type and must not trigger an A010 finding
    // on its object literal — that would be a false positive that
    // blocks unrelated code. Source-aware resolution requires the
    // namespace's import specifier to resolve to the canonical
    // declaration site before the leaf is treated as canonical.
    it('does NOT flag a `External.SceneModule` reference from a non-canonical namespace import', () => {
      const src = [
        "import type * as External from '@pkg/shadow';",
        'declare const x: unknown;',
        'export const myScene: External.SceneModule = {',
        "  id: 'fake',",
        '  exportMetadata: x,',
        '};',
      ].join('\n');
      expect(rule3FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag an `import("@pkg/shadow").SceneModule` type-position reference from a non-canonical specifier', () => {
      const src = [
        'declare const x: unknown;',
        "export const myScene: import('@pkg/shadow').SceneModule = {",
        "  id: 'fake',",
        '  exportMetadata: x,',
        '};',
      ].join('\n');
      expect(rule3FindingsOf(src)).toEqual([]);
    });

    // Codex review cycle 2 class finding (returned-manifest array
    // gap): `function makeManifest(): CompositionManifest { return
    // [{...}] }` and arrow `(): CompositionManifest => ([{...}])`
    // are valid authoring shapes whose array sits inside a return
    // statement / arrow-function body. The detector now walks up
    // from the array to the enclosing function-like declaration.
    it('flags forbidden field on a CompositionManifest returned from a function', () => {
      const src = [
        'export function makeManifest(): CompositionManifest {',
        "  return [{ id: 'fake-scene', exportMetadata: {} }];",
        '}',
      ].join('\n');
      const findings = rule3FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "exportMetadata" on scene-module object literal',
      );
    });

    it('flags forbidden field on a CompositionManifest returned from an arrow function', () => {
      const src = [
        'export const makeManifest = (): CompositionManifest => [',
        "  { id: 'fake-scene', renderManifest: {} },",
        '];',
      ].join('\n');
      const findings = rule3FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata field "renderManifest" on scene-module object literal',
      );
    });

    // Codex review cycle 2 class finding (accessor-bypass): get/set
    // accessors on a scene-shaped literal install the same public
    // property key as a regular assignment. `get exportMetadata() {
    // ... }` and `set exportMetadata(v) { ... }` are now scanned.
    it('flags `get exportMetadata()` on a scene-shaped literal', () => {
      const src = [
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        '  get exportMetadata() { return {}; },',
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata getter "exportMetadata" on scene-module object literal',
      );
    });

    it('flags `set renderManifest(v)` on a scene-shaped literal', () => {
      const src = [
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        '  set renderManifest(v: unknown) { void v; },',
        '};',
      ].join('\n');
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel export-metadata setter "renderManifest" on scene-module object literal',
      );
    });

    it('does NOT flag canonical scene fields on a scene-shaped literal', () => {
      const src = [
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        "  title: 'Fake',",
        '  duration: null,',
        '  tags: [],',
        '  assets: [],',
        '  audio: [],',
        '  captions: [],',
        '  defaultNext: null,',
        '  standalone: true,',
        '  trailerSafe: false,',
        '  create: () => {},',
        '  timeline: () => null,',
        '  cleanup: () => {},',
        '};',
      ].join('\n');
      expect(rule3FindingsOf(src)).toEqual([]);
    });
  });

  describe('rule 4 — exported authoring declarations must carry a canonical binding', () => {
    const RULE_4_LABEL_SUFFIX =
      ' — must carry `: SceneModule` / `: CompositionManifest` (or equivalent `as` / `satisfies` wrapper) so PUL-A010 rule 3 can classify forbidden export-metadata fields';

    it('flags an exported unannotated object literal under `src/scenes/`', () => {
      const src = "export const myScene = { id: 'fake' };";
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        `unannotated exported object-literal authoring declaration "myScene"${RULE_4_LABEL_SUFFIX}`,
      );
    });

    it('flags an exported unannotated array literal under `src/compositions/`', () => {
      const src = "export const m = [{ id: 'fake-scene' }];";
      const findings = rule4FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        `unannotated exported array-literal authoring declaration "m"${RULE_4_LABEL_SUFFIX}`,
      );
    });

    it('does NOT flag an exported object literal WITH a type annotation', () => {
      const src = "export const myScene: SceneModule = { id: 'fake' };";
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag an exported object literal WITH `as SceneModule`', () => {
      const src = "export const myScene = ({ id: 'fake' }) as SceneModule;";
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag an exported object literal WITH `satisfies SceneModule`', () => {
      const src = "export const myScene = ({ id: 'fake' }) satisfies SceneModule;";
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag an exported `as const satisfies SceneModule` chain', () => {
      const src = "export const myScene = ({ id: 'fake' } as const) satisfies SceneModule;";
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag an exported string / number literal (not an authoring artifact)', () => {
      const src = ["export const TITLE = 'My Scene';", 'export const COUNT = 42;'].join('\n');
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag a non-export `const` (out of scope)', () => {
      const src = "const local = { id: 'fake' };";
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    it('does NOT scan files OUTSIDE `src/scenes/` and `src/compositions/`', () => {
      const src = "export const myScene = { id: 'fake' };";
      expect(rule4FindingsOf(src, 'src/runtime/scene.ts')).toEqual([]);
      expect(rule4FindingsOf(src, 'src/main.ts')).toEqual([]);
    });

    it('honors `// PUL-A010-allow: <reason>` on the offending line', () => {
      const src =
        "export const myScene = { id: 'fake' }; // PUL-A010-allow: utility helper, not a scene authoring artifact";
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    it('flags every unannotated exported literal in a multi-declaration file', () => {
      const src = [
        "export const sceneA = { id: 'a' };",
        "export const sceneB: SceneModule = { id: 'b' };",
        "export const sceneC = { id: 'c' };",
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings.map((f) => f.label)).toEqual([
        `unannotated exported object-literal authoring declaration "sceneA"${RULE_4_LABEL_SUFFIX}`,
        `unannotated exported object-literal authoring declaration "sceneC"${RULE_4_LABEL_SUFFIX}`,
      ]);
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('rule 1: zero forbidden export-metadata fields on `SceneModule` / `CompositionEntryOverride`', () => {
      const sceneFile = join(SRC_ROOT, 'runtime', 'scene.ts');
      const compositionFile = join(SRC_ROOT, 'runtime', 'composition.ts');
      expect(statSync(sceneFile).isFile()).toBe(true);
      expect(statSync(compositionFile).isFile()).toBe(true);
      const findings: SourceFinding[] = [];
      for (const file of [sceneFile, compositionFile]) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        findings.push(...scanForbiddenSceneFields(parseSource(text, rel)));
      }
      const header =
        'PUL-A010 forbids parallel export-metadata fields on the scene-module / composition-entry surfaces. Export pipelines consume the canonical scene metadata and composition manifests (ADR-006); a sibling field like `exportMetadata`, `renderManifest`, `exportCaptions`, `exportAssets`, `exportAudio`, `videoDuration`, or `remotionMetadata` constitutes a separate authoring source. Add a `// PUL-A010-allow: <reason>` exemption on the same line only for a deliberate, gated experiment.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });

    it('rule 2: zero forbidden parallel scene/composition declarations across `src/**/*.ts`', () => {
      const files = walkTsFiles(SRC_ROOT);
      const findings: SourceFinding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        findings.push(...scanForbiddenSchemas(parseSource(text, rel)));
      }
      const header =
        'PUL-A010 forbids declaring a parallel scene/composition shape (`ExportScene`, `RenderScene`, `SceneDTO`, `ExportComposition`, `RenderManifest`, `ExportSceneSchema`, etc.) anywhere in the runtime tree. The canonical `SceneModule` (`src/runtime/scene.ts`) and `CompositionManifest` / `CompositionEntry` / `CompositionEntryOverride` (`src/runtime/composition.ts`) are the only authoring shapes; export pipelines consume them structurally (ADR-006). Add a `// PUL-A010-allow: <reason>` exemption on the same line only when a serialization-format proposal is under review.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });

    it('rule 4: every exported literal under `src/scenes/` and `src/compositions/` carries a canonical binding', () => {
      const findings: SourceFinding[] = [];
      for (const root of SCENE_MODULE_AUTHORING_ROOTS) {
        const dir = join(SRC_ROOT, root);
        expect(statSync(dir).isDirectory()).toBe(true);
        for (const file of walkTsFiles(dir)) {
          const text = readFileSync(file, 'utf-8');
          const rel = relative(REPO_ROOT, file);
          findings.push(...scanUnannotatedAuthoringDeclarations(parseSource(text, rel)));
        }
      }
      const header =
        'PUL-A010 requires every exported top-level object- or array-literal authoring declaration under `src/scenes/` and `src/compositions/` to carry a canonical type annotation (`X: SceneModule = ...`) or an equivalent `as` / `satisfies` wrapper. Without one, rule 3 cannot classify whether a forbidden export-metadata field is present on the literal. Add the annotation, or use a `// PUL-A010-allow: <reason>` exemption on the same line for a deliberate utility helper that is not a scene/composition authoring artifact.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });

    it('rule 3: zero forbidden export-metadata fields on scene-module object literals under `src/scenes/` and `src/compositions/`', () => {
      const findings: SourceFinding[] = [];
      for (const root of SCENE_MODULE_AUTHORING_ROOTS) {
        const dir = join(SRC_ROOT, root);
        expect(statSync(dir).isDirectory()).toBe(true);
        for (const file of walkTsFiles(dir)) {
          const text = readFileSync(file, 'utf-8');
          const rel = relative(REPO_ROOT, file);
          findings.push(...scanForbiddenSceneObjectFields(parseSource(text, rel)));
        }
      }
      const header =
        'PUL-A010 forbids parallel export-metadata fields on scene-module object literals (the actual authoring surface under `src/scenes/` and `src/compositions/`). The canonical `SceneModule` shape is the single authoring slot; a sibling `exportMetadata` / `renderManifest` / `videoDuration` / `exportCaptions` / `exportAssets` / `exportAudio` / `remotionMetadata` on a `: SceneModule` or `satisfies SceneModule` literal is a separate authoring source even though `assertSceneModule()` accepts unknown keys. Add a `// PUL-A010-allow: <reason>` exemption on the same line only for a deliberate, gated experiment.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });
  });
});
