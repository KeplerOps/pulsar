# ADR-025: Timeline Adapter and Composition Master — Revising the Resolution Lifecycle

## Status

Accepted (supersedes the *resolution-ordering* decisions of
[ADR-002 §Resolution](002-scene-registry-and-compositions.md) and
[ADR-011](011-composition-resolver-orchestration.md); their other
decisions stand)

## Date

2026-05-10

## Context

[ADR-003](003-gsap-timeline-engine.md) decided GSAP is the timeline
engine: each scene's `timeline(ctx)` returns a GSAP timeline, scenes
receive GSAP through `ctx.gsap` (not by importing it), and **the runtime
composes scene timelines into a master timeline for a composition**.
[ADR-011](011-composition-resolver-orchestration.md) made the
composition resolver a pure orchestrator with an injected
`SceneTimelineRunner` adapter so the GSAP runner could land later
without touching `composition-resolver.ts`.
[ADR-002 §Resolution](002-scene-registry-and-compositions.md) defined
the lifecycle the resolver implements: validate every referenced scene
id → preload assets → mount each scene via `create(ctx)` → run its
timeline → tear it down via `cleanup(ctx)` → advance to the next entry
— **strictly per scene**.

Until now the `SceneTimelineRunner` slot held a placeholder that parked
each scene until the navigation aborted; no `gsap` import existed in the
repo, `ctx.gsap` was unset, and the URL/runner mode hints (`beat`,
`repeat`, `hold`, `cueGate`, `screenshot`) were honored only vacuously
by parking. PUL-F022 is the requirement that ships the real path:

> Each scene SHALL produce a timeline that the runtime composes into a
> master timeline for the active composition. The composed timeline
> SHALL support play, pause, seek, speed change, and named labels.

The key word is **for the active composition** (singular) — echoed by
ADR-003 ("a master timeline for *a composition*"). That is in direct
tension with ADR-002's *per-scene* lifecycle: if scenes are mounted and
torn down one at a time, their timelines can never all be in one master
at once, so `seek` / named labels / transport over the *composition*
collapse to transport over the *active scene*. The first cut of
PUL-F022 took the per-scene reading; review (codex, twice, plus the
maintainer) rejected it as not delivering the requirement.

`docs/design/pul-f022-timeline-orchestration-preflight.md` (the codex
architecture preflight) records the binding constraints: GSAP belongs
behind a timeline adapter and `ctx.gsap`; `composition-resolver.ts` must
stay GSAP-free; the registries, asset preloader, abort signal, and
mandatory-cleanup invariant must be reused, not bypassed; master labels
need deterministic collision handling because a composition may reuse a
scene id (ADR-002 allows repeated entries); speed is a validated
transport parameter on the master, not scene metadata or manifest
`behavior`; the runner must not hand-roll timers.

The reference designs the resolution borrows from — verified against
their docs:

- **GSAP** (`gsap.com/docs/v3/GSAP/Timeline/`, the timelines guide, and
  the common-mistakes page): nesting is first-class — `master.add(child,
  position)` with the `'>'` / label / `'+='` position syntax; a child
  timeline's labels do **not** propagate to the parent (they must be
  re-added on the master); transport on the master cascades to children
  (`play` / `pause` / `seek` / `timeScale` / `repeat` / `reverse`);
  `tweenTo` / `tweenFromTo` scrub the playhead to a time/label and stop;
  a timeline is itself thenable (`then()` resolves on completion);
  "adding tweens to a completed timeline" is a documented mistake (so
  the master is composed before play, not extended behind the playhead).
- **Remotion** (`remotion.dev/docs/series`, `remotion.dev/docs/the-fundamentals`)
  — Pulsar's export path, ADR-006: a `<Composition>` is a component +
  metadata with `durationInFrames` declared up front; `<Series>`
  stitches `<Series.Sequence durationInFrames={N}>` segments
  sequentially; **"children are unmounted if they are not within the
  time range of display"** — Remotion does *windowed* mounting, with the
  frame number as the source of truth.
