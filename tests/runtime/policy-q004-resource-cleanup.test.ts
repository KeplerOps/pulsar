import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  GLOBAL_WRAPPERS,
  REPO_ROOT,
  SRC_ROOT,
  type SourceFinding,
  collectLineExemptions,
  getAccessPath,
  isInTypePosition,
  lineText,
  parseSource,
  unwrap,
  walkTsFiles,
} from './source-policy';

// PUL-Q004 — Resource cleanup completeness (source scan).
//
// Statement: "After `cleanup(ctx)` has run for a scene, no DOM nodes,
// event listeners, audio handles, or timeline objects created by the
// scene SHALL remain attached to the runtime."
//
// The PUL-Q004 preflight
// (`docs/design/pul-q004-resource-cleanup-preflight.md`) frames
// cleanup completeness as a runtime invariant enforced INSIDE the
// existing lifecycle boundaries (resolver / loader / timeline /
// audio / presenter). The runtime-side invariants are pinned by the
// per-boundary test suites; PUL-Q004 adds the missing structural
// defense on the *scene-authored* side — constructions that bypass
// the runtime's activation-scope cleanup discipline.
//
// Scope of THIS gate vs adjacent gates and runtime cleanup
// boundaries (codex review, cycle 2):
//   - PUL-A001 bans direct `gsap` imports in scenes — encapsulation
//     gate. Forces every timeline construction through `ctx.gsap`.
//   - PUL-A002 bans direct `howler` imports AND `new Audio()` /
//     `new HTMLAudioElement()` in scenes — encapsulation gate.
//     Forces every audio operation through `ctx.audio`.
//   - PUL-Q001 bans `setTimeout` / `setInterval` /
//     `requestAnimationFrame` / `Element.animate` — scene-authored
//     animation timers cannot escape `ctx.gsap`.
//
// Encapsulation gates above are NOT cleanup-completeness proofs.
// They prove activation-scope ENTRY (scenes touch audio/timeline
// only through `ctx`); they do NOT prove activation-scope OWNERSHIP
// (every entered resource is released on `cleanup(ctx)`). The
// activation-ownership invariants for audio handles and timeline
// objects live in the RUNTIME boundary, not this gate:
//   - `AudioService.stopAll()` (`src/runtime/audio.ts`) stops AND
//     unloads every sound the service registered on navigation
//     abort / dispose / happy-path completion. A scene's audio
//     handle cannot survive the navigation.
//   - `MasterTimeline.kill()` (`src/runtime/timeline.ts`) kills the
//     composed master on natural completion AND on abort;
//     `composeMasterTimeline` kills every scene-returned timeline
//     on compose failure. A scene's timeline object cannot survive
//     the navigation.
// Per-scene-within-composition cleanup of an *ungrouped* audio cue
// or an *unreturned* default-playing timeline is a runtime-facade
// follow-up named in the PUL-Q004 preflight ("True per-scene
// activation contexts ... are a documented resolver follow-up").
// This source-policy gate does NOT close that gap; the preflight
// and runtime-side test suites are the durable record of what
// closes it. Q004's structural defense, scoped to scene authoring,
// is the bypass-closure for DOM nodes and event listeners — plus
// the categorically-related anti-patterns the preflight names
// (DOM observers and DOM-prototype monkey-patches).
//
// What is *not* covered yet, and is structurally specific to the
// "no remaining DOM nodes / listeners after cleanup" invariant:
//
//   1. Scene-attached global event listeners
//      (`document.addEventListener`, `window.addEventListener`,
//      `globalThis.addEventListener`, `self.addEventListener`,
//      `global.addEventListener`, and their `removeEventListener`
//      siblings). Listeners attached to global targets cannot be
//      cleanly removed in `cleanup(ctx)` without re-creating the
//      exact options tuple (passive / capture / once / signal);
//      they outlive the scene's activation scope. The preflight is
//      explicit: prefer activation-owned registration so removal
//      does not depend on recreating options exactly.
//   2. Observer constructions in scenes (`new MutationObserver`,
//      `new IntersectionObserver`, `new ResizeObserver`,
//      `new PerformanceObserver`). Each has a `disconnect()` that
//      scenes would need to remember to call in `cleanup`; the
//      activation-scope ownership pattern the preflight prefers is
//      missing today, so banning these in scenes pushes future
//      observer usage through `ctx`-mediated seams.
//   3. Monkey-patches of DOM-global prototypes
//      (`EventTarget.prototype.X = ...`,
//      `Element.prototype.X = ...`,
//      `Node.prototype.X = ...`,
//      `Document.prototype.X = ...`,
//      `Window.prototype.X = ...`,
//      `HTMLElement.prototype.X = ...`). The preflight names this
//      as an anti-pattern. The matcher covers EVERY assignment
//      operator (`=`, `||=`, `??=`, `&&=`, compound arithmetic /
//      bitwise) AND the call-form patches
//      (`Object.defineProperty`, `Object.assign`, `Reflect.set`,
//      `Reflect.defineProperty`) so a refactored monkey-patch does
//      not slip past the direct-equals check.
//   4. Ambient-`document` attachment surfaces
//      (`document.body`, `document.head`, `document.documentElement`,
//      `document.appendChild`, `document.querySelector`, ...). A
//      scene attaching to `document.body` or pulling parent
//      references through ambient `document` puts nodes outside
//      `ctx.stage`'s ownership — cleanup cannot detach what it
//      never tracked. `ctx.stage.ownerDocument` is the canonical
//      seam scenes use for DOM allocation
//      (`src/scenes/browser-support-fixture.ts`).
//
// Scope: `src/scenes/**/*.ts`. The runtime itself
// (`src/runtime/**/*.ts`) uses signal-bound `addEventListener`
// extensively; that is the canonical activation-scope ownership
// pattern PUL-Q004 wants scenes to adopt by going through `ctx`.
// The runtime is intentionally OUT of scope so its signal-bound
// listener attachments do not require per-line exemptions.
//
// Bypass defenses (cycle 1 codex review): file-local aliases of
// restricted roots resolve through `collectAliases`, and computed
// member access on a restricted root flags conservatively via
// `isComputedRestrictedRootAccess` — so
// `const doc = document; doc.addEventListener(...)`,
// `document['add' + 'EventListener'](...)`,
// `const Obs = window.MutationObserver; new Obs(...)`, and
// `const ET = EventTarget; ET.prototype.foo = wrapped` all match
// the same per-surface tables as the canonical spellings.
//
// Exemption: a line-scoped `// PUL-Q004-allow: <reason>` comment
// excludes a single line from the scan. Empty / whitespace-only
// rationales are rejected; markers hidden inside string literals
// are rejected (the `source-policy.ts` exemption parser uses TS's
// scanner so the marker must be on an actual comment token).

const ALLOW_TAG = 'PUL-Q004-allow';

const SCENES_ROOT = join(SRC_ROOT, 'scenes');

// Roots that own a global event listener registry. A scene calling
// `document.addEventListener(...)` attaches state outside its own
// activation scope — exactly the leak surface PUL-Q004 closes.
const FORBIDDEN_LISTENER_ROOTS: ReadonlySet<string> = new Set([
  'document',
  'window',
  'self',
  'globalThis',
  'global',
]);

// Listener-attachment leaves matched at the end of an access path
// rooted on a forbidden listener root (directly or through one of
// the recognised global wrappers).
const FORBIDDEN_LISTENER_METHODS: ReadonlyMap<string, string> = new Map([
  [
    'addEventListener',
    'global addEventListener (scene attaches listener outside activation scope)',
  ],
  [
    'removeEventListener',
    'global removeEventListener (scene removes listener outside activation scope)',
  ],
]);

// Observer constructors a scene SHALL NOT instantiate directly.
// Their `disconnect()` must be paired with a `cleanup(ctx)` call
// that scene authors cannot reliably wire today; activation-scope
// ownership belongs at the `ctx` seam, not in scene code.
const FORBIDDEN_OBSERVER_CTORS: ReadonlyMap<string, string> = new Map([
  [
    'MutationObserver',
    'new MutationObserver (scene constructs DOM observer outside activation scope)',
  ],
  [
    'IntersectionObserver',
    'new IntersectionObserver (scene constructs DOM observer outside activation scope)',
  ],
  ['ResizeObserver', 'new ResizeObserver (scene constructs DOM observer outside activation scope)'],
  [
    'PerformanceObserver',
    'new PerformanceObserver (scene constructs performance observer outside activation scope)',
  ],
]);

// DOM-global prototypes whose monkey-patching by a scene corrupts
// sibling scenes' cleanup discipline and cannot be undone in
// `cleanup(ctx)`. The preflight names this as a hard anti-pattern.
const FORBIDDEN_PROTOTYPE_ROOTS: ReadonlySet<string> = new Set([
  'EventTarget',
  'Element',
  'Node',
  'Document',
  'Window',
  'HTMLElement',
]);

