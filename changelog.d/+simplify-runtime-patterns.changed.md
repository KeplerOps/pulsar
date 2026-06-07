Simplified the scene-loader and navigation/composition runtime cluster
without behavior change: inlined linter-noise micro-helpers
(`setStageAttr` / `clearStageAttr` / `audioOutputPolicyFor` /
`audioServiceOptions`), collapsed the `...(x === undefined ? {} : { x })`
conditional-spread idiom to its positive `...(x ? { x } : {})` form,
replaced writable-intermediate-then-freeze object construction in
`parseNavigationSearch` / `composeSegments` / `buildPrompterScript` with
direct frozen literals, and merged the two-stage `chromeBehavior`
extraction in `scene-loader-guard`. Public signatures, `data-pulsar-*`
attributes, error strings, and PUL-Q008 attribute-literal handling are
unchanged.