- **Theatre.js** (`theatrejs.com/docs/latest/manual/sequences`): one
  Sequence per Sheet, with a "Focus Range" to play/inspect a sub-range
  — the analog of Pulsar's composition `range` override.

## Decision

### 1. The timeline adapter (`src/runtime/timeline.ts`)

The runtime's single GSAP boundary:

- `createTimelineEngine()` returns `{ gsap }` — the GSAP instance the
  workbench passes to scenes as `ctx.gsap` (ADR-003). `WorkbenchSceneCtx`
  gains a required `gsap` member; `src/main.ts`'s `buildCtx` supplies it
  per navigation. Scenes call `ctx.gsap.timeline()` in `timeline(ctx)`;
  they do not import GSAP. The composition resolver still treats `ctx` as
  opaque — only scenes and this adapter read it.
- `assertSceneTimeline(value, sceneId)` validates the value
  `timeline(ctx)` returned: a GSAP timeline is accepted; `null` /
  `undefined` is accepted as "no timeline authored yet" (the placeholder
  scene returns `null` and stays valid); anything else — including a
  `Promise` — throws `SceneTimelineTypeError` with the scene id in the
  message.
- `composeMasterTimeline(engine, segments)` nests the scene timelines of
  the active composition slice into one master `gsap.timeline({ paused:
  true })`, in manifest order. Each segment gets a master label at its
  start (`sceneSegmentLabel`), and every scene-local label is copied into
  the master under a **namespaced** name (`sceneTimelineLabel`) so a
  composition that reuses a scene id keeps an unambiguous label space:
  the first / only use of scene id `intro` produces `intro:hook`; a
  second use produces `intro#1:hook`. A `null` / `undefined` segment
  timeline contributes a zero-duration segment. A scene timeline built
  with `{ paused: true }` (the GSAP "construct to nest" idiom) is
  un-paused once nested so the master drives it; the master stays paused
  at time 0 — positioning and playback are the caller's job.
- `MasterTimeline` is the transport surface PUL-F022 mandates, keeping
  GSAP behind the boundary: `play()`, `pause()`, `isPaused()`,
  `seek(time | label)` (unknown label or non-finite time →
  `TimelineSeekError`), `setSpeed(multiplier)` (a **finite number
  greater than zero** — zero, negative, NaN, Infinity, and non-number
  values throw `TimelineSpeedError` and leave the prior rate unchanged),
  `speed()`, `repeat(count)` (`-1` = infinite — the loop-mode
  mechanism), `time()`, `duration()`, a frozen `labels` snapshot,
  `hasLabel(name)`, `labelFor(sceneId, localLabel, occurrence?)`,
  `onComplete(handler)`, and `kill()`.
