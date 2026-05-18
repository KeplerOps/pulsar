// Pulsar L2 — prompter window helper.
//
// `openPrompterWindow(url)` spawns a separate browser window booted
// in `mode=prompter`. The runtime's existing `renderPrompter` adapter
// in the spawned window receives the prompter script and renders it
// (the L2 system layer ships a default renderer below that upgrades
// the placeholder in `src/main.ts`).
//
// Because pulsar already has end-to-end prompter wiring (loader-side
// lifecycle bypass + buildPrompterScript caption aggregation), the
// prompter window just needs to open the same URL with mode=prompter.

import type { PrompterRenderer, PrompterScript } from '../../runtime/prompter';

/**
 * Open a new browser window pointed at the current composition in
 * `mode=prompter`. The caller passes the current `?composition=` or
 * `?scene=` URL parameters (without the mode override); this helper
 * appends `mode=prompter` and opens it.
 */
export const openPrompterWindow = (
  baseUrl: string,
  features = 'width=900,height=700,menubar=no,toolbar=no',
): Window | null => {
  const url = baseUrl.includes('mode=')
    ? baseUrl.replace(/mode=[^&]*/, 'mode=prompter')
    : baseUrl.includes('?')
      ? `${baseUrl}&mode=prompter`
      : `${baseUrl}?mode=prompter`;
  return globalThis.window?.open(url, '_blank', features) ?? null;
};

/**
 * A non-trivial `PrompterRenderer` that renders the full prompter
 * script into the workbench chrome's lower-third slot (or a fallback
 * `<aside>`). Used by `src/main.ts` to replace the placeholder
 * renderer when the chrome slot is available.
 *
 * The renderer mounts a panel and returns a cleanup callback the
 * loader invokes on next navigation.
 */
export const createChromePrompterRenderer =
  (target: HTMLElement | (() => HTMLElement | null)): PrompterRenderer =>
  (script: PrompterScript) => {
    const resolved = typeof target === 'function' ? target() : target;
    if (resolved === null) return undefined;
    const doc = resolved.ownerDocument;
    const panel = doc.createElement('section');
    panel.className = 'pulsar-prompter';
    panel.setAttribute(
      'style',
      'position: fixed; inset: var(--pulsar-space-letterbox) 0; z-index: var(--pulsar-z-hud); padding: var(--pulsar-space-xl); background: var(--pulsar-color-bg-deep); color: var(--pulsar-color-fg-white); font-family: var(--pulsar-type-mono); font-size: var(--pulsar-type-body-size); line-height: 1.5; overflow-y: auto;',
    );
    const h = doc.createElement('h1');
    h.textContent = `Prompter — ${script.composition?.id ?? 'scene'}`;
    h.setAttribute(
      'style',
      'font-family: var(--pulsar-type-display); margin: 0 0 var(--pulsar-space-lg); color: var(--pulsar-color-accent-cyan); font-size: var(--pulsar-type-h3-size); text-transform: uppercase;',
    );
    panel.appendChild(h);
    for (const entry of script.entries) {
      const section = doc.createElement('section');
      section.setAttribute('style', 'margin-bottom: var(--pulsar-space-xl);');
      const title = doc.createElement('h2');
      title.textContent = `${entry.sceneId} — ${entry.title}`;
      title.setAttribute(
        'style',
        'font-family: var(--pulsar-type-sans); font-size: var(--pulsar-type-h3-size); color: var(--pulsar-color-fg-faint); margin: 0 0 var(--pulsar-space-md);',
      );
      section.appendChild(title);
      for (const c of entry.captions) {
        const line = doc.createElement('p');
        const at = typeof c.at === 'string' ? c.at : `${c.at}ms`;
        line.textContent = `[${at}] ${c.text}`;
        line.setAttribute('style', 'margin: 4px 0;');
        section.appendChild(line);
      }
      panel.appendChild(section);
    }
    resolved.appendChild(panel);
    return () => {
      panel.remove();
    };
  };
