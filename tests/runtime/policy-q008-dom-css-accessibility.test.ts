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
  unwrap,
  walkSourceFiles,
} from './source-policy';

// PUL-Q008 — Accessibility of DOM/CSS scenes (source-policy gate).
//
// Statement: "Scenes rendered via DOM/CSS SHALL preserve the browser's
// native accessibility tree: text remains selectable, focus order
// follows DOM order, and ARIA attributes are not stripped by the
// runtime."
//
// PUL-Q008 is a *preservation* contract over ADR-005 (DOM/CSS is the
// default rendering surface). The runtime today already passes
// scene-authored DOM through untouched; this gate locks the property
// in by banning the structural hazards the codex preflight
// (`docs/design/pul-q008-dom-css-accessibility-preflight.md`) names.
// End-to-end browser proof of the three clauses runs in
// `tests-e2e/dom-css-accessibility.spec.ts` under the existing
// PUL-Q002 Playwright matrix; this Vitest gate is defense in depth
// at the source seam.
//
// Surface families enforced here, parameterised by tables so future
// rules add a row without rewriting the walker:
//
//   1. Scene-authored attribute writes (source modules under `src/scenes/`) —
//      `setAttribute(name, value)` calls whose `(name, value)` pair
//      hits a forbidden row in `FORBIDDEN_SCENE_ATTRS`:
//        - `tabindex` with a string-literal positive integer
//          (`"1"`, `"2"`, ...) — DOM-order override (clause C2).
//          `"0"`, `"-1"`, and any non-literal value are NOT flagged
//          by this rule (a non-literal might be a runtime-supplied
//          neutral value; the bounded conservative scope catches
//          the actual hazard the preflight names).
//        - `aria-hidden` with value `'true'` — hiding scene-authored
//          content from the accessibility tree (clause C3 +
//          preflight anti-pattern).
//        - `inert` with any value — inherently suppresses
//          accessibility exposure on the subtree (preflight
//          anti-pattern).
//
//   2. Scene-authored equivalent DOM property + style API calls
//      (codex pre-push review, cycle 1, class finding). The same
//      hazards are reachable through these non-`setAttribute` forms,
//      so the matcher classifies them onto the same rule table:
//        - `el.tabIndex = <positive>` / `el.tabIndex = <positive>`
//          (the IDL reflection of `tabindex`).
//        - `el.inert = true` (the IDL reflection of `inert`).
//        - `el.ariaHidden = 'true'` (the IDL reflection of
//          `aria-hidden`).
//        - `el.style.userSelect = 'none'` and the kebab variants
//          (`MozUserSelect`, `WebkitUserSelect`, `msUserSelect`).
//        - `el.style.setProperty('user-select', 'none')` and the
//          vendor-prefixed property names.
//
//   3. Scene-authored CSS strings (source modules under `src/scenes/`) —
//      `FORBIDDEN_SCENE_CSS_DECLARATIONS` matched against a
//      *normalised* form of every string literal AND every
//      template-literal head/span. Normalisation collapses runs of
//      whitespace (including newlines) into a single space and
//      removes whitespace around `:` so common CSS authoring forms
//      hit the same rule:
//        - `user-select: none`, `user-select:none`,
//          `user-select :  none`, `user-select:\nnone` all match.
//        - Same for `-webkit-user-select`, `-moz-user-select`,
//          `-ms-user-select`.
//      Comments are NOT scanned (the TS scanner classifies tokens,
//      so a `// user-select: none` comment is not a string-literal
//      token); the existing `source-policy.ts` line-exemption parser
//      uses the same scanner discipline.
//
//   4. Runtime-authored attribute removals
//      (source modules under `src/runtime/` + `src/main.ts`) —
//      `removeAttribute(name)` calls whose `name` is a string-literal
//      matching `FORBIDDEN_RUNTIME_REMOVAL_NAMES` (per ARIA tree
//      preservation, clause C3). The runtime owns the stage and may
//      freely remove its own `data-pulsar-*` markers, but it must
//      not strip accessibility attributes the scene authored:
//        - `role`, `tabindex`, `aria-labelledby`, `aria-describedby`
//        - any name matching `^aria-` (catches every present and
//          future ARIA state/property attribute).
//
//      Helper resolution (codex pre-push review, cycle 1, class
//      finding). The runtime today funnels removals through a small
//      `clearStageAttr(name)`-shape helper. Without flow analysis a
//      future caller could pass `'role'` through such a helper and
//      bypass the gate. The walker therefore:
//        a) Collects every module-level `const X = '<literal>';`
//           binding in the file.
//        b) Identifies every "removeAttribute relay" — a function
//           whose body calls `<target>.removeAttribute(<param>)`
//           where `<param>` is one of that function's parameters.
//           Relays are tracked by their binding name in the same
//           file (function declarations, arrow / function-expression
//           initialisers in `const`/`let`/`var` declarations,
//           method shorthand properties, and class methods that
//           are accessible as identifiers via `this`).
//        c) For every `removeAttribute(arg)` call AND every call to
//           a tracked relay function, classifies the argument:
//             - Direct string literal → check the literal.
//             - Identifier resolving to a module-level const literal
//               → check the resolved literal.
//             - Anything else → flag as a non-literal name whose
//               accessibility safety cannot be proven statically.
//
//      The check is anchored on the call-expression callee
//      `removeAttribute` (any receiver) so `stage.removeAttribute`,
//      `el.removeAttribute`, and `(stage as Element).removeAttribute`
//      all match the same way. The runtime today only removes
//      `data-pulsar-*` markers — those are NOT in the blocked set
//      by construction.
//
// Argument unwrapping (codex pre-push review, cycle 1, class
// finding). Every name/value classifier first runs the shared
// `unwrap()` helper from `source-policy.ts` so value-preserving
// TypeScript wrappers (`as` assertions, `as const`, parentheses,
// non-null `!`, `satisfies`) do not let a forbidden literal slip
// past — `setAttribute(('tabindex' as const), '1')` and
// `removeAttribute(('aria-label'))` classify identically to the
// canonical forms.
//
// Exemption: a line-scoped `// PUL-Q008-allow: <reason>` marker
// excludes a single line. Empty / whitespace-only rationales are
// rejected; markers hidden inside string literals are rejected
// (the `source-policy.ts` exemption parser uses TypeScript's
// scanner so the marker must be on an actual comment token).

