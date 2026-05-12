import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  type ImportBanRule,
  REPO_ROOT,
  SRC_ROOT,
  type SourceFinding,
  collectLineExemptions,
  getAccessPath,
  isComputedGlobalWrapperAccess,
  isInTypePosition,
  lineText,
  parseSource,
  pathResolvesTo,
  scanImportSpecifiers,
  walkTsFiles,
} from './source-policy';

// PUL-A002 — Audio library encapsulation.
//
// Statement: "Scene modules SHALL access audio playback only via the
// runtime audio context. Scenes SHALL NOT instantiate
// `HTMLAudioElement` or directly import the audio library, except
// where a scene drops down to raw Web Audio with a documented
// justification and registers cleanup with the runtime."
//
// Enforcement: a Vitest source scan over `src/scenes/**/*.ts` with
// two checks:
//
//   1. Direct imports of `howler` (or any `howler/*` subpath) are
//      flagged. The runtime adapter at `src/runtime/audio.ts` is the
//      only production module allowed to import Howler; it is outside
//      the scene scope, so the scan never sees it. Scenes use
//      `ctx.audio` exclusively.
//
//   2. Value-position constructions of `HTMLAudioElement` or `Audio`
//      (`new HTMLAudioElement(...)`, `new Audio(...)`, `Audio(...)`)
//      are flagged. Type-position references
//      (`type T = HTMLAudioElement` or `(el: HTMLAudioElement) => void`)
//      are NOT flagged — they are compile-time-only annotations.
//
// The "documented justification" the statement mentions is supplied
// via the line-scoped exemption marker `// PUL-A002-allow: <reason>`.
// A scene that drops down to raw Web Audio (the `AudioContext` API,
// distinct from `HTMLAudioElement`) does not need the exemption — it
// does not match either check.

const IMPORT_RULE: ImportBanRule = {
  label: 'howler (scene module imports audio library directly)',
  specifiers: ['howler', 'howler/'],
  boundaries: [],
  allowTag: 'PUL-A002-allow',
};

const FORBIDDEN_AUDIO_CTORS: ReadonlyMap<string, string> = new Map([
  ['Audio', 'new Audio() (scene constructs HTMLAudioElement)'],
  ['HTMLAudioElement', 'new HTMLAudioElement() (scene constructs HTMLAudioElement)'],
]);

const SCENES_ROOT = join(SRC_ROOT, 'scenes');
const ALLOW_TAG = IMPORT_RULE.allowTag;

// True when `path` ends in `[document, createElement]` or
// `[<global-wrapper>, document, createElement]`. We treat `document`
// as a recognised DOM-level root similar to how the global wrappers
// are treated for `Audio` — strip any leading global-wrapper
// segments first.
function pathIsDocumentCreateElement(path: readonly string[]): boolean {
  let start = 0;
  // `import { GLOBAL_WRAPPERS } from './source-policy'` is the same
  // set Q007/A002 use; we inline the membership check here to keep
  // the function pure of imports beyond what the file already has.
  const wrappers = new Set(['globalThis', 'window', 'self', 'global']);
  while (start < path.length && wrappers.has(path[start] ?? '')) {
    start += 1;
  }
  const tail = path.slice(start);
  return tail.length === 2 && tail[0] === 'document' && tail[1] === 'createElement';
}

function firstArgIsAudioLiteral(call: ts.CallExpression | ts.NewExpression): boolean {
  const args = call.arguments;
  if (!args || args.length === 0) return false;
  const first = args[0];
  if (!first) return false;
  const inner = ts.isParenthesizedExpression(first) ? first.expression : first;
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return inner.text.toLowerCase() === 'audio';
  }
  return false;
}

