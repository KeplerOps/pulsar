// Workbench entry — bootstraps Pulsar's runtime and activates URL
// navigation per PUL-F007 (URL grammar parser) + PUL-F008 (scene
// navigation dispatch) + ADR-007 + ADR-013 + ADR-014.
//
// Lifecycle:
//
//  1. Mark the `#stage` element so the placeholder background is
//     visible while the runtime decides what (if anything) to load.
//  2. Build the scene and composition registries from the bundled
//     scene/composition modules. Both registries are immutable after
//     construction (ADR-008 #2 "manifests over flow control").
//  3. Build a `SceneLoader` (PUL-F008) wired to those registries plus
//     the lifecycle adapters (PUL-F005 asset preloader; placeholder
//     timeline runner until ADR-003's GSAP runner lands).
//  4. Subscribe to the parsed-target events PUL-F007's
//     `bootstrapNavigation` dispatches: `pulsar:navigate` carries a
//     parsed `NavigationTarget`, `pulsar:navigate-error` carries a
//     grammar `Error`. Both are translated into loader calls so URL
//     parameters are honored at startup and on every `popstate`
//     (ADR-007).
//  5. Vite HMR re-evaluating the entry module disposes the previous
//     popstate listener AND the loader's in-flight load, so re-eval
//     does not stack duplicate listeners or strand a half-loaded
//     scene.

import { createAssetPreloader } from './runtime/asset-preloader';
import { type AudioService, createHowlerAudioEngine } from './runtime/audio';
import { createDomAudioUnlockAdapter } from './runtime/audio-unlock-dom';
import { createCompositionRegistry } from './runtime/composition-registry';
import {
  type NavigationMode,
  type NavigationTarget,
  PULSAR_NAVIGATE_ERROR_EVENT_TYPE,
  PULSAR_NAVIGATE_EVENT_TYPE,
  bootstrapNavigation,
} from './runtime/navigation';
import type { PrompterRenderer } from './runtime/prompter';
import { createSceneRegistry } from './runtime/registry';
import { type WorkbenchSceneCtx, createSceneLoader } from './runtime/scene-loader';
import { createGsapCompositionTimeline, createTimelineEngine } from './runtime/timeline';
import { assertNoValidationFindings, validateRuntime } from './runtime/validation';
import { createDomWorkbenchChrome } from './runtime/workbench-chrome';
// Pulsar L2 — register, chrome, templates, transitions.
import './system/register/tokens.css';
import './system/chrome/atmospheric.css';
import './system/chrome/chrome.css';
import './system/templates/templates.css';
import { type ChromeSlots, mountChromeSlots } from './system/chrome';
import { defaultTransitions } from './system/transitions';
import { WORKBENCH_COMPOSITIONS, WORKBENCH_SCENES } from './workbench-graph';

const stage = document.querySelector('#stage');
stage?.setAttribute('data-pulsar', 'placeholder');

// PUL-F028 / ADR-008 #7: structural validation pass BEFORE any
// lifecycle effect. Runs over the same declarative inputs the
// workbench is about to hand to `createSceneRegistry` and
// `createCompositionRegistry`, surfacing every finding — missing
// scenes in compositions, dangling assets, duplicate ids, undeclared
// cleanup — in one aggregate. The workbench error sink picks up the
// per-finding detail; the `data-pulsar-validation-failed` stage
// attribute lets screenshot regression and agent-driven inspection
// see at a glance that boot was aborted on structural grounds. The
// throwing wrapper halts the workbench so navigation, the loader,
// the preloader, and the resolver never touch a broken graph. Empty
// findings array → boot proceeds untouched.
//
// `scenes` and `compositionEntries` are declared ONCE in
// `./workbench-graph.ts` and passed to both the validator and the
// registry constructors. Splitting them into per-call literals
// would let a future scene get added to the registry path without
// being added to validation, leaving the PUL-F028 gate looking
// active while running unvalidated inputs (codex review cycle 3).
// The canonical module is the same source the PUL-P002 CI gate
// (`tests/runtime/workbench-graph.test.ts`) consumes — the browser
// bootstrap and the CI validation run against identical inputs.
// The module lives at the composition-root layer (next to
// `main.ts`), not under `src/runtime/`, so the reusable runtime
// engine does not import concrete scenes or compositions.
const scenes = WORKBENCH_SCENES;
const compositionEntries = WORKBENCH_COMPOSITIONS;

