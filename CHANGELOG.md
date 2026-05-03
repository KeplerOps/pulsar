# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `src/runtime/composition-resolver.ts` — `resolveComposition` async
  function plus `ResolveCompositionOptions`, `AssetPreloader`, and
  `SceneTimelineRunner` types. Implements PUL-F004 (composition
  resolution): given a `SceneRegistry` and a `CompositionManifest`, the
  runtime (a) calls `assertCompositionManifest` defensively then
  aggregates every missing scene id into a single actionable error
  before any side effect; (b) per scene, `await`s the injected
  `preloadAssets(scene)` adapter; (c) `await`s `scene.create(ctx)`;
  (d) `await`s `runTimeline(scene, scene.timeline(ctx))`; (e) always
  `await`s `scene.cleanup(ctx)` whenever the scene was touched
  (mandatory cleanup per ADR-008 / PUL-P001 — runs after `create`
  failure when resources may have been partially acquired, and after
  timeline failure). Errors carry a `composition resolution failed:`
  prefix; original errors are preserved as `Error.cause`; when both a
  lifecycle phase AND cleanup throw, the wrapping message names both
  and the cleanup error is chained onto the phase error
  (`phaseError.cause = cleanupError`) so neither is silently swallowed.
  Scene `ctx`, `range`, and `behavior` are opaque to the resolver —
  sub-range / behavior interpretation is delegated to the timeline
  runner adapter (ADR-011).
- `tests/runtime/composition-resolver.test.ts` — 27-test Vitest spec
  covering every clause of PUL-F004: manifest-defense boundary;
  clause-(a) pre-flight existence with single, multiple, and object-
  entry missing ids plus the "no side effect before pre-flight"
  invariant; clause-(b) preload order, async-await ordering, and abort
  semantics; clause-(c) `create(ctx)` ordering plus the "still calls
  cleanup when create rejects" rule; clause-(d) timeline-value
  pass-through, async-await ordering, and the timeline-throws-cleanup-
  still-runs rule (separately for `scene.timeline(ctx)` itself
  throwing and for the runner adapter rejecting); clause-(e) cleanup
  ordering across a 3-scene happy path, cleanup-only failures,
  combined timeline+cleanup failures with cause chaining, and combined
  create+cleanup failures; sync vs async lifecycle hook handling; the
  range/behavior pass-through deferral; the codex-preflight no-dedup
  invariant for repeated scene ids; and the ADR-002 `trailer` fixture
  driven end-to-end with mixed bare-string and object entries.
- `docs/adrs/011-composition-resolver-orchestration.md` — records the
  decision that the composition resolver is a pure orchestrator that
  owns lifecycle order, mandatory-cleanup invariant, and aggregated
  failure semantics, while delegating asset preloading and timeline
  execution to injected callbacks (`AssetPreloader`,
  `SceneTimelineRunner`). Documents the deferral of `range` /
  `behavior` interpretation to the timeline runner adapter so the
  resolver does not weld itself to one timeline engine (keeping
  ADR-003's swappable `ctx.gsap` decision intact). ADR-011 is
  registered in Ground Control via `gc_create_adr`.
- `docs/adrs/README.md` index — backfills missing rows for ADR-010
  (Issue Tag Taxonomy) and ADR-011 (Composition Resolver
  Orchestration) so the table stays in sync with the files on disk.
- `src/runtime/composition.ts` — `CompositionManifest`,
  `CompositionEntry`, `CompositionEntryOverride`, `SubRange`, and
  `BehaviorOverride` types plus `assertCompositionManifest` runtime
  validator and `isCompositionManifest` predicate. Implements
  PUL-F003 (the composition manifest format): a manifest is an
  ordered array of entries; each entry is a bare kebab-case scene id
  string or an object with `id` plus optional `range` (single beat
  label or `[start, end]` label pair, per ADR-003 §Labels) and
  `behavior` (per-entry override blob). Unknown override keys are
  rejected so typos surface immediately. The validator owns the
  *format* only — registry-existence and timeline-label-existence
  checks belong to a later resolution requirement. Errors identify
  the entry index and offending field/condition, matching the
  `assertSceneModule` error grammar (PUL-Q005 spirit).
- `src/runtime/identifier.ts` — `KEBAB_IDENTIFIER_PATTERN` and
  `isKebabIdentifier`. Single source of truth for the kebab-case
  identifier rule that ADR-008 #1 makes binding on scenes,
  compositions, beats, and assets. Reused by `scene.ts` (scene id
  validation) and `composition.ts` (entry id and beat label
  validation).
- `src/runtime/object.ts` — `isPlainRecord` predicate. Accepts only
  `{ ... }` and `Object.create(null)` literals; rejects class
  instances such as `Date`, `Map`, `Set`, `RegExp`, `Error`, and
  user classes. Per ADR-008 #1 ("manifests are declarative data
  only"), runtime payload validation must reject opaque object
  instances that cannot be safely serialized, diffed, or treated as
  records of keyed fields. Reused by both `scene.ts` (scene module
  shape + caption shape) and `composition.ts` (entry shape +
  behavior override).
- `tests/runtime/composition.test.ts` — 103-test Vitest spec covering
  every PUL-F003 clause (top-level array shape, bare-string entries
  with kebab-case rule, object entries with `id` + `range` +
  `behavior` overrides, unknown-key rejection per the codex
  preflight guardrail), the AC1 mixed-entry contract using ADR-002's
  literal `fullTalk` / `shortTalk` / `trailer` examples as fixtures,
  AC2 actionable-error checks, and the `isCompositionManifest`
  predicate.

### Changed

- `src/runtime/scene.ts` — sources the kebab-case identifier
  predicate from the new `src/runtime/identifier.ts` instead of
  carrying its own `SCENE_ID_PATTERN` constant. Object-shape
  validation now uses the shared `isPlainRecord` predicate from
  `src/runtime/object.ts`, which tightens the previous loose check
  to reject class instances (`Date`, `Map`, `Set`, etc.) — same
  ADR-008 #1 declarative-data invariant the composition validator
  enforces. Existing scene fixtures (object literals) remain valid;
  the change rejects opaque object instances that should never have
  satisfied the scene contract.

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