- `createGsapCompositionTimeline({ engine, onMaster? })` returns the
  `CompositionTimelineAdapter` (§2) the workbench wires onto the
  resolver, replacing the placeholder runner. Each `run(segments, opts)`
  call composes `segments` into one master, applies the head hints
  (`headHold: 'first-frame'` → seek 0 + pause, wins over `headBeat` /
  `headRepeat` with no beat lookup — ADR-019; `headScreenshot: 'capture'`
  → seek to the addressed beat or frame 0 + pause — ADR-021; `headBeat`
  → seek to the head scene's namespaced label, or, if it does not exist,
  call `onBeatMissing()` and stay at frame 0, then play forward —
  PUL-F011 / ADR-015, non-fatal; `headRepeat: 'until-aborted'` →
  `repeat(-1)` then play — ADR-018; `headCueGate: 'monotonic-forward'` →
  no-op until the audio engine lands — PUL-F024 / ADR-020), reports the
  live master to `onMaster` (the seam the future workbench transport /
  scrub UI and presenter HUD drive), then plays the master and resolves
  on its **natural completion** (so the resolver tears every scene down —
  ADR-002's "advance" becomes "the composition ended") or on
  `opts.signal` abort, killing the master either way. The completion
  handler is armed before `play()`, so a very short master cannot
  complete before the waiter is installed. A held / looped master never
  reaches its end, so only abort resolves it then.

### 2. The revised resolution lifecycle (`src/runtime/composition-resolver.ts`)

The runtime owns **one master timeline per active composition**, so
every scene's DOM must coexist while the master plays. `resolveComposition`
now:

1. validates the manifest; builds the plan (resolves scene ids →
   modules; snapshots per-entry `range` / `behavior` overrides);
2. **MOUNT phase** — for each scene in manifest order: `preloadAssets`,
   `await create(ctx)`. Scenes are **not** torn down between steps.
   Abort checkpoints: before any scene, after each preload, after each
   create. A scene whose `create` was attempted joins the cleanup list
   even if `create` itself threw (resources may have been partially
   acquired);
3. **COMPOSE + RUN phase** — collects each mounted scene's `timeline(ctx)`
   value (NOT awaited — see §3) and hands the slice + the head hints to
   the injected `CompositionTimelineAdapter.run(segments, opts)`, which
   composes the master, plays it, and resolves on natural completion or
   on abort;
4. **CLEANUP phase** — `await cleanup(ctx)` for every mounted scene in
   reverse mount order, **always** — including every failure path in
   steps 2/3, and including a navigation abort during playback (the
   adapter resolves rather than throwing on abort, so cleanup always
   runs, then the resolver re-raises an `aborted during composition
   playback` error so the loader's pure-abort suppression applies).

The per-scene `SceneTimelineRunner` / `SceneTimelineRunInput` seam is
**removed** and replaced by `CompositionTimelineAdapter` (`run(segments,
opts): Promise<void>`). The resolver depends only on that interface, so
it stays GSAP-free (ADR-011's pure-orchestrator decision holds — only
the *shape* of the timeline adapter changed). The other ADR-011 / ADR-002
invariants are preserved: missing-id pre-flight aggregates all offenders
before any side effect; `assertCompositionManifest` is called
defensively at the boundary; cleanup is mandatory whenever a scene was
touched and runs exactly once per scene activation; a phase failure plus
one or more cleanup failures surface as an `AggregateError` whose
`errors` array carries the phase error first then the cleanup errors in
order, none mutated; the `composition resolution failed:` wrapping prefix
and the `Error.cause` chain are unchanged. The bridge
(`scene-navigation.ts`) and loader (`scene-loader.ts`) thread the
adapter through instead of `runTimeline`; the single-scene workbench
modes (`standalone` / `loop` / `paused` / `scrub` / `screenshot`) still
truncate the slice to the head before the resolver sees it (ADR-017 —
ADR-021), so "no following entries run" stays a structural guarantee;
`mode=present` runs the full slice and forwards the presenter controller
once into the run options.

### 3. `scene.timeline(ctx)` is no longer awaited

ADR-011 had the resolver `await scene.timeline(ctx)` "so async timeline
factories resolve to a concrete timeline". A GSAP timeline is itself
thenable (`Animation.prototype.then` resolves on completion), so awaiting
it would block until the timeline finished — forever, for a paused one —
instead of yielding the timeline. The resolver now hands the value to the
adapter unchanged; a scene that needs asynchronous setup does that work
in `create(ctx)` (which the resolver does await) and builds the timeline
synchronously. A `timeline(ctx)` that still returns a `Promise` reaches
the adapter's validator and is rejected.

### 4. Test-file split (no oversized files)

`tests/runtime/scene-loader.test.ts` had grown to ~6 400 lines. It is
split into focused suites — `scene-loader.test.ts` (navigation, errors,
abort), `scene-loader-beat-mode.test.ts`, `scene-loader-present.test.ts`,
`scene-loader-standalone-loop.test.ts`, `scene-loader-paused-scrub.test.ts`,
`scene-loader-screenshot-prompter.test.ts` — sharing
`scene-loader.helpers.ts` (fixtures plus an `asTimeline` shim that maps
the new `(segments, opts)` adapter call onto the old per-scene callback
shape, so tests that only pin a per-navigation hint keep their bodies;
suites that exercise composition-level behavior drive a recording
adapter directly). `composition-resolver.test.ts` and `timeline.test.ts`
were rewritten for the new lifecycle. No source or test file exceeds the
repo's size budget.

### 5. What stays follow-up (and the seam each extends)

PUL-F022's clauses are scene-produces-timeline, runtime-composes-into-a-
master-for-the-composition, and the master supports play / pause / seek /
speed change / named labels — all of which this adapter and lifecycle
deliver, proven end to end in `timeline.test.ts` (through the wired
adapter and through `resolveComposition`) and the resolver / loader
suites. Deliberately deferred:

- **Windowed / lazy scene mounting** (Remotion `<Series>` style — mount
  only the scenes within the master's current display window, clean up
  trailing ones). Today every scene in the active slice mounts before
  playback; for a long `mode=present` composition that is more DOM than
  ideal. Tracked as a follow-up requirement; the master / adapter
  primitives do not change when it lands.
- **Cross-scene transition rendering and visibility coordination** —
  fading scene N out as scene N+1 fades in, hiding inactive scenes.
  ADR-003's GSAP runner + a future transitions/ADR own this; today a
  scene that wants to stay hidden until its segment plays does that in
  its own timeline.
- **Bidirectional / cross-scene `seek`** — seeking back into an
  already-torn-down scene, or forward past mounted scenes, needs the
  windowed-mount/playhead-driven lifecycle above; `MasterTimeline.seek`
  is structurally there.
- **Per-entry `range` sub-range cuts** (PUL-F003 / ADR-011) — the
  resolver carries `range` through to the adapter as a segment field;
  the adapter does not interpret it yet.
- **Presenter → transport translation** (PUL-F020 / PUL-F021 / ADR-023 /
  ADR-024) — the resolver forwards the presenter controller into the run
  options; translating `advance` / `hold` / `skip-*` / `pause` /
  `resume` into `MasterTimeline.play` / `pause` / `seek` (including
  ADR-024's cross-command precedence and playhead-preserving
  pause/resume) is those requirements' runner contract, landing on this
  adapter's transport surface. PUL-F020 / PUL-F021 stay DRAFT.
- **Workbench transport / scrub controls UI** (PUL-F017's controls
  clause) — `createGsapCompositionTimeline`'s `onMaster` is its seam.
- **Audio-cue gating** (PUL-F024 / ADR-004 / ADR-020) — `headCueGate` is
  its seam; a no-op until the audio engine exists.

PUL-F022 transitions to ACTIVE.

## Consequences

### Positive

- ADR-003 is delivered: GSAP is the engine, scenes get `ctx.gsap`, the
  runtime composes the active composition's scene timelines into one
  master, and the master supports labels, seeking, pause, and speed
  control — without scenes importing GSAP.
- ADR-011's principle holds: `composition-resolver.ts` stays GSAP-free
  and is still a pure orchestrator with an injected timeline adapter;
  only the adapter's shape changed (per-scene → per-composition).
- The whole timeline subsystem has one home (`timeline.ts`). A future
  engine swap, a `ctx.gsap` wrapper expansion, sub-range cuts, presenter
  translation, the scrub UI, audio gating, and windowed mounting all
  land here (the last also touches the resolver lifecycle, deliberately).
- Master labels are deterministic and collision-free for repeated scene
  entries, which the URL `beat` grammar (ADR-015), composition `range`
  (ADR-002), and a future presenter HUD address by name.
- Speed validation is centralized and strict (finite, positive), so a
  stringly-typed or NaN rate cannot reach GSAP.
- The composition's master timeline genuinely spans the composition (all
  scene timelines nested at once), so named-label and seek behavior is
  composition-wide, not scene-local — the requirement's "for the active
  composition" is met as written.

### Negative

- GSAP is now a runtime dependency (`package.json` / `pnpm-lock.yaml`).
  Bundle size and license terms are tracked per ADR-003's risk table:
  core GSAP only; bonus / Club plugins require a separate ADR.
- ADR-002 §Resolution's and ADR-011's per-scene `mount → run timeline →
  cleanup → advance` *ordering* is superseded by mount-all → compose →
  play → cleanup-all. The cleanup-always invariant, the error envelopes,
  the missing-id pre-flight, and the abort seam are preserved; the
  *ordering* of `cleanup` relative to the next scene's `create` is what
  changed (now all-create, then all-cleanup-in-reverse). Code or tests
  that relied on "scene N is torn down before scene N+1 mounts" must
  adjust.
- Every scene in the active composition slice has its DOM mounted while
  the master plays (the windowed-mount optimization is a follow-up).
  For the single-scene modes this is one scene; for `mode=present` it is
  the whole slice.
- `WorkbenchSceneCtx` gained a required `gsap` member, so every ctx
  constructor (the workbench `buildCtx` plus test ctx builders) must
  supply it. Done in this change.
- The `SceneTimelineRunner` / `SceneTimelineRunInput` types are gone.
  External callers of `resolveComposition` / `loadSceneNavigationTarget`
  / `createSceneLoader` pass a `CompositionTimelineAdapter` (`run(segments,
  opts)`) instead of a per-scene `runTimeline`.

### Risks

| Risk | Mitigation |
|------|-----------|
| GSAP imported in the `node` test environment fails (no DOM / no `requestAnimationFrame`). | The tested surface — composition, labels, seeking, `timeScale`, `paused`, completion — is window-independent; GSAP's ticker falls back when `requestAnimationFrame` is absent. The timeline tests run in `node` and `kill()` masters so the ticker idles and the process exits cleanly. |
| Reusing the same scene id in a composition produces ambiguous master labels. | `composeMasterTimeline` namespaces every label by scene id and occurrence index; `sceneSegmentLabel` / `sceneTimelineLabel` are exported so the URL beat layer and a future presenter HUD compute the same names. |
| A scene returns a non-timeline (or a `Promise`) and the runner crashes. | `assertSceneTimeline` rejects at the adapter boundary; the resolver wraps the rejection with `composition resolution failed:` and still tears every scene down. |
| The deferred items (windowed mounting, transitions, range cuts, presenter translation, scrub UI, audio gating) get forgotten. | Each is a separate DRAFT requirement with its own issue, and §5 plus `timeline.ts`'s module comment name the seam each extends. |
| A new mode hint is added and the adapter silently ignores it. | The hints stay the loader-dispatched literal-union pattern; a new one is added at the loader / bridge / resolver seam and tested there, and `positionMaster` is the single place the adapter consumes them. |
| Mounting every scene up front is too much DOM for a long composition. | Acceptable for the talks/cuts the runtime targets today; the windowed-mount follow-up addresses scalability without changing the adapter primitives. |

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) — decided GSAP as the timeline
  engine; this ADR is its implementation.
