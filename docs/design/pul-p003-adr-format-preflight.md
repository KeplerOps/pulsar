# PUL-P003 ADR Format Preflight

Date: 2026-05-12

PUL-P003 governs the architecture-decision workflow. It does not create
a runtime subsystem. The implementation should make the existing ADR
discipline explicit: accepted architecture decisions live as MADR
markdown under `docs/adrs/` and are mirrored into Ground Control ADR
records for machine-readable traceability.

## Boundary

- `docs/adrs/README.md` remains the canonical repo-facing ADR index and
  format description. Keep the index sequential and never reuse numbers.
- `docs/adrs/000-template.md` remains the local MADR template. If the
  template changes, preserve the existing required headings: `Status`,
  `Date`, `Context`, `Decision`, and `Consequences`.
- Ground Control remains the machine-readable ADR mirror. Use
  `gc_create_adr` for new decisions and `gc_update_adr` only to repair
  metadata drift; do not invent a repo-local ADR database, JSON sidecar,
  or issue-only mirror.
- `docs/requirements/conventions.md` remains the requirement linkage
  rule: requirements that have a motivating or constraining ADR MUST
  carry a GC traceability link to that ADR via
  `gc_create_traceability_link` with `artifact_type: ADR` and link
  type `DOCUMENTS` (ADR documents context/rationale) or `CONSTRAINS`
  (ADR is a binding constraint) — per PUL-P005. Inter-requirement
  relations (`PARENT` / `REFINES` / `DEPENDS_ON` / `RELATED` via
  `gc_relation`) are a separate surface and do NOT carry ADR linkage.
  Implementation / test traceability (`IMPLEMENTS` / `TESTS`) remains
  a third surface, separate from ADR mirroring.
- ADRs are immutable once accepted. A reversal or substantial
  replacement must be a new sequential ADR with `superseded by ADR-XXX`
  status on the old record, not an in-place rewrite.

## Required Reuse

Implementation must build on these incumbents:

- ADR repo surfaces: `docs/adrs/000-template.md`,
  `docs/adrs/README.md`, and existing numbered ADR filenames.
- Ground Control surfaces: `.ground-control.yaml` project
  `pulsar`, `gc_list_adrs`, `gc_create_adr`, `gc_update_adr`,
  `gc_get_requirement`, `gc_get_relations`, and
  `gc_create_traceability_link`.
- Requirement linkage: `docs/requirements/conventions.md` ADR linkage
  rule and the GC traceability vocabulary (`gc_create_traceability_link`
  with `artifact_type: ADR` and link type `DOCUMENTS` or `CONSTRAINS`).
  `gc_relation` vocabulary (`PARENT` / `REFINES` / `DEPENDS_ON` /
  `RELATED`) is a separate surface for inter-requirement relations and
  does NOT carry ADR linkage.
- Workflow conventions: AGENTS.md Ground Control instructions,
  `.gc/plan-rules.md` for planning guardrails, and ADR-009's package /
  CI command vocabulary when a future check is added.
- Issue context: ADR-010's "GC source of truth with GitHub mirrors for
  browsability" precedent. For PUL-P003, repo markdown is the
  versioned decision artifact and GC is the machine-readable mirror.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| ADR markdown shape | Require MADR headings already named by `docs/adrs/README.md` and `000-template.md`. Do not add a second markdown dialect, frontmatter schema, or generated wrapper format. |
