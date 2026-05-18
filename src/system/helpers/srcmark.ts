// Pulsar L2 — source-citation overlay.
//
// `srcMark` mounts a small text overlay onto an owner document. The
// returned object exposes `remove()` so a scene's cleanup can tear it
// down idempotently. Used by scenes that need to cite a quote source,
// dataset, or article reference without crowding the scene root.
//
// Authoring requires an `ownerDocument` (read off `ctx.stage` or any
// scene-allocated element). The hand-rolled demo_thoughts decks
// appended to ambient `document.body`; pulsar requires the explicit
// dependency seam to keep scenes pure of global lookups.

export interface SrcMarkHost {
  /** Document the overlay is allocated in (e.g., `ctx.stage.ownerDocument`). */
  readonly ownerDocument: Document;
  /** Element the overlay is parented under. Typically the scene root or `document.body`. */
  readonly parent: ParentNode;
}

export interface SrcMarkHandle {
  readonly element: HTMLElement;
  remove(): void;
}

/**
 * Mount a `<div class="src-mark">` overlay into `host.parent` with the
 * supplied text. Returns a handle exposing `remove()` for cleanup.
 *
 * The styling for `.src-mark` lives in the chrome pack
 * (`src/system/chrome/chrome.css`); this helper only mounts the
 * marker.
 */
export const srcMark = (host: SrcMarkHost, text: string): SrcMarkHandle => {
  const el = host.ownerDocument.createElement('div');
  el.className = 'src-mark';
  el.textContent = text;
  host.parent.appendChild(el);
  let removed = false;
  return {
    element: el,
    remove: (): void => {
      if (removed) return;
      removed = true;
      el.remove();
    },
  };
};
