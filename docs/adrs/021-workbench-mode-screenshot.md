# ADR-021: Workbench Mode `screenshot` — Runner Capture-Bundle Hint at the Loader/Runner Seam

## Status

Accepted

## Date

2026-05-09

## Context

ADR-007 names eight workbench modes: `present`, `standalone`, `loop`,
`paused`, `scrub`, `screenshot`, `prompter`, `rehearsal`. ADR-013 fixes the URL
grammar boundary that carries `mode=` to the runtime. ADR-014 fixes
the scene navigation dispatch layer. ADR-015 fixes URL beat
positioning. ADR-016 (`mode=present`), ADR-017 (`mode=standalone`),
ADR-018 (`mode=loop`), ADR-019 (`mode=paused`), and ADR-020
(`mode=scrub`) establish the precedent for landing a mode's contract
layer plus seam tests while the dependent rendering surfaces are
still pending: PUL-F013, PUL-F014, PUL-F015, PUL-F016, and PUL-F017
all stayed DRAFT after their respective contract PRs because chrome
/ audio / GSAP runner / presenter input / scrub-controls surfaces
are not yet implemented.

PUL-F018 specifies `mode=screenshot`:

> In `mode=screenshot`, the runtime SHALL render the addressed scene
> at the addressed beat (or first frame if no beat) with all asset
> preloads resolved, no animation in progress, all audio suppressed,
> and any randomness sourced from a deterministic seed.

The non-trivial parts of that statement decompose this way:

- "Render the addressed scene at the addressed beat (or first frame
  if no beat)" — the runner must seek to `input.beat` if present,
  else stay at frame 0. The "at the addressed beat" half reuses
  PUL-F011 / ADR-015 `headBeat` plumbing. Unlike `mode=paused`
  (ADR-019: "first frame wins"), screenshot HONORS the beat as the
  addressed-frame anchor — that's literally what the requirement
  says.
- "All asset preloads resolved" — already an invariant of PUL-F004 /
  PUL-F005. The composition resolver awaits `preloadAssets(scene)`
  before invoking `create(ctx)` for every scene. No new plumbing.
- "No animation in progress" — after seeking to the beat (or frame
  0), the runner must HOLD the timeline still. Distinct from
  `hold: 'first-frame'` (paused) because screenshot's hold position
  is beat-aware.
- "All audio suppressed" — the runner / audio engine must produce no
  audio output under screenshot capture. Broader than
  `cueGate: 'monotonic-forward'` (scrub) — `cueGate` only gates
  audio cues scheduled at timeline labels; screenshot suppresses
  cues AND ambient loops AND any other audio output the engine may
  produce.
- "Randomness sourced from a deterministic seed" — scenes that
  consume randomness (random tween offsets, particle emitters with
  jittered start times, procedural visuals, etc.) must derive any
  random values from a stable seed under screenshot capture, so
  re-loading the same URL produces an identical frame.

ADR-003's GSAP runner is not implemented. The placeholder runner in
`src/main.ts` has no real timeline (`scene.timeline(ctx)` returns
`null`), no audio engine (ADR-004's Howler integration is not yet
implemented), and no scene-side randomness path. With no animation,
no audio, and no random source, the placeholder vacuously satisfies
all four runtime axes — but vacuous truth is not enforcement.

The question this ADR answers is: where does the loader → runner
contract for `mode=screenshot` live, and on what contract does
PUL-F018 transition to ACTIVE?

## Decision

### Scope: screenshot is single-scene, explicitly

