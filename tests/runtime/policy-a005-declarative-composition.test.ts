import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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

// PUL-A005 — Composition is declarative.
//
// Statement: "Compositions SHALL be expressed as declarative manifests
// of scene ids. The runtime SHALL NOT support imperative dispatch
// (e.g., `if/else` branching or position-based dispatch in a control
// script) as the source of truth for composition order."
//
// Enforcement: a Vitest source scan over `src/compositions/**/*.ts`
// with two checks:
//
//   1. Every exported `const X: CompositionManifest = <init>` must
//      have an `ArrayLiteralExpression` initializer whose elements
//      are all string literals (or no-substitution template literals).
//      A `ConditionalExpression` (`isProd ? [...] : [...]`), a
//      function call (`buildManifest()`), or a runtime-mutable
//      identifier reference is forbidden.
//
//   2. Every top-level statement in a composition module must be one
//      of: import declaration, export declaration, type alias,
//      interface declaration, or a `const` variable statement.
//      Top-level `if` / `switch` / `for` / `while` / function
//      declarations are forbidden — those are the imperative-dispatch
//      shapes the rule explicitly rejects.
//
// Exemption: a line-scoped `// PUL-A005-allow: <reason>` marker
// excludes a single line. Empty / whitespace-only rationales are
// rejected; markers hidden inside string literals are rejected.

const ALLOW_TAG = 'PUL-A005-allow';
const COMPOSITION_TYPE_NAME = 'CompositionManifest';

const COMPOSITIONS_ROOT = join(SRC_ROOT, 'compositions');

function isStringLikeElement(el: ts.Expression): boolean {
  return ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el);
}

function isAllowedTopLevelStatement(node: ts.Statement): boolean {
  if (ts.isImportDeclaration(node)) return true;
  if (ts.isExportDeclaration(node)) return true;
  if (ts.isExportAssignment(node)) return true;
  if (ts.isTypeAliasDeclaration(node)) return true;
  if (ts.isInterfaceDeclaration(node)) return true;
  if (ts.isVariableStatement(node)) {
    // `const`-only: a `let` or `var` is mutable and would allow
    // runtime reassignment of the manifest binding.
    return (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
  }
  return false;
}

function statementLabel(node: ts.Statement): string {
  if (ts.isIfStatement(node)) return 'top-level if statement (imperative dispatch)';
  if (ts.isSwitchStatement(node)) return 'top-level switch statement (imperative dispatch)';
  if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    return 'top-level for loop (imperative dispatch)';
  }
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    return 'top-level while loop (imperative dispatch)';
  }
  if (ts.isFunctionDeclaration(node)) {
    return 'top-level function declaration (imperative dispatch)';
  }
  if (ts.isClassDeclaration(node)) {
    return 'top-level class declaration (imperative dispatch)';
  }
  if (ts.isExpressionStatement(node)) {
    return 'top-level expression statement (imperative dispatch)';
  }
  if (ts.isVariableStatement(node)) {
    return 'top-level mutable variable statement (imperative dispatch)';
  }
  return 'top-level statement is not a declarative form';
}

