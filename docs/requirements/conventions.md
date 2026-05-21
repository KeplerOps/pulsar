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

`DRAFT` → `ACTIVE` → `DEPRECATED` (PUL-P004).

- `DRAFT` — written, not ratified.
- `ACTIVE` — ratified. A requirement MUST satisfy two conditions to be
  ACTIVE: (a) every clause of its statement is implemented in code,
  docs, configuration, or other artifacts of record (clause-by-clause
  verification, per the `/implement` workflow's Step 4.5); and (b) the
  agent making the transition is committed to reconciling Ground
  Control traceability immediately afterward. Ground Control's API
  enforces the second half operationally: `gc_create_traceability_link`
  with `link_type: IMPLEMENTS` or `TESTS` against a `DRAFT` requirement
  returns `422 requirement_not_active`, so links cannot be created
  before the transition. The canonical order is therefore: implement →
  verify clauses → `gc_transition_status` `DRAFT → ACTIVE` → reconcile
  `IMPLEMENTS` / `TESTS` links → verify the new state landed. A
  transition that ships without implementation or that skips link
  reconciliation is a PUL-P004 violation; the recovery path is to
  finish the reconciliation in a follow-up run (the GC API still
  accepts `IMPLEMENTS` / `TESTS` link writes against an ACTIVE
  requirement) or, when the requirement statement itself proved
  unsatisfiable, transition `ACTIVE → DEPRECATED` and supersede with a
  fresh DRAFT requirement. Ground Control does not support
  `ACTIVE → DRAFT`.
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

When any ADR motivates or constrains a requirement, the requirement
MUST carry a GC traceability link to that ADR (PUL-P005). Use
`gc_create_traceability_link` with `artifact_type: ADR` and link type:

- `DOCUMENTS` — the ADR documents context, rationale, or
  decision-drivers behind the requirement.
- `CONSTRAINS` — the ADR is a binding constraint the requirement
  must satisfy.

Inter-requirement relations (`PARENT` / `REFINES` / `DEPENDS_ON` /
`RELATED` — see the Relations table above) are a separate surface
(`gc_relation`) and do NOT carry ADR linkage.
