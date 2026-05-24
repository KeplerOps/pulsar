// Shared helpers for the PUL-Q007 / PUL-A001..A006 source-policy gates.
//
// The seven runtime-policy bans (#46 + #50..#55) share one enforcement
// shape: a Vitest scan over executable source modules under `src/`
// that flags forbidden constructions (Q007 — `eval`, `new Function`,
// remote dynamic `import()`) or forbidden module specifiers in a given
// file scope (A001..A004, A006). PUL-A005 is the
// composition-declarativeness check; it reuses the AST helpers below
// for top-level-statement classification but supplies its own decision.
//
// This file is the shared seam the preflights authorized:
// `docs/design/pul-q007-runtime-code-execution-preflight.md`:
//   "the shared seam should be a forbidden-surface table plus matcher
//   helpers. Keep the scanner generic enough that the A-series import
//   bans can add policy tables without duplicating the walker or
//   diagnostics."
//
// It is intentionally a `.ts` helper (NOT a `.test.ts`) so vitest's
// glob (`tests/**/*.test.ts`) does not try to run it as a suite. Each
// per-policy test file imports from here.

import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

// --- Finding shape ----------------------------------------------------

export interface SourceFinding {
  readonly file: string; // path relative to the repo root
  readonly line: number; // 1-based
  readonly text: string; // trimmed source line (no AST dumps, no raw blobs)
  readonly label: string; // policy-defined short label
}

// --- Filesystem driver ------------------------------------------------

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SRC_ROOT = join(REPO_ROOT, 'src');
export const SOURCE_POLICY_EXTENSIONS = Object.freeze([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
] as const);

/**
 * True when a file is executable source that Vite/esbuild can bundle
 * from `src/`. Type declaration files are excluded even though their
 * suffixes end in `.ts` / `.mts` / `.cts`; they are not runtime code.
 */
export function isSourcePolicyFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')) {
    return false;
  }
  return SOURCE_POLICY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Walk a directory recursively, returning every executable source
 * module file found. Skips dotfiles (e.g., `.DS_Store`, `.gitignore`).
 * Generated trees (`coverage/`, `dist/`) live OUTSIDE the scanned
 * root, so they are out of scope by construction.
 */
export function walkSourceFiles(root: string, excludes: readonly string[] = []): string[] {
  const isExcluded = (absolutePath: string): boolean => {
    const rel = relative(REPO_ROOT, absolutePath);
    return excludes.some((ex) => rel === ex || rel.startsWith(`${ex}/`));
  };
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.')) continue;
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkSourceFiles(full, excludes));
    } else if (st.isFile() && isSourcePolicyFile(full)) {
      if (!isExcluded(full)) out.push(full);
    }
  }
  return out;
}

// --- AST helpers ------------------------------------------------------

/**
 * Strip TypeScript wrappers that do not change the runtime value:
 * parentheses, `as` assertions, legacy `<T>x` type assertions, non-null
 * `!`, and `satisfies`. Used so policies that match an underlying
 * expression shape (e.g., dynamic `import(...)` argument) don't slip
 * past when a refactor adds a wrapper.
 */
export function unwrap(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Return true when `node` lives in a TypeScript type position. The
 * policy gates only flag value-position constructions; an
 * `import('./mod').Type` reference inside a `TypeReferenceNode`, an
 * `interface` body member name, or a `typeof X` annotation is a
 * compile-time-only artifact and is not a runtime-policy violation.
 */
export function isInTypePosition(node: ts.Node): boolean {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (
      ts.isTypeNode(n) ||
      ts.isTypeAliasDeclaration(n) ||
      ts.isInterfaceDeclaration(n) ||
      ts.isTypeReferenceNode(n) ||
      ts.isTypeLiteralNode(n) ||
      ts.isImportTypeNode(n)
    ) {
      return true;
    }
    n = n.parent;
  }
  return false;
}

/**
 * Read the 0-indexed line `lineIndex0` from the source file's text and
 * return it trimmed. Used for the bounded line-text portion of a
 * finding; never expand to surrounding context.
 */
export function lineText(sourceFile: ts.SourceFile, lineIndex0: number): string {
  const lines = sourceFile.text.split('\n');
  return lines[lineIndex0] ?? '';
}

/**
 * Build a `ts.SourceFile` with parent pointers populated so type-
 * position and parent-shape predicates work.
 */
export function parseSource(text: string, file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /*setParentNodes=*/ true,
    scriptKindForFile(file),
  );
}

