Simplified the audio/timeline runtime cluster without behavior change:
inlined the single-use `validateSpeed` / `validateRepeat` validators
into `GsapMasterTimeline.setSpeed` / `.repeat`, rebuilt
`buildRunComposeOptions` as a single conditional-spread literal instead
of an empty object with four `as`-cast field assignments, and collapsed
the `...(x === undefined ? {} : { x })` idiom to `...(x && { x })` for
the object/boolean-typed `sprite` / `mute` fields in
`createHowlerAudioEngine`. Also trimmed the audio-unlock-dom module
preamble, the orphaned/duplicated adapter JSDoc, and the codex-cycle
narration to terse contracts. Public signatures (`AudioService` /
`AudioError` / `MasterTimeline` / `TimelineEngine` / the audio-unlock
adapter), error strings, `data-pulsar-*` attributes, and the abort-race
isolation guard are unchanged.