// Clear the failure marker before every boot. In a same-document
// lifecycle (Vite HMR or repeated `import` evaluation) a previous
// failed evaluation may have set the attribute; without an explicit
// reset, the stage would stay marked as validation-failed even after
// the author fixes the broken graph (codex review cycle 3).
stage?.removeAttribute('data-pulsar-validation-failed');

const validationFindings = validateRuntime({ scenes, compositions: compositionEntries });
if (validationFindings.length > 0) {
  stage?.setAttribute('data-pulsar-validation-failed', 'true');
  for (const finding of validationFindings) {
    console.error(`pulsar validation [${finding.code}]: ${finding.message}`);
  }
  assertNoValidationFindings(validationFindings);
}

const sceneRegistry = createSceneRegistry(scenes);
const compositionRegistry = createCompositionRegistry(compositionEntries);

// PUL-F022 / ADR-003: the GSAP timeline engine. Scenes receive it as
// `ctx.gsap` and build their timeline with it; the runtime composes the
// scene timelines into a master timeline (see `./runtime/timeline.ts`).
const timelineEngine = createTimelineEngine();

// PUL-F024 / ADR-004: the Howler audio engine — a process singleton.
// The loader builds a fresh per-navigation `AudioService` over it
// (scoped to the navigation's `AbortSignal`) and threads it into
// `ctx.audio`; scenes call `ctx.audio.play(...)` / `fade(...)` etc.
// rather than importing Howler. Howler auto-handles the browser
// autoplay-unlock gesture, so the workbench does not.
const audioEngine = createHowlerAudioEngine();

// PUL-F005 asset preloader. The placeholder scene declares no assets,
// so the preloader is a structural no-op today; once scenes start
// declaring URLs the same wire-up validates schemes, fetches, and
// stream-drains them ahead of `create(ctx)`. The factory shape lets
// the loader build a fresh preloader per navigation with an
// `AbortSignal` that cancels the in-flight `fetch` calls when the
// user clicks back/forward mid-preload.
const createPreloader = (signal: AbortSignal): ReturnType<typeof createAssetPreloader> =>
  createAssetPreloader({ init: { signal } });

// Timeline adapter — PUL-F022 / ADR-003 / ADR-025. The GSAP-backed
// composition timeline: the resolver mounts every scene in the active
// composition slice (preload + `create`), hands the adapter their
// `timeline(ctx)` values, and `run` composes them into one master GSAP
// timeline (`composeMasterTimeline` — namespaced labels, sequential
// nesting), applies the URL/runner-input head hints (`beat` seek with
// the `onBeatMissing` fallback, `mode=loop` repeat, `mode=paused` hold,
// `mode=screenshot` freeze-at-beat; the audio engine lands with
// PUL-F024, but `cueGate`→audio cue gating is a separate follow-up —
// scenes hang `ctx.audio` cues off their own timeline callbacks today),
// plays the master, and resolves on its natural completion (the
// resolver then tears every scene down) or on the per-navigation
// `AbortSignal`. Per-entry `range` overrides
// (PUL-F003) and the presenter command controller (PUL-F020 / PUL-F021)
// are not interpreted here yet — both land on this adapter's
// `MasterTimeline` transport seam when their requirements are
// implemented.
// Inter-scene transition overlay — a transient `<div>` parented to
// `document.body` (above the chrome surface). The L2 transitions
// library (cut / dissolve / hard-slam / hold-on-black / push) tweens
// this element via the master timeline; it lives outside the scene
// roots so a transition can never desynchronize scene-owned GSAP
// state. Created here so it survives across navigations within a
// composition.
const transitionOverlay = document.createElement('div');
transitionOverlay.dataset.pulsarTransition = 'overlay';
transitionOverlay.style.position = 'fixed';
transitionOverlay.style.inset = '0';
transitionOverlay.style.pointerEvents = 'none';
transitionOverlay.style.zIndex = 'var(--pulsar-z-transition)';
transitionOverlay.style.opacity = '0';
transitionOverlay.style.display = 'none';
document.body.appendChild(transitionOverlay);

