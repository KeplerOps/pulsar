import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, parseSource } from './source-policy';

// Issue #102 — scene module trust boundary documentation.
//
// `docs/scene-trust-model.md` is the canonical user-facing statement
// of the scene trust model: scenes are trusted application code,
// runtime validation is shape-only, and there is no sandbox. Issue
// #102's acceptance criterion 4 ("Identify APIs that scene code can
// affect through lifecycle hooks and context") names the structural
// surface the doc enumerates — every field on `WorkbenchSceneCtx` (the
// `ctx.X` an active scene receives, in `src/runtime/scene-ctx.ts`)
// and every lifecycle hook on `SceneModule` (any member typed as
// `SceneLifecycleFn`, in `src/runtime/scene.ts`).
//
// This test pins the doc to the types. Without it, adding a new ctx
// field (`ctx.network`, etc.) or a fourth lifecycle hook would silently
// drift the trust-model doc away from the runtime's actual capability
// surface — exactly the failure mode AC4 exists to prevent. Both
// checks fail loudly with the missing identifier in the assertion
// message so the contributor sees what to add to the doc.
//
// The lifecycle-hook check derives its set from the live `SceneModule`
// interface rather than a hardcoded list — a hardcoded constant would
// only ever check the names it already knows about, which would let a
// fourth hook ship undocumented (test-quality cycle 1 finding F1).
// `lifecycleMembersOf` filters interface members down to property
// signatures whose declared type references `SceneLifecycleFn`, so any
// future hook added to the interface is automatically included in the
// doc-coverage assertion.

const DOC_PATH = join(REPO_ROOT, 'docs/scene-trust-model.md');
const CTX_SRC = join(REPO_ROOT, 'src/runtime/scene-ctx.ts');
const SCENE_SRC = join(REPO_ROOT, 'src/runtime/scene.ts');
const LIFECYCLE_TYPE_NAME = 'SceneLifecycleFn';

function findInterface(file: string, interfaceName: string): ts.InterfaceDeclaration {
  const text = readFileSync(file, 'utf8');
  const sf = parseSource(text, file);
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === interfaceName) {
      return stmt;
    }
  }
  throw new Error(`interface ${interfaceName} not found in ${file}`);
}

function memberNamesOf(file: string, interfaceName: string): readonly string[] {
  const decl = findInterface(file, interfaceName);
  const names: string[] = [];
  for (const m of decl.members) {
    if (
      (ts.isPropertySignature(m) || ts.isMethodSignature(m)) &&
      m.name &&
      ts.isIdentifier(m.name)
    ) {
      names.push(m.name.text);
    }
  }
  return names;
}

function lifecycleMembersOf(file: string, interfaceName: string): readonly string[] {
  const decl = findInterface(file, interfaceName);
  const names: string[] = [];
  for (const m of decl.members) {
    if (!ts.isPropertySignature(m) || !m.name || !ts.isIdentifier(m.name) || !m.type) continue;
    if (!ts.isTypeReferenceNode(m.type)) continue;
    const typeName = m.type.typeName;
    if (!ts.isIdentifier(typeName)) continue;
    if (typeName.text === LIFECYCLE_TYPE_NAME) {
      names.push(m.name.text);
    }
  }
  return names;
}

describe('docs/scene-trust-model.md — capability surface drift gate', () => {
  it('names every WorkbenchSceneCtx field as `ctx.<name>`', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const ctxFields = memberNamesOf(CTX_SRC, 'WorkbenchSceneCtx');
    expect(ctxFields.length).toBeGreaterThan(0);
    const missing = ctxFields.filter((field) => !doc.includes(`ctx.${field}`));
    expect(missing).toEqual([]);
  });

  it('names every SceneModule SceneLifecycleFn member as `<hook>(ctx)`', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const lifecycleHooks = lifecycleMembersOf(SCENE_SRC, 'SceneModule');
    expect(
      lifecycleHooks.length,
      `SceneModule must declare at least one ${LIFECYCLE_TYPE_NAME} member`,
    ).toBeGreaterThan(0);
    const missingFromDoc = lifecycleHooks.filter((hook) => !doc.includes(`${hook}(ctx)`));
    expect(missingFromDoc, 'trust-model doc must name each lifecycle hook').toEqual([]);
  });
});