`mode=screenshot` is **single-scene execution at the addressed
head**, not a composition-wide capture mode. PUL-F018's requirement
is "the addressed scene at the addressed beat" — one scene, one
frame. Composition-wide capture (a sequence of frames across
multiple scenes' timelines, or a video export across a manifest) is
explicitly out of scope: the runtime has no cross-scene timeline
abstraction, no manifest-level frame aggregation, and no export
pipeline — adding any of those would be a wholly new architectural
layer beyond what PUL-F018 calls for. The user (or capture tooling)
addresses one specific scene to capture one frame.

The URL contract for "which scene to capture" reuses the existing
PUL-F008 / ADR-014 locator shapes (PUL-F007 / ADR-013 grammar):

- `?scene=x&mode=screenshot` — capture scene `x` directly.
- `?composition=c&mode=screenshot` — capture the head scene of
  composition `c`.
- `?composition=c&scene=x&mode=screenshot` — capture scene `x`
  within composition `c`.
- `?composition=c&index=N&mode=screenshot` — capture the entry at
  index `N` within composition `c`.

To capture a different scene in the same composition, the user
addresses that scene by id or index in a fresh URL — same pattern
the rest of the URL grammar uses for scene selection.

This single-scene scope is the precedent the four other
single-scene-execution modes (standalone / loop / paused / scrub)
already establish. The five single-scene-execution modes share the
same slice-truncation transform because they share the same
structural "no following entries run" promise; they differ only in
the head's runner-side semantic.

### Plumbing

`mode=screenshot` is dispatched at the loader
(`src/runtime/scene-loader.ts`) as a runner-input field forwarded
to the timeline-runner adapter on the head scene's run input only.
When `effectiveMode(target) === 'screenshot'` the loader passes
`screenshot: 'capture'` through `loadSceneNavigationTarget()` and
the resolver to `SceneTimelineRunInput.screenshot`.

The runner-side conformance bar splits across two seams:
`input.screenshot` (runner-input field) and `ctx.mode` (per-
navigation scene context). The split is forced by lifecycle
ordering: `create(ctx)` and `timeline(ctx)` run BEFORE the
resolver invokes `runTimeline(input)`, so any clause whose
enforcement must happen during scene setup cannot be gated by a
flag on the runner input.

`input.screenshot === 'capture'` covers the **runner-side** axes —
delivered on or after `runTimeline()` is called. A runner that
recognizes the field MUST:

1. Seek to `input.beat` if present, else stay at the timeline's
   start (frame 0). Missing-label handling reuses the existing
   PUL-F011 / ADR-015 `onBeatMissing` non-fatal path.
2. HOLD the timeline at that position — no animation in progress,
   no automatic advance. ADR-003's future GSAP runner achieves
   this with `timeline.seek(label).pause()` (or `seek(0).pause()`
   when no beat is supplied), then keeps its returned promise
   pending until the per-navigation `AbortSignal` fires (same
   parking pattern PUL-F016 / ADR-019 records for `mode=paused`).
3. Suppress all audio output the runner controls. ADR-004's future
   audio engine reads `input.screenshot === 'capture'` (or the
   scene `ctx.mode === 'screenshot'` seam) and produces no audio
   output: no cues, no ambient loops, no global mixer output. This
   is broader than `cueGate: 'monotonic-forward'` (scrub) because
   screenshot suppresses every audio path, not just cue firing.

`ctx.mode === 'screenshot'` covers the **scene-side** axis —
delivered to scene code from the moment `create(ctx)` runs:

4. Source any randomness from a deterministic seed so the captured
   frame is reproducible across runs. Scenes that consume
   randomness (random tween offsets, particle emitters with
   jittered start times, procedural visuals, etc.) read
   `ctx.mode === 'screenshot'` (the existing PUL-F012 / ADR-007
   seam) and route any random values through a deterministic
   source — today that means a scene-local PRNG seeded from a
   stable input (scene id + beat label is a natural choice;
   ADR-007 reserves the freedom for a workbench-supplied seed
   surface on `ctx` to land later). The runner's
   `input.screenshot` flag is NOT the seam for this clause
   because `create(ctx)` and `timeline(ctx)` run before the
   runner ever sees `input.screenshot`; gating randomness on the
   runner input would let scene-setup randomness escape the gate
   on every navigation. Scene-side determinism flows through
   `ctx.mode` + a future seed surface; ADR-021 reserves both.

A runner / scene that does NOT exercise the affected subsystems
trivially satisfies the bundle because none of the affected
behaviors exist. The placeholder timeline runner today and the
placeholder scene today are both in this category — no real
timeline, no audio engine, no scene-side randomness — so
"ignore the `screenshot` field and ignore `ctx.mode`" is correct
conformance. ADR-003's GSAP runner, ADR-004's audio engine, and
a deterministic-randomness convention (consumed by scenes via
`ctx.mode` plus the seed surface) are what introduce the
consumers that activate each MUST.

This wording is intentionally tighter than ADR-018's `repeat` and
ADR-019's `hold` because PUL-F018's clause uses SHALL on a
behavior bundle (frame freeze, audio suppression, deterministic
randomness) that has concrete subsystem boundaries (timeline,
audio, randomness). For `repeat` / `hold` / `cueGate` every
runner with a timeline (or audio cues) can honor a single hint;
for `screenshot`, only runners with all three subsystems
materially deliver the bundle.

The hint is **head-only**. Under composition targets the slice's
first entry is the addressed scene; following composition entries
never receive `screenshot`. This scoping is structural: under
screenshot the slice is truncated upstream so the head's frozen
timeline does not hand off to following entries. Forwarding
`screenshot` to non-head scenes would imply a following entry
could itself produce a deterministic frame, which contradicts the
requirement's single-scene scoping. The plumbing is parallel to
PUL-F011 / ADR-015's `headBeat`, PUL-F015 / ADR-018's
`headRepeat`, PUL-F016 / ADR-019's `headHold`, and PUL-F017 /
ADR-020's `headCueGate` head-only forwarding — same shape,
different field.

`SceneTimelineRunInput.screenshot` is declared as a literal-typed
field (`'capture'`) rather than a boolean so future capture
semantics (e.g., `'capture-still'` for explicit single-frame, or a
future multi-frame variant for animated capture) can extend the
union without breaking existing runners. A runner that ignores the
field, or that only recognizes `'capture'`, gracefully degrades to
no-capture behavior (the timeline plays normally, audio fires,
randomness is non-deterministic — i.e., default playback
semantics). The resolver and bridge do not interpret the value.

The slice IS **truncated** under `mode=screenshot` to the addressed
head entry — the same shape transform `mode=standalone` (ADR-017),
`mode=loop` (ADR-018), `mode=paused` (ADR-019), and `mode=scrub`
(ADR-020) apply. Without truncation, a runner that ignores
`input.screenshot` (a placeholder, a buggy GSAP wiring, a future
test runner) would let the resolver advance to the next composition
entry and screenshot-mode would silently degrade into normal
composition playback. That violates the documented screenshot
guarantee: "render the addressed scene at the addressed beat (or
first frame)" presupposes one scene, one frame; advancing to a
following entry breaks that promise.

