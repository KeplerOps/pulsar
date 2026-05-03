# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `docs/adrs/010-issue-tag-taxonomy.md` — defines a five-dimension,
  namespaced GitHub issue label taxonomy: type (`requirement` /
  `bug` / `enhancement` / `documentation` / `chore`),
  `series:<functional|quality|architecture|policy>`,
  `priority:<must|should|could|wont>`, `wave:<N>`, and `area:<...>`
  (12 subsystem labels). Mirrors Ground Control's `requirement_type`,
  `priority`, and `wave` fields onto labels so triage and filtering
  work in GitHub's UI without round-tripping through Ground Control.
  ADR-010 is registered in Ground Control via `gc_create_adr`. Labels
  applied to all 55 existing requirement-derived issues
  (#6, #8, #10, #12–#63).

### Changed

- `src/runtime/scene.ts` — `assertSceneModule` now enforces strict
  kebab-case format on `scene.id`: non-empty lowercase ASCII segments
  (`[a-z0-9]+`) joined by single hyphens, rejecting empty strings,
  uppercase, underscores, leading/trailing/consecutive hyphens,
  whitespace, punctuation, and non-ASCII. The same predicate is also
  applied to `defaultNext` (which holds a scene id reference) so the
  validator's notion of "scene id" is consistent across every field
  that carries one. Implements clause C1 of PUL-A007 (ADR-002 §Scene
  shape, ADR-008 #1 "stable, kebab-case ids"). Clause C2 (no id reuse
  across scenes) is already enforced by `createSceneRegistry`
  (PUL-F002). Existing scene fixtures (`'scene-a'`, `'next-scene'`,
  etc.) remain valid; the change tightens what the validator rejects,
  not what it accepts in current use.
- `tests/runtime/scene.test.ts` — adds a `scene id format (PUL-A007)`
  describe block (32 tests): 8 valid kebab-case ids, 22 invalid id
  shapes covering every rejection class, and 2 error-message format
  tests confirming the offending value is surfaced verbatim. Adds 9
  more cases under field types covering kebab-case enforcement on
  `defaultNext`.

### Added

- `src/runtime/registry.ts` — `SceneRegistry` interface and
  `createSceneRegistry` factory. Builds a single in-memory registry
  keyed by `scene.id`, delegating per-scene shape validation to
  `assertSceneModule` (PUL-F001) and rejecting duplicate ids on
  construction. The returned registry is frozen and exposes only
  id-based lookup (`get`, `has`, `ids`, `size`) — no positional or
  mutation API by design. Implements PUL-F002 (and ADR-002 §Scene
  registry / §Navigation, ADR-008 #2 "manifests over flow control"):
  scene id is the source of truth for addressability and the registry
  is the only navigation lookup path.
- `tests/runtime/registry.test.ts` — 35-test Vitest spec covering both
  clauses of PUL-F002: registry construction (happy paths over arrays,
  generators, sets), validation delegation to PUL-F001, duplicate-id
  rejection, lookup hits and misses, `has` semantics, insertion-order
  listing with caller-side mutation isolation, registry frozenness, and
  structural absence of positional / mutation methods.
- `src/runtime/scene.ts` — `SceneModule`, `Caption`, `SceneContext`,
  `SceneLifecycleFn` types plus `assertSceneModule` runtime validator
  and `isSceneModule` predicate. Implements the canonical scene-module
  contract per PUL-F001 (and ADR-002 / ADR-008): presence + shape of
  the 12 fields, `duration` strict (non-negative integer ms or `null`,
  rejecting `undefined`, `NaN`, `Infinity`, floats, negatives, strings,
  booleans). Errors identify the scene id and offending field/condition,
  laying the foundation for PUL-Q005 (validation actionability).
- `tests/runtime/scene.test.ts` — 62-test Vitest spec covering every
  clause of PUL-F001 (presence, duration rules, field types, caption
  element shape, happy paths, `isSceneModule` predicate, and error
  message format).
- `src/runtime/version.ts` exporting `PULSAR_RUNTIME_VERSION` plus a
  Vitest spec covering it. First runtime symbol the test runner exercises.
- Toolchain scaffold per ADR-009: TypeScript (strict), ESM, pnpm 9.15,
  Vite 6, Vitest 3 (`@vitest/coverage-v8` for lcov), Biome 1.9, Node 22
  LTS pinned via `.nvmrc` and `package.json` `engines` /
  `packageManager`.
- `package.json` scripts: `dev`, `build`, `preview`, `test`,
  `test:watch`, `test:coverage`, `lint`, `format`, `typecheck`.
- Source skeleton: `src/runtime/`, `src/scenes/`, `src/compositions/`,
  `tests/`, `assets/` (all empty with `.gitkeep` except for the
  workbench entry `src/main.ts` and a sentinel `tests/toolchain.test.ts`).
- `index.html` workbench entry that Vite's dev server and bundler
  consume.
- Configs: `tsconfig.json` (strict, ESNext + Bundler resolution),
  `vite.config.ts`, `vitest.config.ts`, `biome.json`.
- Pre-commit additions: `actionlint` for workflow YAML; local `biome-check`,
  `typecheck`, and `vitest` hooks gated by file regex (mirror CI).
- CI workflow rewritten as six required-status-check jobs (`pre-commit`,
  `typecheck`, `test`, `build`, `dependency-audit`, `sonarcloud`) on
  Node 22 + pnpm 9.15, with pnpm caching via `actions/setup-node`.
- SonarCloud wiring: `sonar-project.properties` and the `sonarcloud`
  block in `.ground-control.yaml`. The `sonarcloud` CI job runs with
  `-Dsonar.qualitygate.wait=true` so a RED gate fails the PR.
- `.ground-control.yaml` `workflow.*` commands populated so
  `/implement` exercises a real completion gate.

## [0.1.0] - 2026-04-30

### Added

- Initial repository scaffold from `KeplerOps/keplerops-template`.
- `.ground-control.yaml` configured with `pulsar` project identifier and
  `KeplerOps/pulsar` GitHub repo.
- `.mcp.json` wired to the local Ground Control MCP server with
  `GH_REPO=KeplerOps/pulsar`.
- `docs/adrs/` seeded with foundational ADRs covering the custom
  runtime decision, scene/composition model, timeline engine, audio
  engine, default rendering surface, export path, browser workbench,
  and agent-native authoring constraint.
- `docs/design/` seeded with architecture recommendations and a
  positioning/landscape doc that motivate the ADRs.
- `docs/requirements/` scaffolded with conventions (UID `PUL-`,
  F/Q/A/P series, RFC 2119 statements, status/priority/wave) and
  placeholders for personas, use cases, and user stories.
- `AGENTS.md` rewritten for this repo (replaces template residue).
- Personas, use cases, and user stories for Scene Author, Coding Agent,
  Presenter, and Reviewer under `docs/requirements/`.
- 55 requirements created in Ground Control: 30 functional (PUL-F001
  through PUL-F030), 10 quality (PUL-Q001 through PUL-Q010), 10
  architectural constraints (PUL-A001 through PUL-A010), 5 policy/process
  (PUL-P001 through PUL-P005). All requirements are `DRAFT` and carry
  priority + wave. Inter-requirement relations (DEPENDS_ON, REFINES,
  RELATED) and ADR traceability links (DOCUMENTS, CONSTRAINS) added.
- `.claude/skills/`: `implement`, `ship`, `stage`, `review-tests`, and
  `gh-workflow-monitor` skills imported and adapted from
  `KeplerOps/Ground-Control`. The end-of-flow Codex cross-model review
  step is removed in this repo's `/implement` and `/ship`; test-quality
  review still runs.
- `.claude/hooks/`: `git-merge-guard.py` (blocks merges/force-push),
  `log-skill-call.sh` (records skill invocations for the stop hook),
  `verify-implementation.sh` (stop hook enforcing CHANGELOG when
  `/implement` was used).
- `.claude/settings.json`: registered the new hooks (PreToolUse Bash,
  PostToolUse Skill, Stop).
