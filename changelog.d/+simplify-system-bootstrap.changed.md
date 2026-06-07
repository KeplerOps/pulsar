Made `createDomWorkbenchChrome` and `createDomAudioUnlockAdapter` generic
over their concrete element type so `src/main.ts` mounts a real
`HTMLElement` / `HTMLButtonElement` without `as unknown as Node` casts.
Trimmed narrative/ceremony comments in the chrome, prompter-window,
practice-renderer, and keyboard-source modules, and collapsed the
repeated `tl.fromTo` reveal boilerplate in the pulsar-intro deck behind a
local `reveal` helper (byte-identical timeline output). Behavior, exported
signatures, DOM attributes, and tests are unchanged.
