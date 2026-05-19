// Pulsar L2 template — incidentPlate.
//
// Image-backed plate: background image (optional) + scrim + bottom-
// left plate with eyebrow time + headline + optional subtitle. The
// canonical "incident at TIME — HEADLINE" shape for cinematic decks
// that walk an audience through a timeline of beats. Used 6× in the
// reference cinematic deck (one per incident moment).

import type { SceneModule } from '../../runtime/scene';
import { buildTemplateScene, buildTemplateTimeline, mountTemplateRoot } from './_shared';

export interface IncidentPlateContent {
  /** Eyebrow timestamp text (e.g. `7:31 PM`, `02:18:14`). */
  readonly time: string;
  /** Hero headline — short, all-caps friendly. */
  readonly headline: string;
  /** Optional sub-paragraph beneath the headline. */
  readonly sub?: string;
  /** Optional background image path (loaded via `assets`). */
  readonly bgSrc?: string;
  /** Optional alt text for the background image. */
  readonly bgAlt?: string;
}

export const incidentPlate = (id: string, content: IncidentPlateContent): SceneModule =>
  buildTemplateScene({
    id,
    title: `Incident plate — ${content.time} — ${content.headline}`,
    captions: [{ at: 'plate-in', text: `${content.time} — ${content.headline}` }],
    assets: content.bgSrc !== undefined ? [content.bgSrc] : [],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'incident-plate',
        buildChildren: (root, ownerDoc) => {
          if (content.bgSrc !== undefined) {
            const bg = ownerDoc.createElement('div');
            bg.setAttribute('class', 'incident-plate__bg');
            bg.setAttribute('style', `background-image: url(${content.bgSrc})`);
            if (content.bgAlt !== undefined) bg.setAttribute('aria-label', content.bgAlt);
            root.appendChild?.(bg);
          }
          const scrim = ownerDoc.createElement('div');
          scrim.setAttribute('class', 'incident-plate__scrim');
          scrim.setAttribute('aria-hidden', 'true');
          root.appendChild?.(scrim);
          const plate = ownerDoc.createElement('div');
          plate.setAttribute('class', 'incident-plate__plate');
          const eyebrow = ownerDoc.createElement('p');
          eyebrow.setAttribute('class', 'incident-plate__time');
          eyebrow.textContent = content.time;
          plate.appendChild?.(eyebrow);
          const headline = ownerDoc.createElement('h2');
          headline.setAttribute('class', 'incident-plate__headline');
          headline.textContent = content.headline;
          plate.appendChild?.(headline);
          if (content.sub !== undefined) {
            const sub = ownerDoc.createElement('p');
            sub.setAttribute('class', 'incident-plate__sub');
            sub.textContent = content.sub;
            plate.appendChild?.(sub);
          }
          root.appendChild?.(plate);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 1.6,
        buildSegments: (tl) => {
          tl.addLabel('plate-in', 0);
          tl.to({}, { duration: 2.4 });
        },
      }),
  });
