// Workbench entry — bootstraps the Pulsar runtime and activates URL
// navigation (PUL-F007 / PUL-F008 / ADR-007 / ADR-013 / ADR-014). Builds
// the immutable registries, wires a `SceneLoader` to the lifecycle
// adapters (preloader, timeline, audio, unlock, chrome), and subscribes
// to `pulsar:navigate` / `pulsar:navigate-error`. Vite HMR disposes the
// popstate listener and any in-flight load on re-eval.

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
  effectiveMode,
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
import {
  type ChromeSlots,
  type ScrubControlsHandle,
  createScrubControls,
  mountChromeSlots,
} from './system/chrome';
import {
  type PracticeRendererHandle,
  type PresenterBridgeHandle,
  combinePresenterSources,
  createChromePrompterRenderer,
  createKeyboardPresenterSource,
  createPracticeRenderer,
  createPresenterBridge,
  getPresenterSessionId,
} from './system/presenter';
import { defaultTransitions } from './system/transitions';
import { WORKBENCH_COMPOSITIONS, WORKBENCH_SCENES } from './workbench-graph';

const stage = document.querySelector('#stage');
stage?.setAttribute('data-pulsar', 'placeholder');

// PUL-F028 / ADR-008 #7: structural validation BEFORE any lifecycle
// effect, over the same inputs the registries get. On findings, mark
// `data-pulsar-validation-failed` and throw, so the loader/resolver
// never touch a broken graph. The single shared
// `WORKBENCH_SCENES` / `WORKBENCH_COMPOSITIONS` source (also the
// PUL-P002 CI gate's input) keeps validated and registered inputs identical.
const scenes = WORKBENCH_SCENES;
const compositionEntries = WORKBENCH_COMPOSITIONS;

// Clear the failure marker before every boot so a fixed graph is not left
// marked validation-failed across a same-document re-eval (Vite HMR).
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

// PUL-F022 / ADR-003: GSAP timeline engine, threaded to scenes as `ctx.gsap`.
const timelineEngine = createTimelineEngine();

// PUL-F024 / ADR-004: Howler audio engine (process singleton). The loader
// builds a per-navigation `AudioService` over it for `ctx.audio`.
const audioEngine = createHowlerAudioEngine();

// PUL-F005 asset preloader factory — one per navigation, bound to an
// `AbortSignal` so back/forward cancels in-flight fetches.
const createPreloader = (signal: AbortSignal): ReturnType<typeof createAssetPreloader> =>
  createAssetPreloader({ init: { signal } });

// Timeline adapter — PUL-F022 / ADR-003 / ADR-025: composes scene timelines
// into the master, applies URL head hints, wires audio + cue gate +
// presenter, and resolves on natural completion or abort.
// Inter-scene transition overlay (`<div>` on `document.body`, above the
// chrome). L2 transitions tween it via the master timeline; living outside
// the scene roots keeps it from desyncing scene-owned GSAP state.
const transitionOverlay = document.createElement('div');
transitionOverlay.dataset.pulsarTransition = 'overlay';
transitionOverlay.style.position = 'fixed';
transitionOverlay.style.inset = '0';
transitionOverlay.style.pointerEvents = 'none';
transitionOverlay.style.zIndex = 'var(--pulsar-z-transition)';
transitionOverlay.style.opacity = '0';
transitionOverlay.style.display = 'none';
document.body.appendChild(transitionOverlay);

// PUL-F017 / ADR-020: scrub controls (built below). Declared here so the
// timeline adapter's `onMaster` hook can attach the live master; revealed
// only under `mode=scrub` (re-derived per navigation in `onNavigate`).
let scrubControls: ScrubControlsHandle | undefined;
let scrubMode = false;

let activeMode: NavigationMode = 'present';

const applyActiveSegment = (segment: import('./runtime/timeline').MasterSegment): void => {
  if (stage === null) return;
  stage.setAttribute('data-pulsar-scene-target', segment.id);
  if (activeMode !== 'present') return;
  const roots = stage.querySelectorAll('[data-pulsar-template]');
  for (const root of Array.from(roots)) {
    const shouldActive = root.getAttribute('data-pulsar-template') === segment.id;
    root.setAttribute('data-pulsar-template-active', shouldActive ? 'true' : 'false');
  }
};