function scanForA005(source: string, file: string): readonly SourceFinding[] {
  const sf = parseSource(source, file);
  const exempted = collectLineExemptions(sf, ALLOW_TAG);
  const findings: SourceFinding[] = [];

  const record = (node: ts.Node, label: string): void => {
    const start = node.getStart(sf);
    const { line } = sf.getLineAndCharacterOfPosition(start);
    if (exempted.has(line)) return;
    findings.push({
      file,
      line: line + 1,
      text: lineText(sf, line).trim(),
      label,
    });
  };

  // Symbol-aware: every `import type { CompositionManifest as Local }`
  // (and the un-aliased form) widens the set of names the manifest
  // scan recognises. Without this step a contributor could write
  //   import type { CompositionManifest as Manifest } from '...';
  //   export const x: Manifest = buildManifest();
  // and slip imperative dispatch past the gate.
  const manifestTypeNames = collectCompositionManifestLocalNames(sf);
  const isManifestTypeRef = (type: ts.TypeNode | undefined): boolean =>
    isCompositionManifestTypeRef(type, manifestTypeNames);
  const unwrapAssertedManifestExpr = (expr: ts.Expression): ts.Expression | null =>
    unwrapAssertedManifest(expr, manifestTypeNames);

  // 1. Top-level statement shape.
  for (const stmt of sf.statements) {
    if (!isAllowedTopLevelStatement(stmt)) {
      record(stmt, statementLabel(stmt));
    }
  }

  // First pass — collect the set of names that are exported from this
  // module. A binding can be exported either inline (`export const x
  // = ...`) or via a later re-export (`const x = ...; export { x };`).
  // Both routes turn `x` into a public composition surface, so the
  // shape check has to follow both.
  const exportedNames = collectExportedNames(sf);

  // 2. Every CompositionManifest-typed binding must be a static array
  //    literal of string-like elements. We recognise six surface
  //    shapes — all of them produce a `CompositionManifest` value:
  //
  //      a) `export const m: CompositionManifest = [...]`
  //         (variable declaration with explicit type annotation)
  //      b) `export const m = [...] as CompositionManifest`
  //         (as-expression with the target type)
  //      c) `export const m = [...] satisfies CompositionManifest`
  //         (satisfies-expression with the target type)
  //      d) `export default ([...] as|satisfies CompositionManifest)`
  //         (default export carrying one of the above shapes)
  //      e) `export default <any-expression>` (no assertion)
  //         A composition module's default export is implicitly the
  //         composition manifest. Without a type assertion there's no
  //         declared annotation to read, but the file is still under
  //         `src/compositions/**/*.ts` and the export still becomes
  //         the registered manifest. We enforce the same static-array
  //         rule so `export default buildManifest();` is caught.
  //      f) `export const m = <init>` (untyped, no assertion) AND
  //         `const m = <init>; export { m };` — every other named
  //         export from a composition module. The initializer must be
  //         a "declarative composition surface": a primitive literal
  //         (kept as a scene-id constant such as
  //         `DEFAULT_COMPOSITION_ID = 'default'`) or a static array
  //         literal of string literals. A function call, conditional,
  //         identifier-only reference, or other dynamic shape is
  //         imperative dispatch in disguise and is forbidden.
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (isManifestTypeRef(decl.type)) {
          if (!init) {
            record(decl, `${COMPOSITION_TYPE_NAME} export has no initializer`);
            continue;
          }
          checkManifestInitializer(init, record);
          continue;
        }
        // Shapes (b) / (c): initializer carries the assertion itself.
        const asserted = init && unwrapAssertedManifestExpr(init);
        if (asserted) {
          checkManifestInitializer(asserted, record);
          continue;
        }
        // Shape (f): untyped named export. Apply the declarative-
        // composition rule only to bindings that are actually
        // exported from the module — a module-local helper that is
        // never exposed is allowed to be a function call or other
        // computed value (it does not become part of the public
        // composition surface).
        if (!ts.isIdentifier(decl.name)) continue;
        if (!exportedNames.has(decl.name.text)) continue;
        if (!init) continue; // `let x;` won't pass the top-level statement check.
        checkUntypedComposedExport(init, record);
      }
    } else if (ts.isExportAssignment(stmt)) {
      // Default exports in a composition module are the composition
      // manifest by convention. Validate the underlying expression
      // (stripped of any `as|satisfies` type assertion) against the
      // same static-array rule. This closes the no-assertion default
      // export bypass and keeps the explicit-assertion case behaving
      // identically.
      const inner = unwrapAssertedManifestExpr(stmt.expression) ?? stmt.expression;
      checkManifestInitializer(inner, record);
    }
  }

  return findings;
}

/**
 * Collect every name that this composition module exports. Tracks two
 * shapes:
 *   - `export const x = ...`, `export function f() { ... }`, etc. —
 *     statements that carry an `export` modifier directly on the
 *     declaration. Inline-exported bindings.
 *   - `export { x, y as z }` — a standalone `export` declaration
 *     whose specifiers name local bindings (or rename them).
 *
 * Re-exports of imports (`export { x } from '...'`) are intentionally
 * out of scope: the binding originates in another module, so the
 * receiving module is not authoring the manifest shape itself.
 */
