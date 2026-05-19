// Pulsar L2 templates — shared lifecycle envelope.
//
// Every template factory in this directory returns a `SceneModule`.
// The lifecycle envelope (defensive ctx narrowing, scene-root mount
// into `ctx.stage` via the owner document, cleanup via root.remove)
// is identical across templates and is hoisted here so each template
// file holds only its scene-specific content + beat declarations.
//
// Templates that need chrome slot access read `ctx.chrome` directly
// (added to `WorkbenchSceneCtx` in Batch F). Templates that author
// their own DOM use the scene root returned from `mountTemplateRoot`.

import { NAVIGATION_MODES } from '../../runtime/navigation';
import type { Caption, SceneLifecycleFn, SceneModule } from '../../runtime/scene';
import type { WorkbenchSceneCtx } from '../../runtime/scene-loader';
import type { ChromeSlots } from '../chrome';
import { addAdvanceGate } from '../helpers/timing';

// ---------- ctx narrowing (shared with the scene authoring contract) ----

export interface TemplateDomElement {
  setAttribute(name: string, value: string): void;
  appendChild?(node: unknown): unknown;
  textContent?: string;
  innerHTML?: string;
  dataset?: Record<string, string>;
  style?: { [k: string]: string };
}

export interface TemplateDomFactory {
  createElement(tag: string): TemplateDomElement;
}

export interface TemplateStageElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild?(node: unknown): unknown;
  querySelector?(selector: string): {
    setAttribute?(name: string, value: string): void;
    remove?(): void;
  } | null;
  readonly ownerDocument?: TemplateDomFactory | null;
}

/**
 * The ctx shape every template factory's lifecycle hooks narrow to.
 * `chrome` is optional because templates that only own their scene
 * root don't need it; templates that mount into chrome slots (title,
 * centerpiece, brand, lower-third, tag) do.
 */
export interface TemplateCtx {
  readonly stage: TemplateStageElement | null;
  readonly mode: WorkbenchSceneCtx['mode'];
  readonly gsap: WorkbenchSceneCtx['gsap'];
  readonly chrome?: ChromeSlots;
}

const isStageShape = (stage: unknown): stage is TemplateStageElement | null => {
  if (stage === null) return true;
  if (typeof stage !== 'object') return false;
  const c = stage as Partial<Record<'setAttribute' | 'removeAttribute', unknown>>;
  return typeof c.setAttribute === 'function' && typeof c.removeAttribute === 'function';
};

const isGsapShape = (gsap: unknown): gsap is WorkbenchSceneCtx['gsap'] => {
  if (gsap === null || typeof gsap !== 'object') return false;
  return typeof (gsap as { timeline?: unknown }).timeline === 'function';
};

/** Defensive ctx predicate used by every template's create/timeline/cleanup. */
export const isTemplateCtx = (value: unknown): value is TemplateCtx => {
  if (typeof value !== 'object' || value === null) return false;
  if (!('stage' in value) || !('mode' in value) || !('gsap' in value)) return false;
  const v = value as Record<string, unknown>;
  if (!isStageShape(v.stage)) return false;
  if (typeof v.mode !== 'string' || !(NAVIGATION_MODES as readonly string[]).includes(v.mode))
    return false;
  return isGsapShape(v.gsap);
};

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
  readonly buildChildren?: (root: TemplateDomElement, ownerDoc: TemplateDomFactory) => void;
}

/**
 * Mount a scene root inside `ctx.stage`. Returns the root element (or
 * `null` when the ctx is malformed / off-DOM). Sets the standard
 * `data-pulsar-template` attr and initial inactive activation, so
 * mount-then-play visibility stays coherent — scene roots only show
 * during their own segment via the template's timeline callbacks.
 */
