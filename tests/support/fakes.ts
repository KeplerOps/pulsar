// Shared jsdom-free test fakes.
//
// Several suites need the same lightweight stand-ins instead of a full
// DOM/runtime: a stage stub that records attribute writes, a synthetic
// HTMLElement/Document tree for the chrome pack, and an event-emitting
// presenter controller. Each lives here once so the suites consume one
// faithful implementation rather than re-deriving it per file.

import type { PresenterCommand, PresenterController } from '../../src/runtime/presenter';

// ---------- scene-fixture stage stub ----------

/**
 * Stage stub for the `mode=*` fixture scenes: `appendChild` records
 * children, `querySelector` resolves them by the attribute name in the
 * `[<attr>]` selector the fixtures use, and `ownerDocument.createElement`
 * returns a recording element. The fixtures allocate DOM through the
 * stage's owner document rather than an ambient `document` global
 * (ADR-008 #2), so the stub mirrors that seam.
 */
export interface SceneFixtureStage {
  readonly children: { attrs: Map<string, string> }[];
  readonly element: {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    appendChild(node: unknown): unknown;
    querySelector(selector: string): {
      setAttribute(name: string, value: string): void;
      remove(): void;
    } | null;
    ownerDocument: {
      createElement(tag: string): { setAttribute(name: string, value: string): void };
    };
  };
}

export const buildSceneFixtureStage = (): SceneFixtureStage => {
  const children: { attrs: Map<string, string> }[] = [];
  return {
    children,
    element: {
      setAttribute: () => undefined,
      removeAttribute: () => undefined,
      appendChild: (node: unknown) => {
        children.push(node as { attrs: Map<string, string> });
        return node;
      },
      querySelector: (selector: string) => {
        const attr = selector.replace(/^\[|\]$/g, '').split('=')[0];
        if (attr === undefined) return null;
        for (let i = 0; i < children.length; i += 1) {
          const child = children[i];
          if (child === undefined) continue;
          if (child.attrs.has(attr)) {
            return {
              setAttribute: (name: string, value: string) => child.attrs.set(name, value),
              remove: () => {
                children.splice(i, 1);
              },
            };
          }
        }
        return null;
      },
      ownerDocument: {
        createElement: () => {
          const attrs = new Map<string, string>();
          return {
            attrs,
            setAttribute: (name: string, value: string) => attrs.set(name, value),
          };
        },
      },
    },
  };
};

// ---------- synthetic HTMLElement / Document tree ----------

// Finds the first element (depth-first) whose class list includes the
// `.<class>` selector. Hoisted so `querySelector` stays under the Biome
// cognitive-complexity gate.
const findByClass = (root: HTMLElement, selector: string): HTMLElement | null => {
  const match = selector.match(/^\.([\w-]+)$/);
  if (match === null) return null;
  const cls = match[1] ?? '';
  if ((root.className ?? '').split(' ').includes(cls)) return root;
  for (const child of (root as unknown as { childNodes: HTMLElement[] }).childNodes) {
    const found = findByClass(child, selector);
    if (found !== null) return found;
  }
  return null;
};

/**
 * A minimal DOM tree (no jsdom): each element carries the attribute,
 * class-list, child-node, innerHTML/textContent, and layout-read
 * surface the chrome pack touches. `querySelector` resolves `.<class>`
 * selectors via depth-first traversal. Typed as the real DOM interfaces
 * so callers pass the fakes without `as unknown as` ceremony.
 */
export interface DomFake {
  readonly doc: Document;
  createElement(tag: string): HTMLElement;
}

export const createDomFake = (): DomFake => {
  const make = (tag: string, doc: Document): HTMLElement => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const children: HTMLElement[] = [];
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      classList: {
        add: (n: string) => {
          classes.add(n);
          el.className = [...classes].join(' ');
        },
        remove: (n: string) => {
          classes.delete(n);
          el.className = [...classes].join(' ');
        },
        contains: (n: string) => classes.has(n),
      },
      innerHTML: '',
      textContent: null as string | null,
      ownerDocument: doc,
      childNodes: children,
      parentElement: null as HTMLElement | null,
      offsetWidth: 0,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      get firstChild() {
        return children[0] ?? null;
      },
      setAttribute: (n: string, v: string) => {
        attrs.set(n, v);
      },
      getAttribute: (n: string) => attrs.get(n) ?? null,
      appendChild: (child: HTMLElement) => {
        (child as { parentElement: HTMLElement | null }).parentElement =
          el as unknown as HTMLElement;
        children.push(child);
        return child;
      },
      removeChild: (child: HTMLElement) => {
        const i = children.indexOf(child);
        if (i >= 0) children.splice(i, 1);
        (child as { parentElement: HTMLElement | null }).parentElement = null;
        return child;
      },
      remove: () => {
        const p = (el as unknown as HTMLElement).parentElement;
        if (p !== null) p.removeChild(el as unknown as HTMLElement);
      },
      querySelector: (selector: string): HTMLElement | null =>
        findByClass(el as unknown as HTMLElement, selector),
    };
    return el as unknown as HTMLElement;
  };
  const doc = {
    createElement: (tag: string) => make(tag, doc as unknown as Document),
  } as unknown as Document;
  return { doc, createElement: (tag: string) => make(tag, doc) };
};

// ---------- presenter command source ----------

/**
 * An event-emitting presenter controller fake: `controller.subscribe`
 * registers a handler and returns an unsubscribe, `emit` fans a command
 * out to every live handler, and `subscriberCount` reports the live
 * count (so leak / cleanup assertions can observe it).
 */
export interface ControllerFake {
  readonly controller: PresenterController;
  emit(cmd: PresenterCommand): void;
  subscriberCount(): number;
}

export const createControllerFake = (): ControllerFake => {
  const handlers = new Set<(cmd: PresenterCommand) => void>();
  return {
    controller: {
      subscribe: (handler) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    },
    emit: (cmd) => {
      for (const h of [...handlers]) h(cmd);
    },
    subscriberCount: () => handlers.size,
  };
};

/** A presenter controller that accepts subscribers but never emits. */
export const noopPresenterController: PresenterController = {
  subscribe: () => () => {},
};