function scanCtorConstructions(
  sourceFile: ts.SourceFile,
  exempted: Set<number>,
): readonly SourceFinding[] {
  const findings: SourceFinding[] = [];
  const file = sourceFile.fileName;

  // Match either a bare identifier callee (`new Audio(...)`,
  // `Audio(...)`) OR a recognised global-wrapper access chain
  // (`new window.Audio(...)`, `globalThis.HTMLAudioElement(...)`).
  // We share `getAccessPath` / `pathResolvesTo` with PUL-Q007 so a new
  // wrapper layer added to one scanner extends both.
  //
  // A third check covers the DOM factory form
  // `document.createElement('audio')` (with optional global wrappers
  // in front of `document`). `createElement('audio')` returns an
  // `HTMLAudioElement` — the same hazard as `new Audio()` — so it
  // belongs under the same ban with the same exemption tag.
  const recordViolation = (node: ts.Node, label: string): void => {
    const start = node.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    if (exempted.has(line)) return;
    findings.push({
      file,
      line: line + 1,
      text: lineText(sourceFile, line).trim(),
      label,
    });
  };

  const checkCallee = (node: ts.NewExpression | ts.CallExpression): void => {
    if (isInTypePosition(node)) return;
    const path = getAccessPath(node.expression);
    if (!path) {
      // Computed subscript on a recognised global wrapper
      // (`new globalThis['Au' + 'dio']('clip')`) is the bypass shape
      // the policy must catch: the runtime value of the subscript may
      // still resolve to `Audio` or `HTMLAudioElement`, so the access
      // pattern itself is forbidden. Conservatively flag.
      if (isComputedGlobalWrapperAccess(node.expression)) {
        recordViolation(
          node,
          'computed global wrapper access (possible Audio / HTMLAudioElement bypass)',
        );
      }
      return;
    }
    // Audio / HTMLAudioElement constructor / call form.
    for (const [ctorName, label] of FORBIDDEN_AUDIO_CTORS) {
      if (pathResolvesTo(path, ctorName)) {
        recordViolation(node, label);
        return;
      }
    }
    // `document.createElement('audio')` form (calls only — `new` on
    // `createElement` is invalid).
    if (ts.isCallExpression(node) && pathIsDocumentCreateElement(path)) {
      if (firstArgIsAudioLiteral(node)) {
        recordViolation(
          node,
          "document.createElement('audio') (scene constructs HTMLAudioElement)",
        );
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      checkCallee(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function scanForA002(source: string, file: string): readonly SourceFinding[] {
  const sf = parseSource(source, file);
  const exempted = collectLineExemptions(sf, ALLOW_TAG);
  return [
    ...scanImportSpecifiers(sf, IMPORT_RULE, exempted),
    ...scanCtorConstructions(sf, exempted),
  ];
}

describe('PUL-A002 — audio library encapsulation (source scan)', () => {
  describe('scanner self-tests — import ban', () => {
    it.each([
      ["import { Howl } from 'howler';", '(static import)'],
      ["import * as howler from 'howler';", '(static import)'],
      ["import { Howler } from 'howler/dist/howler';", '(static import)'],
      ["await import('howler');", '(dynamic import)'],
      ["import type { Howl } from 'howler';", '(type-only import)'],
      ["export * from 'howler';", '(re-export)'],
    ])('flags `%s` %s', (source, suffix) => {
      const findings = scanForA002(source, 'src/scenes/x.ts');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.label).toBe(`${IMPORT_RULE.label} ${suffix}`);
    });

    it('does NOT flag a similarly-named package (whole-specifier match)', () => {
      const src = "import { thing } from 'howler-types';";
      expect(scanForA002(src, 'src/scenes/x.ts')).toEqual([]);
    });

    it('does NOT flag scenes that use `ctx.audio`', () => {
      const src = [
        'import type { WorkbenchSceneCtx } from "../runtime/scene-loader";',
        'export const create = (ctx: WorkbenchSceneCtx) => ctx.audio?.unlock();',
      ].join('\n');
      expect(scanForA002(src, 'src/scenes/example.ts')).toEqual([]);
    });
  });

  describe('scanner self-tests — constructor ban', () => {
    it.each([
      ['new Audio() (scene constructs HTMLAudioElement)', 'const a = new Audio();'],
      ['new Audio() (scene constructs HTMLAudioElement)', "const a = new Audio('clip.mp3');"],
      [
        'new HTMLAudioElement() (scene constructs HTMLAudioElement)',
        'const a = new HTMLAudioElement();',
      ],
      ['new HTMLAudioElement() (scene constructs HTMLAudioElement)', 'HTMLAudioElement();'],
      ['new Audio() (scene constructs HTMLAudioElement)', "Audio('clip.mp3');"],
    ])('flags %s — %s', (label, source) => {
      const findings = scanForA002(source, 'src/scenes/x.ts');
      expect(findings.map((f) => f.label)).toContain(label);
    });

    it('does NOT flag `HTMLAudioElement` in a type annotation', () => {
      const src = 'export const accept = (el: HTMLAudioElement): void => { el.pause(); };';
      expect(scanForA002(src, 'src/scenes/x.ts')).toEqual([]);
    });

    it('does NOT flag `HTMLAudioElement` in a type alias', () => {
      const src = 'type ScenePlayer = HTMLAudioElement | null;';
      expect(scanForA002(src, 'src/scenes/x.ts')).toEqual([]);
    });

    it('still flags `new Audio()` when a local class `Audio` shadows the global (known false positive — name-based resolution)', () => {
      // A local `Audio` shadows the global at runtime, but the scanner
      // resolves identifiers by name, not by symbol — so the AST visit
      // still matches `new Audio()`. This test pins that behavior
      // explicitly: the scanner DOES emit a finding for the local-
      // class case. The false-positive surface is bounded (nobody
      // writes a class named `Audio` in a Pulsar scene); the
      // line-scoped exemption marker is the documented escape hatch
      // if this edge case fires. The test name reflects what the
      // assertion actually verifies, not what an ideal symbol-aware
      // scanner would do.
      const src = 'class Audio { play() {} }; const x = new Audio();';
      expect(scanForA002(src, 'src/scenes/x.ts').map((f) => f.label)).toContain(
        'new Audio() (scene constructs HTMLAudioElement)',
      );
    });

    it('does NOT flag raw Web Audio (`new AudioContext()`)', () => {
      const src = 'const ctx = new AudioContext(); ctx.createOscillator();';
      expect(scanForA002(src, 'src/scenes/x.ts')).toEqual([]);
    });

    it('honors `// PUL-A002-allow: <reason>` exemption on the constructor line', () => {
      const src =
        "const a = new Audio('clip.mp3'); // PUL-A002-allow: raw Web Audio fallback, cleanup registered";
      expect(scanForA002(src, 'src/scenes/x.ts')).toEqual([]);
    });

    // Every entry in `GLOBAL_WRAPPERS` (`globalThis`, `window`, `self`,
    // `global`) appears at least once below so a regression that drops
    // one wrapper from the set fails here. `global.Audio()` /
    // `new global.HTMLAudioElement()` are the Node.js-adjacent bypass
    // shapes a developer in a Node-side script could otherwise use to
    // slip past the scene-side audio ban while every other test stayed
    // green.
    it.each([
      ['new Audio() (scene constructs HTMLAudioElement)', 'new window.Audio();'],
      ['new Audio() (scene constructs HTMLAudioElement)', "new globalThis.Audio('clip.mp3');"],
      ['new Audio() (scene constructs HTMLAudioElement)', 'new self.Audio();'],
      ['new Audio() (scene constructs HTMLAudioElement)', "new global.Audio('clip.mp3');"],
      [
        'new HTMLAudioElement() (scene constructs HTMLAudioElement)',
        'new window.HTMLAudioElement();',
      ],
      [
        'new HTMLAudioElement() (scene constructs HTMLAudioElement)',
        'globalThis.HTMLAudioElement();',
      ],
      [
        'new HTMLAudioElement() (scene constructs HTMLAudioElement)',
        'new global.HTMLAudioElement();',
      ],
      ['new Audio() (scene constructs HTMLAudioElement)', "window['Audio']('clip.mp3');"],
      [
        'new Audio() (scene constructs HTMLAudioElement)',
        "new (globalThis as any).Audio('clip.mp3');",
      ],
    ])('flags global-wrapper form %s — `%s`', (label, source) => {
      const findings = scanForA002(source, 'src/scenes/x.ts');
      expect(findings.map((f) => f.label)).toContain(label);
    });

    it('does NOT flag `obj.Audio()` where `obj` is a non-global local', () => {
      const src = "declare const obj: { Audio: (src: string) => unknown }; obj.Audio('clip.mp3');";
      expect(scanForA002(src, 'src/scenes/x.ts')).toEqual([]);
    });

    it.each([
      "document.createElement('audio');",
      'document.createElement("audio");',
      'document.createElement(`audio`);',
      "document.createElement('AUDIO');",
      "window.document.createElement('audio');",
      "globalThis.document.createElement('audio');",
      "self.document.createElement('audio');",
    ])('flags `%s` (HTMLAudioElement via createElement)', (source) => {
      const findings = scanForA002(source, 'src/scenes/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        "document.createElement('audio') (scene constructs HTMLAudioElement)",
      );
    });

    it("does NOT flag `document.createElement('div')` and other non-audio tags", () => {
      const sources = [
        "document.createElement('div');",
        "document.createElement('canvas');",
        "document.createElement('video');",
      ];
      for (const src of sources) {
        expect(scanForA002(src, 'src/scenes/x.ts')).toEqual([]);
      }
    });

    it("does NOT flag a non-global `doc.createElement('audio')` lookalike", () => {
      const src = [
        'declare const doc: { createElement: (tag: string) => unknown };',
        "doc.createElement('audio');",
      ].join('\n');
      expect(scanForA002(src, 'src/scenes/x.ts')).toEqual([]);
    });

    it('does NOT flag `document.createElement(tag)` with a non-literal first argument', () => {
      // A computed tag is too dynamic to classify statically. Flagging
      // every such call would over-fire on legitimate code that builds
      // tag names from declared scene metadata. The line-scoped
      // exemption is the documented escape hatch when an audio element
      // is legitimately needed.
      const src = 'declare const tag: string; document.createElement(tag);';
      expect(scanForA002(src, 'src/scenes/x.ts')).toEqual([]);
    });

    it("honors `// PUL-A002-allow: <reason>` exemption on a createElement('audio') line", () => {
      const src =
        "document.createElement('audio'); // PUL-A002-allow: documented Web Audio fallback, cleanup registered";
      expect(scanForA002(src, 'src/scenes/x.ts')).toEqual([]);
    });

    it.each([
      "new globalThis['Au' + 'dio']('clip.mp3');",
      "globalThis[someKey]('clip.mp3');",
      "new window[`Aud${'io'}`]('clip.mp3');",
      "self['HTML' + 'AudioElement']();",
    ])('flags computed global-wrapper bypass — `%s`', (source) => {
      const findings = scanForA002(`declare const someKey: string; ${source}`, 'src/scenes/x.ts');
      expect(findings.map((f) => f.label)).toContain(
        'computed global wrapper access (possible Audio / HTMLAudioElement bypass)',
      );
    });

    it('does NOT flag computed access on a non-global root', () => {
      const findings = scanForA002(
        "declare const obj: Record<string, (s: string) => unknown>; declare const k: string; obj[k]('clip.mp3');",
        'src/scenes/x.ts',
      );
      expect(findings).toEqual([]);
    });
  });

  describe('runtime tree (current code revision)', () => {
    it('scenes root `src/scenes/` exists and contains at least one .ts file', () => {
      expect(statSync(SCENES_ROOT).isDirectory()).toBe(true);
      expect(walkTsFiles(SCENES_ROOT).length).toBeGreaterThan(0);
    });

    it('contains no A002 violations across `src/scenes/**/*.ts`', () => {
      const files = walkTsFiles(SCENES_ROOT);
      const findings: SourceFinding[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        const rel = relative(REPO_ROOT, file);
        const sf = parseSource(text, rel);
        const exempted = collectLineExemptions(sf, ALLOW_TAG);
        findings.push(
          ...scanImportSpecifiers(sf, IMPORT_RULE, exempted),
          ...scanCtorConstructions(sf, exempted),
        );
      }
      const header =
        'PUL-A002 forbids scene modules from importing `howler` / `howler/*` directly OR instantiating `HTMLAudioElement` / `Audio`. Use `ctx.audio` (the runtime adapter at `src/runtime/audio.ts`). Add a `// PUL-A002-allow: <reason>` exemption on the same line when raw Web Audio with cleanup is the only path.';
      const detail = findings.map((f) => `  ${f.file}:${f.line}  ${f.label}  ${f.text}`).join('\n');
      const message = findings.length === 0 ? '' : `${header}\n${detail}`;
      expect(findings, message).toEqual([]);
    });

    it('runtime adapter `src/runtime/audio.ts` is exempt by scope (the boundary)', () => {
      const adapter = join(SRC_ROOT, 'runtime', 'audio.ts');
      expect(statSync(adapter).isFile()).toBe(true);
      const text = readFileSync(adapter, 'utf-8');
      expect(text).toMatch(/from\s+['"]howler['"]/);
      const sceneFiles = walkTsFiles(SCENES_ROOT);
      expect(sceneFiles).not.toContain(adapter);
    });
  });
});
