import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, walkSourceFiles } from './source-policy';

// Issue 90 — per-function cognitive-complexity hard gate.
//
// The acceptance contract for the gate is structural: Biome itself is
// the runtime enforcer. The plain-text shape of `biome.json` is the
// single canonical declaration that wires the rule into `pnpm lint`,
// the `.pre-commit-config.yaml` `biome-check` hook, and the CI
// pre-commit job. This test pins that shape so the gate cannot be
// accidentally relaxed or removed without flipping a test.
//
// Scope:
//
//   1. `linter.rules.complexity.noExcessiveCognitiveComplexity` is
//      enabled at level `"error"` with `maxAllowedComplexity: 15`.
//
//   2. Every `overrides` entry that touches the rule has an `include`
//      list whose every glob is in a tight allow-set — the named
//      policy-scanner files the backlog documents. A broader subtree
//      glob (`tests/**`, `tests/runtime/**`, `tests/**/*.test.ts`,
//      etc.) is rejected so the gate cannot be silently disabled for
//      unrelated test files added later.
//
//   3. Every site-level `// biome-ignore lint/complexity/`
//      `noExcessiveCognitiveComplexity:` suppression in the files the
//      backlog records carries a non-empty rationale. Empty / bare
//      suppressions are rejected so the complexity backlog at
//      `docs/design/complexity-backlog.md` is always discoverable from
//      the suppression site.

const BIOME_CONFIG_PATH = join(REPO_ROOT, 'biome.json');
const COMPLEXITY_BACKLOG_PATH = join(REPO_ROOT, 'docs/design/complexity-backlog.md');
const RULE_NAME = 'noExcessiveCognitiveComplexity';
const SUPPRESSION_PREFIX = '// biome-ignore lint/complexity/noExcessiveCognitiveComplexity:';

// The offender files catalogued in `docs/design/complexity-backlog.md`.
// The probe lint run that drove the plan reported these exact files;
// if a future commit refactors one to below threshold, the
// corresponding row in the backlog can also be removed (ratchet
// path). Production-source and test-side rows are partitioned so the
// override-allowlist assertion can name the policy-scanner cluster
// without re-deriving it from the suppression list.
const EXPECTED_RUNTIME_FILES_WITH_SUPPRESSIONS = ['src/runtime/asset-preloader.ts'] as const;

const EXPECTED_TEST_FILES_WITH_SUPPRESSIONS = [
  'tests/runtime/scene-loader.helpers.ts',
  'tests/runtime/scene-loader-present.test.ts',
  'tests/scenes/dom-css-accessibility-fixture.test.ts',
] as const;

// Tight allowlist of `overrides.include` globs that are permitted to
// disable the gate. Anything else — even a sibling pattern under
// `tests/runtime/` — fails the override-shape test below. This is the
// override side of the "narrow exemption" preflight guardrail; the
// site-side is enforced by `EXPECTED_*_WITH_SUPPRESSIONS` and the
// suppression-rationale check.
const ALLOWED_OVERRIDE_INCLUDES = new Set<string>([
  'tests/runtime/policy-*.test.ts',
  'tests/runtime/source-policy.ts',
  'tests/runtime/screenshot-determinism-source.test.ts',
]);

type BiomeConfig = {
  linter?: {
    rules?: {
      complexity?: {
        noExcessiveCognitiveComplexity?: unknown;
      };
    };
  };
  overrides?: ReadonlyArray<{
    include?: readonly string[];
    linter?: {
      rules?: {
        complexity?: {
          noExcessiveCognitiveComplexity?: unknown;
        };
      };
    };
  }>;
};

function readBiomeConfig(): BiomeConfig {
  const raw = readFileSync(BIOME_CONFIG_PATH, 'utf8');
  return JSON.parse(raw) as BiomeConfig;
}

