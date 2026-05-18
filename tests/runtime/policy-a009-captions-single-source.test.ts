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

// PUL-A009 — Captions / prompter single source.
//
// Statement: "The prompter view SHALL be derived from the same caption
// metadata used by the runtime. There SHALL NOT be a separate
// authoring source for prompter content."
//
// Clause 1 is structurally satisfied today by `Caption`,
// `SceneModule.captions`, and `buildPrompterScript()` — pinned by
// `tests/runtime/prompter.test.ts` (derivation behavior),
// `tests/runtime/scene.test.ts` (canonical schema), and
// `tests/runtime/scene-loader-screenshot-prompter.test.ts` (loader
// routes `mode=prompter` through the captions data path). This gate
// adds the structural defense for clause 2 — the *negation* — so a
// future PR cannot silently re-introduce a parallel authoring source
// for prompter content.
//
// Four sub-rules, each modeled on the existing PUL-A001..A006 / A008
// source-scan family and sharing the helpers in `source-policy.ts`:
//
//   1. **Forbidden authoring-source field names on the scene-module
//      and composition-entry INTERFACES.** AST-walk the canonical
//      scene and composition modules; flag any property declared on
//      the `SceneModule` interface or the `CompositionEntryOverride`
//      interface whose name is in {prompterCaptions, prompterScript,
//      prompterText, teleprompter, captionOverrides, script, notes}.
//      Property-name extraction covers identifier, string-literal,
//      and computed-string-literal forms (`['prompterCaptions']:
//      ...`); codex review cycle 2 closed the computed-key bypass.
//
//   2. **Forbidden parallel caption-schema declarations anywhere in
//      `src/`.** Flag `interface`, `type`, `const`, `let`, `var`,
//      `class`, `function`, `enum`, and destructured-binding
//      declarations whose name is in {Caption, PrompterCaption,
//      PrompterCaptionSchema, CaptionSchema, CaptionError,
//      CaptionAuthoring, PrompterAuthoring, CaptionInput,
//      CaptionDTO}. `Caption` itself is included with a
//      path-sensitive exemption (the canonical declaration site is
//      `src/runtime/scene.ts`); a parallel `Caption` anywhere else
//      is the same hazard. Codex review cycles 1 and 2 surfaced
//      both the value-level declaration vector (`const CaptionSchema
//      = z.object(...)`, `class CaptionError extends Error`, etc.)
//      AND the destructured-binding vector (`const { CaptionSchema }
//      = external`); the rule now classifies every binding form onto
//      the same table.
//
//   3. **Caption import boundary in `src/runtime/prompter.ts`.** The
//      prompter module may import `Caption` only from `./scene`.
//      Codex review cycle 1 expanded the rule to flag any non-`./scene`
//      import that brings `Caption` into prompter's identifier scope:
//      named imports whose source OR local name is `Caption`,
//      default imports bound locally as `Caption`, and namespace
//      imports bound locally as `Caption`. This catches both the
//      source-side rename hazard (`import { Caption as MyCaption }`)
//      and the local-side shadow hazard (`import { Foo as Caption }`,
//      `import Caption from`, `import * as Caption from`).
//
//   4. **Forbidden authoring-source field names on the scene-module
//      and composition-entry OBJECT LITERALS** (codex review cycle 1
//      class finding). The interface-level scan (rule 1) does not
//      cover the actual authoring surface where scene module values
//      are written — `src/scenes/**/*.ts` and
//      `src/compositions/**/*.ts`. Because `assertSceneModule()`
//      accepts unknown keys (the preflight rules out a runtime
//      implementation change for this requirement), an authored scene
//      can carry a forbidden caption-shaped sibling field at the
//      value level and pass both the schema gate and rule 1. Rule 4
//      AST-walks every object literal annotated, asserted, or
//      `satisfies`-bound as `SceneModule` or
//      `CompositionEntryOverride`, flagging property keys against the
//      same forbidden set rule 1 uses. Codex review cycle 2 added:
//      (a) file-local alias resolution for the canonical type names
//      (`import { SceneModule as Module }`, `type Module =
//      SceneModule`, chained type aliases) so a rename cannot
//      escape; (b) a structural ban on `SpreadAssignment` inside
//      scene-shaped literals (`{ ...extra }`) because the spread
//      source cannot be statically classified for forbidden keys;
//      and (c) the same computed-string-literal key extraction as
//      rule 1.
//
// Each rule supports a line-scoped `// PUL-A009-allow: <reason>`
// exemption via the shared `collectLineExemptions` helper. Empty /
// whitespace-only rationales are rejected; markers hidden inside
// string literals are rejected; the marker applies only to its own
// line. The exemption is for narrow legitimate cases that may emerge
// later (e.g., a deliberate test fixture file that needs to declare
// `CaptionDTO` for a serialization-format proposal under review).

const ALLOW_TAG = 'PUL-A009-allow';

