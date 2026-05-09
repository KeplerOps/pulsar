# ADR-022: Workbench Mode `prompter` — Loader-Side Lifecycle Bypass with Captions Aggregation Seam

## Status

Accepted

## Date

2026-05-09

## Context

ADR-007 names seven workbench modes: `present`, `standalone`, `loop`,
`paused`, `scrub`, `screenshot`, `prompter`. ADR-013 fixes the URL
grammar boundary that carries `mode=` to the runtime. ADR-014 fixes
the scene navigation dispatch layer. ADR-015 fixes URL beat
positioning. ADR-016 (`mode=present`), ADR-017 (`mode=standalone`),
ADR-018 (`mode=loop`), ADR-019 (`mode=paused`), ADR-020
(`mode=scrub`), and ADR-021 (`mode=screenshot`) establish the
precedent for landing a mode's contract layer plus seam tests while
the dependent rendering surfaces are still pending: PUL-F013
through PUL-F018 all stayed DRAFT after their respective contract PRs
because chrome / audio / GSAP runner / presenter input / scrub-
controls / capture surfaces are not yet implemented.

PUL-F019 specifies `mode=prompter`:

> In `mode=prompter`, the runtime SHALL render a script/caption
> view derived from the captions metadata of the addressed scene or
> composition. Visual rendering of the scene SHALL be suppressed.

The clauses decompose this way:

- "Render a script/caption view derived from the captions metadata of
  the addressed scene or composition" — the runtime aggregates
  `scene.captions` (PUL-F001 / ADR-002 — `{ at: ms, text }[]`) from
  the addressed target into a script structure and hands it to a
  rendering surface. For composition targets, captions span every
  scene in the resolved slice (PUL-F008 / ADR-014's snapshot from the
  addressed scene onward). The output is a script/caption view;
  rendering it visibly is the job of a workbench chrome surface that
  consumes the aggregated script.
- "Visual rendering of the scene SHALL be suppressed" — the runtime
  does not run the scene's visual rendering path under prompter. This
  is structurally distinct from the other six modes (`present` plays
  normally; `standalone` / `loop` / `paused` / `scrub` /
  `screenshot` alter how the scene runs but still mount it). Per the
  codex architecture preflight for PUL-F019: "the implementation
  should avoid mounting/instantiating the visual scene renderer,
  canvas/stage, media playback, animation loop, or asset pipeline for
  prompter mode. CSS-hiding an already-rendered scene is not
  sufficient." Suppression must be structural, not cosmetic.

The other five workbench-mode ADRs (ADR-017 through ADR-021) all use
the same pattern: pass an opaque hint to the timeline-runner adapter,
let the runner alter behavior, leave the lifecycle (preload → create
→ timeline → cleanup) running normally. That pattern does not fit
`mode=prompter`: the hint approach would still run the asset
preloader, still mount the scene via `create(ctx)`, still execute the
timeline's setup phase. PUL-F019's structural-suppression clause
forbids those side effects. The cleanest defense is to bypass the
resolver lifecycle entirely under `mode=prompter` so the captions
data path runs *instead of* the lifecycle, not alongside it.

The question this ADR answers is: where does the loader → captions
seam live, and on what contract does PUL-F019 transition to ACTIVE?

## Decision

### Scope: prompter is a captions-only view

`mode=prompter` is a script/caption view derived from the addressed
target's captions metadata. The scope is intentionally narrow: this
mode does NOT include caption editing, review comments, teleprompter
scrolling, timing playback, audio narration, visual overlays, or
persistence. PUL-F019's statement names exactly the captions view;
broader behaviors (highlight-on-scrub, timed playback alongside
captions, etc.) are out of scope and would warrant their own
requirements.

The URL contract for "what to capture in the captions view" reuses
the PUL-F008 / ADR-014 locator shapes (PUL-F007 / ADR-013 grammar):

- `?scene=x&mode=prompter` — captions for scene `x` only.
- `?composition=c&mode=prompter` — captions for every scene in
  composition `c`, in manifest order.
- `?composition=c&scene=x&mode=prompter` — captions starting at
  scene `x` within composition `c`, then continuing through the
  rest of the composition (the dispatcher's slice-from-addressed-
  onward behavior).
- `?composition=c&index=N&mode=prompter` — captions starting at
  index `N` within composition `c`, then continuing.