Truncating the slice makes "no following entries run" a structural
guarantee that does not depend on runner conformance. The five
single-scene-execution modes (`standalone`, `loop`, `paused`,
`scrub`, `screenshot`) share the same slice transform; they differ
only in the head's runner-side semantic — standalone plays
normally, loop sets `input.repeat = 'until-aborted'`, paused sets
`input.hold = 'first-frame'`, scrub sets
`input.cueGate = 'monotonic-forward'`, screenshot sets
`input.screenshot = 'capture'`. The shape transform is shared
because the structural promise ("no following entries run") is
identical; the runner-side behaviors live where they belong.

The slice is **truncated, not flattened.** Replacing the resolved
target with `{ scene }` (no composition) would lose the head
entry's per-entry `range` / `behavior` overrides (object-form
entries per ADR-002 / ADR-011), turning screenshot into
direct-scene flattening — same foot-gun ADR-017 / ADR-018 /
ADR-019 / ADR-020 call out. The truncated `manifestSlice` (length
1) continues through the composition branch in
`loadSceneNavigationTarget()`, and the existing runner-input
plumbing forwards `range` / `behavior` per ADR-011.

PUL-F018 stays DRAFT after this PR lands, mirroring the ADR-016 /
PUL-F013, ADR-017 / PUL-F014, ADR-018 / PUL-F015, ADR-019 /
PUL-F016, and ADR-020 / PUL-F017 precedent. This PR ships:

- The loader → runner-input contract: `screenshot: 'capture'`
  reaches the head scene's run input under
  `effectiveMode === 'screenshot'`.
- The seam: `ctx.mode === 'screenshot'` reaches every lifecycle
  hook of the head scene through the existing PUL-F012 plumbing.
