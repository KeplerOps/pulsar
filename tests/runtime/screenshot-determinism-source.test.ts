import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

// PUL-Q001 — screenshot determinism source scan.
//
// PUL-Q001's clause: "For a given code revision and a given workbench
// URL with `mode=screenshot`, the rendered output SHALL be byte-
// identical across reloads on the same browser engine and platform."
//
// Byte-identical output requires the runtime/scene/composition source
// to be free of wall-clock and ambient-state primitives that would
// inject entropy into the captured frame. ADR-007's screenshot
// determinism contract and `.gc/plan-rules.md`'s screenshot-determinism
// rule both forbid these primitives in scene and runtime code; this
// test makes the rule structurally enforceable so a regression cannot
// silently land.
//
// Scope: all `.ts` files under `src/`. Generated artifacts
// (`coverage/`, `dist/`), declared configs (`vite.config.ts`,
// `vitest.config.ts`), and tests are out of scope — tests legitimately
// use `Date.now()` for synthetic timestamps, and configs do not
// influence captured rendering.
//
// Detection: the scanner uses the TypeScript compiler API to walk the
// AST. Each forbidden surface is matched as a semantic access path
// — root-anchored on either the ambient global identifier itself
// (`Math`, `Date`, `performance`, `crypto`, `document`, `history`,
// `process`) or a recognised global wrapper (`globalThis`, `window`,
// `self`, `global`). Suffix-only matching (e.g., flagging
// `snapshot.history.state` because it ends in `[history, state]`)
// would produce false positives on ordinary data graphs; the
// scanner therefore requires the root of every flagged access to
// resolve to a known ambient global, directly or through a file-
// local alias.
//
// Equivalent spellings covered:
//   - direct property access (`Math.random`)
//   - element access with string-literal / template-literal subscript
//     (`Date['now']`, `Date[\`now\`]`)
//   - global-wrapper access (`globalThis.Math.random`,
//     `window.localStorage`, `self.setTimeout`)
//   - file-local aliasing (`const m = Math; m.random()`,
//     `const D = Date; new D()`)
//   - destructuring (`const { random } = Math; random();`)
//   - parenthesized / `as` / non-null / `satisfies` / type-assertion
//     wrappers (`(Math).random()`, `(Date as unknown as DateCtor).now()`,
//     `performance!.now()`)
//   - optional chaining (`el?.animate(...)`, `el?.['animate'](...)`)
//   - object-shorthand property reads (`return { localStorage }`)
//
// Exemption: a line carrying a real `// PUL-Q001-allow: <reason>`
// line comment (with at least one non-whitespace character after the
// colon) is intentionally excluded from the scan. The exemption is
// line-scoped to keep approval narrow and visible in code review.
// Exempted lines are determined from TS comment ranges attached to
// AST nodes, so a marker hidden inside a string literal is NOT honored.

interface SourceFinding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly label: string;
}

// --- Forbidden semantic surfaces ---

// Ambient-global roots that carry nondeterministic data. A property
// or element access against any of these roots — directly, through a
// recognised global wrapper, or through a file-local alias — is a
// determinism hazard for the specific properties listed below.
const FORBIDDEN_ROOT_PROPERTIES: readonly {
  readonly root: string;
  readonly prop: string;
  readonly label: string;
}[] = [
  { root: 'Math', prop: 'random', label: 'Math.random' },
  { root: 'Date', prop: 'now', label: 'Date.now' },
  { root: 'performance', prop: 'now', label: 'performance.now' },
  { root: 'crypto', prop: 'getRandomValues', label: 'crypto.getRandomValues' },
  { root: 'document', prop: 'cookie', label: 'document.cookie' },
  { root: 'history', prop: 'state', label: 'history.state' },
  { root: 'process', prop: 'env', label: 'process.env' },
  { root: 'process', prop: 'argv', label: 'process.argv' },
];

// Set of all ambient roots referenced by the table above. A bare
// identifier read of one of these names that isn't followed by an
// allowed deterministic member is still suspect, but the scan flags
// access to the listed properties only; `Math` by itself is not a
// hazard (e.g., `Math.floor` is deterministic).
const FORBIDDEN_ROOTS = new Set(FORBIDDEN_ROOT_PROPERTIES.map((e) => e.root));

// Ambient globals that can carry the forbidden roots as their own
// properties (`globalThis.Math`, `window.crypto`, `self.localStorage`,
// `global.setTimeout`). The scan allows one of these as the outer
// segment when matching an access path.
const GLOBAL_ROOTS = new Set(['globalThis', 'window', 'self', 'global']);

