// Pulsar L2 chrome — live counter overlay primitive.
//
// Used by terminal scenes (please-hack-style) and any scene that
// needs to show a ticking elapsed time while a long action runs.
// Deterministic: tick / freeze / fast-forward are explicit method
// calls, not wall-clock reads, so screenshot mode and master pause
// behave predictably.
//
// Two pieces: the numeric counter and an optional "FAST-FORWARD"
// indicator that fades in when the master speed leaves 1.0.
//
// Mount lifecycle:
//
//     const counter = createCounter({ ownerDocument: document, parent: stage });
//     counter.tick(45);       // shows 00:00:45
//     counter.setSpeed(2.5);  // shows ►► 2.5x
//     counter.freeze();       // pauses the visual update
//     counter.stop();         // detaches the element

/** Format `totalSeconds` as `HH:MM:SS`. Negative inputs clamp to 0. */
export const formatHms = (totalSeconds: number): string => {
  const t = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export interface CounterHost {
  readonly ownerDocument: Document;
  readonly parent: HTMLElement;
  /** Position preset. Default `'bottom-right'`. */
  readonly position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Label text (e.g. `"elapsed"`). Optional. */
  readonly label?: string;
}

export interface CounterHandle {
  /** The mounted element (for tests / chrome integration). */
  readonly element: HTMLElement;
  /** Render the counter at `totalSeconds`. */
  tick(totalSeconds: number): void;
  /** Hide the speed indicator and keep the last numeric value showing. */
  freeze(): void;
  /** Show / update the fast-forward indicator (e.g. `2.5` → `►► 2.5x`). */
  setSpeed(multiplier: number): void;
  /** Detach from the parent. Idempotent. */
  stop(): void;
}

const POSITION_STYLES: Readonly<Record<NonNullable<CounterHost['position']>, string>> = {
  'top-left': 'top: clamp(20px, 3vh, 60px); left: clamp(20px, 3vw, 60px);',
  'top-right': 'top: clamp(20px, 3vh, 60px); right: clamp(20px, 3vw, 60px);',
  'bottom-left': 'bottom: clamp(20px, 3vh, 60px); left: clamp(20px, 3vw, 60px);',
  'bottom-right': 'bottom: clamp(20px, 3vh, 60px); right: clamp(20px, 3vw, 60px);',
};

/**
 * Mount a live counter into `parent`. Tick / setSpeed are explicit
 * calls so the chrome surface stays deterministic — no
 * `performance.now()` ride-along, no rAF loop owned by the counter.
 * A scene that wants the counter to advance with wall-clock time can
 * use a GSAP `to(counter, { totalSeconds: 0, duration: N, onUpdate: ... })`
 * tween, which inherits master speed / pause for free.
 */
export const createCounter = (host: CounterHost): CounterHandle => {
  const { ownerDocument, parent } = host;
  const position = host.position ?? 'bottom-right';
  const root = ownerDocument.createElement('div');
  root.className = 'pulsar-counter';
  root.setAttribute(
    'style',
    `position: absolute; ${POSITION_STYLES[position]} pointer-events: none; z-index: var(--pulsar-z-hud, 70); font-family: var(--pulsar-type-mono, monospace); color: var(--pulsar-color-fg-soft, #fff); text-align: right;`,
  );
  if (host.label !== undefined) {
    const lbl = ownerDocument.createElement('div');
    lbl.className = 'pulsar-counter__label';
    lbl.textContent = host.label;
    lbl.setAttribute(
      'style',
      'font-size: clamp(12px, 0.9vw, 16px); letter-spacing: 0.16em; text-transform: uppercase; color: var(--pulsar-color-fg-faint, rgba(255,255,255,0.42)); margin-bottom: 4px;',
    );
    root.appendChild(lbl);
  }
  const value = ownerDocument.createElement('div');
  value.className = 'pulsar-counter__value';
  value.setAttribute(
    'style',
    'font-size: clamp(20px, 1.8vw, 32px); font-variant-numeric: tabular-nums; line-height: 1;',
  );
  value.textContent = formatHms(0);
  root.appendChild(value);

  const speed = ownerDocument.createElement('div');
  speed.className = 'pulsar-counter__speed';
  speed.setAttribute(
    'style',
    'opacity: 0; transition: opacity 220ms ease-out; margin-top: 6px; font-size: clamp(13px, 1.05vw, 18px); color: var(--pulsar-color-accent-cyan, #7df5ff); letter-spacing: 0.06em;',
  );
  speed.textContent = '';
  root.appendChild(speed);

  parent.appendChild(root);

  let stopped = false;
  return {
    element: root,
    tick: (totalSeconds) => {
      if (stopped) return;
      value.textContent = formatHms(totalSeconds);
    },
    freeze: () => {
      if (stopped) return;
      speed.style.opacity = '0';
    },
    setSpeed: (multiplier) => {
      if (stopped) return;
      if (Math.abs(multiplier - 1) < 0.01) {
        speed.style.opacity = '0';
        return;
      }
      speed.textContent = `►► ${multiplier.toFixed(1)}x`;
      speed.style.opacity = '1';
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      root.remove();
    },
  };
};
