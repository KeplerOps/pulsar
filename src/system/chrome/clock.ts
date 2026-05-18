// Pulsar L2 chrome — elapsed clock overlay.
//
// Port of the demo_thoughts `clock` object. The clock element is
// mounted into an explicit parent (typically `slots.stage` or
// `document.body`) and ticks every 250ms. Scenes that need
// fast-forward / time re-anchoring (e.g., simulated terminal speed-
// ups) read/write `state.startTs` directly between control calls —
// the returned handle exposes it.

export interface ClockHost {
  readonly ownerDocument: Document;
  readonly parent: ParentNode;
}

/**
 * Mutable handle for an active clock. The state fields are exposed
 * intentionally so a scene driving fast-forward semantics can
 * re-anchor `startTs` to simulate accelerated elapsed time.
 */
export interface ClockHandle {
  readonly element: HTMLElement;
  /** Wall-clock anchor (ms). Scenes that fast-forward set this back to simulate elapsed jumps. */
  startTs: number;
  /** Stop the ticker but leave the element on screen at the current value. */
  freeze(): void;
  /** Remove the element and stop the ticker. Idempotent. */
  stop(): void;
  /** Re-render the displayed value once (called automatically every 250ms while live). */
  tick(): void;
}

const PAD = (n: number): string => String(n).padStart(2, '0');

const now = (): number => {
  const hasPerf = typeof performance !== 'undefined' && typeof performance.now === 'function'; // PUL-Q001-allow: elapsed-clock wall-time selector; clock overlay never appears in mode=screenshot.
  if (hasPerf) {
    return performance.now(); // PUL-Q001-allow: elapsed-clock wall time; clock overlay never appears in mode=screenshot.
  }
  return Date.now(); // PUL-Q001-allow: elapsed-clock wall-time fallback; clock overlay never appears in mode=screenshot.
};

/**
 * Mount and start the elapsed clock. Returns a handle for control.
 */
export const startClock = (host: ClockHost): ClockHandle => {
  const { ownerDocument, parent } = host;
  const el = ownerDocument.createElement('div');
  el.className = 'ph-clock';
  el.innerHTML = `
    <span class="ph-clock__label">Elapsed</span>
    <span class="ph-clock__time">
      <span class="ph-clock__min">00</span><span class="ph-clock__col">:</span><span class="ph-clock__sec">00</span>
    </span>
  `;
  parent.appendChild(el);

  const handle: ClockHandle = {
    element: el,
    startTs: now(),
    freeze: () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    },
    stop: () => {
      handle.freeze();
      el.remove();
    },
    tick: () => {
      const total = Math.floor((now() - handle.startTs) / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      const minEl = el.querySelector('.ph-clock__min');
      const secEl = el.querySelector('.ph-clock__sec');
      if (minEl !== null) minEl.textContent = PAD(m);
      if (secEl !== null) secEl.textContent = PAD(s);
    },
  };

  handle.tick();
  let interval: ReturnType<typeof setInterval> | null = setInterval(handle.tick, 250); // PUL-Q001-allow: elapsed-clock ticker; clock overlay never appears in mode=screenshot.
  return handle;
};
