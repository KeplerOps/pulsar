// Pulsar L2 template — screenshotCallouts.
//
// An image with absolutely-positioned annotation labels, each at
// (x%, y%) relative to the image.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface CalloutSpec {
  readonly x: number; // percentage
  readonly y: number;
  readonly text: string;
}

export interface ScreenshotCalloutsContent {
  readonly imageSrc: string;
  readonly imageAlt?: string;
  readonly callouts: readonly CalloutSpec[];
}

export const screenshotCallouts = (id: string, content: ScreenshotCalloutsContent): SceneModule =>
  buildTemplateScene({
    id,
    title: 'Screenshot callouts',
    assets: [content.imageSrc],
    captions: content.callouts.map((c, i) => ({ at: `callout-${i}`, text: c.text })),
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'screenshot-callouts',
        buildChildren: (root, ownerDoc) => {
          const shot = ownerDoc.createElement('div');
          shot.setAttribute('class', 'shot');
          const img = ownerDoc.createElement('img');
          img.setAttribute('src', content.imageSrc);
          img.setAttribute('alt', content.imageAlt ?? '');
          shot.appendChild?.(img);
          content.callouts.forEach((c, i) => {
            const div = ownerDoc.createElement('div');
            div.setAttribute('class', 'callout');
            div.setAttribute(
              'style',
              `left: ${c.x}%; top: ${c.y}%; --callout-delay: ${600 + i * 320}ms`,
            );
            div.textContent = c.text;
            shot.appendChild?.(div);
          });
          root.appendChild?.(shot);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.6,
        buildSegments: (tl) => {
          content.callouts.forEach((_c, i) => {
            tl.addLabel(`callout-${i}`, 0.6 + i * 0.32);
          });
          tl.to({}, { duration: 0.6 + content.callouts.length * 0.32 });
        },
      }),
  });