// Leaf names on the ambient `document` that, when read from a
// scene, expose attachment surfaces outside `ctx.stage`. The
// browser-support fixture already routes DOM allocation through
// `ctx.stage.ownerDocument.createElement`, so banning every
// `document.<leaf>` read at the scene boundary forces future
// scenes onto the same activation-scope seam.
//
// The set is intentionally narrow to the parent-reference reads
// (`body`, `head`, `documentElement`, `firstElementChild`,
// `lastElementChild`, `activeElement`) and the DOM-traversal /
// node-mutation methods that introduce attachment leaks if called
// on the ambient document (`appendChild`, `removeChild`,
// `replaceChild`, `insertBefore`, `append`, `prepend`,
// `querySelector`, `querySelectorAll`, `getElementById`,
// `getElementsByClassName`, `getElementsByTagName`,
// `getElementsByName`, `createElement`, `createElementNS`,
// `createTextNode`, `createDocumentFragment`, `adoptNode`,
// `importNode`, `write`, `open`, `close`). Reads via Q003's
// `document.cookie` matcher live in their own gate.
const FORBIDDEN_DOCUMENT_LEAVES: ReadonlyMap<string, string> = new Map([
  ['body', 'document.body (scene reads ambient DOM attachment root — use ctx.stage)'],
  ['head', 'document.head (scene reads ambient DOM attachment root — use ctx.stage)'],
  ['documentElement', 'document.documentElement (scene reads ambient DOM root — use ctx.stage)'],
  ['firstElementChild', 'document.firstElementChild (scene reads ambient DOM — use ctx.stage)'],
  ['lastElementChild', 'document.lastElementChild (scene reads ambient DOM — use ctx.stage)'],
  ['activeElement', 'document.activeElement (scene reads ambient DOM — use ctx.stage)'],
  ['appendChild', 'document.appendChild (scene attaches to ambient DOM — attach via ctx.stage)'],
  ['removeChild', 'document.removeChild (scene mutates ambient DOM — operate on ctx.stage)'],
  ['replaceChild', 'document.replaceChild (scene mutates ambient DOM — operate on ctx.stage)'],
  ['insertBefore', 'document.insertBefore (scene mutates ambient DOM — operate on ctx.stage)'],
  ['append', 'document.append (scene mutates ambient DOM — operate on ctx.stage)'],
  ['prepend', 'document.prepend (scene mutates ambient DOM — operate on ctx.stage)'],
  ['querySelector', 'document.querySelector (scene reads ambient DOM — query via ctx.stage)'],
  ['querySelectorAll', 'document.querySelectorAll (scene reads ambient DOM — query via ctx.stage)'],
  ['getElementById', 'document.getElementById (scene reads ambient DOM — query via ctx.stage)'],
  [
    'getElementsByClassName',
    'document.getElementsByClassName (scene reads ambient DOM — query via ctx.stage)',
  ],
  [
    'getElementsByTagName',
    'document.getElementsByTagName (scene reads ambient DOM — query via ctx.stage)',
  ],
  [
    'getElementsByName',
    'document.getElementsByName (scene reads ambient DOM — query via ctx.stage)',
  ],
  [
    'createElement',
    'document.createElement (scene allocates DOM via ambient document — use ctx.stage.ownerDocument.createElement)',
  ],
  [
    'createElementNS',
    'document.createElementNS (scene allocates DOM via ambient document — use ctx.stage.ownerDocument)',
  ],
  [
    'createTextNode',
    'document.createTextNode (scene allocates DOM via ambient document — use ctx.stage.ownerDocument)',
  ],
  [
    'createDocumentFragment',
    'document.createDocumentFragment (scene allocates DOM via ambient document — use ctx.stage.ownerDocument)',
  ],
  [
    'adoptNode',
    'document.adoptNode (scene mutates ambient DOM ownership — operate on ctx.stage.ownerDocument)',
  ],
  [
    'importNode',
    'document.importNode (scene allocates DOM via ambient document — use ctx.stage.ownerDocument)',
  ],
  ['write', 'document.write (scene mutates ambient DOM — operate on ctx.stage)'],
  ['open', 'document.open (scene mutates ambient DOM — operate on ctx.stage)'],
  ['close', 'document.close (scene mutates ambient DOM — operate on ctx.stage)'],
  // Document members that return another global root surface
  // (codex review, cycle 3 — `document.defaultView` hands out the
  // Window object whose listeners and observers Q004 also bans
  // through every other seam).
  [
    'defaultView',
    'document.defaultView (scene reads ambient Window through Document — route through ctx)',
  ],
]);

// Leaves that are permitted on a `Document` reached through
// `ctx.stage.ownerDocument` (codex review, cycle 2). The canonical
// scene seam allocates DOM through the stage's owner document —
// every other Document surface (listener attach, parent-root reads,
// queries, mutations) is the same activation-bypass hazard via
// `ownerDocument` as via the ambient `document` global. Allocation
// helpers are allow-listed; everything else flows through
// `FORBIDDEN_DOCUMENT_LEAVES` and `FORBIDDEN_LISTENER_METHODS` and
// is rejected. Keep this set tight: the goal is "allocate via
// ownerDocument, do nothing else with it."
const ALLOWED_OWNER_DOCUMENT_LEAVES: ReadonlySet<string> = new Set([
  'createElement',
  'createElementNS',
  'createTextNode',
  'createDocumentFragment',
  'importNode',
]);

// Roots whose file-local aliases the scanner resolves before
// access-path matching. Without this, ordinary refactors
// (`const doc = document; doc.addEventListener(...)`,
// `const win = window; win.addEventListener(...)`,
// `const ET = EventTarget; ET.prototype.foo = wrapped`,
// `const Obs = window.MutationObserver; new Obs(...)`) would slip
// past every per-surface check while still attaching to the same
// resource the gate names. The set is the union of: the global
// wrappers, the listener roots, the prototype roots, and the
// observer constructor names. `EventTarget` is in the prototype
// roots already.
const ALIAS_ROOTS: ReadonlySet<string> = new Set<string>([
  ...GLOBAL_WRAPPERS,
  ...FORBIDDEN_LISTENER_ROOTS,
  ...FORBIDDEN_PROTOTYPE_ROOTS,
  ...FORBIDDEN_OBSERVER_CTORS.keys(),
  // Listener method names so `const ael = addEventListener; ael(...)`
  // (codex review, cycle 3) registers a single-segment canonical
  // path that the bare-listener branch picks up.
  ...FORBIDDEN_LISTENER_METHODS.keys(),
]);

// True when `node` is the `.name` portion of a property access /
// qualified name — a key position rather than a value-read. Stops
// the visitor's leaf-identifier branch from double-flagging the
// `addEventListener` leaf when the root-property matcher already
// did.
function isPropertyNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) &&
    'name' in parent &&
    parent.name === node
  ) {
    return true;
  }
  return false;
}

// True when `node` is being declared (`const MutationObserver = ...`,
// `function caches() {}`, etc.). Declarations are not value reads.
function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isClassDeclaration(parent) && parent.name === node) return true;
  if (ts.isInterfaceDeclaration(parent) && parent.name === node) return true;
  if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return true;
  if (ts.isEnumDeclaration(parent) && parent.name === node) return true;
  if (ts.isEnumMember(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodSignature(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent)) return true;
  if (ts.isImportClause(parent) && parent.name === node) return true;
  if (ts.isNamespaceImport(parent)) return true;
  if (ts.isExportSpecifier(parent)) return true;
  return false;
}

// Strip leading recognised global-wrapper segments. Returns the
// remaining `tail`.
function stripWrappers(path: readonly string[]): readonly string[] {
  let start = 0;
  while (start < path.length && GLOBAL_WRAPPERS.has(path[start] ?? '')) {
    start += 1;
  }
  return path.slice(start);
}

// Resolve an expression to an access-path, treating bare
// identifiers and `import.meta` as length-1 paths. Used for the
// callee of `Object.defineProperty(<PROTO>, ...)` first-argument
// matching and for alias collection.
function getAccessPathFromExpression(expr: ts.Expression): readonly string[] | null {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) return [inner.text];
  if (ts.isMetaProperty(inner)) return ['import.meta'];
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
    return getAccessPath(inner);
  }
  return null;
}

// True when `node` (an identifier) is shadowed by a function /
// method / arrow / constructor / accessor parameter of the same
// name anywhere in its ancestor chain (codex review, cycle 3 —
// "alias resolution ignores lexical scope and will misclassify
// valid scene code"). Without this guard, a file-global alias like
// `const doc = document` would also resolve the inner `doc` in
// `function helper(doc: T) { doc.addEventListener(...) }` as the
// document global. The check stays surgical: parameter shadowing
// only. Block-scoped shadowing (`{ const doc = otherThing; doc.foo }`)
// is a smaller concern; if it becomes a real source of false
// positives, the check extends to walk variable declarations in
// closer blocks. Today's runtime scenes only declare aliases at
// the module level, so parameter shadowing covers the realistic
// false-positive surface.
function hasParameterShadow(node: ts.Identifier): boolean {
  const name = node.text;
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      for (const param of current.parameters) {
        const paramName = param.name;
        if (ts.isIdentifier(paramName) && paramName.text === name) return true;
        if (ts.isObjectBindingPattern(paramName) || ts.isArrayBindingPattern(paramName)) {
          for (const element of paramName.elements) {
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
              if (element.name.text === name) return true;
            }
          }
        }
      }
    }
    current = current.parent;
  }
  return false;
}