- Tests pinning the seam, the head-only scoping, the
  no-other-mode contamination, and the existing invariants under
  `screenshot` (composition validation still runs; no
  `data-pulsar-mode-*` attribute; beat forwarding preserved;
  `range` / `behavior` overrides preserved).

What it does NOT yet ship is the active *capture-bundle* behavior
(frame freeze, audio suppression, deterministic randomness):

- ADR-003's GSAP runner is not implemented. The placeholder runner
  has no real timeline to seek-and-freeze; it parks until abort.
  The placeholder vacuously satisfies "no animation in progress"
  because no animation ever advances, but cannot exercise the
  seek-then-freeze contract.
- ADR-004's Howler audio engine is not implemented. Audio output
  itself does not yet exist; there is nothing to suppress.
- A deterministic-randomness convention is not yet established.
  Scenes today have no scene-side randomness path; the
  scene-side seed surface (on `ctx`, paired with the existing
  `ctx.mode === 'screenshot'` seam) has no consumer. The
  scene-side seam itself (`ctx.mode`) IS already wired by
  PUL-F012 — what is missing is the seed payload and the scenes
  that consume it.

PUL-F018 transitions DRAFT → ACTIVE when ALL THREE hold:

1. ADR-003's GSAP runner lands AND it actively reads
   `input.screenshot === 'capture'` and seeks to `input.beat` (or
   frame 0) before pausing the timeline, with end-to-end tests
   showing the timeline does not advance after the initial seek
   under screenshot mode.
2. ADR-004's audio engine lands AND under
   `input.screenshot === 'capture'` (or `ctx.mode === 'screenshot'`
   on the scene context) produces no audio output — no cues, no
   ambient loops, no mixer output — with end-to-end tests proving
   silence under screenshot.
3. A scene-side deterministic-randomness convention lands —
   typically a seed surface on `ctx` (e.g., `ctx.seed`) the
   workbench derives from a stable input (scene id + beat label
   is a natural choice) AND scenes consume that seed via the
   existing `ctx.mode === 'screenshot'` seam to route any random
   values through a deterministic PRNG, with end-to-end tests
   proving identical pixels across runs. The scene-side surface
   is required because scene `create(ctx)` and `timeline(ctx)`
   run before the runner sees `input.screenshot`, so the
   runner-input field cannot gate scene-setup randomness.

Until all three land, the issue ↔ requirement link stays as
`DOCUMENTS` and PUL-F018 stays DRAFT — matching how ADR-016 /
PUL-F013, ADR-017 / PUL-F014, ADR-018 / PUL-F015, ADR-019 /
PUL-F016, and ADR-020 / PUL-F017 record "land the contract layer;
keep the requirement DRAFT until the dependent subsystems land."

### Boundary

The capture-bundle hint flows from the loader because:

- The loader already derives `effectiveMode(target)` for `ctx.mode`
  (ADR-007 / PUL-F012). Reusing the same derivation for
  `screenshot` keeps mode-aware logic in one place — no second
  `target.mode` inspection on a different layer.
- The composition resolver MUST stay mode-opaque (ADR-011 — pure
  orchestrator, no adapter knowledge). The resolver plumbs
  `headScreenshot` exactly the way it plumbs `headBeat`,
  `headRepeat`, `headHold`, and `headCueGate`: as an opaque
  forwarding field with no semantics it interprets. The loader is
  the only thing that maps `effectiveMode === 'screenshot'` to
  `screenshot: 'capture'`.
- `resolveSceneNavigation()` MUST run validation regardless of
  mode: unregistered compositions, unknown member scenes,
  ambiguous `composition+scene` locators, out-of-range indexes,
  and empty compositions still surface as navigation errors under
  `mode=screenshot`. No silent fallback to direct scene lookup.
- `loadSceneNavigationTarget()` already plumbs head-only options
  (`beat` / `onBeatMissing` / `repeat` / `hold` / `cueGate`);
  adding `screenshot` to that list reuses the same shape rather
  than inventing a new bridge surface.

### Stage attribute behavior

