// Pulsar L2 templates — shared lifecycle envelope.
//
// Every template factory in this directory returns a `SceneModule`.
// The lifecycle envelope (scene-root mount into `ctx.stage` via the
// owner document, cleanup via `root.remove`) is identical across
// templates and is hoisted here so each template file holds only its
// scene-specific content + beat declarations.
//
// Templates author DOM with real `lib.dom` types (`HTMLElement`,
// `Document`). The scene `ctx` is repo-owned internal code, not
// untrusted input, so the hooks read it through a single typed view
// ({@link TemplateCtx}) and check only the one branch that genuinely
// varies at runtime: a `null` stage (off-DOM Node environments).

import type { NavigationMode } from '../../runtime/navigation';
import {
  type Caption,
  type SceneLifecycleFn,
  type SceneModule,
  defineScene,
} from '../../runtime/scene';
import type { WorkbenchSceneCtx } from '../../runtime/scene-ctx';
import type { ChromeSlots } from '../chrome';

// ---------- ctx view --------------------------------------------------

/**
 * The typed view every template's lifecycle hook reads `ctx` as. The
 * runtime hands hooks an opaque `unknown` ({@link SceneLifecycleFn});
 * templates narrow it to this shape with a single `ctx as TemplateCtx`
 * and check `stage === null` for the off-DOM path. `stage` is a real
 * `HTMLElement` so templates author against `lib.dom`; `chrome` is
 * optional because templates that only own their scene root don't
 * need it.
 */
export interface TemplateCtx {
  readonly stage: HTMLElement | null;
  readonly mode: NavigationMode;
  readonly gsap: WorkbenchSceneCtx['gsap'];
  readonly chrome?: ChromeSlots;
}

/** Read the opaque lifecycle `ctx` as the template view. */
export const asTemplateCtx = (ctx: unknown): TemplateCtx => ctx as TemplateCtx;

/**
 * The GSAP timeline scenes author beats on — the concrete type
 * `ctx.gsap.timeline()` returns. Decks reference this so their
 * `beats(tl, ...)` callbacks stay typed without importing GSAP or
 * re-declaring a structural subset.
 */
export type TemplateTimeline = ReturnType<WorkbenchSceneCtx['gsap']['timeline']>;

// ---------- scene-root mount ------------------------------------------

/**
 * The DOM marker every L2 template root carries. Per-template
 * factories pass a unique `rootValue` (typically a kebab-case template
 * id) so query selectors stay distinguishable across multiple scenes
 * mounted on the same stage.
 */
export const TEMPLATE_ROOT_ATTR = 'data-pulsar-template';

export interface MountTemplateRootHost {
  readonly ctx: unknown;
  /** Unique handle for query lookup — typically the scene id. */
  readonly rootValue: string;
  /**
   * CSS template-kind suffix used for `.pulsar-template--<templateKind>`.
   * Multiple scenes built from the same template share the kind but
   * have unique `rootValue`s. Defaults to `rootValue` when omitted.
   */
  readonly templateKind?: string;
  readonly tag?: string;
  readonly extraClasses?: readonly string[];
  /** Author the scene's children inside the freshly-mounted root. */
  readonly buildChildren?: (root: HTMLElement, ownerDoc: Document) => void;
}

/**
 * Mount a scene root inside `ctx.stage`. Returns the root element (or
 * `null` when the runtime has no stage). Sets the standard
 * `data-pulsar-template` attr and initial inactive activation, so
 * mount-then-play visibility stays coherent — scene roots only show
 * during their own segment via the template's timeline callbacks.
 */
export const mountTemplateRoot = (host: MountTemplateRootHost): HTMLElement | null => {
  const { rootValue, templateKind, tag = 'section', extraClasses = [], buildChildren } = host;
  const stage = asTemplateCtx(host.ctx).stage;
  if (stage === null) return null;
  const ownerDoc = stage.ownerDocument;

  const root = ownerDoc.createElement(tag);
  const kind = templateKind ?? rootValue;
  root.setAttribute(
    'class',
    ['pulsar-template', `pulsar-template--${kind}`, ...extraClasses].join(' '),
  );
  // The data-pulsar-template id is read by querySelector for cleanup /
  // activation lookups, so we set it as a true attribute (not via
  // dataset) so the value is queryable regardless of the
  // dataset->attribute-name camelCase translation.
  root.setAttribute(TEMPLATE_ROOT_ATTR, rootValue);
  // Initially inactive. CSS selector
  // `.pulsar-template[data-pulsar-template-active="true"]` reveals it
  // when the timeline activates the scene.
  root.dataset.pulsarTemplateActive = 'false';
  if (buildChildren !== undefined) buildChildren(root, ownerDoc);
  stage.appendChild(root);
  return root;
};