// Walk an access expression to its root identifier, unwrapping
// TypeScript wrappers and skipping computed/element-access steps.
// Returns null when the root is not a plain identifier (e.g.
// `import.meta`, a parenthesized non-identifier expression).
function rootIdentifier(expr: ts.Expression): ts.Identifier | null {
  let current: ts.Expression = unwrap(expr);
  while (true) {
    current = unwrap(current);
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return ts.isIdentifier(current) ? current : null;
}

// Subresource segments that a local alias may carry without its
// containing root. `ownerDocument` lets `const ownerDoc = stage.ownerDocument`
// register the local with canonical `[ownerDocument]`; downstream
// `ownerDoc.body` resolves to `[ownerDocument, body]` and
// `matchOwnerDocumentLeaf` picks it up. `prototype` lets
// `const proto = EventTarget.prototype` register the local with
// canonical `[EventTarget, prototype]`; downstream `proto.foo = wrapped`
// resolves to `[EventTarget, prototype, foo]` and `matchPrototypePatch`
// picks it up. (Codex review, cycle 3 — "restricted subresource
// aliases evade ownerDocument and prototype checks".)
const SUBRESOURCE_TAILS: ReadonlySet<string> = new Set(['ownerDocument', 'prototype']);

// Substitute the first segment of `path` with its canonical alias
// path, if one is registered. The canonical value is now a MULTI-
// segment path (codex review, cycle 3 — subresource aliases like
// `const proto = EventTarget.prototype` need to carry their parent
// root forward so downstream matchers see the full restricted
// surface). Subsequent segments are property names by construction
// so single-step prefix substitution is enough.
function resolveAliasedPath(
  path: readonly string[] | null,
  aliases: ReadonlyMap<string, readonly string[]>,
): readonly string[] | null {
  if (!path || path.length === 0 || aliases.size === 0) return path;
  const first = path[0];
  if (first === undefined) return path;
  const canonical = aliases.get(first);
  if (canonical === undefined) return path;
  return [...canonical, ...path.slice(1)];
}

// Collect file-local aliases that bind a fresh identifier to one of
// the ambient roots in `ALIAS_ROOTS`. Handles four initializer
// shapes (parallel to the Q003 collector, scoped to the roots Q004
// cares about):
//   1. Bare identifier in `ALIAS_ROOTS`
//      (`const doc = document;`, `const Obs = MutationObserver;`).
//   2. Alias of an existing alias
//      (`const win = window; const w2 = win;` → `w2 → window`).
//   3. Property / element access whose alias-resolved + wrapper-
//      stripped path is a single ambient root segment
//      (`const Obs = window.MutationObserver;`).
//   4. Destructured property whose name is an ambient root, from a
//      wrapper initializer (`const { MutationObserver } = window;`).
// Iterates to a fixed point so chained aliases resolve regardless
// of source order.
function collectAliases(sourceFile: ts.SourceFile): Map<string, readonly string[]> {
  const aliases = new Map<string, readonly string[]>();
  type DirectDecl = { kind: 'direct'; name: string; init: ts.Expression };
  type DestructuringDecl = {
    kind: 'destructuring';
    pattern: ts.ObjectBindingPattern;
    init: ts.Expression;
  };
  const declarations: (DirectDecl | DestructuringDecl)[] = [];
  const collectVisit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        declarations.push({ kind: 'direct', name: node.name.text, init: node.initializer });
      } else if (ts.isObjectBindingPattern(node.name)) {
        declarations.push({
          kind: 'destructuring',
          pattern: node.name,
          init: node.initializer,
        });
      }
    }
    ts.forEachChild(node, collectVisit);
  };
  collectVisit(sourceFile);

  const tryRegisterDirect = (localName: string, init: ts.Expression): boolean => {
    if (aliases.has(localName)) return false;
    const inner = unwrap(init);
    if (ts.isIdentifier(inner)) {
      if (ALIAS_ROOTS.has(inner.text)) {
        aliases.set(localName, [inner.text]);
        return true;
      }
      const aliased = aliases.get(inner.text);
      if (aliased !== undefined) {
        aliases.set(localName, aliased);
        return true;
      }
      return false;
    }
    if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
      const rawPath = getAccessPath(inner);
      if (!rawPath) return false;
      const resolved = resolveAliasedPath(rawPath, aliases) ?? rawPath;
      const tail = stripWrappers(resolved);
      if (tail.length === 1) {
        const canonical = tail[0];
        if (canonical && ALIAS_ROOTS.has(canonical)) {
          aliases.set(localName, [canonical]);
          return true;
        }
      }
      // Wrapper-to-wrapper property aliases (codex review, cycle 2):
      // `const win = globalThis.window` — both segments are global
      // wrappers, so stripWrappers leaves an empty tail. Without this
      // branch the local `win` is never registered, and downstream
      // access (`win.addEventListener(...)`, `new win.MutationObserver(...)`)
      // bypasses the per-surface tables. The local resolves to a
      // canonical wrapper (`globalThis`) so the existing wrapper-aware
      // matchers and `isComputedRestrictedRootAccess` pick it up.
      if (tail.length === 0 && resolved.length > 0) {
        aliases.set(localName, ['globalThis']);
        return true;
      }
      // Subresource aliases (codex review, cycle 3 — `const ownerDoc =
      // stage.ownerDocument; ownerDoc.body` AND `const proto =
      // EventTarget.prototype; proto.foo = wrapped`). When the resolved
      // path ends in a recognised subresource segment, register the
      // local with the FULL canonical path so downstream matchers see
      // the parent root (e.g. `proto → ['EventTarget', 'prototype']`).
      // For `stage.ownerDocument`, the parent is the scene's stage —
      // there is no wrapper root upstream — so the canonical is just
      // `['ownerDocument']`; that is enough for `matchOwnerDocumentLeaf`
      // to fire on `ownerDoc.body` → `['ownerDocument', 'body']`.
      const last = resolved[resolved.length - 1];
      if (last !== undefined && SUBRESOURCE_TAILS.has(last)) {
        if (last === 'prototype') {
          // `proto = <ROOT>.prototype` → register `[<ROOT>, prototype]`
          // when ROOT is a forbidden prototype root. Other roots
          // (`MyClass.prototype`) are not Q004 hazards.
          const before = resolved[resolved.length - 2];
          if (before !== undefined && FORBIDDEN_PROTOTYPE_ROOTS.has(before)) {
            aliases.set(localName, [before, 'prototype']);
            return true;
          }
        } else {
          aliases.set(localName, [last]);
          return true;
        }
      }
    }
    return false;
  };

  const tryRegisterDestructuring = (
    pattern: ts.ObjectBindingPattern,
    init: ts.Expression,
  ): boolean => {
    const initPath = resolveAliasedPath(getAccessPathFromExpression(init), aliases);
    if (!initPath) return false;
    const tail = stripWrappers(initPath);
    if (tail.length !== 0) return false; // not a pure wrapper root
    let changed = false;
    for (const element of pattern.elements) {
      const propNode = element.propertyName ?? element.name;
      const propText = ts.isIdentifier(propNode)
        ? propNode.text
        : ts.isStringLiteralLike(propNode)
          ? propNode.text
          : null;
      if (!propText) continue;
      if (!ALIAS_ROOTS.has(propText)) continue;
      if (!ts.isIdentifier(element.name)) continue;
      const localName = element.name.text;
      if (aliases.has(localName)) continue;
      aliases.set(localName, [propText]);
      changed = true;
    }
    return changed;
  };

  for (let pass = 0; pass < declarations.length + 1; pass += 1) {
    let changed = false;
    for (const decl of declarations) {
      if (decl.kind === 'direct') {
        if (tryRegisterDirect(decl.name, decl.init)) changed = true;
      } else {
        if (tryRegisterDestructuring(decl.pattern, decl.init)) changed = true;
      }
    }
    if (!changed) break;
  }
  return aliases;
}

// True when `expr` is a computed member access (`<obj>[<expr>]`
// or `<obj>.<...>[<expr>]`) whose underlying root resolves to one
// of the Q004 restricted roots (listener root, prototype root,
// observer constructor, global wrapper) — directly OR through a
// file-local alias. Conservative: a computed segment on an
// unrelated root is not flagged. Catches bypass shapes like
// `document['add' + 'EventListener'](...)`,
// `globalThis[key](...)`, `new window['Mutation' + 'Observer'](...)`,
// `EventTarget.prototype['x' + suffix] = wrapped`.
function isComputedRestrictedRootAccess(
  expr: ts.Expression,
  aliases: ReadonlyMap<string, readonly string[]>,
): boolean {
  let current: ts.Expression = unwrap(expr);
  let foundComputed = false;
  while (true) {
    current = unwrap(current);
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      const arg = unwrap(current.argumentExpression);
      if (!ts.isStringLiteralLike(arg)) {
        foundComputed = true;
      }
      current = current.expression;
      continue;
    }
    break;
  }
  if (!foundComputed) return false;
  if (!ts.isIdentifier(current)) return false;
  if (ALIAS_ROOTS.has(current.text)) return true;
  const canonical = aliases.get(current.text);
  if (canonical === undefined) return false;
  // Canonical is now a path. Treat the first segment as the
  // resolved root for the bypass detector — same shape the
  // single-string version had.
  const firstCanonical = canonical[0];
  return firstCanonical !== undefined && ALIAS_ROOTS.has(firstCanonical);
}

// Match an access-path tail of length 2 `[<listener-root>, <method>]`
// after stripping any leading global wrappers.
function matchRootListener(path: readonly string[]): string | null {
  const tail = stripWrappers(path);
  if (tail.length !== 2) return null;
  const [root, method] = tail;
  if (root === undefined || method === undefined) return null;
  if (!FORBIDDEN_LISTENER_ROOTS.has(root)) return null;
  return FORBIDDEN_LISTENER_METHODS.get(method) ?? null;
}

// Match an access path that is just `[<wrapper>, <method>]` ⇒ a
// wrapper-rooted bare listener method (`globalThis.addEventListener`).
// The unstripped path length is always 2 here; stripped tail is 1.
function matchBareWrapperListener(path: readonly string[]): string | null {
  const tail = stripWrappers(path);
  if (tail.length !== 1) return null;
  const [method] = tail;
  if (method === undefined) return null;
  if (path.length === tail.length) return null;
  return FORBIDDEN_LISTENER_METHODS.get(method) ?? null;
}

// Match `[..wrappers.., document, <leaf>]` — a scene reading the
// ambient `document` for an attachment surface or DOM allocation
// helper.
function matchDocumentLeaf(path: readonly string[]): string | null {
  const tail = stripWrappers(path);
  if (tail.length !== 2) return null;
  const [root, leaf] = tail;
  if (root === undefined || leaf === undefined) return null;
  if (root !== 'document') return null;
  return FORBIDDEN_DOCUMENT_LEAVES.get(leaf) ?? null;
}

// Match any access path containing `ownerDocument` as a segment
// followed by a leaf that is NOT in `ALLOWED_OWNER_DOCUMENT_LEAVES`
// (codex review, cycle 2 — `ownerDocument` reached the same global
// surfaces as the ambient `document`). The canonical scene seam is
// `ctx.stage.ownerDocument.createElement(...)` — every other Document
// surface (`ownerDocument.addEventListener`, `ownerDocument.body`,
// `ownerDocument.querySelector`, `ownerDocument.appendChild`, ...)
// is the same activation-bypass hazard as the ambient form.
//
// The matcher walks every adjacent pair in the path (not just the
// tail) because chained access like
// `ctx.stage.ownerDocument.body.appendChild` carries the leak in
// the MIDDLE of the path, not at the tail. Allocation helpers
// reach a returned element (`<el>.setAttribute`, `<el>.appendChild`
// on a NEW node) — those are scene-owned activation state, not a
// bypass.
function matchOwnerDocumentLeaf(path: readonly string[]): string | null {
  for (let i = 0; i < path.length - 1; i += 1) {
    if (path[i] !== 'ownerDocument') continue;
    const leaf = path[i + 1];
    if (leaf === undefined) continue;
    if (ALLOWED_OWNER_DOCUMENT_LEAVES.has(leaf)) continue;
    // Listener methods on ownerDocument are listener leaks under
    // any seam — surface the dedicated listener label.
    const listenerLabel = FORBIDDEN_LISTENER_METHODS.get(leaf);
    if (listenerLabel) return listenerLabel;
    // Forbidden document leaves keep their original label; the
    // ambient and ownerDocument-reached forms share the same
    // attachment hazard.
    const docLabel = FORBIDDEN_DOCUMENT_LEAVES.get(leaf);
    if (docLabel) return docLabel;
    // Any other leaf on ownerDocument is also a bypass surface;
    // generic finding so a new Document API doesn't slip past the
    // explicit tables (codex review, cycle 2).
    return `ctx.stage.ownerDocument.${leaf} (scene reaches Document surface outside allocation helpers — only createElement-style allocation is permitted)`;
  }
  return null;
}

// Match `[..wrappers.., <PROTOTYPE_ROOT>, prototype, <anything>]`
// — a prototype monkey-patch access (the caller decides whether
// the access is being written, via `=` / `||=` / `Object.assign(...)`
// etc.).
function matchPrototypePatch(path: readonly string[]): string | null {
  const tail = stripWrappers(path);
  if (tail.length < 3) return null;
  const [root, prototype] = tail;
  if (root === undefined || prototype === undefined) return null;
  if (!FORBIDDEN_PROTOTYPE_ROOTS.has(root)) return null;
  if (prototype !== 'prototype') return null;
  return `${root}.prototype monkey-patch (scene mutates DOM-global prototype)`;
}