/**
 * Resolve a static string name for a `PropertyName` — covering identifier
 * forms (`captions`), string-literal forms (`'captions'`), and computed
 * forms whose inner expression resolves to a static string
 * (`['captions']`, `` [`captions`] ``). Returns `undefined` for any
 * dynamic, computed-non-literal, or numeric form. Shared across rule 1
 * (interface members) and rule 4 (object-literal properties) so a
 * regression that hides a forbidden key behind `['prompterCaptions']`
 * cannot escape either gate. Codex review cycle 2 class finding
 * (computed-key bypass) — the prior name-extraction was identifier +
 * string-literal-like only.
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

// --- Rule 1: forbidden field names on SceneModule / CompositionEntryOverride ---

const FORBIDDEN_SCENE_FIELDS: ReadonlySet<string> = new Set([
  'prompterCaptions',
  'prompterScript',
  'prompterText',
  'teleprompter',
  'captionOverrides',
  'script',
  'notes',
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
        // Codex review cycle 3 (class finding): the prior scan
        // skipped method-style members on the assumption they were
        // not authoring data slots. But `SceneModule` interfaces
        // accept unknown keys at the value level (the schema gate
        // does not reject them), and a `prompterScript(): string`
        // method on the interface is structurally the same parallel
        // authoring surface as `prompterScript: () => string`.
        // The scanner now flags both `PropertySignature` and
        // `MethodSignature` members whose name is in the forbidden
        // set.
        if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
        const propName = getStaticPropertyName(member.name);
        if (propName === undefined) continue;
        if (!FORBIDDEN_SCENE_FIELDS.has(propName)) continue;
        const start = member.getStart(sourceFile);
        const { line } = sourceFile.getLineAndCharacterOfPosition(start);
        if (exempted.has(line)) continue;
        const memberKind = ts.isMethodSignature(member) ? 'method' : 'field';
        findings.push({
          file: sourceFile.fileName,
          line: line + 1,
          text: lineText(sourceFile, line).trim(),
          label: `parallel caption authoring ${memberKind} "${propName}" on ${node.name.text}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// --- Rule 2: forbidden parallel caption-schema declarations ---

const FORBIDDEN_SCHEMA_NAMES: ReadonlySet<string> = new Set([
  'Caption',
  'PrompterCaption',
  'PrompterCaptionSchema',
  'CaptionSchema',
  'CaptionError',
  'CaptionAuthoring',
  'PrompterAuthoring',
  'CaptionInput',
  'CaptionDTO',
]);

// The canonical declaration site for each forbidden name (if any). A
// declaration of `name` at `path` whose `kind` is in `allowedKinds`
// is exempt — that IS the canonical declaration the rule is
// protecting. Every other declaration kind, AND every declaration at
// any other path, is flagged.
//
// Codex review cycle 2 (`Caption` blind spot): the prior rule omitted
// `Caption` itself, so `src/runtime/other.ts` could declare a parallel
// `Caption` interface and pass. The rule became path-sensitive.
//
// Codex review cycle 3 (canonical-path exemption was too broad): the
// path-sensitive exemption allowed ANY declaration named `Caption` at
// `src/runtime/scene.ts`, including value-level forms
// (`const Caption = z.object(...)`, `class Caption {}`). The canonical
// declaration is the `interface Caption` shape; the exemption is now
// scoped to that shape (interface + type alias). Value-level
// `Caption` is the same parallel-surface hazard at the canonical path
// as anywhere else.
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

const CANONICAL_DECLARATION_PATHS: ReadonlyMap<string, CanonicalDeclarationRule> = new Map([
  [
    'Caption',
    {
      path: 'src/runtime/scene.ts',
      allowedKinds: new Set<DeclarationKind>(['interface', 'type']),
    },
  ],
]);

// The preflight bans "a second schema, parser, validator, exception
// hierarchy, logging surface, persistence layer, workflow controller,
// or prompter repository for captions." Type-level declarations
// (`interface` / `type`) are one form, but the same forbidden names
// can also land as VALUE-level declarations — `const CaptionSchema =
// z.object(...)`, `class CaptionError extends Error`, `function
// CaptionSchema(...) { ... }`, `enum CaptionInput { ... }` — or as
// destructured bindings in `const { CaptionSchema } = somewhere`. The
// visitor below classifies every declaration-introducing form onto
// one rule table so renaming the storage shape cannot escape the
// gate.
function scanForbiddenSchemas(sourceFile: ts.SourceFile): readonly SourceFinding[] {
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const findings: SourceFinding[] = [];
  const record = (node: ts.Node, declName: string, kind: DeclarationKind): void => {
    if (!FORBIDDEN_SCHEMA_NAMES.has(declName)) return;
    // Path- AND kind-aware exemption for canonical declarations
    // (e.g., the canonical `Caption` INTERFACE/TYPE lives in
    // `src/runtime/scene.ts`; a value-level `Caption` even at that
    // path is still a parallel-surface hazard). Match on either the
    // exact stored path OR a path ending in `/` + the canonical
    // path so absolute-path callers behave identically to
    // repo-relative-path callers — the same idiom the existing
    // `isInBoundary` helper in `source-policy.ts` uses.
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
      label: `parallel caption-schema ${kind} "${declName}" (PUL-A009)`,
    });
  };
  // Walk a binding pattern (object / array destructuring) and record
  // every local identifier whose name is in the forbidden set. Codex
  // review cycle 2 (class finding): `const { CaptionSchema } =
  // external` introduces a local `CaptionSchema` binding whose
  // underlying declaration lives outside `src/`; without this walk
  // a forbidden surface could land via destructuring and pass the
  // gate.
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
  // ...)`) and record every binding the list introduces. Codex review
  // cycle 3: the prior visitor only handled `VariableStatement`, so
  // a forbidden binding in a `for (const CaptionSchema of schemas)`
  // header would slip through. Classifying loop-header declarations
  // identically catches the regression.
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
      // Loop-header variable declarations: `for (const X of ...)`,
      // `for (let X in ...)`, `for (var X = ...; ...; ...)`. Codex
      // review cycle 3 — non-statement variable declarations.
      walkVariableDeclarationList(node.initializer);
    } else if (
      ts.isImportDeclaration(node) &&
      node.importClause !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      // `import { CaptionSchema } from '@pkg/captions'` introduces a
      // local `CaptionSchema` binding from a source outside `src/**`.
      // Codex review cycle 3 (one-off): import specifiers are local
      // bindings of exactly the same character as destructuring;
      // both routes around `src/` source-policy scanning need to be
      // gated together. Default and namespace import shapes are
      // handled the same way (`clause.name` and the
      // `NamespaceImport` binding's `name`, respectively).
      //
      // Canonical-source exemption: an import of a forbidden name
      // whose specifier path-resolves to that name's canonical
      // declaration path is the CONSUMER-side of the canonical
      // declaration and must be allowed (otherwise every legitimate
      // consumer of `Caption` flagged itself). The resolution walks
      // `path.posix.join(dirname(sourceFile), specifier)` and
      // compares the result + `.ts` extension against the canonical
      // path either exactly OR via endsWith — same idiom the
      // declaration-path exemption uses.
      const specifier = node.moduleSpecifier.text;
      const recordImport = (target: ts.Node, localName: string): void => {
        const canonical = CANONICAL_DECLARATION_PATHS.get(localName);
        if (canonical !== undefined) {
          const importingDir = pathPosix.dirname(sourceFile.fileName);
          const resolved = `${pathPosix.normalize(pathPosix.join(importingDir, specifier))}.ts`;
          const matchesCanonical =
            resolved === canonical.path || resolved.endsWith(`/${canonical.path}`);
          if (matchesCanonical) return;
        }
        record(target, localName, 'import');
      };
      const clause = node.importClause;
      if (clause.name !== undefined) {
        recordImport(clause, clause.name.text);
      }
      if (clause.namedBindings !== undefined) {
        const bindings = clause.namedBindings;
        if (ts.isNamespaceImport(bindings)) {
          recordImport(bindings, bindings.name.text);
        } else if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            recordImport(element, element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// --- Rule 3: Caption import boundary inside src/runtime/prompter.ts ---

const PROMPTER_PATH = 'src/runtime/prompter.ts';
const CAPTION_SCENE_SPECIFIER = './scene';

function scanPrompterCaptionImports(sourceFile: ts.SourceFile): readonly SourceFinding[] {
  // Only meaningful for `src/runtime/prompter.ts`; callers that pass a
  // different file get an empty list (the runtime-tree assertion below
  // calls this scanner only on the prompter file).
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const findings: SourceFinding[] = [];
  const record = (node: ts.Node, specifier: string, detailSuffix: string): void => {
    if (specifier === CAPTION_SCENE_SPECIFIER) return;
    const start = node.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    if (exempted.has(line)) return;
    findings.push({
      file: sourceFile.fileName,
      line: line + 1,
      text: lineText(sourceFile, line).trim(),
      label: `Caption imported from non-canonical specifier "${specifier}" in prompter module${detailSuffix}`,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause === undefined) {
        ts.forEachChild(node, visit);
        return;
      }
      // The rule flags any import shape that brings `Caption` into the
      // prompter module's identifier scope from a non-canonical source.
      // Four shapes can do that, all of them caught here:
      //   1. Default import `import Caption from '<spec>'` — the
      //      default-export side has no name; the LOCAL binding is
      //      `Caption`.
      //   2. Namespace import `import * as Caption from '<spec>'` —
      //      the LOCAL binding is `Caption` and references every
      //      export. (Unusual, but a perfectly valid Caption-shadowing
      //      vector.)
      //   3. Named import `import { Caption } from '<spec>'` — both
      //      the source and the local identifier are `Caption`.
      //   4. Aliased named import `import { Foo as Caption } from
      //      '<spec>'` or `import { Caption as Foo } from '<spec>'` —
      //      either the SOURCE identifier OR the LOCAL identifier is
      //      `Caption`. The hazard is symmetric: a non-canonical
      //      module exporting `Caption` (the local-shadow case) AND a
      //      non-canonical module's `Foo` re-bound locally as
      //      `Caption` (the source-rename case) both install a
      //      parallel authoring seam at the consumer.
      // Codex review cycle 1 (class finding): the earlier
      // source-identifier-only check missed shapes 1, 2, and the
      // local-alias half of shape 4.
      if (clause.name !== undefined && clause.name.text === 'Caption') {
        record(node, specifier, ' (default-import binding)');
      }
      if (clause.namedBindings !== undefined) {
        const bindings = clause.namedBindings;
        if (ts.isNamespaceImport(bindings) && bindings.name.text === 'Caption') {
          record(node, specifier, ' (namespace-import binding)');
        } else if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const localName = element.name.text;
            const sourceName = element.propertyName?.text ?? localName;
            if (sourceName !== 'Caption' && localName !== 'Caption') continue;
            const suffix =
              localName === 'Caption' && sourceName !== 'Caption'
                ? ' (local-alias binding)'
                : sourceName === 'Caption' && localName !== 'Caption'
                  ? ' (source identifier "Caption" aliased locally)'
                  : '';
            record(element, specifier, suffix);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// --- Rule 4: forbidden authoring fields on scene-module object literals ---
//
// Codex review cycle 1 (class finding): rule 1 only inspects the
// TypeScript `SceneModule` / `CompositionEntryOverride` INTERFACE
// declarations in `src/runtime/{scene,composition}.ts`. The actual
// authoring data lives in object literals under
// `src/scenes/**/*.ts` (and per-composition overrides under
// `src/compositions/**/*.ts`). Because `assertSceneModule()` does
// NOT reject unknown keys (preflight: no runtime implementation
// change for this requirement), a scene module export can carry a
// forbidden caption-shaped sibling field today and pass both the
// schema gate AND rule 1. Rule 4 closes the category at the
// authoring boundary by scanning every object literal that is
// annotated, asserted, or `satisfies`-bound as `SceneModule` or
// `CompositionEntryOverride`, flagging any property whose key
// resolves to a name in the same forbidden set rule 1 uses.

const SCENE_LIKE_TYPE_NAMES: ReadonlySet<string> = SCENE_LIKE_INTERFACES;
// Codex review cycle 3 (composition-manifest array entries): a
// `CompositionManifest` typing on an array binding implies every
// element of that array is a `CompositionEntryOverride` literal.
// Track the manifest-array type names so rule 4 can look up through
// the array boundary.
const COMPOSITION_MANIFEST_TYPE_NAMES: ReadonlySet<string> = new Set(['CompositionManifest']);
const SCENE_MODULE_AUTHORING_ROOTS: readonly string[] = ['scenes', 'compositions'];

/**
 * Resolve every type name a TypeNode structurally references. Returns
 * an array because intersection types (`SceneModule & Extra`) introduce
 * multiple references, any of which can identify the structural shape
 * the gate cares about (codex review cycle 3 — intersection-type
 * bypass). Wrappers (`parenthesized`, `as ... satisfies ...`) unwrap.
 * `null`-ish unsupported nodes return `[]`.
 *
 * The result is bounded to direct identifier-style references —
 * function types, union types, mapped types, etc. cannot statically
 * identify the canonical scene shape and conservatively return no
 * names.
 */
function getReferencedTypeNames(typeNode: ts.TypeNode | undefined): readonly string[] {
  if (typeNode === undefined) return [];
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return [typeNode.typeName.text];
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return getReferencedTypeNames(typeNode.type);
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    const names: string[] = [];
    for (const t of typeNode.types) {
      names.push(...getReferencedTypeNames(t));
    }
    return names;
  }
  return [];
}

/**
 * Convenience: the first identifier referenced by a TypeNode, or
 * `null` if none. Kept for callers that handle a single referenced
 * type name; multi-name callers (intersection-aware) use
 * `getReferencedTypeNames` directly.
 */
function getReferencedTypeName(typeNode: ts.TypeNode | undefined): string | null {
  const names = getReferencedTypeNames(typeNode);
  return names[0] ?? null;
}

/**
 * Collect file-local aliases for the canonical scene-shaped type names
 * (`SceneModule`, `CompositionEntryOverride`) AND the composition-
 * manifest array type (`CompositionManifest`). Three alias sources are
 * honored, matching the adjacent PUL-A008 alias collector (codex review
 * cycle 2 class finding — scene-shaped detection missed type aliases
 * and aliased imports):
 *
 *   1. `import { SceneModule as Module } from '...'` — Module is an
 *      alias for SceneModule for the rest of the file.
 *   2. `type Module = SceneModule` — alias declaration.
 *   3. Intersection-type aliases — `type X = SceneModule & Extra`
 *      classifies X as a scene-shaped binding (codex review cycle 3).
 *
 * Chained aliases (`type A = SceneModule; type B = A;`) resolve via
 * fixed-point iteration; out-of-order declarations work too.
 *
 * Returns a map of LOCAL identifier name → canonical type name. The
 * canonical names themselves map to themselves so callers can do one
 * lookup instead of a membership-then-alias-lookup dance.
 */
function collectSceneShapedAliases(sourceFile: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const canonical of SCENE_LIKE_TYPE_NAMES) {
    aliases.set(canonical, canonical);
  }
  for (const canonical of COMPOSITION_MANIFEST_TYPE_NAMES) {
    aliases.set(canonical, canonical);
  }

  // 1) Named imports — `import { SceneModule as X } from '...'`
  //    or `import { SceneModule } from '...'`. The SOURCE identifier
  //    is what we match against the canonical set; the LOCAL
  //    identifier (alias or same name) is the file-local handle.
  const visitImports = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause !== undefined) {
      const clause = node.importClause;
      if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const sourceName = element.propertyName?.text ?? element.name.text;
          if (
            SCENE_LIKE_TYPE_NAMES.has(sourceName) ||
            COMPOSITION_MANIFEST_TYPE_NAMES.has(sourceName)
          ) {
            aliases.set(element.name.text, sourceName);
          }
        }
      }
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(sourceFile);

  // 2) Type-alias declarations — `type X = SceneModule`. Chained
  //    aliases resolve via fixed-point iteration. Intersection types
  //    walk every branch so `type X = SceneModule & Extra` classifies
  //    X as scene-shaped (codex review cycle 3).
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
    for (const referenced of getReferencedTypeNames(alias.init)) {
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

  return aliases;
}

/**
 * Resolve `typeNode` to its canonical scene-shaped name by walking the
 * alias map collected per-file. Returns the canonical name (one of
 * `SceneModule`, `CompositionEntryOverride`, `CompositionManifest`)
 * when any branch resolves, or `null` for unrelated types.
 *
 * Intersection types resolve to the first scene-shaped branch — the
 * gate's contract is "the literal is structurally bound to a
 * scene-shaped type," and ANY intersection branch satisfying that is
 * sufficient.
 */
function resolveSceneShapedType(
  typeNode: ts.TypeNode | undefined,
  aliases: ReadonlyMap<string, string>,
): string | null {
  for (const name of getReferencedTypeNames(typeNode)) {
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
 * name. Codex review cycles 2 and 3 expanded this set:
 *
 *   - `const x: SceneModule = { ... }` — the parent `VariableDeclaration`
 *     has `type` referencing the scene-shaped type.
 *   - `({ ... }) as SceneModule` — `AsExpression` whose `type`
 *     references the scene-shaped type. Parentheses around the
 *     literal (`(literal) as X`) are transparent.
 *   - `({ ... }) satisfies SceneModule` — `SatisfiesExpression`.
 *   - `<SceneModule>{ ... }` — legacy `TypeAssertionExpression`.
 *   - **Composition-manifest array entries** (codex review cycle 3 —
 *     `const m: CompositionManifest = [{ id, script }]`). When an
 *     object literal sits inside an `ArrayLiteralExpression` whose own
 *     enclosing binding resolves to `CompositionManifest`, every
 *     element is a `CompositionEntryOverride`. The array binding may
 *     be a direct variable initializer, an `as` cast, or a
 *     `satisfies` expression.
 *   - **Function-return SceneModule** (codex review cycle 3 — `function
 *     makeScene(): SceneModule { return { ... } }`). When the literal
 *     is the operand of a `ReturnStatement` whose enclosing function-
 *     like declaration has a return type resolving to a scene-shaped
 *     name, the literal is scene-shaped.
 *   - Arrow-function expression body `(): SceneModule => ({...})`.
 *
 * Intersection types (`SceneModule & Extra`) are honored at every
 * level above through `resolveSceneShapedType`. Parenthesized
 * wrappers are transparent via `getEffectiveParent` + `unwrapParens`
 * (test-quality review cycle 1 — `({literal}) as X` form had no
 * coverage and exposed a wrong implementation of paren handling).
 */
function isSceneShapedObjectLiteral(
  objectLiteral: ts.ObjectLiteralExpression,
  aliases: ReadonlyMap<string, string>,
): boolean {
  const parent = getEffectiveParent(objectLiteral);
  if (parent === undefined) return false;
  // Direct binding shapes — the literal IS the operand (after
  // unwrapping any parens) of an `as` / `satisfies` /
  // `<Type>literal` / variable initializer.
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer !== undefined &&
    unwrapParens(parent.initializer) === objectLiteral
  ) {
    return resolveSceneShapedType(parent.type, aliases) !== null;
  }
  if (ts.isAsExpression(parent) && unwrapParens(parent.expression) === objectLiteral) {
    return resolveSceneShapedType(parent.type, aliases) !== null;
  }
  if (ts.isSatisfiesExpression(parent) && unwrapParens(parent.expression) === objectLiteral) {
    return resolveSceneShapedType(parent.type, aliases) !== null;
  }
  if (ts.isTypeAssertionExpression(parent) && unwrapParens(parent.expression) === objectLiteral) {
    return resolveSceneShapedType(parent.type, aliases) !== null;
  }
  // Array-entry shape: `const m: CompositionManifest = [{ id, script }]`.
  // The literal's effective parent is `ArrayLiteralExpression`; its
  // enclosing binding may be a direct variable initializer, an `as`
  // cast, or a `satisfies` expression. All three resolve through the
  // same alias map check.
  if (ts.isArrayLiteralExpression(parent)) {
    const arrayBinding = getEffectiveParent(parent);
    if (arrayBinding === undefined) return false;
    if (
      ts.isVariableDeclaration(arrayBinding) &&
      arrayBinding.initializer !== undefined &&
      unwrapParens(arrayBinding.initializer) === parent
    ) {
      return resolveSceneShapedType(arrayBinding.type, aliases) === 'CompositionManifest';
    }
    if (ts.isAsExpression(arrayBinding) && unwrapParens(arrayBinding.expression) === parent) {
      return resolveSceneShapedType(arrayBinding.type, aliases) === 'CompositionManifest';
    }
    if (
      ts.isSatisfiesExpression(arrayBinding) &&
      unwrapParens(arrayBinding.expression) === parent
    ) {
      return resolveSceneShapedType(arrayBinding.type, aliases) === 'CompositionManifest';
    }
    return false;
  }
  // Function-return shape: walk up from a `ReturnStatement` (or an
  // arrow function whose body is an expression) to the enclosing
  // function-like declaration; check its declared return type.
  // Captures `function makeScene(): SceneModule { return { ... } }`
  // and arrow `(): SceneModule => ({ ... })`.
  if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) {
    let cursor: ts.Node | undefined = parent;
    while (cursor !== undefined) {
      if (
        ts.isFunctionDeclaration(cursor) ||
        ts.isFunctionExpression(cursor) ||
        ts.isMethodDeclaration(cursor) ||
        ts.isArrowFunction(cursor)
      ) {
        const fn = cursor as ts.SignatureDeclaration;
        return resolveSceneShapedType(fn.type, aliases) !== null;
      }
      cursor = cursor.parent;
    }
  }
  return false;
}

function scanForbiddenSceneObjectFields(sourceFile: ts.SourceFile): readonly SourceFinding[] {
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const aliases = collectSceneShapedAliases(sourceFile);
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
    if (ts.isObjectLiteralExpression(node) && isSceneShapedObjectLiteral(node, aliases)) {
      for (const property of node.properties) {
        // Codex review cycle 2 (one-off — spread can smuggle
        // forbidden authoring fields): a `SpreadAssignment` carries
        // an opaque source whose keys we cannot statically classify
        // without resolving and re-walking the spread target. We
        // structurally ban spreads in scene-shaped literals; an
        // author who needs composition can spell the keys out or
        // use the line-allow exemption.
        if (ts.isSpreadAssignment(property)) {
          recordOn(
            property,
            'spread in scene-module object literal — caption-authoring vector cannot be statically classified',
          );
          continue;
        }
        // Codex review cycle 3 (class finding — methods bypass the
        // gate): a `prompterScript() { ... }` method on a scene-
        // shaped literal is the same parallel-authoring surface as
        // `prompterScript: () => ...` because `assertSceneModule()`
        // accepts unknown keys. Method declarations are now in
        // scope.
        if (
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property) ||
          ts.isMethodDeclaration(property)
        ) {
          // Codex review cycle 3 (one-off — opaque computed keys
          // bypass the same opacity rule that bans spreads): if the
          // property name is a `ComputedPropertyName` whose
          // expression is NOT a static literal, the key cannot be
          // statically classified. By the same logic that bans
          // spreads, we ban opaque computed keys in scene-shaped
          // literals.
          if (ts.isComputedPropertyName(property.name)) {
            const expr = property.name.expression;
            if (!ts.isStringLiteralLike(expr)) {
              recordOn(
                property,
                'opaque computed key in scene-module object literal — caption-authoring vector cannot be statically classified',
              );
              continue;
            }
          }
          const propName = getStaticPropertyName(property.name);
          if (propName === undefined) continue;
          if (!FORBIDDEN_SCENE_FIELDS.has(propName)) continue;
          const memberKind = ts.isMethodDeclaration(property) ? 'method' : 'field';
          recordOn(
            property,
            `parallel caption authoring ${memberKind} "${propName}" on scene-module object literal`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
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

function rule3FindingsOf(source: string): readonly SourceFinding[] {
  return scanPrompterCaptionImports(parseSource(source, PROMPTER_PATH));
}

function rule4FindingsOf(
  source: string,
  file = 'src/scenes/fake-scene.ts',
): readonly SourceFinding[] {
  return scanForbiddenSceneObjectFields(parseSource(source, file));
}

// --- Tests -----------------------------------------------------------

describe('PUL-A009 — captions / prompter single source (source scan)', () => {
  describe('rule 1 — forbidden authoring fields on SceneModule / CompositionEntryOverride', () => {
    it.each([
      ['prompterCaptions'],
      ['prompterScript'],
      ['prompterText'],
      ['teleprompter'],
      ['captionOverrides'],
      ['script'],
      ['notes'],
    ])('flags `%s` on the SceneModule interface', (field) => {
      const src = [
        'export interface SceneModule {',
        '  id: string;',
        `  ${field}: readonly { at: number; text: string }[];`,
        '  captions: readonly { at: number; text: string }[];',
        '}',
      ].join('\n');
      const findings = rule1FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(`parallel caption authoring field "${field}" on SceneModule`);
      expect(findings[0]?.line).toBe(3);
    });

    it.each([['prompterCaptions'], ['captionOverrides'], ['script'], ['notes']])(
      'flags `%s` on the CompositionEntryOverride interface',
      (field) => {
        const src = [
          'export interface CompositionEntryOverride {',
          '  readonly id: string;',
          `  readonly ${field}?: readonly { at: number; text: string }[];`,
          '}',
        ].join('\n');
        const findings = rule1FindingsOf(src, 'src/runtime/composition.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.label).toBe(
          `parallel caption authoring field "${field}" on CompositionEntryOverride`,
        );
      },
    );

    it('does NOT flag the canonical `captions: readonly Caption[]` field on SceneModule', () => {
      const src = [
        'export interface SceneModule {',
        '  id: string;',
        '  captions: readonly { at: number; text: string }[];',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag unrelated SceneModule fields (`assets`, `audio`, `tags`)', () => {
      const src = [
        'export interface SceneModule {',
        '  id: string;',
        '  tags: readonly string[];',
        '  assets: readonly string[];',
        '  audio: readonly string[];',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag a forbidden field name on an UNRELATED interface', () => {
      // The rule's contract is "no parallel authoring source on the
      // scene-module / composition-entry surfaces." A `script` field
      // on a router config, a test fixture, or a totally unrelated
      // type is out of scope. Scoping the scan to the two named
      // interfaces is what makes the gate false-positive-resistant.
      const src = [
        'export interface VideoExportPlan {',
        '  script: string;',
        '  notes: string;',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toEqual([]);
    });

    it('flags forbidden field names declared as METHOD signatures', () => {
      // Codex review cycle 3 (class finding): `SceneModule` accepts
      // unknown keys at the value level, so a `script(ctx): void`
      // method on the interface is structurally the same parallel
      // authoring surface as `script: () => void`. Both forms add a
      // property whose name is in the forbidden set; the scanner
      // now flags both.
      const src = ['export interface SceneModule {', '  script(ctx: unknown): void;', '}'].join(
        '\n',
      );
      const findings = rule1FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel caption authoring method "script" on SceneModule');
    });

    it('honors `// PUL-A009-allow: <reason>` on the offending line', () => {
      const src = [
        'export interface SceneModule {',
        '  id: string;',
        '  prompterCaptions: readonly { at: number; text: string }[]; // PUL-A009-allow: experimental, gated',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toEqual([]);
    });

    it('rejects an empty allow-tag rationale', () => {
      const src = [
        'export interface SceneModule {',
        '  id: string;',
        '  prompterCaptions: readonly unknown[]; // PUL-A009-allow:',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toHaveLength(1);
    });

    it('rejects an allow-tag hidden inside a string literal', () => {
      const src = [
        'const note = "PUL-A009-allow: not a real exemption";',
        'export interface SceneModule {',
        '  prompterCaptions: readonly unknown[];',
        '}',
      ].join('\n');
      expect(rule1FindingsOf(src)).toHaveLength(1);
    });

    it('flags every forbidden field independently in a multi-field declaration', () => {
      const src = [
        'export interface SceneModule {',
        '  prompterCaptions: readonly unknown[];',
        '  captionOverrides: readonly unknown[];',
        '  script: string;',
        '}',
      ].join('\n');
      const findings = rule1FindingsOf(src);
      expect(findings).toHaveLength(3);
      expect(findings.map((f) => f.label)).toEqual([
        'parallel caption authoring field "prompterCaptions" on SceneModule',
        'parallel caption authoring field "captionOverrides" on SceneModule',
        'parallel caption authoring field "script" on SceneModule',
      ]);
    });

    // Codex review cycle 2 (class finding — computed-key bypass).
    // `interface SceneModule { ['prompterCaptions']: ... }` would
    // resolve at runtime to the same forbidden key but escape an
    // identifier-only name extractor. The visitor now resolves
    // computed property names whose inner expression is a static
    // string literal.
    it.each([
      ["['prompterCaptions']", 'prompterCaptions'],
      ['[`script`]', 'script'],
      ["['captionOverrides']", 'captionOverrides'],
    ])('flags computed-string-literal key `%s` on SceneModule', (key, fieldName) => {
      const src = ['export interface SceneModule {', `  ${key}: readonly unknown[];`, '}'].join(
        '\n',
      );
      const findings = rule1FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        `parallel caption authoring field "${fieldName}" on SceneModule`,
      );
    });
  });

  describe('rule 2 — forbidden parallel caption-schema declarations', () => {
    it.each([
      ['interface', 'PrompterCaption'],
      ['interface', 'PrompterCaptionSchema'],
      ['interface', 'CaptionSchema'],
      ['interface', 'CaptionError'],
      ['interface', 'CaptionAuthoring'],
      ['interface', 'PrompterAuthoring'],
      ['interface', 'CaptionInput'],
      ['interface', 'CaptionDTO'],
    ])('flags `%s %s { ... }`', (_kind, name) => {
      const src = `export interface ${name} { at: number; text: string }`;
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(`parallel caption-schema interface "${name}" (PUL-A009)`);
    });

    it.each([
      ['type', 'PrompterCaption'],
      ['type', 'CaptionSchema'],
      ['type', 'CaptionError'],
      ['type', 'CaptionDTO'],
    ])('flags `%s %s = ...`', (_kind, name) => {
      const src = `export type ${name} = { at: number; text: string };`;
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(`parallel caption-schema type "${name}" (PUL-A009)`);
    });

    it('does NOT flag the canonical `Caption` interface at `src/runtime/scene.ts`', () => {
      // Codex review cycle 2: `Caption` itself was missing from the
      // forbidden set, so a parallel `Caption` interface could live
      // outside `scene.ts` and pass. The rule is now path-sensitive:
      // forbid `Caption` everywhere except the canonical
      // declaration site.
      const src = 'export interface Caption { at: number; text: string }';
      expect(rule2FindingsOf(src, 'src/runtime/scene.ts')).toEqual([]);
    });

    it('flags a parallel `Caption` interface declared OUTSIDE `src/runtime/scene.ts`', () => {
      const src = 'export interface Caption { at: number; text: string }';
      const findings = rule2FindingsOf(src, 'src/runtime/shadow-captions.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel caption-schema interface "Caption" (PUL-A009)');
    });

    it('flags a parallel value-level `Caption` declared OUTSIDE `src/runtime/scene.ts`', () => {
      const src = 'const Caption = { parse: (v: unknown) => v };';
      const findings = rule2FindingsOf(src, 'src/runtime/other.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel caption-schema const "Caption" (PUL-A009)');
    });

    it('canonical-path exemption works with absolute paths too', () => {
      // The scanner is sometimes invoked with absolute paths (the
      // runtime-tree assertion converts to repo-relative, but
      // self-tests through `rule2FindingsOf` synthesize a path
      // string). The exemption suffix-matches `/src/runtime/scene.ts`
      // so an absolute caller behaves identically.
      const src = 'export interface Caption { at: number; text: string }';
      expect(rule2FindingsOf(src, '/home/user/repo/src/runtime/scene.ts')).toEqual([]);
    });

    it.each([
      ['const', 'const Caption = { parse: (v: unknown) => v };'],
      ['class', 'class Caption {}'],
      ['function', 'function Caption(v: unknown) { return v; }'],
      ['enum', "enum Caption { A = 'a' }"],
    ])(
      'flags value-level `%s Caption` even at the canonical `src/runtime/scene.ts` path',
      (kind, source) => {
        // Codex review cycle 3 (one-off): the canonical-path
        // exemption is now KIND-scoped. Only `interface Caption`
        // and `type Caption = ...` are allowed at the canonical
        // path; any value-level declaration (`const`/`class`/
        // `function`/`enum`/destructured) named `Caption` even at
        // the canonical path is still a parallel-surface hazard.
        const findings = rule2FindingsOf(source, 'src/runtime/scene.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.label).toBe(`parallel caption-schema ${kind} "Caption" (PUL-A009)`);
      },
    );

    it('allows `type Caption = ...` at the canonical path (interface OR type)', () => {
      // The exemption's allowed-kind set is `{ interface, type }` —
      // both type-level declarations are honored.
      const src = 'export type Caption = { at: number; text: string };';
      expect(rule2FindingsOf(src, 'src/runtime/scene.ts')).toEqual([]);
    });

    // Codex review cycle 3 (one-off): import bindings introduce a
    // local handle to a forbidden name from outside `src/`. The
    // visitor now treats them the same way as `VariableStatement`
    // and destructured bindings.
    it("flags `import { CaptionSchema } from '@pkg/captions'` (named import binding)", () => {
      const src = "import { CaptionSchema } from '@pkg/captions';";
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel caption-schema import "CaptionSchema" (PUL-A009)');
    });

    it("flags `import CaptionError from '@pkg/captions'` (default import binding)", () => {
      const src = "import CaptionError from '@pkg/captions';";
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel caption-schema import "CaptionError" (PUL-A009)');
    });

    it("flags `import * as CaptionDTO from '@pkg/captions'` (namespace import binding)", () => {
      const src = "import * as CaptionDTO from '@pkg/captions';";
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel caption-schema import "CaptionDTO" (PUL-A009)');
    });

    it('flags `import { Sym as CaptionSchema }` (locally aliased import)', () => {
      const src = "import { Sym as CaptionSchema } from '@pkg/captions';";
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel caption-schema import "CaptionSchema" (PUL-A009)');
    });

    it("does NOT flag a canonical `import { Caption } from './scene'` in another runtime module", () => {
      // Consumer-side of the canonical declaration: the importing
      // module brings `Caption` into scope from the canonical
      // declaration site. Path-resolves to
      // `src/runtime/scene.ts`, so the exemption activates.
      const src = "import { Caption } from './scene';";
      expect(rule2FindingsOf(src, 'src/runtime/prompter.ts')).toEqual([]);
    });

    it("does NOT flag canonical `import { Caption } from '../runtime/scene'` (deeper consumer)", () => {
      const src = "import { Caption } from '../runtime/scene';";
      expect(rule2FindingsOf(src, 'src/scenes/foo.ts')).toEqual([]);
    });

    it("flags `import { Caption } from './shadow-module'` (non-canonical specifier)", () => {
      const src = "import { Caption } from './shadow-module';";
      const findings = rule2FindingsOf(src, 'src/runtime/prompter.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe('parallel caption-schema import "Caption" (PUL-A009)');
    });

    it.each([
      // Test-quality review cycle 1 (warning): tighten partial
      // string predicates to exact `toBe` matches so a
      // misclassified loop-variable kind (e.g., `const` reported
      // for a classic-for `let` initializer) fails the test
      // instead of silently shipping the wrong diagnostic.
      [
        'for-of',
        'for (const CaptionSchema of [1]) { void CaptionSchema; }',
        'parallel caption-schema const "CaptionSchema" (PUL-A009)',
      ],
      [
        'for-in',
        'for (const CaptionSchema in {}) { void CaptionSchema; }',
        'parallel caption-schema const "CaptionSchema" (PUL-A009)',
      ],
      [
        'for-classic',
        'for (let CaptionSchema = 0; CaptionSchema < 1; CaptionSchema++) { void CaptionSchema; }',
        'parallel caption-schema let "CaptionSchema" (PUL-A009)',
      ],
    ])(
      'flags a forbidden binding inside a `%s` loop header',
      (_loopKind, source, expectedLabel) => {
        // Codex review cycle 3 (one-off): non-statement variable
        // declarations (`for (const X of ...)`, `for (let X = 0; ...)`)
        // bind the same local-scope identifier as
        // `VariableStatement`. The visitor now classifies them on
        // the rule table identically with the correct kind.
        const findings = rule2FindingsOf(source);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.label).toBe(expectedLabel);
      },
    );

    it.each([
      ['PrompterScript'],
      ['PrompterScriptEntry'],
      ['PrompterRenderer'],
      ['PrompterDispose'],
    ])('does NOT flag the canonical derivation output type `%s`', (name) => {
      const src = `export interface ${name} { x: string }`;
      expect(rule2FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag a forbidden name appearing in a STRING literal or comment', () => {
      const src = [
        '// PrompterCaption is forbidden by PUL-A009',
        'const note = "PrompterCaption";',
      ].join('\n');
      expect(rule2FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag a forbidden name USED but not DECLARED (variable annotation only)', () => {
      // A variable `const x: PrompterCaption = ...` is a USE site,
      // not a DECLARATION site. The rule's contract is "no parallel
      // schema DECLARATION" — a use can only resolve if a
      // declaration exists somewhere, and the declaration is what
      // the rule catches. Pinning this prevents over-reach.
      const src = ['declare const x: PrompterCaption;', 'export { x };'].join('\n');
      expect(rule2FindingsOf(src)).toEqual([]);
    });

    it('honors `// PUL-A009-allow: <reason>` on the declaration line', () => {
      const src =
        'export interface PrompterCaption { at: number; text: string } // PUL-A009-allow: serialization-format proposal under review';
      expect(rule2FindingsOf(src)).toEqual([]);
    });

    it('flags both an interface AND a type with the same forbidden name', () => {
      // Two declaration kinds in one file: both must be flagged so
      // a half-rename regression doesn't slip through.
      const src = [
        'export interface PrompterCaption { at: number }',
        'export type CaptionSchema = { at: number };',
      ].join('\n');
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(2);
      expect(findings.map((f) => f.label)).toEqual([
        'parallel caption-schema interface "PrompterCaption" (PUL-A009)',
        'parallel caption-schema type "CaptionSchema" (PUL-A009)',
      ]);
    });

    // Codex review cycle 1 (class finding): the type-level pass
    // alone leaves value-level declarations of the same forbidden
    // names unguarded. A `const CaptionSchema = z.object(...)` or
    // `class CaptionError extends Error` would silently install a
    // parallel runtime schema / exception type. The visitor now
    // classifies all six declaration kinds onto the rule table.
    it.each([
      ['const', 'PrompterCaption', "const PrompterCaption = { at: 0, text: '' };"],
      ['const', 'CaptionSchema', 'const CaptionSchema = { parse: (v: unknown) => v };'],
      ['const', 'CaptionInput', 'const CaptionInput = Symbol("CaptionInput");'],
      ['let', 'CaptionError', 'let CaptionError: Error | undefined = undefined;'],
      ['var', 'CaptionDTO', 'var CaptionDTO = null;'],
    ])('flags value-level `%s %s = ...`', (kind, name, source) => {
      const findings = rule2FindingsOf(source);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(`parallel caption-schema ${kind} "${name}" (PUL-A009)`);
    });

    it.each([
      ['class', 'CaptionError', 'export class CaptionError extends Error {}'],
      ['class', 'PrompterCaption', 'export class PrompterCaption { at = 0; text = ""; }'],
      ['function', 'CaptionSchema', 'export function CaptionSchema(v: unknown) { return v; }'],
      ['function', 'CaptionInput', 'export function CaptionInput() { return null; }'],
      ['enum', 'CaptionInput', "export enum CaptionInput { A = 'a', B = 'b' }"],
    ])('flags `%s %s ...`', (kind, name, source) => {
      const findings = rule2FindingsOf(source);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(`parallel caption-schema ${kind} "${name}" (PUL-A009)`);
    });

    it('flags every forbidden value-level declaration independently', () => {
      const src = [
        'const CaptionSchema = { parse: (v: unknown) => v };',
        'class CaptionError extends Error {}',
        'function CaptionInput() { return null; }',
      ].join('\n');
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(3);
      expect(findings.map((f) => f.label)).toEqual([
        'parallel caption-schema const "CaptionSchema" (PUL-A009)',
        'parallel caption-schema class "CaptionError" (PUL-A009)',
        'parallel caption-schema function "CaptionInput" (PUL-A009)',
      ]);
    });

    it('flags `const { CaptionSchema } = source` (destructured local binding)', () => {
      // Codex review cycle 2 (class finding): destructuring
      // introduces a LOCAL binding with the forbidden name; the
      // underlying source may live outside `src/**/*.ts` (external
      // module, generated code, inline factory), so the underlying
      // declaration is not reachable from the scanner. The local
      // binding is the parallel-surface vector the gate must close.
      const src = [
        'declare const source: { CaptionSchema: unknown };',
        'const { CaptionSchema } = source;',
        'export { CaptionSchema };',
      ].join('\n');
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption-schema destructured "CaptionSchema" (PUL-A009)',
      );
    });

    it('flags `const [CaptionDTO] = makeSchemas()` (array destructured local binding)', () => {
      const src = [
        'declare const makeSchemas: () => unknown[];',
        'const [CaptionDTO] = makeSchemas();',
        'export { CaptionDTO };',
      ].join('\n');
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption-schema destructured "CaptionDTO" (PUL-A009)',
      );
    });

    it('flags nested destructuring `const { sub: { CaptionError } } = source`', () => {
      const src = [
        'declare const source: { sub: { CaptionError: unknown } };',
        'const { sub: { CaptionError } } = source;',
        'export { CaptionError };',
      ].join('\n');
      const findings = rule2FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption-schema destructured "CaptionError" (PUL-A009)',
      );
    });

    it('does NOT flag destructuring when the LOCAL binding is a non-forbidden name', () => {
      // `const { CaptionSchema: localAlias } = source` reads the
      // forbidden property name from `source` but binds it locally
      // as `localAlias` — that local binding is not a parallel
      // surface. The contract is "no local parallel-schema binding."
      const src = [
        'declare const source: { CaptionSchema: unknown };',
        'const { CaptionSchema: localAlias } = source;',
        'export { localAlias };',
      ].join('\n');
      expect(rule2FindingsOf(src)).toEqual([]);
    });
  });

  describe('rule 3 — Caption import boundary in src/runtime/prompter.ts', () => {
    it("does NOT flag the canonical `import type { Caption, SceneModule } from './scene'`", () => {
      const src = "import type { Caption, SceneModule } from './scene';";
      expect(rule3FindingsOf(src)).toEqual([]);
    });

    it("flags `import { Caption } from '../other-module'`", () => {
      // Source identifier === local identifier === Caption: no
      // alias-direction suffix.
      const src = "import { Caption } from '../other-module';";
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'Caption imported from non-canonical specifier "../other-module" in prompter module',
      );
    });

    it("flags `import type { Caption } from '../other-module'`", () => {
      const src = "import type { Caption } from '../other-module';";
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'Caption imported from non-canonical specifier "../other-module" in prompter module',
      );
    });

    it('flags `import { Foo as Caption }` (LOCAL alias rebinds to Caption)', () => {
      // Codex review cycle 1 (class finding): the prior rule only
      // checked the SOURCE identifier, so this shape — which is the
      // most-likely-to-slip-through alias smuggling form — went
      // undetected. `import { Foo as Caption }` rebinds the LOCAL
      // name to `Caption`, installing a Caption-shadowing seam at
      // the consumer even though the source identifier was
      // innocuous. The rule now flags either-side matches.
      const src = "import { Foo as Caption } from '../shadow-module';";
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'Caption imported from non-canonical specifier "../shadow-module" in prompter module (local-alias binding)',
      );
    });

    it('flags `import { Caption as MyCaption }` (SOURCE identifier is Caption)', () => {
      // Symmetric to the local-alias case: a non-canonical module
      // exporting `Caption` is still a parallel-source hazard even
      // when the local consumer renames it. The source-name match
      // produces a separate label suffix so the diagnostic
      // identifies which side of the alias tripped the gate.
      const src = "import { Caption as MyCaption } from '../shadow-module';";
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'Caption imported from non-canonical specifier "../shadow-module" in prompter module (source identifier "Caption" aliased locally)',
      );
    });

    it('flags default import `import Caption from "../shadow"`', () => {
      // A non-canonical module's default export bound locally as
      // `Caption` brings a Caption-shaped consumer into prompter
      // without any named-import surface for rule 3 to inspect.
      // Default-import bindings always set `clause.name.text` to
      // the local identifier — the gate flags when that local is
      // `Caption`.
      const src = "import Caption from '../shadow-module';";
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'Caption imported from non-canonical specifier "../shadow-module" in prompter module (default-import binding)',
      );
    });

    it('flags namespace import `import * as Caption from "../shadow"`', () => {
      // Even more exotic, but valid TypeScript: the local binding
      // `Caption` references the WHOLE module. Same hazard, same
      // gate.
      const src = "import * as Caption from '../shadow-module';";
      const findings = rule3FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'Caption imported from non-canonical specifier "../shadow-module" in prompter module (namespace-import binding)',
      );
    });

    it('does NOT flag a default import bound as a non-Caption local', () => {
      const src = "import OtherType from '../shadow-module';";
      expect(rule3FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag a non-Caption import from a non-canonical specifier', () => {
      const src = "import type { BehaviorOverride, SubRange } from './composition';";
      expect(rule3FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag a `Caption` import alongside other named imports from `./scene`', () => {
      const src = "import type { Caption, SceneModule } from './scene';";
      expect(rule3FindingsOf(src)).toEqual([]);
    });

    it('honors `// PUL-A009-allow: <reason>` on the import line', () => {
      const src =
        "import { Caption } from '../experimental/caption-fixture'; // PUL-A009-allow: test fixture for serialization-format proposal";
      expect(rule3FindingsOf(src)).toEqual([]);
    });
  });

  describe('rule 4 — forbidden authoring fields on scene-module object literals', () => {
    // Codex review cycle 1 (class finding): the interface-level scan
    // (rule 1) leaves the AUTHORING side — `src/scenes/**/*.ts`,
    // `src/compositions/**/*.ts` — unguarded because
    // `assertSceneModule()` does not reject unknown keys. Rule 4
    // scans every object literal annotated/asserted/satisfies-bound
    // as `SceneModule` or `CompositionEntryOverride` and flags
    // property keys that match the same forbidden set rule 1 uses.

    it.each([
      ['prompterCaptions'],
      ['prompterScript'],
      ['prompterText'],
      ['teleprompter'],
      ['captionOverrides'],
      ['script'],
      ['notes'],
    ])('flags `%s` on a `: SceneModule`-annotated variable declaration', (field) => {
      const src = [
        'declare const noop: (ctx: unknown) => void;',
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        "  title: 'Fake',",
        '  duration: null,',
        '  tags: [],',
        '  assets: [],',
        '  captions: [],',
        '  audio: [],',
        '  defaultNext: null,',
        '  standalone: true,',
        '  trailerSafe: false,',
        '  create: noop,',
        '  timeline: noop,',
        '  cleanup: noop,',
        `  ${field}: [],`,
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        `parallel caption authoring field "${field}" on scene-module object literal`,
      );
    });

    it('flags `prompterCaptions` on a `satisfies SceneModule` literal', () => {
      const src = [
        'declare const noop: (ctx: unknown) => void;',
        'export const myScene = {',
        "  id: 'fake',",
        '  prompterCaptions: [],',
        '} satisfies SceneModule;',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "prompterCaptions" on scene-module object literal',
      );
    });

    it('flags `captionOverrides` on an `as SceneModule` cast literal', () => {
      const src = [
        'export const myScene = ({',
        "  id: 'fake',",
        '  captionOverrides: [],',
        '} as SceneModule);',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "captionOverrides" on scene-module object literal',
      );
    });

    it('flags forbidden field on a `<SceneModule>{...}` legacy type assertion', () => {
      // Test-quality review cycle 1 (critical): the
      // `TypeAssertionExpression` branch (`<SceneModule>{ ... }`)
      // had no unit coverage. Without this test, removing the
      // branch would not fail any other case — a scene file could
      // ship a legacy-cast scene module with forbidden fields and
      // pass the gate silently. The legacy form is rare but valid
      // TypeScript (and historically common in older codebases);
      // covering it pins the structural defense regardless.
      const src = [
        'export const myScene = <SceneModule>{',
        "  id: 'fake',",
        '  prompterCaptions: [],',
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "prompterCaptions" on scene-module object literal',
      );
    });

    it('flags forbidden field when ONLY the literal is parenthesized: `({...}) as SceneModule`', () => {
      // Test-quality review cycle 1 (warning): the `as` cast tests
      // above produce `({ ... } as SceneModule)` where the LITERAL's
      // direct parent is `AsExpression`. The case where the parens
      // wrap only the literal — `({...}) as SceneModule` — produces
      // `AsExpression > ParenthesizedExpression > ObjectLiteralExpression`,
      // which exercises the `ParenthesizedExpression` walk in
      // `getEffectiveParent` + `unwrapParens`. The earlier
      // implementation here was structurally broken (recursive call
      // with a wrong-typed argument) and silently happened to do the
      // wrong thing; the rewrite + this test pin the contract.
      const src = [
        "export const myScene = ({ id: 'fake', captionOverrides: [] }) as SceneModule;",
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "captionOverrides" on scene-module object literal',
      );
    });

    it('flags forbidden field on `([...]) as CompositionManifest` (array `as`-cast)', () => {
      // Test-quality review cycle 1 (warning): the CompositionManifest
      // array-binding has three flavors (variable-init, `as`,
      // `satisfies`). The variable-init branch is covered by the
      // existing test above; this exercises the `as` branch.
      const src = [
        "export const m = ([{ id: 'fake-scene', script: 'override' }]) as CompositionManifest;",
      ].join('\n');
      const findings = rule4FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "script" on scene-module object literal',
      );
    });

    it('flags forbidden field on `[...] satisfies CompositionManifest` (array satisfies)', () => {
      // Test-quality review cycle 1 (warning): same as above for
      // the `satisfies` branch of the array-binding handler.
      const src = [
        "export const m = [{ id: 'fake-scene', prompterCaptions: [] }] satisfies CompositionManifest;",
      ].join('\n');
      const findings = rule4FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "prompterCaptions" on scene-module object literal',
      );
    });

    it('flags `script` on a `: CompositionEntryOverride`-annotated literal', () => {
      const src = [
        'export const entry: CompositionEntryOverride = {',
        "  id: 'fake-scene',",
        "  script: 'override',",
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "script" on scene-module object literal',
      );
    });

    it('does NOT flag the canonical `captions: ...` field on a scene-module literal', () => {
      const src = [
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        '  captions: [],',
        '};',
      ].join('\n');
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag a forbidden field name on an UNTYPED object literal', () => {
      // The rule's binding requirement is "annotated/asserted as
      // SceneModule." A plain `{ ... }` with no type binding is out
      // of scope — the actual hazard requires the runtime to treat
      // the literal as a scene module, which requires the type.
      const src = ['export const data = {', "  id: 'fake',", '  prompterCaptions: [],', '};'].join(
        '\n',
      );
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    it('does NOT flag a forbidden field name on a literal bound to an unrelated type', () => {
      const src = [
        'interface ExportPlan { id: string; script: string }',
        'export const plan: ExportPlan = {',
        "  id: 'plan',",
        "  script: 'hello',",
        '};',
      ].join('\n');
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    it('flags method-style properties (`script(ctx) { ... }`)', () => {
      // Codex review cycle 3 (class finding): symmetric to rule 1.
      // A method-style member is the same parallel authoring
      // surface as a value-style one — `assertSceneModule()`
      // accepts unknown keys at the value level. The scanner now
      // flags both shapes.
      const src = [
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        '  script(ctx: unknown) { void ctx; },',
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring method "script" on scene-module object literal',
      );
    });

    it('honors `// PUL-A009-allow: <reason>` on the offending property line', () => {
      const src = [
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        '  prompterCaptions: [], // PUL-A009-allow: gated experiment under ADR review',
        '};',
      ].join('\n');
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    it('flags every forbidden property independently in a multi-key literal', () => {
      const src = [
        'export const myScene: SceneModule = {',
        '  prompterCaptions: [],',
        '  captionOverrides: [],',
        "  script: 'override',",
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(3);
      expect(findings.map((f) => f.label)).toEqual([
        'parallel caption authoring field "prompterCaptions" on scene-module object literal',
        'parallel caption authoring field "captionOverrides" on scene-module object literal',
        'parallel caption authoring field "script" on scene-module object literal',
      ]);
    });

    // Codex review cycle 2 (class finding — scene-shaped detection
    // missed type aliases and aliased imports). `import { SceneModule
    // as Module }` rebinds the local name; `type Module = SceneModule`
    // declares an alias; either form should still bind a literal as
    // scene-shaped for the gate. The visitor now consults a file-
    // local alias map (same pattern as PUL-A008's literal-alias
    // collector).
    it('flags forbidden field via aliased import `import { SceneModule as Module }`', () => {
      const src = [
        "import type { SceneModule as Module } from '../runtime/scene';",
        'export const myScene = ({',
        "  id: 'fake',",
        '  prompterCaptions: [],',
        '} as Module);',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "prompterCaptions" on scene-module object literal',
      );
    });

    it('flags forbidden field via type-alias `type Module = SceneModule`', () => {
      const src = [
        'type Module = SceneModule;',
        'export const myScene: Module = {',
        "  id: 'fake',",
        '  prompterCaptions: [],',
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "prompterCaptions" on scene-module object literal',
      );
    });

    it('flags via chained type-alias `type A = SceneModule; type B = A`', () => {
      const src = [
        'type A = SceneModule;',
        'type B = A;',
        'export const myScene: B = {',
        "  id: 'fake',",
        '  captionOverrides: [],',
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "captionOverrides" on scene-module object literal',
      );
    });

    it('flags via aliased CompositionEntryOverride import', () => {
      const src = [
        "import type { CompositionEntryOverride as Override } from '../runtime/composition';",
        'export const entry: Override = {',
        "  id: 'fake-scene',",
        "  script: 'override',",
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "script" on scene-module object literal',
      );
    });

    // Codex review cycle 2 (one-off finding — spread can smuggle
    // forbidden authoring fields). Spread assignments inside a
    // scene-shaped literal cannot be statically classified without
    // resolving the spread source; the gate structurally bans the
    // construct in scene literals.
    it('flags `...extra` spread inside a SceneModule literal', () => {
      const src = [
        'declare const extra: { prompterCaptions: unknown[] };',
        'export const myScene: SceneModule = {',
        '  ...extra,',
        "  id: 'fake',",
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'spread in scene-module object literal — caption-authoring vector cannot be statically classified',
      );
    });

    it('flags a spread even when no forbidden keys are visible at the call site', () => {
      // The whole point: the source object of the spread is opaque
      // to a static scanner. The structural ban catches the vector
      // regardless of what the spread happens to expose today.
      const src = [
        'declare const safe: { id: string };',
        'export const myScene: SceneModule = {',
        '  ...safe,',
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'spread in scene-module object literal — caption-authoring vector cannot be statically classified',
      );
    });

    it('does NOT flag a spread INSIDE an unrelated (non-scene-shaped) literal', () => {
      const src = [
        'declare const extra: { prompterCaptions: unknown[] };',
        'export const config = { ...extra };',
      ].join('\n');
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    it('honors the line-allow tag on a spread', () => {
      const src = [
        'declare const extra: { id: string };',
        'export const myScene: SceneModule = {',
        '  ...extra, // PUL-A009-allow: spread from named helper, no caption fields',
        '};',
      ].join('\n');
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    // Codex review cycle 2 (class finding — computed-key bypass).
    // Both rule 1 (interface member name) and rule 4 (object-literal
    // property name) now resolve computed names whose inner
    // expression is a static string literal.
    it.each([
      ["['prompterCaptions']", 'prompterCaptions'],
      ['[`prompterCaptions`]', 'prompterCaptions'],
      ["['script']", 'script'],
      ['[`captionOverrides`]', 'captionOverrides'],
    ])('flags computed-string-literal key `%s` on a SceneModule literal', (key, fieldName) => {
      const src = [
        'export const myScene: SceneModule = {',
        "  id: 'fake',",
        `  ${key}: [],`,
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        `parallel caption authoring field "${fieldName}" on scene-module object literal`,
      );
    });

    it('flags opaque computed keys on scene-shaped literals (cannot be statically classified)', () => {
      // Codex review cycle 3 (one-off): the same opacity argument
      // that bans spreads applies to computed keys whose expression
      // is not a static literal. `{ [key]: [] }` could resolve to
      // any forbidden authoring slot at runtime — the gate cannot
      // statically classify it. Structurally ban; line-allow if
      // legitimate.
      const src = [
        'declare const key: string;',
        'export const myScene: SceneModule = {',
        '  [key]: [],',
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'opaque computed key in scene-module object literal — caption-authoring vector cannot be statically classified',
      );
    });

    it('honors the line-allow tag on an opaque computed key', () => {
      const src = [
        'declare const key: string;',
        'export const myScene: SceneModule = {',
        '  [key]: [], // PUL-A009-allow: dynamic-key authoring helper under review',
        '};',
      ].join('\n');
      expect(rule4FindingsOf(src)).toEqual([]);
    });

    // Codex review cycle 3 (one-off — composition-manifest array
    // entries): `const m: CompositionManifest = [{ id, script }]`
    // typing implies every entry is a `CompositionEntryOverride`.
    // The scanner walks up through the `ArrayLiteralExpression`
    // parent to detect this binding shape.
    it('flags forbidden field on a CompositionManifest array entry literal', () => {
      const src = [
        'export const m: CompositionManifest = [',
        "  { id: 'fake-scene', script: 'override' },",
        '];',
      ].join('\n');
      const findings = rule4FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "script" on scene-module object literal',
      );
    });

    it('flags via aliased CompositionManifest binding `import { CompositionManifest as Manifest }`', () => {
      const src = [
        "import type { CompositionManifest as Manifest } from '../runtime/composition';",
        'export const m: Manifest = [',
        "  { id: 'fake-scene', prompterCaptions: [] },",
        '];',
      ].join('\n');
      const findings = rule4FindingsOf(src, 'src/compositions/fake.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "prompterCaptions" on scene-module object literal',
      );
    });

    // Codex review cycle 3 (one-off — function-return SceneModule).
    // `function makeScene(): SceneModule { return { ... } }` and
    // arrow `(): SceneModule => ({ ... })` both produce a
    // scene-shaped value via the return type. The scanner walks up
    // to the enclosing function-like declaration to detect this
    // binding shape.
    it('flags forbidden field on a literal returned from `(): SceneModule`', () => {
      const src = [
        'export function makeScene(): SceneModule {',
        '  return {',
        "    id: 'fake',",
        '    prompterCaptions: [],',
        '  };',
        '}',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "prompterCaptions" on scene-module object literal',
      );
    });

    it('flags forbidden field on a literal returned from an arrow `(): SceneModule => ({ ... })`', () => {
      const src = [
        'export const makeScene = (): SceneModule => ({',
        "  id: 'fake',",
        '  captionOverrides: [],',
        '});',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "captionOverrides" on scene-module object literal',
      );
    });

    // Codex review cycle 3 (one-off — intersection types like
    // `SceneModule & Extra`). `getReferencedTypeNames` now walks
    // intersection branches.
    it('flags forbidden field on a `SceneModule & Extra` intersection-typed variable', () => {
      const src = [
        'interface Extra { customMeta: string }',
        'export const myScene: SceneModule & Extra = {',
        "  id: 'fake',",
        "  customMeta: 'meta',",
        '  prompterCaptions: [],',
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "prompterCaptions" on scene-module object literal',
      );
    });

    it('flags via type-alias of an intersection (`type X = SceneModule & Extra`)', () => {
      const src = [
        'interface Extra { customMeta: string }',
        'type X = SceneModule & Extra;',
        'export const myScene: X = {',
        "  id: 'fake',",
        "  customMeta: 'meta',",
        '  script: "value",',
        '};',
      ].join('\n');
      const findings = rule4FindingsOf(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(
        'parallel caption authoring field "script" on scene-module object literal',
      );
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('rule 1: zero forbidden authoring fields on `SceneModule` / `CompositionEntryOverride`', () => {
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
        'PUL-A009 forbids parallel caption-authoring fields on the scene-module / composition-entry surfaces. `SceneModule.captions` is the single authoring slot — sibling fields like `prompterCaptions`, `script`, `notes`, or `captionOverrides` constitute a separate authoring source for prompter content. Add a `// PUL-A009-allow: <reason>` exemption on the same line only for a deliberate, gated experiment.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });

    it('rule 2: zero forbidden parallel caption-schema declarations across `src/**/*.ts`', () => {
      const files = walkTsFiles(SRC_ROOT);
      const findings: SourceFinding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        findings.push(...scanForbiddenSchemas(parseSource(text, rel)));
      }
      const header =
        'PUL-A009 forbids declaring a parallel caption schema (`PrompterCaption`, `CaptionSchema`, `CaptionError`, `CaptionDTO`, etc.). The canonical `Caption` (in `src/runtime/scene.ts`) is the only authoring shape; the prompter consumes it structurally via `buildPrompterScript()`. Add a `// PUL-A009-allow: <reason>` exemption on the same line only when a serialization-format proposal is under review.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });

    it('rule 3: prompter module imports `Caption` only from `./scene`', () => {
      const prompter = join(REPO_ROOT, PROMPTER_PATH);
      expect(statSync(prompter).isFile()).toBe(true);
      const text = readFileSync(prompter, 'utf-8');
      const findings = scanPrompterCaptionImports(parseSource(text, PROMPTER_PATH));
      const header =
        'PUL-A009 pins the prompter module\'s caption seam at `import { Caption } from "./scene"`. A `Caption` import from any other specifier is a parallel-authoring-source vector. Add a `// PUL-A009-allow: <reason>` exemption on the same line only for a deliberate, gated test fixture.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });

    it('rule 4: zero forbidden caption-authoring fields on scene-module object literals under `src/scenes/` and `src/compositions/`', () => {
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
        'PUL-A009 forbids parallel caption-authoring fields on scene-module object literals (the actual authoring surface under `src/scenes/` and `src/compositions/`). `SceneModule.captions` is the single authoring slot; a sibling `prompterCaptions` / `script` / `notes` / `captionOverrides` on a `: SceneModule` or `satisfies SceneModule` literal is a separate authoring source even though `assertSceneModule()` accepts unknown keys. Add a `// PUL-A009-allow: <reason>` exemption on the same line only for a deliberate, gated experiment.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });
  });
});
