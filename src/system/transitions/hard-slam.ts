// Pulsar L2 transitions — hard slam.
//
// White flash → cut. Master-time consumed is short (default 180ms):
// snap overlay to white, hold 1 frame, snap back to transparent.

import type { Transition, TransitionContext } from '../../runtime/timeline';

export const hardSlam: Transition = {
  name: 'hard-slam',
  defaultDurationMs: 180,
  insert(ctx: TransitionContext): number {
    if (ctx.overlay === null) return 0;
    const seconds = ctx.durationMs / 1000;
    const hold = seconds / 3;
    ctx.master.set(
      ctx.overlay,
      { opacity: 0, backgroundColor: '#ffffff', display: 'block' },
      ctx.insertAt,
    );
    ctx.master.to(ctx.overlay, { opacity: 1, duration: hold, ease: 'power3.in' }, ctx.insertAt);
    ctx.master.to(
      ctx.overlay,
      { opacity: 0, duration: seconds - hold, ease: 'power3.out' },
      ctx.insertAt + hold,
    );
    ctx.master.set(ctx.overlay, { display: 'none' }, ctx.insertAt + seconds);
    return seconds;
  },
};
