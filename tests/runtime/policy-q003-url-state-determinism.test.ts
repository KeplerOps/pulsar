import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  GLOBAL_WRAPPERS,
  REPO_ROOT,
  SRC_ROOT,
  type SourceFinding,
  collectLineExemptions,
  getAccessPath,
  isInTypePosition,
  lineText,
  parseSource,
  unwrap,
  walkTsFiles,
} from './source-policy';

// PUL-Q003 — URL state determinism source scan.
//
// Statement: "URL parameters SHALL fully determine the runtime's
// targeted state. The runtime SHALL NOT use `localStorage`,
// `sessionStorage`, cookies, or other persisted state to determine
// which scene, beat, composition, or mode is targeted."
//
// The PUL-Q003 preflight (`docs/design/pul-q003-url-state-determinism-preflight.md`)
// names browser persistence APIs AND host-state surfaces as out of
// scope for target selection: `localStorage`, `sessionStorage`,
// `document.cookie`, `history.state`, IndexedDB, Cache Storage,
// `process.env`, `process.argv`, `import.meta.env`. The scanner bans
// the union so the gate is structurally complete on its own terms —
// independent of the Q001 screenshot-determinism scan, which today
// happens to overlap on the host-state subset but is logically
// scope-separable.
//
// Enforcement: a Vitest source scan over `src/**/*.ts`. The scanner
// flags every runtime-value read of:
//   - `localStorage`, `sessionStorage` (Web Storage)
//   - `document.cookie`
//   - `history.state` (the `history` global's persisted slot —
//     `history.pushState` / `replaceState` are URL mutators and stay
//     allowed)
//   - `indexedDB` (IndexedDB)
//   - `caches` (Cache Storage)
//   - `process.env`, `process.argv` (host environment / argv)
//   - `import.meta.env` (Vite-injected env binding)
// Each surface is matched bare (`localStorage`), through a recognised
// global wrapper (`window.localStorage`, `globalThis.caches`,
// `self.indexedDB`, `global.history.state`), via string-literal
// bracket access (`window['localStorage']`), via a computed
// wrapper-access bypass (`globalThis['local' + 'Storage']`), and
// **through file-local aliases** of the ambient roots or the global
// wrappers (`const h = history; h.state` / `const win = window;
// win.localStorage`). Type-position references, declaration names,
// and property-name keys are ignored. Comments and string literals do
// not trigger the gate.
//
// This is a sibling policy to the PUL-Q001 screenshot-determinism
// source scan (`screenshot-determinism-source.test.ts`), which already
// bans `localStorage`, `sessionStorage`, `document.cookie`,
// `history.state`, `process.env`, `process.argv`, and `import.meta.env`
// in `src/`. The two gates dual-flag the overlap intentionally:
// Q001 protects byte-identical screenshot capture; Q003 protects
// URL-only target selection. If a future refactor scopes Q001 to
// screenshot-mode paths or to the scene subset, Q003 keeps the
// persisted-state / host-state ban in force across the whole authored
// runtime. Q003 additionally covers two browser-persistence surfaces
// (`indexedDB`, `caches`) that Q001 does not, because those are
// persistence hazards rather than wall-clock / entropy hazards.
//
// Exemption: a line-scoped `// PUL-Q003-allow: <reason>` comment
// excludes a single line from the scan. Empty / whitespace-only
// rationales are rejected; markers hidden inside string literals are
// rejected; the marker applies only to its own line.

const ALLOW_TAG = 'PUL-Q003-allow';

// Forbidden bare globals: bare identifier reads (and `<wrapper>.X` /
// `<wrapper>['X']`) trip the gate. Each entry is the global identifier
// name; the label is the human-readable surface name carried on the
// finding.
const FORBIDDEN_GLOBAL_IDENTIFIERS: readonly { readonly name: string; readonly label: string }[] = [
  { name: 'localStorage', label: 'localStorage' },
  { name: 'sessionStorage', label: 'sessionStorage' },
  { name: 'indexedDB', label: 'indexedDB' },
  { name: 'caches', label: 'caches (Cache Storage)' },
];
const FORBIDDEN_GLOBAL_IDENTIFIER_LABEL_BY_NAME = new Map(
  FORBIDDEN_GLOBAL_IDENTIFIERS.map((e) => [e.name, e.label]),
);

// Forbidden root + property pairs: `[..wrappers.., root, prop]` access
// chains. The persisted-slot reads (`document.cookie`, `history.state`),
// the host-state reads (`process.env`, `process.argv`), and the
// Vite-injected env binding (`import.meta.env`) all go through one
// unified table. `import.meta` is treated as a synthetic root segment
// emitted by `getAccessPath` for the JS meta-property; the matcher
// handles it the same way as the regular roots. `history.pushState` /
// `replaceState` are URL mutators and are NOT in this table; they
// push state into the URL, they do not read persisted state out.
const FORBIDDEN_ROOT_PROPERTY_PAIRS: readonly {
  readonly root: string;
  readonly prop: string;
  readonly label: string;
}[] = [
  { root: 'document', prop: 'cookie', label: 'document.cookie' },
  { root: 'history', prop: 'state', label: 'history.state' },
  { root: 'process', prop: 'env', label: 'process.env' },
  { root: 'process', prop: 'argv', label: 'process.argv' },
  { root: 'import.meta', prop: 'env', label: 'import.meta.env' },
];

// Ambient roots whose file-local aliases (`const X = <root>` or
// `const X = <wrapper>.<root>`) the scanner resolves before access-path
// matching. Without this, ordinary refactors (`const h = history;
// h.state`, `const h = window.history; h.state`, `const win = window;
// win.localStorage`) would slip past every per-surface check while
// still reading the persisted-state slot. The set is the union of the
// global wrappers, the forbidden-table roots, the bare-global
// identifiers, and the `import.meta` meta-property root so an alias of
// any covered root resolves correctly.
const ALIAS_ROOTS: ReadonlySet<string> = new Set<string>([
  ...GLOBAL_WRAPPERS,
  'document',
  'history',
  'process',
  'import.meta',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
]);

// True when `node` is the `.name` portion of a property access /
// qualified name — i.e., a key position rather than a value-read. A
// `foo.cookie` access where `foo` is a local does not trip the
// `document.cookie` rule because root-property matching is anchored
// on `document` / `history`; this predicate prevents the leaf
// identifier `cookie` from also triggering a separate bare-identifier
// match through the visitor loop.
function isPropertyNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) &&
    'name' in parent &&
    parent.name === node
  ) {
    return true;
  }
  return false;
}

// True when `node` is being declared (`const localStorage = ...`,
// `function caches() {}`, `interface I { localStorage(): void }`,
// etc.). Declarations are not value reads.
function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isClassDeclaration(parent) && parent.name === node) return true;
  if (ts.isInterfaceDeclaration(parent) && parent.name === node) return true;
  if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return true;
  if (ts.isEnumDeclaration(parent) && parent.name === node) return true;
  if (ts.isEnumMember(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodSignature(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  // ShorthandPropertyAssignment is intentionally NOT a declaration:
  // `{ localStorage }` is a value-position read, equivalent to
  // `{ localStorage: localStorage }`.
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent)) return true;
  if (ts.isImportClause(parent) && parent.name === node) return true;
  if (ts.isNamespaceImport(parent)) return true;
  if (ts.isExportSpecifier(parent)) return true;
  return false;
}

