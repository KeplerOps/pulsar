Closed the three `src/runtime/audio.ts` cognitive-complexity
suppressions. `unlock()` now delegates its HTML5 and Web Audio
fallback branches to the `unlockHtml5Fallback` / `resumeWebAudioContext`
module helpers; `play()` delegates option validation to `validatePlay`
and per-instance engine output to `applyPlayToHandle`. The
`normalizeSources` offender was already covered by the hoisted
`normalizeAudioUrl`. Behavior is unchanged — the audio service public
methods, output policies, error families, composition bed routing, cue
gate, and master-mute semantics are byte-identical. The audio.ts rows
were removed from `docs/design/complexity-backlog.md` and the
complexity-gate policy oracle.

Slimmed the audio service internals without changing observable
behavior: the per-service `disposed` boolean and its scattered guards
were replaced by a single internal `AbortController` so the navigation
signal and an explicit `stopAll()` converge on one disposal gate and one
teardown; the composition bed is now registered through the same
`registerSound` core scene sounds use (the bespoke `startBed` engine
duplication is gone) under the reserved, non-kebab `composition audio
bed` id, keeping it unreachable from `ctx.audio`; and the four
per-option `assertPlayOption*` helpers were folded into a table-driven
`assertPlayOptions`. Sprite-map validation, a field of the sound
definition, was folded into `assertSoundDefinition` so the whole
definition payload passes one boundary assert (the standalone
`assertSpriteMap` is gone); the throws scenes observe for a malformed
sprite are unchanged.
