import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { NAVIGATION_MODES } from '../../src/runtime/navigation';

import {
  REPO_ROOT,
  SRC_ROOT,
  type SourceFinding,
  collectLineExemptions,
  isInTypePosition,
  lineText,
  parseSource,
  unwrap,
  walkTsFiles,
} from './source-policy';

// PUL-A008 — Workbench mode dispatch in the runtime core.
//
// Statement: "Workbench mode dispatch SHALL be implemented in the
// runtime core. Scene modules SHALL NOT contain mode-specific
// branches except where they must respond to mode hints (e.g.,
// suppressing audio in `mode=screenshot`)."
//
// Enforcement: a Vitest source scan over `src/scenes/**/*.ts`. The
// scanner flags three AST shapes — all variants of "this code branches
// on a workbench mode literal":
//
//   1. A `BinaryExpression` whose operator is `===` / `!==` / `==` /
//      `!=` where one operand is a NAVIGATION_MODES string literal
//      (direct or via a file-local `const` alias) AND the other
//      operand resolves to a `.mode` property access (any expression)
//      OR a bare identifier `mode`. Covers `ctx.mode === 'screenshot'`,
//      `'present' === ctx.mode`, `mode !== 'paused'`,
//      `ctx.mode == 'paused'` (loose-equality bypass), the TypeScript-
//      wrapper variants (`(ctx.mode as string) === '...'`,
//      `(ctx.mode!) === '...'`, parenthesized, `satisfies`), and the
//      alias form `const SCREENSHOT = 'screenshot'; if (ctx.mode ===
//      SCREENSHOT) {}`.
//
//   2. A `SwitchStatement` whose discriminant resolves to `.mode` /
//      bare `mode` AND any `case` clause's expression is a
//      NAVIGATION_MODES literal (direct or via a file-local `const`
//      alias). Covers `switch (ctx.mode) { case 'loop': ... }` and
//      `switch (ctx.mode) { case TARGET: ... }`.
//
//   3. A `CallExpression` `<receiver>.includes(<arg>)` where the
//      argument resolves to a `.mode` / bare-`mode` read AND the
//      receiver is an `ArrayLiteralExpression` (or a `const`-aliased
//      array literal) that contains at least one NAVIGATION_MODES
//      literal. Covers `['paused', 'screenshot'].includes(ctx.mode)`,
//      `MUTED_MODES.includes(ctx.mode)`, and the loose membership
//      branching form authors reach for when they want "is the mode
//      one of N values".
//
// The set of forbidden mode literals is imported live from
// `src/runtime/navigation.ts` so adding a ninth mode extends the
// gate by construction. The receiver-array form deliberately does
// NOT cover the canonical scene-validation pattern
// `NAVIGATION_MODES.includes(ctx.mode)` because the receiver is the
// `NAVIGATION_MODES` identifier, not an array-literal-of-mode-strings.
//
// The runtime core (`src/runtime/`) IS the mode-dispatch boundary and
// intentionally contains exactly the constructions this gate forbids
// in scenes — scanning it would be a category error. The scope is
// therefore `src/scenes/**/*.ts` only.
//
// Exemption: a line-scoped `// PUL-A008-allow: <reason>` comment
// excludes a single line. Empty / whitespace-only rationales are
// rejected; markers hidden inside string literals are rejected; the
// marker applies only to its own line. The preflight names the
// narrow legitimate use — scene-owned side-effect suppression that
// the loader cannot enforce centrally (e.g., deterministic
// randomness under `mode=screenshot`).

const ALLOW_TAG = 'PUL-A008-allow';
const MODE_LITERALS: ReadonlySet<string> = new Set(NAVIGATION_MODES);
const SCENES_ROOT = join(SRC_ROOT, 'scenes');

/**
 * True when `expr` reads a `.mode` property OR is a bare identifier
 * named `mode`. Wrapper expressions (`(x.mode as string)`, `(x.mode!)`,
 * parenthesized forms, `satisfies`) are unwrapped first. Returns false
 * for type-position references — the gate only cares about value-level
 * branches.
 */
function isModeRead(expr: ts.Expression): boolean {
  const inner = unwrap(expr);
  if (ts.isPropertyAccessExpression(inner)) {
    return inner.name.text === 'mode' && !isInTypePosition(inner);
  }
  if (ts.isElementAccessExpression(inner)) {
    const arg = unwrap(inner.argumentExpression);
    return ts.isStringLiteralLike(arg) && arg.text === 'mode' && !isInTypePosition(inner);
  }
  if (ts.isIdentifier(inner)) {
    return inner.text === 'mode' && !isInTypePosition(inner);
  }
  return false;
}