// Strip leading recognised global-wrapper segments. Returns the
// remaining `tail` plus the count of stripped segments.
function stripWrappers(path: readonly string[]): readonly string[] {
  let start = 0;
  while (start < path.length && GLOBAL_WRAPPERS.has(path[start] ?? '')) {
    start += 1;
  }
  return path.slice(start);
}

// Match `[..wrappers.., root, prop]` against the unified table.
// Returns the matched label, or null when the path doesn't match.
// `import.meta` resolves to a synthetic single-segment root and is
// handled here too — `[import.meta, env]` matches the
// `import.meta.env` row.
function matchRootPropertyPair(path: readonly string[]): string | null {
  const tail = stripWrappers(path);
  if (tail.length !== 2) return null;
  const [root, prop] = tail;
  for (const surface of FORBIDDEN_ROOT_PROPERTY_PAIRS) {
    if (surface.root === root && surface.prop === prop) {
      return surface.label;
    }
  }
  return null;
}

// Match a path whose first non-wrapper segment is a bare forbidden
// global (`localStorage`, `sessionStorage`, `indexedDB`, `caches`).
// Catches BOTH the exact-length bare read (path `[localStorage]`)
// and downstream property reads (`storage.getItem` after `const
// storage = localStorage` resolves to `[localStorage, getItem]`).
// The earlier `pathResolvesTo` helper required a tail of length 1
// and therefore missed the aliased-and-then-used case where the
// binding line is allow-exempted.
function matchBareGlobalRoot(path: readonly string[]): string | null {
  const tail = stripWrappers(path);
  if (tail.length === 0) return null;
  const root = tail[0];
  if (root === undefined) return null;
  return FORBIDDEN_GLOBAL_IDENTIFIER_LABEL_BY_NAME.get(root) ?? null;
}

// Collect file-local aliases that bind a fresh identifier to one of
// the ambient roots in `ALIAS_ROOTS`. The collector handles five
// initializer shapes:
//
//   1. A bare identifier in `ALIAS_ROOTS` (`const h = history;`,
//      `const ls = localStorage;`).
//   2. An alias of an alias — when the initializer identifier is
//      itself in the aliases map, register the new local against
//      the canonical (`const win = window; const w2 = win;` →
//      `w2 → window`).
//   3. A property/element access whose alias-resolved + wrapper-
//      stripped path is a single ambient root segment
//      (`const h = window.history;`,
//      `const h = win.history` after `const win = window;`).
//   4. The `import.meta` meta-property (`const meta = import.meta;`).
//   5. A destructured property that names an ambient root, when the
//      initializer is a wrapper (`const { history: h } = window;`,
//      `const { document: doc } = root;` after `const root = globalThis;`).
//
// The collector iterates to a fixed point so alias chains resolve
// regardless of source order (`const h = win.history; const win = window;`
// resolves on the second pass when `win`'s registration becomes
// visible to the property-access classifier).
//
// Chained or expression-shaped initializers (`const h = history.state;`,
// `const h = computeRoot();`) do NOT register an alias because the
// resulting local no longer refers to the ambient root verbatim — it
// refers to a value that was once derived from it.
function collectAliases(sourceFile: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();

  type DirectDecl = { kind: 'direct'; name: string; init: ts.Expression };
  type DestructuringDecl = {
    kind: 'destructuring';
    pattern: ts.ObjectBindingPattern;
    init: ts.Expression;
  };
  const declarations: (DirectDecl | DestructuringDecl)[] = [];
  const collectVisit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        declarations.push({ kind: 'direct', name: node.name.text, init: node.initializer });
      } else if (ts.isObjectBindingPattern(node.name)) {
        declarations.push({
          kind: 'destructuring',
          pattern: node.name,
          init: node.initializer,
        });
      }
    }
    ts.forEachChild(node, collectVisit);
  };
  collectVisit(sourceFile);

  const tryRegisterDirect = (localName: string, init: ts.Expression): boolean => {
    if (aliases.has(localName)) return false;
    const inner = unwrap(init);
    if (ts.isIdentifier(inner)) {
      if (ALIAS_ROOTS.has(inner.text)) {
        aliases.set(localName, inner.text);
        return true;
      }
      const aliased = aliases.get(inner.text);
      if (aliased !== undefined) {
        aliases.set(localName, aliased);
        return true;
      }
      return false;
    }
    if (ts.isMetaProperty(inner)) {
      aliases.set(localName, 'import.meta');
      return true;
    }
    if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
      const rawPath = getAccessPath(inner);
      if (!rawPath) return false;
      const resolved = resolveAliasedPath(rawPath, aliases) ?? rawPath;
      const tail = stripWrappers(resolved);
      if (tail.length === 1) {
        const canonical = tail[0];
        if (canonical && ALIAS_ROOTS.has(canonical)) {
          aliases.set(localName, canonical);
          return true;
        }
      }
    }
    return false;
  };

  const tryRegisterDestructuring = (
    pattern: ts.ObjectBindingPattern,
    init: ts.Expression,
  ): boolean => {
    // Only ambient-root destructuring from a wrapper registers an
    // alias. `const { state } = history;` reads `history.state` —
    // that's surface-matched elsewhere, not aliased.
    const initPath = resolveAliasedPath(getAccessPathFromExpression(init), aliases);
    if (!initPath) return false;
    const tail = stripWrappers(initPath);
    if (tail.length !== 0) return false; // not a pure wrapper root
    let changed = false;
    for (const element of pattern.elements) {
      const propNode = element.propertyName ?? element.name;
      const propText = ts.isIdentifier(propNode)
        ? propNode.text
        : ts.isStringLiteralLike(propNode)
          ? propNode.text
          : null;
      if (!propText) continue;
      if (!ALIAS_ROOTS.has(propText)) continue;
      // Skip when the local name isn't a simple identifier (nested
      // destructuring is not aliased).
      if (!ts.isIdentifier(element.name)) continue;
      const localName = element.name.text;
      if (aliases.has(localName)) continue;
      aliases.set(localName, propText);
      changed = true;
    }
    return changed;
  };

  // Iterate to a fixed point. Each pass can register one additional
  // level of chaining; the upper bound is `declarations.length`
  // passes, which is plenty for any realistic source file.
  for (let pass = 0; pass < declarations.length + 1; pass += 1) {
    let changed = false;
    for (const decl of declarations) {
      if (decl.kind === 'direct') {
        if (tryRegisterDirect(decl.name, decl.init)) changed = true;
      } else {
        if (tryRegisterDestructuring(decl.pattern, decl.init)) changed = true;
      }
    }
    if (!changed) break;
  }
  return aliases;
}

