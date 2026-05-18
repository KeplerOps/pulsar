// Pulsar L2 transitions — push.
//
// Directional slide-in via the overlay. Tweens the overlay's
// `transform: translateX` from -100% → 0 (left-to-right) during the
// first half (covering the outgoing scene) then 0 → 100% during the
// second half (revealing the incoming scene). Master-time consumed
// equals `durationMs`.

import type { Transition, TransitionContext } from '../../runtime/timeline';

export const push: Transition = {
  name: 'push',
  defaultDurationMs: 600,
  insert(ctx: TransitionContext): number {
    if (ctx.overlay === null) return 0;
    const seconds = ctx.durationMs / 1000;
    const half = seconds / 2;
    ctx.master.set(
      ctx.overlay,
      {
        opacity: 1,
        backgroundColor: '#0a0a0d',
        display: 'block',
        x: '-100%',
      },
      ctx.insertAt,
    );
    ctx.master.to(ctx.overlay, { x: '0%', duration: half, ease: 'power3.out' }, ctx.insertAt);
    ctx.master.to(
      ctx.overlay,
      { x: '100%', duration: half, ease: 'power3.in' },
      ctx.insertAt + half,
    );
    ctx.master.set(ctx.overlay, { x: '0%' }, ctx.insertAt + seconds);
    return seconds;
  },
};
