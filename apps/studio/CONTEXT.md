# Studio

Studio turns one long, rambly screen recording into a short video **re-voiced in the
user's own cloned voice**: an AI "master director" shortens the transcript and splits it
into scenes, the producer builds each scene one at a time, and the result is assembled
into a final cut and published (e.g. to YouTube).

## Language

**Final cut**:
The short, produced video assembled from the built scenes — the published artifact. Its
spoken content is the re-voiced narration script, not the original rambling recording.
_Avoid_: Export, render, output video

**Contact sheet**:
A grid of interval-sampled video frames, each with its wall-clock timestamp burned into a
corner, handed to the AI as visual context (and reused as a scrubbing sprite). Frames map
back to original-video time.
_Avoid_: Thumbnail grid, montage, sprite sheet (in user-facing copy)

**Companion blog post**:
A blog-format article derived from the [[Final cut]] — same content and coverage as the
published video, written to be read instead of watched, illustrated with frames pulled
from the recording. A companion to the video, not a standalone piece from the raw
recording. Delivered as a portable [[Blog bundle]]; Studio never hosts it.
_Avoid_: Article, write-up, transcript dump

**Blog bundle**:
The take-away artifact for a [[Companion blog post]]: a single Markdown document plus an
`images/` folder of the illustrating frames, referenced by relative path, packaged so the
user can host it anywhere. Self-contained, not served by Studio.
_Avoid_: Export, download, zip (as the concept name)
