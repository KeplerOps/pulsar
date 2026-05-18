// Issue 98 — vertical-slice demo: title-card scene.
//
// The demo composition (`src/compositions/demo.ts`) wires this scene
// first. It opens the slice with a heading and a subtitle, fading
// each in on a named GSAP beat so reviewers can verify the timeline
// engine, the prompter caption path, and the URL beat-seek surface
// against authored content rather than a fixture. The codex preflight
// at `docs/design/issue-098-vertical-slice-demo-preflight.md` is
// binding: this scene reuses `ctx.gsap`, `ctx.stage.ownerDocument`,
// the existing scene schema, and the existing identifier grammar; it
// adds no new ADR, mode, asset pipeline, audio engine, or runtime
// abstraction. Shared defensive helpers (the ctx predicate, the
// activation marker flip, the scene-root query) live in
// `./demo-shared.ts` — see that file's header for the rationale.

import type { SceneModule } from '../runtime/scene';
import {
  DEMO_ACTIVE_ATTR,
  DEMO_ROOT_ATTR,
  findDemoRoot,
  isDemoCtx,
  setDemoActive,
} from './demo-shared';

const ROOT_VALUE = 'demo-title';
const STATE_ATTR = 'data-pulsar-demo-state';
const BEAT_TITLE_IN = 'title-in';
const BEAT_SUBTITLE_IN = 'subtitle-in';

const TITLE_TEXT = 'Pulsar';
const SUBTITLE_TEXT = 'A scene-and-composition runtime for cinematic browser presentations.';

export const demoTitleScene: SceneModule = {
  id: 'demo-title',
  title: 'Demo — title card',
  // `null` is honest: the scene's playable length is whatever
  // `timeline(ctx)` constructs, and PUL-F001 / ADR-002 explicitly
  // treats a divergence between `duration` metadata and the actual
  // GSAP timeline as a drift risk for prompter / export consumers.
  // Promoting this to an authoritative integer is a follow-up if /
  // when scene authoring needs scrub-bar metadata.
  duration: null,
  tags: ['demo'],
  assets: [],
  // Caption `at` labels are kebab-case and resolve against the GSAP
  // labels added in `timeline(ctx)`; the shared identifier grammar
  // (ADR-008 #1) covers both.
  captions: [
    { at: BEAT_TITLE_IN, text: TITLE_TEXT },
    { at: BEAT_SUBTITLE_IN, text: SUBTITLE_TEXT },
  ],
  audio: [],
  defaultNext: 'demo-feature',
  standalone: true,
  trailerSafe: true,
  create: (ctx: unknown) => {
    if (!isDemoCtx(ctx)) return;
    const stage = ctx.stage;
    if (stage === null) return;
    if (typeof stage.appendChild !== 'function') return;
    const ownerDoc = stage.ownerDocument;
    if (ownerDoc === undefined || ownerDoc === null) return;
    if (typeof ownerDoc.createElement !== 'function') return;

    const root = ownerDoc.createElement('section');
    root.setAttribute(DEMO_ROOT_ATTR, ROOT_VALUE);
    root.setAttribute(STATE_ATTR, 'mounted');
    // Initially inactive: the resolver mounts every scene in the
    // slice before any timeline runs, so a visible-on-create root
    // would render alongside every sibling scene. Activation flips
    // to true inside the scene's own timeline segment.
    root.setAttribute(DEMO_ACTIVE_ATTR, 'false');
    root.setAttribute('style', 'display: none;');
    if (typeof root.appendChild === 'function') {
      const title = ownerDoc.createElement('h1');
      title.setAttribute('data-pulsar-demo-title', '');
      title.textContent = TITLE_TEXT;
      root.appendChild(title);
      const subtitle = ownerDoc.createElement('p');
      subtitle.setAttribute('data-pulsar-demo-subtitle', '');
      subtitle.textContent = SUBTITLE_TEXT;
      root.appendChild(subtitle);
    }
    stage.appendChild(root);
  },
  timeline: (ctx: unknown) => {
    if (!isDemoCtx(ctx)) return null;
    const stage = ctx.stage;
    if (stage === null) return null;
    const root = findDemoRoot(stage, ROOT_VALUE);
    // GSAP labels are the named beats the URL / prompter / future
    // beat-seek surface address. We add them on the scene's own
    // timeline so `composeMasterTimeline` translates them into
    // `scene("demo-title").label("title-in")` master labels per
    // `sceneTimelineLabel` in `src/runtime/timeline.ts`. The trailing
    // mutation rides on the last tween's `onComplete` rather than a
    // post-tween `tl.call(...)` because the last entry in a
    // composition slice has its child timeline end at master
    // duration, and a callback at that exact position races the
    // master's `onComplete` and may be skipped.
    const tl = ctx.gsap.timeline();
    tl.call(() => setDemoActive(root, true));
    tl.addLabel(BEAT_TITLE_IN, 0);
    tl.to({}, { duration: 1 });
    tl.addLabel(BEAT_SUBTITLE_IN, 1);
    tl.to(
      {},
      {
        duration: 1,
        onComplete: () => {
          if (root !== null && typeof root.setAttribute === 'function') {
            root.setAttribute(STATE_ATTR, 'ran');
          }
          setDemoActive(root, false);
        },
      },
    );
    return tl;
  },
  cleanup: (ctx: unknown) => {
    if (!isDemoCtx(ctx)) return;
    const stage = ctx.stage;
    if (stage === null) return;
    const root = findDemoRoot(stage, ROOT_VALUE);
    if (root !== null && typeof root.remove === 'function') {
      root.remove();
    }
  },
};
