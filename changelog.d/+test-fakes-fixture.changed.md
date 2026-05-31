Extracted the duplicated jsdom-free test fakes into a single
`tests/support/fakes.ts` fixture: the `mode=*` fixture-scene stage stub
(was re-derived byte-for-byte in five `tests/scenes/*-fixture.test.ts`
files), the synthetic `HTMLElement`/`Document` tree the chrome pack
tests use (was duplicated across `chrome-slots` and `chrome-extras`),
and the event-emitting / no-op presenter controllers (was re-rolled in
`helpers` and `presenter-driven`). Typing the chrome fake as the real
DOM interfaces dropped every `as unknown as HTMLElement|FakeElement`
cast at the chrome-test call sites, and trimmed the copy-pasted
coverage-narration headers to one line each. Assertions, test counts,
and behavior coverage are unchanged.
