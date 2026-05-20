// Pulsar L2 — fade lifecycle helpers.
//
// `fadeInCenter` is the canonical centerpiece swap: remove the `.show`
// class to fade out, wait for the CSS transition to settle, set new
// content, double-rAF, then re-add `.show` so the freshly-set
// children get a real CSS transition (not skipped because the class
// was added in the same frame the content was set).
//
// `fadeOutAudio` ramps an `HTMLAudioElement.volume` down to zero over
// `durationMs` using rAF, then pauses + resets the volume so a later
// `play()` re-starts at the configured baseline.
//
// PUL-Q001 disclaimer: these helpers use `setTimeout`,
// `requestAnimationFrame`, `performance.now`, and `Date.now` for
// authoring-time pacing. Screenshot mode silences audio and pauses
// the master timeline at frame 0 before scene-level helpers ever
// run, so the nondeterministic primitives below cannot affect a
// captured frame. Per-call `// PUL-Q001-allow:` exemptions document
// the same reasoning where the source-policy scan touches them.

export interface FadeInCenterOptions {
  /** ms to wait for the exit transition before swapping content. Defaults to 380. */
  readonly exitMs?: number;
  /** Optional dwell on the dark/empty frame between exit and entry. */
  readonly darkBeatMs?: number;
}

/**
 * Cross-fade `center`'s HTML content. Removes the `.show` class so the
 * existing CSS transition fades it out, waits `exitMs`, swaps in the
 * new `html`, double-rAFs so the new children are laid out, then adds
 * `.show` back. An optional `darkBeatMs` dwell holds on the empty
 * frame between exit and entry for dramatic effect.
 *
 * `center` must be an element with `classList` and `innerHTML`. Does
 * not require GSAP — pure CSS transitions.
 */
export const fadeInCenter = async (
  center: { classList: DOMTokenList; innerHTML: string },
  html: string,
  opts: FadeInCenterOptions = {},
): Promise<void> => {
  const exitMs = opts.exitMs ?? 380;
  const darkBeatMs = opts.darkBeatMs;
  center.classList.remove('show');
  await new Promise<void>((r) => setTimeout(r, exitMs)); // PUL-Q001-allow: authoring-time CSS-transition wait; helper never runs under mode=screenshot.
  center.innerHTML = html;
  await new Promise<void>((r) => {
    // Double rAF: first frame paints the new innerHTML; second frame
    // is the one where adding .show triggers a real CSS transition.
    const second = (): void => {
      center.classList.add('show');
      r();
    };
    const first = (): void => {
      requestAnimationFrame(second); // PUL-Q001-allow: double-rAF settle for CSS-transition kickoff; helper never runs under mode=screenshot.
    };
    requestAnimationFrame(first); // PUL-Q001-allow: double-rAF settle for CSS-transition kickoff; helper never runs under mode=screenshot.
  });
  if (darkBeatMs !== undefined) {
    await new Promise<void>((r) => setTimeout(r, darkBeatMs)); // PUL-Q001-allow: authoring-time dwell; helper never runs under mode=screenshot.
  }
};

/**
 * Ramp `audio.volume` from its current value to zero over `durationMs`
 * using rAF, then `audio.pause()` and restore the original volume so a
 * future `play()` starts from the same baseline. Resolves when the
 * ramp completes or when `signal` fires (in which case the audio is
 * paused immediately at its current volume, then volume is restored).
 *
 * Used by scenes that hold an ambient audio bed for the duration of
 * the scene and need to silence it cleanly on advance.
 */
export const fadeOutAudio = (
  audio: HTMLAudioElement,
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted === true) {
    audio.pause();
    return Promise.resolve();
  }
  const startVol = audio.volume;
  const now = (): number => {
    const hasPerf = typeof performance !== 'undefined' && typeof performance.now === 'function'; // PUL-Q001-allow: audio-ramp clock selection; audio is silenced under mode=screenshot before this helper runs.
    if (hasPerf) {
      return performance.now(); // PUL-Q001-allow: audio-ramp elapsed time; see selection guard above.
    }
    return Date.now(); // PUL-Q001-allow: audio-ramp elapsed time fallback; see selection guard above.
  };
  const startTs = now();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      audio.pause();
      audio.volume = startVol;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => finish();
    signal?.addEventListener('abort', onAbort, { once: true });
    const tick = (): void => {
      if (done) return;
      const elapsed = now() - startTs;
      if (elapsed >= durationMs) {
        audio.volume = 0;
        finish();
        return;
      }
      const t = elapsed / durationMs;
      audio.volume = Math.max(0, startVol * (1 - t));
      requestAnimationFrame(tick); // PUL-Q001-allow: rAF-driven audio ramp; never runs under mode=screenshot.
    };
    requestAnimationFrame(tick); // PUL-Q001-allow: rAF-driven audio ramp; never runs under mode=screenshot.
  });
};
