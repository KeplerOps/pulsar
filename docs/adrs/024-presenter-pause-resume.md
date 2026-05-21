# ADR-024: Presenter Pause/Resume - Runner-Owned Transport State on the Existing Presenter Command Seam

## Status

Accepted

## Date

2026-05-10

## Context

PUL-F021 specifies:

> The runtime SHALL accept presenter input to pause the active
> timeline and SHALL accept input to resume from the same point.

ADR-023 already defines the runtime-side presenter input seam for
PUL-F020: a workbench-supplied `PresenterCommandSource` is wrapped by
a per-navigation `PresenterController`, scoped by the loader to
`mode=present`, validated at the command boundary, forwarded through
the bridge and resolver, and wrapped again per scene so stale
subscriptions do not leak into the next active scene.

PUL-F021 is adjacent to that seam but not identical to any existing
concept:

- `mode=paused` (ADR-019) is a URL-selected inspection mode that mounts
  the addressed head scene at its first frame. It is not live presenter
  pause/resume.
- PUL-F020 `hold` is a presenter beat-pacing command. It is not a
  resumable full transport state with an explicit resume command.
- `mode=scrub` (ADR-020) is timeline inspection with controls and
  monotonic audio-cue gating. It is not pause/resume for a live
  presentation.

The design question is whether PUL-F021 creates a new pause-specific
input surface, mode, or state object, or whether it extends the
existing presenter command seam.

## Decision

PUL-F021 extends the existing presenter command seam. It does not add
a new URL mode, command source, controller, event bus, cleanup path, or
pause-specific schema.

The canonical command schema remains `PresenterCommand` in
`src/runtime/presenter.ts`. PUL-F021 adds command kinds for `pause` and
`resume` to the existing `PRESENTER_COMMAND_KINDS` allowlist and keeps
`isPresenterCommand` as the single command-boundary validator. Unknown
kinds remain dropped at the controller boundary and reported through
the existing `onError` diagnostic sink.

Loader scoping remains unchanged: presenter commands are available
only when `effectiveMode(target) === 'present'` and the workbench
supplied `presenterCommands`. Non-present modes do not build a
presenter controller and therefore cannot receive pause/resume through
the runtime path.

Pause/resume transport state belongs to the timeline runner, not the
loader, resolver, scene, or command controller. A conforming GSAP
runner maps:

- `pause` to the active timeline's native pause operation, preserving
  the current playhead position.
- `resume` to native playback from that preserved position.

Pause/resume MUST NOT abort the navigation, call `cleanup(ctx)`, reload
the scene, re-run `scene.timeline(ctx)`, mutate the URL, write browser
history, or persist the playhead in localStorage/sessionStorage/cookies.
The "same point" is the active timeline instance's internal playhead
position. The runner keeps its returned promise pending while paused,
then continues normal completion after resume or normal abort cleanup
when the navigation is superseded.

Duplicate `pause` while already paused and duplicate `resume` while
already playing are idempotent no-ops. `resume` after the navigation
or scene wrapper has aborted is ignored by the existing presenter
controller cleanup semantics.

### Cross-command precedence

`pause` and `resume` form a transport-freeze gate that is *orthogonal*
to the PUL-F020 beat-pacing commands (`hold`, `advance`,
`skip-forward`, `skip-backward`). The two concepts compose; neither
overrides the other. A conforming runner observes this contract so
that seam-test-passing runners cannot diverge on PUL-F020 hold
semantics or PUL-F021 same-point pause semantics:

- **Freeze + restore.** `pause` freezes the active timeline's playhead
  wherever it is — nothing on stage advances — and snapshots the
  current beat-pacing state (whether the timeline was `hold`-ing at a
  beat or running toward the next beat). `resume` releases the freeze
  and continues from that exact playhead with the snapshotted
  beat-pacing state restored. `resume` does **not** clear a `hold`
  that was engaged before `pause`, and `pause` does **not** engage
  `hold`. A `pause` issued while `hold` is engaged resumes back into
  the held state.