const ALLOW_TAG = 'PUL-Q008-allow';

const SCENES_ROOT = join(SRC_ROOT, 'scenes');
const RUNTIME_ROOT = join(SRC_ROOT, 'runtime');
const MAIN_TS = join(SRC_ROOT, 'main.ts');

// --- Surface tables: scene-authored attribute writes -----------------

interface SceneAttrRule {
  readonly attr: string;
  // `null` matches the attribute at any value (e.g. `inert`).
  readonly valuePredicate: ((literal: string) => boolean) | null;
  readonly label: string;
}

const isPositiveIntegerLiteral = (s: string): boolean => /^[1-9]\d*$/.test(s);

const FORBIDDEN_SCENE_ATTRS: readonly SceneAttrRule[] = [
  {
    attr: 'tabindex',
    valuePredicate: isPositiveIntegerLiteral,
    label:
      'tabindex with positive value (scene overrides DOM focus order — PUL-Q008 clause C2; use 0 / -1 or reorder DOM)',
  },
  {
    attr: 'aria-hidden',
    valuePredicate: (v) => v === 'true',
    label:
      'aria-hidden="true" (scene hides authored content from the accessibility tree — PUL-Q008 clause C3)',
  },
  {
    attr: 'inert',
    valuePredicate: null,
    label:
      'inert attribute (scene suppresses focus + accessibility on the subtree — PUL-Q008 preflight anti-pattern)',
  },
];

// --- Surface tables: scene-authored DOM property + style assignments -

// Map from the IDL property name to the `FORBIDDEN_SCENE_ATTRS` entry
// it reflects. Hits when the scene assigns `el.<prop> = <value>`. The
// value classifier mirrors the setAttribute rule: positive-integer
// numeric (or string-literal positive integer) for `tabIndex`,
// `true` (boolean OR string literal `'true'`) for `inert` /
// `ariaHidden`. Reflection-property names are intentionally NOT
// case-folded because IDL spelling is fixed (`ariaHidden`, NOT
// `ariahidden`).
interface SceneDomPropertyRule {
  readonly property: string;
  readonly valuePredicate: (literalValue: string | boolean | number | null) => boolean;
  readonly label: string;
}

const FORBIDDEN_SCENE_DOM_PROPERTIES: readonly SceneDomPropertyRule[] = [
  {
    property: 'tabIndex',
    valuePredicate: (v) => {
      if (typeof v === 'number') return Number.isInteger(v) && v > 0;
      if (typeof v === 'string') return isPositiveIntegerLiteral(v);
      return false;
    },
    label:
      'tabIndex with positive value (scene overrides DOM focus order via the IDL property — PUL-Q008 clause C2)',
  },
  {
    property: 'inert',
    valuePredicate: (v) => v === true || v === 'true',
    label:
      'inert IDL property (scene suppresses focus + accessibility on the subtree — PUL-Q008 preflight anti-pattern)',
  },
  {
    property: 'ariaHidden',
    valuePredicate: (v) => v === 'true' || v === true,
    label:
      'ariaHidden IDL property = "true" (scene hides authored content from the accessibility tree — PUL-Q008 clause C3)',
  },
];

// Forbidden `style.<property>` assignments AND forbidden
// `style.setProperty(<property>, <value>)` calls. The kebab-case
// property names map to camelCase reflections (`user-select` →
// `userSelect`, `-webkit-user-select` → `WebkitUserSelect`, etc.).
// Both spellings are matched against the same value classifier so a
// scene using either form is flagged identically.
interface SceneStyleRule {
  readonly kebab: string;
  readonly camel: string;
  readonly valuePredicate: (literal: string) => boolean;
  readonly label: string;
}

const FORBIDDEN_SCENE_STYLE_PROPERTIES: readonly SceneStyleRule[] = [
  {
    kebab: 'user-select',
    camel: 'userSelect',
    valuePredicate: (v) => v.trim().toLowerCase() === 'none',
    label: 'CSS user-select: none via style API (scene blocks text selection — PUL-Q008 clause C1)',
  },
  {
    kebab: '-webkit-user-select',
    camel: 'WebkitUserSelect',
    valuePredicate: (v) => v.trim().toLowerCase() === 'none',
    label:
      'CSS -webkit-user-select: none via style API (scene blocks text selection — PUL-Q008 clause C1)',
  },
  {
    kebab: '-moz-user-select',
    camel: 'MozUserSelect',
    valuePredicate: (v) => v.trim().toLowerCase() === 'none',
    label:
      'CSS -moz-user-select: none via style API (scene blocks text selection — PUL-Q008 clause C1)',
  },
  {
    kebab: '-ms-user-select',
    camel: 'msUserSelect',
    valuePredicate: (v) => v.trim().toLowerCase() === 'none',
    label:
      'CSS -ms-user-select: none via style API (scene blocks text selection — PUL-Q008 clause C1)',
  },
];

// --- Surface tables: scene-authored CSS declarations ------------------

// Token-level CSS-declaration needles. Matched against the
// whitespace-normalised cooked text of each string literal so
// authoring variants like `user-select : none`, `user-select:\nnone`,
// `USER-SELECT: NONE`, etc. all hit the same rule. Normalisation:
//   1. Lowercase the entire string.
//   2. Collapse every run of `\s+` to a single space.
//   3. Remove whitespace immediately around `:`.
// The canonical form is therefore `<property>:<value>`.
interface CssDeclarationRule {
  readonly canonical: string;
  readonly label: string;
}

