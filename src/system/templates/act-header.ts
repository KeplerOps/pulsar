// Pulsar L2 template — actHeader.
//
// Act/section divider with optional Roman numeral. Styled via
// `.pulsar-template--act-header` in templates.css.

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface ActHeaderContent {
  readonly act: string; // typically a Roman numeral like "I", "II"
  readonly section: string;
}

export const actHeader = (id: string, content: ActHeaderContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Act ${content.act} — ${content.section}`,
    captions: [{ at: 'act-header-in', text: `Act ${content.act}: ${content.section}` }],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'act-header',
        buildChildren: (root, ownerDoc) => {
          const rail = ownerDoc.createElement('span');
          rail.setAttribute('class', 'act__rail');
          root.appendChild(rail);
          const num = ownerDoc.createElement('div');
          num.setAttribute('class', 'act__numeral');
          num.textContent = `Act ${content.act}`;
          root.appendChild(num);
          const name = ownerDoc.createElement('h2');
          name.setAttribute('class', 'act__name');
          name.textContent = content.section;
          root.appendChild(name);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.4,
        buildSegments: (tl) => {
          tl.addLabel('act-header-in', 0);
          tl.to({}, { duration: 1.2 });
        },
      }),
  });
