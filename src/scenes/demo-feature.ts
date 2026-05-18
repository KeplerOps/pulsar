// Issue 98 — vertical-slice demo: feature-highlight scene.
//
// The second scene in the demo composition. This one declares a real
// static asset (an SVG mark committed under `public/assets/demo/`),
// which Vite's default public-asset surface serves at the root path
// under both `pnpm dev` and `pnpm build` + `pnpm preview`. The
// preflight at `docs/design/issue-098-vertical-slice-demo-preflight.md`
// is binding: same-origin asset, no `http://` / `https://` / `data:` /
// `blob:` URL, no audio (asset-policy decision the issue does not
// require). The Playwright spec at
// `tests-e2e/demo-composition.spec.ts` HEAD-fetches the asset URL so
// "the committed path is actually served" is a runtime check, not just
// a static-validation pass. The shared lifecycle envelope lives in
// `./demo-shared.ts`; per-scene constants stay here.

import type { SceneModule } from '../runtime/scene';
import { buildDemoTimeline, cleanupDemoRoot, mountDemoRoot } from './demo-shared';

// Exported so the unit + e2e tests assert against ONE constant rather
// than each duplicating the literal path. A future asset replacement
// is a one-line edit here.
export const DEMO_FEATURE_ASSET_URL = '/assets/demo/pulsar-mark.svg';

const ROOT_VALUE = 'demo-feature';
const FEATURE_IMG_ATTR = 'data-pulsar-demo-feature-img';

const BEAT_FEATURE_REVEAL = 'feature-reveal';

const HEADLINE_TEXT = 'Composition over slides.';
const BODY_TEXT =
  'Scenes carry their own timelines, captions, assets, and audio. Compositions arrange them.';

export const demoFeatureScene: SceneModule = {
  id: 'demo-feature',
  title: 'Demo — feature highlight',
  // See `demo-title.ts` for the rationale: `null` until the timeline
  // becomes authoritative for prompter / export consumers.
  duration: null,
  tags: ['demo'],
  assets: [DEMO_FEATURE_ASSET_URL],
  captions: [
    { at: 0, text: HEADLINE_TEXT },
    { at: BEAT_FEATURE_REVEAL, text: BODY_TEXT },
  ],
  audio: [],
  defaultNext: 'demo-outro',
  standalone: false,
  trailerSafe: true,
  create: (ctx: unknown) => {
    mountDemoRoot(ctx, ROOT_VALUE, (root, ownerDoc) => {
      const heading = ownerDoc.createElement('h2');
      heading.setAttribute('data-pulsar-demo-headline', '');
      heading.textContent = HEADLINE_TEXT;
      root.appendChild?.(heading);

      // The preloader (PUL-F005) has already warmed `assets[0]` when
      // this hook runs; the <img> just points at the same URL.
      const img = ownerDoc.createElement('img');
      img.setAttribute(FEATURE_IMG_ATTR, '');
      img.setAttribute('src', DEMO_FEATURE_ASSET_URL);
      img.setAttribute('alt', 'Pulsar mark');
      root.appendChild?.(img);

      const body = ownerDoc.createElement('p');
      body.setAttribute('data-pulsar-demo-body', '');
      body.textContent = BODY_TEXT;
      root.appendChild?.(body);
    });
  },
  timeline: (ctx: unknown) =>
    buildDemoTimeline(
      ctx,
      ROOT_VALUE,
      (tl) => {
        tl.to({}, { duration: 1 });
        tl.addLabel(BEAT_FEATURE_REVEAL, 1);
      },
      1,
    ),
  cleanup: cleanupDemoRoot(ROOT_VALUE),
};
