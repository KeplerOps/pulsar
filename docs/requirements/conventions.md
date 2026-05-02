# Requirements Conventions

## UID

Format: `PUL-<series><number>`. Examples: `PUL-F001`, `PUL-Q014`.
Numbers per series, never reused.

## Series

| Series | Scope |
|--------|-------|
| F | Functional. Observable capability the runtime provides. |
| Q | Quality. Non-functional attribute (performance, determinism, accessibility, observability, security). |
| A | Architectural constraint. Binding structural rule, typically derived from an ADR. |
| P | Policy / process. Lifecycle, contributor, governance, release. |

## Statement Style

- RFC 2119: SHALL / MUST / SHOULD / MAY / SHALL NOT / MUST NOT.
- One requirement = one normative clause where reasonable.
- WHAT, not HOW. No library names, no API choices, no implementation
  tactics in the statement.
- The statement either describes observable behavior or a measurable
  quality attribute. If it does neither, it is not a requirement.

## Status Lifecycle

`DRAFT` → `ACTIVE` → `DEPRECATED`.

- `DRAFT` — written, not ratified.
- `ACTIVE` — ratified; implementation may begin.
- `DEPRECATED` — superseded or removed.

## Priority (MoSCoW)

`MUST` / `SHOULD` / `COULD` / `WONT`.

## Wave

| Wave | Scope |
|------|-------|
| 0 | Runtime core. Scene contract, registry, composition resolution, lifecycle. |
| 1 | Workbench. URL grammar, modes, presenter controls. |
| 2 | Audio + rendering. Timeline + audio integration; DOM/CSS surfaces; specialized surface adapters. |
| 3 | Export. Remotion path. |
| 4 | Polish. |

## Relations

| Type | Meaning |
|------|---------|
| `PARENT` | Decomposition. Children together satisfy the parent. |
| `REFINES` | Tightens or specializes a parent without decomposition. |
| `DEPENDS_ON` | Requires another requirement to be satisfied first. |
| `RELATED` | Cross-reference. No dependency or decomposition implied. |

## ADR Linkage

Every requirement traces to at least one ADR if any ADR motivates or
constrains it. Use GC `RELATED` links from requirement to ADR.
