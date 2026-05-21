// Pulsar L2 chrome — scrub-mode timeline transport controls.
//
// PUL-F017 / ADR-020: "In `mode=scrub`, the runtime SHALL display
// timeline controls allowing the user to scrub forward, backward, and
// to named beats."
//
// This is the workbench-owned transport surface for `mode=scrub`. It is
// a thin view over the live `MasterTimeline` the GSAP composition
// timeline adapter exposes through `createGsapCompositionTimeline({
// onMaster })`: every control drives the master through its public
// transport API (`play` / `pause` / `reverse` / `seek`) and every named
// beat affordance comes from `master.beats()`. The component never
// touches raw GSAP, never parses master-label strings, and never
// reaches into scene DOM (ADR-020 §Boundary).
//
// `src/main.ts` builds one instance at bootstrap, mounts it into the
// workbench chrome surface, and `attach()`es a master whenever a
// `mode=scrub` navigation activates one. The controls are hidden until
// attached, so they only ever appear under `mode=scrub`.
//
// Mount lifecycle:
//
//     const scrub = createScrubControls({ ownerDocument: document, parent: chromeSurface });
//     scrub.attach(master);  // mode=scrub navigation → controls appear
//     scrub.sync();          // refresh the playhead readout (per frame)
//     scrub.detach();        // navigation left scrub → controls hide
//     scrub.dispose();       // workbench teardown

import type { MasterTimeline } from '../../runtime/timeline';

/** Format `seconds` as `m:ss` for the transport readout. Negative clamps to 0. */
export const formatScrubTime = (seconds: number): string => {
  const t = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

/** Inputs to {@link createScrubControls}. */
export interface ScrubControlsHost {
  /** Document used to allocate the control DOM (threaded so tests pass a fake). */
  readonly ownerDocument: Document;
  /** Element the control bar mounts into — the workbench chrome surface. */
  readonly parent: HTMLElement;
}

/** The handle {@link createScrubControls} returns. */
export interface ScrubControlsHandle {
  /** The mounted control-bar element. */
  readonly element: HTMLElement;
  /**
   * Bind the controls to a live master timeline and reveal them. Called
   * once per `mode=scrub` navigation with the master the GSAP adapter
   * reported through `onMaster`. Re-binding replaces any prior master.
   */
  attach(master: MasterTimeline): void;
  /**
   * Unbind from the current master and hide the controls. Called when a
   * navigation leaves `mode=scrub` (or aborts) so the controls never
   * drive a stale master.
   */
  detach(): void;
  /**
   * Refresh the playhead readout (scrub position + time + play/pause
   * state) from the bound master. Cheap and idempotent; `src/main.ts`
   * calls it once per animation frame so the readout tracks playback.
   * Inert when no master is attached or while the user is scrubbing.
   */
  sync(): void;
  /** Remove the control bar from the workbench. Idempotent; inert afterwards. */
  dispose(): void;
}

const BEAT_ATTR = 'data-pulsar-scrub-beat';

/** Build a transport `<button>` with an accessible label. */
const transportButton = (
  doc: Document,
  className: string,
  label: string,
  glyph: string,
): HTMLButtonElement => {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = className;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.textContent = glyph;
  return button;
};

interface ScrubDom {
  readonly root: HTMLElement;
  readonly reverse: HTMLButtonElement;
  readonly playPause: HTMLButtonElement;
  readonly seek: HTMLInputElement;
  readonly time: HTMLElement;
  readonly beats: HTMLElement;
}

/** Allocate the scrub control-bar DOM. */
const buildScrubDom = (doc: Document): ScrubDom => {
  const root = doc.createElement('div');
  root.className = 'pulsar-scrub';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'timeline scrub controls');
  root.dataset.pulsarScrub = 'controls';
  root.hidden = true;

  const reverse = transportButton(
    doc,
    'pulsar-scrub__btn pulsar-scrub__reverse',
    'scrub backward',
    '◀◀',
  );
  const playPause = transportButton(doc, 'pulsar-scrub__btn pulsar-scrub__play', 'play', '▶');

  const seek = doc.createElement('input');
  seek.type = 'range';
  seek.className = 'pulsar-scrub__seek';
  seek.min = '0';
  seek.max = '0';
  seek.step = 'any';
  seek.value = '0';
  seek.setAttribute('aria-label', 'timeline position');

  const time = doc.createElement('span');
  time.className = 'pulsar-scrub__time';
  time.textContent = `${formatScrubTime(0)} / ${formatScrubTime(0)}`;

  const beats = doc.createElement('div');
  beats.className = 'pulsar-scrub__beats';
  beats.setAttribute('role', 'group');
  beats.setAttribute('aria-label', 'named beats');

  root.append(reverse, playPause, seek, time, beats);
  return { root, reverse, playPause, seek, time, beats };
};