const timeline = createGsapCompositionTimeline({
  engine: timelineEngine,
  transitions: defaultTransitions(),
  transitionOverlay,
  onSegmentChange: applyActiveSegment,
  // Reports the live master once per activation; only `mode=scrub`
  // attaches it to the scrub controls (PUL-F017 / ADR-020).
  onMaster: (master) => {
    if (scrubMode) scrubControls?.attach(master);
  },
});

// Filled in after the chrome surface is mounted (below).
let chromeSlots: ChromeSlots | undefined;

// Build the navigation-scoped scene ctx; the loader adds each occurrence's
// `activation` (issue #99) and seeded `rng` (PUL-F018), so both are omitted.
const buildCtx = (
  mode: NavigationMode,
  audio: AudioService,
  presenter?: import('./runtime/presenter').PresenterController,
): Omit<WorkbenchSceneCtx, 'activation' | 'rng'> => {
  const base: Omit<WorkbenchSceneCtx, 'activation' | 'rng'> = {
    stage,
    mode,
    gsap: timelineEngine.gsap,
    audio,
    ...(presenter === undefined ? {} : { presenter }),
  };
  if (chromeSlots === undefined) return base;
  return { ...base, chrome: chromeSlots as unknown as Readonly<Record<string, unknown>> };
};

// Prompter renderer (PUL-F019 / ADR-022): paints the captions script into
// the chrome lower-third slot (falling back to `document.body`), returning
// a dispose callback the loader runs on the next navigation.
const renderPrompter: PrompterRenderer = createChromePrompterRenderer(
  () => chromeSlots?.lowerThird ?? document.body,
);

// PUL-F030 / ADR-029: present-mode audio unlock adapter. The loader invokes
// it BEFORE preload / create / timeline / playback when a present-mode
// composition declares audio. The factory owns the click / abort / cleanup
// contract; this wiring supplies the stage and the `<button>`.
const audioUnlockAdapter = createDomAudioUnlockAdapter({
  mount: stage === null ? null : (button) => stage.appendChild(button as unknown as Node),
  createButton: () => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.pulsarAudioUnlock = 'gesture';
    button.textContent = 'Start presentation';
    // Center the gate on screen at the highest z-index, above the chrome.
    button.setAttribute(
      'style',
      [
        'position: fixed',
        'top: 50%',
        'left: 50%',
        'transform: translate(-50%, -50%)',
        'z-index: 9999',
        'padding: 18px 36px',
        'font: 600 18px/1 system-ui, -apple-system, "Segoe UI", sans-serif',
        'letter-spacing: 0.08em',
        'text-transform: uppercase',
        'color: #08090c',
        'background: #7df5ff',
        'border: none',
        'border-radius: 6px',
        'cursor: pointer',
        'box-shadow: 0 18px 60px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255,255,255,0.08) inset',
      ].join('; '),
    );
    return button;
  },
});

// PUL-F031 / ADR-031: workbench chrome surface — workbench-owned, mounted
// on `document.body` (not re-parenting `#stage`) BEFORE navigation listeners
// register, so it persists across a composition's scenes. The loader flips
// visibility per navigation. ARIA `role="complementary"` keeps it announced
// without disturbing scene focus order (PUL-Q008).
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

// Populate the chrome surface with the L2 slot DOM; scenes read these refs
// via `ctx.chrome`.
const chromeSurfaceEl = document.querySelector(
  '[data-pulsar-chrome="surface"]',
) as HTMLElement | null;
if (chromeSurfaceEl !== null) {
  chromeSlots = mountChromeSlots({
    surface: chromeSurfaceEl,
    ownerDocument: document,
  });
  // PUL-F017 / ADR-020: scrub transport controls, mounted AFTER the slot DOM
  // (`mountChromeSlots` clears the surface). Hidden until a scrub navigation.
  scrubControls = createScrubControls({
    ownerDocument: document,
    parent: chromeSurfaceEl,
  });
}

// PUL-F017 / ADR-020: drive the scrub readout off the GSAP ticker;
// `sync()` is inert when the controls are hidden / detached.
const syncScrubControls = (): void => scrubControls?.sync();
timelineEngine.gsap.ticker.add(syncScrubControls);