describe('issue 90 — Biome cognitive-complexity hard gate', () => {
  it('declares the rule at error with maxAllowedComplexity 15', () => {
    const config = readBiomeConfig();
    const rule = config.linter?.rules?.complexity?.noExcessiveCognitiveComplexity;
    expect(rule, `biome.json is missing linter.rules.complexity.${RULE_NAME}`).toBeDefined();
    expect(rule, `biome.json's ${RULE_NAME} must be an object form, not a level string`).toEqual(
      expect.objectContaining({
        level: 'error',
        options: expect.objectContaining({ maxAllowedComplexity: 15 }),
      }),
    );
  });

  it('only relaxes the rule via overrides whose includes match the documented allowlist', () => {
    const config = readBiomeConfig();
    const overrides = config.overrides ?? [];
    const relaxingOverrides = overrides.filter(
      (entry) => entry.linter?.rules?.complexity?.noExcessiveCognitiveComplexity !== undefined,
    );

    expect(
      relaxingOverrides.length,
      'expected at least one overrides entry for the policy-scanner cluster',
    ).toBeGreaterThan(0);

    for (const entry of relaxingOverrides) {
      const includes = entry.include ?? [];
      expect(
        includes.length,
        `overrides entry that relaxes ${RULE_NAME} must declare an explicit include list`,
      ).toBeGreaterThan(0);
      for (const pattern of includes) {
        expect(
          ALLOWED_OVERRIDE_INCLUDES.has(pattern),
          `overrides include "${pattern}" must be in the documented allowlist (${[...ALLOWED_OVERRIDE_INCLUDES].join(', ')}); broader subtree globs would silently disable the gate for unrelated tests`,
        ).toBe(true);
      }
    }
  });

  it('keeps every backlog-listed suppression site-scoped with a non-empty rationale', () => {
    const allBackloggedFiles = [
      ...EXPECTED_RUNTIME_FILES_WITH_SUPPRESSIONS,
      ...EXPECTED_TEST_FILES_WITH_SUPPRESSIONS,
    ];
    for (const relPath of allBackloggedFiles) {
      const filePath = join(REPO_ROOT, relPath);
      const text = readFileSync(filePath, 'utf8');
      const lines = text.split('\n');
      const suppressionLines = lines
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => line.includes(SUPPRESSION_PREFIX));

      expect(
        suppressionLines.length,
        `${relPath} should carry at least one ${RULE_NAME} suppression — the probe run identified offenders here`,
      ).toBeGreaterThan(0);

      for (const { line, idx } of suppressionLines) {
        const afterColon = line.split(SUPPRESSION_PREFIX, 2)[1] ?? '';
        const rationale = afterColon.trim();
        expect(
          rationale.length,
          `${relPath}:${idx + 1} — ${RULE_NAME} suppression must carry a non-empty rationale after the colon`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('rejects bare suppressions anywhere under src/ or tests/, not just the backlog list', () => {
    // Exhaustive guard. The previous test pins the backlog files; this
    // test scans every TypeScript file under `src/` and `tests/` so a
    // future commit cannot land a `// biome-ignore lint/complexity/`
    // `noExcessiveCognitiveComplexity:` without a rationale by adding
    // the suppression to a file that is not in the hardcoded
    // EXPECTED_*_WITH_SUPPRESSIONS list.
    const scanRoots = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'tests')];
    const bareSuppressions: string[] = [];
    for (const root of scanRoots) {
      for (const filePath of walkSourceFiles(root)) {
        const text = readFileSync(filePath, 'utf8');
        const lines = text.split('\n');
        lines.forEach((line, idx) => {
          if (!line.includes(SUPPRESSION_PREFIX)) return;
          const afterColon = line.split(SUPPRESSION_PREFIX, 2)[1] ?? '';
          if (afterColon.trim().length === 0) {
            bareSuppressions.push(`${relative(REPO_ROOT, filePath)}:${idx + 1}`);
          }
        });
      }
    }
    expect(
      bareSuppressions,
      'bare `// biome-ignore lint/complexity/noExcessiveCognitiveComplexity:` suppressions must carry a rationale — every site below is missing one',
    ).toEqual([]);
  });

  it('publishes the complexity backlog doc that lists every site-suppression target', () => {
    const text = readFileSync(COMPLEXITY_BACKLOG_PATH, 'utf8');
    expect(text).toContain('maxAllowedComplexity');
    expect(text).toContain('ratchet');
    const allBackloggedFiles = [
      ...EXPECTED_RUNTIME_FILES_WITH_SUPPRESSIONS,
      ...EXPECTED_TEST_FILES_WITH_SUPPRESSIONS,
    ];
    for (const relPath of allBackloggedFiles) {
      expect(text, `backlog must list ${relPath}`).toContain(relPath);
    }
  });
});
