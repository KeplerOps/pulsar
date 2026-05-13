import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { REPO_ROOT, parseSource } from './source-policy';

// PUL-Q002 — Browser support structural gate.
//
// Statement: "The runtime SHALL function in the latest stable releases
// of Chromium-based browsers, Firefox, and WebKit-based browsers as of
// the project release."
//
// Real verification is delivered by Playwright executing the workbench
// in all three engines inside CI (`browser-support` job). This Vitest
// gate is defense in depth: it asserts that the gate is wired —
// Playwright config present with the three engine projects, the spec
// file present, package.json declares `@playwright/test` and the
// `test:browsers` script, and the CI workflow includes a job that runs
// `pnpm test:browsers`. Silently disabling any of those pieces would
// otherwise let the browser gate rot under a green `pnpm test`.
//
// Detection is structural across all three asserted artifacts: the
// Playwright config is parsed via the TypeScript compiler API (so
// `projects: [{ name: 'chromium', ... }]` is matched on AST shape,
// not regex over text), package.json is parsed as JSON, and the CI
// workflow is parsed as YAML — the test resolves the actual
// `browser-support` job and walks its `steps[].run` bodies. A
// whole-file regex match over the workflow text would pass on
// inert occurrences (commented-out steps, disabled jobs, prose in a
// surrounding step's `run:` body, an unrelated job that happens to
// invoke the same script); structural job/step resolution rules
// those failure modes out. Each piece of the gate is asserted
// independently so a single missing artifact surfaces a targeted
// failure message.
//
// ADR-030 defines the contract this gate enforces.

const PLAYWRIGHT_CONFIG_PATH = join(REPO_ROOT, 'playwright.config.ts');
const PLAYWRIGHT_SPEC_PATH = join(REPO_ROOT, 'tests-e2e', 'browser-support.spec.ts');
const PACKAGE_JSON_PATH = join(REPO_ROOT, 'package.json');
const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

const REQUIRED_ENGINES: readonly string[] = ['chromium', 'firefox', 'webkit'];

// --- Playwright config parsing ---------------------------------------

/**
 * Extract the literal string values of the `name` property on every
 * object literal element in a Playwright `projects: [...]` array. The
 * walker descends through `defineConfig({...})`, `export default ...`,
 * and any top-level `const config = ...` form so the test does not
 * depend on a specific authoring shape.
 *
 * Spread / computed / non-literal entries are intentionally NOT
 * resolved — if the Playwright config introduces dynamic projects the
 * gate fails loud and the author either inlines the engine names or
 * adds an explicit allow path here.
 */