export const mountTemplateRoot = (host: MountTemplateRootHost): TemplateDomElement | null => {
  const { ctx, rootValue, templateKind, tag = 'section', extraClasses = [], buildChildren } = host;
  if (!isTemplateCtx(ctx)) return null;
  const stage = ctx.stage;
  if (stage === null) return null;
  if (typeof stage.appendChild !== 'function') return null;
  const ownerDoc = stage.ownerDocument;
  if (ownerDoc === undefined || ownerDoc === null) return null;
  if (typeof ownerDoc.createElement !== 'function') return null;

  const root = ownerDoc.createElement(tag);
  const kind = templateKind ?? rootValue;
  const classes = ['pulsar-template', `pulsar-template--${kind}`, ...extraClasses];
  root.setAttribute('class', classes.join(' '));
  // The data-pulsar-template id is read by querySelector for cleanup
  // / activation lookups, so we set it as a true attribute (not via
  // dataset) so the value is queryable regardless of the
  // dataset->attribute-name camelCase translation.
  root.setAttribute(TEMPLATE_ROOT_ATTR, rootValue);
  // Initially inactive. CSS selector
  // `.pulsar-template[data-pulsar-template-active="true"]` reveals it
  // when the timeline activates the scene.
  writeTemplateActive(root, false);
  if (buildChildren !== undefined && typeof root.appendChild === 'function') {
    buildChildren(root, ownerDoc);
  }
  stage.appendChild(root);
  return root;
};

/**
 * Force every template root in the stage tree inactive EXCEPT the
 * one matching `keepValue`. Used by `buildTemplateTimeline` on
 * scene activation so the cross-fade race between a previous
 * scene's trailing `onComplete` and the next scene's leading
 * `setActive(true)` never leaves two roots visible simultaneously.
 */
const deactivateOtherRoots = (ctx: unknown, keepValue: string): void => {
  if (typeof ctx !== 'object' || ctx === null) return;
  const stage = (ctx as { stage?: unknown }).stage as TemplateStageElement | null;
  if (stage === null) return;
  const docHost = stage as unknown as {
    querySelectorAll?: (sel: string) => ArrayLike<{ dataset?: Record<string, string> }>;
  };
  const others = docHost.querySelectorAll?.(
    `[${TEMPLATE_ROOT_ATTR}]:not([${TEMPLATE_ROOT_ATTR}="${keepValue}"])`,
  );
  if (others === undefined) return;
  for (let i = 0; i < others.length; i += 1) {
    const other = others[i];
    if (other?.dataset !== undefined) other.dataset.pulsarTemplateActive = 'false';
  }
};

/** Find a previously-mounted template root by `rootValue`. */
export const findTemplateRoot = (
  ctx: unknown,
  rootValue: string,
): {
  setAttribute?(name: string, value: string): void;
  remove?(): void;
  dataset?: Record<string, string>;
} | null => {
  if (!isTemplateCtx(ctx)) return null;
  const stage = ctx.stage;
  if (stage === null) return null;
  if (typeof stage.querySelector !== 'function') return null;
  return stage.querySelector(`[${TEMPLATE_ROOT_ATTR}="${rootValue}"]`);
};

/**
 * Internal: write the activation marker on a DOM element. Prefers
 * the `dataset` surface (Sonar `prefer-dataset` rule) when present,
 * falls back to `setAttribute` for fake/off-DOM elements.
 */
const writeTemplateActive = (
  root: {
    dataset?: Record<string, string>;
  },
  active: boolean,
): void => {
  if (root.dataset !== undefined) {
    root.dataset.pulsarTemplateActive = active ? 'true' : 'false';
  }
};

/** Flip a template root's visibility marker. CSS handles the actual show/hide via the attribute selector. */
export const setTemplateActive = (
  root: {
    dataset?: Record<string, string>;
  } | null,
  active: boolean,
): void => {
  if (root === null) return;
  writeTemplateActive(root, active);
};

// ---------- timeline envelope -----------------------------------------

