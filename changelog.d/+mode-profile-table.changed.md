Centralized per-mode workbench behavior into a single `ModeProfile`
data table (`src/runtime/mode-profile.ts`). The audio output policy,
composition-slice truncation, chrome visibility, audio-bed suppression,
scrub cue gate, and head-scene runner hints were previously scattered
as `mode === X` branches across `scene-loader.ts` and
`workbench-chrome.ts`; they now read one frozen profile per mode.
Behavior is unchanged (snapshot-equivalence test), and collapsing the
four runner-hint ternaries into a single `...runnerHints` spread dropped
`runLifecycle` below the cognitive-complexity gate, closing a
complexity-backlog entry.
