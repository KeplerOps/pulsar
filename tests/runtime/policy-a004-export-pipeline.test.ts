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

// PUL-A004 — Live runtime is independent of the export pipeline.
//
// Statement: "The runtime core SHALL NOT import Remotion or any
// video-rendering library. Export functionality SHALL live in a
// separate codebase that consumes the same scene metadata and
// composition manifests."
//
// Enforcement: a Vitest source scan over the runtime-core file set
// (everything under `src/` EXCEPT `src/scenes/**`) that flags any
// import of Remotion or its scoped subpackages. Scenes themselves
// cannot pull in Remotion either, but PUL-A003 / PUL-A006 already
// scope scene-local rendering libraries; A004's specific concern is
// the runtime <-> export-pipeline boundary captured in ADR-006.

const RULE: ImportBanRule = {
  label: 'video-rendering library imported by runtime core',
  specifiers: ['remotion', 'remotion/', '@remotion/'],
  boundaries: [],
  allowTag: 'PUL-A004-allow',
};

const SCENES_ROOT = join(SRC_ROOT, 'scenes');

function runtimeCoreFiles(): readonly string[] {
  return walkTsFiles(SRC_ROOT).filter((file) => !file.startsWith(`${SCENES_ROOT}/`));
}

function scanForA004(source: string, file: string): readonly SourceFinding[] {
  const sf = parseSource(source, file);
  const exempted = collectLineExemptions(sf, RULE.allowTag);
  return scanImportSpecifiers(sf, RULE, exempted);
}

describe('PUL-A004 — live runtime independent of export pipeline (source scan)', () => {
  describe('scanner self-tests', () => {
    it.each([
      ["import { Composition } from 'remotion';", '(static import)'],
      ["import 'remotion';", '(static import)'],
      ["import { renderMedia } from '@remotion/renderer';", '(static import)'],
      ["import { Player } from '@remotion/player';", '(static import)'],
      ["await import('remotion');", '(dynamic import)'],
      ["import type { CompositionProps } from 'remotion';", '(type-only import)'],
      ["export * from 'remotion';", '(re-export)'],
    ])('flags `%s` %s in runtime core', (source, suffix) => {
      const findings = scanForA004(source, 'src/runtime/example.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(`${RULE.label} ${suffix}`);
    });

    it('does NOT flag a similarly-named package (whole-specifier match)', () => {
      const src = "import { thing } from 'remotion-extras';";
      expect(scanForA004(src, 'src/runtime/example.ts')).toEqual([]);
    });

    it('honors `// PUL-A004-allow: <reason>` exemption on the import line', () => {
      const src =
        "import { Composition } from 'remotion'; // PUL-A004-allow: shared metadata adapter, see ADR-006";
      expect(scanForA004(src, 'src/runtime/example.ts')).toEqual([]);
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('runtime-core file set is non-empty', () => {
      expect(runtimeCoreFiles().length).toBeGreaterThan(0);
    });

    it('runtime-core file set excludes `src/scenes/`', () => {
      // Pins the scope filter (`!file.startsWith(SCENES_ROOT + '/')`)
      // so a regression that removed or inverted the filter would fail
      // here instead of silently widening the scan. Without this
      // assertion, deleting the scope filter would still leave the
      // "contains no violations" check green (no scene currently
      // imports Remotion), so the scope contract has no other guard.
      const files = runtimeCoreFiles();
      const scenePaths = files.filter((f) => f.startsWith(`${SCENES_ROOT}/`));
      expect(scenePaths).toEqual([]);
    });

    it('contains no A004 violations across the runtime-core file set', () => {
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
        'PUL-A004 forbids the runtime core from importing Remotion or any video-rendering library. Export functionality lives in a separate codebase (ADR-006). Add a `// PUL-A004-allow: <reason>` exemption on the same line if the use is intentional.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });
  });
});
