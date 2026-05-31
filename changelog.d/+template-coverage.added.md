Behavioral test coverage for the under-tested L2 template library and
runtime timing helpers. New mount-and-assert suites exercise the real
rendered DOM, authored timeline beats, and cleanup for `terminal`,
`card-carousel`, `activity-feed-payoff`, `chat-pick-list`,
`split-dialogue-email`, `split-pane-terminal-doc`, `metric-ticker`, the
`_shared` template envelope, the `register` token barrel, and the
abortable-timing primitives in `helpers/timing`. Product line coverage
(runtime + template library) rises from ~93% to ~99%; `terminal.ts`
alone goes 35% to 99%. The example decks (demonstration content,
exercised by the Playwright E2E) are scoped out of the coverage gate —
the gate measures the product, not the sample decks.