The `beat=` URL parameter is grammar-valid for any scene-like
locator (ADR-013) and is preserved in the parsed `NavigationTarget`
under `mode=prompter`, but the loader does not consume it on this
dispatch path. A reviewer who wants to focus on a specific beat's
caption presents a different requirement (caption-specific
positioning) that is out of scope for PUL-F019; the parser-level
preservation costs nothing and leaves the door open for a future
extension.

### Plumbing: loader-side lifecycle bypass

`mode=prompter` is dispatched at the loader
(`src/runtime/scene-loader.ts`) on a separate code path from the
other six lifecycle-running modes. When `effectiveMode(target) ===
'prompter'`:

1. The loader still validates the navigation target via the existing
   `resolveSceneNavigation` (PUL-F008 / ADR-014). Composition
   validation — unregistered composition, unknown member scene,
   ambiguous `composition+scene` locator, out-of-range index, empty
   composition — STILL surfaces as a navigation error. There is no
   silent fallback to direct scene lookup, no exception path that
   degrades quietly. ADR-013's "no silent fallback" invariant holds
   under prompter the same way it holds under every other mode.

2. The loader still writes `data-pulsar-scene-target` and (when the
   locator addressed a composition) `data-pulsar-composition-target`
   to the stage. The attrs communicate "what was addressed," not
   "what's running" — same invariant as `mode=standalone` (ADR-017),
   `mode=loop` (ADR-018), `mode=paused` (ADR-019), `mode=scrub`
   (ADR-020), and `mode=screenshot` (ADR-021). External observers
   (agents, future tooling) reading the stage see the URL-addressed
   target even when the lifecycle does not run.

3. The loader does NOT call `applySingleSceneSlice`. The five
   single-scene-execution modes (standalone, loop, paused, scrub,
   screenshot) truncate the slice to the addressed head because each
   of those modes' lifecycle promise is "no following entries run."
   Under prompter the lifecycle does not run AT ALL (visual
   rendering is structurally suppressed), so the truncation defense
   from those modes does not apply — the captions view's contract
   is "captions of the addressed scene OR composition," and under a
   composition target the entire dispatched slice's captions are the
   addressed material. Truncating would silently drop tail-scene
   captions from the prompter view, breaking PUL-F019's clause 1.

4. The loader builds a `PrompterScript` from the validated
   navigation target via `buildPrompterScript` (a pure function in
   `src/runtime/prompter.ts`). The script structure is:
   ```
   interface PrompterScriptEntry {
     readonly sceneId: string;
     readonly title: string;
     readonly captions: readonly Caption[];
   }
   interface PrompterScript {
     readonly composition?: { readonly id: string };
     readonly entries: readonly PrompterScriptEntry[];
   }
   ```
   Captions come from the registered scene module's `captions`
   metadata (the canonical PUL-F001 / ADR-002 shape). Object-form
   composition entries' `range` / `behavior` overrides are
   runner-side concerns (ADR-002 / ADR-011) and do NOT alter caption
   content — prompter shows the scene's full captions verbatim
   regardless of which sub-range the runner would have played. The
   script is deep-frozen so a misbehaving renderer cannot corrupt
   the next navigation's view.

5. The loader hands the script to a new optional `renderPrompter`
   adapter on `SceneLoaderOptions` (parallel to `runTimeline` /
   `createPreloader` / `buildCtx`). The adapter receives the script
   and the per-navigation `AbortSignal`. The adapter's return value
   drives the cleanup lifecycle:
   - `void` / `undefined` — renderer mounted nothing persistent; the
     dispatch is complete and the loader does not park.
   - A `PrompterDispose` callback (`() => void | Promise<void>`) —
     renderer mounted persistent state. The loader holds the
     callback, parks until `signal.aborted` fires, then invokes
     the callback to tear the state down.
   - `Promise<void>` / `Promise<PrompterDispose>` — async variants
     of the above.

   The dispose-return contract makes cleanup ENFORCEABLE rather than
   documentation-only: a renderer that mounts DOM and returns a
   `PrompterDispose` callback delegates abort sequencing to the
   loader; the loader, not the renderer, is responsible for "wait
   for abort, then call dispose." A renderer that returns void
   asserts "nothing to clean up." The compiler does not enforce
   "void return implies no DOM mounted" — that's still a
   responsibility the renderer holds — but the dispose-return
   pattern is the structurally-correct shape for renderers that DO
   mount state, with the loader owning the lifecycle. Cleanup-
   before-handoff and latest-event supersession apply uniformly to
   prompter dispatch the same way they apply to lifecycle dispatch.

