// Pulsar L2 template — metricTicker.
//
// Live-update metrics. Each metric ticks every `tickMs` (default
// 860ms) — `start` increments/decrements by `step` per tick. The
// update interval is started from `create` and torn down by an
// extended cleanup hook.

import type { SceneModule } from '../../runtime/scene';
import { startInterval } from '../helpers';
import {
  buildTemplateScene,
  buildTemplateTimeline,
  cleanupTemplateRoot,
  findTemplateRoot,
  mountTemplateRoot,
} from './_shared';

export interface MetricSpec {
  readonly label: string;
  readonly direction: 'up' | 'down';
  readonly start: number;
  readonly step: number;
  readonly prefix?: string;
  readonly suffix?: string;
}

export interface MetricTickerContent {
  readonly eyebrow?: string;
  readonly title: string;
  readonly metrics: readonly MetricSpec[];
  /** ms between ticks. Defaults to 860. */
  readonly tickMs?: number;
}

const format = (m: MetricSpec, n: number): string => {
  const value = Math.max(0, Math.round(n)).toString();
  return `${m.prefix ?? ''}${value}${m.suffix ?? ''}`;
};

/**
 * Update every `[data-metric]` cell in the ticker scene root with its
 * new computed value. The per-tick DOM update lives in one named
 * helper so the interval callback just schedules it.
 */
const applyTickerFrame = (
  ctx: unknown,
  id: string,
  metrics: readonly MetricSpec[],
  tick: number,
): void => {
  const root = findTemplateRoot(ctx, id);
  if (root === null) return;
  const nodes = root.querySelectorAll<HTMLElement>('[data-metric]');
  let i = 0;
  for (const node of nodes) {
    const idx = node.getAttribute('data-metric');
    const m = metrics[Number(idx ?? i)];
    if (m === undefined) {
      i++;
      continue;
    }
    const delta = m.step * tick;
    const value = m.direction === 'up' ? m.start + delta : m.start - delta;
    node.textContent = format(m, value);
    i++;
  }
};

export const metricTicker = (id: string, content: MetricTickerContent): SceneModule => {
  const tickMs = content.tickMs ?? 860;
  let timer: { stop(): void } | null = null;
  return buildTemplateScene({
    id,
    title: `Metric ticker — ${content.title}`,
    captions: [{ at: 'ticker-in', text: content.title }],
    create: (ctx) => {
      const root = mountTemplateRoot({
        ctx,
        rootValue: id,
        templateKind: 'metric-ticker',
        buildChildren: (rootEl, ownerDoc) => {
          if (content.eyebrow !== undefined) {
            const eb = ownerDoc.createElement('div');
            eb.setAttribute('class', 'eyebrow');
            eb.textContent = content.eyebrow;
            rootEl.appendChild(eb);
          }
          const h = ownerDoc.createElement('h2');
          h.setAttribute('class', 'heading');
          h.textContent = content.title;
          rootEl.appendChild(h);
          const ticker = ownerDoc.createElement('div');
          ticker.setAttribute('class', 'ticker');
          content.metrics.forEach((m, i) => {
            const art = ownerDoc.createElement('article');
            art.setAttribute('class', m.direction);
            art.setAttribute('style', `--metric-delay: ${400 + i * 160}ms`);
            const lab = ownerDoc.createElement('div');
            lab.setAttribute('class', 'label');
            lab.textContent = m.label;
            art.appendChild(lab);
            const val = ownerDoc.createElement('span');
            val.setAttribute('class', 'value');
            val.dataset.metric = String(i);
            val.textContent = format(m, m.start);
            art.appendChild(val);
            const dir = ownerDoc.createElement('span');
            dir.setAttribute('class', 'direction');
            dir.textContent = m.direction === 'up' ? 'Increasing' : 'Decreasing';
            art.appendChild(dir);
            ticker.appendChild(art);
          });
          rootEl.appendChild(ticker);
        },
      });
      if (root === null) return;
      // Start the tick after a brief delay so the scene becomes active first.
      let tick = 0;
      timer = startInterval(() => {
        tick += 1;
        applyTickerFrame(ctx, id, content.metrics, tick);
      }, tickMs);
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: id,
        suffixDurationSeconds: 2,
        buildSegments: (tl) => {
          tl.addLabel('ticker-in', 0.5);
          tl.to({}, { duration: 1 + content.metrics.length * 0.16 });
        },
      }),
    cleanup: (ctx) => {
      if (timer !== null) {
        timer.stop();
        timer = null;
      }
      cleanupTemplateRoot(id)(ctx);
    },
  });
};
