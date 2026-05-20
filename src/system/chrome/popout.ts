// Pulsar L2 chrome — popout punches.
//
// `firePopout` mounts a center-of-stage text overlay that auto-removes
// after 2600ms. Used for dramatic single-word reveals during terminal
// scenes ("OPEN PORTS", "ROOT FLAG CAPTURED", etc.).

export interface PopoutHost {
  readonly ownerDocument: Document;
  readonly parent: ParentNode;
}

/**
 * Mount a popout overlay with `text`. Auto-removes after 2600ms (matching
 * the CSS keyframe). Returns a handle so a caller can dismiss earlier.
 */
export const firePopout = (host: PopoutHost, text: string): { remove(): void } => {
  const { ownerDocument, parent } = host;
  const wrap = ownerDocument.createElement('div');
  wrap.className = 'ph-popout';
  const txt = ownerDocument.createElement('div');
  txt.className = 'ph-popout__text';
  txt.textContent = text;
  wrap.appendChild(txt);
  parent.appendChild(wrap);
  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    wrap.remove();
  };
  setTimeout(remove, 2600); // PUL-Q001-allow: popout dismissal; popout overlays never appear in mode=screenshot.
  return { remove };
};
