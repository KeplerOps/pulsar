import { readFileSync } from 'node:fs';
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

// PUL-A006 — Live runtime is independent of slide frameworks.
//
// Statement: "The runtime core SHALL NOT import or depend on
// slide-framework primitives (e.g., reveal.js or Spectacle). Slide
// frameworks MAY be used in companion projects, separate from the
// runtime core."
//
// Enforcement: a Vitest source scan over the runtime-core file set
// (everything under `src/` EXCEPT `src/scenes/**`) that flags any
// import of reveal.js, Spectacle, or their scoped subpackages.

const RULE: ImportBanRule = {
  label: 'slide framework imported by runtime core',
  specifiers: ['reveal.js', 'reveal.js/', 'spectacle', 'spectacle/', '@spectacle/'],
  boundaries: [],
  allowTag: 'PUL-A006-allow',
};

const SCENES_ROOT = join(SRC_ROOT, 'scenes');

function runtimeCoreFiles(): readonly string[] {
  return walkTsFiles(SRC_ROOT).filter((file) => !file.startsWith(`${SCENES_ROOT}/`));
}

function scanForA006(source: string, file: string): readonly SourceFinding[] {
  const sf = parseSource(source, file);
  const exempted = collectLineExemptions(sf, RULE.allowTag);
  return scanImportSpecifiers(sf, RULE, exempted);
}

describe('PUL-A006 — live runtime independent of slide frameworks (source scan)', () => {
  describe('scanner self-tests', () => {
    it.each([
      ["import Reveal from 'reveal.js';", '(static import)'],
      ["import 'reveal.js/dist/reveal.css';", '(static import)'],
      ["import { Deck, Slide } from 'spectacle';", '(static import)'],
      ["import * as Spectacle from 'spectacle';", '(static import)'],
      ["import { Theme } from '@spectacle/theme';", '(static import)'],
      ["await import('reveal.js');", '(dynamic import)'],
      ["import type { Options } from 'reveal.js';", '(type-only import)'],
      ["export * from 'spectacle';", '(re-export)'],
    ])('flags `%s` %s in runtime core', (source, suffix) => {
      const findings = scanForA006(source, 'src/runtime/example.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(`${RULE.label} ${suffix}`);
    });

    it('does NOT flag a similarly-named package (whole-specifier match)', () => {
      const src = "import { thing } from 'reveal.js-toolbelt';";
      expect(scanForA006(src, 'src/runtime/example.ts')).toEqual([]);
    });

    it('does NOT flag a `spectacle` substring in an unrelated specifier', () => {
      const src = "import { thing } from 'spectacle-companion';";
      expect(scanForA006(src, 'src/runtime/example.ts')).toEqual([]);
    });

    it('honors `// PUL-A006-allow: <reason>` exemption on the import line', () => {
      const src =
        "import Reveal from 'reveal.js'; // PUL-A006-allow: documented adapter shim, ADR-001";
      expect(scanForA006(src, 'src/runtime/example.ts')).toEqual([]);
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('runtime-core file set is non-empty', () => {
      expect(runtimeCoreFiles().length).toBeGreaterThan(0);
    });

    it('runtime-core file set excludes `src/scenes/`', () => {
      // Pins the scope filter so a regression that removed or
      // inverted the filter would fail here instead of silently
      // widening the scan. No scene currently imports a slide
      // framework, so without this assertion the "contains no
      // violations" check alone would not catch the scope drift.
      const files = runtimeCoreFiles();
      const scenePaths = files.filter((f) => f.startsWith(`${SCENES_ROOT}/`));
      expect(scenePaths).toEqual([]);
    });

    it('contains no A006 violations across the runtime-core file set', () => {
      const files = runtimeCoreFiles();
      const findings: SourceFinding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        const sf = parseSource(text, rel);
        const exempted = collectLineExemptions(sf, RULE.allowTag);
        findings.push(...scanImportSpecifiers(sf, RULE, exempted));
      }
      const header =
        'PUL-A006 forbids the runtime core from importing slide-framework primitives (reveal.js, Spectacle). Slide frameworks belong in companion projects (ADR-001). Add a `// PUL-A006-allow: <reason>` exemption on the same line if the use is intentional.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });
  });
});