| ADR numbering and naming | Allocate the next numeric ADR from `docs/adrs/README.md` / existing filenames. Never reuse deleted numbers, renumber accepted ADRs, or let GC ids drive filenames. |
| Ground Control mirror | Create or update the GC ADR record from the same title, status, date, decision summary, and related requirement context as the markdown ADR. Do not maintain separate wording that can become a competing source of truth. |
| Requirement linkage | Use `gc_create_traceability_link` with `artifact_type: ADR` and link type `DOCUMENTS` or `CONSTRAINS` (per PUL-P005) when an ADR motivates or constrains a requirement. Use `IMPLEMENTS` / `TESTS` only for code and test artifacts after implementation, not for the ADR mirror itself. `gc_relation` `RELATED` is for inter-requirement cross-references only — it is not the surface for requirement-to-ADR linkage. |
| GitHub issue surface | Issue #61 is process tracking only. Do not treat the issue body, labels, or comments as the ADR store. They may point to GC and repo ADRs. |
| Auth and secrets | Ground Control tool calls use the configured connector/session. Do not pass tokens, database URLs, connector credentials, or exported ADR payloads through shell argv, committed files, CI logs, or issue comments. |
| Config and env binding | `.ground-control.yaml` already binds the project identifier and workflow command vocabulary. Do not add env vars, hidden config, browser storage, or package config to locate ADRs. |
| OS/process exposure | Prefer connector/MCP calls for GC writes. If a future script wraps ADR mirroring, pass non-secret file paths and ids as typed options; never pass credentials or large ADR bodies through argv where process listings can expose them. |
| Error envelope | Missing template fields, numbering conflicts, or GC drift should fail with bounded diagnostics: ADR number/path, title, status, and GC id when known. Do not dump connector responses, auth headers, raw requirement exports, or unrelated repo state. |
| Observability | Commit history, ADR index diffs, and GC record history are sufficient. Do not add telemetry, a logging framework, SARIF, or artifacts for this process requirement. |
| Persistence | The repo markdown and Ground Control ADR record are the only persistent stores. Do not add SQLite, YAML registries, generated JSON manifests, or duplicated ADR metadata files. |
| Security policy | ADR mirroring does not require network fetches beyond Ground Control access and does not need GitHub token permission changes. Future CI checks must run read-only against repo files unless explicitly required to verify GC drift. |

## Extensibility

The required seam is an ADR metadata normalizer that can be reused by
future checks or scripts: derive `number`, `title`, `status`, `date`,
and `path` from the markdown ADR, then let an edge adapter mirror that
metadata into Ground Control. Keep markdown parsing separate from GC
transport so a future `pnpm adr:check`, JSON report, or GC drift check
does not duplicate parsing or connector logic.

Parameterize only the obvious variables: ADR directory, template path,
project identifier, and optional related requirement UID. Those values
already exist in `docs/adrs/`, `.ground-control.yaml`, and the
requirement payload. Do not bake PUL-P003 or issue #61 into a reusable
checker.

## Gotchas And Anti-Patterns

- Do not create a second ADR schema in TypeScript, JSON, YAML, issue
  labels, or CHANGELOG entries.
- Do not convert ADRs into implementation plans. ADRs record decisions,
  context, and consequences; design preflights remain mutable guidance
  under `docs/design/`.
- Do not edit accepted ADRs to change their decision. Create a new ADR
  and mark the old one superseded.
- Do not make GC authoritative over the versioned decision text. GC is
  the machine-readable mirror; the repo ADR is the reviewed artifact.
- Do not mark PUL-P003 ACTIVE until the repo convention and GC mirror
  behavior are both represented and linked.
- Do not add CI writes to Ground Control. Automated checks, if added
  later, should detect drift; humans or an explicit release workflow
  should perform writes.
- Do not broaden workflow permissions, introduce secrets, or expose ADR
  payloads in logs to satisfy a documentation governance requirement.
- Do not conflate ADR mirroring with GitHub issue mirroring,
  requirement status transitions, or code/test traceability.

## Non-Goals

PUL-P003 does not change runtime code, scene schemas, validation
findings, asset policy, URL grammar, workbench modes, CI gates,
package scripts, GitHub label taxonomy, requirement statement style,
or CHANGELOG policy.

It does not require a public CLI, formatter, linter rule, generated ADR
site, JSON export, issue automation, GC status transition, code
traceability link, or migration of existing ADR prose beyond correcting
clear format or mirror drift.
