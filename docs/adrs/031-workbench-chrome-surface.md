# ADR-031: Workbench Chrome Surface — Workbench-Owned, Mode-Governed, Persistent

## Status

Accepted

## Date

2026-05-18

## Context

PUL-F031 specifies the workbench chrome surface:

> The runtime SHALL render a workbench chrome surface around the scene
> stage. Chrome SHALL be workbench-owned, mounted before the first
> scene navigation, and SHALL NOT be created or mutated by scene
> modules. Chrome rendering SHALL be governed by the active workbench
> mode: `mode=present` renders chrome fully; modes that explicitly
> suppress chrome (e.g., `mode=standalone`, `mode=screenshot`) SHALL
> hide it. Chrome SHALL persist across scene navigations within a
> composition without being torn down between scenes.

ADR-007 names the eight workbench modes and the URL-only-source
invariant for mode selection. ADR-013 fixes the URL grammar boundary.
ADR-014 fixes scene target resolution. ADR-016 (`present`), ADR-017
(`standalone`), ADR-018 (`loop`), ADR-019 (`paused`), ADR-020
(`scrub`), ADR-021 (`screenshot`), ADR-022 (`prompter`) record the
mode-specific seams. PUL-A008 forbids scene modules from owning mode
dispatch. PUL-F013 (ADR-016) names "render full chrome" as one of the
four facets present-mode must deliver and explicitly leaves chrome to
"a future workbench-shell requirement (not yet drafted)" — that
requirement is PUL-F031.

The question this ADR answers: where does the chrome surface live,
how does it learn about workbench mode, and how does it persist
across scene navigations without becoming a scene-lifecycle concern?

## Decision

Chrome is a **workbench-owned DOM root**, built at the runtime
composition root (`src/main.ts`) before the first navigation event,
governed by a single per-navigation `applyMode` call from the scene
loader, and structurally inert to the resolver and scenes.

### Boundary

The chrome surface lives at two seams:

- **`src/runtime/workbench-chrome.ts`** — a factory
  (`createDomWorkbenchChrome`) that mounts the chrome DOM root,
  exposes `applyMode(mode: NavigationMode): void` and `dispose():
  void`, and contains the pure visibility policy
  `chromeVisibilityFor(mode)`. The factory mirrors
  `audio-unlock-dom.ts`: injected `mount` and `createSurface` hooks
  keep every DOM behavior testable against fakes while production
  `main.ts` supplies real `document.createElement` and the live mount
  point.

- **`src/runtime/scene-loader.ts`** — adds an optional `chrome?:
  WorkbenchChromeAdapter` field on `SceneLoaderOptions`. In
  `runTarget`, immediately after `validateModeGrammar(target)` passes
  and BEFORE `resolveSceneNavigation`, the loader calls
  `options.chrome?.applyMode(effectiveMode(target))`. The single call
  site is upstream of the composition resolver's per-scene loop, so a
  multi-scene composition produces exactly one `applyMode` call — the
  structural form of "chrome SHALL persist across scene navigations
  within a composition without being torn down between scenes."

`src/main.ts` instantiates `createDomWorkbenchChrome({...})` BEFORE
calling `bootstrapNavigation(globalThis)`, so the chrome surface exists
before any navigation event can fire. The HMR `dispose()` hook tears
chrome down so re-evaluated entry modules do not accumulate chrome
surfaces.

### Mode → visibility policy

The pure helper `chromeVisibilityFor(mode: NavigationMode): 'visible'
| 'hidden'` defines the policy:

| Mode | Chrome |
|------|--------|
| `present` | visible |
| `standalone` | **hidden** |
| `screenshot` | **hidden** |
| `loop` | visible |
| `paused` | visible |
| `scrub` | visible |
| `prompter` | visible |
| `rehearsal` | visible |

PUL-F031's statement names only `standalone` and `screenshot` as
chrome-suppressing modes. The PUL-F031 preflight records the
remaining defaults: "Other modes keep their existing ADR-defined
behavior unless their own requirement explicitly suppresses chrome."
No requirement names chrome suppression for `loop`, `paused`,
`scrub`, `prompter`, or `rehearsal`, so they default to visible.

The seam is **chrome-specific**, not a generic `ModePolicy`. A future
mode that needs compact / reviewer / presenter chrome variants
extends the literal-union return type at this one helper. Per the
ADR-016 / PUL-F013 precedent, generic mode-policy abstractions land
when a second concrete consumer demands them, not speculatively.

### What chrome IS NOT in this PR

PUL-F031 delivers the **structural chrome surface and the visibility
seam**, not chrome's visual content. The chrome surface ships empty
today — actual presenter controls (PUL-F020 / F021 / F025), captions
chrome, and audio chrome land as their own requirements. Per the
PUL-F031 preflight non-goals: "PUL-F031 should not implement
presenter controls, presenter command transport, audio chrome,
inter-scene transitions, screenshot capture, prompter UI, a new
workbench mode, a design system, persistence, authentication,
telemetry, export behavior, or a generic mode-policy framework."

### PUL-F013 coupling

PUL-F013 (`mode=present` renders full chrome, audio, transitions, and
responds to presenter input — ADR-016) lists four facets that ACTIVE
requires. This PR delivers the first facet (chrome). The remaining
three (audio service per ADR-004, GSAP runner per ADR-003, presenter
input per PUL-F020 / F021 / F025) are independent surfaces. PUL-F013
stays DRAFT — landing PUL-F031 satisfies one facet, not the full
four-facet contract. The DRAFT → ACTIVE transition is gated on every
facet landing.

## Consequences

### Positive