const FORBIDDEN_SCENE_CSS_DECLARATIONS: readonly CssDeclarationRule[] = [
  {
    canonical: 'user-select:none',
    label: 'CSS user-select: none (scene blocks text selection — PUL-Q008 clause C1)',
  },
  {
    canonical: '-webkit-user-select:none',
    label: 'CSS -webkit-user-select: none (scene blocks text selection — PUL-Q008 clause C1)',
  },
  {
    canonical: '-moz-user-select:none',
    label: 'CSS -moz-user-select: none (scene blocks text selection — PUL-Q008 clause C1)',
  },
  {
    canonical: '-ms-user-select:none',
    label: 'CSS -ms-user-select: none (scene blocks text selection — PUL-Q008 clause C1)',
  },
];

const normaliseCssText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*/g, ':');

// --- Surface tables: runtime attribute removals -----------------------

const FORBIDDEN_RUNTIME_REMOVAL_NAMES: ReadonlySet<string> = new Set([
  'role',
  'tabindex',
  'aria-labelledby',
  'aria-describedby',
]);

const isForbiddenRuntimeRemovalName = (name: string): boolean => {
  if (FORBIDDEN_RUNTIME_REMOVAL_NAMES.has(name)) return true;
  return name.startsWith('aria-');
};

// --- AST helpers ------------------------------------------------------

/**
 * Read the cooked text of a static string-literal-like expression
 * after unwrapping value-preserving TypeScript wrappers (parens,
 * `as`, `as const`, non-null `!`, `satisfies`). Returns `null` when
 * the unwrapped node is not a static string (template literals with
 * substitutions cannot be classified at scan time). The CSS-substring
 * scanner walks template-literal heads + spans separately so a
 * `${dynamic}` interpolation does NOT prevent matching on the static
 * portion.
 */
function staticStringValue(node: ts.Expression): string | null {
  const inner = unwrap(node);
  if (ts.isStringLiteralLike(inner)) return inner.text;
  return null;
}

/**
 * Classify a value expression as one of: string literal (cooked
 * text), numeric literal, boolean literal, or `null` (anything else).
 * Used by the DOM-property assignment matcher whose value rules
 * accept either a string ('true', '1') or a typed primitive
 * (`true`, `1`). Wrappers are unwrapped first.
 */