6. The loader does NOT call `createPreloader`. The asset pipeline
   does not run under prompter. PUL-F019's structural-suppression
   clause names "asset pipeline" specifically; bypassing the
   preloader is the strongest possible defense.

7. The loader does NOT call `buildCtx`. There is no per-navigation
   ctx to construct because there is no scene to mount. PUL-F012's
   "scenes receive `ctx.mode`" contract does not apply under prompter
   because no scene's lifecycle hook fires; `ctx.mode === 'prompter'`
   is a moot seam.

8. The loader does NOT call `runTimeline`. There is no timeline to
   execute. This is the structural defense for the "no animation"
   half of "visual rendering SHALL be suppressed" — independent of
   how the future GSAP runner (ADR-003) is wired, prompter cannot
   run a timeline because the runner is not invoked at all.

9. The loader does NOT call any scene's `create` / `timeline` /
   `cleanup`. Visual scene mounting is structurally suppressed by
   not running the resolver lifecycle that would mount it. This is
   the strongest interpretation of PUL-F019's clause 2 — even a
   well-meaning scene that reads `ctx.mode === 'prompter'` and
   tries to skip its visual rendering cannot leak side effects
   (e.g. eager DOM allocations in `create(ctx)` ahead of an early
   return) because the hook never fires. CSS-hiding was explicitly
   ruled out by the codex preflight; not-running is the inverse
   ceiling.

A workbench bootstrap that has not yet wired a captions UI omits
the `renderPrompter` field. Under that configuration the loader
still pays the structural-suppression cost (lifecycle is bypassed)
but resolves immediately — the captions data path simply has no
consumer. A real workbench bootstrap supplies a concrete renderer
when the UI surface lands. The optional adapter mirrors the
approach the placeholder timeline runner uses today: a no-op stand-
in that satisfies the contract without delivering the visible
behavior, with the contract surface ready for a future surface PR
to plug in.

PUL-F019 stays DRAFT after this PR lands, mirroring the
ADR-016 / PUL-F013, ADR-017 / PUL-F014, ADR-018 / PUL-F015,
ADR-019 / PUL-F016, ADR-020 / PUL-F017, and ADR-021 / PUL-F018
precedent. This PR ships:

- The loader → captions seam: `effectiveMode === 'prompter'`
  bypasses the lifecycle and hands a `PrompterScript` to
  `renderPrompter`.
- The captions aggregation: `buildPrompterScript` is a pure
  function over `SceneNavigationTarget`.
- The `PrompterRenderer` adapter type and its placeholder
  implementation in `src/main.ts`.
- Tests pinning the dispatch seam, the lifecycle suppression, the
  full-slice (non-truncated) captions aggregation, the "no
  prompter for any other mode" invariant, error surfacing, and the
  abort/cleanup-before-handoff invariants.

What it does NOT yet ship is the visible captions UI surface. The
placeholder `renderPrompter` produces no visible output. PUL-F019
transitions DRAFT → ACTIVE when a captions/script UI surface lands
and:

