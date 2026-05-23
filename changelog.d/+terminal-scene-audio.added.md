The `terminal` L2 template accepts an optional `audio` soundtrack. A
terminal scene can name a source URL, sound id, volume, playback rate,
and fade-out duration; the template declares the URL in `scene.assets`
+ `scene.audio`, loads and plays the track through `ctx.audio` when the
script begins, and fades it to silence on scene teardown.