// Direct identifier references that are forbidden as value reads.
// Each entry is also matched as `<GLOBAL_ROOT>.<name>` so
// `globalThis.localStorage`, `window.setTimeout`, etc. are caught.
const FORBIDDEN_GLOBAL_IDENTIFIERS: readonly { readonly name: string; readonly label: string }[] = [
  { name: 'localStorage', label: 'localStorage' },
  { name: 'sessionStorage', label: 'sessionStorage' },
  { name: 'requestAnimationFrame', label: 'requestAnimationFrame' },
  { name: 'setTimeout', label: 'setTimeout' },
  { name: 'setInterval', label: 'setInterval' },
];
const FORBIDDEN_GLOBAL_IDENTIFIER_NAMES = new Set(FORBIDDEN_GLOBAL_IDENTIFIERS.map((e) => e.name));
const FORBIDDEN_GLOBAL_IDENTIFIER_LABEL_BY_NAME = new Map(
  FORBIDDEN_GLOBAL_IDENTIFIERS.map((e) => [e.name, e.label]),
);

// Property-access leaf names whose semantic is animation orchestration
// against wall-clock time. `Element.prototype.animate(…)` introduces a
// CSS Web Animations API timeline; the captured frame would depend on
// when the capture fires relative to the animation start time. The
// scan flags ANY READ of the leaf name (property access, element
// access with a string-literal subscript, optional chaining) — not
// only immediate dot-calls — so `const animate = el.animate` and
// `el?.['animate'](...)` are caught alongside `el.animate(...)`.
const FORBIDDEN_LEAF_NAMES: readonly { readonly name: string; readonly label: string }[] = [
  { name: 'animate', label: 'Element.animate' },
];
const FORBIDDEN_LEAF_LABEL_BY_NAME = new Map(FORBIDDEN_LEAF_NAMES.map((e) => [e.name, e.label]));

const EXEMPT_REGEX = /PUL-Q001-allow:\s*\S/;

// --- Expression unwrapping ---

// Strip ordinary TypeScript wrappers that do not change the runtime
// value: parentheses, `as` assertions, `<T>x` legacy type assertions,
// non-null assertions (`x!`), and `satisfies`. These show up in
// normal refactors and must not let a forbidden access slip past
// the gate.
function unwrap(node: ts.Expression): ts.Expression {
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

// --- Access-path resolution ---

interface AccessPath {
  readonly path: readonly string[]; // resolved segment names (post-alias)
  readonly originalRoot: string; // root identifier as written
}

function getAccessPath(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  aliases: ReadonlyMap<string, string>,
): AccessPath | null {
  const parts: string[] = [];
  let current: ts.Expression = node;
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
        // Computed access (`obj[expr]` with non-literal `expr`) is
        // too dynamic to track semantically; bail out.
        return null;
      }
    } else if (ts.isIdentifier(current)) {
      const originalRoot = current.text;
      const resolvedRoot = aliases.get(originalRoot) ?? originalRoot;
      parts.unshift(resolvedRoot);
      return { path: parts, originalRoot };
    } else if (ts.isMetaProperty(current)) {
      // `import.meta` — synthesize a single root token. Not aliasable.
      parts.unshift('import.meta');
      return { path: parts, originalRoot: 'import.meta' };
    } else {
      return null;
    }
  }
}

// `path` matches the surface when, after stripping any leading
// recognised global-wrapper segments, the remaining segments equal
// `[root, prop]`. Returns the label of the matched surface or null.
function matchRootPropertySurface(path: readonly string[]): string | null {
  let start = 0;
  while (start < path.length && GLOBAL_ROOTS.has(path[start] ?? '')) {
    start += 1;
  }
  const tail = path.slice(start);
  if (tail.length !== 2) return null;
  const [root, prop] = tail;
  for (const surface of FORBIDDEN_ROOT_PROPERTIES) {
    if (surface.root === root && surface.prop === prop) {
      return surface.label;
    }
  }
  return null;
}

// Match `[..global-roots.., <forbidden-identifier-name>]` — e.g.,
// `window.localStorage`, `globalThis.setTimeout`.
function matchWrappedGlobalIdentifier(path: readonly string[]): string | null {
  let start = 0;
  while (start < path.length && GLOBAL_ROOTS.has(path[start] ?? '')) {
    start += 1;
  }
  const tail = path.slice(start);
  if (tail.length !== 1) return null;
  const name = tail[0] ?? '';
  return FORBIDDEN_GLOBAL_IDENTIFIER_LABEL_BY_NAME.get(name) ?? null;
}