- [ADR-002](002-scene-registry-and-compositions.md) — its §Resolution
  *ordering* is superseded here; its scene/composition model, mandatory
  cleanup, and "manifests over flow control" stand.
- [ADR-011](011-composition-resolver-orchestration.md) — its per-scene
  `runTimeline` ordering and the `await scene.timeline(ctx)` step are
  superseded here; its pure-orchestrator + injected-adapter + failure-
  semantics decisions stand.
- [ADR-006](006-remotion-export-path.md) — Remotion's `<Series>` /
  windowed-mounting model is the reference the windowed-mount follow-up
  borrows from; the export path consumes the same scene/composition
  model.
- [ADR-015](015-url-beat-positioning.md) / [ADR-018](018-workbench-mode-loop.md)
  / [ADR-019](019-workbench-mode-paused.md) / [ADR-021](021-workbench-mode-screenshot.md)
  — the URL beat / loop / paused / screenshot head hints the adapter
  honors via the master's transport API.
- [ADR-020](020-workbench-mode-scrub.md) — the scrub cue-gate hint the
  adapter carries forward as a no-op until the audio engine lands.
- [ADR-023](023-presenter-controls.md) / [ADR-024](024-presenter-pause-resume.md)
  — the presenter command seam whose `→ transport` translation extends
  this adapter's `MasterTimeline` surface when PUL-F020 / PUL-F021 are
  implemented.
- [ADR-004](004-howler-audio-engine.md) — the audio engine that arrives
  on `ctx.audio` and consumes the `cueGate` hint.
