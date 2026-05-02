# Presenter

## Role

The human running a composition live in a browser at presentation
time. Often the same person as the Scene Author; the role is distinct
because the constraints differ.

## Goals

- Load a composition in `mode=present` and run it end to end.
- Advance, hold, and skip beats predictably under presenter input.
- Recover from interrupts (mute, skip, resume) without losing place.
- Optionally view captions on a second display via `mode=prompter`.

## Constraints

- Cannot edit during presentation.
- Environment may be unfamiliar (conference laptop, projector,
  off-network).
- Audio output reliability matters; browser autoplay policy must be
  handled.
- Recovery latency from any error must be short; presentation cannot
  pause for diagnostics.

## Touchpoints

- Browser running the runtime in `mode=present`.
- Keyboard input.
- Audio output.
- Optional second display for `mode=prompter`.

## Out of scope

- Authoring.
- Debugging or modifying scenes.
- Recovery from issues that require code changes.