`data-pulsar-scene-target` (head scene id) AND
`data-pulsar-composition-target` (composition id) are both set on
the stage when the URL named a composition under `mode=screenshot`.
The attrs communicate "what was addressed," not "what's running" —
same invariant as `mode=standalone` (ADR-017), `mode=loop`
(ADR-018), `mode=paused` (ADR-019), and `mode=scrub` (ADR-020). No
`data-pulsar-mode-*` suppression attribute is preemptively written
under `screenshot` (parity with ADR-016 / ADR-017 / ADR-018 /
ADR-019 / ADR-020); future capture tooling that observes the
runtime is free to use that namespace if it actually needs a
stage-level signal.

### Beat semantics

`beat=` under `mode=screenshot` is forwarded to the head scene's
runner unchanged. PUL-F018 explicitly names "at the addressed beat
(or first frame if no beat)" — beat is the captured-frame anchor.
The runner sees both `input.beat` and `input.screenshot` on the
same input bundle.

Unlike `mode=paused` — where ADR-019's runner-side policy is "first
frame wins" so the runner SHOULD ignore `input.beat` —
`mode=screenshot` HONORS `input.beat` as the captured-frame
position. PUL-F018 says "at the addressed beat OR first frame if no
beat"; the conditional is explicit. The future GSAP runner under
screenshot calls `timeline.seek(input.beat).pause()` when `beat` is
present and `timeline.seek(0).pause()` when it is absent. Both
seeks produce a stable, non-animating frame; there is no
"play-forward" path under screenshot.

Missing-label diagnostics surface via the existing non-fatal
`onBeatMissing` path (ADR-015): a URL like
`?scene=x&beat=does-not-exist&mode=screenshot` does not unmount
the scene; the diagnostic appears on
`data-pulsar-navigation-error` / `onError` and the scene lands at
the timeline's first frame (the default cursor position).

### Composition slice behavior

Truncated to the addressed head entry, parallel to `mode=standalone`
(ADR-017), `mode=loop` (ADR-018), `mode=paused` (ADR-019), and
`mode=scrub` (ADR-020). The single-scene-execution helper at the
loader is shared: `applySingleSceneSlice` runs for all five modes
(`standalone`, `loop`, `paused`, `scrub`, `screenshot`). Following
composition entries do not run; the head scene's
`screenshot: 'capture'` reaches the runner input and the runner is
responsible for the actual capture-bundle delivery.

The composition slice MUST be validated by `resolveSceneNavigation()`
BEFORE the truncation transform. Unregistered compositions,
unknown member scenes, ambiguous `composition+scene` locators, and
out-of-range indexes still surface as navigation errors under
`mode=screenshot` — the same invariant ADR-017 / ADR-018 / ADR-019
/ ADR-020 hold for standalone, loop, paused, and scrub.

The bridge ALSO truncates a composition slice when `screenshot` is
supplied (`truncateToHead` shared with the `repeat` / `hold` /
`cueGate` paths) — a structural defense layered with the loader's
`applySingleSceneSlice` so direct bridge callers (test harnesses,
future export pipelines) get the same screenshot-mode single-scene-
execution guarantee. The two truncations are idempotent.

## Consequences

### Positive

- Mode → runner-input plumbing lives at the loader, the same place
  PUL-F012 derives `ctx.mode`, PUL-F015 derives `repeat`, PUL-F016
  derives `hold`, and PUL-F017 derives `cueGate`. One mode dispatch
  site, not five.
- The resolver stays mode-opaque (ADR-011): `headScreenshot` is
  plumbed the same way `headBeat`, `headRepeat`, `headHold`, and
  `headCueGate` already are, with no new resolver semantics.
- The runner contract is a single optional input field
  (`screenshot?: 'capture'`). A runner that ignores it
  (placeholder, future non-screenshot test runners) gracefully
  degrades; a runner that honors it (future GSAP + audio +
  determinism stack) reads one field instead of inferring
  screenshot semantics from `ctx.mode`.
- The bundle approach (one literal-typed flag instead of
  `freeze` + `audioMode` + `seed` fields) keeps the runner
  surface narrow. The four runtime axes travel together because
  `mode=screenshot` means "capture this frame deterministically";
  shipping them separately would fragment the surface for a
  combination that has no other consumer.
