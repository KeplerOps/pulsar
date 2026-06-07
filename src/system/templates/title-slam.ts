// Pulsar L2 template — titleSlam.
//
// Title card with word-by-word stagger entry. Renders `<span class="word">`
// children of an `<h1 class="pulsar-title__h">` inside the scene root;
// CSS in `templates.css` drives the staggered word-in animation.
// Optional subtitle.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface TitleSlamContent {
  readonly title: string;
  readonly subtitle?: string;
  readonly glitch?: boolean;
}

export const titleSlam = (id: string, content: TitleSlamContent): SceneModule => {
  const words = content.title.split(/\s+/).filter((w) => w.length > 0);
  return buildTemplateScene({
    id,
    title: `Title — ${content.title}`,
    captions: [{ at: 'title-in', text: content.title }],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'title-slam',
        buildChildren: (root, ownerDoc) => {
          const h1 = ownerDoc.createElement('h1');
          h1.className = 'pulsar-title__h';
          for (const w of words) {
            const span = ownerDoc.createElement('span');
            span.className = content.glitch === true ? 'word pulsar-glitch' : 'word';
            span.textContent = w;
            span.dataset.text = w;
            h1.appendChild(span);
          }
          root.appendChild(h1);
          if (content.subtitle !== undefined) {
            const sub = ownerDoc.createElement('p');
            sub.setAttribute('class', 'pulsar-title__subtitle');
            sub.textContent = content.subtitle;
            root.appendChild(sub);
          }
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.6,
        buildSegments: (tl) => {
          tl.addLabel('title-in', 0);
          tl.to({}, { duration: 1.6 });
          tl.addLabel('subtitle-in', 1.6);
        },
      }),
  });
};
