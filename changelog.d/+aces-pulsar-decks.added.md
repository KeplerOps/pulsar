Rebuilt both reference decks with bespoke per-deck CSS rather than the L2
template kit. `pulsar-intro` is now an editorial, two-surface deck
(near-black + paper) demonstrating the runtime to a presentation author
who has never seen Pulsar; `aces-ecosystem-intro` is a standards-body
briefing register grounded in citations to `aces-sdl/` and the F1
literature review.

Added timeline-owned active segment reporting to the workbench. Presenter
scene navigation now moves by an explicit segment cursor; `ArrowRight`,
`PageDown`, `ArrowLeft`, and `PageUp` keep the visible scene and
`data-pulsar-scene-target` aligned without relying on GSAP callback replay
after seeks.

Extended the trailing tween on each deck's last scene so the composition
master never reaches its natural end. Advancing past the outro now holds
on the final scene with a clear `end · N of N` folio instead of tearing
all scenes down and showing a blank stage.

Made cinematic chrome atmosphere composition-opt-in and fixed presenter
session entropy on non-secure Tailscale HTTP origins.