function scriptKindForFile(file: string): ts.ScriptKind {
  const lower = file.toLowerCase();
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

// --- Line-scoped exemption parser -------------------------------------

/**
 * Collect every 0-indexed line that carries a single-line comment
 * matching `// <allowTag>: <non-empty reason>`. A marker hidden inside
 * a string literal is NOT honored — the TypeScript scanner classifies
 * tokens, so we only see the marker text on actual comment tokens.
 *
 * Each per-policy file passes its own `allowTag` (e.g., `PUL-Q007-allow`).
 * Reuse for line-scoping discipline: a broad file-level allowlist is
 * intentionally NOT supported.
 */
export function collectLineExemptions(sourceFile: ts.SourceFile, allowTag: string): Set<number> {
  // Build the regex once per call to keep the helper pure of policy
  // state. `\\S` requires at least one non-whitespace character after
  // the colon so empty / whitespace-only rationales are rejected.
  const escaped = allowTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}:\\s*\\S`);
  const exempted = new Set<number>();
  const text = sourceFile.text;
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /*skipTrivia=*/ false,
    ts.LanguageVariant.Standard,
    text,
  );
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia) {
      const tokenText = scanner.getTokenText();
      if (re.test(tokenText)) {
        const start = scanner.getTokenStart();
        const { line } = sourceFile.getLineAndCharacterOfPosition(start);
        exempted.add(line);
      }
    }
    token = scanner.scan();
  }
  return exempted;
}

// --- Dynamic-import-specifier classification --------------------------

/**
 * Classification of the argument to a `import(specifier)` call.
 *
 * - `static-local-package`: a string literal that is unambiguously a
 *   LOCAL module reference — either a relative path (`./x`, `../x`) or
 *   a bare npm-style package specifier with no URL scheme, no
 *   protocol-relative prefix, and no absolute filesystem path. These
 *   resolve at bundle time and never inject runtime-external code.
 *
 * - `static-remote-url`: every other static-string form, including:
 *     * `http:` / `https:` URLs
 *     * protocol-relative (`//cdn.example/x.js`)
 *     * any other URL scheme — `data:`, `blob:`, `file:`, `node:`,
 *       `chrome-extension:`, etc.
 *     * absolute filesystem paths (`/abs/path`)
 *   The PUL-Q007 statement explicitly bans "any equivalent mechanism
 *   that would execute code not present in the published bundle." A
 *   `data:` / `blob:` literal executes runtime-supplied code; a
 *   `file:` literal pulls code from outside the bundle; `node:`
 *   dynamic imports don't belong in browser-targeted runtime. All are
 *   the same class of hazard as an `http(s):` literal.
 *
 * - `non-static`: a template literal with substitutions, an
 *   identifier read, a property access, a computed expression, etc.
 *   Classified as non-static even if today's value happens to be
 *   local; PUL-Q007 treats this as forbidden because the surface
 *   creates a surprise execution path.
 */
export type ImportSpecifierKind = 'static-local-package' | 'static-remote-url' | 'non-static';

// Bare-package-specifier predicate. Accepts:
//   - `pkg`
//   - `pkg/subpath`
//   - `@scope/pkg`
//   - `@scope/pkg/subpath`
// Rejects: leading `/`, scheme prefixes (`data:`, `node:`, `https:`),
// protocol-relative `//`, whitespace, query/hash characters. Local
// relative paths (`./`, `../`) are handled separately above.
const BARE_PACKAGE_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._\-/]*)?$/i;

function classifyStaticSpecifierString(value: string): ImportSpecifierKind {
  if (value === '') return 'static-remote-url';
  if (value.startsWith('./') || value.startsWith('../')) return 'static-local-package';
  if (value.startsWith('/')) return 'static-remote-url'; // catches '//cdn/...' and '/abs/path'
  // Any URL scheme — `http:`, `https:`, `data:`, `blob:`, `file:`,
  // `node:`, etc. The TS scheme grammar is `[a-zA-Z][a-zA-Z0-9+.-]*:`.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return 'static-remote-url';
  if (BARE_PACKAGE_RE.test(value)) return 'static-local-package';
  return 'static-remote-url';
}

export function classifyImportSpecifier(arg: ts.Expression): ImportSpecifierKind {
  const inner = unwrap(arg);
  if (ts.isStringLiteral(inner)) {
    return classifyStaticSpecifierString(inner.text);
  }
  // Template literals with NO substitutions are technically a static
  // string; classify them by their cooked value the same way.
  if (ts.isNoSubstitutionTemplateLiteral(inner)) {
    return classifyStaticSpecifierString(inner.text);
  }
  return 'non-static';
}

/**
 * True when the call expression is a runtime-value dynamic `import(...)`.
 * `ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword`.
 * Type-position `import('./mod').T` is an `ImportTypeNode`, NOT a
 * `CallExpression`, and is handled by `isInTypePosition`.
 */
export function isDynamicImportCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

// --- Access-path resolution (shared between Q007 and A002) ------------

/**
 * Recognised global wrappers that can carry forbidden names as their
 * own properties: `globalThis.eval`, `window.Audio`, `self.Function`,
 * etc. Limited to these four names so an unrelated object that happens
 * to expose a forbidden property is not flagged.
 */