- Following ADR-016 / ADR-017 / ADR-018 / ADR-019 / ADR-020's
  precedent keeps the DRAFT → ACTIVE bar consistent across mode
  requirements: ACTIVE means the named behavior is actively
  delivered end to end, not just structurally scaffolded.
- No premature abstraction. No `ModePolicy` record, no shared
  mode-hint type, no policy table. When a future mode needs a
  different shape of runner hint, it adds its own field; if
  multiple modes converge on a shared representation, that
  representation lands then with at least two consumers informing
  its shape. The five single-scene-execution modes (standalone,
  loop, paused, scrub, screenshot) share `applySingleSceneSlice`
  because they share a structural invariant, but they do NOT share
  a runner-input field — each owns its own (`repeat`, `hold`,
  `cueGate`, `screenshot`, none).

### Negative

- PUL-F018 stays DRAFT until ADR-003's GSAP runner, ADR-004's
  audio engine, AND a deterministic-randomness convention all
  land. A reviewer reading the requirement in isolation may
  expect ACTIVE on first delivery; the DRAFT-with-contract-and-
  seams state is intentional and matches the PUL-F011 / PUL-F013
  / PUL-F014 / PUL-F015 / PUL-F016 / PUL-F017 precedent.
- Adding `screenshot` to `SceneTimelineRunInput` widens the runner
  adapter surface. Every runner adapter (placeholder today, future
  GSAP, test harnesses) sees the new field. Test runners that
  don't care about screenshot semantics ignore it; this is the
  cost of extending the input shape. The alternative (a separate
  runner parameter) would be larger surface, not smaller.
- The seam tests are necessary but not sufficient: they prove the
  hook exists and behaves correctly under `mode=screenshot`, but
  they do not prove that a future GSAP runner will plug in
  correctly, that a future audio engine will respect the
  suppression, or that a future randomness convention will be
  consumed correctly. The surface PRs that land each of those
  subsystems are responsible for adding their own end-to-end
  tests.