// Match `[..wrappers.., <PROTOTYPE_ROOT>, prototype]` — the bare
// prototype object handed to a mutation call like
// `Object.defineProperty(EventTarget.prototype, ...)`.
function matchPrototypeTarget(path: readonly string[]): string | null {
  const tail = stripWrappers(path);
  if (tail.length !== 2) return null;
  const [root, prototype] = tail;
  if (root === undefined || prototype === undefined) return null;
  if (!FORBIDDEN_PROTOTYPE_ROOTS.has(root)) return null;
  if (prototype !== 'prototype') return null;
  return `${root}.prototype monkey-patch via mutation API (scene mutates DOM-global prototype)`;
}

// Return the access path of a `new <Name>(...)` / `<Name>(...)`
// call's *callee* expression, or null when the callee is not an
// access path.
function calleeAccessPath(node: ts.CallExpression | ts.NewExpression): readonly string[] | null {
  const callee = unwrap(node.expression);
  if (ts.isIdentifier(callee)) return [callee.text];
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    return getAccessPath(callee);
  }
  return null;
}

// True when `path` (after stripping leading global wrappers) is a
// single-segment access whose name is a forbidden observer
// constructor.
function matchObserverCtor(path: readonly string[]): string | null {
  const tail = stripWrappers(path);
  if (tail.length !== 1) return null;
  const name = tail[0];
  if (name === undefined) return null;
  return FORBIDDEN_OBSERVER_CTORS.get(name) ?? null;
}

