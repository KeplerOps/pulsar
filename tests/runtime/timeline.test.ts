import { describe, expect, it } from 'vitest';

import { createTimelineEngine } from '../../src/runtime/timeline';

// Timeline engine — PUL-F022 / ADR-003. Under ADR-032 the runtime no longer
// composes a master timeline; the only surviving surface is the GSAP engine
// handle the workbench threads to scenes as `ctx.gsap`. Scenes author and
// drive their own per-scene timelines through the imperative control plane
// (`spike/control-plane.ts`); that path is covered by
// `scene-control-plane.test.ts`.

const engine = createTimelineEngine();

describe('createTimelineEngine', () => {
  it('exposes the gsap instance scenes receive as ctx.gsap', () => {
    expect(engine.gsap).toBeTruthy();
    expect(engine.gsap.timeline).toBeTypeOf('function');
    expect(engine.gsap.core.Timeline).toBeTypeOf('function');
    const tl = engine.gsap.timeline({ paused: true });
    expect(tl).toBeInstanceOf(engine.gsap.core.Timeline);
    tl.kill();
  });

  it('returns a stable engine handle each call', () => {
    expect(createTimelineEngine().gsap).toBe(createTimelineEngine().gsap);
  });
});