- **Only `resume` unfreezes.** A `hold` / `advance` / `skip-forward` /
  `skip-backward` received while paused MUST NOT implicitly resume
  playback. The runner MAY apply `skip-forward` / `skip-backward` as a
  seek that moves the frozen playhead (presenter scrubbing while
  paused) and MAY record `advance` / `hold` intent for when transport
  resumes, but the stage stays visually frozen until an explicit
  `resume`. A minimal runner MAY drop a beat-pacing command it cannot
  honor while paused; what it MUST NOT do is silently resume on any
  command other than `resume`.
- **Idempotent edges.** Duplicate `pause` while paused and duplicate
  `resume` while playing are idempotent no-ops (above); likewise a
  `resume` received while not paused is a no-op.

`presenter` remains forwarded to every scene run input under
`mode=present`; it is still not head-only and it does not truncate the
composition slice. Pause/resume acts on whichever scene's runner is
currently active. A future composition-level/master-timeline runner can
honor the same command kinds at its own transport layer without
changing the command source contract.

PUL-F021 stays DRAFT until a real presenter UI source and the GSAP
runner both land with end-to-end tests proving pause freezes the active
timeline and resume continues from the same playhead position. The
placeholder runner may ignore the new commands because it has no real
timeline to pause or resume.

## Consequences

### Positive

- PUL-F021 reuses the validated, abort-tied presenter command boundary
  from ADR-023.
- There is one presenter command schema and one command allowlist.
- Pause/resume does not create a second lifecycle or cleanup path.
- The runner owns timeline transport state, matching ADR-003.

### Negative

- ADR-023's original four-kind command set must be extended by a later
  requirement, so tests around the frozen allowlist need to change when
  PUL-F021 is implemented.
- Seam tests can prove command delivery, but real "same point" behavior
  is not testable until the GSAP runner exists.

### Risks

| Risk | Mitigation |
|------|------------|
| `pause` is confused with `mode=paused` | Keep `mode=paused` URL-only and first-frame-only. Live pause/resume is a `mode=present` presenter command. |
| `pause` is implemented by aborting navigation | Forbid pause/resume from touching `AbortController`, `cleanup(ctx)`, loader handles, URL state, or history. Abort remains supersession/dispose only. |
| A second pause command schema appears | `src/runtime/presenter.ts` is the only command schema and validator. Add `pause` / `resume` there. |
| A stale scene keeps receiving resume | Reuse ADR-023's per-scene presenter wrapper; it aborts after cleanup and drops post-abort emissions. |
| Resume restarts from the beginning or a beat label | The runner resumes from its current playhead position; it does not seek unless a separate command explicitly asks it to. |
| A runner resumes playback on `advance` / `skip-*` / `hold` received while paused, or `resume` clears a prior `hold` | Only `resume` unfreezes transport; other commands update beat/playhead state the runner restores on `resume` but do not resume. `pause` / `resume` are orthogonal to `hold`. See *Cross-command precedence*. |
| A future remote presenter protocol leaks untrusted payloads into the runner | Remote/auth policy must live before the `PresenterCommandSource`. The controller still shape-checks every emitted command before forwarding. |

## Related ADRs

- [ADR-003](003-gsap-timeline-engine.md) - timeline transport is GSAP
  runner responsibility.
- [ADR-007](007-browser-workbench.md) - `present` is the presenter
  workbench mode and the URL is the only source of mode selection.
- [ADR-016](016-workbench-mode-present.md) - presenter input is one
  facet of `mode=present`.
- [ADR-019](019-workbench-mode-paused.md) - `mode=paused` is
  first-frame inspection, not live pause/resume.
- [ADR-020](020-workbench-mode-scrub.md) - scrub controls are
  timeline inspection, not pause/resume.
- [ADR-023](023-presenter-controls.md) - presenter command source,
  controller, validation, scoping, and cleanup seam.