function literalPrimitiveValue(node: ts.Expression): string | boolean | number | null {
  const inner = unwrap(node);
  if (ts.isStringLiteralLike(inner)) return inner.text;
  if (inner.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(inner)) {
    const n = Number(inner.text);
    return Number.isFinite(n) ? n : null;
  }
  // Negative numeric (`-1`) parses as a PrefixUnaryExpression.
  if (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(inner.operand)
  ) {
    const n = -Number(inner.operand.text);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Return the unqualified method name of a call expression whose
 * callee is a property access `<receiver>.<name>(...)`. Receiver is
 * unwrapped first so `(stage as Element).setAttribute(...)` returns
 * `'setAttribute'`. Returns `null` for free-function calls and for
 * computed-element-access callees.
 */
function callTargetMethod(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/**
 * Return the property name of an access expression `<receiver>.<name>`
 * (post-unwrap). Returns `null` when the access is computed
 * (element-access with a non-literal subscript) or not a property
 * access at all.
 */
function staticPropertyName(node: ts.Expression): string | null {
  const inner = unwrap(node);
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  if (ts.isElementAccessExpression(inner)) {
    const arg = unwrap(inner.argumentExpression);
    if (ts.isStringLiteralLike(arg)) return arg.text;
  }
  return null;
}

/**
 * Walk a property access chain and return the unqualified tail name
 * AT a specific depth from the receiver root. Used to detect
 * `el.style.<property>` assignments and `el.style.setProperty(...)`
 * calls without anchoring on the identity of `el`.
 *
 * `getAccessSegments(el.style.userSelect)` →
 *   ['userSelect', 'style', 'el']
 *
 * Returns the segments in tail→root order. Computed segments with a
 * literal subscript are accepted (the literal becomes the segment);
 * any non-literal computed segment yields `null` overall.
 */
function getAccessSegments(node: ts.Expression): readonly string[] | null {
  const out: string[] = [];
  let current: ts.Expression = unwrap(node);
  while (true) {
    current = unwrap(current);
    if (ts.isPropertyAccessExpression(current)) {
      out.push(current.name.text);
      current = current.expression;
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      const arg = unwrap(current.argumentExpression);
      if (!ts.isStringLiteralLike(arg)) return null;
      out.push(arg.text);
      current = current.expression;
      continue;
    }
    if (ts.isIdentifier(current)) {
      out.push(current.text);
      return out;
    }
    if (current.kind === ts.SyntaxKind.ThisKeyword) {
      out.push('this');
      return out;
    }
    return null;
  }
}

// --- Scene scanner ----------------------------------------------------

function scanScenesFile(sourceFile: ts.SourceFile): SourceFinding[] {
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const findings: SourceFinding[] = [];
  const file = sourceFile.fileName;

  const record = (node: ts.Node, label: string): void => {
    const start = node.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    if (exempted.has(line)) return;
    findings.push({
      file,
      line: line + 1,
      text: lineText(sourceFile, line).trim(),
      label,
    });
  };

  // 1. CSS string-literal substring scan (canonical declaration form
  //    after whitespace normalisation).
  const checkCssText = (text: string, node: ts.Node): void => {
    const canonical = normaliseCssText(text);
    for (const rule of FORBIDDEN_SCENE_CSS_DECLARATIONS) {
      if (canonical.includes(rule.canonical)) {
        record(node, rule.label);
        return;
      }
    }
  };

  const visitCss = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      checkCssText(node.text, node);
    } else if (ts.isTemplateExpression(node)) {
      // Walk head + every span text; substitutions are not classified.
      checkCssText(node.head.text, node.head);
      for (const span of node.templateSpans) {
        checkCssText(span.literal.text, span.literal);
      }
    }
  };

  // 2. `el.setAttribute('<attr>', '<value>')` matcher.
  const checkSetAttribute = (call: ts.CallExpression): void => {
    const nameArg = call.arguments[0];
    const valueArg = call.arguments[1];
    if (!nameArg || !valueArg) return;
    const name = staticStringValue(nameArg);
    if (name === null) return;
    for (const rule of FORBIDDEN_SCENE_ATTRS) {
      if (rule.attr !== name) continue;
      if (rule.valuePredicate === null) {
        record(call, rule.label);
        return;
      }
      const value = staticStringValue(valueArg);
      if (value !== null && rule.valuePredicate(value)) {
        record(call, rule.label);
        return;
      }
    }
  };

  // 3. `el.<idl-property> = <value>` matcher (binary-expression
  //    assignment where the left side is `<receiver>.<property>`).
  //    Covers the tabIndex / inert / ariaHidden IDL reflections.
  const checkDomPropertyAssignment = (binary: ts.BinaryExpression): void => {
    if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const segments = getAccessSegments(binary.left);
    if (segments === null || segments.length < 2) return;
    const property = segments[0];
    if (property === undefined) return;
    // Exclude `<receiver>.style.<X> = ...` from this matcher (the
    // style-property matcher below handles those).
    if (segments.length >= 3 && segments[1] === 'style') return;
    for (const rule of FORBIDDEN_SCENE_DOM_PROPERTIES) {
      if (rule.property !== property) continue;
      const value = literalPrimitiveValue(binary.right);
      if (value !== null && rule.valuePredicate(value)) {
        record(binary, rule.label);
      }
      return;
    }
  };

  // 4. `el.style.<property> = <value>` matcher.
  const checkStylePropertyAssignment = (binary: ts.BinaryExpression): void => {
    if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const segments = getAccessSegments(binary.left);
    // Need at least [<style-property>, 'style', ...receiver].
    if (segments === null || segments.length < 3) return;
    if (segments[1] !== 'style') return;
    const property = segments[0];
    if (property === undefined) return;
    for (const rule of FORBIDDEN_SCENE_STYLE_PROPERTIES) {
      if (rule.camel !== property && rule.kebab !== property) continue;
      const valueStr = staticStringValue(binary.right);
      if (valueStr !== null && rule.valuePredicate(valueStr)) {
        record(binary, rule.label);
      }
      return;
    }
  };

  // 5. `el.style.setProperty('<property>', '<value>')` matcher.
  const checkStyleSetProperty = (call: ts.CallExpression): void => {
    const callee = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee)) return;
    if (callee.name.text !== 'setProperty') return;
    // The receiver of `setProperty` must be `<...>.style` for the
    // CSSOM style-declaration. Reject other classes (`URLSearchParams`,
    // `<Map>.setProperty`) by checking the receiver's tail segment.
    const receiverSegments = getAccessSegments(callee.expression);
    if (receiverSegments === null || receiverSegments.length === 0) return;
    if (receiverSegments[0] !== 'style') return;
    const propArg = call.arguments[0];
    const valueArg = call.arguments[1];
    if (!propArg || !valueArg) return;
    const property = staticStringValue(propArg);
    if (property === null) return;
    for (const rule of FORBIDDEN_SCENE_STYLE_PROPERTIES) {
      if (rule.kebab !== property && rule.camel !== property) continue;
      const valueStr = staticStringValue(valueArg);
      if (valueStr !== null && rule.valuePredicate(valueStr)) {
        record(call, rule.label);
      }
      return;
    }
  };

  const visit = (node: ts.Node): void => {
    visitCss(node);
    if (ts.isCallExpression(node)) {
      const method = callTargetMethod(node);
      if (method === 'setAttribute' && node.arguments.length >= 2) {
        checkSetAttribute(node);
      } else if (method === 'setProperty' && node.arguments.length >= 2) {
        checkStyleSetProperty(node);
      }
    }
    if (ts.isBinaryExpression(node)) {
      checkDomPropertyAssignment(node);
      checkStylePropertyAssignment(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// --- Runtime scanner (with helper / alias resolution) -----------------

interface RuntimeAnalysisContext {
  readonly constLiterals: ReadonlyMap<string, string>;
  readonly relays: ReadonlySet<string>;
}

// Collect every top-level `const X = '<literal>'` binding, after
// unwrapping value-preserving wrappers on the initializer. Used so
// `removeAttribute(ATTR_SCENE)` resolves to its module-level
// `'data-pulsar-scene-target'` literal during classification. Inner
// function-scope bindings are NOT collected — overshooting into
// every block scope is unnecessary because the runtime authoring
// pattern places these constants at the module level.
function collectConstLiterals(sourceFile: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer) continue;
      const value = staticStringValue(decl.initializer);
      if (value === null) continue;
      out.set(decl.name.text, value);
    }
  }
  return out;
}

