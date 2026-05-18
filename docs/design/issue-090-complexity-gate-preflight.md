# Issue 90 Complexity Gate Preflight

Date: 2026-05-18

Issue 90 hardens the existing Biome lint gate with one explicit
per-function cognitive-complexity rule. This is repository workflow
policy, not runtime behavior, not a new validation framework, and not a
general lint expansion.

## Existing Contracts

- ADR-009 owns the toolchain: Node 22, pnpm 9.15, TypeScript strict
  mode, Vite, Vitest, and Biome. Keep the complexity gate inside that
  Biome contract.
- `package.json` already defines `lint` as `biome check .` and
  `format` as `biome check --write .`. Preserve that vocabulary;
  `.ground-control.yaml` and maintainer workflows depend on it.
- `.ground-control.yaml` defines the completion gate as
  `pnpm lint && pnpm typecheck && pnpm test`. Do not create a parallel
  completion command for complexity.
- `.github/workflows/ci.yml` is the CI surface. It already installs
  Node 22, pnpm 9.15, dependencies with `--frozen-lockfile`, and runs
  pre-commit hooks as a blocking job. Reuse that job or the existing
  package script; do not add a second workflow.
- `.pre-commit-config.yaml` already contains one local `biome-check`
  hook. Extend or correct that hook instead of adding another Biome
  hook with overlapping scope.
- `sonar-project.properties` and the SonarCloud job remain advisory for
  this issue's contract. The hard gate must be local Biome behavior.

## Guardrails

- Add only `lint/complexity/noExcessiveCognitiveComplexity` at
  `error` level with `maxAllowedComplexity: 15`. Do not broaden Biome's
  ruleset or change unrelated formatter/import behavior.
- Keep the threshold literal in the canonical Biome config. If a future
  issue changes the threshold, the seam is Biome's
  `maxAllowedComplexity` option, not a wrapper script, env var, or
  duplicate policy file.
- Existing offenders, if any, need explicit exemptions and a single
  documented complexity backlog. Prefer the narrowest exemption that
  keeps `biome check .` blocking for all other functions.
- Exemptions must name the rule and give a concrete reason. Do not use
  broad `biome-ignore-all`, directory-wide ignores, or generic
  "legacy" comments when a narrower site or file exemption works.
- The backlog must record the offending function or file, why it is
  exempt today, and the ratchet intent: lower `maxAllowedComplexity` as
  the backlog shrinks.
- Keep the pre-commit path aligned with `pnpm lint` semantics. Local
  hooks may run on staged filenames for speed, but CI must still have
  an all-files path for the repository gate.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Toolchain config | `biome.json` is the only complexity-rule schema. Do not duplicate the threshold in `package.json`, CI YAML, shell scripts, SonarCloud config, or tests. |
| Package-script surface | `pnpm lint` remains the canonical command for a full repo check. Do not add `lint:complexity` unless a future issue needs a separate operator-facing command. |
| CI workflow | Use `.github/workflows/ci.yml`'s existing Node/pnpm/pre-commit setup and read-only permissions. Do not add network downloads, writable repo tokens, artifacts, or a new workflow controller for this gate. |
| Local workflow | Reuse `.pre-commit-config.yaml`'s local `biome-check` hook. Avoid overlapping hooks that can disagree on arguments, file scope, or write behavior. |
| Security checks | Preserve `detect-private-key`, `gitleaks`, dependency audit, OSV, and SonarCloud jobs. Complexity enforcement must not weaken or skip existing security gates. |
| Config validation | Biome's JSON schema is the config validator. Keep `check-json` passing and avoid JSONC-only comments in `biome.json`. |
| OS/process exposure | The gate needs no secrets, env vars, tokens, or repo-specific absolute paths. Commands should pass file paths only; no confidential source snippets belong in process arguments. |
| Error surface | Biome diagnostics are the error envelope. Do not wrap them in a custom reporter, runtime validation findings, GitHub annotation parser, or logging framework. |
| Runtime boundaries | No scene registry, validation schema, controller, DTO, service, repository, runtime exception, or browser code changes belong to this issue. |
| Persistence | Persistent artifacts are limited to config and docs. Do not add generated reports, caches, metrics files, baselines, or lockfile churn unless a dependency actually changes. |

## Extensibility

The extension seam is the Biome rule options block in `biome.json`.
Future changes can lower the threshold, remove exemptions, or add
file-specific overrides without changing package scripts or CI
topology.

If the repo later becomes a pnpm workspace, keep the full-repo gate at
the root and parameterize package-local checks through workspace
filters. Do not copy complexity policy into each package.

## Gotchas

- The issue text may lag the repo: this repository already has a local
  `biome-check` pre-commit hook and CI already runs pre-commit. Confirm
  current behavior before adding jobs or hooks.
- A pre-commit hook that runs Biome in write mode is not the same
  contract as `pnpm lint`. If hook arguments change, keep local failure
  behavior explicit and keep `pnpm format` as the write-mode command.
- Biome overrides can accidentally exempt future code in large modules.
  Prefer site-level ignores for isolated offenders; use file overrides
  only when site-level ignores are not practical.
- `biome check .` ignores paths through `biome.json`'s `files.ignore`
  and `.gitignore`. Do not put source modules into ignored paths to
  silence complexity.
- Do not rely on SonarCloud to catch existing-tree complexity. The
  issue's hard gate is Biome running in local and CI workflows.

## Anti-Patterns

- No ESLint, custom AST scanner, shell `grep`, TypeScript compiler
  plugin, SonarCloud-only enforcement, or generated complexity
  baseline.
- No duplicate complexity threshold in docs that can drift from
  `biome.json`; docs may state the intended value but must identify
  `biome.json` as canonical.
- No broad formatter, import-sort, style, or recommended-ruleset churn.
- No refactoring of offender functions in the same narrow gate change
  unless the implementation issue explicitly expands scope.
- No runtime validation findings, exception hierarchy, logging,
  telemetry, persistence, auth, or browser-workbench changes.

## Non-Goals

Issue 90 does not change runtime behavior, scene metadata,
composition manifests, URL navigation, asset policy, audio/timeline
orchestration, browser support, release workflow, dependency audit, OSV
scanner, or SonarCloud quality-gate policy.

It does not require a new ADR. ADR-009 already owns the repo tooling
decision; this preflight pins guardrails for one Biome rule inside that
tooling contract.

It does not create or transition Ground Control requirements. GitHub
issue 90 is the contract for this requirement-free workflow hardening.