- Bundling the four runtime axes (frame freeze, audio
  suppression, deterministic randomness, no animation) under one
  flag means a runner cannot opt-in to a subset (e.g., "freeze
  but don't suppress audio"). This is intentional — the
  requirement bundles them — but a future need to differentiate
  would require extending the union (e.g., `'capture-no-audio'`
  vs `'capture'`). The literal-typed union leaves room for that
  extension.

### Risks

| Risk | Mitigation |
|------|-----------|
| A future runner ignores `input.screenshot` and the regression goes unnoticed | The seam tests pin "loader sets `input.screenshot = 'capture'` under `mode=screenshot`." A runner that ignores the hint produces wrong runtime behavior (timeline advances, audio fires, randomness is non-deterministic). When the GSAP runner / audio engine / randomness convention land, their own end-to-end tests prove the hint is honored. |
| `screenshot` accumulates as a kitchen-sink field for unrelated capture semantics | The literal-typed union (`'capture'`) constrains valid values. Adding a new variant (`'capture-still'`, `{ frame: 'addressed', audio: false, seed: 42 }`) is an explicit type extension, visible in code review. |
| Slice truncation flattens to direct-scene and loses object-form `range` / `behavior` overrides | The seam test "preserves the addressed head entry's `range` and `behavior` overrides on the runner input under `mode=screenshot` (composition+index with object-form entry)" pins object-form head-entry plumbing through the truncated slice. A flatten-by-mistake would lose those overrides. |
| A runner that ignores `input.screenshot` silently degrades screenshot into normal composition playback | Slice truncation makes "no following entries run" structural — a no-op runner under `mode=screenshot` runs the head's lifecycle once and then completes the navigation, rather than advancing to a tail entry that should not have run. |
| PUL-F018 lingers DRAFT forever because the GSAP runner / audio engine / randomness convention keep slipping | DRAFT is a feature here: it tells reviewers the screenshot-mode contract is partly delivered (boundary + seam) and gates ACTIVE on actual capture-bundle delivery. The GSAP runner PR (ADR-003), the audio engine PR (ADR-004), and a future randomness-convention PR are the natural triggers to revisit PUL-F018's status. |
| A non-parser caller forges a `NavigationTarget` with `mode: 'screenshot'` mid-flight | The defense-in-depth check `validateModeGrammar` already rejects unknown modes at the loader boundary; `'screenshot'` is in the `NAVIGATION_MODES` allowlist, and `effectiveMode` is the only consumer of the field. |
| A future runner honors `input.screenshot` for frame freeze and audio but skips deterministic randomness, producing visually different captures across runs | The seam test pins the loader-side hint propagation; the runner-side end-to-end tests for ACTIVE include an "identical pixels across runs" check explicitly. ADR-021 splits the runner-side axes (frame freeze, audio suppression — gated on `input.screenshot`) from the scene-side axis (deterministic randomness — gated on `ctx.mode === 'screenshot'` plus a future seed surface) so the contract is honest about which surface enforces which clause. |
| A reviewer assumes scene-side randomness is gated on `input.screenshot` and writes a scene that consumes randomness in `create(ctx)` expecting determinism | `create(ctx)` runs before `runTimeline(input)` is invoked, so a flag on the runner input cannot gate `create`-time randomness. ADR-021 explicitly routes the deterministic-randomness clause through the existing `ctx.mode === 'screenshot'` seam (available from `create(ctx)` forward) plus a future seed surface on `ctx`. The runner-input docstring on `SceneTimelineRunInput.screenshot` documents the split inline. |
| A capture pipeline assumes screenshot mode persists scene state (e.g., camera position, last interaction) and breaks when ADR-007's "URL is the only source of mode" rule is enforced | ADR-007 already forbids recovering mode from non-URL sources; the capture pipeline must encode all addressing in the URL (scene, beat, mode) per the requirement statement. |

## Current state (2026-05-09)

This PR delivers the contract boundary and seam-pinning layer:

- `src/runtime/composition-resolver.ts` — `SceneTimelineRunInput`
  gains optional `screenshot?: 'capture'`;
  `ResolveCompositionOptions` gains optional `headScreenshot?:
  'capture'`; the resolver forwards `headScreenshot` to plan[0]'s
  run input only.
- `src/runtime/scene-navigation.ts` —
  `LoadSceneNavigationTargetOptions` gains optional `screenshot?:
  'capture'`; `loadSceneNavigationTarget()` forwards it to
  `resolveComposition` as `headScreenshot`. The bridge truncates a
  composition slice when `screenshot` is supplied (the shared
  `truncateToHead` predicate fires when ANY of `repeat` / `hold` /
  `cueGate` / `screenshot` is supplied).
- `src/runtime/scene-loader.ts` — when `effectiveMode(target) ===
  'screenshot'`, the loader passes `screenshot: 'capture'` through
  the bridge; otherwise the key is omitted (key-presence
  semantics). The single-scene-execution helper
  `applySingleSceneSlice` widens to include `'screenshot'` so the
  slice is truncated to the addressed head under any of the five
  single-scene modes (standalone, loop, paused, scrub,
  screenshot) — the SHAPE transform is shared, the runner-side
  semantic difference (`input.screenshot`) is what differentiates
  screenshot from the others.
- `src/main.ts` — placeholder timeline runner docstring
  acknowledges `input.screenshot`. The placeholder ignores the
  hint; parking until abort vacuously satisfies the capture
  bundle because none of the affected subsystems exist yet.
  ADR-003's GSAP runner + ADR-004's audio engine + a
  deterministic-randomness convention will read the hint and
  deliver active behavior.
- `tests/runtime/composition-resolver.test.ts` — new
  `'URL screenshot-mode runner capture-hint forwarding (PUL-F018)'`
  describe block.
- `tests/runtime/scene-navigation.test.ts` — new `'URL
  screenshot-mode capture forwarding (PUL-F018)'` describe block
  under `loadSceneNavigationTarget`.
- `tests/runtime/scene-loader.test.ts` — new `'screenshot-mode
  runner capture-hint forwarding (PUL-F018)'` describe block.
- `docs/design/pul-f018-screenshot-mode-preflight.md` — codex
  architecture preflight design context (preserved from the
  preflight tool's returned summary; the codex sandbox failed to
  write design files during preflight, so the guardrails are
  reproduced verbatim — same handling pattern as
  `pul-f015-loop-mode-preflight.md`,
  `pul-f016-paused-mode-preflight.md`, and
  `pul-f017-scrub-mode-preflight.md`).
- This ADR.

PUL-F018 remains DRAFT. Issue #27 links to PUL-F018 via
`DOCUMENTS`. This PR is **not** an implementation of PUL-F018's
"render at the addressed beat with no animation, all audio
suppressed, deterministic randomness" clauses — it lands the
contract boundary and the seam. The ACTIVE transition is gated on
ADR-003's GSAP runner honoring `input.screenshot`, ADR-004's audio
engine providing real silence under `input.screenshot`, AND a
deterministic-randomness convention that scenes consume under
`input.screenshot`, each with end-to-end tests alongside the seam
tests in this PR. Treating this PR as satisfying PUL-F018 would be
a traceability/status mismatch.

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) — the timeline runner is
  the seam through which seek-to-beat-and-pause will flow when the
  GSAP runner lands. Today the runner is a placeholder, so
  screenshot frame freeze is structurally vacuous.