// L2 keyboard presenter source (see `keyboard-source.ts` for key mappings).
// `onHome` pushes the default-composition URL and lets the popstate
// listener handle the navigation (`bootstrapNavigation` owns history).
const presenterKeyboard = createKeyboardPresenterSource({
  onHome: () => {
    globalThis.history.pushState(null, '', '?composition=default');
    globalThis.dispatchEvent(new PopStateEvent('popstate'));
  },
});

// Cross-window bridge: same-origin pulsar windows share a session-scoped
// presenter `BroadcastChannel`, so a keystroke in either window drives the
// same controller. Local commands broadcast outbound; inbound commands
// merge with the keyboard source via `combinePresenterSources`.
const presenterSessionId = getPresenterSessionId();
const presenterBridge: PresenterBridgeHandle = createPresenterBridge({
  sessionId: presenterSessionId,
});
presenterKeyboard.source.subscribe((cmd) => presenterBridge.send(cmd));
const combinedPresenterSource = combinePresenterSources(
  presenterKeyboard.source,
  presenterBridge.source,
);

// Practice / speaker-notes renderer in the lower-third slot, toggled on
// `toggle-practice` (KeyN); re-renders the active scene's captions on each
// scene change.
let practiceRenderer: PracticeRendererHandle | null = null;
let stageObserver: MutationObserver | null = null;
if (chromeSlots !== undefined) {
  practiceRenderer = createPracticeRenderer({ target: chromeSlots.lowerThird });
  const refresh = (): void => {
    const stageEl = document.getElementById('stage');
    const sceneId = stageEl?.dataset.pulsarSceneTarget ?? null;
    if (sceneId === null) {
      practiceRenderer?.render([]);
      return;
    }
    const scene = sceneRegistry.get(sceneId);
    practiceRenderer?.render(scene?.captions ?? []);
  };
  const stageEl = document.getElementById('stage');
  if (stageEl !== null) {
    stageObserver = new MutationObserver(refresh);
    stageObserver.observe(stageEl, {
      attributes: true,
      attributeFilter: ['data-pulsar-scene-target'],
    });
  }
  refresh();
  combinedPresenterSource.subscribe((cmd) => {
    if (cmd.kind !== 'toggle-practice') return;
    practiceRenderer?.toggle();
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
  presenterCommands: combinedPresenterSource,
});

const onNavigate = (event: Event): void => {
  const target = (event as CustomEvent<NavigationTarget>).detail;
  // PUL-F017 / ADR-020: re-derive scrub mode from the URL and detach from
  // any prior master; a scrub activation re-attaches via `onMaster`.
  activeMode = effectiveMode(target);
  scrubMode = activeMode === 'scrub';
  scrubControls?.detach();
  void loader.handle(target);
};
const onNavigateError = (event: Event): void => {
  activeMode = 'present';
  scrubMode = false;
  scrubControls?.detach();
  loader.handleError((event as CustomEvent<Error>).detail);
};

globalThis.addEventListener(PULSAR_NAVIGATE_EVENT_TYPE, onNavigate);
globalThis.addEventListener(PULSAR_NAVIGATE_ERROR_EVENT_TYPE, onNavigateError);

const disposeNavigation = bootstrapNavigation(globalThis);

// Dev-only: on Vite HMR re-eval, tear down every listener / surface /
// source / in-flight load so they do not stack across re-evaluations.
// `import.meta.hot` is undefined in production builds.
import.meta.hot?.dispose(() => {
  disposeNavigation();
  globalThis.removeEventListener(PULSAR_NAVIGATE_EVENT_TYPE, onNavigate);
  globalThis.removeEventListener(PULSAR_NAVIGATE_ERROR_EVENT_TYPE, onNavigateError);
  loader.dispose();
  chrome.dispose();
  transitionOverlay.remove();
  presenterKeyboard.dispose();
  presenterBridge.dispose();
  stageObserver?.disconnect();
  practiceRenderer?.dispose();
  timelineEngine.gsap.ticker.remove(syncScrubControls);
  scrubControls?.dispose();
});
