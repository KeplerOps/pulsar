# Presenter — Use Cases

| UID | Title |
|-----|-------|
| UC-P1 | Load a composition for presentation |
| UC-P2 | Advance, hold, and skip beats |
| UC-P3 | Pause and resume during presentation |
| UC-P4 | Display prompter on a second screen |
| UC-P5 | Mute and unmute audio |
| UC-P6 | Recover from a runtime error |

## UC-P1: Load a composition for presentation

Presenter opens a URL in `mode=present` for the composition,
satisfies the audio-unlock interaction, and starts.

## UC-P2: Advance, hold, and skip beats

Presenter advances, holds, or skips beats using keyboard input. Beat
progression is interruptible without breaking timeline state.

## UC-P3: Pause and resume during presentation

Presenter pauses the composition (e.g., to take a question) and
resumes at the same beat.

## UC-P4: Display prompter on a second screen

Presenter opens `mode=prompter` for the current composition on a
second display while `mode=present` runs on the main display.

## UC-P5: Mute and unmute audio

Presenter mutes and unmutes audio via master mute without
interrupting the timeline.

## UC-P6: Recover from a runtime error

On a scene-level error, the runtime surfaces it to the Presenter
without halting the entire composition. Presenter can skip to the
next scene.