- The structural defense for every PUL-F031 clause exists in code:
  workbench ownership (factory is not exported into the scene
  surface), bootstrap-time mount (`main.ts` calls the factory before
  `bootstrapNavigation`), mode governance (`chromeVisibilityFor`
  table), composition persistence (single `applyMode` call per
  navigation, upstream of the resolver's per-scene loop).
- The chrome adapter follows the existing inert-seam pattern
  (`renderPrompter`, `presenterCommands`, `audioUnlockAdapter`).
  Pre-PUL-F031 loader callers (Node tests, every existing loader
  test suite) continue to work unchanged because the option is
  optional.
- The visibility policy is one pure function over `NavigationMode`,
  exhaustive over `NAVIGATION_MODES`. Adding the ninth mode requires
  an explicit case in the switch — the compiler forces the author to
  decide chrome behavior for the new mode.
- Chrome is mounted as a sibling of `#stage` on `document.body`. The
  preflight invariant "Do not re-parent `#stage` in a way that breaks
  loader ownership or lets scene cleanup clear chrome" is honored by
  construction.
- The `hidden` boolean IDL property (rather than CSS `display: none`)
  keeps hidden chrome out of the accessibility tree and prevents
  focus traps, satisfying the PUL-Q008 cross-cutting layer the
  preflight names.

### Negative

- The chrome surface ships empty today. A reviewer expecting visible
  presenter affordances will not see any — that content is owned by
  PUL-F020 / F021 / F025 and lands when those requirements are
  implemented. The DOM root is present and `data-pulsar-chrome` /
  `data-pulsar-chrome-visibility` are addressable for downstream
  styling and inspection.
- Two new files (`workbench-chrome.ts`, two test files) plus a
  single line at the loader's `runTarget` increase the loader's
  optional-seam list to four (`renderPrompter`,
  `presenterCommands`, `audioUnlockAdapter`, `chrome`). Each is
  narrowly scoped and inert when absent, but the list is growing.
  When a fifth lands, consider whether the loader's optional-seam
  pattern should consolidate into a single "workbench surfaces"
  argument bag.

### Risks

| Risk | Mitigation |
|------|-----------|
| Future chrome content (presenter controls, captions chrome) gets bolted onto the chrome surface in a way that re-introduces scene-owned mode branches | PUL-A008 source policy continues to scan `src/scenes/**/*.ts` for mode-literal branches. Chrome content authors land their content at the runtime/workbench seam, not at the scene seam — same pattern as audio (PUL-F024), presenter (PUL-F025), and prompter (ADR-022). |
| A future PR adds a generic `ModePolicy` abstraction by pulling `chromeVisibilityFor` alongside `audioOutputPolicyFor` into a shared table | The ADR-016 precedent: defer the abstraction until a third concrete consumer demands it. Two pure helpers in two files is not yet a pattern to extract. |
| Hidden chrome under `standalone` / `screenshot` becomes a covert focus trap if a future presenter control inside the chrome surface acquires focus before visibility is applied | The chrome adapter sets `element.hidden = true` (HTML `hidden` IDL property), which removes the element and all descendants from the focus order and the accessibility tree. PUL-Q008's Playwright gate exercises the live workbench and will catch focus-order regressions for any visible chrome content the future delivers. |
| A non-loader caller forges an invalid mode and calls `chrome.applyMode` directly | The chrome adapter re-validates against `NAVIGATION_MODES` and throws on unknown modes — defense in depth. The loader's `validateModeGrammar` already rejects forged modes before they reach chrome. |

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) — the timeline runner is a
  separate seam from chrome; chrome does not own timeline state.
- [ADR-004](004-howler-audio-engine.md) — `ctx.audio` is the separate
  seam through which audio chrome will flow when audio chrome lands;
  this ADR does not deliver audio chrome.
- [ADR-007](007-browser-workbench.md) — defines the eight workbench
  modes and the URL-only-source invariant for mode selection.
- [ADR-008](008-agent-native-authoring.md) — manifests-over-flow-
  control underpins the workbench-owned, scene-opaque chrome ownership
  choice.
- [ADR-011](011-composition-resolver-orchestration.md) — the resolver
  is mode-opaque and chrome-opaque. Chrome dispatch lives at the
  loader, not inside the resolver.
- [ADR-013](013-url-navigation-grammar-boundary.md) — the parser
  preserves `mode` and forbids recovering it from any non-URL source.
- [ADR-016](016-workbench-mode-present.md) — establishes the
  present-mode boundary and lists "render full chrome" as the first
  of four facets PUL-F013 ACTIVE requires. PUL-F031 delivers that
  facet; PUL-F013 stays DRAFT until the remaining three land.
- [ADR-017](017-workbench-mode-standalone.md) — names "surrounding
  chrome suppressed" as a PUL-F014 ACTIVE precondition. PUL-F031's
  `chromeVisibilityFor('standalone') === 'hidden'` satisfies that
  precondition structurally.
- [ADR-021](021-workbench-mode-screenshot.md) — screenshot-mode
  determinism includes "all chrome hidden" as a visual invariant.
  PUL-F031's `chromeVisibilityFor('screenshot') === 'hidden'`
  satisfies it.
- [ADR-022](022-workbench-mode-prompter.md) — prompter bypasses the
  scene lifecycle; PUL-F031's chrome dispatch still fires under
  `prompter` because the chrome surface is mode-governed, not
  lifecycle-governed.
- [ADR-029](029-present-mode-audio-unlock-gate.md) — the audio unlock
  adapter's factory shape (`audio-unlock-dom.ts`) is the prior art
  this ADR's `workbench-chrome.ts` factory mirrors.