export const GLOBAL_WRAPPERS: ReadonlySet<string> = new Set([
  'globalThis',
  'window',
  'self',
  'global',
]);

/**
 * Resolve `expr` to a list of access-path segments anchored on the
 * outermost identifier (or `import.meta`). Wrappers (parentheses /
 * `as` / `!` / `satisfies`) are stripped via `unwrap`. Computed bracket
 * access with a non-literal subscript bails out — it cannot be
 * statically classified — and returns `null`.
 *
 * `getAccessPath(globalThis.window.Audio)` → `['globalThis', 'window', 'Audio']`
 * `getAccessPath(obj['foo'])` (with literal subscript) → `['obj', 'foo']`
 * `getAccessPath(obj[k])` (computed subscript) → `null`
 */
export function getAccessPath(expr: ts.Expression): readonly string[] | null {
  const parts: string[] = [];
  let current: ts.Expression = expr;
  while (true) {
    current = unwrap(current);
    if (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text);
      current = current.expression;
    } else if (ts.isElementAccessExpression(current)) {
      const arg = unwrap(current.argumentExpression);
      if (ts.isStringLiteralLike(arg)) {
        parts.unshift(arg.text);
        current = current.expression;
      } else {
        return null;
      }
    } else if (ts.isIdentifier(current)) {
      parts.unshift(current.text);
      return parts;
    } else if (ts.isMetaProperty(current)) {
      parts.unshift('import.meta');
      return parts;
    } else {
      return null;
    }
  }
}

/**
 * True when `path` resolves to `target` once any leading recognised
 * global-wrapper segments are stripped. Used by Q007 and A002 to
 * detect both bare (`eval`, `Audio`) and global-wrapped
 * (`globalThis.eval`, `window.Audio`, `self.HTMLAudioElement`) forms
 * with one helper.
 *
 * `pathResolvesTo(['eval'], 'eval')` → true
 * `pathResolvesTo(['globalThis', 'window', 'Audio'], 'Audio')` → true
 * `pathResolvesTo(['obj', 'Audio'], 'Audio')` → false
 *   (root `obj` is not a recognised global wrapper)
 */
export function pathResolvesTo(path: readonly string[], target: string): boolean {
  let start = 0;
  while (start < path.length && GLOBAL_WRAPPERS.has(path[start] ?? '')) {
    start += 1;
  }
  const tail = path.slice(start);
  return tail.length === 1 && tail[0] === target;
}

/**
 * True when `expr` is a computed member access (`<obj>[<expr>]` or
 * `<obj>.<...>[<expr>]`) whose root identifier — after walking back
 * through static property/literal-element accesses — is a recognised
 * global wrapper. Used by Q007 / A002 to flag potentially-evasive
 * forms like `globalThis['ev' + 'al']('x')` or
 * `window['Aud' + 'io']('clip')` that hide a forbidden identifier
 * behind a non-literal subscript.
 *
 * Strictly conservative: any computed segment in the chain whose
 * subscript is not a string-literal causes the function to return
 * `true` only when the root identifier is a global wrapper. Computed
 * access on a non-global root (`obj[k]`) is NOT flagged — the policies
 * intentionally allow arbitrary indexing on non-global locals.
 */
export function isComputedGlobalWrapperAccess(expr: ts.Expression): boolean {
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
  return ts.isIdentifier(current) && GLOBAL_WRAPPERS.has(current.text);
}

// --- Import-ban matcher (A001..A004, A006) ----------------------------

/**
 * A single import-ban rule.
 *
 * `specifiers` is the exact set of forbidden module specifiers, with
 * a trailing `/` matching every subpath: `'gsap/'` would match
 * `'gsap/Draggable'`, `'gsap/all'`, etc. The bare specifier
 * (`'gsap'`) is matched literally. Use both forms together when the
 * package and its subpaths should all be forbidden.
 *
 * `boundaries` is the optional escape-hatch list: files inside these
 * relative paths (matched by exact equality OR `startsWith(prefix +
 * '/')` for directory boundaries) are allowed to import the
 * specifiers. For PUL-A001 the boundary is `src/runtime/timeline.ts`
 * — the adapter module.
 *
 * `allowTag` is the line-comment marker used to opt out a single
 * line (e.g., `PUL-A001-allow`). Empty rationales are rejected by
 * `collectLineExemptions`.
 */
export interface ImportBanRule {
  readonly label: string; // appears on findings
  readonly specifiers: readonly string[]; // exact specifiers; '<pkg>/' = subpath wildcard
  readonly boundaries: readonly string[]; // files / dirs that may import (repo-relative)
  readonly allowTag: string;
}