function readPlaywrightProjectNames(source: ts.SourceFile): readonly string[] {
  const names: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = node.name;
      const isProjectsKey =
        (ts.isIdentifier(key) && key.text === 'projects') ||
        (ts.isStringLiteral(key) && key.text === 'projects');
      if (isProjectsKey && ts.isArrayLiteralExpression(node.initializer)) {
        for (const element of node.initializer.elements) {
          if (!ts.isObjectLiteralExpression(element)) continue;
          for (const member of element.properties) {
            if (!ts.isPropertyAssignment(member)) continue;
            const memberKey = member.name;
            const isNameKey =
              (ts.isIdentifier(memberKey) && memberKey.text === 'name') ||
              (ts.isStringLiteral(memberKey) && memberKey.text === 'name');
            if (!isNameKey) continue;
            const value = member.initializer;
            if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
              names.push(value.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

// --- Tests -----------------------------------------------------------

describe('PUL-Q002 — browser support structural gate', () => {
  describe('Playwright config', () => {
    it('playwright.config.ts exists at the repo root', () => {
      expect(existsSync(PLAYWRIGHT_CONFIG_PATH), 'playwright.config.ts missing at repo root').toBe(
        true,
      );
    });

    it.each(REQUIRED_ENGINES)('declares a Playwright project named %s', (engine) => {
      const text = readFileSync(PLAYWRIGHT_CONFIG_PATH, 'utf-8');
      const source = parseSource(text, 'playwright.config.ts');
      const names = readPlaywrightProjectNames(source).map((n) => n.toLowerCase());
      expect(
        names,
        `playwright.config.ts must declare a project named "${engine}" (found: ${JSON.stringify(names)})`,
      ).toContain(engine);
    });

    it('imports from @playwright/test (not playwright-core or ad hoc)', () => {
      const text = readFileSync(PLAYWRIGHT_CONFIG_PATH, 'utf-8');
      const source = parseSource(text, 'playwright.config.ts');
      const imports: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          imports.push(node.moduleSpecifier.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(
        imports.some((spec) => spec === '@playwright/test'),
        `playwright.config.ts must import from '@playwright/test' (found imports: ${JSON.stringify(imports)})`,
      ).toBe(true);
    });
  });

  describe('Playwright spec', () => {
    it('tests-e2e/browser-support.spec.ts exists', () => {
      expect(
        existsSync(PLAYWRIGHT_SPEC_PATH),
        'tests-e2e/browser-support.spec.ts missing — Playwright has no spec to run',
      ).toBe(true);
    });

    it('imports from @playwright/test', () => {
      const text = readFileSync(PLAYWRIGHT_SPEC_PATH, 'utf-8');
      const source = parseSource(text, 'tests-e2e/browser-support.spec.ts');
      const imports: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          imports.push(node.moduleSpecifier.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(
        imports.some((spec) => spec === '@playwright/test'),
        `tests-e2e/browser-support.spec.ts must import from '@playwright/test' (found imports: ${JSON.stringify(imports)})`,
      ).toBe(true);
    });
  });

  describe('package.json wiring', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as {
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    it('declares @playwright/test in devDependencies', () => {
      expect(
        pkg.devDependencies?.['@playwright/test'],
        'package.json must declare @playwright/test in devDependencies',
      ).toBeTruthy();
    });

    it('declares a test:browsers script that runs playwright test', () => {
      const script = pkg.scripts?.['test:browsers'];
      expect(script, 'package.json must declare a test:browsers script').toBeTruthy();
      expect(
        script,
        'test:browsers must invoke playwright test (no shell substitution, no ad hoc runner)',
      ).toMatch(/^playwright test(\s|$)/);
    });
  });

  describe('CI workflow wiring', () => {
    // The gate is owned by a single, named CI job (`browser-support`)
    // so the structural assertion below resolves that job and walks
    // its `steps[].run` bodies. A whole-file regex would pass on
    // inert text — commented-out steps, prose mentioning the gate,
    // an unrelated step that happens to invoke the same script
    // (codex pre-push review, cycle 1, class finding) — and let a
    // silently-disabled gate keep `pnpm test` green. Resolving the
    // job by name + iterating its real steps closes those evasions.
    // YAML parses an unquoted `if: false` as boolean `false`, not as
    // the string `'false'`. Widening `if` to `unknown` here keeps the
    // disabled-condition helper authoritative — without it, a
    // boolean `false` would silently fall through the `=== 'false'`
    // path and be treated as enabled (codex pre-push review, cycle
    // 2, class finding).
    interface WorkflowStep {
      readonly name?: string;
      readonly run?: string;
      readonly uses?: string;
      readonly if?: unknown;
    }
    interface WorkflowJob {
      readonly name?: string;
      readonly if?: unknown;
      readonly steps?: readonly WorkflowStep[];
    }
    interface Workflow {
      readonly jobs?: Record<string, WorkflowJob>;
    }
    const workflow = parseYaml(readFileSync(CI_WORKFLOW_PATH, 'utf-8')) as Workflow;
    const BROWSER_SUPPORT_JOB = 'browser-support';
    const job = workflow.jobs?.[BROWSER_SUPPORT_JOB];
    // A job (or step) whose `if:` evaluates to false is dead —
    // GitHub Actions short-circuits it. The disabled-condition
    // shapes the runtime evaluates to false are:
    //   - boolean `false` (YAML parses an unquoted `if: false` as
    //     boolean, not string — `if: 'false'` is the only string
    //     form),
    //   - the literal string `'false'` (case-insensitive),
    //   - a GitHub Actions expression `${{ false }}` /
    //     `${{ FALSE }}` (the only constant-false expression form
    //     the workflow runner accepts; arbitrary expressions are
    //     not safely classifiable here).
    // A check that compared `value === 'false'` only would let an
    // unquoted boolean or an expression form silently disable the
    // gate (codex pre-push review, cycle 2, class finding).
    const isDisabledCondition = (value: unknown): boolean => {
      if (value === false) return true;
      if (typeof value !== 'string') return false;
      const trimmed = value.trim();
      if (trimmed.toLowerCase() === 'false') return true;
      return /^\$\{\{\s*false\s*\}\}$/i.test(trimmed);
    };
    const jobIsActive = job !== undefined && !isDisabledCondition(job.if);
    const activeSteps: readonly WorkflowStep[] =
      jobIsActive && job?.steps ? job.steps.filter((s) => !isDisabledCondition(s.if)) : [];

    it(`declares an active \`${BROWSER_SUPPORT_JOB}\` job`, () => {
      expect(
        job,
        `.github/workflows/ci.yml must declare a \`${BROWSER_SUPPORT_JOB}\` job — the PUL-Q002 browser gate is owned by that exact job name`,
      ).toBeDefined();
      expect(
        jobIsActive,
        `the \`${BROWSER_SUPPORT_JOB}\` job must not be disabled via top-level \`if: false\``,
      ).toBe(true);
    });

    // Normalize a step's `run:` body into the shell command-line set
    // it actually executes. YAML may parse the value as a single line
    // or a multi-line `|` / `>` block; this helper splits on newline,
    // trims, drops blank lines, and drops POSIX-style `#` comment
    // lines. Heredoc payload lines (between `<<TAG` … `TAG`) are also
    // dropped: the text inside a heredoc is data fed to a command,
    // not a command line itself, so `cat <<EOF\npnpm
    // test:browsers\nEOF` does NOT satisfy a "the script runs"
    // assertion (codex pre-push review, cycle 3, class finding).
    const commandLinesOf = (run: unknown): readonly string[] => {
      if (typeof run !== 'string') return [];
      const out: string[] = [];
      let heredocTag: string | null = null;
      for (const raw of run.split('\n')) {
        const line = raw.trim();
        if (heredocTag !== null) {
          if (line === heredocTag) heredocTag = null;
          continue;
        }
        if (line === '' || line.startsWith('#')) continue;
        // Detect a `<<[-]TAG` introducer on the command line itself —
        // record the tag so the payload lines that follow are
        // skipped. The command line is still recorded (its first
        // tokens are e.g. `cat`, which fail the head-token check).
        const heredocStart = /<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/.exec(line);
        if (heredocStart) heredocTag = heredocStart[1] ?? null;
        out.push(line);
      }
      return out;
    };

    // True when `line` is an executable command-line whose head
    // tokens invoke `pnpm <scriptName>` or `pnpm run <scriptName>`.
    // The head-token rule rules out `echo pnpm test:browsers`,
    // `printf 'pnpm test:browsers'`, `cat <pnpm test:browsers` and
    // every other shell-pseudo-command form that mentions the
    // script name as data rather than executing it.
    const invokesPnpmScript = (line: string, scriptName: string): boolean => {
      const tokens = line.split(/\s+/);
      if (tokens[0] !== 'pnpm') return false;
      if (tokens[1] === scriptName) return true;
      return tokens[1] === 'run' && tokens[2] === scriptName;
    };

    // True when `line` actually invokes `playwright install …`.
    // Allows `pnpm exec playwright install …`, `pnpm dlx playwright
    // install …`, `npx playwright install …`, and bare `playwright
    // install …`. Rejects lines whose head token is a shell
    // pseudo-command (`echo`, `printf`, `cat`, `true`, `:`,
    // `false`) — those would otherwise satisfy a raw-text match
    // while never installing browsers.
    const invokesPlaywrightInstall = (line: string): boolean => {
      const tokens = line.split(/\s+/);
      const SHELL_NONEXEC: ReadonlySet<string> = new Set([
        'echo',
        'printf',
        'cat',
        'true',
        'false',
        ':',
      ]);
      if (tokens[0] === undefined || SHELL_NONEXEC.has(tokens[0])) return false;
      for (let i = 0; i < tokens.length - 1; i += 1) {
        if (tokens[i] === 'playwright' && tokens[i + 1] === 'install') return true;
      }
      return false;
    };

    it(`the \`${BROWSER_SUPPORT_JOB}\` job declares a step that runs \`pnpm test:browsers\``, () => {
      const matching = activeSteps.filter((step) =>
        commandLinesOf(step.run).some((line) => invokesPnpmScript(line, 'test:browsers')),
      );
      expect(
        matching,
        `the \`${BROWSER_SUPPORT_JOB}\` job must include an active step whose \`run:\` head-invokes \`pnpm test:browsers\` (or \`pnpm run test:browsers\`) — \`echo\`/comment/heredoc mentions of the script name do not satisfy the gate`,
      ).not.toEqual([]);
    });

    it(`the \`${BROWSER_SUPPORT_JOB}\` job declares a step that runs \`playwright install\``, () => {
      // `playwright install` (with or without `--with-deps`) is the
      // step that pulls the bundled engines onto the runner. Without
      // it, `pnpm test:browsers` fails with "Executable doesn't
      // exist" inside the test job. The head-token check rules out
      // `echo`/comment/heredoc mentions of the command (codex
      // pre-push review, cycle 3, class finding).
      const matching = activeSteps.filter((step) =>
        commandLinesOf(step.run).some(invokesPlaywrightInstall),
      );
      expect(
        matching,
        `the \`${BROWSER_SUPPORT_JOB}\` job must include an active step whose \`run:\` actually invokes \`playwright install\` (e.g. via \`pnpm exec\`, \`npx\`, or bare) so the engines are available before \`pnpm test:browsers\``,
      ).not.toEqual([]);
    });

    // Self-tests for the run-line normalizer. The category fix is
    // applied at this single shared helper rather than at the two
    // assertion sites, so a regression in either evasion shape
    // would be caught by these targeted tests before reaching the
    // workflow-content checks above.
    describe('run-line normalizer self-tests', () => {
      it('rejects echo wrappers around the script name', () => {
        expect(
          commandLinesOf('echo pnpm test:browsers').some((line) =>
            invokesPnpmScript(line, 'test:browsers'),
          ),
        ).toBe(false);
      });

      it('rejects POSIX comment lines that mention the script name', () => {
        expect(
          commandLinesOf('# pnpm test:browsers\necho ok').some((line) =>
            invokesPnpmScript(line, 'test:browsers'),
          ),
        ).toBe(false);
      });

      it('rejects heredoc payload lines that mention the command', () => {
        const run = ['cat <<EOF', 'pnpm test:browsers', 'EOF'].join('\n');
        expect(commandLinesOf(run).some((line) => invokesPnpmScript(line, 'test:browsers'))).toBe(
          false,
        );
      });

      it('accepts `pnpm test:browsers` as the head of a non-comment line', () => {
        expect(
          commandLinesOf('pnpm test:browsers').some((line) =>
            invokesPnpmScript(line, 'test:browsers'),
          ),
        ).toBe(true);
      });

      it('accepts `pnpm run test:browsers`', () => {
        expect(
          commandLinesOf('pnpm run test:browsers').some((line) =>
            invokesPnpmScript(line, 'test:browsers'),
          ),
        ).toBe(true);
      });

      it('rejects an echo wrapper around `playwright install`', () => {
        expect(commandLinesOf('echo playwright install').some(invokesPlaywrightInstall)).toBe(
          false,
        );
      });

      it('accepts `pnpm exec playwright install --with-deps chromium`', () => {
        expect(
          commandLinesOf('pnpm exec playwright install --with-deps chromium').some(
            invokesPlaywrightInstall,
          ),
        ).toBe(true);
      });

      it('accepts `npx playwright install firefox`', () => {
        expect(
          commandLinesOf('npx playwright install firefox').some(invokesPlaywrightInstall),
        ).toBe(true);
      });
    });
  });
});
