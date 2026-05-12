import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type ImportBanRule,
  REPO_ROOT,
  SRC_ROOT,
  type SourceFinding,
  collectLineExemptions,
  parseSource,
  scanImportSpecifiers,
  walkTsFiles,
} from './source-policy';

// PUL-A001 — Timeline library encapsulation.
//
// Statement: "Scene modules SHALL NOT import the timeline library
// directly. Scene timelines SHALL be constructed via the timeline
// utilities exposed on the scene context."
//
// Enforcement: a Vitest source scan over `src/scenes/**/*.ts` that
// flags every import — static (`import ... from 'gsap'`), dynamic
// (`import('gsap')`), and type-only (`import type ... from 'gsap'`) —
// of the `gsap` package and its subpaths. The runtime adapter at
// `src/runtime/timeline.ts` is the ONLY production module allowed to
// import GSAP; it is outside the scene scope so the scan never sees
// it. Scenes consume the timeline engine via `ctx.gsap`.
//
// Exemption: a line-scoped `// PUL-A001-allow: <reason>` marker
// excludes a single line. Empty / whitespace-only rationales are
// rejected; markers hidden inside string literals are rejected.

const RULE: ImportBanRule = {
  label: 'gsap (scene module imports timeline library directly)',
  specifiers: ['gsap', 'gsap/'],
  boundaries: [],
  allowTag: 'PUL-A001-allow',
};

const SCENES_ROOT = join(SRC_ROOT, 'scenes');

function scanForA001(source: string, file: string): readonly SourceFinding[] {
  const sf = parseSource(source, file);
  const exempted = collectLineExemptions(sf, RULE.allowTag);
  return scanImportSpecifiers(sf, RULE, exempted);
}

