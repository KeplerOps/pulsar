// Pulsar L2 template — introGrid.
//
// Speaker/role grid. Each role is `{ logo, alt, role, primary? }`.
// Primary entries get bolder styling.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface IntroRole {
  readonly logoSrc?: string;
  readonly logoAlt?: string;
  readonly role: string;
  readonly primary?: boolean;
}

export interface IntroGridContent {
  readonly title: string;
  readonly roles: readonly IntroRole[];
}

export const introGrid = (id: string, content: IntroGridContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Intro grid — ${content.title}`,
    captions: [{ at: 'roles-in', text: content.title }],
    assets: content.roles.map((r) => r.logoSrc).filter((s): s is string => typeof s === 'string'),
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'intro-grid',
        buildChildren: (root, ownerDoc) => {
          const h = ownerDoc.createElement('h2');
          h.setAttribute('class', 'heading');
          h.textContent = content.title;
          root.appendChild(h);
          const grid = ownerDoc.createElement('div');
          grid.setAttribute('class', 'grid');
          content.roles.forEach((role, i) => {
            const art = ownerDoc.createElement('article');
            art.setAttribute('style', `--role-delay: ${500 + i * 220}ms`);
            if (role.primary === true) art.setAttribute('class', 'primary');
            if (role.logoSrc !== undefined) {
              const img = ownerDoc.createElement('img');
              img.setAttribute('src', role.logoSrc);
              img.setAttribute('alt', role.logoAlt ?? '');
              art.appendChild(img);
            }
            const p = ownerDoc.createElement('p');
            p.textContent = role.role;
            art.appendChild(p);
            grid.appendChild(art);
          });
          root.appendChild(grid);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.6,
        buildSegments: (tl) => {
          tl.addLabel('roles-in', 0.5);
          tl.to({}, { duration: 0.6 + content.roles.length * 0.22 });
        },
      }),
  });
