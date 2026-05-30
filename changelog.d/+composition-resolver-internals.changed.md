Refactored the composition-resolver and scene-navigation internals
without changing behavior. `SceneActivation` identity is now embedded
in each plan step at build time (no per-call reconstruction); the
three finalizers collapse into one `finalize()` that selects
aggregate-vs-reraise from whether `onSceneFailed` was supplied;
`onSceneFailed` is wrapped once at lifecycle-context build; the bare
mount→compose→run→cleanup engine (`runLifecycle`) is separated from
the scene-failure-isolation decorator (`resolveComposition`); the
three composition-resolution paths (from-start / scene / index) unify
behind one parameterized index finder; and the resolver's run-option
builder is reduced to a single strip. Added both-path
(onSceneFailed supplied / omitted) regression coverage asserting
cleanup-exactly-once-per-activation and correct error routing for
create-throw, timeline-throw, cleanup-throw, abort-mid-mount, and a
repeated scene id where one occurrence fails. Public signatures,
`data-pulsar-*` attributes, and error wording are unchanged.
