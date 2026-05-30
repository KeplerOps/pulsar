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