1. Renders the `PrompterScript` visibly — the addressed scene's
   captions (or the composition slice's aggregated captions) are
   shown to the user.
2. End-to-end tests confirm the captions are rendered and that the
   visual scene rendering is, in fact, suppressed (no canvas /
   stage / media / animation side effects on a navigation under
   `mode=prompter`).
3. Ground Control traceability has the captions UI module linked
   as `IMPLEMENTS` PUL-F019 alongside the loader's existing
   `IMPLEMENTS` link.

Until that surface lands, the issue ↔ requirement link stays as
`DOCUMENTS` and PUL-F019 stays DRAFT — matching how ADR-016 /
PUL-F013 through ADR-021 / PUL-F018 record "land the contract layer;
keep the requirement DRAFT until the dependent surfaces land."

### Boundary

The captions seam lives at the loader because:

- The loader already derives `effectiveMode(target)` for `ctx.mode`
  (ADR-007 / PUL-F012). Reusing the same derivation for the
  prompter bypass keeps mode-aware dispatch in one place.
- The composition resolver MUST stay mode-opaque (ADR-011 — pure
  orchestrator, no adapter knowledge). Pushing the prompter bypass
  into the resolver would force the resolver to inspect a runtime
  detail that has no place in the orchestrator.
- The bridge (`loadSceneNavigationTarget`) is also mode-opaque by
  design — it forwards head-only options to the resolver and
  truncates slices for the runner-input modes. Adding a prompter
  branch there would entangle the bridge with a different runtime
  contract (no runner at all).
- `resolveSceneNavigation` MUST run validation regardless of mode:
  unregistered compositions, unknown member scenes, out-of-range
  indexes, and empty compositions still surface as navigation
  errors under `mode=prompter`. No silent fallback to direct scene
  lookup.

### Stage attribute behavior

`data-pulsar-scene-target` (head scene id) AND
`data-pulsar-composition-target` (composition id) are both set on
the stage when the URL named a composition under `mode=prompter`.
The attrs communicate "what was addressed," not "what's running" —
parity with all five other non-`present` modes. No
`data-pulsar-mode-*` suppression attribute is preemptively written
under `prompter`; future captions-UI surface is free to use that
namespace if it actually needs a stage-level signal.

### Composition slice behavior

NOT truncated. Under composition addressing, the captions view
consumes the FULL slice the dispatcher snapshotted (PUL-F008 /
ADR-014). PUL-F019 explicitly says "the addressed scene OR
composition" — under a composition target, the captions belong to
every scene in the slice, not just the head. This is the
structural difference from `mode=standalone`, `mode=loop`,
`mode=paused`, `mode=scrub`, and `mode=screenshot`, all of which
truncate to head because their lifecycle promise is "no following
entries run." Prompter has no analogous lifecycle promise to
defend with truncation; applying truncation here would silently
drop tail-scene captions from the view.

### Beat semantics

`beat=` under `mode=prompter` is preserved on the parsed
`NavigationTarget` but not consumed by the loader's prompter
dispatch path. PUL-F019 does not name beats; the captions view's
job is to show captions, not to position playback. A future
caption-position requirement could use the preserved value if it
landed; today the loader simply does not read it.

`beat=` grammar validation still runs (`validateBeatGrammar`
defends against hand-built `NavigationTarget`s with malformed
beats). A grammar-invalid beat under `mode=prompter` surfaces as a
navigation error before the prompter dispatch runs, matching the
defense-in-depth pattern the loader applies for every other mode.

## Consequences

### Positive

- Visual rendering suppression is STRUCTURAL: the runtime does not
  invoke the asset preloader, scene `create` / `timeline` /
  `cleanup`, or the timeline runner under `mode=prompter`. CSS-
  hiding (which the codex preflight explicitly ruled out) is not
  needed because no visual rendering is even started.
- Captions are aggregated from the canonical PUL-F001 / ADR-002
  metadata. There is no parallel "prompter captions" schema, no
  duplicate validation, no opportunity for the script view to
  diverge from the source metadata.
- The captions seam is testable today as a pure function. The
  loader's prompter dispatch is testable today via the renderer
  adapter. Both contracts can be pinned without depending on a
  real captions UI surface.
- The contract surface (`renderPrompter` adapter on
  `SceneLoaderOptions`) is parallel to `runTimeline` /
  `createPreloader`. A future captions UI plugs in the same way the
  future GSAP runner will plug into `runTimeline`.
- Following ADR-016 through ADR-021's precedent keeps the DRAFT →
  ACTIVE bar consistent across mode requirements: ACTIVE means the
  named user-visible behavior is actively delivered end to end, not
  just structurally scaffolded.
- Composition addressing under prompter is straightforward: the
  full slice's captions reach the renderer in manifest order. No
  per-mode special-casing of the slice transform.

### Negative

- PUL-F019 stays DRAFT until a real captions UI surface lands. A
  reviewer reading the requirement in isolation may expect ACTIVE
  on first delivery; the DRAFT-with-contract-and-seams state is
  intentional and matches the PUL-F011 / PUL-F013 / PUL-F014 /
  PUL-F015 / PUL-F016 / PUL-F017 / PUL-F018 precedent.
- The dispatch path under `mode=prompter` diverges from the other
  six modes. The shape transform shared by F014 / F015 / F016 /
  F017 / F018 (`applySingleSceneSlice`) does not apply, and the
  runner-input plumbing (`headBeat` / `headRepeat` / `headHold` /
  `headCueGate` / `headScreenshot`) is not used. This is
  intentional — prompter is structurally a different mode — but it
  does mean the loader has two dispatch shapes instead of one.
- Adding `renderPrompter` widens the `SceneLoaderOptions` surface.
  Every direct caller (production bootstrap, test harnesses) sees
  the new field. Optional makes the impact small: a caller that
  doesn't supply it gets graceful degradation.
- `ctx.mode === 'prompter'` is exposed by the existing PUL-F012
  seam but never reaches a scene under prompter (the lifecycle
  doesn't run). A future caption-aware behavior that needs scene
  cooperation would have to surface through a different seam —
  e.g., a scene-side caption augmentation hook the captions UI
  reads, or a successor ADR that revisits the bypass decision.

### Risks

| Risk | Mitigation |
|------|-----------|
| A future runner / preloader regression accidentally mounts scenes under `mode=prompter` | The loader's prompter branch never invokes `createPreloader`, `buildCtx`, or `runTimeline`. Tests pin every one of those zero-invocation invariants explicitly. The codex preflight names asset pipeline + scene renderer + canvas/stage + media playback + animation loop — every one of those side effects is structurally unreachable under prompter because the lifecycle is not entered. |
| A reviewer (or future agent) expects the prompter view to play scene audio / show timeline scrubbing alongside captions | PUL-F019 names captions only; the visible captions UI's scope is bounded. A future requirement that combines captions with playback would be a new requirement, not an extension of PUL-F019. |
| The placeholder `renderPrompter` parks until abort, so a `mode=prompter` URL renders no captions until the UI lands | This is intentional — same shape as the placeholder timeline runner that has shipped under `mode=present` since the runtime first booted. The DRAFT → ACTIVE bar names the captions UI surface as the gating delivery; reviewers who paste a `mode=prompter` URL today see the structural suppression (no scene mounts) but no captions UI yet, which matches the DRAFT state. |
| The captions aggregation re-implements `scene.captions` shape and drifts from PUL-F001 | `buildPrompterScript` reads `scene.captions` directly via the SceneModule type. A change to the shape (e.g. PUL-F001 adding a third caption field) compiles through to the prompter script automatically; tests catch a regression that filtered out a new field. No parallel schema. |
| Slice truncation copy-pasted from F014–F018 silently drops tail-scene captions | The seam test "aggregates captions across the FULL composition slice (NOT truncated to head)" pins this directly with a three-scene composition. A regression that applied `applySingleSceneSlice` (or any equivalent head-only truncation) under prompter would surface only the head's captions and fail this test. |
| A renderer that ignores the abort signal hangs the navigation queue | The loader awaits the renderer's returned promise with the same abort-and-await pattern the runner uses. The "aborts a long-running `renderPrompter` when superseded" seam test pins the abort path. A renderer that ignores the signal would surface as a hung second navigation, caught by vitest's per-test timeout. |
| A non-parser caller forges a `NavigationTarget` with `mode: 'prompter'` mid-flight | The defense-in-depth check `validateModeGrammar` already rejects unknown modes at the loader boundary; `'prompter'` is in the `NAVIGATION_MODES` allowlist, and `effectiveMode` is the only consumer of the field. |
| A future captions UI relies on `ctx.mode === 'prompter'` and breaks when no `ctx` is built | ADR-022 explicitly records that `buildCtx` is NOT called under prompter; the `ctx.mode` seam is moot in this mode. A captions UI surface should subscribe to its own seam (renderer adapter + script payload) rather than reaching for a `ctx.mode` that no scene observes. |

## Current state (2026-05-09)

This PR delivers the contract boundary and seam-pinning layer:

- `src/runtime/prompter.ts` — new module exporting
  `PrompterScriptEntry`, `PrompterScript`, `PrompterRenderer`, and
  `buildPrompterScript`. Pure function over a
  `SceneNavigationTarget`; produces a deep-frozen script.
- `src/runtime/scene-loader.ts` — `SceneLoaderOptions` gains
  optional `renderPrompter?: PrompterRenderer`. `runTarget`
  branches on `effectiveMode === 'prompter'`: validates the target,
  sets stage attrs, builds the script, hands it to the renderer
  with the per-navigation abort signal. Lifecycle adapters
  (`createPreloader`, `buildCtx`, `runTimeline`) are NOT called.
- `src/main.ts` — placeholder `renderPrompter` adapter that parks
  until abort, mirroring the placeholder timeline runner pattern.
  Until the captions UI lands, it produces no visible output;
  structural visual-rendering suppression is delivered by the
  loader's lifecycle bypass, not by the renderer.
- `tests/runtime/prompter.test.ts` — pure-function tests for
  `buildPrompterScript`: single scene, full composition slice,
  composition+scene non-head, object-form entry with overrides,
  empty captions, deep-frozen output, no source mutation.
- `tests/runtime/scene-loader.test.ts` — new
  `'prompter-mode caption-view dispatch (PUL-F019)'` describe
  block: lifecycle suppression (no preloader, no buildCtx, no
  runner, no scene hooks), full-slice captions aggregation, single-
  scene + composition variants, no prompter for non-prompter
  modes, stage attrs preserved, no `data-pulsar-mode-*`
  preemptive attribute, composition validation errors still
  surface, graceful degradation when `renderPrompter` is omitted,
  renderer abort, cleanup-before-handoff across the
  present→prompter boundary, and `kind: 'none'` no-renderer
  invariant.
- This ADR.

PUL-F019 remains DRAFT. Issue #28 links to PUL-F019 via
`DOCUMENTS`. This PR is **not** an implementation of PUL-F019's
"render a script/caption view" clause — the placeholder renderer
produces no visible output. The ACTIVE transition is gated on a
captions/script UI surface that consumes the `PrompterScript`,
renders it visibly, and is covered by end-to-end tests. Treating
this PR as satisfying PUL-F019 would be a traceability/status
mismatch.

## Related ADRs

- [ADR-002](002-scene-registry-and-compositions.md) — defines the
  `Caption = { at: ms, text }` shape this ADR aggregates.
- [ADR-007](007-browser-workbench.md) — defines the seven workbench
  modes; specifically references `mode=prompter` as the
  script/caption review mode.
- [ADR-008](008-agent-native-authoring.md) — manifests-over-flow-
  control underpins the no-mode-suppression-in-resolver constraint;
  the captions seam is data, not flow.
- [ADR-011](011-composition-resolver-orchestration.md) — the
  composition resolver (`resolveComposition` in
  `src/runtime/composition-resolver.ts`) is opaque to mode and
  orchestrates the preload → create → timeline → cleanup
  lifecycle. The prompter dispatch reaches the navigation-level
  resolver (`resolveSceneNavigation` from PUL-F008 / ADR-014, for
  composition existence and member validation) but does NOT reach
  the lifecycle composition resolver (`resolveComposition`). Two
  distinct resolvers, distinguished here so a future maintainer
  doesn't conflate "navigation resolution" (still runs under
  prompter — composition errors still surface) with "lifecycle
  orchestration" (does not run under prompter — visual rendering
  is suppressed structurally). This ADR's bypass therefore does
  not violate ADR-011 because ADR-011's subject is the lifecycle
  resolver, which the prompter dispatch never invokes.
