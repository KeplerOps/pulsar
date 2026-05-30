// Presenter transport — PUL-F020 / PUL-F021 (DRAFT) / ADR-024.
//
// The opt-in seam that translates presenter commands into master-timeline
// transport actions. It is wired ONLY on the `mode=present` composition
// path (`createGsapCompositionTimeline` calls {@link wirePresenterCommands}
// when, and only when, the run input carries a `presenter` controller).
// A non-present navigation never reaches this module, so the always-on
// composition path in `timeline.ts` carries none of this state machine.
//
// ADR-024 *Cross-command precedence* is the binding contract: an explicit
// PUL-F021 `pause` is distinct from a PUL-F020 beat `hold` and a GSAP
// `addPause` advance-gate. GSAP exposes only a single `paused()` bit, so
// the runner keeps the three apart with the private {@link PresenterTransportState}.
//
// References:
//  - PUL-F020 — advance / hold / skip-forward / skip-backward under
//    `mode=present`; beat progression interruptible without breaking
//    timeline state.
//  - PUL-F021 — pause the active timeline / resume from the same point.
//  - ADR-024 — presenter pause/resume precedence: only `resume`
//    unfreezes an explicit pause; a beat-pacing command never does.

import type { CompositionTimelineRunOptions } from './composition-resolver';
import { type MasterSegment, type MasterTimeline, segmentIndexAtTime } from './timeline';

/**
 * Per-activation presenter transport state, held inside the
 * {@link wirePresenterCommands} closure (fresh per navigation). GSAP
 * exposes only a single `paused()` bit, which is not a sufficient state
 * model: a PUL-F020 beat `hold`, a GSAP `addPause` advance-gate, and an
 * explicit PUL-F021 `pause` all read as "paused" but compose
 * differently. ADR-024 *Cross-command precedence* requires the runner to
 * keep them apart; these flags are that private state, scoped to the
 * present-mode transport — not URL, loader, scene, or storage state.
 */
interface PresenterTransportState {
  /** A PUL-F020 beat `hold` is engaged. */
  held: boolean;
  /** A PUL-F021 transport `pause` freeze is engaged. */
  explicitlyPaused: boolean;
  /** Current scene segment cursor in the active composition slice. */
  activeSegmentIndex: number;
}

/**
 * Release a beat hold (or a GSAP `addPause` advance-gate), or — when
 * playing — seek forward to the next authored beat label OR next segment
 * boundary, whichever is closer (ADR-024). Dropped while explicitly
 * paused: a beat-pacing command never unfreezes a PUL-F021 pause.
 */
function presenterAdvance(
  master: MasterTimeline,
  segments: readonly MasterSegment[],
  state: PresenterTransportState,
  onSegmentChange: (segment: MasterSegment) => void,
): void {
  // ADR-024: a beat-pacing command received while explicitly paused
  // MUST NOT resume playback — drop it; the frozen playhead stays put.
  if (state.explicitlyPaused) return;
  state.held = false;
  if (master.isPaused()) {
    // Release the beat hold (or a GSAP addPause advance-gate).
    master.play();
    return;
  }
  const now = master.time();
  const beatTimes = master.beats().map((b) => b.time);
  const nextBeat = beatTimes.filter((t) => t > now + 0.05).sort((a, b) => a - b)[0];
  const nextSegment = segments.find((s) => s.time > now + 0.05);
  if (nextBeat === undefined && nextSegment === undefined) return;
  if (nextSegment !== undefined && (nextBeat === undefined || nextSegment.time <= nextBeat)) {
    master.seek(nextSegment.time);
    state.activeSegmentIndex = nextSegment.index;
    onSegmentChange(nextSegment);
    return;
  }
  if (nextBeat !== undefined) {
    master.seek(nextBeat);
    state.activeSegmentIndex = segmentIndexAtTime(segments, nextBeat);
  }
}

/**
 * Shared skip body: seek to `target`, report the new active segment,
 * then — unless an explicit PUL-F021 pause is in effect — release any
 * beat hold and resume playback. ADR-024 permits skip to move the frozen
 * playhead while paused (presenter scrubbing), but it must not resume.
 */
function presenterSkip(
  master: MasterTimeline,
  state: PresenterTransportState,
  target: MasterSegment | undefined,
  onSegmentChange: (segment: MasterSegment) => void,
): void {
  if (target === undefined) return;
  master.seek(target.time);
  state.activeSegmentIndex = target.index;
  onSegmentChange(target);
  if (state.explicitlyPaused) return;
  state.held = false;
  if (master.isPaused()) master.play();
}

