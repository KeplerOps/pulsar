// Pulsar L2 transitions — dissolve.
//
// Cross-fade by tweening a black overlay up to full opacity, holding
// briefly, then back to transparent. The outgoing scene's last frame
// is visible on the way to black; the incoming scene's first frame
// is visible on the way back. Master-time consumed equals
// `durationMs` (half up, half down).

import type { Transition, TransitionContext } from '../../runtime/timeline';

export const dissolve: Transition = {
  name: 'dissolve',
  defaultDurationMs: 500,
  insert(ctx: TransitionContext): number {
    if (ctx.overlay === null) return 0;
    const seconds = ctx.durationMs / 1000;
    const half = seconds / 2;
    ctx.master.set(
      ctx.overlay,
      { opacity: 0, backgroundColor: '#000000', display: 'block' },
      ctx.insertAt,
    );
    ctx.master.to(ctx.overlay, { opacity: 1, duration: half, ease: 'power2.inOut' }, ctx.insertAt);
    ctx.master.to(
      ctx.overlay,
      { opacity: 0, duration: half, ease: 'power2.inOut' },
      ctx.insertAt + half,
    );
    return seconds;
  },
};