// Substitute the first segment of `path` with its canonical alias
// target, if one is registered. Subsequent segments are property
// names by construction (a property access cannot itself be an
// aliased ambient root), so single-step substitution is sufficient.
function resolveAliasedPath(
  path: readonly string[] | null,
  aliases: Map<string, string>,
): readonly string[] | null {
  if (!path || path.length === 0 || aliases.size === 0) return path;
  const first = path[0];
  if (first === undefined) return path;
  const canonical = aliases.get(first);
  if (canonical === undefined) return path;
  return [canonical, ...path.slice(1)];
}

// Q003-local computed-access detector. Walks back through nested
// property / element access nodes; returns `true` when any subscript
// is non-literal (i.e., computed) AND the underlying root resolves to
// one of: a recognised global wrapper, an ambient ALIAS_ROOTS root,
// or the `import.meta` meta-property — directly or through a file-
// local alias. Conservative: a computed segment on a non-restricted
// root is NOT flagged.
//
// This replaces the shared `isComputedGlobalWrapperAccess` for the
// Q003 path because the shared helper only accepts wrapper roots,
// not aliased wrapper roots or `import.meta`. Used for bypass
// patterns like `win[key]` after `const win = window`,
// `globalThis['lo' + 'calStorage']`, and `import.meta['en' + 'v']`.
function isComputedRestrictedRootAccess(
  expr: ts.Expression,
  aliases: ReadonlyMap<string, string>,
): boolean {
  let current: ts.Expression = unwrap(expr);
  let foundComputed = false;
  while (true) {
    current = unwrap(current);
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      const arg = unwrap(current.argumentExpression);
      if (!ts.isStringLiteralLike(arg)) {
        foundComputed = true;
      }
      current = current.expression;
      continue;
    }
    break;
  }
  if (!foundComputed) return false;
  if (ts.isMetaProperty(current)) return true;
  if (!ts.isIdentifier(current)) return false;
  // Direct ambient root (`history[key]`, `process[key]`, etc.) is a
  // bypass surface even without aliasing — codex review cycle 3
  // flagged that `history['st' + 'ate']` was silently passing
  // because the direct-root branch only accepted GLOBAL_WRAPPERS.
  // ALIAS_ROOTS is the superset (wrappers + ambient roots + bare
  // globals + import.meta), so a single membership check covers
  // both direct and aliased forms.
  if (ALIAS_ROOTS.has(current.text)) return true;
  const canonical = aliases.get(current.text);
  if (canonical === undefined) return false;
  return ALIAS_ROOTS.has(canonical);
}

function scanQ003(sourceFile: ts.SourceFile): readonly SourceFinding[] {
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const aliases = collectAliases(sourceFile);
  const findings: SourceFinding[] = [];
  const seen = new Set<string>();

  const record = (node: ts.Node, label: string): void => {
    const start = node.getStart(sourceFile);
    const key = `${start}::${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    if (exempted.has(line)) return;
    findings.push({
      file: sourceFile.fileName,
      line: line + 1,
      text: lineText(sourceFile, line).trim(),
      label,
    });
  };

  // Destructuring helper: given an initializer expression and the
  // collection of object-pattern elements, record findings for every
  // element that destructures a forbidden surface. Used for BOTH the
  // `const { ... } = X` (VariableDeclaration) and `({ ... } = X)`
  // (assignment) forms.
  const recordDestructuring = (
    initializer: ts.Expression,
    elements: readonly { node: ts.Node; propertyName: string }[],
  ): void => {
    const initPath = resolveAliasedPath(getAccessPathFromExpression(initializer), aliases);
    if (!initPath) return;
    const tail = stripWrappers(initPath);
    // Case A: tail length 0 — destructuring directly from a global
    // wrapper (`const { localStorage } = window;`). Each property is
    // a bare-global read.
    if (tail.length === 0) {
      for (const element of elements) {
        const label = FORBIDDEN_GLOBAL_IDENTIFIER_LABEL_BY_NAME.get(element.propertyName);
        if (label) record(element.node, `${label} (via destructuring)`);
      }
      return;
    }
    // Case B: tail length 1 — destructuring from a named ambient
    // root (`const { cookie } = document;`, `const { env } = process;`,
    // `const { env } = import.meta;`). Property names match against
    // the root.prop table.
    if (tail.length === 1) {
      const rootSegment = tail[0];
      for (const element of elements) {
        for (const surface of FORBIDDEN_ROOT_PROPERTY_PAIRS) {
          if (rootSegment === surface.root && surface.prop === element.propertyName) {
            record(element.node, `${surface.label} (via destructuring)`);
          }
        }
      }
    }
    // Tail length >= 2 means the initializer is itself a read of a
    // surface (`const { x } = document.cookie;`); the access-path
    // matcher already flags the initializer, so no extra finding is
    // needed at the destructuring elements.
  };

  // Extract the destructured `(node, propertyName)` pairs from a
  // VariableDeclaration object binding pattern. String-literal keys
  // (`const { 'cookie': c } = document;`) are accepted alongside
  // identifier keys.
  const variablePatternElements = (
    pattern: ts.ObjectBindingPattern,
  ): { node: ts.Node; propertyName: string }[] => {
    const out: { node: ts.Node; propertyName: string }[] = [];
    for (const element of pattern.elements) {
      const propName = element.propertyName ?? element.name;
      if (ts.isIdentifier(propName)) {
        out.push({ node: element, propertyName: propName.text });
      } else if (ts.isStringLiteralLike(propName)) {
        out.push({ node: element, propertyName: propName.text });
      }
    }
    return out;
  };

  // Extract the destructured `(node, propertyName)` pairs from an
  // ObjectLiteralExpression destructuring assignment pattern
  // (`({ state } = history;)`). TypeScript represents the LHS as an
  // ObjectLiteralExpression whose `properties` are
  // ShorthandPropertyAssignment / PropertyAssignment.
  const assignmentPatternElements = (
    pattern: ts.ObjectLiteralExpression,
  ): { node: ts.Node; propertyName: string }[] => {
    const out: { node: ts.Node; propertyName: string }[] = [];
    for (const property of pattern.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        out.push({ node: property, propertyName: property.name.text });
      } else if (ts.isPropertyAssignment(property)) {
        const key = property.name;
        if (ts.isIdentifier(key)) {
          out.push({ node: property, propertyName: key.text });
        } else if (ts.isStringLiteralLike(key)) {
          out.push({ node: property, propertyName: key.text });
        }
      }
    }
    return out;
  };

  const visit = (node: ts.Node): void => {
    // 1. Property / element access chains. The access path is
    //    resolved through the alias map so file-local rebindings
    //    (`const h = history; h.state`, `const h = window.history;
    //    h.state`, `const win = window; win.localStorage`) match the
    //    same per-surface table as the canonical form. Detection
    //    covers:
    //    (a) `[..wrappers.., root, prop]` against the unified
    //        root/property pair table (document.cookie, history.state,
    //        process.env, process.argv, import.meta.env).
    //    (b) A bare forbidden global as the first non-wrapper
    //        segment of the path (`window.localStorage`,
    //        `globalThis['caches']`, and — through alias resolution —
    //        `storage.getItem` after `const storage = localStorage`).
    //    (c) Computed access whose root resolves (directly or via
    //        an alias) to a global wrapper / ambient root /
    //        `import.meta` — flagged conservatively as a possible
    //        bypass.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (!isInTypePosition(node)) {
        const rawPath = getAccessPath(node);
        const path = resolveAliasedPath(rawPath, aliases);
        if (path) {
          const pairLabel = matchRootPropertyPair(path);
          if (pairLabel) {
            record(node, pairLabel);
          } else {
            const bareLabel = matchBareGlobalRoot(path);
            if (bareLabel) {
              record(node, bareLabel);
            }
          }
        } else if (isComputedRestrictedRootAccess(node, aliases)) {
          record(node, 'computed restricted-root access (possible persisted-state bypass)');
        }
      }
    }

    // 2. Bare identifier reads. Skip the binding site, type positions,
    //    and the `.name` of a property access (the leaf-name `cookie`
    //    in `document.cookie` is handled by the root-property matcher
    //    above). Flag:
    //    (a) Identifiers in the forbidden bare-global table
    //        (`localStorage`, `sessionStorage`, `indexedDB`, `caches`).
    //    (b) Identifiers whose alias resolves to a forbidden bare-
    //        global — catches `storage.<anything>` and the bare `storage`
    //        read even when the original `const storage = localStorage`
    //        binding line is allow-exempted.
    if (ts.isIdentifier(node) && !isInTypePosition(node) && !isDeclarationName(node)) {
      if (!isPropertyNamePosition(node)) {
        const direct = FORBIDDEN_GLOBAL_IDENTIFIER_LABEL_BY_NAME.get(node.text);
        if (direct) {
          record(node, direct);
        } else {
          const canonical = aliases.get(node.text);
          if (canonical !== undefined) {
            const aliasedLabel = FORBIDDEN_GLOBAL_IDENTIFIER_LABEL_BY_NAME.get(canonical);
            if (aliasedLabel) {
              record(node, aliasedLabel);
            }
          }
        }
      }
    }

    // 3. Destructuring — both variable-declaration form and
    //    assignment form. String-literal keys are accepted alongside
    //    identifier keys. Initializers are resolved through the alias
    //    map so destructuring via aliased roots
    //    (`const proc = process; const { env } = proc;`) is caught.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name)
    ) {
      recordDestructuring(node.initializer, variablePatternElements(node.name));
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(node.left)
    ) {
      recordDestructuring(node.right, assignmentPatternElements(node.left));
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// Resolve an expression to an access-path. Used for destructuring
// initializers (`const { state } = history;`) where the initializer is
// an `Expression`, not specifically a `Property/ElementAccessExpression`.
// `import.meta` is mapped to the synthetic root segment `import.meta`.
function getAccessPathFromExpression(expr: ts.Expression): readonly string[] | null {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) return [inner.text];
  if (ts.isMetaProperty(inner)) return ['import.meta'];
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
    return getAccessPath(inner);
  }
  return null;
}

