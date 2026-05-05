# ADR-013: URL Navigation Grammar Boundary

## Status

Accepted

## Date

2026-05-03

## Context

PUL-F007 requires the runtime to accept `scene`, `composition`,
`index`, `beat`, and `mode` URL parameters, and to parse parameter
combinations at startup and on `popstate`. PUL-F010 gives the
`composition` + `index` combination runtime meaning: `index` is a
zero-based positional locator inside the selected composition.

[ADR-002](002-scene-registry-and-compositions.md) and
[ADR-007](007-browser-workbench.md) define the public grammar, but the
implementation still needs boundary rules. Without those rules, URL
handling can turn into a second resolver: duplicated identifier
validation, positional dispatch hidden in the parser, mode checks in
scenes, or different behavior on initial load and browser back/forward.

## Decision

URL parsing is a boundary adapter from `URLSearchParams` to a plain
navigation target. It does not resolve scenes, inspect composition
manifests, run timelines, load assets, or mutate browser history.

The parser accepts only the grammar keys named by PUL-F007:
`scene`, `composition`, `index`, `beat`, and `mode`. Repeated grammar
keys are invalid because `URLSearchParams.get()` would otherwise make
ambiguous input look deterministic. Unknown query keys are ignored by
the grammar parser; they must not affect navigation state.

String identifiers reuse the shared kebab-case predicate in
`src/runtime/identifier.ts`. Do not add URL-specific regexes for
`scene`, `composition`, or `beat`. `mode` is validated against the
ADR-007 workbench mode set. `index` is a base-10, zero-based,
non-negative safe integer scoped to a composition. It is not scene
identity, a scene id alias, or a persistent bookmark independent of
the composition's current order.

`composition` is a composition identifier, not an inline manifest and
not the manifest array itself. Looking up that identifier belongs to
the workbench/bootstrap layer that owns the available composition
catalog; validating the manifest format still belongs to
`assertCompositionManifest`.

Valid target shapes are:

- `scene` with optional `beat` and optional `mode`.
- `composition` with optional `mode`.
- `composition` + `scene` with optional `beat` and optional `mode`.
- `composition` + `index` with optional `beat` and optional `mode`.
- no explicit target, with optional `mode`, for whatever default target
  the bootstrap layer owns.

Invalid combinations include:

- `index` without `composition`.
- `scene` + `index` in the same URL.
- `beat` without an explicit `scene` or `composition` + `index` target.
- malformed identifiers, malformed indexes, unknown modes, and repeated
  grammar keys.

`composition` + `scene` is an id-based locator. The composition
resolution layer must validate that the scene id exists in the selected
composition. If the same scene id appears more than once in that
composition, the locator is ambiguous and the URL must use `index`
instead.

Startup parsing and `popstate` parsing use the same path and the same
error semantics. The URL search string is the source of truth on
`popstate`; `history.state`, localStorage, cookies, and cached runtime
state must not redefine the target. A navigation change hands off to
the existing runtime orchestration layer so `cleanup(ctx)` and
composition-level cancellation semantics remain centralized.

For PUL-F012, the parser preserves the difference between absent
`mode` and an explicit `mode=present`: absent mode remains absent on
the parsed `NavigationTarget`, while the runtime core selects
effective mode `present` before dispatching mode behavior or exposing
`ctx.mode` to scenes. This keeps URL grammar validation separate from
workbench state selection and prevents the parser from becoming the
mode dispatcher.

## Consequences

### Positive

- The URL grammar remains an agent-stable contract without becoming a
  router framework.
- Identifier validation stays centralized in the existing runtime
  predicate.
- Composition existence, repeated-scene ambiguity, beat existence,
  preloading, timeline execution, and cleanup stay with the layers that
  already own those concerns.
- Initial load and browser back/forward cannot drift.

### Negative

- Some URLs that could be guessed are intentionally rejected. In
  particular, `scene` + `index` must be rewritten as one locator.
- Repeated scene ids inside a composition require `index` for precise
  URLs.

### Risks

| Risk | Mitigation |
|------|------------|
| Parser starts resolving scenes or manifests | Keep URL parsing as a pure boundary step; resolve through the registry/composition orchestration layers. |
| URL mode handling leaks into individual scenes | Dispatch modes in the runtime core per ADR-007; expose only mode hints through context where needed. |
| Parser defaults absent mode and hides URL intent | Preserve absent `mode` in `NavigationTarget`; derive the effective `present` mode in the runtime core handoff. |
| Positional navigation becomes identity | Treat `index` as a composition-scoped compatibility locator; scene id remains content identity. |
| Query values become resource paths or dynamic imports | Query values are identifiers only. Do not load modules, files, or network resources directly from URL parameter values. |
| PUL-F010 handling forks from the existing composition path | Reuse the `composition-index` locator and dispatch through the same composition registry, scene registry, resolver, preloader, cleanup, and error-surfacing layers. |

## Related ADRs

- [ADR-002](002-scene-registry-and-compositions.md) — defines the
  scene/composition model and public URL examples.
- [ADR-007](007-browser-workbench.md) — defines workbench modes and the
  browser agent contract.
- [ADR-011](011-composition-resolver-orchestration.md) — centralizes
  composition lifecycle, cancellation, and cleanup behavior.