// Match `[import.meta, env]`.
function matchImportMetaEnv(path: readonly string[]): string | null {
  if (path.length === 2 && path[0] === 'import.meta' && path[1] === 'env') {
    return 'import.meta.env';
  }
  return null;
}

// --- Alias collection ---

// File-local aliases of ambient global roots / globals. `const m =
// Math; m.random()` resolves to `Math.random`. Shadowing isn't
// universally handled (a `const Math = somethingElse` would still
// be matched by the suffix table because root resolution is
// alias-by-name, not symbol-by-identity), but the practical
// failure mode is rare and is bounded by `FORBIDDEN_ROOTS` /
// `GLOBAL_ROOTS` membership: we only record aliases whose
// initializer is one of the known global roots, and a redeclared
// `Math` (etc.) without a forbidden-root initializer is treated
// as a regular variable that, if it appears as the root of an
// access path, will not resolve via the alias map.
function collectAliases(sourceFile: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isIdentifier(init)) {
        const targetName = init.text;
        if (FORBIDDEN_ROOTS.has(targetName) || GLOBAL_ROOTS.has(targetName)) {
          aliases.set(node.name.text, targetName);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

// --- Identifier classification ---

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
  // ShorthandPropertyAssignment is intentionally NOT treated as a
  // declaration: `{ requestAnimationFrame }` is a value-position
  // read of the identifier, equivalent to
  // `{ requestAnimationFrame: requestAnimationFrame }`.
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent)) return true;
  if (ts.isImportClause(parent) && parent.name === node) return true;
  if (ts.isNamespaceImport(parent)) return true;
  if (ts.isImportEqualsDeclaration(parent) && parent.name === node) return true;
  if (ts.isExportSpecifier(parent)) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  // Property-name positions: the `.name` of a PropertyAccess or
  // QualifiedName is the key, not a value-position reference.
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) &&
    'name' in parent &&
    parent.name === node
  ) {
    return true;
  }
  return false;
}

function isInTypePosition(node: ts.Node): boolean {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (
      ts.isTypeNode(n) ||
      ts.isTypeAliasDeclaration(n) ||
      ts.isInterfaceDeclaration(n) ||
      ts.isTypeReferenceNode(n) ||
      ts.isTypeLiteralNode(n)
    ) {
      return true;
    }
    n = n.parent;
  }
  return false;
}

// --- Comment / exemption ---