/**
 * Resolve `expr` to a string literal value when it is a direct
 * `StringLiteral` / `NoSubstitutionTemplateLiteral`, OR an identifier
 * resolved through the alias map to such a literal. Returns `null`
 * when the expression is not statically a string.
 *
 * Type-position references are intentionally ignored: a union member
 * like `type Mode = 'present' | 'paused'` is compile-time only and
 * does not branch on a value.
 */
function resolveStringLiteral(
  expr: ts.Expression,
  literalAliases: ReadonlyMap<string, string>,
): string | null {
  const inner = unwrap(expr);
  if (isInTypePosition(inner)) return null;
  if (ts.isStringLiteral(inner)) return inner.text;
  if (ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (ts.isIdentifier(inner)) {
    return literalAliases.get(inner.text) ?? null;
  }
  return null;
}

/**
 * True when `expr` resolves (directly or via alias) to a string literal
 * that is a member of {@link NAVIGATION_MODES}.
 */
function isModeLiteral(expr: ts.Expression, literalAliases: ReadonlyMap<string, string>): boolean {
  const value = resolveStringLiteral(expr, literalAliases);
  return value !== null && MODE_LITERALS.has(value);
}

/**
 * Collect file-local `const <name> = '<string literal>'` bindings —
 * including chained aliases (`const A = 'screenshot'; const B = A;`)
 * — so the scanner sees through the trivial obfuscation
 * `const SCREENSHOT = 'screenshot'; if (ctx.mode === SCREENSHOT) {}`.
 *
 * The collector iterates to a fixed point so chained declarations
 * resolve regardless of source order. `let` / `var` bindings are
 * intentionally excluded — the rule's contract is "no mode-specific
 * branches"; a mutable binding through which a mode value flows is
 * exotic enough that the line-allow tag is the right escape hatch.
 *
 * Returns a map of identifier name → resolved string literal value.
 */
function collectLiteralAliases(sourceFile: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  type Decl = { readonly name: string; readonly init: ts.Expression };
  const declarations: Decl[] = [];
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      // `const` only — the parent's `flags` carry `NodeFlags.Const` when
      // declared with `const`. `let` / `var` bindings are excluded so
      // re-assignment can't quietly invalidate the alias map.
      node.parent &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      declarations.push({ name: node.name.text, init: node.initializer });
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const tryRegister = (decl: Decl): boolean => {
    if (aliases.has(decl.name)) return false;
    const inner = unwrap(decl.init);
    if (ts.isStringLiteral(inner)) {
      aliases.set(decl.name, inner.text);
      return true;
    }
    if (ts.isNoSubstitutionTemplateLiteral(inner)) {
      aliases.set(decl.name, inner.text);
      return true;
    }
    if (ts.isIdentifier(inner)) {
      const resolved = aliases.get(inner.text);
      if (resolved !== undefined) {
        aliases.set(decl.name, resolved);
        return true;
      }
    }
    return false;
  };

  // Fixed-point iteration: `const B = A; const A = 'screenshot';`
  // resolves on the second pass when `A`'s registration becomes
  // visible to `B`'s lookup. Upper bound is the declaration count.
  for (let pass = 0; pass < declarations.length + 1; pass += 1) {
    let changed = false;
    for (const decl of declarations) {
      if (tryRegister(decl)) changed = true;
    }
    if (!changed) break;
  }
  return aliases;
}

/**
 * Collect file-local `const <name> = [<string literal>, ...]` bindings
 * (and chained aliases of such bindings) so the scanner sees through
 * `const MUTED = ['paused', 'screenshot']; if (MUTED.includes(ctx.mode)) {}`.
 *
 * Each entry maps an identifier to the resolved string-literal values
 * its array contains. Non-string-literal entries are silently ignored
 * — the gate only cares about mode-literal membership; an array with
 * mixed contents that includes a mode literal still trips the gate.
 *
 * Returns a map of identifier name → set of resolved literal strings.
 */
function collectArrayAliases(
  sourceFile: ts.SourceFile,
  literalAliases: ReadonlyMap<string, string>,
): Map<string, ReadonlySet<string>> {
  const aliases = new Map<string, ReadonlySet<string>>();
  type Decl = { readonly name: string; readonly init: ts.Expression };
  const declarations: Decl[] = [];
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      node.parent &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      declarations.push({ name: node.name.text, init: node.initializer });
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const extractElements = (expr: ts.Expression): ReadonlySet<string> | null => {
    const inner = unwrap(expr);
    if (ts.isArrayLiteralExpression(inner)) {
      const out = new Set<string>();
      for (const element of inner.elements) {
        const value = resolveStringLiteral(element, literalAliases);
        if (value !== null) out.add(value);
      }
      return out;
    }
    if (ts.isIdentifier(inner)) {
      return aliases.get(inner.text) ?? null;
    }
    return null;
  };

  const tryRegister = (decl: Decl): boolean => {
    if (aliases.has(decl.name)) return false;
    const elements = extractElements(decl.init);
    if (elements === null) return false;
    aliases.set(decl.name, elements);
    return true;
  };

  for (let pass = 0; pass < declarations.length + 1; pass += 1) {
    let changed = false;
    for (const decl of declarations) {
      if (tryRegister(decl)) changed = true;
    }
    if (!changed) break;
  }
  return aliases;
}

/**
 * True when `expr` resolves (directly or via alias) to an array
 * containing at least one NAVIGATION_MODES literal. Used to flag the
 * `[mode1, mode2].includes(ctx.mode)` membership-branching form.
 *
 * Returns false for the canonical scene-validation pattern
 * `NAVIGATION_MODES.includes(ctx.mode)` — the `NAVIGATION_MODES`
 * identifier is not a file-local alias (it's an import), so the
 * `arrayAliases` lookup misses, leaving the inline array form as the
 * only thing the gate flags. That's exactly the asymmetry the
 * requirement names: scenes may validate via the runtime's allowlist,
 * but may not author their own mode-membership branches.
 */
function arrayContainsModeLiteral(
  expr: ts.Expression,
  literalAliases: ReadonlyMap<string, string>,
  arrayAliases: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const inner = unwrap(expr);
  if (ts.isArrayLiteralExpression(inner)) {
    for (const element of inner.elements) {
      const value = resolveStringLiteral(element, literalAliases);
      if (value !== null && MODE_LITERALS.has(value)) return true;
    }
    return false;
  }
  if (ts.isIdentifier(inner)) {
    const set = arrayAliases.get(inner.text);
    if (!set) return false;
    for (const value of set) {
      if (MODE_LITERALS.has(value)) return true;
    }
    return false;
  }
  return false;
}

function scanA008(sourceFile: ts.SourceFile): readonly SourceFinding[] {
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const literalAliases = collectLiteralAliases(sourceFile);
  const arrayAliases = collectArrayAliases(sourceFile, literalAliases);
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

  // Equality operators covered by the gate: strict (`===` / `!==`) AND
  // loose (`==` / `!=`). The loose forms are forbidden by the project's
  // lint config in application code; flagging them here is defense in
  // depth so a scene that bypasses the lint with an inline disable
  // still trips the architectural gate.
  const EQUALITY_OPS: ReadonlySet<ts.SyntaxKind> = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ]);

  const visit = (node: ts.Node): void => {
    // 1. Binary equality against a NAVIGATION_MODES literal (direct or
    //    aliased) on one side AND a `.mode` / bare `mode` read on the
    //    other.
    if (ts.isBinaryExpression(node) && EQUALITY_OPS.has(node.operatorToken.kind)) {
      // Symmetric: either order trips the gate.
      const leftIsMode = isModeRead(node.left);
      const rightIsMode = isModeRead(node.right);
      const leftIsLit = isModeLiteral(node.left, literalAliases);
      const rightIsLit = isModeLiteral(node.right, literalAliases);
      if ((leftIsMode && rightIsLit) || (rightIsMode && leftIsLit)) {
        record(node, 'mode-literal comparison in scene module');
      }
    }

    // 2. `switch (...mode) { case '<literal>': ... }`. Flagged on each
    //    matching case so authors get one finding per offending arm
    //    rather than a single switch-level finding that hides which
    //    arms violate the rule. The case expression resolves through
    //    the literal-alias map so `case TARGET:` is caught when
    //    `const TARGET = 'screenshot'`.
    if (ts.isSwitchStatement(node) && isModeRead(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && isModeLiteral(clause.expression, literalAliases)) {
          record(clause, 'mode-literal switch case in scene module');
        }
      }
    }

    // 3. `<receiver>.includes(<arg>)` where the receiver is an array
    //    literal (or a `const`-aliased array literal) containing at
    //    least one mode literal AND the argument is a `.mode` / bare
    //    `mode` read. Covers `['paused'].includes(ctx.mode)` and
    //    `MUTED_MODES.includes(ctx.mode)`.
    //
    //    Pure-aliased `NAVIGATION_MODES.includes(ctx.mode)` does NOT
    //    trip the gate — `NAVIGATION_MODES` is an import, not a
    //    file-local const, so the array-alias lookup misses by design.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'includes' &&
      node.arguments.length === 1
    ) {
      const arg = node.arguments[0];
      const receiver = node.expression.expression;
      if (
        arg !== undefined &&
        isModeRead(arg) &&
        arrayContainsModeLiteral(receiver, literalAliases, arrayAliases)
      ) {
        record(node, 'mode-literal membership branch in scene module');
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function findingsOf(source: string, file = 'src/scenes/fake.ts'): readonly SourceFinding[] {
  return scanA008(parseSource(source, file));
}

// --- Tests -----------------------------------------------------------

describe('PUL-A008 — mode dispatch in core (source scan)', () => {
  describe('scanner self-tests', () => {
    describe('binary === / !== comparisons against a mode literal', () => {
      // Every NAVIGATION_MODES member must be flagged in at least one
      // form. A regression that drops a mode from the gate's literal
      // set (e.g., hard-codes a stale subset) is caught here. The
      // table is generated from the live `NAVIGATION_MODES` import so
      // adding a ninth mode adds the case by construction.
      it.each(NAVIGATION_MODES.map((m) => [m]))("flags `ctx.mode === '%s'`", (mode) => {
        const findings = findingsOf(
          `declare const ctx: { mode: string }; if (ctx.mode === '${mode}') {}`,
        );
        expect(findings.map((f) => f.label)).toContain('mode-literal comparison in scene module');
        expect(findings).toHaveLength(1);
      });

      it.each([
        ["flipped order — `'screenshot' === ctx.mode`", "if ('screenshot' === ctx.mode) {}"],
        ["inequality — `ctx.mode !== 'paused'`", "if (ctx.mode !== 'paused') {}"],
        ["flipped inequality — `'loop' !== ctx.mode`", "if ('loop' !== ctx.mode) {}"],
        [
          "bare identifier — `mode === 'present'`",
          "declare const mode: string; if (mode === 'present') {}",
        ],
        [
          "ternary — `ctx.mode === 'screenshot' ? 1 : 0`",
          'declare const ctx: { mode: string }; const x = ctx.mode === "screenshot" ? 1 : 0;',
        ],
        [
          "parenthesized — `(ctx.mode) === 'present'`",
          'declare const ctx: { mode: string }; if ((ctx.mode) === "present") {}',
        ],
        [
          "non-null — `ctx.mode! === 'paused'`",
          'declare const ctx: { mode: string }; if (ctx.mode! === "paused") {}',
        ],
        [
          "as-cast — `(ctx.mode as string) === 'paused'`",
          'declare const ctx: { mode: string }; if ((ctx.mode as string) === "paused") {}',
        ],
        [
          'template no-substitution — `` ctx.mode === \\`present\\` ``',
          'declare const ctx: { mode: string }; if (ctx.mode === `present`) {}',
        ],
        [
          'bracket access — `ctx["mode"] === \'present\'`',
          'declare const ctx: { mode: string }; if (ctx["mode"] === "present") {}',
        ],
        [
          "satisfies wrapper — `(ctx.mode satisfies string) === 'present'`",
          'declare const ctx: { mode: string }; if ((ctx.mode satisfies string) === "present") {}',
        ],
      ])('flags %s', (_label, source) => {
        const findings = findingsOf(`const _ = (): void => { ${source} };`);
        expect(findings.map((f) => f.label)).toContain('mode-literal comparison in scene module');
        expect(findings).toHaveLength(1);
      });

      it('preserves exact count when multiple comparisons appear', () => {
        const src = [
          'declare const ctx: { mode: string };',
          "if (ctx.mode === 'screenshot') {}",
          "if (ctx.mode !== 'paused') {}",
          "if ('loop' === ctx.mode) {}",
        ].join('\n');
        const findings = findingsOf(src);
        expect(findings).toHaveLength(3);
        expect(findings.every((f) => f.label === 'mode-literal comparison in scene module')).toBe(
          true,
        );
      });
    });

    describe('switch (...mode) case literals', () => {
      it.each(NAVIGATION_MODES.map((m) => [m]))(
        "flags `case '%s'` inside `switch (ctx.mode)`",
        (mode) => {
          const findings = findingsOf(
            [
              'declare const ctx: { mode: string };',
              'switch (ctx.mode) {',
              `  case '${mode}': break;`,
              '  default: break;',
              '}',
            ].join('\n'),
          );
          expect(findings.map((f) => f.label)).toContain(
            'mode-literal switch case in scene module',
          );
          expect(findings).toHaveLength(1);
        },
      );

      it('flags each matching case independently', () => {
        const findings = findingsOf(
          [
            'declare const ctx: { mode: string };',
            'switch (ctx.mode) {',
            "  case 'screenshot': break;",
            "  case 'paused': break;",
            "  case 'loop': break;",
            '  default: break;',
            '}',
          ].join('\n'),
        );
        expect(findings).toHaveLength(3);
        expect(findings.every((f) => f.label === 'mode-literal switch case in scene module')).toBe(
          true,
        );
      });

      it('flags `switch (mode)` with a bare identifier discriminant', () => {
        const findings = findingsOf(
          [
            'declare const mode: string;',
            'switch (mode) {',
            "  case 'screenshot': break;",
            '}',
          ].join('\n'),
        );
        expect(findings.map((f) => f.label)).toContain('mode-literal switch case in scene module');
        expect(findings).toHaveLength(1);
      });

      it('does NOT flag a switch whose discriminant is a non-mode property (symmetric to binary-comparison defense)', () => {
        // The binary-comparison block has the same negative coverage
        // (`ctx.kind === 'screenshot'` does not flag). The switch
        // visitor shares `isModeRead`, so a regression that widened
        // `isModeRead` would be caught by either test — but pinning
        // the invariant explicitly for the switch shape documents it.
        const src = [
          'declare const ctx: { kind: string };',
          'switch (ctx.kind) {',
          "  case 'screenshot': break;",
          '  default: break;',
          '}',
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag a `switch (ctx.mode)` whose cases are not NAVIGATION_MODES members', () => {
        const findings = findingsOf(
          [
            'declare const ctx: { mode: string };',
            'switch (ctx.mode) {',
            "  case 'something-else': break;",
            '  default: break;',
            '}',
          ].join('\n'),
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag a default-only `switch (ctx.mode)`', () => {
        const findings = findingsOf(
          ['declare const ctx: { mode: string };', 'switch (ctx.mode) { default: break; }'].join(
            '\n',
          ),
        );
        expect(findings).toEqual([]);
      });
    });

    describe('false-positive defense', () => {
      it('does NOT flag `NAVIGATION_MODES.includes(ctx.mode)` (the canonical scene validation)', () => {
        const src = [
          'declare const NAVIGATION_MODES: readonly string[];',
          'declare const ctx: { mode: string };',
          'const ok = NAVIGATION_MODES.includes(ctx.mode);',
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag `(NAVIGATION_MODES as readonly string[]).includes(mode)`', () => {
        const src = [
          'declare const NAVIGATION_MODES: readonly string[];',
          'declare const mode: string;',
          'const ok = (NAVIGATION_MODES as readonly string[]).includes(mode);',
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag a comparison between two `.mode` reads (no literal)', () => {
        const src = [
          'declare const ctx: { mode: string };',
          'declare const prior: { mode: string };',
          'if (ctx.mode === prior.mode) {}',
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag a comparison against a non-mode literal', () => {
        const src = [
          'declare const ctx: { mode: string };',
          "if (ctx.mode === 'unknown-future-mode') {}",
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag a mode-literal comparison against a non-mode property', () => {
        // `ctx.kind === 'screenshot'` is structurally analogous to a
        // mode branch but reads a different field. The rule scopes to
        // the `.mode` / bare-`mode` surface; an unrelated `.kind` is
        // not in scope.
        const src = [
          'declare const ctx: { kind: string };',
          "if (ctx.kind === 'screenshot') {}",
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag a mode literal inside a string concatenation', () => {
        const src = ['const label = "mode-" + "present";', 'export { label };'].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag a mode literal inside a comment', () => {
        expect(findingsOf("// mode === 'screenshot' is forbidden in scenes")).toEqual([]);
      });

      it('does NOT flag a mode literal inside a string literal', () => {
        const src = 'const note = "mode === present is forbidden in scenes";';
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag a type-position mode union (`type X = "present" | "paused"`)', () => {
        const src = 'type Mode = "present" | "paused" | "screenshot"; export type { Mode };';
        expect(findingsOf(src)).toEqual([]);
      });
    });

    describe('loose equality (defense in depth against lint bypass)', () => {
      // `==` / `!=` are forbidden by the project's lint rules in
      // application code, but a scene that bypasses the lint with an
      // inline disable AND compares `.mode` against a mode literal
      // still violates the architectural rule. The gate flags both
      // strict and loose equality so a lint-bypass doesn't slip past.
      it.each([
        ["loose === — `ctx.mode == 'screenshot'`", "if (ctx.mode == 'screenshot') {}"],
        ["loose !== — `ctx.mode != 'paused'`", "if (ctx.mode != 'paused') {}"],
        ["flipped loose === — `'loop' == ctx.mode`", "if ('loop' == ctx.mode) {}"],
        ["flipped loose !== — `'present' != ctx.mode`", "if ('present' != ctx.mode) {}"],
      ])('flags %s', (_label, source) => {
        const findings = findingsOf(`declare const ctx: { mode: string }; ${source}`);
        expect(findings.map((f) => f.label)).toContain('mode-literal comparison in scene module');
        expect(findings).toHaveLength(1);
      });
    });

    describe('file-local const alias of a mode literal', () => {
      // Codex review (cycle 1): `const SCREENSHOT = 'screenshot';
      // if (ctx.mode === SCREENSHOT) {}` was a blind spot. The
      // literal-alias collector resolves single-step and chained
      // `const` bindings so the comparison fires the same way as the
      // inline literal.
      it('flags `const SCREENSHOT = "screenshot"; if (ctx.mode === SCREENSHOT) {}`', () => {
        const src = [
          'declare const ctx: { mode: string };',
          "const SCREENSHOT = 'screenshot';",
          'if (ctx.mode === SCREENSHOT) {}',
        ].join('\n');
        const findings = findingsOf(src);
        expect(findings.map((f) => f.label)).toContain('mode-literal comparison in scene module');
        // The finding lands on the comparison line, not the binding.
        expect(
          findings.find((f) => f.label === 'mode-literal comparison in scene module')?.line,
        ).toBe(3);
      });

      it('flags chained const aliases (`const A = "loop"; const B = A; ctx.mode === B`)', () => {
        const src = [
          'declare const ctx: { mode: string };',
          "const A = 'loop';",
          'const B = A;',
          'if (ctx.mode === B) {}',
        ].join('\n');
        const findings = findingsOf(src);
        expect(findings.map((f) => f.label)).toContain('mode-literal comparison in scene module');
        expect(findings).toHaveLength(1);
      });

      it('flags out-of-order chained aliases (declaration after use)', () => {
        // Fixed-point iteration must handle declarations whose RHS
        // depends on a later binding. Without it, `B` would only
        // register on a pass that ran after `A`'s pass.
        const src = [
          'declare const ctx: { mode: string };',
          'const B = A;',
          "const A = 'loop';",
          'if (ctx.mode === B) {}',
        ].join('\n');
        const findings = findingsOf(src);
        expect(findings.map((f) => f.label)).toContain('mode-literal comparison in scene module');
        expect(findings).toHaveLength(1);
      });

      it('flags `case TARGET:` inside `switch (ctx.mode)` when `const TARGET = "screenshot"`', () => {
        const src = [
          'declare const ctx: { mode: string };',
          "const TARGET = 'screenshot';",
          'switch (ctx.mode) {',
          '  case TARGET: break;',
          '  default: break;',
          '}',
        ].join('\n');
        const findings = findingsOf(src);
        expect(findings.map((f) => f.label)).toContain('mode-literal switch case in scene module');
        expect(findings).toHaveLength(1);
      });

      it('flags loose-equality through an alias (`ctx.mode == SCREENSHOT`)', () => {
        const src = [
          'declare const ctx: { mode: string };',
          "const SCREENSHOT = 'screenshot';",
          'if (ctx.mode == SCREENSHOT) {}',
        ].join('\n');
        const findings = findingsOf(src);
        expect(findings.map((f) => f.label)).toContain('mode-literal comparison in scene module');
        expect(findings).toHaveLength(1);
      });

      it('does NOT flag an alias to a non-mode literal (`const X = "kebab"; ctx.mode === X`)', () => {
        const src = [
          'declare const ctx: { mode: string };',
          "const X = 'unknown-future-mode';",
          'if (ctx.mode === X) {}',
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT track a `let` alias (the gate is `const`-only on purpose)', () => {
        // `let` re-assignment can quietly invalidate the alias map.
        // Scene modules that route a mode value through a mutable
        // local for branching are exotic enough that the line-allow
        // tag is the right escape hatch rather than full flow
        // analysis here.
        const src = [
          'declare const ctx: { mode: string };',
          "let target: string = 'screenshot';",
          'if (ctx.mode === target) {}',
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });
    });

    describe('membership-call branches (`<receiver>.includes(<.mode>)`)', () => {
      // Codex review (cycle 1): `if (['paused'].includes(ctx.mode)) {}`
      // was another bypass. The visitor now flags any
      // `<array>.includes(<.mode>)` call where the array literal or
      // its `const`-aliased equivalent contains a NAVIGATION_MODES
      // literal.
      it.each(NAVIGATION_MODES.map((m) => [m]))(
        "flags `[\\'%s\\'].includes(ctx.mode)` (inline array literal)",
        (mode) => {
          const findings = findingsOf(
            `declare const ctx: { mode: string }; if (['${mode}'].includes(ctx.mode)) {}`,
          );
          expect(findings.map((f) => f.label)).toContain(
            'mode-literal membership branch in scene module',
          );
          expect(findings).toHaveLength(1);
        },
      );

      it("flags multi-element `['paused', 'screenshot'].includes(ctx.mode)`", () => {
        const findings = findingsOf(
          "declare const ctx: { mode: string }; if (['paused', 'screenshot'].includes(ctx.mode)) {}",
        );
        expect(findings.map((f) => f.label)).toContain(
          'mode-literal membership branch in scene module',
        );
        expect(findings).toHaveLength(1);
      });

      it('flags aliased-array `const MUTED = ["paused"]; MUTED.includes(ctx.mode)`', () => {
        const src = [
          'declare const ctx: { mode: string };',
          "const MUTED = ['paused', 'screenshot'];",
          'if (MUTED.includes(ctx.mode)) {}',
        ].join('\n');
        const findings = findingsOf(src);
        expect(findings.map((f) => f.label)).toContain(
          'mode-literal membership branch in scene module',
        );
        expect(findings).toHaveLength(1);
      });

      it('flags chained alias of an array (`const A = ["paused"]; const B = A; B.includes(ctx.mode)`)', () => {
        const src = [
          'declare const ctx: { mode: string };',
          "const A = ['paused'];",
          'const B = A;',
          'if (B.includes(ctx.mode)) {}',
        ].join('\n');
        const findings = findingsOf(src);
        expect(findings.map((f) => f.label)).toContain(
          'mode-literal membership branch in scene module',
        );
        expect(findings).toHaveLength(1);
      });

      it('flags bare-`mode` argument (`["paused"].includes(mode)`)', () => {
        const src = "declare const mode: string; if (['paused'].includes(mode)) {}";
        const findings = findingsOf(src);
        expect(findings.map((f) => f.label)).toContain(
          'mode-literal membership branch in scene module',
        );
        expect(findings).toHaveLength(1);
      });

      it('does NOT flag the canonical `NAVIGATION_MODES.includes(ctx.mode)` validation', () => {
        const src = [
          'declare const NAVIGATION_MODES: readonly string[];',
          'declare const ctx: { mode: string };',
          'const ok = NAVIGATION_MODES.includes(ctx.mode);',
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag an array whose elements are not NAVIGATION_MODES members', () => {
        const src = [
          'declare const ctx: { mode: string };',
          "if (['foo', 'bar'].includes(ctx.mode)) {}",
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag `.includes()` on a non-`.mode` argument', () => {
        const src = [
          'declare const ctx: { kind: string };',
          "if (['paused', 'screenshot'].includes(ctx.kind)) {}",
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag a different method name (`["paused"].some(x => x === ctx.mode)`)', () => {
        // The `.some(x => x === ctx.mode)` form has the comparison
        // inside the callback; the inner `===` against a `.mode` read
        // is caught by the binary-equality rule, but only if the
        // inner predicate compares against a mode literal. Here the
        // predicate is `x === ctx.mode` which has no literal, so no
        // finding is correct.
        const src = [
          'declare const ctx: { mode: string };',
          "if (['paused', 'screenshot'].some((x) => x === ctx.mode)) {}",
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('honors the line-allow tag on a `.includes()` branch', () => {
        const src =
          "declare const ctx: { mode: string }; if (['screenshot'].includes(ctx.mode)) {} // PUL-A008-allow: scene-owned screenshot suppression";
        expect(findingsOf(src)).toEqual([]);
      });
    });

    describe('exemption marker', () => {
      it('honors `// PUL-A008-allow: <reason>` on the same line', () => {
        const src =
          "declare const ctx: { mode: string }; if (ctx.mode === 'screenshot') {} // PUL-A008-allow: screenshot randomness suppression";
        expect(findingsOf(src)).toEqual([]);
      });

      it('rejects an empty rationale', () => {
        const src =
          "declare const ctx: { mode: string }; if (ctx.mode === 'screenshot') {} // PUL-A008-allow:";
        const findings = findingsOf(src);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.label).toBe('mode-literal comparison in scene module');
      });

      it('rejects a whitespace-only rationale', () => {
        const src =
          "declare const ctx: { mode: string }; if (ctx.mode === 'screenshot') {} // PUL-A008-allow:    ";
        expect(findingsOf(src)).toHaveLength(1);
      });

      it('rejects a marker hidden inside a string literal', () => {
        const src = [
          'declare const ctx: { mode: string };',
          'const note = "// PUL-A008-allow: hidden";',
          "if (ctx.mode === 'screenshot') {}",
        ].join('\n');
        expect(findingsOf(src)).toHaveLength(1);
      });

      it('does NOT honor a marker on a different line (line-scoped)', () => {
        const src = [
          'declare const ctx: { mode: string };',
          '// PUL-A008-allow: see above',
          "if (ctx.mode === 'screenshot') {}",
        ].join('\n');
        const findings = findingsOf(src);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.line).toBe(3);
      });

      it('honors the marker on a `switch` case line (per-case exemption)', () => {
        const src = [
          'declare const ctx: { mode: string };',
          'switch (ctx.mode) {',
          "  case 'screenshot': break; // PUL-A008-allow: scene-owned screenshot suppression",
          "  case 'paused': break;",
          '  default: break;',
          '}',
        ].join('\n');
        const findings = findingsOf(src);
        // Two case arms touch a NAVIGATION_MODES literal; the
        // screenshot arm is exempt, leaving exactly one finding on
        // the `paused` arm.
        expect(findings).toHaveLength(1);
        expect(findings[0]?.text).toContain("case 'paused'");
      });
    });

    describe('reporting', () => {
      it('reports the 1-based line, file path, label, and trimmed source text on every finding', () => {
        const src = [
          'declare const ctx: { mode: string };',
          'const a = 1;',
          "if (ctx.mode === 'screenshot') {}",
          'const b = 2;',
        ].join('\n');
        const findings = findingsOf(src, 'src/scenes/example.ts');
        expect(findings).toHaveLength(1);
        // Explicit `text` assertion catches a silent regression in
        // `lineText()` that would corrupt the runtime-tree diagnostic
        // (the human-readable context in the violation message) without
        // any other test catching it.
        expect(findings[0]).toMatchObject({
          file: 'src/scenes/example.ts',
          line: 3,
          label: 'mode-literal comparison in scene module',
          text: "if (ctx.mode === 'screenshot') {}",
        });
      });
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('scenes root `src/scenes/` exists and contains at least one .ts file', () => {
      expect(statSync(SCENES_ROOT).isDirectory()).toBe(true);
      expect(walkTsFiles(SCENES_ROOT).length).toBeGreaterThan(0);
    });

    it('contains no A008 violations across `src/scenes/**/*.ts`', () => {
      const files = walkTsFiles(SCENES_ROOT);
      const findings: SourceFinding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        findings.push(...scanA008(parseSource(text, rel)));
      }
      const header =
        'PUL-A008 forbids scene modules from branching on workbench mode literals (`ctx.mode === "screenshot"`, `switch (ctx.mode) { case "loop": ... }`, etc.). Mode dispatch lives in the runtime core (`src/runtime/navigation.ts`, `src/runtime/scene-loader.ts`); scenes consume bounded `ctx.mode` hints. Add a `// PUL-A008-allow: <reason>` exemption on the same line only when scene-owned behavior cannot be enforced centrally (e.g., deterministic randomness under mode=screenshot).';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });

    it('runtime core `src/runtime/` is exempt by scope (the dispatch boundary)', () => {
      // The scope is `src/scenes/**/*.ts`, so `src/runtime/navigation.ts`
      // and `src/runtime/scene-loader.ts` — which deliberately contain
      // the mode-literal comparisons this gate forbids in scenes —
      // never enter the scan. This test pins that property so a
      // future change to the scope cannot silently drag the dispatch
      // boundary into the gate.
      const navigation = join(SRC_ROOT, 'runtime', 'navigation.ts');
      const loader = join(SRC_ROOT, 'runtime', 'scene-loader.ts');
      expect(statSync(navigation).isFile()).toBe(true);
      expect(statSync(loader).isFile()).toBe(true);
      const sceneFiles = walkTsFiles(SCENES_ROOT);
      expect(sceneFiles).not.toContain(navigation);
      expect(sceneFiles).not.toContain(loader);
    });
  });
});