// True when `body` contains a call to `<x>.removeAttribute(p)` where
// `p` is one of `paramNames`. The call must pass exactly one argument
// and that argument must be an identifier reference to a parameter.
// This is the structural shape of a "removeAttribute relay" — a
// helper whose only contribution is forwarding its argument to a
// runtime `removeAttribute`.
function bodyForwardsRemoveAttribute(body: ts.Node, paramNames: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'removeAttribute') {
        const arg = n.arguments[0];
        if (arg && ts.isIdentifier(unwrap(arg))) {
          const ident = unwrap(arg) as ts.Identifier;
          if (paramNames.has(ident.text)) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

// Collect the names of every "removeAttribute relay" function or
// helper accessible by identifier in this file. Captures:
//   - Function declarations (`function X(name) { stage.removeAttribute(name); }`).
//   - Const/let/var bindings whose initializer is an arrow function
//     or function expression with the same forwarding shape.
function collectRelayNames(sourceFile: ts.SourceFile): Set<string> {
  const out = new Set<string>();

  const considerFunctionLike = (
    name: string,
    parameters: readonly ts.ParameterDeclaration[],
    body: ts.Node | undefined,
  ): void => {
    if (body === undefined) return;
    const paramNames = new Set<string>();
    for (const p of parameters) {
      if (ts.isIdentifier(p.name)) paramNames.add(p.name.text);
    }
    if (paramNames.size === 0) return;
    if (bodyForwardsRemoveAttribute(body, paramNames)) out.add(name);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      considerFunctionLike(node.name.text, node.parameters, node.body);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        considerFunctionLike(node.name.text, init.parameters, init.body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

// Classify a `name` argument expression for a `removeAttribute` or
// relay call. Returns:
//   - { kind: 'literal', value } when statically resolvable.
//   - { kind: 'non-literal' } when not.
function classifyNameArg(
  arg: ts.Expression,
  constLiterals: ReadonlyMap<string, string>,
): { kind: 'literal'; value: string } | { kind: 'non-literal' } {
  const direct = staticStringValue(arg);
  if (direct !== null) return { kind: 'literal', value: direct };
  const inner = unwrap(arg);
  if (ts.isIdentifier(inner)) {
    const resolved = constLiterals.get(inner.text);
    if (resolved !== undefined) return { kind: 'literal', value: resolved };
  }
  return { kind: 'non-literal' };
}

// True when `call` is a `<x>.removeAttribute(<param>)` whose argument
// is the parameter of an enclosing function/method/arrow. These calls
// represent the *body* of a tracked relay — classifying them at the
// body site would double-count every call: once at the relay's
// receiver call, and once on the body's pass-through. Call-site
// classification covers the call entirely (and tracks the relay
// binding), so the body site is suppressed.
function isCallInsideRelayBody(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  if (!arg) return false;
  const inner = unwrap(arg);
  if (!ts.isIdentifier(inner)) return false;
  const argName = inner.text;
  let current: ts.Node | undefined = call.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      for (const p of current.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === argName) return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function scanRuntimeFile(sourceFile: ts.SourceFile): SourceFinding[] {
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const findings: SourceFinding[] = [];
  const file = sourceFile.fileName;
  const ctx: RuntimeAnalysisContext = {
    constLiterals: collectConstLiterals(sourceFile),
    relays: collectRelayNames(sourceFile),
  };

  const record = (node: ts.Node, label: string): void => {
    const start = node.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    if (exempted.has(line)) return;
    findings.push({
      file,
      line: line + 1,
      text: lineText(sourceFile, line).trim(),
      label,
    });
  };

  const classifyCall = (
    call: ts.CallExpression,
    surface: 'removeAttribute' | 'relay',
    relayName?: string,
  ): void => {
    const nameArg = call.arguments[0];
    if (!nameArg) return;
    const classification = classifyNameArg(nameArg, ctx.constLiterals);
    if (classification.kind === 'literal') {
      if (isForbiddenRuntimeRemovalName(classification.value)) {
        const surfaceLabel =
          surface === 'removeAttribute'
            ? `removeAttribute('${classification.value}')`
            : `${relayName ?? 'helper'}('${classification.value}') routes to runtime removeAttribute`;
        record(
          call,
          `runtime ${surfaceLabel} (runtime must not strip accessibility attributes authored by scenes — PUL-Q008 clause C3)`,
        );
      }
      return;
    }
    // Non-literal: the name's safety cannot be proven. Flag.
    const surfaceLabel =
      surface === 'removeAttribute'
        ? 'removeAttribute(<non-literal>)'
        : `${relayName ?? 'helper'}(<non-literal>) routes to runtime removeAttribute`;
    record(
      call,
      `runtime ${surfaceLabel} (name must statically resolve to a non-accessibility string literal to prove PUL-Q008 clause C3; bind the value to a module-level \`const\` or pass a string literal)`,
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      // Direct `<x>.removeAttribute(...)`.
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'removeAttribute') {
        // Skip when this call is the body of a tracked relay helper
        // (the call-site classification handles it). Without this
        // guard the relay body itself emits a duplicate finding for
        // every call, and the runtime's existing `clearStageAttr`
        // helper (`stage?.removeAttribute(name)`) would always flag.
        if (!isCallInsideRelayBody(node)) {
          classifyCall(node, 'removeAttribute');
        }
      } else if (ts.isIdentifier(callee) && ctx.relays.has(callee.text)) {
        // Call to a known relay helper.
        classifyCall(node, 'relay', callee.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// --- Tests -----------------------------------------------------------

describe('PUL-Q008 — DOM/CSS accessibility (source scan)', () => {
  describe('scene-authored attribute scanner self-tests', () => {
    const scan = (src: string): SourceFinding[] =>
      scanScenesFile(parseSource(src, 'src/scenes/example.ts'));

    it("flags setAttribute('tabindex', '1')", () => {
      const findings = scan(`el.setAttribute('tabindex', '1');`);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toContain('tabindex');
    });

    it('flags setAttribute("tabindex", "42") (multi-digit positive)', () => {
      expect(scan(`el.setAttribute("tabindex", "42");`)).toHaveLength(1);
    });

    it('does NOT flag setAttribute("tabindex", "0")', () => {
      expect(scan(`el.setAttribute("tabindex", "0");`)).toEqual([]);
    });

    it('does NOT flag setAttribute("tabindex", "-1")', () => {
      expect(scan(`el.setAttribute("tabindex", "-1");`)).toEqual([]);
    });

    it('does NOT flag setAttribute("tabindex", computedValue) (non-literal value)', () => {
      expect(scan(`const v = '0'; el.setAttribute("tabindex", v);`)).toEqual([]);
    });

    it("flags setAttribute('aria-hidden', 'true')", () => {
      const findings = scan(`el.setAttribute('aria-hidden', 'true');`);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toContain('aria-hidden');
    });

    it('does NOT flag setAttribute("aria-hidden", "false")', () => {
      expect(scan(`el.setAttribute("aria-hidden", "false");`)).toEqual([]);
    });

    it("flags setAttribute('inert', '') (any value)", () => {
      expect(scan(`el.setAttribute('inert', '');`)).toHaveLength(1);
    });

    it('does NOT flag arbitrary data-pulsar-* attribute writes', () => {
      expect(scan(`el.setAttribute('data-pulsar-fixture-state', 'ran');`)).toEqual([]);
    });

    it('does NOT flag arbitrary ARIA writes (only the configured value-pair hazards)', () => {
      expect(scan(`el.setAttribute('aria-label', 'alpha');`)).toEqual([]);
      expect(scan(`el.setAttribute('role', 'region');`)).toEqual([]);
      expect(scan(`el.setAttribute('aria-describedby', 'beta');`)).toEqual([]);
    });

    it('does NOT flag a similar-looking attribute name (whole-name match)', () => {
      expect(scan(`el.setAttribute('data-tabindex', '5');`)).toEqual([]);
    });

    it('does NOT flag a comment mentioning tabindex', () => {
      expect(scan(`// el.setAttribute('tabindex', '5')\nvoid 0;`)).toEqual([]);
    });

    it('honors `// PUL-Q008-allow: <reason>` exemption', () => {
      const src = `el.setAttribute('tabindex', '1'); // PUL-Q008-allow: documented exception`;
      expect(scan(src)).toEqual([]);
    });

    it('rejects an empty exemption rationale', () => {
      const src = `el.setAttribute('tabindex', '1'); // PUL-Q008-allow:`;
      expect(scan(src)).toHaveLength(1);
    });

    it('does NOT flag an exemption marker hidden inside a string literal', () => {
      const src = `const s = "PUL-Q008-allow: this is a string";\nel.setAttribute('tabindex', '1');`;
      const findings = scan(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toContain('tabindex');
    });

    it("flags setAttribute(('tabindex'), '1') with wrapped name argument", () => {
      expect(scan(`el.setAttribute(('tabindex'), '1');`)).toHaveLength(1);
    });

    it("flags setAttribute('tabindex' as const, '1') with `as const` wrapper", () => {
      expect(scan(`el.setAttribute('tabindex' as const, '1');`)).toHaveLength(1);
    });

    it("flags setAttribute('aria-hidden', ('true')) with wrapped value argument", () => {
      expect(scan(`el.setAttribute('aria-hidden', ('true'));`)).toHaveLength(1);
    });
  });

  describe('scene-authored DOM property + style scanner self-tests', () => {
    const scan = (src: string): SourceFinding[] =>
      scanScenesFile(parseSource(src, 'src/scenes/example.ts'));

    it('flags el.tabIndex = 1 (numeric literal)', () => {
      const findings = scan('el.tabIndex = 1;');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toContain('tabIndex');
    });

    it('flags el.tabIndex = 42', () => {
      expect(scan('el.tabIndex = 42;')).toHaveLength(1);
    });

    it('does NOT flag el.tabIndex = 0', () => {
      expect(scan('el.tabIndex = 0;')).toEqual([]);
    });

    it('does NOT flag el.tabIndex = -1', () => {
      expect(scan('el.tabIndex = -1;')).toEqual([]);
    });

    it("flags el.tabIndex = '1' (string-literal positive)", () => {
      expect(scan(`el.tabIndex = '1';`)).toHaveLength(1);
    });

    it('flags el.inert = true', () => {
      const findings = scan('el.inert = true;');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toContain('inert');
    });

    it('does NOT flag el.inert = false', () => {
      expect(scan('el.inert = false;')).toEqual([]);
    });

    it("flags el.ariaHidden = 'true'", () => {
      const findings = scan(`el.ariaHidden = 'true';`);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toContain('ariaHidden');
    });

    it("does NOT flag el.ariaHidden = 'false'", () => {
      expect(scan(`el.ariaHidden = 'false';`)).toEqual([]);
    });

    it("flags el.style.userSelect = 'none'", () => {
      const findings = scan(`el.style.userSelect = 'none';`);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toContain('user-select');
    });

    it("flags el.style.WebkitUserSelect = 'none' (camelCase vendor)", () => {
      expect(scan(`el.style.WebkitUserSelect = 'none';`)).toHaveLength(1);
    });

    it("flags el.style.MozUserSelect = 'none'", () => {
      expect(scan(`el.style.MozUserSelect = 'none';`)).toHaveLength(1);
    });

    it("flags el.style.msUserSelect = 'none'", () => {
      expect(scan(`el.style.msUserSelect = 'none';`)).toHaveLength(1);
    });

    it("does NOT flag el.style.userSelect = 'auto'", () => {
      expect(scan(`el.style.userSelect = 'auto';`)).toEqual([]);
    });

    it("flags el.style.setProperty('user-select', 'none')", () => {
      expect(scan(`el.style.setProperty('user-select', 'none');`)).toHaveLength(1);
    });

    it("flags el.style.setProperty('-webkit-user-select', 'none')", () => {
      expect(scan(`el.style.setProperty('-webkit-user-select', 'none');`)).toHaveLength(1);
    });

    it("does NOT flag el.style.setProperty('user-select', 'auto')", () => {
      expect(scan(`el.style.setProperty('user-select', 'auto');`)).toEqual([]);
    });

    it("does NOT flag other.setProperty('user-select', 'none') (not on a style chain)", () => {
      // `URLSearchParams.set('user-select', 'none')` and similar are
      // unrelated to CSS authoring; the matcher only fires when the
      // receiver tail is `style`.
      expect(scan(`params.setProperty('user-select', 'none');`)).toEqual([]);
    });

    it('does NOT flag an unrelated property assignment', () => {
      expect(scan(`el.textContent = 'hello';`)).toEqual([]);
      expect(scan(`el.style.padding = '4px';`)).toEqual([]);
    });

    it('honors `// PUL-Q008-allow: <reason>` exemption on a property assignment', () => {
      expect(scan('el.tabIndex = 1; // PUL-Q008-allow: trap-of-record helper')).toEqual([]);
    });
  });

  describe('scene-authored CSS substring scanner self-tests', () => {
    const scan = (src: string): SourceFinding[] =>
      scanScenesFile(parseSource(src, 'src/scenes/example.ts'));

    it.each([
      `const css = 'user-select: none';`,
      `const css = "user-select:none";`,
      `const css = '-webkit-user-select: none';`,
      `const css = '-webkit-user-select:none';`,
      `const css = '-moz-user-select: none';`,
      `const css = '-ms-user-select: none';`,
    ])('flags `%s`', (src) => {
      const findings = scan(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toContain('user-select');
    });

    it('flags `user-select : none` with whitespace around the colon', () => {
      expect(scan(`const css = 'user-select : none';`)).toHaveLength(1);
    });

    it('flags `user-select  :  none` with multi-space around the colon', () => {
      expect(scan(`const css = 'user-select  :  none';`)).toHaveLength(1);
    });

    it('flags multi-line CSS string with newline between property and value', () => {
      expect(scan(`const css = 'user-select:\\nnone';`)).toHaveLength(1);
    });

    it('flags vendor-prefixed declaration with newline after the colon', () => {
      expect(scan(`const css = '-webkit-user-select:\\n  none';`)).toHaveLength(1);
    });

    it('flags a user-select: none substring inside a larger CSS string', () => {
      const findings = scan(
        `const css = 'p.locked { color: red; user-select: none; padding: 4px; }';`,
      );
      expect(findings).toHaveLength(1);
    });

    it('matches case-insensitively', () => {
      expect(scan(`const css = 'USER-SELECT: NONE';`)).toHaveLength(1);
    });

    it('does NOT flag `user-select: auto`', () => {
      expect(scan(`const css = 'user-select: auto';`)).toEqual([]);
    });

    it('does NOT flag `user-select: text`', () => {
      expect(scan(`const css = 'user-select: text';`)).toEqual([]);
    });

    it('does NOT flag comment-only mentions of user-select: none', () => {
      expect(scan('// user-select: none — forbidden in scenes\nvoid 0;')).toEqual([]);
    });

    it('flags user-select: none inside a template-literal head', () => {
      expect(scan('const css = `user-select: none ${suffix}`;')).toHaveLength(1);
    });

    it('flags user-select: none inside a template-literal span literal', () => {
      expect(scan('const css = `padding: 4px;${prefix} user-select: none;`;')).toHaveLength(1);
    });

    it('honors `// PUL-Q008-allow: <reason>` exemption on a CSS-string line', () => {
      const src = `const css = 'user-select: none'; // PUL-Q008-allow: locked-card subtree`;
      expect(scan(src)).toEqual([]);
    });
  });

  describe('runtime-authored attribute-removal scanner self-tests', () => {
    const scan = (src: string): SourceFinding[] =>
      scanRuntimeFile(parseSource(src, 'src/runtime/example.ts'));

    it.each([
      `stage.removeAttribute('role');`,
      `stage.removeAttribute("tabindex");`,
      `stage.removeAttribute('aria-labelledby');`,
      `stage.removeAttribute('aria-describedby');`,
      `stage.removeAttribute('aria-hidden');`,
      `stage.removeAttribute('aria-label');`,
      `stage.removeAttribute('aria-pressed');`,
    ])('flags `%s`', (src) => {
      const findings = scan(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toContain('removeAttribute');
    });

    it('does NOT flag runtime removal of data-pulsar-* markers (literal)', () => {
      const src = [
        `stage.removeAttribute('data-pulsar-validation-failed');`,
        `stage.removeAttribute('data-pulsar-scene-target');`,
        `stage.removeAttribute('data-pulsar-composition-target');`,
        `stage.removeAttribute('data-pulsar-navigation-error');`,
        `stage.removeAttribute('data-pulsar-scene-failures');`,
        `stage.removeAttribute('data-pulsar-scene-lifecycle');`,
      ].join('\n');
      expect(scan(src)).toEqual([]);
    });

    it('resolves a module-level const literal binding (safe value)', () => {
      const src = [
        `const ATTR_SCENE = 'data-pulsar-scene-target';`,
        'stage.removeAttribute(ATTR_SCENE);',
      ].join('\n');
      expect(scan(src)).toEqual([]);
    });

    it('resolves a module-level const literal binding (forbidden value)', () => {
      const src = [`const ATTR = 'role';`, 'stage.removeAttribute(ATTR);'].join('\n');
      const findings = scan(src);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toContain("removeAttribute('role')");
    });

    it('flags a non-literal name (parameter routed through a non-relay function)', () => {
      // A bare non-literal call site: the name comes from somewhere
      // the scanner cannot trace. The new rule rejects this.
      expect(scan('stage.removeAttribute(externalName);')).toHaveLength(1);
    });

    it('flags a const-resolved aria-* (case insensitivity not assumed)', () => {
      const src = [`const ATTR = 'aria-pressed';`, 'stage.removeAttribute(ATTR);'].join('\n');
      expect(scan(src)).toHaveLength(1);
    });

    it('does NOT flag setAttribute calls (the gate is removal-only)', () => {
      expect(scan(`stage.setAttribute('aria-label', 'workbench');`)).toEqual([]);
    });

    it('honors `// PUL-Q008-allow: <reason>` exemption on a literal removal', () => {
      const src = `stage.removeAttribute('role'); // PUL-Q008-allow: shutdown reset path`;
      expect(scan(src)).toEqual([]);
    });

    it('honors `// PUL-Q008-allow: <reason>` exemption on a non-literal removal', () => {
      const src = 'stage.removeAttribute(externalName); // PUL-Q008-allow: documented relay';
      expect(scan(src)).toEqual([]);
    });

    it("flags removeAttribute(('aria-label')) with wrapped name argument", () => {
      expect(scan(`stage.removeAttribute(('aria-label'));`)).toHaveLength(1);
    });

    it('reports the file/line/text and label of the offending line', () => {
      const findings = scan(['// header', '', `stage.removeAttribute('aria-label');`].join('\n'));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.file).toBe('src/runtime/example.ts');
      expect(findings[0]?.line).toBe(3);
      expect(findings[0]?.text).toBe(`stage.removeAttribute('aria-label');`);
    });

    describe('relay-helper resolution', () => {
      it('flags a forbidden literal routed through an arrow-function relay', () => {
        const src = [
          'const clearStageAttr = (name: string) => { stage.removeAttribute(name); };',
          `clearStageAttr('aria-label');`,
        ].join('\n');
        const findings = scan(src);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.label).toContain('clearStageAttr');
      });

      it('flags a forbidden literal routed through a function declaration relay', () => {
        const src = [
          'function clearAttr(name: string) { stage.removeAttribute(name); }',
          `clearAttr('role');`,
        ].join('\n');
        expect(scan(src)).toHaveLength(1);
      });

      it('does NOT flag a relay called with a safe literal', () => {
        const src = [
          'const clearStageAttr = (name: string) => { stage.removeAttribute(name); };',
          `clearStageAttr('data-pulsar-scene-target');`,
        ].join('\n');
        expect(scan(src)).toEqual([]);
      });

      it('does NOT flag a relay called with a const-resolved safe name', () => {
        const src = [
          `const ATTR_SCENE = 'data-pulsar-scene-target';`,
          'const clearStageAttr = (name: string) => { stage.removeAttribute(name); };',
          'clearStageAttr(ATTR_SCENE);',
        ].join('\n');
        expect(scan(src)).toEqual([]);
      });

      it('flags a relay called with a const-resolved forbidden name', () => {
        const src = [
          `const ATTR = 'aria-label';`,
          'const clearStageAttr = (name: string) => { stage.removeAttribute(name); };',
          'clearStageAttr(ATTR);',
        ].join('\n');
        expect(scan(src)).toHaveLength(1);
      });

      it('flags a relay called with a non-literal (unresolved) name', () => {
        const src = [
          'const clearStageAttr = (name: string) => { stage.removeAttribute(name); };',
          'clearStageAttr(externalName);',
        ].join('\n');
        expect(scan(src)).toHaveLength(1);
      });
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('scenes root `src/scenes/` exists and contains at least one source module file', () => {
      expect(statSync(SCENES_ROOT).isDirectory()).toBe(true);
      expect(walkSourceFiles(SCENES_ROOT).length).toBeGreaterThan(0);
    });

    it('runtime root `src/runtime/` exists and contains at least one source module file', () => {
      expect(statSync(RUNTIME_ROOT).isDirectory()).toBe(true);
      expect(walkSourceFiles(RUNTIME_ROOT).length).toBeGreaterThan(0);
    });

    it('`src/main.ts` exists', () => {
      expect(statSync(MAIN_TS).isFile()).toBe(true);
    });

    it('contains no Q008 violations across source modules under `src/scenes/`', () => {
      const files = walkSourceFiles(SCENES_ROOT);
      const findings: SourceFinding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        const sf = parseSource(text, rel);
        findings.push(...scanScenesFile(sf));
      }
      const header =
        'PUL-Q008 forbids scene-authored DOM/CSS that defeats the browser accessibility tree: positive `tabindex`, `aria-hidden="true"`, `inert`, the IDL reflections of those attributes (`tabIndex`, `inert`, `ariaHidden`), CSS `user-select: none` (any vendor prefix), and the `style` API equivalents (`el.style.userSelect = "none"`, `el.style.setProperty("user-select", "none")`, vendor-prefixed forms). Reorder DOM for focus, use 0/-1 for `tabindex`, omit `aria-hidden`/`inert`, and leave text selectable. Add a `// PUL-Q008-allow: <reason>` exemption on the same line only as a last resort.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });

    it('contains no Q008 violations across source modules under `src/runtime/`', () => {
      const files = walkSourceFiles(RUNTIME_ROOT);
      const findings: SourceFinding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        const sf = parseSource(text, rel);
        findings.push(...scanRuntimeFile(sf));
      }
      const header =
        'PUL-Q008 forbids the runtime from removing accessibility attributes authored by scenes (aria-*, role, tabindex, aria-labelledby, aria-describedby). The runtime owns the stage and may freely remove its own `data-pulsar-*` markers, but ARIA attributes the scene set must survive lifecycle transitions. Helper functions whose body forwards a parameter to `<x>.removeAttribute(...)` are tracked as relays; every call site is classified the same way as a direct `removeAttribute` call. Non-literal names that cannot be resolved through a module-level `const` binding are flagged.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });

    it('contains no Q008 violations in `src/main.ts`', () => {
      const text = readFileSync(MAIN_TS, 'utf-8');
      const rel = relative(REPO_ROOT, MAIN_TS);
      const sf = parseSource(text, rel);
      const findings = scanRuntimeFile(sf);
      const header =
        'PUL-Q008 forbids `src/main.ts` from removing accessibility attributes — the workbench bootstrap participates in the same ARIA-preservation contract as source modules under `src/runtime/`.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });
  });
});
