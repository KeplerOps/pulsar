# ADR-014: Loading the Addressed Scene as the Runtime Navigation Target

## Status

Accepted

## Date

2026-05-04

## Context

PUL-F008 requires the runtime to load the addressed scene as the
navigation target when a scene-targeting URL parameter is present.
[ADR-002](002-scene-registry-and-compositions.md),
[ADR-007](007-browser-workbench.md), and
[ADR-013](013-url-navigation-grammar-boundary.md) already define the
URL grammar and the boundary parser (`parseNavigationSearch` in
`src/runtime/navigation.ts`, PUL-F007). The grammar parser produces a
`NavigationTarget` whose `locator` is one of:

- `kind: 'none'` — no explicit target; the bootstrap chooses a default.
- `kind: 'scene'` — single scene by id.
- `kind: 'composition'` — composition by id, no in-composition jump.
- `kind: 'composition-scene'` — composition + scene id (id-based).
- `kind: 'composition-index'` — composition + zero-based index.

ADR-013 deliberately stops at the grammar boundary. PUL-F008 picks up
where the parser leaves off: turn each scene-targeting locator into a
running scene by way of the existing composition-resolver lifecycle.

The locator value is still external input. It is well-formed (the
grammar parser already rejected malformed identifiers, repeated
keys, invalid combinations, etc.) but it can still address scenes or
compositions that are not registered, members not present in a
composition, indexes outside a composition's manifest, or empty
compositions with nothing to load.

## Decision

PUL-F008 owns the **scene navigation dispatch** layer. It does not
parse URLs, mutate `history.state`, dispatch popstate, or interpret
`mode` / `beat` (those concerns belong to PUL-F007 and future
requirements). For each `NavigationTarget` the parser hands it, the
dispatch layer:

- Resolves the locator against the runtime's `SceneRegistry`
  (PUL-F002) and `CompositionRegistry` (this PR's companion to
  PUL-F002 — see `src/runtime/composition-registry.ts`).
- Snapshots the manifest slice and the matching scene modules at
  resolve time. The snapshot is the contract the lifecycle bridge
  plays — the bridge never re-resolves by id, so a registry that
  maps the same id to a different module mid-flight cannot
  substitute scenes.
- Treats every miss (unknown scene, unknown composition, scene not
  in composition, index out of bounds, empty composition) as a
  navigation error before any scene lifecycle hook runs.
- Preserves the existing lifecycle contract. Loading a scene still
  goes through the runtime lifecycle that preloads declared assets
  (PUL-F005), calls `create(ctx)`, runs the timeline adapter, and
  calls `cleanup(ctx)` on exit (PUL-F004 + PUL-F006). The dispatch
  layer synthesizes a single-scene or sliced-composition manifest
  from the snapshot and delegates to `resolveComposition`.
- Keeps URL state authoritative. The dispatch layer never reads
  localStorage, cookies, or any cached runtime state — the
  `NavigationTarget` it consumes is the only source.

Locator handling:

- `kind: 'none'` — no scene to load; the dispatcher returns null and
  the workbench leaves the stage in its placeholder state.
- `kind: 'scene'` — single-scene navigation. Bridge plays a
  one-entry manifest containing the addressed scene.
- `kind: 'composition'` — load the named composition from the start.
  An empty composition is a navigation error.
- `kind: 'composition-scene'` — find the addressed scene id in the
  named composition. If the id appears more than once the locator is
  ambiguous and the URL must use `composition-index` instead (per
  ADR-013); the dispatcher rejects ambiguous locators with
  `scene "<id>" appears <N> times in composition "<id>" — use
  composition+index for ambiguous locators` rather than silently
  picking the first occurrence.
- `kind: 'composition-index'` — index into the composition's
  manifest, snapshot from that entry onwards.

`beat` and `mode` (when present on the parsed target) are recorded
on the navigation target but not consumed by the dispatch layer.
`mode` lands with PUL-A008 (workbench mode dispatch); `beat` lands
with the timeline-engine integration.

The startup + popstate hooks are owned by PUL-F007's
`subscribeNavigation` / `bootstrapNavigation`; the dispatch layer
subscribes to F007's `pulsar:navigate` event (or consumes
`subscribeNavigation` directly) and aborts any in-flight load
before starting a new one so the previous scene's `cleanup(ctx)`
always runs before the next preload begins.

## Consequences

### Positive

- Direct scene URLs stay aligned with the registries and the
  agent-addressable inspection contract.
- The dispatch layer reuses the boundary parser (PUL-F007), the
  composition resolver (PUL-F004), and the asset preloader
  (PUL-F005) instead of introducing parallel implementations.
- Bad input (unregistered scene, missing composition member,
  out-of-bounds index, empty composition) fails before lifecycle
  side effects, which keeps cleanup and asset-loading behavior
  predictable.
- Snapshotting the manifest slice + scene modules at resolve time
  rules out an entire class of identity bugs: the bridge runs the
  modules the dispatcher verified, not whatever modules a passed-in
  registry maps the same ids to.

### Negative

- The dispatch layer must distinguish navigation errors (resolved
  by PUL-F008) from composition resolution errors (bubbled up from
  the resolver).
- Index-based addressing requires the composition to be stable —
  reordering composition entries changes which scene `?index=N`
  resolves to. Documented as the cost of a position-as-identity
  shortcut, deliberate per ADR-013.

### Risks

| Risk | Mitigation |
|------|------------|
| Dispatch layer duplicates URL parsing | Consume PUL-F007's `parseNavigationSearch` / `subscribeNavigation`; no URL handling in this layer. |
| Scene URL bypasses the resolver lifecycle | Route scene execution through the same preload / create / timeline / cleanup path used for composition resolution. |
| Composition + scene re-resolves modules and substitutes scenes mid-flight | Snapshot the manifest slice and the matching scene modules at resolve time; the bridge plays the snapshot, never re-resolving by id against an outside registry. |
| Composition + scene plays a scene that was never in the composition | Verify membership at dispatch time; non-member combinations are navigation errors before any lifecycle hook runs. |
| Composition + index points outside the manifest | Range-check before snapshotting; out-of-bounds is a navigation error. |
| Invalid URLs silently fall back to a default scene | Dispatch layer surfaces an explicit navigation error to the workbench (stage attribute + `onError` hook) per ADR-013's "no silent fallback". |

## Related ADRs

- [ADR-002](002-scene-registry-and-compositions.md) — scene registry,
  composition manifests, and the URL navigation tuple.
- [ADR-007](007-browser-workbench.md) — browser URL grammar and
  workbench modes.
- [ADR-008](008-agent-native-authoring.md) — stable identity,
  manifests over flow control, and agent-addressable inspection.
- [ADR-011](011-composition-resolver-orchestration.md) — shared
  runtime lifecycle and injected preloader/timeline adapters.
- [ADR-013](013-url-navigation-grammar-boundary.md) — URL grammar
  boundary parser; this ADR builds on its `NavigationTarget` shape.