function collectExemptedLines(sourceFile: ts.SourceFile): Set<number> {
  const exempted = new Set<number>();
  const text = sourceFile.text;
  const seen = new Set<number>();
  const addRanges = (ranges: readonly ts.CommentRange[] | undefined): void => {
    if (ranges === undefined) return;
    for (const range of ranges) {
      if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const tokenText = text.slice(range.pos, range.end);
      if (EXEMPT_REGEX.test(tokenText)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(range.pos);
        exempted.add(line);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    addRanges(ts.getLeadingCommentRanges(text, node.pos));
    addRanges(ts.getTrailingCommentRanges(text, node.end));
    ts.forEachChild(node, visit);
  };
  addRanges(ts.getLeadingCommentRanges(text, 0));
  visit(sourceFile);
  return exempted;
}

function lineText(sourceFile: ts.SourceFile, lineIndex0: number): string {
  const lines = sourceFile.text.split('\n');
  return lines[lineIndex0] ?? '';
}

// --- Scanner entry point ---

function scanSourceForNonDeterminism(text: string, file: string): readonly SourceFinding[] {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /*setParentNodes=*/ true,
  );
  const exempted = collectExemptedLines(sourceFile);
  const aliases = collectAliases(sourceFile);
  const findings: SourceFinding[] = [];
  const seen = new Set<string>(); // dedupe (node start + label)

  const record = (node: ts.Node, label: string): void => {
    const start = node.getStart(sourceFile);
    const key = `${start}::${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    if (exempted.has(line)) return;
    findings.push({
      file,
      line: line + 1,
      text: lineText(sourceFile, line).trim(),
      label,
    });
  };

  // Resolve a callee expression to its access path (with aliases /
  // wrappers unwound). Used by no-arg `new Date()` / `Date()` and
  // by Element.animate dot-call detection (the latter no longer
  // needs it because we flag any read of `.animate`, but the helper
  // is still useful for the Date constructor case).
  const resolveCalleePath = (callee: ts.Expression): AccessPath | null => {
    const inner = unwrap(callee);
    if (ts.isIdentifier(inner)) {
      const resolved = aliases.get(inner.text) ?? inner.text;
      return { path: [resolved], originalRoot: inner.text };
    }
    if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
      return getAccessPath(inner, aliases);
    }
    return null;
  };

  // Check whether a path resolves to `[..globals.., Date]` (i.e., the
  // `Date` constructor) — used for no-arg `new Date()` and `Date()`.
  const isDatePath = (path: readonly string[]): boolean => {
    let start = 0;
    while (start < path.length && GLOBAL_ROOTS.has(path[start] ?? '')) {
      start += 1;
    }
    return path.length - start === 1 && path[start] === 'Date';
  };

  const visit = (node: ts.Node): void => {
    // 1. Property / element access chains. Detection covers:
    //   (a) `[root, prop]` and `[..globals.., root, prop]` against
    //       the FORBIDDEN_ROOT_PROPERTIES table.
    //   (b) `[..globals.., globalIdent]` against the FORBIDDEN_GLOBAL_
    //       IDENTIFIERS table — catches `window.localStorage`, etc.
    //   (c) Forbidden leaf-name reads (`.animate`) regardless of root.
    //   (d) `import.meta.env`.
    //
    // The outermost access wins for (a)/(b)/(d); nested sub-accesses
    // are still visited but normally produce no match because their
    // path is too short. Dedup via `seen` keeps a single outer match
    // from being reported by both the outer and inner visits.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (!isInTypePosition(node)) {
        const access = getAccessPath(node, aliases);
        if (access) {
          const rootProp = matchRootPropertySurface(access.path);
          if (rootProp) {
            record(node, rootProp);
          } else {
            const wrappedGlobal = matchWrappedGlobalIdentifier(access.path);
            if (wrappedGlobal) record(node, wrappedGlobal);
            const importMeta = matchImportMetaEnv(access.path);
            if (importMeta) record(node, importMeta);
          }
        }
        // Leaf-name reads (Element.animate, etc.) — flag regardless
        // of the root, because the surface is the named method/
        // property itself.
        const leafName = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : ts.isStringLiteralLike(node.argumentExpression)
            ? node.argumentExpression.text
            : null;
        if (leafName) {
          const leafLabel = FORBIDDEN_LEAF_LABEL_BY_NAME.get(leafName);
          if (leafLabel) record(node, leafLabel);
        }
      }
    }

    // 2. Bare identifier references (not declarations, not type
    //    positions, not the `.name` of a PropertyAccess).
    if (ts.isIdentifier(node) && !isDeclarationName(node) && !isInTypePosition(node)) {
      const name = node.text;
      const label = FORBIDDEN_GLOBAL_IDENTIFIER_LABEL_BY_NAME.get(name);
      if (label) {
        // Don't double-count `globalThis.setTimeout` — handled by
        // the wrapped-global-identifier check above. The check here
        // is for BARE identifier reads where the parent is not a
        // PropertyAccess `.name`.
        const parent = node.parent;
        const isPropertyAccessName =
          parent &&
          (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) &&
          'name' in parent &&
          parent.name === node;
        if (!isPropertyAccessName) {
          record(node, label);
        }
      }
    }

    // 3. `new Date()` / `Date()` with zero arguments — covering
    //    bare, global-wrapped, aliased, and parenthesized callees.
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const hasNoArgs = !node.arguments || node.arguments.length === 0;
      if (hasNoArgs) {
        const callee = resolveCalleePath(node.expression);
        if (callee && isDatePath(callee.path)) {
          record(node, ts.isNewExpression(node) ? 'new Date() (no-arg)' : 'Date() (function call)');
        }
      }
    }

    // 4. Destructuring from a forbidden root. `const { random } =
    //    Math;` is semantically equivalent to a `Math.random` read.
    //    The initializer is unwrapped before identifier-matching so
    //    `const { random } = (Math)` / `(Math as object)` are
    //    caught alongside the bare form.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const init = unwrap(node.initializer);
      if (ts.isIdentifier(init)) {
        const resolved = aliases.get(init.text) ?? init.text;
        if (FORBIDDEN_ROOTS.has(resolved)) {
          for (const element of node.name.elements) {
            const propName = element.propertyName ?? element.name;
            if (!ts.isIdentifier(propName)) continue;
            for (const surface of FORBIDDEN_ROOT_PROPERTIES) {
              if (surface.root === resolved && surface.prop === propName.text) {
                record(element, `${surface.label} (via destructuring)`);
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

// --- File system driver ---

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCAN_ROOT = join(REPO_ROOT, 'src');

// `.ts` paths in `src/` that this scan skips. None today; the array
// exists so a future generated or third-party include under `src/`
// can be opted out explicitly. Test files don't live under `src/`,
// so they don't need an exclude.
const SCAN_EXCLUDES: readonly string[] = [];

function isExcluded(absolutePath: string): boolean {
  const rel = relative(REPO_ROOT, absolutePath);
  return SCAN_EXCLUDES.some((ex) => rel === ex || rel.startsWith(`${ex}/`));
}

function walkTs(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.')) continue;
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTs(full));
    } else if (st.isFile() && entry.endsWith('.ts')) {
      if (!isExcluded(full)) out.push(full);
    }
  }
  return out;
}

// --- Tests ---

describe('PUL-Q001 — screenshot determinism source scan', () => {
  describe('scanner self-tests', () => {
    describe('direct spellings', () => {
      it.each([
        ['Math.random', 'const x = Math.random();'],
        ['Date.now', 'const t = Date.now();'],
        ['new Date() (no-arg)', 'const d = new Date();'],
        ['Date() (function call)', 'const s = Date();'],
        ['performance.now', 'const t = performance.now();'],
        ['crypto.getRandomValues', 'crypto.getRandomValues(new Uint8Array(4));'],
        ['requestAnimationFrame', 'requestAnimationFrame(noop);'],
        ['localStorage', 'localStorage.getItem("x");'],
        ['sessionStorage', 'sessionStorage.getItem("x");'],
        ['document.cookie', 'document.cookie;'],
        ['history.state', 'const s = history.state;'],
        ['process.env', 'const v = process.env.FOO;'],
        ['process.argv', 'const a = process.argv[2];'],
        ['import.meta.env', 'const v = import.meta.env.VITE_SEED;'],
        ['setTimeout', 'setTimeout(noop, 0);'],
        ['setInterval', 'setInterval(noop, 0);'],
      ])('flags %s', (label, source) => {
        const findings = scanSourceForNonDeterminism(source, 'fake.ts');
        expect(findings.map((f) => f.label)).toContain(label);
      });

      it('flags Element.animate calls (direct dot-call)', () => {
        const findings = scanSourceForNonDeterminism(
          'declare const el: HTMLElement; el.animate([], { duration: 100 });',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('Element.animate');
      });

      it('flags Element.animate reads (alias, not just calls)', () => {
        // PUL-Q001 forbids `Element.animate` because it starts a
        // wall-clock animation timeline. Reading the member to alias
        // it is the same hazard — flag both forms.
        const findings = scanSourceForNonDeterminism(
          'declare const el: HTMLElement; const animateFn = el.animate;',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('Element.animate');
      });

      it('flags Element.animate via bracket access', () => {
        const findings = scanSourceForNonDeterminism(
          `declare const el: HTMLElement; el['animate']([], { duration: 100 });`,
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('Element.animate');
      });

      it('flags Element.animate via optional chaining', () => {
        const findings = scanSourceForNonDeterminism(
          'declare const el: HTMLElement | null; el?.animate([]);',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('Element.animate');
      });
    });

    describe('global-wrapper forms (globalThis / window / self / global)', () => {
      it.each([
        ['globalThis.Math.random', 'globalThis.Math.random();', 'Math.random'],
        ['window.localStorage', 'window.localStorage.getItem("x");', 'localStorage'],
        ['self.setTimeout', 'self.setTimeout(noop, 0);', 'setTimeout'],
        [
          'global.requestAnimationFrame',
          'global.requestAnimationFrame(noop);',
          'requestAnimationFrame',
        ],
        [
          'globalThis.crypto.getRandomValues',
          'globalThis.crypto.getRandomValues(new Uint8Array(4));',
          'crypto.getRandomValues',
        ],
        ['window.document.cookie', 'window.document.cookie;', 'document.cookie'],
        ['globalThis.history.state', 'const s = globalThis.history.state;', 'history.state'],
        ['globalThis.process.env', 'const v = globalThis.process.env.FOO;', 'process.env'],
        ["globalThis['setInterval']", `globalThis['setInterval'](noop, 0);`, 'setInterval'],
      ])('flags %s', (_label, source, expectedLabel) => {
        const findings = scanSourceForNonDeterminism(source, 'fake.ts');
        expect(findings.map((f) => f.label)).toContain(expectedLabel);
      });

      it('flags `new globalThis.Date()` (no-arg)', () => {
        const findings = scanSourceForNonDeterminism('new globalThis.Date();', 'fake.ts');
        expect(findings.map((f) => f.label)).toContain('new Date() (no-arg)');
      });

      it('flags `globalThis.Date()` (function-call form)', () => {
        const findings = scanSourceForNonDeterminism('const s = globalThis.Date();', 'fake.ts');
        expect(findings.map((f) => f.label)).toContain('Date() (function call)');
      });
    });

    describe('aliased forms', () => {
      it('flags `const m = Math; m.random()`', () => {
        const findings = scanSourceForNonDeterminism(
          'const m = Math; const r = m.random();',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('Math.random');
      });

      it('flags `const perf = performance; perf.now()`', () => {
        const findings = scanSourceForNonDeterminism(
          'const perf = performance; const t = perf.now();',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('performance.now');
      });

      it('flags `const rng = crypto; rng.getRandomValues(...)`', () => {
        const findings = scanSourceForNonDeterminism(
          'const rng = crypto; rng.getRandomValues(new Uint8Array(4));',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('crypto.getRandomValues');
      });

      it('flags `const Clock = Date; new Clock()` (no-arg)', () => {
        const findings = scanSourceForNonDeterminism(
          'const Clock = Date; const d = new Clock();',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('new Date() (no-arg)');
      });

      it('flags `const Clock = Date; Clock.now()`', () => {
        const findings = scanSourceForNonDeterminism(
          'const Clock = Date; const t = Clock.now();',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('Date.now');
      });

      it('flags `const g = globalThis; g.Math.random()`', () => {
        const findings = scanSourceForNonDeterminism(
          'const g = globalThis; const r = g.Math.random();',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('Math.random');
      });
    });

    describe('TypeScript wrapper expressions', () => {
      it.each([
        ['(Math).random()', '(Math).random();', 'Math.random'],
        ['(Date).now()', '(Date).now();', 'Date.now'],
        [
          '(performance as Performance).now()',
          '(performance as Performance).now();',
          'performance.now',
        ],
        [
          '(globalThis as any).crypto.getRandomValues',
          '(globalThis as any).crypto.getRandomValues(new Uint8Array(4));',
          'crypto.getRandomValues',
        ],
        [
          'performance!.now()',
          'declare const performance: Performance | undefined; performance!.now();',
          'performance.now',
        ],
        ['(Math satisfies object).random()', '(Math satisfies object).random();', 'Math.random'],
        ['new (Date)()', 'const d = new (Date)();', 'new Date() (no-arg)'],
      ])('unwraps %s', (_label, source, expectedLabel) => {
        const findings = scanSourceForNonDeterminism(source, 'fake.ts');
        expect(findings.map((f) => f.label)).toContain(expectedLabel);
      });
    });

    describe('bracket access', () => {
      it('flags `Date["now"]()`', () => {
        const findings = scanSourceForNonDeterminism(`Date['now']();`, 'fake.ts');
        expect(findings.map((f) => f.label)).toContain('Date.now');
      });

      it('flags `Math["random"]()`', () => {
        const findings = scanSourceForNonDeterminism(`Math['random']();`, 'fake.ts');
        expect(findings.map((f) => f.label)).toContain('Math.random');
      });

      it('flags `Date[`now`]()` (template-literal subscript)', () => {
        const findings = scanSourceForNonDeterminism('Date[`now`]();', 'fake.ts');
        expect(findings.map((f) => f.label)).toContain('Date.now');
      });
    });

    describe('destructuring', () => {
      it('flags `const { random } = Math; random();`', () => {
        const findings = scanSourceForNonDeterminism(
          'const { random } = Math; random();',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('Math.random (via destructuring)');
      });

      it('flags `const { now } = Date; now();`', () => {
        const findings = scanSourceForNonDeterminism('const { now } = Date; now();', 'fake.ts');
        expect(findings.map((f) => f.label)).toContain('Date.now (via destructuring)');
      });

      it('flags destructuring through an alias (`const M = Math; const { random } = M;`)', () => {
        const findings = scanSourceForNonDeterminism(
          'const M = Math; const { random } = M;',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('Math.random (via destructuring)');
      });
    });

    describe('object shorthand', () => {
      it('flags `{ localStorage }` shorthand read', () => {
        // Object shorthand `{ requestAnimationFrame }` is equivalent
        // to `{ requestAnimationFrame: requestAnimationFrame }` —
        // the identifier is a value-position read, not a
        // declaration.
        const findings = scanSourceForNonDeterminism(
          'const timers = { requestAnimationFrame };',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('requestAnimationFrame');
      });

      it('flags `return { localStorage }` shorthand read', () => {
        const findings = scanSourceForNonDeterminism(
          'function pack() { return { localStorage }; }',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('localStorage');
      });
    });

    describe('non-global object graphs are NOT flagged (false-positive defense)', () => {
      it.each([
        // root-anchoring prevents these from triggering
        [
          'snapshot.history.state',
          'declare const snapshot: { history: { state: number } }; const s = snapshot.history.state;',
        ],
        [
          'fixture.process.env',
          'declare const fixture: { process: { env: object } }; const e = fixture.process.env;',
        ],
        [
          'mock.document.cookie',
          'declare const mock: { document: { cookie: string } }; const c = mock.document.cookie;',
        ],
        [
          'scene.crypto.getRandomValues',
          'declare const scene: { crypto: { getRandomValues(buf: Uint8Array): void } }; scene.crypto.getRandomValues(new Uint8Array(4));',
        ],
      ])('does NOT flag %s (root is not an ambient global)', (_label, source) => {
        const findings = scanSourceForNonDeterminism(source, 'fake.ts');
        expect(findings).toEqual([]);
      });
    });

    describe('whole-word semantics + lookalikes', () => {
      it('does not flag whole-word lookalikes', () => {
        const safe = `declare const myDate: { now: number };
          declare function requestAnimationFrameLike(cb: () => void): void;
          const a = myDate.now;
          requestAnimationFrameLike(() => {});`;
        const findings = scanSourceForNonDeterminism(safe, 'fake.ts');
        expect(findings).toEqual([]);
      });

      it('does not flag `new Date(timestamp)` (argument-form is deterministic)', () => {
        expect(scanSourceForNonDeterminism('const d = new Date(0);', 'fake.ts')).toEqual([]);
        expect(scanSourceForNonDeterminism('const d = new Date(beatMs);', 'fake.ts')).toEqual([]);
      });

      it('does NOT flag computed bracket access (semantically opaque)', () => {
        const findings = scanSourceForNonDeterminism(
          'declare const propKey: string; Math[propKey];',
          'fake.ts',
        );
        expect(findings).toEqual([]);
      });
    });

    describe('type-position references are ignored', () => {
      it('does not flag setTimeout used as a type member name', () => {
        const findings = scanSourceForNonDeterminism(
          'interface Timers { setTimeout(cb: () => void, ms: number): number; }',
          'fake.ts',
        );
        expect(findings).toEqual([]);
      });

      it('does not flag identifier reads inside a type alias', () => {
        const findings = scanSourceForNonDeterminism('type T = typeof setTimeout;', 'fake.ts');
        // `typeof setTimeout` in a type alias is a type-position
        // reference; it does not execute at runtime.
        expect(findings).toEqual([]);
      });
    });

    describe('comment / string handling', () => {
      it('ignores forbidden vocabulary inside `//` line comments', () => {
        const text = '// `Math.random`, `Date.now()`, and `localStorage` are forbidden.';
        expect(scanSourceForNonDeterminism(text, 'fake.ts')).toEqual([]);
      });

      it('ignores forbidden vocabulary inside `/* … */` block comments (single line)', () => {
        const text = '/* Math.random and Date.now are forbidden. */';
        expect(scanSourceForNonDeterminism(text, 'fake.ts')).toEqual([]);
      });

      it('ignores forbidden vocabulary inside `/* … */` block comments spanning multiple lines', () => {
        const text = ['/**', ' * Forbids Math.random and Date.now().', ' */', 'const x = 1;'].join(
          '\n',
        );
        expect(scanSourceForNonDeterminism(text, 'fake.ts')).toEqual([]);
      });

      it('does not treat `//` inside a string literal as a comment', () => {
        const text = `const url = 'foo://bar'; const t = Date.now();`;
        const findings = scanSourceForNonDeterminism(text, 'fake.ts');
        expect(findings.map((f) => f.label)).toContain('Date.now');
      });
    });

    describe('exemption marker', () => {
      it('respects an inline `// PUL-Q001-allow:` exemption on the same line', () => {
        const findings = scanSourceForNonDeterminism(
          'const t = Date.now(); // PUL-Q001-allow: bootstrap log timestamp, not captured',
          'fake.ts',
        );
        expect(findings).toEqual([]);
      });

      it('does NOT honor an empty exemption rationale', () => {
        const findings = scanSourceForNonDeterminism(
          'const t = Date.now(); // PUL-Q001-allow:',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('Date.now');
      });

      it('does NOT honor an exemption with only whitespace after the colon', () => {
        const findings = scanSourceForNonDeterminism(
          'const t = Date.now(); // PUL-Q001-allow:   ',
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('Date.now');
      });

      it('does NOT honor a marker hidden inside a string literal', () => {
        const findings = scanSourceForNonDeterminism(
          `const note = "// PUL-Q001-allow: hidden in a string"; const t = Date.now();`,
          'fake.ts',
        );
        expect(findings.map((f) => f.label)).toContain('Date.now');
      });

      it('does NOT honor an exemption on a different line (line-scoped, not file-scoped)', () => {
        const text = '// PUL-Q001-allow: see above\nconst t = Date.now();';
        const findings = scanSourceForNonDeterminism(text, 'fake.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.line).toBe(2);
      });

      it('honors an exemption on a `// PUL-Q001-allow:` marker after the forbidden call on the same line', () => {
        const findings = scanSourceForNonDeterminism(
          'setTimeout(work, 0); // PUL-Q001-allow: navigation idle scheduling, not captured',
          'fake.ts',
        );
        expect(findings).toEqual([]);
      });

      it('honors a trailing exemption on a later source line', () => {
        const findings = scanSourceForNonDeterminism(
          [
            'const a = 1;',
            'crypto.getRandomValues(new Uint8Array(4)); // PUL-Q001-allow: non-render entropy',
            'const b = 2;',
          ].join('\n'),
          'fake.ts',
        );
        expect(findings).toEqual([]);
      });
    });

    describe('reporting', () => {
      it('reports line numbers (1-based) and the offending file path', () => {
        const text = 'const a = 1;\nconst b = 2;\nconst t = Date.now();\nconst c = 3;';
        const findings = scanSourceForNonDeterminism(text, 'src/runtime/example.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.line).toBe(3);
        expect(findings[0]?.file).toBe('src/runtime/example.ts');
      });

      it('reports every distinct violation when a single line carries more than one', () => {
        const findings = scanSourceForNonDeterminism(
          'const r = Math.random() + Date.now();',
          'fake.ts',
        );
        expect(findings.map((f) => f.label).sort()).toEqual(['Date.now', 'Math.random']);
      });

      it('reports findings across multiple lines independently', () => {
        const text = ['const a = Math.random();', 'const t = Date.now();'].join('\n');
        const findings = scanSourceForNonDeterminism(text, 'fake.ts');
        expect(findings).toHaveLength(2);
        expect(findings[0]?.line).toBe(1);
        expect(findings[1]?.line).toBe(2);
      });
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('scan root `src/` exists and contains at least one .ts file', () => {
      const st = statSync(SCAN_ROOT);
      expect(st.isDirectory()).toBe(true);
      const files = walkTs(SCAN_ROOT);
      expect(files.length).toBeGreaterThan(0);
    });

    it.each([
      ['src/runtime', join(SCAN_ROOT, 'runtime')],
      ['src/scenes', join(SCAN_ROOT, 'scenes')],
      ['src/compositions', join(SCAN_ROOT, 'compositions')],
    ])('expected runtime subtree %s contains at least one .ts file', (label, root) => {
      const files = walkTs(root);
      expect(files.length, `${label} produced no .ts files`).toBeGreaterThan(0);
    });

    it('expected runtime entry `src/main.ts` exists', () => {
      const st = statSync(join(SCAN_ROOT, 'main.ts'));
      expect(st.isFile()).toBe(true);
    });

    it('contains no non-deterministic primitives across `src/**/*.ts`', () => {
      const files = walkTs(SCAN_ROOT);
      const findings: SourceFinding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        findings.push(...scanSourceForNonDeterminism(text, rel));
      }

      const header =
        'PUL-Q001 forbids the listed APIs in runtime source. Add a `// PUL-Q001-allow: <reason>` exemption on the same line if the use is intentional and deterministic in context.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });
  });
});
