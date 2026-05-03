# ADR-013: URL `scene` Parameter Selects the Runtime Navigation Target

## Status

Accepted

## Date

2026-05-03

## Context

PUL-F008 requires the runtime to load the addressed scene as the
navigation target when the `scene` URL parameter is present.

[ADR-002](002-scene-registry-and-compositions.md) and
[ADR-007](007-browser-workbench.md) already define the browser URL
grammar. The implementation still needs a narrow boundary decision so
the `scene` parameter does not grow into a second registry, a second
composition schema, or a route-specific scene loader.

The parameter is also an untrusted external input. It can be malformed,
missing from the registry, combined with other URL parameters, repeated,
or manipulated by agents and reviewers while testing.

## Decision

The `scene` URL parameter is a **navigation target selector**. It
identifies an existing scene by the same stable scene id used by the
runtime registry. It does not define a scene, import a scene, mutate a
composition, or create a separate addressing scheme.

When `scene` is present:

- Parse it once from `URLSearchParams` at the browser/runtime boundary.
- Validate its identifier shape with the shared kebab-case identifier
  rule from `src/runtime/identifier.ts`; do not add a URL-only regex.
- Resolve existence through `SceneRegistry.has` / `SceneRegistry.get`;
  do not scan arrays, import by path, or dispatch through conditionals.
- Treat malformed or unknown scene ids as navigation errors before any
  scene lifecycle hook runs.
- Preserve the existing lifecycle contract. Loading a scene still goes
  through the runtime lifecycle that preloads declared assets, calls
  `create(ctx)`, runs the timeline adapter, and calls `cleanup(ctx)` on
  exit.
- Keep URL state authoritative. Do not persist the selected scene in
  localStorage, cookies, or hidden global state.

If `composition` is also present, `scene` names the target scene
within that composition per ADR-002. The runtime then:

- Parses the composition id at the same boundary as `scene`, with the
  same kebab-case validation rule.
- Resolves composition existence through `CompositionRegistry.has` /
  `CompositionRegistry.get`. Composition is the same shape contract as
  the scene registry: id-keyed, immutable after construction, no
  positional dispatch.
- Verifies the addressed scene is a member of the named composition
  (by id) before any lifecycle hook runs. Non-member combinations are
  navigation errors.
- Snapshots the manifest slice from the addressed scene onwards plus
  the matching scene modules at resolve time, then plays the slice
  through the existing composition resolver. Per-entry `range` and
  `behavior` overrides survive slicing intact.

If no `composition` is present, `scene` selects a single-scene
navigation target. Positional `index` is a compatibility shim and
must not become the identity source when `scene` is supplied.

If no `scene` is present but `composition` is, the runtime navigates
to the composition from its first scene (ADR-002 §Navigation: "load
a composition from the start"). An empty composition is a navigation
error — there is no scene to load.

Workbench mode handling remains orthogonal. `mode` changes how the
target runs; it does not change what scene id the URL addresses.

URL parsing runs at runtime startup *and* on `popstate` (ADR-007).
The runtime aborts any in-flight scene load before re-resolving the
new URL so the previous scene's `cleanup(ctx)` always runs before
the next scene's preload begins. Snapshots returned by the resolver
(`manifestSlice`, `sceneSlice`) are deep-frozen so callers cannot
mutate the verified target between resolve and lifecycle dispatch.

## Consequences

### Positive

- Direct scene URLs stay aligned with the registry and agent-addressable
  inspection contract.
- The implementation can reuse existing validation and registry
  boundaries instead of introducing duplicate URL schemas.
- Bad URL input fails before lifecycle side effects, which keeps
  cleanup and asset-loading behavior predictable.

### Negative

- The runtime boundary must distinguish URL target selection errors
  from composition resolution errors.
- Repeated or conflicting URL parameters need explicit handling at the
  parsing boundary because `URLSearchParams.get()` silently chooses the
  first value.

### Risks

| Risk | Mitigation |
|------|------------|
| URL parsing duplicates scene validation | Reuse `isKebabIdentifier` for id shape and the registry for existence. |
| A scene URL bypasses the resolver lifecycle | Route scene execution through the same preload/create/timeline/cleanup path used for composition resolution. |
| `scene` and `index` disagree | Prefer stable scene id identity; `index` is only meaningful as a composition-position helper. |
| Scene ids become dynamic import paths | Never derive import paths, module specifiers, or DOM HTML from the raw query value. |
| Invalid URLs fall back to a default scene | Surface an explicit navigation error; do not silently load another scene. |
| `composition`+`scene` re-resolves modules and substitutes scenes mid-flight | Snapshot the manifest slice and the matching scene modules at resolve time; the bridge plays the snapshot, never re-resolving by id against an outside registry. |
| `composition`+`scene` plays a scene that was never in the composition | Verify membership at the URL boundary; non-member combinations are navigation errors before any lifecycle hook runs. |

## Related ADRs

- [ADR-002](002-scene-registry-and-compositions.md) — scene registry,
  composition manifests, and URL navigation tuple.
- [ADR-007](007-browser-workbench.md) — browser URL grammar and
  workbench modes.
- [ADR-008](008-agent-native-authoring.md) — stable identity,
  manifests over flow control, and agent-addressable inspection.
- [ADR-011](011-composition-resolver-orchestration.md) — shared
  runtime lifecycle and injected preloader/timeline adapters.