function collectExportedNames(sf: ts.SourceFile): ReadonlySet<string> {
  const out = new Set<string>();
  for (const stmt of sf.statements) {
    const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const hasExport = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (hasExport && ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) out.add(decl.name.text);
      }
    }
    if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause) {
      if (ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          // `export { x }` → name `x`; `export { x as y }` → still
          // surfaces `x` from the local module under a new external
          // name. The local binding being exposed is `propertyName ??
          // name` (the *local* identifier in TypeScript's export
          // grammar).
          const local = spec.propertyName?.text ?? spec.name.text;
          out.add(local);
        }
      }
    }
  }
  return out;
}

/**
 * Validate an untyped named composition export's initializer against
 * the declarative-composition contract:
 *
 * - A primitive literal (string, number, boolean, null, undefined,
 *   bigint) is allowed — that's how `DEFAULT_COMPOSITION_ID =
 *   'default'` is expressed.
 * - A static array literal of string-like elements is allowed — that
 *   is the canonical manifest shape.
 * - Anything else (function call, conditional expression, identifier
 *   reference, binary expression, etc.) is imperative dispatch in
 *   disguise and is forbidden. The line-scoped exemption marker is
 *   the documented escape hatch.
 */
function checkUntypedComposedExport(
  init: ts.Expression,
  record: (node: ts.Node, label: string) => void,
): void {
  if (isPrimitiveLiteral(init)) return;
  if (ts.isArrayLiteralExpression(init)) {
    for (const el of init.elements) {
      if (!isStringLikeElement(el)) {
        record(
          el,
          `${COMPOSITION_TYPE_NAME} export element is not a string literal (imperative dispatch)`,
        );
      }
    }
    return;
  }
  record(
    init,
    'untyped composition export initializer is not a primitive literal or static array literal',
  );
}

function isPrimitiveLiteral(expr: ts.Expression): boolean {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return true;
  if (ts.isNumericLiteral(expr) || ts.isBigIntLiteral(expr)) return true;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  // `undefined` is technically a value-position identifier read, not a
  // keyword; allow it explicitly.
  if (ts.isIdentifier(expr) && expr.text === 'undefined') return true;
  return false;
}

/**
 * Walk the file's top-level `import` statements and return the set of
 * local names that resolve to the `CompositionManifest` type. Tracks
 * the un-aliased form (`import type { CompositionManifest } from ...`)
 * and the `as` alias form (`import type { CompositionManifest as
 * Manifest } from ...`). Value imports of the same name are also
 * tracked because TypeScript's `isolatedDeclarations` setting allows a
 * non-type-only import to satisfy a type position too. The canonical
 * name is always included so direct `CompositionManifest` references
 * keep working even when no import statement is present (e.g., in the
 * scanner's own self-tests).
 */
function collectCompositionManifestLocalNames(sf: ts.SourceFile): ReadonlySet<string> {
  const out = new Set<string>([COMPOSITION_TYPE_NAME]);
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    const bindings = clause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const spec of bindings.elements) {
      // `import { CompositionManifest }`              → propertyName undefined, name=CompositionManifest
      // `import { CompositionManifest as Manifest }` → propertyName=CompositionManifest, name=Manifest
      const exported = spec.propertyName?.text ?? spec.name.text;
      if (exported === COMPOSITION_TYPE_NAME) {
        out.add(spec.name.text);
      }
    }
  }
  return out;
}

/**
 * True when `node` is a `TypeReferenceNode` whose `typeName` is one of
 * the file-local names that resolves to `CompositionManifest`. The
 * canonical name is always recognised; aliases (`CompositionManifest
 * as Manifest`) are picked up via `collectCompositionManifestLocalNames`.
 *
 * Qualified type references (e.g., `Composition.Manifest`) are NOT
 * recognised by this textual check. The composition modules in the
 * repo do not use qualified type references, and the
 * `composition-modules-import-CompositionManifest-by-name` self-test
 * documents the constraint explicitly so a future contributor sees
 * the requirement.
 */
