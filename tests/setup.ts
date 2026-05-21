// Vitest global setup.
//
// `CustomEvent` became a Node global without a flag in Node 19. The
// repo's declared engine is Node 22, but contributors running tests on
// older Node versions (e.g. 18.x with the `--experimental-global-...`
// flag absent) would otherwise hit a ReferenceError. This polyfill is
// a one-liner aligned with the WHATWG / DOM spec for `CustomEvent` and
// is a no-op when the global is already defined.

if (typeof globalThis.CustomEvent === 'undefined') {
  class CustomEventPolyfill<T> extends Event {
    readonly detail: T;
    constructor(type: string, init?: { detail?: T }) {
      super(type);
      this.detail = init?.detail as T;
    }
  }
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    writable: true,
    value: CustomEventPolyfill,
  });
}
