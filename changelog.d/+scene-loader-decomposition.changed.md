Decomposed the scene-loader god-functions (`buildLoad`, `runTarget`)
into cohesive single-responsibility units below the cognitive-complexity
gate, deleting both `noExcessiveCognitiveComplexity` suppressions.
Per-navigation audio service / presenter pipe / ctx factory moved to
`src/runtime/scene-loader-ctx.ts`; the present-mode audio unlock-gate
predicate and the composition chrome dispatch policy to
`src/runtime/scene-loader-guard.ts`. The `beat` / `mode` grammar rules
are now sourced from a single `NAVIGATION_GRAMMAR` object in
`src/runtime/navigation.ts`, consumed by both `parseNavigationSearch`
and the loader's defense-in-depth re-check (the forged-target trust
seam is retained). `createSceneLoader`, all exported types, the
`data-pulsar-*` stage attributes, and runtime behavior are unchanged.