export interface BuildTemplateTimelineHost {
  readonly ctx: unknown;
  readonly rootValue: string;
  /** Scene-specific authoring callback — declare beats, tweens, etc. */
  readonly buildSegments: (
    tl: ReturnType<WorkbenchSceneCtx['gsap']['timeline']>,
    root: ReturnType<typeof findTemplateRoot>,
  ) => void;
  /** Duration (s) of the trailing tween whose onComplete deactivates the root. */
  readonly suffixDurationSeconds?: number;
  /**
   * When `true` (default), a trailing `addAdvanceGate(tl)` is inserted
   * after the scene's `buildSegments` content so master pauses at the
   * scene boundary until the presenter advances. Decks that want a
   * scene to flow into the next without a hold (auto-flow demo
   * sequences) pass `false`.
   */
  readonly holdForAdvance?: boolean;
  /**
   * Optional teardown callback fired by the suffix tween's
   * `onComplete` alongside the template root's deactivation. Used by
   * templates that mount chrome elements outside the scene root
   * (e.g. terminal's clock + srcMark on `document.body`) so those
   * elements are stripped when master leaves the segment.
   */
  readonly onDeactivate?: () => void;
}

/**
 * Build the scene's GSAP timeline with the canonical activation
 * envelope: leading `tl.call` flips the root to active (visible), the
 * supplied `buildSegments` callback adds beats / tweens, the trailing
 * tween's `onComplete` deactivates the root.
 *
 * The trailing mutation rides on a tween's `onComplete` (not a
 * trailing `tl.call`) because the last entry in a composition slice
 * has its child timeline end at master `duration()`, where a callback
 * at that exact position races the master's own `onComplete` and may
 * be skipped on the final tick. A short trailing tween moves the
 * mutation off the boundary.
 */
export const buildTemplateTimeline = (
  host: BuildTemplateTimelineHost,
): ReturnType<WorkbenchSceneCtx['gsap']['timeline']> | null => {
  if (!isTemplateCtx(host.ctx)) return null;
  const stage = host.ctx.stage;
  if (stage === null) return null;
  const root = findTemplateRoot(host.ctx, host.rootValue);
  const suffix = host.suffixDurationSeconds ?? 0.5;
  const hold = host.holdForAdvance !== false;
  const tl = host.ctx.gsap.timeline();
  tl.call(() => {
    deactivateOtherRoots(host.ctx, host.rootValue);
    setTemplateActive(root, true);
  });
  host.buildSegments(tl, root);
  if (hold) addAdvanceGate(tl);
  const userOnDeactivate = host.onDeactivate;
  // Trailing tween whose onComplete deactivates the root. Suffix
  // duration is intentionally small so the window between "this
  // scene's onComplete" and "next scene's leading setActive(true)"
  // is imperceptible — otherwise both roots briefly stack on the
  // stage during the cross-fade.
  tl.to(
    {},
    {
      duration: suffix,
      onComplete: () => {
        setTemplateActive(root, false);
        if (userOnDeactivate !== undefined) userOnDeactivate();
      },
    },
  );
  return tl;
};

/** Build the cleanup hook that removes the scene root. */
export const cleanupTemplateRoot =
  (rootValue: string): SceneLifecycleFn =>
  (ctx) => {
    const root = findTemplateRoot(ctx, rootValue);
    if (root !== null && typeof root.remove === 'function') {
      root.remove();
    }
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
 * metadata. Provides sensible defaults so each template factory only
 * declares what differs.
 */
export const buildTemplateScene = (host: BuildTemplateSceneHost): SceneModule => ({
  id: host.id,
  title: host.title,
  duration: null,
  tags: host.tags ?? ['template'],
  assets: host.assets ?? [],
  captions: host.captions ?? [],
  audio: host.audio ?? [],
  defaultNext: host.defaultNext ?? null,
  standalone: host.standalone ?? true,
  trailerSafe: host.trailerSafe ?? true,
  create: host.create,
  timeline: host.timeline,
  cleanup: host.cleanup ?? cleanupTemplateRoot(host.id),
});
