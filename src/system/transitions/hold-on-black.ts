// Pulsar L2 transitions — hold on black.
//
// Fade to black, hold for the bulk of the duration, fade up. Used
// for dramatic act-break beats. Master-time consumed equals
// `durationMs` (200ms down + hold + 200ms up).

import type { Transition, TransitionContext } from '../../runtime/timeline';

export const holdOnBlack: Transition = {
  name: 'hold-on-black',
  defaultDurationMs: 1400,
  insert(ctx: TransitionContext): number {
    if (ctx.overlay === null) return 0;
    const seconds = ctx.durationMs / 1000;
    const fade = 0.2; // 200ms each way
    const hold = Math.max(0, seconds - fade * 2);
    ctx.master.set(
      ctx.overlay,
      { opacity: 0, backgroundColor: '#000000', display: 'block' },
      ctx.insertAt,
    );
    ctx.master.to(ctx.overlay, { opacity: 1, duration: fade, ease: 'power2.inOut' }, ctx.insertAt);
    ctx.master.to(ctx.overlay, { opacity: 1, duration: hold, ease: 'none' }, ctx.insertAt + fade);
    ctx.master.to(
      ctx.overlay,
      { opacity: 0, duration: fade, ease: 'power2.inOut' },
      ctx.insertAt + fade + hold,
    );
    ctx.master.set(ctx.overlay, { display: 'none' }, ctx.insertAt + seconds);
    return seconds;
  },
};