/**
 * True when `specifier` matches any entry in `specifiers`. A trailing
 * slash in a rule entry (`'gsap/'`) is a directory wildcard matching
 * every `gsap/...` subpath.
 */
export function specifierMatches(specifier: string, specifiers: readonly string[]): boolean {
  for (const entry of specifiers) {
    if (entry.endsWith('/')) {
      if (specifier.startsWith(entry)) return true;
    } else if (specifier === entry) {
      return true;
    }
  }
  return false;
}

/**
 * True when `filePath` falls inside the rule's `boundaries`
 * escape-hatch list. A boundary may be a single file path
 * (`src/runtime/timeline.ts`) or a directory prefix
 * (`src/runtime/` → matches every file under `src/runtime/`).
 *
 * Accepts either an absolute path or a repo-relative path. The
 * per-policy runtime-tree scans in this directory build `SourceFile`s
 * with repo-relative names (so the diagnostic shows
 * `src/runtime/x.ts` instead of `/home/user/.../src/runtime/x.ts`),
 * while the unit-test exercises pass absolute paths through
 * `join(SRC_ROOT, ...)`. Normalising both shapes here keeps the
 * `boundaries` contract working for callers that follow either
 * pattern.
 */
export function isInBoundary(filePath: string, boundaries: readonly string[]): boolean {
  const rel = isAbsolute(filePath) ? relative(REPO_ROOT, filePath) : filePath;
  for (const b of boundaries) {
    if (b.endsWith('/')) {
      if (rel === b.slice(0, -1) || rel.startsWith(b)) return true;
    } else if (rel === b) {
      return true;
    }
  }
  return false;
}

/**
 * Scan `source` for static and dynamic imports whose specifier matches
 * the rule's `specifiers`. Returns findings in source order. Does not
 * check the line-exemption set — the caller decides how to combine
 * exemption with the rule (some rules want exemptions per-policy, not
 * shared with other policies in the same file).
 *
 * Both `import 'gsap'` and `import('gsap')` are flagged. Type-only
 * imports (`import type X from 'gsap'`) are also flagged: an
 * `ImportDeclaration` with `importClause.isTypeOnly === true` still
 * surfaces the library specifier to the scene module and gives an
 * authoring shortcut around the encapsulation boundary; the
 * preflights name this explicitly.
 */
export function scanImportSpecifiers(
  sourceFile: ts.SourceFile,
  rule: ImportBanRule,
  exemptedLines: Set<number>,
): SourceFinding[] {
  const findings: SourceFinding[] = [];
  const file = sourceFile.fileName;
  // A file inside the rule's escape-hatch boundary list is allowed
  // to import the forbidden specifiers — that is the entire point of
  // the boundary concept (e.g., `src/runtime/timeline.ts` is PUL-A001's
  // boundary). Return an empty findings list without walking the file.
  // Per-policy tests in this repo all set `boundaries: []` and rely on
  // file-scope exclusion instead, but the shared helper has to honour
  // its own advertised contract for any future caller that supplies a
  // boundary — otherwise the boundary field is documentation that does
  // not behave the way the docs claim.
  if (isInBoundary(file, rule.boundaries)) {
    return findings;
  }
  const recordIfMatch = (node: ts.Node, specifier: string, suffix: string): void => {
    if (!specifierMatches(specifier, rule.specifiers)) return;
    const start = node.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    if (exemptedLines.has(line)) return;
    findings.push({
      file,
      line: line + 1,
      text: lineText(sourceFile, line).trim(),
      label: `${rule.label} ${suffix}`,
    });
  };

  const visit = (node: ts.Node): void => {
    // Static `import ... from 'x'`
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec)) {
        const kind = node.importClause?.isTypeOnly ? '(type-only import)' : '(static import)';
        recordIfMatch(node, spec.text, kind);
      }
    }
    // `import x = require('y')` — uncommon in ESM but covered.
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteral(expr)) {
        recordIfMatch(node, expr.text, '(import equals require)');
      }
    }
    // `export ... from 'x'` and `export * from 'x'`
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      recordIfMatch(node, node.moduleSpecifier.text, '(re-export)');
    }
    // Dynamic `import('x')` — value position only; type-position
    // `import('./mod').Type` is an ImportTypeNode handled by
    // `isInTypePosition`.
    if (isDynamicImportCall(node) && !isInTypePosition(node)) {
      const arg = node.arguments[0];
      if (arg) {
        const kind = classifyImportSpecifier(arg);
        if (kind === 'static-local-package') {
          const inner = unwrap(arg);
          // `unwrap` and `isStringLiteralLike` already validated above.
          if (ts.isStringLiteralLike(inner)) {
            recordIfMatch(node, inner.text, '(dynamic import)');
          }
        }
        // Non-static and remote-url specifiers are not import-ban
        // matches — they are PUL-Q007's concern. Don't double-count.
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
