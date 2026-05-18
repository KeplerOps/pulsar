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
// abstraction. The lifecycle envelope (defensive ctx narrowing, root
// mount with the activation marker, the activation/deactivation
// timeline wrap, cleanup) lives in `./demo-shared.ts` — see that
// file's header for the rationale. Per-scene constants (beat names,
// copy text) stay here per the preflight's "no demo framework on
// first pass" rule.

import type { SceneModule } from '../runtime/scene';
import { buildDemoTimeline, cleanupDemoRoot, mountDemoRoot } from './demo-shared';

const ROOT_VALUE = 'demo-title';
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
    mountDemoRoot(ctx, ROOT_VALUE, (root, ownerDoc) => {
      const title = ownerDoc.createElement('h1');
      title.setAttribute('data-pulsar-demo-title', '');
      title.textContent = TITLE_TEXT;
      root.appendChild?.(title);
      const subtitle = ownerDoc.createElement('p');
      subtitle.setAttribute('data-pulsar-demo-subtitle', '');
      subtitle.textContent = SUBTITLE_TEXT;
      root.appendChild?.(subtitle);
    });
  },
  timeline: (ctx: unknown) =>
    buildDemoTimeline(
      ctx,
      ROOT_VALUE,
      (tl) => {
        // GSAP labels are the named beats the URL / prompter / future
        // beat-seek surface address. `composeMasterTimeline`
        // translates each label into a `sceneTimelineLabel`-namespaced
        // master label per `src/runtime/timeline.ts`. The leading
        // activation call and the trailing deactivation tween are
        // owned by `buildDemoTimeline`.
        tl.addLabel(BEAT_TITLE_IN, 0);
        tl.to({}, { duration: 1 });
        tl.addLabel(BEAT_SUBTITLE_IN, 1);
      },
      1,
    ),
  cleanup: cleanupDemoRoot(ROOT_VALUE),
};