const timeline = createGsapCompositionTimeline({
  engine: timelineEngine,
  transitions: defaultTransitions(),
  transitionOverlay,
});

// Scene context carries the stage handle, the per-navigation effective
// workbench mode (PUL-F012 / ADR-007), the GSAP instance scenes build
// their timeline with (PUL-F022 / ADR-003), and the per-navigation
// audio service (PUL-F024 / ADR-004). The loader calls this builder
// once per navigation that produces a runnable target, passing the
// effective mode it derived from the URL via `effectiveMode` and the
// audio service it built over `audioEngine`. Constructing ctx per
// navigation enforces ADR-007's "URL is the only source of mode" rule
// by construction — there is no long-lived ctx slot for a previous
// mode to linger in — and makes "audio survives the scene that started
// it" impossible. ADR-008 #2 (explicit dependencies over ambient
// globals) is satisfied by passing `stage`, `gsap`, and `audio` through
// ctx rather than reaching for `document`, importing GSAP, or importing
// Howler directly in scene modules.
// Filled in after the chrome surface is mounted (below).
let chromeSlots: ChromeSlots | undefined;

const buildCtx = (mode: NavigationMode, audio: AudioService): WorkbenchSceneCtx => {
  const base: WorkbenchSceneCtx = {
    stage,
    mode,
    gsap: timelineEngine.gsap,
    audio,
  };
  if (chromeSlots === undefined) return base;
  return { ...base, chrome: chromeSlots as unknown as Readonly<Record<string, unknown>> };
};

// Prompter renderer placeholder (PUL-F019 / ADR-022). Under
// `mode=prompter` the loader bypasses the resolver lifecycle
// structurally — no preload, no `create`, no `timeline`, no
// `cleanup` — and hands a `PrompterScript` (captions aggregated
// from the addressed scene or composition slice) to this adapter.
// Until the captions/script UI surface lands, the placeholder
// produces no visible output; the structural visual-rendering
// suppression is delivered by the loader's lifecycle bypass, not by
// this adapter.
//
// The placeholder mounts nothing persistent and returns
// `undefined`. Per the `PrompterRenderer` contract, that signals
// "no cleanup obligation" — the loader does not park waiting for
// abort. A future captions UI that mounts persistent DOM will
// return a `PrompterDispose` callback the loader invokes on the
// next navigation. ADR-022 records the DRAFT → ACTIVE bar for
// PUL-F019 (visible captions UI + end-to-end tests).
const renderPrompter: PrompterRenderer = () => undefined;

// Presenter command source (PUL-F020 / PUL-F021 / ADR-023 /
// ADR-024): intentionally OMITTED here. The runtime-side contract
// layer ships the `PresenterCommandSource` / per-navigation
// `PresenterController` seam and the `advance` / `hold` /
// `skip-forward` / `skip-backward` (PUL-F020) plus `pause` /
// `resume` (PUL-F021, ADR-024) command kinds — the loader builds a
// per-navigation `PresenterController` when `mode=present` AND
// `presenterCommands` is supplied. By omitting the field, the
// loader gracefully degrades (runners see `input.presenter ===
// undefined`) and the seam stays structurally inert until a real
// presenter UI surface lands. The future workbench surface owns
// the keyboard listener / on-screen controls and emits
// `PresenterCommand`s through a `PresenterCommandSource`; ADR-023
// (advance/hold/skip) and ADR-024 (pause/resume — including the
// cross-command precedence the runner must honor: `pause` / `resume`
// are a transport-freeze gate orthogonal to the beat-pacing kinds)
// record the DRAFT → ACTIVE bar (presenter UI module + GSAP runner
// that translates commands to transport calls — including playhead-
// preserving pause/resume — + end-to-end tests).
// PUL-F030 / ADR-029: present-mode audio unlock adapter. The loader
// invokes this BEFORE preload + scene `create(ctx)` + scene
// `timeline(ctx)` + master timeline playback when a present-mode
// composition declares audio (any scene's `scene.audio` non-empty).
// The factory in `./runtime/audio-unlock-dom` owns the click / abort /
// cleanup contract; this wiring just supplies the stage and the
// concrete `<button>` element. Tests cover the factory directly so a
// regression in click handling, abort race, or cleanup surfaces in
// `tests/runtime/audio-unlock-dom.test.ts` (codex review cycle 3).
const audioUnlockAdapter = createDomAudioUnlockAdapter({
  mount: stage === null ? null : (button) => stage.appendChild(button as unknown as Node),
  createButton: () => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.pulsarAudioUnlock = 'gesture';
    button.textContent = 'Start presentation';
    return button;
  },
});

