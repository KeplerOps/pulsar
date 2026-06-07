Collapsed the audio error hierarchy and de-duplicated the shape-validator tests. The nine `AudioError` subclasses
(`AudioSoundError` / `AudioGroupError` / `AudioRangeError` / `AudioSourceError`, etc.) are gone — no `src/` caller
discriminated them — replaced by one `AudioError` carrying a `category` discriminant (`sound` / `group` / `source` /
`range` / `option`) and module-private per-category constructors. `ctx.audio` runtime behavior, the throwable surface,
and every rejected input are unchanged. The brittle field-by-field `.each` validation loops for `assertSceneModule`,
`assertCompositionManifest`, and `assertAudioBedDeclaration` are replaced by one representative assert per shape plus a
shared seeded property fuzz (`tests/runtime/validator-fuzz.ts`) covering the same malformed-input classes (omission,
wrong type, out-of-range number, non-kebab id) and asserting the offending field is named.