// True when `kind` is any assignment operator: `=`, `+=`, `-=`,
// `*=`, `/=`, `%=`, `**=`, `<<=`, `>>=`, `>>>=`, `&=`, `|=`, `^=`,
// `&&=`, `||=`, `??=`. Any of these on a forbidden prototype path
// is a monkey-patch.
function isAssignmentToken(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

// Recognised mutation-API callees that, when passed a forbidden
// prototype as their FIRST argument, are equivalent to a direct
// monkey-patch assignment. The matcher is access-path-anchored on
// the wrapper / bare form so `Object.defineProperty(...)`,
// `globalThis.Object.defineProperty(...)`,
// `Reflect.set(...)`, etc. all match.
const MUTATION_API_CALLEES: ReadonlySet<string> = new Set([
  'Object.defineProperty',
  'Object.defineProperties',
  'Object.assign',
  'Object.setPrototypeOf',
  'Reflect.set',
  'Reflect.defineProperty',
  'Reflect.setPrototypeOf',
]);

// Render the access path of a call's callee as a dotted string
// (after wrapper stripping) so it can be matched against
// `MUTATION_API_CALLEES`. Returns null for non-resolvable callees.
function calleeMutationApiName(
  callExpr: ts.CallExpression,
  aliases: ReadonlyMap<string, readonly string[]>,
): string | null {
  const callee = unwrap(callExpr.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null;
  const rawPath = getAccessPath(callee);
  const path = resolveAliasedPath(rawPath, aliases);
  if (!path) return null;
  const tail = stripWrappers(path);
  if (tail.length !== 2) return null;
  return `${tail[0]}.${tail[1]}`;
}

// Given a wrapper-stripped source path `tail` and a destructured
// property name, return the per-surface label that applies, or
// null when the destructuring is not a Q004 hazard.
//
// Source-path semantics:
//   - `tail.length === 0` → source IS a global wrapper
//     (`const { addEventListener } = window`,
//     `const { MutationObserver } = globalThis`). Listener methods,
//     observer constructors, and `document` itself are bare globals
//     reachable on the wrapper; destructuring them strips the
//     wrapper anchor and leaves a bound local that the existing
//     bare-identifier branch cannot recognise.
//   - `tail.length === 1`, first segment `'document'` →
//     destructuring an attachment / mutation / query leaf out of
//     the ambient document (`const { body } = document`,
//     `const { addEventListener } = document`).
//   - `tail.length === 1`, first segment is a listener root other
//     than `document` (handled by wrappers above) → listener
//     methods apply.
//   - `tail.length === 1`, first segment is a prototype root →
//     destructured `prototype` is a live handle to the DOM-global
//     prototype object; flag.
function matchDestructuredMemberLabel(tail: readonly string[], propName: string): string | null {
  if (tail.length === 0) {
    // Source is a wrapper. Listener methods, observer ctors, and
    // a destructured `document` are reachable bare globals.
    const listenerLabel = FORBIDDEN_LISTENER_METHODS.get(propName);
    if (listenerLabel) return listenerLabel;
    const ctorLabel = FORBIDDEN_OBSERVER_CTORS.get(propName);
    if (ctorLabel) return ctorLabel;
    // `const { document } = window` would let downstream code call
    // every `document.*` surface on the destructured local without
    // any wrapper anchor. Treat it like a wrapper-rooted document
    // read so the gate names the hazard.
    if (propName === 'document') {
      return 'document (scene destructures ambient document binding — route DOM through ctx.stage)';
    }
    return null;
  }
  if (tail.length !== 1) return null;
  const root = tail[0];
  if (root === undefined) return null;
  if (root === 'document') {
    const docLabel = FORBIDDEN_DOCUMENT_LEAVES.get(propName);
    if (docLabel) return docLabel;
    const listenerLabel = FORBIDDEN_LISTENER_METHODS.get(propName);
    if (listenerLabel) return listenerLabel;
    return null;
  }
  if (FORBIDDEN_LISTENER_ROOTS.has(root)) {
    return FORBIDDEN_LISTENER_METHODS.get(propName) ?? null;
  }
  if (FORBIDDEN_PROTOTYPE_ROOTS.has(root) && propName === 'prototype') {
    return `${root}.prototype destructure (scene captures DOM-global prototype handle)`;
  }
  return null;
}

function scanQ004(sourceFile: ts.SourceFile): readonly SourceFinding[] {
  const exempted = collectLineExemptions(sourceFile, ALLOW_TAG);
  const aliases = collectAliases(sourceFile);
  const findings: SourceFinding[] = [];
  const seen = new Set<string>();

  // Parameter-shadow guard (codex review, cycle 3 — "alias
  // resolution ignores lexical scope"). Returns the alias map when
  // the access's root identifier is NOT shadowed by a closer
  // function/method/arrow parameter of the same name; an empty
  // map otherwise. Callers use the returned map with
  // `resolveAliasedPath` so a parameter `doc` does not inherit a
  // module-level `const doc = document` binding. The collector
  // itself is not affected because it builds the map from module-
  // level declarations whose root nodes are themselves at module
  // scope.
  const EMPTY_ALIASES: ReadonlyMap<string, readonly string[]> = new Map();
  const aliasMapForExpr = (expr: ts.Expression | null): ReadonlyMap<string, readonly string[]> => {
    if (expr === null) return aliases;
    const root = rootIdentifier(expr);
    if (root && hasParameterShadow(root)) return EMPTY_ALIASES;
    return aliases;
  };

  const record = (node: ts.Node, label: string): void => {
    const start = node.getStart(sourceFile);
    const key = `${start}::${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    if (exempted.has(line)) return;
    findings.push({
      file: sourceFile.fileName,
      line: line + 1,
      text: lineText(sourceFile, line).trim(),
      label,
    });
  };

  // Walk an object binding pattern's elements and record findings
  // when the source initializer (alias-resolved + wrapper-stripped)
  // is a restricted root AND the destructured property names a
  // forbidden member (codex review, cycle 2). The tail's first
  // segment after wrapper stripping decides which member tables
  // apply: empty tail (= source IS a wrapper) → listener methods,
  // observer ctors, and document leaves apply (wrapper-rooted
  // `document` / `addEventListener` reach the same surface);
  // tail `[document]` → document leaves apply; tail `[<root>]`
  // where root is a listener root → listener methods apply;
  // tail `[<root>]` where root is a prototype root → `prototype`
  // destructured property applies.
  const recordRestrictedMemberDestructuring = (
    initializer: ts.Expression,
    pattern: ts.ObjectBindingPattern,
  ): void => {
    const initPath = resolveAliasedPath(
      getAccessPathFromExpression(initializer),
      aliasMapForExpr(initializer),
    );
    if (!initPath) return;
    const tail = stripWrappers(initPath);
    for (const element of pattern.elements) {
      const propNode = element.propertyName ?? element.name;
      const propText = ts.isIdentifier(propNode)
        ? propNode.text
        : ts.isStringLiteralLike(propNode)
          ? propNode.text
          : null;
      if (!propText) continue;
      const finding = matchDestructuredMemberLabel(tail, propText);
      if (finding) record(element, `${finding} (via destructuring)`);
    }
  };

  const recordRestrictedMemberDestructuringAssignment = (
    initializer: ts.Expression,
    pattern: ts.ObjectLiteralExpression,
  ): void => {
    const initPath = resolveAliasedPath(
      getAccessPathFromExpression(initializer),
      aliasMapForExpr(initializer),
    );
    if (!initPath) return;
    const tail = stripWrappers(initPath);
    for (const property of pattern.properties) {
      let propText: string | null = null;
      const node: ts.Node = property;
      if (ts.isShorthandPropertyAssignment(property)) {
        propText = property.name.text;
      } else if (ts.isPropertyAssignment(property)) {
        const key = property.name;
        if (ts.isIdentifier(key)) propText = key.text;
        else if (ts.isStringLiteralLike(key)) propText = key.text;
      }
      if (!propText) continue;
      const finding = matchDestructuredMemberLabel(tail, propText);
      if (finding) record(node, `${finding} (via destructuring)`);
    }
  };

  const visit = (node: ts.Node): void => {
    // 1. Property / element access chains. The access path is
    //    alias-resolved through `collectAliases` so a file-local
    //    rebinding of a restricted root
    //    (`const doc = document; doc.addEventListener(...)`) matches
    //    the same per-surface tables as the canonical form. Four
    //    matchers run on every (non-type-position) access path:
    //    (a) listener call (root.method or wrapper.method),
    //    (b) ambient-document leaf (document.body, etc.),
    //    (c) prototype-patch (when the access is the LHS of an
    //        assignment-operator BinaryExpression),
    //    (d) computed-restricted-root bypass (when getAccessPath
    //        returned null because of a computed subscript).
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (!isInTypePosition(node)) {
        const rawPath = getAccessPath(node);
        const localAliases = aliasMapForExpr(node);
        const path = resolveAliasedPath(rawPath, localAliases);
        if (path) {
          const listenerLabel = matchRootListener(path) ?? matchBareWrapperListener(path);
          if (listenerLabel) record(node, listenerLabel);
          const documentLabel = matchDocumentLeaf(path);
          if (documentLabel) record(node, documentLabel);
          const ownerDocLabel = matchOwnerDocumentLeaf(path);
          if (ownerDocLabel) record(node, ownerDocLabel);
          const parent = node.parent;
          const isLhsOfAssignment =
            parent &&
            ts.isBinaryExpression(parent) &&
            isAssignmentToken(parent.operatorToken.kind) &&
            parent.left === node;
          if (isLhsOfAssignment) {
            const protoLabel = matchPrototypePatch(path);
            if (protoLabel) record(node, protoLabel);
          }
        } else if (isComputedRestrictedRootAccess(node, localAliases)) {
          record(node, 'computed restricted-root access (possible PUL-Q004 bypass)');
        }
      }
    }

    // 2. `new <Name>(...)` / `<Name>(...)` whose callee resolves to
    //    a forbidden observer constructor OR a bare global listener
    //    function (codex review, cycle 3 — `addEventListener('resize',
    //    handler)` and `removeEventListener('resize', handler)` are
    //    valid global Window operations when called bare in a browser
    //    scene). Wrapper-rooted forms, alias-resolved bare forms,
    //    and computed-subscript forms are all covered.
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const rawCalleePath = calleeAccessPath(node);
      const localAliases = aliasMapForExpr(node.expression);
      const calleePath = resolveAliasedPath(rawCalleePath, localAliases);
      if (calleePath) {
        const ctorLabel = matchObserverCtor(calleePath);
        if (ctorLabel) record(node, ctorLabel);
        // Bare global listener call (Q004 cycle-3 finding 1). The
        // callee path after alias resolution is a single segment
        // `[addEventListener]` / `[removeEventListener]` (or wrapper-
        // rooted, in which case it has length ≥ 2 and is already
        // covered by branch 1's `matchBareWrapperListener`). Restrict
        // to CallExpression (not NewExpression — `new addEventListener`
        // is not the listener bypass we are guarding).
        if (ts.isCallExpression(node) && calleePath.length === 1) {
          const bareLabel = FORBIDDEN_LISTENER_METHODS.get(calleePath[0] ?? '');
          if (bareLabel) record(node, bareLabel);
        }
      } else if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        isComputedRestrictedRootAccess(callee, localAliases)
      ) {
        record(node, 'computed restricted-root access (possible PUL-Q004 bypass)');
      }
    }

    // 3. Mutation-API monkey-patches: `Object.defineProperty(<PROTO>, ...)`,
    //    `Object.assign(<PROTO>, ...)`, `Reflect.set(<PROTO>, ...)`,
    //    etc. The FIRST argument's access path is checked against
    //    `matchPrototypeTarget`; the callee is recognised by its
    //    dotted name in `MUTATION_API_CALLEES`.
    if (ts.isCallExpression(node)) {
      const calleeLocalAliases = aliasMapForExpr(node.expression);
      const apiName = calleeMutationApiName(node, calleeLocalAliases);
      if (apiName && MUTATION_API_CALLEES.has(apiName)) {
        const firstArg = node.arguments[0];
        if (firstArg) {
          const argLocalAliases = aliasMapForExpr(firstArg);
          const argPath = resolveAliasedPath(
            getAccessPathFromExpression(firstArg),
            argLocalAliases,
          );
          if (argPath) {
            const protoLabel = matchPrototypeTarget(argPath);
            if (protoLabel) record(node, protoLabel);
          }
        }
      }
    }

    // 4. Destructuring of forbidden members from a restricted root
    //    (codex review, cycle 2 — class finding "destructuring
    //    restricted members bypasses the scanner"). Covers BOTH
    //    `const { ... } = <root>` (VariableDeclaration) AND
    //    `({ ... } = <root>)` (BinaryExpression LHS object literal).
    //    For each destructured property name:
    //      - `addEventListener` / `removeEventListener` from a
    //        listener root or wrapper → listener leak.
    //      - any document leaf from `document` / wrapper-rooted
    //        `document` → document attachment leak.
    //      - `prototype` from any forbidden prototype root →
    //        prototype-handle leak (the local binding is then a
    //        live reference to the DOM-global prototype object).
    //    String-literal keys are accepted alongside identifier keys
    //    (same precedent as Q003's destructuring pass).
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name)
    ) {
      recordRestrictedMemberDestructuring(node.initializer, node.name);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(node.left)
    ) {
      recordRestrictedMemberDestructuringAssignment(node.right, node.left);
    }

    // 5. Bare identifier reads of a forbidden observer constructor
    //    (`const Obs = MutationObserver;`). Skip declaration sites,
    //    type positions, property-name positions, and the leaf of a
    //    `new ...(...)` / `...(...)` (branch 2 already handled that
    //    callee position).
    if (ts.isIdentifier(node) && !isInTypePosition(node) && !isDeclarationName(node)) {
      if (!isPropertyNamePosition(node)) {
        const direct = FORBIDDEN_OBSERVER_CTORS.get(node.text);
        if (direct !== undefined) {
          const parent = node.parent;
          const isCalleeOfCallOrNew =
            parent &&
            (ts.isNewExpression(parent) || ts.isCallExpression(parent)) &&
            parent.expression === node;
          if (!isCalleeOfCallOrNew) {
            record(node, direct);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function findingsOf(source: string, file = 'src/scenes/fake.ts'): readonly SourceFinding[] {
  return scanQ004(parseSource(source, file));
}

// --- Tests -----------------------------------------------------------

describe('PUL-Q004 — resource cleanup completeness (source scan)', () => {
  describe('scanner self-tests', () => {
    describe('global listener attach / detach', () => {
      it.each([
        ['document.addEventListener("click", () => undefined);'],
        ['document.removeEventListener("click", handler);'],
        ['window.addEventListener("resize", () => undefined);'],
        ['window.removeEventListener("resize", handler);'],
      ])('flags %s', (source) => {
        const findings = findingsOf(`declare const handler: () => void; ${source}`);
        expect(findings.length).toBeGreaterThan(0);
        const labels = findings.map((f) => f.label);
        expect(
          labels.some(
            (l) =>
              l.startsWith('global addEventListener') || l.startsWith('global removeEventListener'),
          ),
        ).toBe(true);
      });

      it.each([
        ['globalThis.addEventListener("click", () => undefined);', 'global addEventListener'],
        ['window.addEventListener("click", () => undefined);', 'global addEventListener'],
        ['self.addEventListener("click", () => undefined);', 'global addEventListener'],
        ['global.addEventListener("click", () => undefined);', 'global addEventListener'],
        ['globalThis.removeEventListener("click", handler);', 'global removeEventListener'],
      ])('flags wrapper-rooted listener `%s` with label `%s`', (source, expectedLabel) => {
        // Label assertion (test-quality review): a regression that
        // routed wrapper-rooted listener access through the wrong
        // matcher would still flag the line but emit the wrong
        // remediation hint; pin the exact prefix per source/label
        // pair so the diagnostic contract is structurally enforced.
        const findings = findingsOf(`declare const handler: () => void; ${source}`);
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith(expectedLabel))).toBe(true);
      });

      it('flags `document["addEventListener"](...)` (string-literal subscript) with the listener label', () => {
        const findings = findingsOf(
          'declare const handler: () => void; document["addEventListener"]("click", handler);',
        );
        const labels = findings.map((f) => f.label);
        // Test-quality review (cycle 1): pin the listener label so a
        // regression that routed string-literal subscripts through
        // `isComputedRestrictedRootAccess` (wrong label: "computed
        // restricted-root access") would fail this test rather than
        // pass silently.
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('passes `ctx.stage.addEventListener(...)` through the source-policy gate (gate scope, codex review cycle 3)', () => {
        // Codex cycle 3 surfaced that the gate enshrined this
        // pattern as "OK" when in fact the runtime contract does
        // NOT yet expose an activation-bound listener API on
        // `ctx.stage` — a stage listener attached here will survive
        // `cleanup(ctx)` unless the scene removes it manually OR
        // wires the call to the navigation `AbortSignal` itself.
        // The source-policy gate scopes to ambient/global bypass
        // closure; cleanup-completeness for `ctx.stage` listeners
        // is the loader/resolver activation-facade follow-up named
        // in the preflight ("True per-scene activation contexts
        // ... are a documented resolver follow-up"). This test
        // pins the gate's scope rather than claiming the runtime
        // proves cleanup for the pattern.
        const findings = findingsOf(
          'declare const ctx: { stage: { addEventListener(e: string, h: () => void): void } }; ctx.stage.addEventListener("click", () => undefined);',
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag `signal.addEventListener("abort", ...)` (signal-bound listener)', () => {
        const findings = findingsOf(
          'declare const signal: AbortSignal; signal.addEventListener("abort", () => undefined);',
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag a method named `addEventListener` on a non-global object', () => {
        const findings = findingsOf(
          'declare const obj: { addEventListener(e: string, h: () => void): void }; obj.addEventListener("click", () => undefined);',
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag forbidden vocabulary inside a `//` comment', () => {
        expect(findingsOf('// document.addEventListener is forbidden in scenes')).toEqual([]);
      });

      it('does NOT flag forbidden vocabulary inside a string literal', () => {
        expect(findingsOf('const note = "document.addEventListener";')).toEqual([]);
      });
    });

    describe('observer construction', () => {
      it.each([
        ['MutationObserver'],
        ['IntersectionObserver'],
        ['ResizeObserver'],
        ['PerformanceObserver'],
      ])('flags `new %s(() => undefined)`', (name) => {
        const findings = findingsOf(`new ${name}(() => undefined);`);
        expect(findings.length).toBeGreaterThan(0);
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes(name))).toBe(true);
      });

      it.each([
        ['new globalThis.MutationObserver(() => undefined);', 'MutationObserver'],
        ['new window.IntersectionObserver(() => undefined);', 'IntersectionObserver'],
        ['new self.ResizeObserver(() => undefined);', 'ResizeObserver'],
        ['new global.PerformanceObserver(() => undefined);', 'PerformanceObserver'],
      ])('flags wrapper-rooted `%s`', (source, name) => {
        const findings = findingsOf(source);
        expect(findings.length).toBeGreaterThan(0);
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes(name))).toBe(true);
      });

      it('flags `new window["MutationObserver"](() => undefined)` (string-literal subscript) with the observer label', () => {
        const findings = findingsOf('new window["MutationObserver"](() => undefined);');
        const labels = findings.map((f) => f.label);
        // Test-quality review (cycle 1): pin the observer label so a
        // regression that routed string-literal subscripts through
        // `isComputedRestrictedRootAccess` (wrong label) would fail
        // this test rather than pass silently.
        expect(labels.some((l) => l.includes('MutationObserver'))).toBe(true);
      });

      it('flags a bare `MutationObserver` identifier read (no construction) — pins branch 5 bare-identifier detection', () => {
        // Test-quality review (cycle 1, critical finding): the
        // combined assignment+construction test was satisfied by
        // either branch 5 (bare identifier read on the RHS) OR
        // branch 2 (alias-resolved `new Obs(...)` callee). Without
        // separating, a regression that broke alias collection could
        // pass because branch 5 still fires. This test exercises
        // branch 5 in isolation: the bare-identifier read with no
        // `new` and no alias use.
        const findings = findingsOf('declare let used: unknown; used = MutationObserver;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes('MutationObserver'))).toBe(true);
      });

      it('flags `const Obs = MutationObserver; new Obs(...)` via alias resolution only — pins tryRegisterDirect bare-ctor alias path', () => {
        // Test-quality review (cycle 1, critical finding): cover the
        // `tryRegisterDirect` path where `ALIAS_ROOTS.has(inner.text)`
        // is true for a bare forbidden-ctor identifier. Without this
        // test the alias-collection code path is asserted only via
        // a combined test that branch 5 could satisfy alone. Here the
        // SCANNER finds two findings (one on the RHS bare read, one
        // on the `new Obs(...)` callee); we assert both exist AND
        // that the `new Obs(...)` call's resolved path produces the
        // observer label — proving the alias map carries the ctor
        // identity forward.
        const findings = findingsOf('const Obs = MutationObserver; new Obs(() => undefined);');
        const labels = findings.map((f) => f.label);
        const observerFindings = findings.filter((f) => f.label.includes('MutationObserver'));
        // At least 2: the bare-identifier read AND the alias-resolved
        // call. If alias resolution broke we would see only 1.
        expect(observerFindings.length).toBeGreaterThanOrEqual(2);
        expect(labels.some((l) => l.includes('MutationObserver'))).toBe(true);
      });

      it('does NOT flag a class member named `MutationObserver`', () => {
        const findings = findingsOf('class C { MutationObserver(): void {} }');
        expect(findings).toEqual([]);
      });

      it('does NOT flag a type-position reference to `MutationObserver`', () => {
        const findings = findingsOf('declare function f(o: MutationObserver): void;');
        expect(findings).toEqual([]);
      });

      it('does NOT flag a property named `MutationObserver` on a non-global object', () => {
        const findings = findingsOf(
          'declare const obj: { MutationObserver: () => void }; obj.MutationObserver();',
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag forbidden vocabulary inside a string literal', () => {
        expect(findingsOf('const note = "MutationObserver";')).toEqual([]);
      });
    });

    describe('prototype monkey-patches', () => {
      it.each([
        ['EventTarget.prototype.addEventListener = wrapped;', 'EventTarget'],
        ['Element.prototype.click = wrapped;', 'Element'],
        ['Node.prototype.appendChild = wrapped;', 'Node'],
        ['Document.prototype.querySelector = wrapped;', 'Document'],
        ['Window.prototype.alert = wrapped;', 'Window'],
        ['HTMLElement.prototype.focus = wrapped;', 'HTMLElement'],
      ])('flags `%s`', (source, root) => {
        const findings = findingsOf(`declare const wrapped: unknown; ${source}`);
        expect(findings.length).toBeGreaterThan(0);
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes(`${root}.prototype monkey-patch`))).toBe(true);
      });

      it('flags `globalThis.EventTarget.prototype.addEventListener = wrapped` through wrapper with the prototype-patch label', () => {
        const findings = findingsOf(
          'declare const wrapped: unknown; globalThis.EventTarget.prototype.addEventListener = wrapped;',
        );
        const labels = findings.map((f) => f.label);
        // Test-quality review (cycle 1): pin the prototype-patch label
        // so a regression in wrapper-stripping or label dispatch
        // (emitting a document-leaf or listener label instead) fails
        // the test rather than passing silently.
        expect(labels.some((l) => l.includes('EventTarget.prototype monkey-patch'))).toBe(true);
      });

      it.each([
        ['EventTarget.prototype.foo ||= wrapped;', 'EventTarget'],
        ['Element.prototype.foo ??= wrapped;', 'Element'],
        ['Node.prototype.foo &&= wrapped;', 'Node'],
        ['Document.prototype.count += 1;', 'Document'],
        ['HTMLElement.prototype.flags |= 1;', 'HTMLElement'],
      ])(
        'flags compound assignment `%s` (covers cycle-1 one-off "only direct equals")',
        (source, root) => {
          const findings = findingsOf(`declare const wrapped: unknown; ${source}`);
          expect(findings.length).toBeGreaterThan(0);
          const labels = findings.map((f) => f.label);
          expect(labels.some((l) => l.includes(`${root}.prototype monkey-patch`))).toBe(true);
        },
      );

      it.each([
        [
          'Object.defineProperty(EventTarget.prototype, "addEventListener", { value: wrapped });',
          'EventTarget',
        ],
        ['Object.defineProperties(Element.prototype, { x: { value: wrapped } });', 'Element'],
        ['Object.assign(Node.prototype, { appendChild: wrapped });', 'Node'],
        ['Object.setPrototypeOf(Document.prototype, null);', 'Document'],
        ['Reflect.set(Window.prototype, "alert", wrapped);', 'Window'],
        [
          'Reflect.defineProperty(HTMLElement.prototype, "focus", { value: wrapped });',
          'HTMLElement',
        ],
        ['Reflect.setPrototypeOf(EventTarget.prototype, null);', 'EventTarget'],
      ])('flags mutation-API monkey-patch `%s` (covers cycle-1 one-off)', (source, root) => {
        const findings = findingsOf(`declare const wrapped: unknown; ${source}`);
        expect(findings.length).toBeGreaterThan(0);
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes(`${root}.prototype monkey-patch`))).toBe(true);
      });

      it('does NOT flag a READ of `EventTarget.prototype.addEventListener`', () => {
        const findings = findingsOf('const orig = EventTarget.prototype.addEventListener;');
        expect(findings).toEqual([]);
      });

      it('does NOT flag an unrelated `prototype` assignment (non-DOM root)', () => {
        const findings = findingsOf(
          'class C {} declare const wrapped: () => void; C.prototype.method = wrapped;',
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag forbidden vocabulary inside a string literal', () => {
        expect(findingsOf('const note = "EventTarget.prototype monkey-patch";')).toEqual([]);
      });
    });

    describe('ambient-document leaf reads (DOM attachment boundary, cycle-1 one-off)', () => {
      it.each([
        ['document.body', 'document.body'],
        ['document.head', 'document.head'],
        ['document.documentElement', 'document.documentElement'],
        ['document.body.appendChild(node);', 'document.body'],
        ['document.appendChild(node);', 'document.appendChild'],
        ['document.querySelector(".target");', 'document.querySelector'],
        ['document.querySelectorAll("li");', 'document.querySelectorAll'],
        ['document.getElementById("target");', 'document.getElementById'],
        ['document.createElement("div");', 'document.createElement'],
        ['document.createTextNode("x");', 'document.createTextNode'],
        ['document.createDocumentFragment();', 'document.createDocumentFragment'],
        ['document.write("evil");', 'document.write'],
      ])('flags `%s`', (source, surface) => {
        const findings = findingsOf(`declare const node: unknown; const _ = ${source}`);
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith(surface))).toBe(true);
      });

      it.each([
        ['globalThis.document.body', 'document.body'],
        ['window.document.head', 'document.head'],
        ['self.document.querySelector(".x");', 'document.querySelector'],
      ])('flags wrapper-rooted `%s` with label starting `%s`', (source, expectedSurface) => {
        // Test-quality review (cycle 1): pin the per-surface label
        // for wrapper-rooted document leaves. A regression in
        // `stripWrappers` or `matchDocumentLeaf` that emitted a
        // listener / observer / prototype label instead would fail
        // the test rather than pass silently.
        const findings = findingsOf(`const _ = ${source};`);
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith(expectedSurface))).toBe(true);
      });

      it('does NOT flag `ctx.stage.ownerDocument.createElement(...)` (canonical scene seam)', () => {
        const findings = findingsOf(
          'declare const ctx: { stage: { ownerDocument: { createElement(t: string): unknown } } }; ctx.stage.ownerDocument.createElement("div");',
        );
        expect(findings).toEqual([]);
      });

      it('passes `ctx.stage.appendChild(...)` through the source-policy gate (gate scope, codex review cycle 3)', () => {
        // Codex cycle 3 surfaced that the gate enshrined this
        // pattern as "guaranteed-clean" — but a scene can
        // `cleanup(ctx)` as a no-op and leak the attached node.
        // The source-policy gate enforces ambient/global bypass
        // closure (Q004's structural defense on the scene-author
        // side); proving stage-attached nodes are detached after
        // `cleanup(ctx)` is the loader/resolver activation-
        // ownership-tracker follow-up named in the preflight, not
        // this gate's contract. The test passes because the gate
        // is intentionally permissive on `ctx.stage.*` — banning
        // those would break the runtime's mount contract — NOT
        // because the runtime currently proves cleanup for them.
        const findings = findingsOf(
          'declare const ctx: { stage: { appendChild(n: unknown): unknown } }; declare const node: unknown; ctx.stage.appendChild(node);',
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag a `document` property of a non-ambient object', () => {
        const findings = findingsOf(
          'declare const fixture: { document: { body: unknown } }; const _ = fixture.document.body;',
        );
        expect(findings).toEqual([]);
      });
    });

    describe('file-local aliases (class finding, cycle 1)', () => {
      it('flags `const doc = document; doc.addEventListener(...)` through alias', () => {
        const findings = findingsOf(
          'const doc = document; doc.addEventListener("click", () => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('flags `const win = window; win.addEventListener(...)` through alias', () => {
        const findings = findingsOf(
          'const win = window; win.addEventListener("click", () => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('flags `const root = globalThis; root.addEventListener(...)` through alias', () => {
        const findings = findingsOf(
          'const root = globalThis; root.addEventListener("click", () => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('flags `const doc = document; doc.body` through alias', () => {
        const findings = findingsOf('const doc = document; const b = doc.body;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.body'))).toBe(true);
      });

      it('flags `const Obs = window.MutationObserver; new Obs(...)` (chained alias)', () => {
        const findings = findingsOf(
          'const Obs = window.MutationObserver; new Obs(() => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes('MutationObserver'))).toBe(true);
      });

      it('flags `const ET = EventTarget; ET.prototype.foo = wrapped` through alias', () => {
        const findings = findingsOf(
          'declare const wrapped: unknown; const ET = EventTarget; ET.prototype.foo = wrapped;',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('EventTarget.prototype monkey-patch'))).toBe(true);
      });

      it('flags `const w2 = win; w2.addEventListener(...)` after `const win = window` (alias of alias)', () => {
        const findings = findingsOf(
          'const win = window; const w2 = win; w2.addEventListener("click", () => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('flags `const { MutationObserver: Obs } = window; new Obs(...)` (destructured alias)', () => {
        const findings = findingsOf(
          'const { MutationObserver: Obs } = window; new Obs(() => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes('MutationObserver'))).toBe(true);
      });
    });

    describe('computed restricted-root access (class finding, cycle 1)', () => {
      it.each([
        // listener-root computed bypass
        ['document["add" + "EventListener"]("click", handler);'],
        ['window[`add${"Event"}Listener`]("click", handler);'],
        ['globalThis[key]("click", handler);'],
        // observer-ctor computed bypass
        ['new window["Mutation" + "Observer"](() => undefined);'],
        ['new globalThis[key2](() => undefined);'],
        // prototype-target computed bypass
        ['EventTarget.prototype["x" + suffix] = wrapped;'],
      ])('flags computed bypass `%s`', (source) => {
        const findings = findingsOf(
          `declare const handler: () => void; declare const key: string; declare const key2: string; declare const suffix: string; declare const wrapped: unknown; ${source}`,
        );
        const labels = findings.map((f) => f.label);
        // Either the specific surface OR the conservative bypass
        // label matches — both indicate the gate caught the attempt.
        expect(
          labels.some(
            (l) =>
              l.includes('PUL-Q004 bypass') ||
              l.includes('monkey-patch') ||
              l.startsWith('global '),
          ),
        ).toBe(true);
      });

      it('does NOT flag computed access on a non-restricted root', () => {
        const findings = findingsOf(
          'declare const obj: Record<string, (e: string, h: () => void) => void>; declare const key: string; obj[key]("click", () => undefined);',
        );
        expect(findings).toEqual([]);
      });
    });

    describe('wrapper-to-wrapper aliases (class finding, cycle 2)', () => {
      // `tryRegisterDirect` used to require the wrapper-stripped tail
      // to have length 1 — so `const win = globalThis.window`
      // (both segments are wrappers, stripped tail is empty) was
      // never registered, leaving downstream `win.addEventListener`,
      // `new win.MutationObserver(...)`, `win.document.body` as
      // silent bypasses. The cycle-2 fix registers the local to a
      // canonical wrapper (`globalThis`) when the resolved path is
      // a non-empty wrapper chain.
      it('flags `win.addEventListener(...)` after `const win = globalThis.window`', () => {
        const findings = findingsOf(
          'const win = globalThis.window; win.addEventListener("click", () => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('flags `new win.MutationObserver(...)` after `const win = globalThis.window`', () => {
        const findings = findingsOf(
          'const win = globalThis.window; new win.MutationObserver(() => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes('MutationObserver'))).toBe(true);
      });

      it('flags `win.document.body` after `const win = window.self`', () => {
        const findings = findingsOf('const win = window.self; const b = win.document.body;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.body'))).toBe(true);
      });

      it('flags `s.addEventListener(...)` after `const s = self.globalThis`', () => {
        const findings = findingsOf(
          'const s = self.globalThis; s.addEventListener("click", () => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });
    });

    describe('bare global listener calls (class finding, cycle 3)', () => {
      // `addEventListener('resize', handler)` and `removeEventListener('resize', handler)`
      // are valid global Window operations in browser scenes. The
      // cycle-1/2 scanner required a wrapper-rooted access (path
      // length > tail length); a bare CALL with no prefix was a
      // silent bypass. Branch 2 of the visitor now records bare
      // listener calls when the callee resolves to a single
      // segment in `FORBIDDEN_LISTENER_METHODS`.
      it('flags bare `addEventListener("resize", handler)`', () => {
        const findings = findingsOf(
          'declare const handler: () => void; addEventListener("resize", handler);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('flags bare `removeEventListener("resize", handler)`', () => {
        const findings = findingsOf(
          'declare const handler: () => void; removeEventListener("resize", handler);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global removeEventListener'))).toBe(true);
      });

      it('flags bare listener call through alias', () => {
        const findings = findingsOf(
          'declare const handler: () => void; const ael = addEventListener; ael("resize", handler);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('does NOT flag a local function named `addEventListener`', () => {
        // A local function declaration shadows the global; this is
        // a parameter/declaration position handled by the visitor's
        // `isDeclarationName` filter on the leaf-identifier branch.
        // The CallExpression branch with calleePath length 1 still
        // fires on the call site, but for THIS shape the local is
        // a function declaration, NOT an alias to the global, and
        // the call resolves to that local. The gate currently
        // cannot distinguish a local function declaration from a
        // local alias of the global at a call site by access path
        // alone — so this test pins the BARE call as flagged
        // (the safer default; a scene defining its own
        // `addEventListener` function should rename it). When
        // codex / SonarCloud surface this as a false positive on
        // a real production scene, the fix is symbol-table-based
        // resolution; for now the bare-listener invariant is the
        // higher-value guard.
        const findings = findingsOf(
          'function addEventListener(e: string, h: () => void): void {} addEventListener("ev", () => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });
    });

    describe('subresource aliases — ownerDocument & prototype (class finding, cycle 3)', () => {
      // `const ownerDoc = stage.ownerDocument; ownerDoc.body` used
      // to bypass `matchOwnerDocumentLeaf` because the local alias
      // did not carry the `ownerDocument` segment forward. The
      // alias map now records multi-segment canonical paths;
      // `ownerDoc → ['ownerDocument']` and
      // `proto → ['<PROTO_ROOT>', 'prototype']` resolve downstream
      // access to the full restricted surface.
      it('flags `ownerDoc.body` after `const ownerDoc = stage.ownerDocument`', () => {
        const findings = findingsOf(
          'declare const stage: { ownerDocument: { body: unknown } }; const ownerDoc = stage.ownerDocument; const b = ownerDoc.body;',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.body'))).toBe(true);
      });

      it('flags `ownerDoc.addEventListener(...)` after `const ownerDoc = stage.ownerDocument`', () => {
        const findings = findingsOf(
          'declare const stage: { ownerDocument: { addEventListener(e: string, h: () => void): void } }; const ownerDoc = stage.ownerDocument; ownerDoc.addEventListener("click", () => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('flags `ownerDoc.querySelector(...)` after `const ownerDoc = stage.ownerDocument`', () => {
        const findings = findingsOf(
          'declare const stage: { ownerDocument: { querySelector(s: string): unknown } }; const ownerDoc = stage.ownerDocument; ownerDoc.querySelector(".target");',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.querySelector'))).toBe(true);
      });

      it('does NOT flag `ownerDoc.createElement(...)` after `const ownerDoc = stage.ownerDocument` (allowed)', () => {
        const findings = findingsOf(
          'declare const stage: { ownerDocument: { createElement(t: string): unknown } }; const ownerDoc = stage.ownerDocument; ownerDoc.createElement("div");',
        );
        expect(findings).toEqual([]);
      });

      it('flags `proto.foo = wrapped` after `const proto = EventTarget.prototype`', () => {
        const findings = findingsOf(
          'declare const wrapped: unknown; const proto = EventTarget.prototype; proto.foo = wrapped;',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('EventTarget.prototype monkey-patch'))).toBe(true);
      });

      it('flags `Object.defineProperty(proto, ...)` after `const proto = Element.prototype`', () => {
        const findings = findingsOf(
          'declare const wrapped: unknown; const proto = Element.prototype; Object.defineProperty(proto, "click", { value: wrapped });',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('Element.prototype monkey-patch'))).toBe(true);
      });

      it('does NOT register `const proto = MyClass.prototype` (non-DOM root)', () => {
        const findings = findingsOf(
          'declare const wrapped: unknown; class MyClass {} const proto = MyClass.prototype; proto.foo = wrapped;',
        );
        expect(findings).toEqual([]);
      });
    });

    describe('document.defaultView (class finding, cycle 3)', () => {
      // `document.defaultView` hands out the Window global; access
      // chains through it reach the same Window listeners/observers
      // that Q004 bans via `window.*`. The fix added `defaultView`
      // to FORBIDDEN_DOCUMENT_LEAVES so the inner `document.defaultView`
      // read fires at the bypass point.
      it('flags `document.defaultView`', () => {
        const findings = findingsOf('const w = document.defaultView;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.defaultView'))).toBe(true);
      });

      it('flags `document.defaultView?.addEventListener(...)` at the defaultView read', () => {
        const findings = findingsOf(
          'declare const handler: () => void; document.defaultView?.addEventListener("resize", handler);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.defaultView'))).toBe(true);
      });

      it('flags `globalThis.document.defaultView` (wrapper-rooted)', () => {
        const findings = findingsOf('const w = globalThis.document.defaultView;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.defaultView'))).toBe(true);
      });
    });

    describe('parameter-shadow guard (class finding, cycle 3)', () => {
      // `function helper(doc: T) { doc.addEventListener(...) }` should
      // NOT be misclassified as the global `document` listener just
      // because a file-global `const doc = document` exists elsewhere.
      // The visitor's `aliasMapForExpr` checks `hasParameterShadow`
      // on the access's root identifier and skips alias resolution
      // when shadowed.
      it('does NOT misclassify `doc.addEventListener` inside `function helper(doc)` when a module-level `const doc = document` exists', () => {
        const findings = findingsOf(
          'const doc = document; function helper(doc: { addEventListener(e: string, h: () => void): void }) { doc.addEventListener("click", () => undefined); }',
        );
        // The module-level `const doc` is unused; the inner `doc`
        // is a parameter. The gate must NOT report a global
        // addEventListener for the parameter access. (The module-
        // level `const doc = document;` is not flagged on its own
        // — only access via the alias would be.)
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(false);
      });

      it('does NOT misclassify destructured parameter shadowing a module-level alias', () => {
        const findings = findingsOf(
          'const doc = document; const helper = ({ doc }: { doc: { body: unknown } }): unknown => doc.body;',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.body'))).toBe(false);
      });

      it('STILL flags `doc.addEventListener` when `doc` IS the module-level alias (no parameter shadowing)', () => {
        // Sanity: parameter-shadow guard must not over-trigger.
        const findings = findingsOf(
          'const doc = document; doc.addEventListener("click", () => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('parameter shadow inside an arrow function also suppresses alias resolution', () => {
        const findings = findingsOf(
          'const doc = document; const helper = (doc: { addEventListener(e: string, h: () => void): void }): void => { doc.addEventListener("ev", () => undefined); };',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(false);
      });
    });

    describe('destructured restricted members (class finding, cycle 2)', () => {
      // `collectAliases` already handled destructuring of an ambient
      // ROOT (`const { document } = window`) — but destructuring a
      // forbidden MEMBER from a restricted root
      // (`const { body } = document`, `const { addEventListener } = window`,
      // `const { prototype } = EventTarget`) was a silent bypass: the
      // bound local was a function/object reference that downstream
      // matchers could not see through `getAccessPath`.
      it('flags `const { body } = document` (document leaf via destructuring)', () => {
        const findings = findingsOf('const { body } = document;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.body'))).toBe(true);
      });

      it('flags `const { appendChild } = document`', () => {
        const findings = findingsOf('const { appendChild } = document;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.appendChild'))).toBe(true);
      });

      it('flags `const { querySelector } = document`', () => {
        const findings = findingsOf('const { querySelector } = document;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.querySelector'))).toBe(true);
      });

      it('flags `const { addEventListener } = window` (listener method via destructuring)', () => {
        const findings = findingsOf('const { addEventListener } = window;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('flags `const { addEventListener } = document` (listener method via destructuring)', () => {
        const findings = findingsOf('const { addEventListener } = document;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('flags `const { MutationObserver } = window` (observer ctor via destructuring)', () => {
        const findings = findingsOf('const { MutationObserver } = window;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes('MutationObserver'))).toBe(true);
      });

      it('flags `const { prototype } = EventTarget` (prototype handle via destructuring)', () => {
        const findings = findingsOf('const { prototype } = EventTarget;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes('EventTarget.prototype destructure'))).toBe(true);
      });

      it('flags `const { prototype } = HTMLElement`', () => {
        const findings = findingsOf('const { prototype } = HTMLElement;');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes('HTMLElement.prototype destructure'))).toBe(true);
      });

      it("flags `const { 'body': b } = document` (string-literal key)", () => {
        const findings = findingsOf("const { 'body': b } = document;");
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.body'))).toBe(true);
      });

      it('flags `({ body } = document)` (assignment destructuring)', () => {
        const findings = findingsOf('let body: unknown; ({ body } = document);');
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.body'))).toBe(true);
      });

      it('flags `({ addEventListener } = window)` (assignment destructuring)', () => {
        const findings = findingsOf(
          'let addEventListener: unknown; ({ addEventListener } = window);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('does NOT flag destructuring of a non-forbidden member', () => {
        const findings = findingsOf('declare const obj: { foo: string }; const { foo } = obj;');
        expect(findings).toEqual([]);
      });

      it('does NOT flag destructuring of a benign document leaf (e.g. document.title)', () => {
        // Only the leaves named in `FORBIDDEN_DOCUMENT_LEAVES` are
        // hazards; `title`, `readyState`, etc. are read-only metadata
        // that don't introduce attachment leaks. A regression that
        // over-extended the table to include benign members would
        // fail this test.
        const findings = findingsOf('const { title } = document;');
        expect(findings).toEqual([]);
      });
    });

    describe('ownerDocument permissive surfaces (class finding, cycle 2)', () => {
      // The fixture teaches scenes to use `ctx.stage.ownerDocument`
      // for DOM allocation — but every other Document surface
      // reached through `ownerDocument` is the same outside-`ctx.stage`
      // hazard as the ambient form. The fix permits only
      // createElement-style allocation; everything else is flagged.
      it('flags `ctx.stage.ownerDocument.addEventListener(...)` (listener via ownerDocument)', () => {
        const findings = findingsOf(
          'declare const ctx: { stage: { ownerDocument: { addEventListener(e: string, h: () => void): void } } }; ctx.stage.ownerDocument.addEventListener("click", () => undefined);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('global addEventListener'))).toBe(true);
      });

      it('flags `ctx.stage.ownerDocument.body` (parent-root via ownerDocument)', () => {
        const findings = findingsOf(
          'declare const ctx: { stage: { ownerDocument: { body: unknown } } }; const b = ctx.stage.ownerDocument.body;',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.body'))).toBe(true);
      });

      it('flags `ctx.stage.ownerDocument.querySelector(...)` (query via ownerDocument)', () => {
        const findings = findingsOf(
          'declare const ctx: { stage: { ownerDocument: { querySelector(s: string): unknown } } }; ctx.stage.ownerDocument.querySelector(".target");',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.querySelector'))).toBe(true);
      });

      it('flags `ctx.stage.ownerDocument.appendChild(...)` (mutation via ownerDocument)', () => {
        const findings = findingsOf(
          'declare const ctx: { stage: { ownerDocument: { appendChild(n: unknown): unknown } } }; declare const node: unknown; ctx.stage.ownerDocument.appendChild(node);',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.startsWith('document.appendChild'))).toBe(true);
      });

      it('flags `<unknown surface> via ownerDocument` (unknown leaf bypass defense)', () => {
        // A future Document method not yet in any table should still
        // be flagged when reached via ownerDocument; only the
        // explicit allowlist (createElement-style) passes.
        const findings = findingsOf(
          'declare const ctx: { stage: { ownerDocument: { someNewApi(): unknown } } }; ctx.stage.ownerDocument.someNewApi();',
        );
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes('outside allocation helpers'))).toBe(true);
      });

      it('does NOT flag `ctx.stage.ownerDocument.createElement(...)` (canonical allocation)', () => {
        const findings = findingsOf(
          'declare const ctx: { stage: { ownerDocument: { createElement(t: string): unknown } } }; ctx.stage.ownerDocument.createElement("div");',
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag `ctx.stage.ownerDocument.createElementNS(...)` (canonical allocation)', () => {
        const findings = findingsOf(
          'declare const ctx: { stage: { ownerDocument: { createElementNS(ns: string, t: string): unknown } } }; ctx.stage.ownerDocument.createElementNS("svg", "g");',
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag `ctx.stage.ownerDocument.createTextNode(...)` (canonical allocation)', () => {
        const findings = findingsOf(
          'declare const ctx: { stage: { ownerDocument: { createTextNode(t: string): unknown } } }; ctx.stage.ownerDocument.createTextNode("x");',
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag `ctx.stage.ownerDocument.createDocumentFragment()` (canonical allocation)', () => {
        const findings = findingsOf(
          'declare const ctx: { stage: { ownerDocument: { createDocumentFragment(): unknown } } }; ctx.stage.ownerDocument.createDocumentFragment();',
        );
        expect(findings).toEqual([]);
      });

      it('does NOT flag `ctx.stage.ownerDocument.importNode(...)` (canonical allocation)', () => {
        const findings = findingsOf(
          'declare const ctx: { stage: { ownerDocument: { importNode(n: unknown, deep: boolean): unknown } } }; declare const node: unknown; ctx.stage.ownerDocument.importNode(node, true);',
        );
        expect(findings).toEqual([]);
      });
    });

    describe('TypeScript wrapper unwrapping', () => {
      it.each([
        ['(document).addEventListener("click", () => undefined);', 'global addEventListener'],
        ['(window as any).addEventListener("click", () => undefined);', 'global addEventListener'],
        ['(globalThis!).addEventListener("click", () => undefined);', 'global addEventListener'],
        [
          '(globalThis satisfies object).addEventListener("click", () => undefined);',
          'global addEventListener',
        ],
        ['new (MutationObserver)(() => undefined);', 'MutationObserver'],
      ])('unwraps wrapper expressions — `%s`', (source, labelFragment) => {
        const findings = findingsOf(source);
        const labels = findings.map((f) => f.label);
        expect(labels.some((l) => l.includes(labelFragment))).toBe(true);
      });
    });

    describe('exemption marker', () => {
      it('honors `// PUL-Q004-allow: <reason>` on the same line', () => {
        const findings = findingsOf(
          'document.addEventListener("click", () => undefined); // PUL-Q004-allow: signal-bound below, see line 2',
        );
        expect(findings).toEqual([]);
      });

      it('rejects an empty rationale', () => {
        const findings = findingsOf(
          'document.addEventListener("click", () => undefined); // PUL-Q004-allow:',
        );
        expect(findings.length).toBeGreaterThan(0);
      });

      it('rejects a whitespace-only rationale', () => {
        const findings = findingsOf(
          'document.addEventListener("click", () => undefined); // PUL-Q004-allow:   ',
        );
        expect(findings.length).toBeGreaterThan(0);
      });

      it('rejects a marker hidden inside a string literal', () => {
        const findings = findingsOf(
          `const note = "// PUL-Q004-allow: hidden"; document.addEventListener('click', () => undefined);`,
        );
        expect(findings.length).toBeGreaterThan(0);
      });

      it('does NOT honor a marker on a different line (line-scoped)', () => {
        const src =
          '// PUL-Q004-allow: see above\ndocument.addEventListener("click", () => undefined);';
        const findings = findingsOf(src);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.line).toBe(2);
      });
    });

    describe('reporting', () => {
      it('reports the 1-based line and file path on every finding', () => {
        const src =
          'const a = 1;\nconst b = 2;\ndocument.addEventListener("click", () => undefined);\nconst c = 3;';
        const findings = findingsOf(src, 'src/scenes/example.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
          file: 'src/scenes/example.ts',
          line: 3,
        });
      });

      it('reports findings across multiple lines independently', () => {
        const src =
          'document.addEventListener("click", () => undefined);\nnew MutationObserver(() => undefined);';
        const findings = findingsOf(src);
        expect(findings.length).toBeGreaterThanOrEqual(2);
        const lines = findings.map((f) => f.line);
        expect(lines).toContain(1);
        expect(lines).toContain(2);
      });
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('scenes root `src/scenes/` exists and contains at least one .ts file', () => {
      expect(statSync(SCENES_ROOT).isDirectory()).toBe(true);
      expect(walkTsFiles(SCENES_ROOT).length).toBeGreaterThan(0);
    });

    it('contains no Q004 violations across `src/scenes/**/*.ts`', () => {
      const files = walkTsFiles(SCENES_ROOT);
      const findings: SourceFinding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        findings.push(...scanQ004(parseSource(text, rel)));
      }
      const header =
        'PUL-Q004 forbids scene-authored global event listeners (document/window/globalThis addEventListener / removeEventListener), DOM observer constructions (Mutation / Intersection / Resize / Performance), ambient-document attachment surfaces (document.body / document.head / document.querySelector / document.createElement / ...), and DOM-prototype monkey-patches (direct, compound-assignment, and Object.defineProperty / Object.assign / Reflect.set forms). Route DOM through `ctx.stage` (or `ctx.stage.ownerDocument`), audio through `ctx.audio`, timeline state through `ctx.gsap`, and bind any necessary listener to the navigation `AbortSignal`. Add a `// PUL-Q004-allow: <reason>` exemption on the same line only as a last resort.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });

    it('runtime tree `src/runtime/**/*.ts` is OUT of scope by design (signal-bound listeners live there)', () => {
      // The runtime owns signal-bound `addEventListener` use across
      // `audio.ts`, `presenter.ts`, `navigation.ts`,
      // `scene-loader.ts`, `timeline.ts`, and `audio-unlock-dom.ts`.
      // PUL-Q004 scopes the source scan to `src/scenes/**` so those
      // canonical activation-scope listener attachments do NOT
      // require per-line exemptions.
      const runtimeRoot = join(SRC_ROOT, 'runtime');
      expect(statSync(runtimeRoot).isDirectory()).toBe(true);
      const sceneFiles = walkTsFiles(SCENES_ROOT);
      for (const file of sceneFiles) {
        expect(file.startsWith(runtimeRoot)).toBe(false);
      }
    });
  });
});