function isCompositionManifestTypeRef(
  node: ts.TypeNode | undefined,
  localNames: ReadonlySet<string>,
): boolean {
  if (!node) return false;
  if (!ts.isTypeReferenceNode(node)) return false;
  const name = node.typeName;
  return ts.isIdentifier(name) && localNames.has(name.text);
}

/**
 * If `expr` (or an immediate parenthesized wrapper of it) is an
 * `AsExpression` or `SatisfiesExpression` whose target type is one of
 * the recognised manifest type names, return the underlying expression
 * that should be checked for the manifest shape. Otherwise return
 * `null`.
 */
function unwrapAssertedManifest(
  expr: ts.Expression,
  localNames: ReadonlySet<string>,
): ts.Expression | null {
  let current: ts.Expression = expr;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    if (isCompositionManifestTypeRef(current.type, localNames)) {
      return current.expression;
    }
  }
  return null;
}

function checkManifestInitializer(
  init: ts.Expression,
  record: (node: ts.Node, label: string) => void,
): void {
  if (!ts.isArrayLiteralExpression(init)) {
    record(init, `${COMPOSITION_TYPE_NAME} export initializer is not a static array literal`);
    return;
  }
  for (const el of init.elements) {
    if (!isStringLikeElement(el)) {
      record(
        el,
        `${COMPOSITION_TYPE_NAME} export element is not a string literal (imperative dispatch)`,
      );
    }
  }
}

