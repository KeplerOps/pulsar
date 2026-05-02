# Presenter — User Stories

## UC-P1: Load a composition for presentation

- As a Presenter, I open a composition URL in `mode=present` so that
  the runtime is in presentation state.
- As a Presenter, I unlock audio with a single explicit gesture so
  that browser autoplay policy does not interrupt the talk.

## UC-P2: Advance, hold, and skip beats

- As a Presenter, I advance to the next beat with keyboard input so
  that I control pacing.
- As a Presenter, I hold the current beat indefinitely so that I can
  speak over it.
- As a Presenter, I skip a beat without breaking timeline state so
  that I recover from over-runs.

## UC-P3: Pause and resume during presentation

- As a Presenter, I pause and resume the composition so that I can
  take questions without restarting.

## UC-P4: Display prompter on a second screen

- As a Presenter, I open `mode=prompter` on a second display so that
  I see captions while presenting.

## UC-P5: Mute and unmute audio

- As a Presenter, I toggle master mute so that I silence audio
  without breaking the timeline.

## UC-P6: Recover from a runtime error

- As a Presenter, I see scene-level errors surface without halting
  the composition so that I can advance past a broken scene.