describe('PUL-A001 — timeline library encapsulation (source scan)', () => {
  describe('scanner self-tests', () => {
    it.each([
      ["import { gsap } from 'gsap';", '(static import)'],
      ["import gsap from 'gsap';", '(static import)'],
      ["import * as gsap from 'gsap';", '(static import)'],
      ["import { Draggable } from 'gsap/Draggable';", '(static import)'],
      ["import 'gsap/all';", '(static import)'],
      ["await import('gsap');", '(dynamic import)'],
      ["await import('gsap/Draggable');", '(dynamic import)'],
      ["import type { Tween } from 'gsap';", '(type-only import)'],
      ["export { gsap } from 'gsap';", '(re-export)'],
      ["export * from 'gsap';", '(re-export)'],
    ])('flags `%s` %s', (source, suffix) => {
      const findings = scanForA001(source, 'src/scenes/x.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(`${RULE.label} ${suffix}`);
    });

    it('does NOT flag scenes that read `ctx.gsap` (the canonical path)', () => {
      const src = [
        'import type { WorkbenchSceneCtx } from "../runtime/scene-loader";',
        'export const timeline = (ctx: WorkbenchSceneCtx) => ctx.gsap.timeline();',
      ].join('\n');
      const findings = scanForA001(src, 'src/scenes/example.ts');
      expect(findings).toEqual([]);
    });

    it('does NOT flag a local identifier named `gsap`', () => {
      const src = 'const gsap = { timeline: () => null }; gsap.timeline();';
      expect(scanForA001(src, 'src/scenes/x.ts')).toEqual([]);
    });

    it('does NOT flag `gsap` in a comment or string literal', () => {
      const src = "// gsap is forbidden in scenes\nconst note = 'gsap';";
      expect(scanForA001(src, 'src/scenes/x.ts')).toEqual([]);
    });

    it('does NOT flag a similarly-named package (whole-specifier match)', () => {
      const src = "import { thing } from 'gsap-like-name';";
      expect(scanForA001(src, 'src/scenes/x.ts')).toEqual([]);
    });

    it('honors `// PUL-A001-allow: <reason>` exemption on the import line', () => {
      const src =
        "import { gsap } from 'gsap'; // PUL-A001-allow: see ADR-XYZ — adapter-bridging fixture";
      expect(scanForA001(src, 'src/scenes/x.ts')).toEqual([]);
    });

    it('rejects an empty exemption rationale', () => {
      const src = "import { gsap } from 'gsap'; // PUL-A001-allow:";
      expect(scanForA001(src, 'src/scenes/x.ts')).toHaveLength(1);
    });

    it('reports the import line and the trimmed source text', () => {
      const src = ['// header', '', "import { gsap } from 'gsap';"].join('\n');
      const findings = scanForA001(src, 'src/scenes/example.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.file).toBe('src/scenes/example.ts');
      expect(findings[0]?.line).toBe(3);
      expect(findings[0]?.text).toBe("import { gsap } from 'gsap';");
    });

    it('the shared `boundaries` escape hatch suppresses findings for files inside the boundary', () => {
      // The repo-level PUL-A001 rule does not use `boundaries` (the
      // adapter is excluded by file scope instead). This test exercises
      // the shared `scanImportSpecifiers` boundary behaviour directly
      // so a future caller that does supply a boundary list gets the
      // documented contract — and a regression in the shared helper is
      // caught here regardless of how the per-policy rules scope their
      // files.
      const ruleWithBoundary: ImportBanRule = {
        ...RULE,
        boundaries: ['src/runtime/timeline.ts'],
      };
      const sf = parseSource(
        "import { gsap } from 'gsap';",
        join(SRC_ROOT, 'runtime', 'timeline.ts'),
      );
      const exempted = collectLineExemptions(sf, ruleWithBoundary.allowTag);
      const findings = scanImportSpecifiers(sf, ruleWithBoundary, exempted);
      expect(findings).toEqual([]);
    });

    it('the shared `boundaries` escape hatch does NOT suppress findings outside the boundary', () => {
      const ruleWithBoundary: ImportBanRule = {
        ...RULE,
        boundaries: ['src/runtime/timeline.ts'],
      };
      const sf = parseSource(
        "import { gsap } from 'gsap';",
        join(SRC_ROOT, 'scenes', 'example.ts'),
      );
      const exempted = collectLineExemptions(sf, ruleWithBoundary.allowTag);
      const findings = scanImportSpecifiers(sf, ruleWithBoundary, exempted);
      expect(findings).toHaveLength(1);
    });

    it('a directory `boundaries` entry suppresses findings for every file under it', () => {
      const ruleWithBoundary: ImportBanRule = {
        ...RULE,
        boundaries: ['src/runtime/'],
      };
      for (const rel of ['runtime/timeline.ts', 'runtime/audio.ts']) {
        const sf = parseSource("import { gsap } from 'gsap';", join(SRC_ROOT, rel));
        const exempted = collectLineExemptions(sf, ruleWithBoundary.allowTag);
        expect(scanImportSpecifiers(sf, ruleWithBoundary, exempted)).toEqual([]);
      }
    });

    it('the `boundaries` check accepts a repo-relative file path (not just an absolute one)', () => {
      // The runtime-tree assertions in every per-policy test build
      // `SourceFile`s with repo-relative names so diagnostics print
      // `src/runtime/x.ts` instead of an absolute path. The boundary
      // check has to accept that input shape — otherwise the documented
      // adapter escape hatch fails the first time a real caller wires
      // a boundary into a production scan.
      const ruleWithBoundary: ImportBanRule = {
        ...RULE,
        boundaries: ['src/runtime/timeline.ts'],
      };
      const sf = parseSource("import { gsap } from 'gsap';", 'src/runtime/timeline.ts');
      const exempted = collectLineExemptions(sf, ruleWithBoundary.allowTag);
      expect(scanImportSpecifiers(sf, ruleWithBoundary, exempted)).toEqual([]);
    });

    it('the `boundaries` check correctly excludes a repo-relative file path that is OUTSIDE the boundary', () => {
      const ruleWithBoundary: ImportBanRule = {
        ...RULE,
        boundaries: ['src/runtime/timeline.ts'],
      };
      const sf = parseSource("import { gsap } from 'gsap';", 'src/scenes/x.ts');
      const exempted = collectLineExemptions(sf, ruleWithBoundary.allowTag);
      expect(scanImportSpecifiers(sf, ruleWithBoundary, exempted)).toHaveLength(1);
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('scenes root `src/scenes/` exists and contains at least one .ts file', () => {
      expect(statSync(SCENES_ROOT).isDirectory()).toBe(true);
      expect(walkTsFiles(SCENES_ROOT).length).toBeGreaterThan(0);
    });

    it('contains no A001 violations across `src/scenes/**/*.ts`', () => {
      const files = walkTsFiles(SCENES_ROOT);
      const findings: SourceFinding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        const sf = parseSource(text, rel);
        const exempted = collectLineExemptions(sf, RULE.allowTag);
        findings.push(...scanImportSpecifiers(sf, RULE, exempted));
      }
      const header =
        'PUL-A001 forbids scene modules from importing `gsap` / `gsap/*` directly. Construct scene timelines via `ctx.gsap` (the runtime adapter at `src/runtime/timeline.ts`). Add a `// PUL-A001-allow: <reason>` exemption on the same line only as a last resort.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });

    it('runtime adapter `src/runtime/timeline.ts` is exempt by scope (the boundary)', () => {
      // The scope is `src/scenes/**/*.ts`, so the adapter never enters
      // the scan — it would never be flagged even though it imports
      // `gsap`. This test pins that property explicitly so a future
      // change to the scope cannot silently drag the adapter in.
      const adapter = join(SRC_ROOT, 'runtime', 'timeline.ts');
      expect(statSync(adapter).isFile()).toBe(true);
      const text = readFileSync(adapter, 'utf-8');
      expect(text).toMatch(/from\s+['"]gsap['"]/);
      const sceneFiles = walkTsFiles(SCENES_ROOT);
      expect(sceneFiles).not.toContain(adapter);
    });
  });
});
