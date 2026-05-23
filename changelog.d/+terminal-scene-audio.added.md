The `terminal` L2 template accepts an optional `audio` soundtrack. A
terminal scene can name a source URL, sound id, volume, playback rate,
and fade-out duration; the template declares the URL in `scene.assets`
+ `scene.audio`, loads and plays the track through `ctx.audio` when the
script begins, and fades it to silence on scene teardown.

The audio integration is exposed as the standalone helper
`startTerminalAudio(audio, config)`, returning the fade-and-stop closure
the template registers on its per-scene session. Decks that need to
drive the same load → play → fade-out shape from a different template
can call the helper directly.
