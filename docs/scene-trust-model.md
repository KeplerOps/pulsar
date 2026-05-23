# Scene module trust model

This is the canonical statement of how Pulsar treats the code inside
scene modules. The position the runtime takes is explicit: scene
modules are trusted, repo-owned application code. There is no sandbox
for scene execution today, and the existing structural gates do not
turn untrusted code into safe code.

This doc exists so a future contributor adding scene import, plugin
loading, third-party sharing, marketplace flow, or any other surface
that brings in code Pulsar did not author cannot accidentally inherit
the current trust model. The current model only covers code in this
repository.

## Scope

- **Scene authors** writing modules under `src/scenes/**`.
- **Future workflow designers** considering import, upload,
  marketplace, plugin, or third-party scene flows.
- **Security reviewers** checking what the runtime's structural
  validation, source-policy gates, and asset URL policy do and do not
  cover.

Out of scope: asset URLs and credentials (see
[`docs/asset-url-policy.md`](asset-url-policy.md)); runtime-source
constructions that would execute code outside the published bundle
(see the PUL-Q007 entry under [Related guardrails](#related-guardrails)).

## Trust position

Scene modules are trusted, repo-owned application code, loaded through
the authored bundle and registered in the scene and composition
graphs ([ADR-002](adrs/002-scene-registry-and-compositions.md),
[ADR-008](adrs/008-agent-native-authoring.md)).

A scene's lifecycle hooks — `create(ctx)`, `timeline(ctx)`, and
`cleanup(ctx)` — execute with the privileges of the application
context that invoked them. There is no capability-reduced execution
profile, no iframe or worker isolation, no permission gate, no
per-scene allowlist of browser APIs, no CSP boundary owned by the
runtime, and no code-signing or origin check on the scene module
itself.

A scene module that lands in this repository can therefore reach any
browser API the workbench (or the test runner) exposes to its host
JavaScript context. The fact that a scene "passes validation" is a
statement about its declared shape and metadata only — it is not a
statement that the code inside its lifecycle hooks is safe to run.

## What runtime validation does cover

The runtime ships two structural gates over scene declarations. Both
are metadata-only.

- `assertSceneModule(value)` in
  [`src/runtime/scene.ts`](../src/runtime/scene.ts) validates the
  `SceneModule` contract: id format and kebab-case grammar, title,
  duration, tag/asset/audio/captions array shape, caption time and
  text fields, `defaultNext` shape, `standalone` / `trailerSafe`
  booleans, presence and type of `create`, `timeline`, and `cleanup`,
  and the cross-field invariant that every audio entry is declared in
  `assets`. It does not call any lifecycle hook, fetch anything,
  inspect the function body of `create` / `timeline` / `cleanup`, or
  evaluate code.
- `validateRuntime({ scenes, compositions, assets })` in
  [`src/runtime/validation.ts`](../src/runtime/validation.ts) runs the
  same shape check over a registry plus composition manifests, plus a
  resolvable-asset check against the configured asset URL policy
  (`baseUrl`, `allowedSchemes`). It collects findings instead of
  failing fast. It is a pure orchestrator over the existing per-record
  checks — it never executes lifecycle hooks, walks `import()` graphs,
  fetches anything, touches the DOM, reads cookies or process state,
  or makes "safe to run" claims about scene code.

## What runtime validation does NOT cover

- Code safety inside `create(ctx)`, `timeline(ctx)`, or
  `cleanup(ctx)`. The lifecycle hooks are application-privileged
  function bodies that the validation pass never executes.
- Reduction of the capability set available through `ctx` (see
  [Capability surface](#capability-surface-lifecycle-and-context)).
- Containment of side effects from a misbehaving scene. The
  composition resolver isolates scene *failures* for reliability
  (see ADR-028 under [Related guardrails](#related-guardrails)), but
  that is a reliability boundary, not a security boundary — a scene
  that does not throw can still write to the DOM, schedule timers,
  hold listeners, etc.
- Trust of any third-party, user-submitted, plugin, marketplace, or
  remotely loaded scene module. The runtime has no such surface today
  (see [Third-party / user-submitted scenes — non-goal](#third-party--user-submitted-scenes--non-goal)).

The phrase "validated scene" in code review, comments, or docs means
"its declarative shape was checked." It does not mean "this scene is
safe to run."

## Capability surface (lifecycle and context)

Every active scene receives a `WorkbenchSceneCtx` (in
[`src/runtime/scene-loader.ts`](../src/runtime/scene-loader.ts))
constructed by the loader per navigation. The full set of capabilities
a scene can reach the runtime through is:

| Field | What it grants |
|-------|----------------|
| `ctx.stage` | The workbench stage DOM element (or `null` in Node tests). Scenes mount, mutate, and tear down DOM through this handle in `create(ctx)` and `cleanup(ctx)`. |
| `ctx.presenter` | The per-navigation `PresenterController` under `mode=present` (undefined under other modes). Scenes that subscribe to advance/pause commands use this seam; the controller auto-detaches on the navigation's `AbortSignal`. |
| `ctx.chrome` | Optional L2 chrome slot refs (title, brand, centerpiece, lower-third, tag, act-frame, flash). Scenes built from the L2 template library address chrome slots through this field rather than ambient `document` lookups. |
| `ctx.mode` | The effective workbench mode (`present` / `standalone` / `loop` / `paused` / `scrub` / `screenshot` / `prompter` / `rehearsal`). Read-only — scene code can branch on it but not change it. |
| `ctx.gsap` | The GSAP instance scenes build timelines with in `timeline(ctx)`. Scenes call `ctx.gsap.timeline()` rather than importing GSAP directly. |
| `ctx.audio` | The per-navigation `AudioService` (load / play / fade / stop / `stopGroup` / mute). Scoped to the navigation's `AbortSignal`; per-scene sound is unloaded on cleanup. |
| `ctx.rng` | A deterministic seeded random generator (one float per call). Scoped per occurrence — distinct activations of the same scene id get distinct streams. |
| `ctx.activation` | The per-occurrence identity `{ sceneId, entryIndex, occurrence }`. Lets a scene own its occurrence's DOM, listeners, and state without colliding with sibling occurrences. |

The lifecycle hooks themselves:

- `create(ctx)` — mount DOM, set up listeners, register audio,
  allocate per-scene resources. Runs once per occurrence at scene
  entry. Application-privileged.
- `timeline(ctx)` — return the scene's `gsap.timeline()`. Runs once
  per occurrence after `create(ctx)`. Application-privileged.
- `cleanup(ctx)` — tear down everything `create(ctx)` and
  `timeline(ctx)` allocated. Mandatory per PUL-P001 and
  [ADR-008](adrs/008-agent-native-authoring.md) #10. Runs once per
  occurrence at scene exit. Application-privileged.

The fact that this surface is the whole capability set is significant
twice: scene authors know exactly which seams the runtime owns, and
any future sandbox would have to parameterize this surface (see
[Future sandbox seam](#future-sandbox-seam)).

## Related guardrails (narrower scopes, not sandboxing)

These existing gates each cover a slice of "what the runtime can
trust." None of them is a code sandbox; do not present any of them as
one.

- **PUL-Q007 source policy** —
  [`tests/runtime/policy-q007-remote-code-execution.test.ts`](../tests/runtime/policy-q007-remote-code-execution.test.ts)
  bans `eval`, `new Function(...)`, `Function(...)`, and dynamic
  `import(specifier)` whose specifier is a remote URL or non-static
  expression in authored runtime source (`src/**/*.ts`). It catches
  attempts to execute code that is not present in the published
  bundle. It does not transform a bundled scene module into
  untrusted-safe code, and it does not restrict what bundled scene
  code can do once it runs.
  See
  [`docs/design/pul-q007-runtime-code-execution-preflight.md`](design/pul-q007-runtime-code-execution-preflight.md).
- **Asset URL and credential policy** — [`docs/asset-url-policy.md`](asset-url-policy.md)
  plus the `AssetPreloaderOptions` seams in
  [`src/runtime/asset-preloader.ts`](../src/runtime/asset-preloader.ts)
  govern resource URLs (scheme allowlist, `baseUrl`, redirects) and
  credential delivery (no global `Authorization`, per-origin custom
  `fetch`). It is a URL and credential gate, not a code sandbox. A
  scene that declares only allowed asset URLs is no more or less
  trusted as executable code than one that doesn't.
- **Scene-level failure isolation** —
  [ADR-028](adrs/028-scene-level-error-isolation.md) and the resolver
  in [`src/runtime/composition-resolver.ts`](../src/runtime/composition-resolver.ts)
  keep a thrown scene from halting the composition, attempt cleanup
  for the failing scene, and surface a redacted diagnostic. That is a
  *reliability* contract — the next scene gets to run — not a
  *security* contract. A scene that does not throw is not contained
  by it.

## Third-party / user-submitted scenes — non-goal

Pulsar does not currently accept third-party, user-submitted, plugin,
marketplace, remote-registry, or upload-flow scene modules. There is
no import resolver, no remote registry client, no plugin loader, no
upload endpoint, no code-signing flow, no CSP that the runtime owns,
no iframe/worker isolation that the runtime owns, and no per-scene
`trusted` / `sandboxed` / `origin` / `author` field on the
`SceneModule` contract.

A change that adds any of those is not in scope for any current
requirement, and the existing structural gates do not silently extend
to cover them. Until a future requirement designs isolation, the
expected position is "we run only the scene catalog this repository
ships."

## Future sandbox seam

If a future requirement accepts untrusted or third-party scene
execution, the implementation must define a separate import and
execution model and a *capability-reduced* `ctx` at the runtime
entrypoint that chooses which scene catalog is loaded. That design
must be parameterized by an execution profile and the granted
capabilities — not by ad-hoc per-scene booleans on `SceneModule` and
not by a deployment toggle that flips arbitrary scene code from
"untrusted" to "trusted."

A complete future sandbox would have to cover: module loading, DOM
authority, network and asset policy (which is already a separate
gate), audio, timelines, presenter and control surfaces, cleanup
guarantees, diagnostics redaction, and host or browser isolation
(iframe / worker / web sandbox / SES / similar). None of that exists
today, and the trust model documented above is the position the
runtime takes until such a design is accepted.

The preflight note for issue #102 —
[`docs/design/issue-102-scene-module-trust-boundary-preflight.md`](design/issue-102-scene-module-trust-boundary-preflight.md) —
records the boundary in more detail and is the binding guardrail for
this doc.

## Related

- [`docs/asset-url-policy.md`](asset-url-policy.md) — asset URL and
  credential policy (narrower scope).
- [`docs/design/issue-102-scene-module-trust-boundary-preflight.md`](design/issue-102-scene-module-trust-boundary-preflight.md)
  — the design preflight that binds this doc.
- [`docs/design/pul-q007-runtime-code-execution-preflight.md`](design/pul-q007-runtime-code-execution-preflight.md)
  — PUL-Q007 boundary.
- [`tests/runtime/policy-q007-remote-code-execution.test.ts`](../tests/runtime/policy-q007-remote-code-execution.test.ts)
  — PUL-Q007 source-policy gate.
- [ADR-001](adrs/001-custom-experience-runtime.md) — the runtime owns
  the scene/composition model rather than delegating to a slide
  framework.
- [ADR-002](adrs/002-scene-registry-and-compositions.md) — scene and
  composition contract.
- [ADR-008](adrs/008-agent-native-authoring.md) — scene contract and
  mandatory cleanup invariant.
- [ADR-028](adrs/028-scene-level-error-isolation.md) — scene
  lifecycle failure isolation (reliability, not security).
- [`src/runtime/scene.ts`](../src/runtime/scene.ts) — `SceneModule`,
  `assertSceneModule()`.
- [`src/runtime/scene-loader.ts`](../src/runtime/scene-loader.ts) —
  `WorkbenchSceneCtx` capability surface.
- [`src/runtime/validation.ts`](../src/runtime/validation.ts) —
  `validateRuntime()`.
