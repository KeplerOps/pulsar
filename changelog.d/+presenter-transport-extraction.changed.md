Extracted the presenter transport machinery (advance / hold / skip /
pause / resume command translation) out of the always-on timeline
composition path into a dedicated opt-in module
(`src/runtime/presenter-transport.ts`). The transport is wired onto the
master timeline only when a navigation forwards a presenter controller
(`mode=present`); a non-present navigation never instantiates it.
`timeline.ts` keeps the GSAP composition spine — `composeMasterTimeline`,
the scene label namespace, `assertSceneTimeline`, and the `MasterBeat`
beat query. No public signatures, `data-pulsar-*` attributes, or
cross-engine timing behavior changed.