function presenterSkipForward(
  master: MasterTimeline,
  segments: readonly MasterSegment[],
  state: PresenterTransportState,
  onSegmentChange: (segment: MasterSegment) => void,
): void {
  state.activeSegmentIndex = segmentIndexAtTime(segments, master.time());
  const targetIndex = Math.min(state.activeSegmentIndex + 1, segments.length - 1);
  presenterSkip(master, state, segments[targetIndex], onSegmentChange);
}

function presenterSkipBackward(
  master: MasterTimeline,
  segments: readonly MasterSegment[],
  state: PresenterTransportState,
  onSegmentChange: (segment: MasterSegment) => void,
): void {
  state.activeSegmentIndex = segmentIndexAtTime(segments, master.time());
  const targetIndex = Math.max(state.activeSegmentIndex - 1, 0);
  presenterSkip(master, state, segments[targetIndex], onSegmentChange);
}

/**
 * Translate one {@link import('./presenter').PresenterCommand} into a
 * master-timeline transport action. ADR-024 *Cross-command precedence*
 * is the binding contract:
 *
 *  - `hold` — engage a PUL-F020 beat hold at the current playhead.
 *    Idempotent; NOT a play/pause toggle.
 *  - `pause` — engage the explicit PUL-F021 transport freeze.
 *  - `resume` — release an explicit `pause` only (a `resume` with no
 *    explicit pause is a no-op); a `resume` that lifts a pause engaged
 *    while a `hold` was active leaves the master held.
 *  - `advance` — release a hold / gate, or seek to the next beat /
 *    segment. Dropped while explicitly paused.
 *  - `skip-forward` / `skip-backward` — seek to the next / previous
 *    segment start. While paused, moves the frozen playhead without
 *    resuming.
 *  - everything else (`toggle-master-mute` / `toggle-practice`) is
 *    audio-owned / L2-owned and ignored here.
 */
function applyPresenterCommandToMaster(
  master: MasterTimeline,
  segments: readonly MasterSegment[],
  state: PresenterTransportState,
  onSegmentChange: (segment: MasterSegment) => void,
  cmd: { readonly kind: string },
): void {
  switch (cmd.kind) {
    case 'hold':
      // Engage a PUL-F020 beat hold. Idempotent — NOT a toggle.
      state.held = true;
      master.pause();
      return;
    case 'pause':
      // Engage the explicit PUL-F021 transport freeze.
      state.explicitlyPaused = true;
      master.pause();
      return;
    case 'resume':
      // ADR-024: only `resume` unfreezes an explicit pause; a `resume`
      // with no explicit pause in effect is a no-op.
      if (!state.explicitlyPaused) return;
      state.explicitlyPaused = false;
      // Restore the snapshotted beat-pacing state: a `hold` engaged
      // before the pause survives the resume — the master stays held.
      if (state.held) return;
      master.play();
      return;
    case 'advance':
      presenterAdvance(master, segments, state, onSegmentChange);
      return;
    case 'skip-forward':
      presenterSkipForward(master, segments, state, onSegmentChange);
      return;
    case 'skip-backward':
      presenterSkipBackward(master, segments, state, onSegmentChange);
      return;
    default:
      return; // toggle-master-mute / toggle-practice / unknown — not master's concern
  }
}

/**
 * Wire the per-navigation presenter controller to master-timeline
 * transport. No-op when the run input carries no presenter controller —
 * so a non-present navigation never instantiates {@link PresenterTransportState}.
 *
 * The controller is signal-bound (per-handler auto-detach on navigation
 * abort), so subscriptions never accumulate across activations.
 */
export function wirePresenterCommands(
  master: MasterTimeline,
  segmentAnchors: readonly MasterSegment[],
  opts: CompositionTimelineRunOptions,
  reportSegmentChange: (segment: MasterSegment) => void,
): void {
  if (opts.presenter === undefined) return;
  const transport: PresenterTransportState = {
    held: false,
    explicitlyPaused: false,
    activeSegmentIndex: segmentIndexAtTime(segmentAnchors, master.time()),
  };
  opts.presenter.subscribe((cmd) => {
    applyPresenterCommandToMaster(master, segmentAnchors, transport, reportSegmentChange, cmd);
  });
}
