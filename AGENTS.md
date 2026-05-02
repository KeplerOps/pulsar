# Agent Instructions

Context for coding agents (Claude Code, Codex, Copilot, etc.) working
in this repository.

## Ground Control

Pulsar uses Ground Control for requirements and ADR records. Project
identifier: `pulsar`. Configuration is in `.ground-control.yaml` at
repo root. Read it via `gc_get_repo_ground_control_context`.

| Tool | Use |
|------|-----|
| `gc_get_requirement` | Fetch by UID. |
| `gc_list_requirements` | List/filter. |
| `gc_get_relations` | Parent/child and dependency relations. |
| `gc_get_traceability` | Code/test/issue links for a requirement. |
| `gc_create_traceability_link` | Link a requirement to a source/test file or issue. |
| `gc_transition_status` | DRAFT → ACTIVE on implementation. |
| `gc_list_adrs` / `gc_create_adr` / `gc_update_adr` | ADR records. |

Requirement UIDs use the `PUL-` prefix. Series and statement
conventions live in `docs/requirements/conventions.md`.

## Conventions

- Requirements: `docs/requirements/conventions.md`.
- ADRs: MADR format under `docs/adrs/`.
- Design context: `docs/design/`.
- Writing style: terse, technical, precise. Say what is true and
  necessary; cut everything else. No marketing, no forecasting, no
  timeline estimation, no embellishment.

## Standards

- Tests for significant behavior.
- Update `CHANGELOG.md` on commits that change source. Documentation-
  and GC-only changes do not require a CHANGELOG entry.
- No AI attribution in commit messages or PR bodies.
- Never merge PRs. Maintainer merges.
- Implementation satisfies the full requirement statement before
  status transitions to ACTIVE. Create IMPLEMENTS / TESTS traceability
  links.

## Repository Structure

```
.claude/                Claude Code config
.gc/                    Ground Control plan rules
.github/                CI workflows
docs/adrs/              Architecture Decision Records
docs/design/            Design context (architecture recs, positioning)
docs/requirements/      Personas, use cases, user stories
```