- [ADR-013](013-url-navigation-grammar-boundary.md) — the parser
  preserves `mode` and forbids recovering it from any non-URL
  source.
- [ADR-014](014-url-scene-target-selection.md) — scene navigation
  dispatch is mode-blind; it resolves the active slice and hands
  off to the loader for mode dispatch.
- [ADR-016](016-workbench-mode-present.md) — establishes the
  contract-layer-plus-seam-tests precedent. PUL-F013 stays DRAFT
  pending chrome / audio / GSAP runner / presenter input.
- [ADR-017](017-workbench-mode-standalone.md) — applies the same
  precedent to PUL-F014 with the slice-truncation seam.
- [ADR-018](018-workbench-mode-loop.md) — runner-input hint
  pattern (`repeat: 'until-aborted'`); ADR-022 takes a different
  shape because prompter does not invoke a runner.
- [ADR-019](019-workbench-mode-paused.md) — runner-input hint
  pattern (`hold: 'first-frame'`); ADR-022 differs for the same
  reason as ADR-018.
- [ADR-020](020-workbench-mode-scrub.md) — runner-input hint
  pattern (`cueGate: 'monotonic-forward'`); ADR-022 differs.
- [ADR-021](021-workbench-mode-screenshot.md) — bundled runner-
  input hint (`screenshot: 'capture'`) plus a scene-side seam
  (`ctx.mode === 'screenshot'`). ADR-022 takes neither shape:
  prompter has no runner consumer (because the runner is not
  called) and no scene-side `ctx.mode` consumer (because no scene
  hook fires). The captions seam is its own surface.
