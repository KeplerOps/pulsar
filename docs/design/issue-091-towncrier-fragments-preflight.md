# Issue 91 Towncrier Fragments Preflight

Date: 2026-05-18

Issue 91 adopts Towncrier-managed changelog fragments for this repo.
This is release-workflow hardening, not runtime behavior.

## Existing Contracts

- `CHANGELOG.md` is already Keep a Changelog formatted. Preserve all
  existing release history above the insertion point; only add the
  Towncrier marker and contributor note needed for future generated
  sections.
- `changelog.d/` already exists and contains `.added.md` fragments.
  Treat that directory as the canonical fragment store; do not create a
  second news-fragment tree or rename existing fragments during this
  issue.
- `.ground-control.yaml` points plan rules at `.gc/plan-rules.md`.
  Record the fragment workflow there as the planning contract; do not
  introduce a parallel agent-policy file.
- ADR-009 owns the repo toolchain: Node 22, pnpm 9.15, single package,
  package-script vocabulary, and the local completion gate. Towncrier is
  an external release tool for changelog assembly; it is not part of the
  runtime build unless maintainers explicitly add a package script later.
- `.github/workflows/ci.yml` is the only CI workflow. This issue does
  not require a new CI job unless the companion workflow-standardization
  issue separately mandates one.
- `.pre-commit-config.yaml` already supplies generic file hygiene and
  secret checks. Fragment docs and templates must satisfy those existing
  hooks instead of adding bespoke local validation.

## Guardrails

- Keep the workflow declarative: one root `towncrier.toml`, one
  `changelog.d/_template.md.jinja`, one `changelog.d/README.md`, and
  the existing `CHANGELOG.md`.
- Configure Towncrier for a non-Python project with explicit
  `directory = "changelog.d"` and `filename = "CHANGELOG.md"`. Do not
  rely on Python package discovery or add a Python package solely for
  version detection.
- Define the six Keep a Changelog fragment types in the intended render
  order: `security`, `removed`, `deprecated`, `added`, `changed`,
  `fixed`. Use ordered `[[tool.towncrier.type]]` entries, not an
  unordered table form.
- Keep fragment names stable and conflict-free:
  `<issue-or-pr>.<type>.md` for tracked work and
  `+<unique-slug>.<type>.md` for orphan/meta fragments.
- Preserve the issue's required orphan-prefix seam (`+`). The adoption
  fragment is `+towncrier-adoption.added.md`; future no-issue entries
  should use the same prefix rather than inventing another convention.
- The template owns generated Markdown shape: `## [X.Y.Z] - DATE`,
  `### Section`, and `- bullet (#issue)`. Do not hand-format release
  sections in `CHANGELOG.md`.
- Use `.gitattributes` `CHANGELOG.md merge=union` only as defense in
  depth. It does not replace fragment workflow discipline.
- Keep release assembly manual unless a separate issue defines a release
  command or CI check. If a command is added later, the parameter seam is
  the release version/date passed to Towncrier, not hardcoded values in
  config or template.

## Cross-Cutting Layers

- Security gates: `.pre-commit-config.yaml` `detect-private-key`,
  `gitleaks`, and `check-added-large-files`; CI `dependency-audit`,
  OSV, and SonarCloud remain unchanged. The Towncrier config and
  fragments must not introduce secrets, generated large files, network
  fetch scripts, or expanded workflow permissions.
- Config shape: `towncrier.toml` is the sole Towncrier config. Do not
  duplicate it in `pyproject.toml`, `package.json`, or shell scripts.
- OS exposure: documented commands should pass `--version` and optional
  `--date` as ordinary CLI arguments. They must not require tokens,
  environment secrets, process-argv secrets, or repo-specific absolute
  paths.
- Error surface: Towncrier failures are CLI/release-tool failures. Do
  not route them through runtime error envelopes, browser diagnostics,
  scene validation findings, or app logging.
- Persistence: the only persistent workflow artifacts are fragment
  files, `CHANGELOG.md`, `.gitattributes`, and docs/config. No database,
  cache, generated lockfile, or release-state file belongs to this
  issue.

## Gotchas

- The repo already has fragments but lacks the visible contributor
  contract and Towncrier config. Do not treat existing fragments as
  changelog history or fold them into `CHANGELOG.md` during adoption.
- Existing fragments include both `### Added` headings and plain bullet
  text. The custom template must avoid producing duplicate nested
  headings if old fragments remain as-is.
- `CHANGELOG.md` currently has a hand-written `[Unreleased]` section.
  The implementation must choose a clean insertion point for the marker
  without rewriting historical entries above it.
- Markdown/Jinja whitespace is release-visible. Validate the generated
  draft before shipping so section spacing, blank lines, and issue
  suffixes match the requested shape.
- `.gitattributes` merge rules only affect future merges after the file
  exists on both sides. They will not retroactively fix current
  top-of-file conflicts.

## Anti-Patterns

- No second changelog generator, release-note script, or package.json
  changelog convention.
- No duplicate fragment type taxonomy in README, plan rules, CI, and
  config with divergent names or ordering. The config is canonical; docs
  restate it for contributors.
- No runtime source changes, scene metadata changes, validation schema
  changes, DTOs, services, repositories, exception classes, or logging
  additions.
- No automatic release publishing, tag creation, GitHub Release
  mutation, PR body rewriting, or branch-protection changes.
- No direct PR edits to generated `CHANGELOG.md` entries after the
  marker except during release assembly.

## Non-Goals

- Do not implement a changelog-required CI check in this issue unless
  the companion standardization work explicitly supplies that contract.
- Do not add Towncrier as a JavaScript dependency. If local reproducible
  invocation is required later, add it as a separate toolchain decision.
- Do not create or transition Ground Control requirements. This is a
  requirement-free issue; GitHub issue 91 is the contract.
- Do not write an ADR. Existing ADR-009 is sufficient for repo tooling;
  this issue only pins a release-note workflow convention.