// PUL-F031 / ADR-031: workbench chrome surface. The chrome controller
// is workbench-owned, mounted as a sibling of `#stage` BEFORE
// `bootstrapNavigation()` registers its listeners, and persists across
// scene navigations within a composition. The loader (above) calls
// `chrome.applyMode(effectiveMode(target))` once per navigation; this
// factory flips the `hidden` boolean + `data-pulsar-chrome-visibility`
// attribute on the same element instance, so persistence is structural.
// The chrome surface ships empty today — actual chrome content
// (presenter controls per PUL-F020 / F021 / F025, captions chrome,
// audio chrome) lands as those surfaces' own requirements. ARIA
// `role="complementary"` + `aria-label` keeps the chrome region
// announced without interfering with the scene's focus order
// (PUL-Q008). Mounting on `document.body` keeps `#stage` ownership
// untouched (preflight: do not re-parent `#stage`).
const chrome = createDomWorkbenchChrome({
  mount: (element) => document.body.appendChild(element as unknown as Node),
  createSurface: () => {
    const surface = document.createElement('div');
    surface.dataset.pulsarChrome = 'surface';
    surface.setAttribute('role', 'complementary');
    surface.setAttribute('aria-label', 'workbench chrome');
    return surface;
  },
});

// Populate the chrome surface with the L2 slot DOM (vignette,
// scanlines, grain, letterbox bars, title/brand/centerpiece/
// lower-third/tag/act-frame/flash slots). Scenes built from the L2
// template library read these refs via `ctx.chrome`.
const chromeSurfaceEl = document.querySelector(
  '[data-pulsar-chrome="surface"]',
) as HTMLElement | null;
if (chromeSurfaceEl !== null) {
  chromeSlots = mountChromeSlots({
    surface: chromeSurfaceEl,
    ownerDocument: document,
  });
}

const loader = createSceneLoader({
  scenes: sceneRegistry,
  compositions: compositionRegistry,
  stage,
  buildCtx,
  createPreloader,
  timeline,
  audioEngine,
  renderPrompter,
  audioUnlockAdapter,
  chrome,
});

const onNavigate = (event: Event): void => {
  const target = (event as CustomEvent<NavigationTarget>).detail;
  void loader.handle(target);
};
const onNavigateError = (event: Event): void => {
  loader.handleError((event as CustomEvent<Error>).detail);
};

globalThis.addEventListener(PULSAR_NAVIGATE_EVENT_TYPE, onNavigate);
globalThis.addEventListener(PULSAR_NAVIGATE_ERROR_EVENT_TYPE, onNavigateError);

const disposeNavigation = bootstrapNavigation(globalThis);

// Dev-only: when Vite HMR replaces this entry module, dispose the
// previous popstate listener AND the loader's in-flight load so
// re-evaluation does not stack duplicate listeners or strand a
// half-loaded scene. `import.meta.hot` is undefined in production
// builds.
import.meta.hot?.dispose(() => {
  disposeNavigation();
  globalThis.removeEventListener(PULSAR_NAVIGATE_EVENT_TYPE, onNavigate);
  globalThis.removeEventListener(PULSAR_NAVIGATE_ERROR_EVENT_TYPE, onNavigateError);
  loader.dispose();
  // PUL-F031 / ADR-031: remove the chrome surface so HMR re-evaluation
  // does not accumulate workbench chrome roots on `document.body`.
  chrome.dispose();
  // L2: drop the transition overlay so a re-evaluated entry does not
  // accumulate fixed-position children on `document.body`.
  transitionOverlay.remove();
});
