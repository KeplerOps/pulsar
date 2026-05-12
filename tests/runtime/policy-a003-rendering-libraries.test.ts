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

// PUL-A003 — Optional rendering libraries are scene-local.
//
// Statement: "The runtime core SHALL NOT import PixiJS, Three.js, or
// Phaser. Adoption of any of these libraries SHALL be scene-local."
//
// Enforcement: a Vitest source scan over the runtime-core file set
// (everything under `src/` EXCEPT `src/scenes/**`) that flags any
// import of `pixi.js`, `three`, or `phaser` (each with subpath
// wildcards). Scene files under `src/scenes/**/*.ts` may adopt these
// libraries locally; they are out of scope by construction.
//
// The runtime-core boundary covers `src/runtime/**`, `src/compositions/**`,
// `src/main.ts`, and `src/workbench-graph.ts`. Compositions are
// declarative manifests (see PUL-A005), so importing a rendering
// library from a composition module would also defeat the rule.

const RULE: ImportBanRule = {
  label: 'optional rendering library imported by runtime core',
  specifiers: ['pixi.js', 'pixi.js/', 'three', 'three/', 'phaser', 'phaser/'],
  boundaries: [],
  allowTag: 'PUL-A003-allow',
};

const SCENES_ROOT = join(SRC_ROOT, 'scenes');

/**
 * Runtime-core file set: every `.ts` under `src/` that is NOT under
 * `src/scenes/`. Computed at scan time so any future top-level file
 * under `src/` (e.g., a new `src/feature-flags.ts`) is automatically
 * included without editing the test.
 */
function runtimeCoreFiles(): readonly string[] {
  return walkTsFiles(SRC_ROOT).filter((file) => !file.startsWith(`${SCENES_ROOT}/`));
}

function scanForA003(source: string, file: string): readonly SourceFinding[] {
  const sf = parseSource(source, file);
  const exempted = collectLineExemptions(sf, RULE.allowTag);
  return scanImportSpecifiers(sf, RULE, exempted);
}

describe('PUL-A003 — optional rendering libraries are scene-local (source scan)', () => {
  describe('scanner self-tests', () => {
    it.each([
      ["import { Application } from 'pixi.js';"],
      ["import { Renderer } from 'pixi.js/lib/core';"],
      ["import * as THREE from 'three';"],
      ["import { Scene } from 'three/src/scenes/Scene';"],
      ["import 'phaser';"],
      ["import Phaser from 'phaser';"],
      ["import { Scene } from 'phaser/types/scene';"],
      ["await import('three');"],
      ["import type { Texture } from 'pixi.js';"],
      ["export * from 'three';"],
    ])('flags %s in runtime core', (source) => {
      const findings = scanForA003(source, 'src/runtime/example.ts');
      expect(findings).toHaveLength(1);
    });

    it('does NOT flag a similarly-named package (whole-specifier match)', () => {
      const src = "import { thing } from 'three-mesh-bvh';";
      // `three-mesh-bvh` does not match `three` (literal) or `three/`
      // (subpath). It is a separate package and should not be flagged.
      expect(scanForA003(src, 'src/runtime/example.ts')).toEqual([]);
    });

    it('honors `// PUL-A003-allow: <reason>` exemption on the import line', () => {
      const src =
        "import { Texture } from 'pixi.js'; // PUL-A003-allow: temporary backstop, see ADR-XYZ";
      expect(scanForA003(src, 'src/runtime/example.ts')).toEqual([]);
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('runtime-core file set is non-empty', () => {
      const files = runtimeCoreFiles();
      expect(files.length).toBeGreaterThan(0);
    });

    it('runtime-core file set excludes `src/scenes/`', () => {
      const files = runtimeCoreFiles();
      const scenePaths = files.filter((f) => f.startsWith(`${SCENES_ROOT}/`));
      expect(scenePaths).toEqual([]);
    });

    it('contains no A003 violations across the runtime-core file set', () => {
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
        'PUL-A003 forbids the runtime core from importing PixiJS / Three.js / Phaser. These libraries are scene-local. Move the import to `src/scenes/<scene>/...` or add a `// PUL-A003-allow: <reason>` exemption on the same line if the use is intentional.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });
  });
});