- [ADR-004](004-howler-audio-engine.md) — audio output is the
  consumer of the suppression. Today there is no audio engine, so
  the suppression has no consumer.
- [ADR-007](007-browser-workbench.md) — defines the eight workbench
  modes and the URL-only-source invariant for mode selection.
  Specifically references `mode=screenshot` as the
  visual-regression hook for agents and reviewers.
- [ADR-008](008-agent-native-authoring.md) — manifests-over-flow-
  control underpins the no-mode-suppression-in-resolver constraint.
- [ADR-011](011-composition-resolver-orchestration.md) — the
  resolver is opaque to mode; mode-derived behavior lives at the
  adapters it forwards to. The resolver plumbs `headScreenshot`
  unchanged, the same way it plumbs `headBeat`, `headRepeat`,
  `headHold`, and `headCueGate`.
- [ADR-013](013-url-navigation-grammar-boundary.md) — the parser
  preserves `mode` and forbids recovering it from any non-URL
  source.
- [ADR-014](014-url-scene-target-selection.md) — scene navigation
  dispatch is mode-blind; it resolves the active slice and hands
  off to the loader for mode dispatch.
- [ADR-015](015-url-beat-positioning.md) — precedent for "the
  resolver plumbs a head-only optional field; runner owns the
  semantics; loader fails fast at the paired-required boundary."
  ADR-021's `headScreenshot` mirrors `headBeat`'s shape. PUL-F018
  explicitly honors beat under screenshot as the captured-frame
  anchor.
- [ADR-016](016-workbench-mode-present.md) — establishes the
  contract-layer-plus-seam-tests precedent. PUL-F013 stays DRAFT
  pending chrome / audio / GSAP runner / presenter input.
- [ADR-017](017-workbench-mode-standalone.md) — applies the same
  precedent to PUL-F014 with the slice-truncation seam.
- [ADR-018](018-workbench-mode-loop.md) — PUL-F015 shares the
  slice-truncation transform; runner-side semantic difference is
  `input.repeat`. ADR-021's `screenshot` is the same shape with a
  different literal value.
- [ADR-019](019-workbench-mode-paused.md) — PUL-F016 shares the
  slice-truncation transform; runner-side semantic difference is
  `input.hold`. ADR-019 records "first frame wins" for paused;
  ADR-021 records "beat is honored" for screenshot — the two
  modes' beat-vs-position policies differ deliberately.
- [ADR-020](020-workbench-mode-scrub.md) — PUL-F017 shares the
  slice-truncation transform; runner-side semantic difference is
  `input.cueGate`. ADR-020 anticipates a future
  `cueGate: 'all-suppressed'` variant for screenshot; this ADR
  takes the alternative path of one bundled `screenshot: 'capture'`
  flag instead, because screenshot suppresses ALL audio output
  (cues, ambient loops, mixer) — a strict superset of cue gating
  — plus three other behaviors (frame freeze, deterministic
  randomness, no animation) that are not cue-gating semantics.