/**
 * Build the workbench scrub-mode transport controls (PUL-F017 /
 * ADR-020).
 */
export const createScrubControls = (host: ScrubControlsHost): ScrubControlsHandle => {
  const doc = host.ownerDocument;
  const dom = buildScrubDom(doc);
  host.parent.appendChild(dom.root);

  let master: MasterTimeline | null = null;
  let disposed = false;
  // While the user drags the seek slider, `sync()` must not fight the
  // drag by writing the playhead position back onto the input.
  let scrubbing = false;

  /** Refresh the play/pause button + numeric readout from the master. */
  const renderReadout = (): void => {
    if (master === null) return;
    const paused = master.isPaused();
    dom.playPause.textContent = paused ? '▶' : '❚❚';
    dom.playPause.setAttribute('aria-label', paused ? 'play' : 'pause');
    dom.playPause.title = paused ? 'play' : 'pause';
    if (!scrubbing) dom.seek.value = String(master.time());
    dom.time.textContent = `${formatScrubTime(master.time())} / ${formatScrubTime(master.duration())}`;
  };

  /** Rebuild the named-beat jump buttons from `master.beats()`. */
  const renderBeats = (): void => {
    dom.beats.replaceChildren();
    if (master === null) return;
    for (const beat of master.beats()) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'pulsar-scrub__beat';
      button.dataset.pulsarScrubBeat = beat.name;
      button.setAttribute(BEAT_ATTR, beat.name);
      button.textContent = beat.label;
      button.title = `jump to beat "${beat.label}" (${formatScrubTime(beat.time)})`;
      button.setAttribute('aria-label', `jump to beat ${beat.label}`);
      button.addEventListener('click', () => {
        if (disposed || master === null) return;
        master.seek(beat.name);
        renderReadout();
      });
      dom.beats.appendChild(button);
    }
  };

  // --- transport wiring (one-time; reads the live `master`) ----------
  dom.playPause.addEventListener('click', () => {
    if (disposed || master === null) return;
    if (master.isPaused()) master.play();
    else master.pause();
    renderReadout();
  });
  dom.reverse.addEventListener('click', () => {
    if (disposed || master === null) return;
    master.reverse();
    renderReadout();
  });
  dom.seek.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  const endScrub = (): void => {
    scrubbing = false;
  };
  dom.seek.addEventListener('pointerup', endScrub);
  dom.seek.addEventListener('blur', endScrub);
  dom.seek.addEventListener('input', () => {
    if (disposed || master === null) return;
    const position = Number(dom.seek.value);
    if (Number.isFinite(position)) master.seek(position);
    renderReadout();
  });

  return {
    element: dom.root,
    attach(next: MasterTimeline): void {
      if (disposed) return;
      master = next;
      scrubbing = false;
      dom.seek.max = String(next.duration());
      dom.seek.value = String(next.time());
      renderBeats();
      renderReadout();
      dom.root.hidden = false;
    },
    detach(): void {
      if (disposed) return;
      master = null;
      scrubbing = false;
      dom.root.hidden = true;
      dom.beats.replaceChildren();
    },
    sync(): void {
      if (disposed || master === null || dom.root.hidden) return;
      renderReadout();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      master = null;
      dom.root.remove();
    },
  };
};