/**
 * Force every template root in the stage tree inactive EXCEPT the one
 * matching `keepValue`. Used by `buildTemplateTimeline` on scene
 * activation so the cross-fade race between a previous scene's
 * trailing `onComplete` and the next scene's leading `setActive(true)`
 * never leaves two roots visible simultaneously.
 */
const deactivateOtherRoots = (stage: HTMLElement | null, keepValue: string): void => {
  if (stage === null) return;
  const others = stage.querySelectorAll<HTMLElement>(
    `[${TEMPLATE_ROOT_ATTR}]:not([${TEMPLATE_ROOT_ATTR}="${keepValue}"])`,
  );
  for (const other of others) other.dataset.pulsarTemplateActive = 'false';
};

/** Find a previously-mounted template root by `rootValue`. */
export const findTemplateRoot = (ctx: unknown, rootValue: string): HTMLElement | null => {
  const stage = asTemplateCtx(ctx).stage;
  if (stage === null) return null;
  return stage.querySelector<HTMLElement>(`[${TEMPLATE_ROOT_ATTR}="${rootValue}"]`);
};

/** Flip a template root's visibility marker. CSS handles the actual show/hide via the attribute selector. */
export const setTemplateActive = (root: HTMLElement | null, active: boolean): void => {
  if (root === null) return;
  root.dataset.pulsarTemplateActive = active ? 'true' : 'false';
};

// ---------- timeline envelope -----------------------------------------

export interface BuildTemplateTimelineHost {
  readonly ctx: unknown;
  readonly rootValue: string;
  /** Scene-specific authoring callback — declare beats, tweens, etc. */
  readonly buildSegments: (tl: TemplateTimeline, root: HTMLElement | null) => void;
  /**
   * Duration (s) the scene's content occupies before the timeline reaches
   * its natural end. Accepted so existing templates keep their per-scene
   * pacing; the run-loop holds for advance after the timeline completes.
   */
  readonly suffixDurationSeconds?: number;
}

/**
 * Build the scene's GSAP timeline with the canonical activation envelope:
 * a leading `tl.call` flips the root to active (visible), then the supplied
 * `buildSegments` callback adds beats / tweens.
 *
 * ADR-032 run-loop: the runtime no longer composes a master timeline, so
 * there is no deactivate-on-complete tween — the scene timeline plays
 * standalone to its natural end, the run-loop holds for advance, and the
 * scene's `cleanup(ctx)` tears down (root removal + any chrome the scene
 * mounted on `document.body`). Teardown therefore lives in `cleanup`, not
 * on the timeline, so it never fires prematurely at the timeline's end.
 */
export const buildTemplateTimeline = (host: BuildTemplateTimelineHost): TemplateTimeline | null => {
  const ctx = asTemplateCtx(host.ctx);
  if (ctx.stage === null) return null;
  const root = findTemplateRoot(host.ctx, host.rootValue);
  const tl = ctx.gsap.timeline();
  tl.call(() => {
    deactivateOtherRoots(ctx.stage, host.rootValue);
    setTemplateActive(root, true);
  });
  host.buildSegments(tl, root);
  return tl;
};

/** Build the cleanup hook that removes the scene root. */
export const cleanupTemplateRoot =
  (rootValue: string): SceneLifecycleFn =>
  (ctx) => {
    findTemplateRoot(ctx, rootValue)?.remove();
  };

// ---------- SceneModule envelope --------------------------------------

export interface BuildTemplateSceneHost {
  readonly id: string;
  readonly title: string;
  readonly captions?: readonly Caption[];
  readonly assets?: readonly string[];
  readonly audio?: readonly string[];
  readonly tags?: readonly string[];
  readonly defaultNext?: string | null;
  readonly standalone?: boolean;
  readonly trailerSafe?: boolean;
  readonly create: SceneLifecycleFn;
  readonly timeline: SceneLifecycleFn;
  readonly cleanup?: SceneLifecycleFn;
}

/**
 * Build a `SceneModule` from the template-specific lifecycle hooks +
 * metadata. Routes through {@link defineScene} so scene defaulting and
 * validation live in exactly one place; only the template-specific
 * defaults (a `template` tag, standalone/trailer-safe by default, and
 * the standard root-removing cleanup) are applied here.
 */
export const buildTemplateScene = (host: BuildTemplateSceneHost): SceneModule =>
  defineScene({
    id: host.id,
    title: host.title,
    tags: host.tags ?? ['template'],
    assets: host.assets,
    captions: host.captions,
    audio: host.audio,
    defaultNext: host.defaultNext,
    standalone: host.standalone ?? true,
    trailerSafe: host.trailerSafe ?? true,
    create: host.create,
    timeline: host.timeline,
    cleanup: host.cleanup ?? cleanupTemplateRoot(host.id),
  });
