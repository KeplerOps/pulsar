# Pulsar

A scene-and-composition runtime for cinematic, timeline-driven browser
presentations.

Scenes are reusable modules with their own timelines, assets, captions,
and metadata. Compositions are manifests that arrange scenes into full
talks, short cuts, trailers, standalone demos, or other recompositions
of the same library.

The runtime owns the scene/composition model. External libraries are
adopted where they make a specific layer stronger, not where they force
the project back into slide semantics.

See `docs/adrs/` for architectural decisions.
