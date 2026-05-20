Pulsar L2 — cinematic-thriller system layer.

The runtime ships a new `src/system/` layer that turns pulsar from
"engine in search of content" into "system that produces decks." A
deck is now a composition manifest + content + small token overrides;
the visual register, chrome, transitions, scene templates, and
presenter UX are inherited.

  - **Register** (`src/system/register/`): one opinionated visual
    register — typography (display / serif / mono / sans), color
    palette, spacing rhythm, motion curves, z-layer stack — exposed
    as both CSS custom properties and typed TS constants. Decks
    override at the token level.
  - **Chrome pack** (`src/system/chrome/`): vignette, scanlines,
    grain, letterbox bars, screen flash, camera shake, glitch text,
    plus title / brand / centerpiece / lower-third / tag / act-frame
    slots. `mountChromeSlots` populates the existing workbench chrome
    surface; effect helpers (shake, fireScreenFlash, flickerOutAll,
    clock, popout) take the slot refs explicitly.
  - **Scene templates** (`src/system/templates/`): 18 factory
    functions returning `SceneModule`s — titleSlam, actHeader,
    centerpiece, outro, statBig, statRow, statPairGrid, quote,
    quoteStack, bulletList, introGrid, definitionTable, compare,
    screenshotCallouts, metricTicker, terminal, placard, outlineTitle.
    A new scene in a deck is one factory call with a content object.
  - **Transitions** (`src/system/transitions/`): 5 inter-scene
    transition kinds — cut, dissolve, hard-slam, hold-on-black, push.
    Composition manifest entries declare `behavior.transition: { name,
    durationMs? }`; the GSAP composer inserts the tween between scene
    segments on a transient overlay element.
  - **Presenter** (`src/system/presenter/`): DOM keyboard source
    (ArrowRight/Space → advance, ArrowLeft → skip-backward, KeyP →
    hold, KeyM → toggle-master-mute, Escape → home) wired through
    the existing `PresenterController`; practice-renderer for
    on-screen speaker notes; chrome-aware prompter renderer.
  - **Helpers** (`src/system/helpers/`): port of the cross-deck
    primitives — sleep, aSleep (AbortSignal + PresenterController-
    aware), startInterval, schedule, holdUntilAdvance, typeNode /
    typeInto with `[[glow]]` markers, markedTextHtml, fadeInCenter
    double-rAF settle, fadeOutAudio rAF volume ramp, srcMark.

Engine patches stay narrow:

  - `composition.ts` widens `BehaviorOverride` to carry an optional
    `transition` declaration.
  - `timeline.ts` extends `composeMasterTimeline` to accept a
    transitions registry + overlay; default behavior unchanged.
  - `scene-loader.ts` adds an optional `chrome` field on
    `WorkbenchSceneCtx` for templates to read.
  - `main.ts` mounts the chrome slots, instantiates the keyboard
    presenter source, passes the transitions registry + overlay
    into the GSAP adapter, and upgrades the placeholder prompter
    renderer.

Reference deck `pulsar-intro` (`?composition=pulsar-intro`) is the
proof: 17 scenes built entirely from template factories that
collectively exercise every template, every transition, every chrome
treatment. Authoring it was content + manifest + zero per-deck CSS.

The trivial issue-98 demo composition + scenes are removed; the
pulsar-intro deck supersedes them. Existing fixture scenes
(placeholder, browser-support, dom-css-accessibility) stay for the
PUL-Q002 / PUL-Q008 Playwright gates.
