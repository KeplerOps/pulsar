// Pulsar L2 transitions — cut.
//
// No-op transition. Consumes zero master-time. The default between
// scenes when a composition entry has no `behavior.transition` is
// also a cut (the composer simply does not call the registry), so
// this is mostly here for explicit-cut declarations.

import type { Transition, TransitionContext } from '../../runtime/timeline';

export const cut: Transition = {
  name: 'cut',
  defaultDurationMs: 0,
  insert(_ctx: TransitionContext): number {
    return 0;
  },
};