describe('PUL-A005 — composition is declarative (source scan)', () => {
  describe('scanner self-tests — manifest shape', () => {
    it('accepts a static array literal of string literals', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        "export const myComp: CompositionManifest = ['a', 'b', 'c'];",
      ].join('\n');
      expect(scanForA005(src, 'src/compositions/x.ts')).toEqual([]);
    });

    it('flags a conditional-expression initializer', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const isProd: boolean;',
        "export const myComp: CompositionManifest = isProd ? ['a'] : ['b'];",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export initializer is not a static array literal`,
      );
    });

    it('flags a function-call initializer', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const buildManifest: () => CompositionManifest;',
        'export const myComp: CompositionManifest = buildManifest();',
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export initializer is not a static array literal`,
      );
    });

    it('flags an identifier-reference initializer', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        "const SCENES: CompositionManifest = ['a'];",
        'export const myComp: CompositionManifest = SCENES;',
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export initializer is not a static array literal`,
      );
    });

    it('flags a non-string-literal array element (computed value)', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const SCENE_ID: string;',
        "export const myComp: CompositionManifest = [SCENE_ID, 'b'];",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export element is not a string literal (imperative dispatch)`,
      );
    });

    it('flags a spread-expression element', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const rest: readonly string[];',
        "export const myComp: CompositionManifest = ['a', ...rest];",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export element is not a string literal (imperative dispatch)`,
      );
    });

    it('accepts a no-substitution template literal element', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'export const myComp: CompositionManifest = [`a`, `b`];',
      ].join('\n');
      expect(scanForA005(src, 'src/compositions/x.ts')).toEqual([]);
    });

    it('flags a tagged- or substituted-template-literal element', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const x: string;',
        'export const myComp: CompositionManifest = [`a-${x}`];',
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export element is not a string literal (imperative dispatch)`,
      );
    });

    it('flags a non-static-array initializer asserted with `satisfies CompositionManifest`', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const buildManifest: () => readonly string[];',
        'export const myComp = buildManifest() satisfies CompositionManifest;',
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export initializer is not a static array literal`,
      );
    });

    it('flags a non-static-array initializer asserted with `as CompositionManifest`', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const buildManifest: () => readonly string[];',
        'export const myComp = buildManifest() as CompositionManifest;',
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export initializer is not a static array literal`,
      );
    });

    it('flags an `export default` carrying `as CompositionManifest` over a non-static initializer', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const buildManifest: () => readonly string[];',
        'export default buildManifest() as CompositionManifest;',
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export initializer is not a static array literal`,
      );
    });

    it('flags an `export default` carrying `satisfies CompositionManifest` over a non-static initializer', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const buildManifest: () => readonly string[];',
        'export default buildManifest() satisfies CompositionManifest;',
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export initializer is not a static array literal`,
      );
    });

    it('accepts `as CompositionManifest` over a static array literal', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        "export const myComp = ['a', 'b'] as CompositionManifest;",
      ].join('\n');
      expect(scanForA005(src, 'src/compositions/x.ts')).toEqual([]);
    });

    it('accepts `satisfies CompositionManifest` over a static array literal', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        "export const myComp = ['a', 'b'] satisfies CompositionManifest;",
      ].join('\n');
      expect(scanForA005(src, 'src/compositions/x.ts')).toEqual([]);
    });

    it('flags a non-string element inside an `as CompositionManifest` array literal', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const x: string;',
        "export const myComp = ['a', x] as CompositionManifest;",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export element is not a string literal (imperative dispatch)`,
      );
    });

    it('flags an untyped `export default <function call>` (no assertion)', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const buildManifest: () => CompositionManifest;',
        'export default buildManifest();',
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export initializer is not a static array literal`,
      );
    });

    it('flags an untyped `export default <conditional>` (no assertion)', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const flag: boolean;',
        "export default flag ? ['a'] : ['b'];",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export initializer is not a static array literal`,
      );
    });

    it('accepts an `export default` of a static array literal (no assertion)', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        "export default ['a', 'b'] satisfies CompositionManifest;",
      ].join('\n');
      expect(scanForA005(src, 'src/compositions/x.ts')).toEqual([]);
    });

    it('flags a non-string element inside an `export default` array literal', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const x: string;',
        "export default ['a', x] satisfies CompositionManifest;",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export element is not a string literal (imperative dispatch)`,
      );
    });

    it('recognises a `CompositionManifest as Manifest` alias and validates against it', () => {
      const src = [
        "import type { CompositionManifest as Manifest } from '../runtime/composition';",
        'declare const buildManifest: () => Manifest;',
        'export const myComp: Manifest = buildManifest();',
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export initializer is not a static array literal`,
      );
    });

    it('recognises a `CompositionManifest as Manifest` alias in `as` assertions too', () => {
      const src = [
        "import type { CompositionManifest as Manifest } from '../runtime/composition';",
        'declare const buildManifest: () => readonly string[];',
        'export const myComp = buildManifest() as Manifest;',
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        `${COMPOSITION_TYPE_NAME} export initializer is not a static array literal`,
      );
    });

    it('accepts a `CompositionManifest as Manifest` aliased static manifest', () => {
      const src = [
        "import type { CompositionManifest as Manifest } from '../runtime/composition';",
        "export const myComp: Manifest = ['a', 'b'];",
      ].join('\n');
      expect(scanForA005(src, 'src/compositions/x.ts')).toEqual([]);
    });

    it('flags an untyped named export whose initializer is a function call', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const buildManifest: () => CompositionManifest;',
        'export const deck = buildManifest();',
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        'untyped composition export initializer is not a primitive literal or static array literal',
      );
    });

    it('flags an untyped named export whose initializer is a conditional expression', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const flag: boolean;',
        "export const deck = flag ? ['a'] : ['b'];",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        'untyped composition export initializer is not a primitive literal or static array literal',
      );
    });

    it('flags an untyped re-export (`const x = ...; export { x };`) whose initializer is a function call', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const buildManifest: () => CompositionManifest;',
        'const deck = buildManifest();',
        'export { deck };',
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        'untyped composition export initializer is not a primitive literal or static array literal',
      );
    });

    it("accepts an untyped scene-id constant export (`export const ID = 'foo'`)", () => {
      // `DEFAULT_COMPOSITION_ID = 'default'` in the real `default.ts`
      // is the canonical example. Primitive-literal initializers are
      // allowed because they cannot encode imperative dispatch.
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        "export const DEFAULT_COMPOSITION_ID = 'default';",
        "export const defaultComposition: CompositionManifest = ['placeholder'];",
      ].join('\n');
      expect(scanForA005(src, 'src/compositions/x.ts')).toEqual([]);
    });

    it('accepts an untyped named export whose initializer is a static array of string literals', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        "export const deck = ['a', 'b', 'c'];",
      ].join('\n');
      expect(scanForA005(src, 'src/compositions/x.ts')).toEqual([]);
    });

    it('does NOT flag a module-local non-exported `const helper = <call>()`', () => {
      // A binding that never leaves the module cannot be the source of
      // truth for a composition's order. Imperative module-local
      // helpers are NOT what PUL-A005 forbids.
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const f: () => string;',
        'const helper = f();',
        "export const deck: CompositionManifest = ['a', 'b'];",
      ].join('\n');
      expect(scanForA005(src, 'src/compositions/x.ts')).toEqual([]);
    });
  });

  describe('scanner self-tests — top-level statement shape', () => {
    it('flags a top-level `if` statement', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const flag: boolean;',
        'if (flag) {',
        "  console.log('dispatch');",
        '}',
        "export const myComp: CompositionManifest = ['a'];",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        'top-level if statement (imperative dispatch)',
      );
    });

    it('flags a top-level `switch` statement', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const v: number;',
        'switch (v) { case 0: break; default: break; }',
        "export const myComp: CompositionManifest = ['a'];",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        'top-level switch statement (imperative dispatch)',
      );
    });

    it('flags a top-level `for` loop', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'for (let i = 0; i < 1; i++) {}',
        "export const myComp: CompositionManifest = ['a'];",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain('top-level for loop (imperative dispatch)');
    });

    it('flags a top-level function declaration', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        "function helper(): string { return 'a'; }",
        "export const myComp: CompositionManifest = ['a'];",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        'top-level function declaration (imperative dispatch)',
      );
    });

    it('flags a top-level `let` declaration', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'let mutableState = 0;',
        "export const myComp: CompositionManifest = ['a'];",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        'top-level mutable variable statement (imperative dispatch)',
      );
    });

    it('flags a top-level expression statement', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        "console.log('side effect');",
        "export const myComp: CompositionManifest = ['a'];",
      ].join('\n');
      const findings = scanForA005(src, 'src/compositions/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        'top-level expression statement (imperative dispatch)',
      );
    });

    it('accepts a top-level type alias and interface declaration', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'type AdditionalProps = { tag: string };',
        'interface Hook { onLoad(): void }',
        "export const myComp: CompositionManifest = ['a'];",
      ].join('\n');
      expect(scanForA005(src, 'src/compositions/x.ts')).toEqual([]);
    });
  });

  describe('scanner self-tests — exemption', () => {
    it('honors `// PUL-A005-allow: <reason>` on the violating line', () => {
      const src = [
        "import type { CompositionManifest } from '../runtime/composition';",
        'declare const flag: boolean;',
        "export const myComp: CompositionManifest = flag ? ['a'] : ['b']; // PUL-A005-allow: legacy bridge, see ADR-XYZ",
      ].join('\n');
      expect(scanForA005(src, 'src/compositions/x.ts')).toEqual([]);
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('compositions root `src/compositions/` exists and contains at least one .ts file', () => {
      expect(statSync(COMPOSITIONS_ROOT).isDirectory()).toBe(true);
      expect(walkTsFiles(COMPOSITIONS_ROOT).length).toBeGreaterThan(0);
    });

    it('contains no A005 violations across `src/compositions/**/*.ts`', () => {
      const files = walkTsFiles(COMPOSITIONS_ROOT);
      const findings: SourceFinding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        findings.push(...scanForA005(text, rel));
      }
      const header =
        'PUL-A005 forbids imperative dispatch as the source of truth for composition order. Compositions must be declarative manifests (static arrays of string-literal scene ids). Add a `// PUL-A005-allow: <reason>` exemption on the same line if the use is intentional.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });
  });
});