function findingsOf(source: string, file = 'fake.ts'): readonly SourceFinding[] {
  return scanQ003(parseSource(source, file));
}

// --- Tests -----------------------------------------------------------

describe('PUL-Q003 — URL state determinism (source scan)', () => {
  describe('scanner self-tests', () => {
    describe('direct bare-global reads', () => {
      it.each([
        ['localStorage', 'localStorage.getItem("scene");'],
        ['sessionStorage', 'sessionStorage.setItem("scene", "x");'],
        ['indexedDB', 'const req = indexedDB.open("scenes");'],
        ['caches (Cache Storage)', 'caches.open("v1");'],
      ])('flags bare %s', (label, source) => {
        const findings = findingsOf(source);
        expect(findings.map((f) => f.label)).toContain(label);
      });
    });

    describe('direct root-property reads', () => {
      it.each([
        ['document.cookie', 'const c = document.cookie;'],
        ['document.cookie', 'document.cookie = "scene=evil";'],
        ['history.state', 'const s = history.state;'],
        ['process.env', 'const v = process.env.SCENE;'],
        ['process.env', 'const e = process.env;'],
        ['process.argv', 'const a = process.argv[2];'],
        ['process.argv', 'const a = process.argv;'],
        ['import.meta.env', 'const v = import.meta.env.VITE_SCENE;'],
        ['import.meta.env', 'const env = import.meta.env;'],
      ])('flags %s', (label, source) => {
        const findings = findingsOf(source);
        expect(findings.map((f) => f.label)).toContain(label);
      });
    });

    describe('global-wrapper forms', () => {
      // Every entry in `GLOBAL_WRAPPERS` (`globalThis`, `window`,
      // `self`, `global`) must appear at least once for the per-surface
      // tables. A regression that drops one wrapper from the shared
      // helper's allow-set must fail this group.
      it.each([
        ['localStorage', 'globalThis.localStorage.getItem("scene");'],
        ['localStorage', 'window.localStorage.getItem("scene");'],
        ['localStorage', 'self.localStorage.getItem("scene");'],
        ['localStorage', 'global.localStorage.getItem("scene");'],
        ['localStorage', `window['localStorage'].getItem('scene');`],
        ['sessionStorage', 'globalThis.sessionStorage.getItem("scene");'],
        ['indexedDB', 'globalThis.indexedDB.open("scenes");'],
        ['indexedDB', 'self.indexedDB.open("scenes");'],
        ['caches (Cache Storage)', 'window.caches.open("v1");'],
        ['caches (Cache Storage)', 'global.caches.open("v1");'],
        ['document.cookie', 'const c = window.document.cookie;'],
        ['document.cookie', 'const c = globalThis.document.cookie;'],
        ['history.state', 'const s = window.history.state;'],
        ['history.state', 'const s = globalThis.history.state;'],
        ['history.state', 'const s = self.history.state;'],
        ['history.state', 'const s = global.history.state;'],
        ['process.env', 'const v = globalThis.process.env.SCENE;'],
        ['process.env', 'const v = global.process.env.SCENE;'],
        ['process.argv', 'const a = globalThis.process.argv[2];'],
      ])('flags wrapped %s', (label, source) => {
        const findings = findingsOf(source);
        expect(findings.map((f) => f.label)).toContain(label);
      });
    });

    describe('computed wrapper access (bypass defense)', () => {
      // String-concatenation / template-substitution / runtime-key
      // forms can hide a forbidden surface behind a non-literal
      // subscript. The shared `isComputedGlobalWrapperAccess` helper
      // flags these conservatively when the root is a recognised
      // global wrapper.
      it.each([
        "globalThis['local' + 'Storage'].getItem('scene');",
        "window['ses' + 'sionStorage'].getItem('scene');",
        "self[`indexed${'DB'}`].open('scenes');",
        "global['cach' + 'es'].open('v1');",
        "globalThis[someKey].getItem('scene');",
      ])('flags computed wrapper access — `%s`', (source) => {
        const findings = findingsOf(`declare const someKey: string; ${source}`);
        expect(findings.map((f) => f.label)).toContain(
          'computed restricted-root access (possible persisted-state bypass)',
        );
      });

      it('does NOT flag computed access on a non-global root', () => {
        const findings = findingsOf(
          "declare const obj: Record<string, { getItem(k: string): string }>; declare const k: string; obj[k].getItem('scene');",
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag string-literal subscript on a global wrapper (handled by the literal path)', () => {
        // `window['localStorage']` is a literal subscript: the
        // access-path resolver returns `[window, localStorage]` and
        // the bare-global matcher fires. The computed-access detector
        // must NOT also fire — otherwise the same line would carry
        // two findings.
        const findings = findingsOf(`window['localStorage'].getItem('scene');`);
        const labels = findings.map((f) => f.label);
        expect(labels).toContain('localStorage');
        expect(labels).not.toContain(
          'computed restricted-root access (possible persisted-state bypass)',
        );
      });
    });

    describe('aliased forms (file-local rebinding)', () => {
      // Aliasing the global through a local binding is the same
      // structural surface; `h.state` after `const h = history;` still
      // reads the host `history.state` slot. The scanner resolves
      // file-local aliases of the ambient roots (`document`, `history`,
      // `process`, `localStorage`, `sessionStorage`, `indexedDB`,
      // `caches`) and of the global wrappers (`window`, `globalThis`,
      // `self`, `global`) before access-path matching, so every per-
      // surface assertion below catches the aliased form too.
      it('flags `const ls = localStorage; ls.getItem(...)` at the alias site', () => {
        const findings = findingsOf("const ls = localStorage; ls.getItem('scene');");
        expect(findings.map((f) => f.label)).toContain('localStorage');
      });

      it('flags `const h = history; h.state` through the alias', () => {
        const findings = findingsOf('const h = history; const s = h.state;');
        expect(findings.map((f) => f.label)).toContain('history.state');
      });

      it('flags `const doc = document; doc.cookie` through the alias', () => {
        const findings = findingsOf('const doc = document; const c = doc.cookie;');
        expect(findings.map((f) => f.label)).toContain('document.cookie');
      });

      it('flags `const proc = process; proc.env` through the alias', () => {
        const findings = findingsOf('const proc = process; const e = proc.env;');
        expect(findings.map((f) => f.label)).toContain('process.env');
      });

      it('flags `const proc = process; proc.argv` through the alias', () => {
        const findings = findingsOf('const proc = process; const a = proc.argv[0];');
        expect(findings.map((f) => f.label)).toContain('process.argv');
      });

      it('flags `const win = window; win.localStorage` through the global-wrapper alias', () => {
        const findings = findingsOf("const win = window; win.localStorage.getItem('scene');");
        expect(findings.map((f) => f.label)).toContain('localStorage');
      });

      it('flags `const root = globalThis; root.caches` through the global-wrapper alias', () => {
        const findings = findingsOf("const root = globalThis; root.caches.open('v1');");
        expect(findings.map((f) => f.label)).toContain('caches (Cache Storage)');
      });

      it('flags `const g = globalThis; g.history.state` through the global-wrapper alias', () => {
        const findings = findingsOf('const g = globalThis; const s = g.history.state;');
        expect(findings.map((f) => f.label)).toContain('history.state');
      });

      it('flags `const g = global; g.process.env` through the global-wrapper alias', () => {
        const findings = findingsOf('const g = global; const e = g.process.env;');
        expect(findings.map((f) => f.label)).toContain('process.env');
      });

      it('flags destructured `const { state } = history;`', () => {
        const findings = findingsOf('const { state } = history;');
        expect(findings.map((f) => f.label)).toContain('history.state (via destructuring)');
      });

      it('flags destructured `const { cookie } = document;`', () => {
        const findings = findingsOf('const { cookie } = document;');
        expect(findings.map((f) => f.label)).toContain('document.cookie (via destructuring)');
      });

      it('flags destructured `const { env } = process;`', () => {
        const findings = findingsOf('const { env } = process;');
        expect(findings.map((f) => f.label)).toContain('process.env (via destructuring)');
      });

      it('flags destructured `const { argv } = process;`', () => {
        const findings = findingsOf('const { argv } = process;');
        expect(findings.map((f) => f.label)).toContain('process.argv (via destructuring)');
      });

      it('flags destructured `const { state } = h;` after `const h = history;` (aliased root)', () => {
        const findings = findingsOf('const h = history; const { state } = h;');
        expect(findings.map((f) => f.label)).toContain('history.state (via destructuring)');
      });

      it('does NOT flag chained aliases — `const x = history.state` is a value read, not an alias of history', () => {
        // `const x = history.state` does NOT register `x` as an alias
        // of `history`; the existing root-property matcher catches the
        // `history.state` read at the binding site, so no further
        // tracking is needed. A subsequent `x.foo` is a property on a
        // non-aliased local and stays unflagged.
        const findings = findingsOf('const x = history.state; const y = x.foo;');
        const labels = findings.map((f) => f.label);
        expect(labels).toEqual(['history.state']);
        // Exactly one finding, on line 1, no spurious finding on line
        // 2 from a regression that mis-aliased `x`.
        expect(findings).toHaveLength(1);
        expect(findings[0]?.line).toBe(1);
      });
    });

    describe('wrapper-derived alias forms (cycle-2 coverage)', () => {
      // Codex review (cycle 2) flagged that `const h = window.history;
      // h.state` was not being caught because the initializer was a
      // property access rather than a bare identifier. The scanner
      // now resolves these wrapper-derived aliases the same way as
      // direct identifier aliases.
      it('flags `const h = window.history; h.state` through the wrapper-derived alias', () => {
        const findings = findingsOf('const h = window.history; const s = h.state;');
        expect(findings.map((f) => f.label)).toContain('history.state');
      });

      it('flags `const doc = globalThis.document; doc.cookie` through the wrapper-derived alias', () => {
        const findings = findingsOf('const doc = globalThis.document; const c = doc.cookie;');
        expect(findings.map((f) => f.label)).toContain('document.cookie');
      });

      it('flags `const proc = global.process; proc.env` through the wrapper-derived alias', () => {
        const findings = findingsOf('const proc = global.process; const e = proc.env;');
        expect(findings.map((f) => f.label)).toContain('process.env');
      });

      it('flags `const storage = window.localStorage; storage.getItem(...)` through the wrapper-derived alias', () => {
        const findings = findingsOf(
          "const storage = window.localStorage; storage.getItem('scene');",
        );
        expect(findings.map((f) => f.label)).toContain('localStorage');
      });

      it('flags `const storage = window["localStorage"]; storage.getItem(...)` through string-literal subscript alias', () => {
        const findings = findingsOf(
          `const storage = window['localStorage']; storage.getItem('scene');`,
        );
        expect(findings.map((f) => f.label)).toContain('localStorage');
      });
    });

    describe('aliased bare-global propagation (cycle-2 coverage)', () => {
      // Codex review (cycle 2) flagged that an allow-exempted binding
      // line could let a subsequent `storage.getItem('scene')` slip
      // through, because `[localStorage, getItem]` is not a length-1
      // bare-global match. The scanner now flags every access whose
      // first non-wrapper path segment is a forbidden bare-global
      // (after alias resolution), and every read of an alias whose
      // canonical resolves to a forbidden bare-global.
      it('flags `storage.getItem(scene)` even when the binding line is allow-exempted', () => {
        const findings = findingsOf(
          [
            'const storage = localStorage; // PUL-Q003-allow: ui pref only',
            "storage.getItem('scene');",
          ].join('\n'),
        );
        expect(findings.map((f) => f.label)).toContain('localStorage');
        // The single finding must land on line 2, not line 1 (which
        // is allow-exempted).
        expect(findings.filter((f) => f.label === 'localStorage')[0]?.line).toBe(2);
      });

      it('flags a bare-identifier read of an aliased bare-global (`const storage = localStorage; doThing(storage);`)', () => {
        const findings = findingsOf('const storage = localStorage; doThing(storage);');
        // Exactly two findings: one at the binding site
        // (`= localStorage`) and one at the aliased bare read
        // (`storage` inside `doThing(...)`). Asserting an exact count
        // catches a regression that exempted either site silently.
        const localStorageFindings = findings.filter((f) => f.label === 'localStorage');
        expect(localStorageFindings).toHaveLength(2);
      });

      it('flags `storage[key]` (computed bracket on aliased bare-global)', () => {
        // `const storage = localStorage; storage[key]` resolves to
        // `[localStorage, ???]` — the computed branch is a possible
        // bypass attempt against an aliased bare-global, and the
        // identifier `storage` itself is a forbidden read.
        const findings = findingsOf(
          'declare const key: string; const storage = localStorage; storage[key];',
        );
        expect(findings.map((f) => f.label)).toContain('localStorage');
      });
    });

    describe('computed access through aliased wrapper (cycle-2 coverage)', () => {
      // Codex review (cycle 2) flagged that `const win = window;
      // win[key]` was not being caught because the computed-wrapper
      // detector was checking the raw root identifier rather than
      // the alias-resolved canonical. The local replacement
      // (`isComputedRestrictedRootAccess`) consults the alias map.
      it('flags `win[key]` after `const win = window`', () => {
        const findings = findingsOf(
          'declare const key: string; const win = window; const x = win[key];',
        );
        expect(findings.map((f) => f.label)).toContain(
          'computed restricted-root access (possible persisted-state bypass)',
        );
      });

      it('flags `root[key]` after `const root = globalThis`', () => {
        const findings = findingsOf(
          'declare const key: string; const root = globalThis; const x = root[key];',
        );
        expect(findings.map((f) => f.label)).toContain(
          'computed restricted-root access (possible persisted-state bypass)',
        );
      });

      it('flags computed access on `import.meta` directly', () => {
        const findings = findingsOf("const v = import.meta['en' + 'v'];");
        expect(findings.map((f) => f.label)).toContain(
          'computed restricted-root access (possible persisted-state bypass)',
        );
      });

      it('flags computed access on an `import.meta` alias', () => {
        const findings = findingsOf(
          'declare const key: string; const meta = import.meta; const v = meta[key];',
        );
        expect(findings.map((f) => f.label)).toContain(
          'computed restricted-root access (possible persisted-state bypass)',
        );
      });
    });

    describe('destructuring of bare globals from a wrapper (cycle-2 coverage)', () => {
      // Codex review (cycle 2) flagged that
      // `const { localStorage } = window` reads a banned bare-global
      // but was being treated as a benign destructuring because the
      // matcher only checked the root.prop table, not the bare-global
      // table.
      it('flags `const { localStorage } = window`', () => {
        const findings = findingsOf('const { localStorage } = window;');
        expect(findings.map((f) => f.label)).toContain('localStorage (via destructuring)');
      });

      it('flags `const { caches } = globalThis`', () => {
        const findings = findingsOf('const { caches } = globalThis;');
        expect(findings.map((f) => f.label)).toContain(
          'caches (Cache Storage) (via destructuring)',
        );
      });

      it('flags `const { sessionStorage, indexedDB } = self`', () => {
        const findings = findingsOf('const { sessionStorage, indexedDB } = self;');
        const labels = findings.map((f) => f.label);
        expect(labels).toContain('sessionStorage (via destructuring)');
        expect(labels).toContain('indexedDB (via destructuring)');
      });
    });

    describe('string-literal destructuring keys (cycle-2 coverage)', () => {
      // Codex review (cycle 2) flagged that `const { 'cookie': c } =
      // document` was being skipped because the matcher only accepted
      // identifier keys. String-literal keys (`'cookie'`, `"state"`)
      // are now accepted.
      it("flags `const { 'cookie': c } = document`", () => {
        const findings = findingsOf("const { 'cookie': c } = document;");
        expect(findings.map((f) => f.label)).toContain('document.cookie (via destructuring)');
      });

      it('flags `const { "state": s } = history`', () => {
        const findings = findingsOf('const { "state": s } = history;');
        expect(findings.map((f) => f.label)).toContain('history.state (via destructuring)');
      });

      it("flags `const { 'env': e } = process`", () => {
        const findings = findingsOf("const { 'env': e } = process;");
        expect(findings.map((f) => f.label)).toContain('process.env (via destructuring)');
      });

      it("flags `const { 'localStorage': ls } = window`", () => {
        const findings = findingsOf("const { 'localStorage': ls } = window;");
        expect(findings.map((f) => f.label)).toContain('localStorage (via destructuring)');
      });
    });

    describe('assignment destructuring (cycle-2 coverage)', () => {
      // Codex review (cycle 2) flagged that destructuring assignment
      // (`({ state } = history);`) was being skipped because the
      // matcher only handled VariableDeclaration patterns. The
      // scanner now also handles BinaryExpression LHS object literals.
      it('flags `({ state } = history)`', () => {
        const findings = findingsOf('let state: unknown; ({ state } = history);');
        expect(findings.map((f) => f.label)).toContain('history.state (via destructuring)');
      });

      it('flags `({ cookie } = document)`', () => {
        const findings = findingsOf('let cookie: unknown; ({ cookie } = document);');
        expect(findings.map((f) => f.label)).toContain('document.cookie (via destructuring)');
      });

      it('flags `({ env } = process)`', () => {
        const findings = findingsOf('let env: unknown; ({ env } = process);');
        expect(findings.map((f) => f.label)).toContain('process.env (via destructuring)');
      });

      it('flags `({ localStorage } = window)`', () => {
        const findings = findingsOf('let localStorage: unknown; ({ localStorage } = window);');
        expect(findings.map((f) => f.label)).toContain('localStorage (via destructuring)');
      });

      it("flags `({ 'cookie': c } = document)`", () => {
        const findings = findingsOf("let c: unknown; ({ 'cookie': c } = document);");
        expect(findings.map((f) => f.label)).toContain('document.cookie (via destructuring)');
      });
    });

    describe('computed access on direct ambient roots (cycle-3 coverage)', () => {
      // Codex review (cycle 3) flagged that `history['st' + 'ate']`,
      // `document[key]`, and `process[key]` were silently passing
      // because the computed-restricted-root detector's direct-root
      // branch only accepted GLOBAL_WRAPPERS. ALIAS_ROOTS is the
      // correct superset for the direct-root check.
      it('flags `history["st" + "ate"]` (computed on direct ambient root)', () => {
        const findings = findingsOf("const s = history['st' + 'ate'];");
        expect(findings.map((f) => f.label)).toContain(
          'computed restricted-root access (possible persisted-state bypass)',
        );
      });

      it('flags `document["coo" + "kie"]` (computed on direct ambient root)', () => {
        const findings = findingsOf("const c = document['coo' + 'kie'];");
        expect(findings.map((f) => f.label)).toContain(
          'computed restricted-root access (possible persisted-state bypass)',
        );
      });

      it('flags `process[key]` (computed on direct ambient root)', () => {
        const findings = findingsOf('declare const key: string; const v = process[key];');
        expect(findings.map((f) => f.label)).toContain(
          'computed restricted-root access (possible persisted-state bypass)',
        );
      });

      it('flags `localStorage[key]` (computed on direct bare-global)', () => {
        const findings = findingsOf('declare const key: string; const v = localStorage[key];');
        expect(findings.map((f) => f.label)).toContain(
          'computed restricted-root access (possible persisted-state bypass)',
        );
      });
    });

    describe('chained aliases through aliased wrapper (cycle-3 coverage)', () => {
      // Codex review (cycle 3) flagged that
      // `const win = window; const h = win.history; h.state;` was not
      // being caught because `collectAliases` resolved property-access
      // initializers against the raw access path. The collector now
      // iterates to a fixed point and resolves the first segment
      // through the alias map at each pass, so chained aliases
      // resolve regardless of source order.
      it('flags `const win = window; const h = win.history; h.state` through the alias chain', () => {
        const findings = findingsOf(
          'const win = window; const h = win.history; const s = h.state;',
        );
        expect(findings.map((f) => f.label)).toContain('history.state');
      });

      it('flags `const root = globalThis; const proc = root.process; proc.env` through the alias chain', () => {
        const findings = findingsOf(
          'const root = globalThis; const proc = root.process; const e = proc.env;',
        );
        expect(findings.map((f) => f.label)).toContain('process.env');
      });

      it('flags `const root = globalThis; const doc = root.document; doc.cookie` through the alias chain', () => {
        const findings = findingsOf(
          'const root = globalThis; const doc = root.document; const c = doc.cookie;',
        );
        expect(findings.map((f) => f.label)).toContain('document.cookie');
      });

      it('flags `const w2 = win; w2.localStorage` after `const win = window` (alias of an alias)', () => {
        const findings = findingsOf(
          "const win = window; const w2 = win; w2.localStorage.getItem('scene');",
        );
        expect(findings.map((f) => f.label)).toContain('localStorage');
      });

      it('flags chained aliases declared in reverse order (`const h = win.history; const win = window;`)', () => {
        // Fixed-point iteration must handle the case where the alias
        // chain's dependency declaration appears AFTER the dependent
        // declaration in source order. Without fixed-point this
        // would only register `win` on pass 1 and miss `h` entirely.
        const findings = findingsOf(
          'const h = win.history; const win = window; const s = h.state;',
        );
        expect(findings.map((f) => f.label)).toContain('history.state');
      });
    });

    describe('destructured ambient-root aliases from wrappers (cycle-3 coverage)', () => {
      // Codex review (cycle 3) flagged that
      // `const { history: h } = window; h.state;` was not being
      // caught because the destructuring path only registered
      // forbidden bare-global aliases. The collector now registers
      // ambient-root aliases from wrapper destructuring so
      // `history`/`document`/`process` destructured out of a wrapper
      // are tracked the same way as a direct identifier alias.
      it('flags `const { history: h } = window; h.state`', () => {
        const findings = findingsOf('const { history: h } = window; const s = h.state;');
        expect(findings.map((f) => f.label)).toContain('history.state');
      });

      it('flags `const { document: doc } = globalThis; doc.cookie`', () => {
        const findings = findingsOf('const { document: doc } = globalThis; const c = doc.cookie;');
        expect(findings.map((f) => f.label)).toContain('document.cookie');
      });

      it('flags `const { process: proc } = globalThis; proc.env`', () => {
        const findings = findingsOf('const { process: proc } = globalThis; const e = proc.env;');
        expect(findings.map((f) => f.label)).toContain('process.env');
      });

      it('flags `const { history } = window; history.state` (shorthand destructuring)', () => {
        // The destructured binding name `history` shadows the global
        // `history` in this scope, but the value it refers to IS the
        // global's `history` property. Tracking the alias keeps the
        // surface read flagged on the shadowed identifier.
        const findings = findingsOf('const { history } = window; const s = history.state;');
        expect(findings.map((f) => f.label)).toContain('history.state');
      });

      it('flags destructured wrapper-property alias through an aliased wrapper (`const root = globalThis; const { history: h } = root; h.state;`)', () => {
        const findings = findingsOf(
          'const root = globalThis; const { history: h } = root; const s = h.state;',
        );
        expect(findings.map((f) => f.label)).toContain('history.state');
      });
    });

    describe('import.meta full coverage (cycle-2 coverage)', () => {
      // Codex review (cycle 2) flagged that `import.meta.env` was
      // only enforced in the direct-access form. Alias propagation,
      // destructuring, and computed-access coverage now apply
      // uniformly because `import.meta` is in the unified
      // `FORBIDDEN_ROOT_PROPERTY_PAIRS` table and in `ALIAS_ROOTS`.
      it('flags `const meta = import.meta; meta.env.VITE_SCENE` through alias', () => {
        const findings = findingsOf('const meta = import.meta; const v = meta.env.VITE_SCENE;');
        expect(findings.map((f) => f.label)).toContain('import.meta.env');
      });

      it('flags `const { env } = import.meta`', () => {
        const findings = findingsOf('const { env } = import.meta;');
        expect(findings.map((f) => f.label)).toContain('import.meta.env (via destructuring)');
      });

      it("flags `const { 'env': e } = import.meta`", () => {
        const findings = findingsOf("const { 'env': e } = import.meta;");
        expect(findings.map((f) => f.label)).toContain('import.meta.env (via destructuring)');
      });

      it('flags `({ env } = import.meta)`', () => {
        const findings = findingsOf('let env: unknown; ({ env } = import.meta);');
        expect(findings.map((f) => f.label)).toContain('import.meta.env (via destructuring)');
      });

      it('flags `const { env } = meta` after `const meta = import.meta`', () => {
        const findings = findingsOf('const meta = import.meta; const { env } = meta;');
        expect(findings.map((f) => f.label)).toContain('import.meta.env (via destructuring)');
      });
    });

    describe('TypeScript wrapper unwrapping', () => {
      it.each([
        ['(localStorage).getItem("x");', 'localStorage'],
        ['(window as any).localStorage.getItem("x");', 'localStorage'],
        ['(globalThis as Record<string, unknown>).indexedDB;', 'indexedDB'],
        ['(history!.state);', 'history.state'],
        ['(document satisfies object).cookie;', 'document.cookie'],
      ])('unwraps wrapper expressions — `%s`', (source, label) => {
        const findings = findingsOf(source);
        expect(findings.map((f) => f.label)).toContain(label);
      });
    });

    describe('object shorthand', () => {
      // `{ localStorage }` is `{ localStorage: localStorage }` — a
      // value-position read of the identifier. The screenshot-
      // determinism scan has the same precedent for `setTimeout` etc.
      it('flags `{ localStorage }` shorthand read', () => {
        const findings = findingsOf('const ref = { localStorage };');
        expect(findings.map((f) => f.label)).toContain('localStorage');
      });

      it('flags `{ caches }` shorthand read', () => {
        const findings = findingsOf('const ref = { caches };');
        expect(findings.map((f) => f.label)).toContain('caches (Cache Storage)');
      });
    });

    describe('false-positive defense', () => {
      it.each([
        // root-anchoring prevents non-global object graphs from triggering
        [
          'fixture.history.state',
          'declare const fixture: { history: { state: number } }; const s = fixture.history.state;',
        ],
        [
          'snapshot.document.cookie',
          'declare const snapshot: { document: { cookie: string } }; const c = snapshot.document.cookie;',
        ],
        [
          'obj.localStorage',
          'declare const obj: { localStorage: { getItem(k: string): string } }; obj.localStorage.getItem("scene");',
        ],
        [
          'obj.caches',
          'declare const obj: { caches: { open(k: string): void } }; obj.caches.open("v1");',
        ],
        [
          'fixture.process.env',
          'declare const fixture: { process: { env: Record<string, string> } }; const e = fixture.process.env;',
        ],
        [
          'shim.process.argv',
          'declare const shim: { process: { argv: string[] } }; const a = shim.process.argv;',
        ],
      ])('does NOT flag %s (root is not an ambient global)', (_label, source) => {
        const findings = findingsOf(source);
        expect(findings).toEqual([]);
      });

      it('does NOT flag a non-banned `process` member (e.g. `process.cwd`)', () => {
        // Q003 only bans `process.env` and `process.argv`. Other
        // members (`process.cwd`, `process.platform`, `process.version`)
        // are not host-state hazards in the same way and must not
        // false-positive.
        expect(findingsOf('const d = process.cwd();')).toEqual([]);
        expect(findingsOf('const p = process.platform;')).toEqual([]);
      });

      it('does NOT flag a non-banned `import.meta` member (e.g. `import.meta.url`)', () => {
        // Only `import.meta.env` is banned; `import.meta.url` is the
        // module's own URL (used legitimately by `fileURLToPath` etc.).
        expect(findingsOf('const u = import.meta.url;')).toEqual([]);
      });

      it('does NOT flag `history.pushState` (URL mutator, not persisted-state read)', () => {
        const findings = findingsOf("history.pushState({}, '', '/scene/intro');");
        expect(findings.map((f) => f.label)).not.toContain('history.state');
        expect(findings).toEqual([]);
      });

      it('does NOT flag `history.replaceState` (URL mutator)', () => {
        const findings = findingsOf("history.replaceState({}, '', '/scene/intro');");
        expect(findings).toEqual([]);
      });

      it('does NOT flag forbidden vocabulary inside a `//` comment', () => {
        expect(findingsOf('// localStorage and document.cookie are forbidden')).toEqual([]);
      });

      it('does NOT flag forbidden vocabulary inside a `/* */` block comment', () => {
        expect(findingsOf('/* localStorage, history.state. */ const x = 1;')).toEqual([]);
      });

      it('does NOT flag forbidden vocabulary inside a string literal', () => {
        const findings = findingsOf('const note = "localStorage is forbidden";');
        expect(findings).toEqual([]);
      });

      it('does NOT flag `localStorage` used as a type member name', () => {
        const findings = findingsOf(
          'interface Storage { localStorage(): string; cookie: string; }',
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag `typeof localStorage` in a type alias', () => {
        const findings = findingsOf('type LS = typeof localStorage;');
        expect(findings).toEqual([]);
      });

      it('does NOT flag the property name `cookie` in a property assignment', () => {
        const findings = findingsOf('const obj = { cookie: 1 };');
        expect(findings).toEqual([]);
      });

      it('does NOT flag a method named `localStorage` on a class', () => {
        const findings = findingsOf('class C { localStorage() { return ""; } }');
        expect(findings).toEqual([]);
      });
    });

    describe('exemption marker', () => {
      it('honors `// PUL-Q003-allow: <reason>` on the same line', () => {
        const findings = findingsOf(
          'localStorage.setItem("ui-pref", "x"); // PUL-Q003-allow: UI preference, not target state',
        );
        expect(findings).toEqual([]);
      });

      it('rejects an empty rationale', () => {
        const findings = findingsOf('localStorage.getItem("x"); // PUL-Q003-allow:');
        expect(findings.map((f) => f.label)).toContain('localStorage');
      });

      it('rejects a whitespace-only rationale', () => {
        const findings = findingsOf('localStorage.getItem("x"); // PUL-Q003-allow:   ');
        expect(findings.map((f) => f.label)).toContain('localStorage');
      });

      it('rejects a marker hidden inside a string literal', () => {
        const findings = findingsOf(
          `const note = "// PUL-Q003-allow: hidden"; localStorage.getItem('x');`,
        );
        expect(findings.map((f) => f.label)).toContain('localStorage');
      });

      it('does NOT honor a marker on a different line (line-scoped)', () => {
        const src = '// PUL-Q003-allow: see above\nlocalStorage.getItem("x");';
        const findings = findingsOf(src);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.line).toBe(2);
      });
    });

    describe('reporting', () => {
      it('reports the 1-based line and file path on every finding', () => {
        const src = 'const a = 1;\nconst b = 2;\nlocalStorage.getItem("x");\nconst c = 3;';
        const findings = findingsOf(src, 'src/runtime/example.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
          file: 'src/runtime/example.ts',
          line: 3,
          label: 'localStorage',
        });
      });

      it('reports findings across multiple lines independently', () => {
        const src = 'localStorage.getItem("a");\nconst c = document.cookie;';
        const findings = findingsOf(src);
        expect(findings).toHaveLength(2);
        // Label assertions pin the label-attribution contract: a
        // regression that swapped the labels (or corrupted one) would
        // pass a line-count-only check but fail here.
        expect(findings[0]).toMatchObject({ line: 1, label: 'localStorage' });
        expect(findings[1]).toMatchObject({ line: 2, label: 'document.cookie' });
      });
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('scan root `src/` exists and contains at least one .ts file', () => {
      expect(statSync(SRC_ROOT).isDirectory()).toBe(true);
      expect(walkTsFiles(SRC_ROOT).length).toBeGreaterThan(0);
    });

    it('contains no Q003 violations across `src/**/*.ts`', () => {
      const files = walkTsFiles(SRC_ROOT);
      const findings: SourceFinding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        findings.push(...scanQ003(parseSource(text, rel)));
      }
      const header =
        'PUL-Q003 forbids `localStorage`, `sessionStorage`, `document.cookie`, `history.state`, `indexedDB`, and `caches` (Cache Storage) reads in runtime source — those surfaces must not determine the targeted scene, beat, composition, or mode. Add a `// PUL-Q003-allow: <reason>` exemption on the same line if the use is documented non-target state.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });
  });
});
