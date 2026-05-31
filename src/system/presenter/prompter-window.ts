// Pulsar L2 — prompter window helper.
//
// `openPrompterWindow(url)` spawns a separate browser window booted in
// `mode=prompter` at the same URL; the spawned window's `renderPrompter`
// adapter (`createChromePrompterRenderer` below) renders the script.

import type { PrompterRenderer, PrompterScript } from '../../runtime/prompter';
import {
  PRESENTER_SESSION_QUERY_PARAM,
  getPresenterSessionId,
  isPresenterSessionId,
} from './bridge';

const DEFAULT_PROMPTER_WINDOW_FEATURES = 'width=900,height=700,menubar=no,toolbar=no';
const POPUP_ISOLATION_FEATURES = ['noopener', 'noreferrer'] as const;

export interface PrompterWindowOptions {
  readonly presenterSessionId?: string;
}

const buildPrompterUrl = (
  baseUrl: string,
  location: Pick<Location, 'href' | 'origin'>,
  presenterSessionId: string,
): string | null => {
  let url: URL;
  try {
    url = new URL(baseUrl, location.href);
  } catch {
    return null;
  }

  if (url.origin !== location.origin) return null;
  url.searchParams.set('mode', 'prompter');
  url.searchParams.set(PRESENTER_SESSION_QUERY_PARAM, presenterSessionId);
  return url.href;
};

const withPopupIsolationFeatures = (features: string): string => {
  const tokens = features
    .split(',')
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0);
  const present = new Set(tokens.map((feature) => feature.toLowerCase()));
  for (const feature of POPUP_ISOLATION_FEATURES) {
    if (!present.has(feature)) tokens.push(feature);
  }
  return tokens.join(',');
};

const isolateOpenedWindow = (opened: Window | null): Window | null => {
  if (opened === null) return null;
  try {
    opened.opener = null;
  } catch {
    // Some browsers return a WindowProxy that rejects opener mutation.
  }
  return opened;
};

/**
 * Open a new browser window pointed at the current composition in
 * `mode=prompter`. The caller passes the current `?composition=` or
 * `?scene=` URL parameters (without the mode override); this helper
 * appends `mode=prompter` and opens it.
 */
export const openPrompterWindow = (
  baseUrl: string,
  features = DEFAULT_PROMPTER_WINDOW_FEATURES,
  options: PrompterWindowOptions = {},
): Window | null => {
  const win = globalThis.window;
  if (win === undefined) return null;

  const presenterSessionId = options.presenterSessionId ?? getPresenterSessionId();
  if (!isPresenterSessionId(presenterSessionId)) return null;

  const url = buildPrompterUrl(baseUrl, win.location, presenterSessionId);
  if (url === null) return null;

  const opened = win.open(url, '_blank', withPopupIsolationFeatures(features));
  return isolateOpenedWindow(opened);
};

/**
 * A `PrompterRenderer` that paints the full prompter script into the
 * chrome lower-third slot (or a fallback element). Mounts a panel and
 * returns the cleanup callback the loader runs on next navigation.
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
