# Studio

Studio turns one long, rambly screen recording into a short video **in the user's own
recorded voice**: an AI "master director" splits the recording into scenes and proposes
cuts (spans of footage to drop), the producer tunes the cuts scene by scene, and the
kept footage is stitched into a final cut and published (e.g. to YouTube). The AI never
rewrites what was said — the spoken content is always the original recording minus cuts.

## Language

**Final cut**:
The short, produced video assembled from the built scenes — the published artifact. Its
spoken content is the original recorded speech with the [[Cut]]s removed, in the
speaker's own voice.
_Avoid_: Export, render, output video

**Cut**:
A span of source footage (in original-video seconds) dropped from the final cut. Cuts
are the *only* edit primitive: the shortened result is derived — original words minus
cuts — never a separately authored script. Proposed by the AI, tuned by hand. Nothing
is ever added between kept spans today; adding footage is a future [[Video patch]].
_Avoid_: Deletion, trim (as the concept name)

**Scene**:
A titled window of the recording, produced by the [[Master director]]. Scenes tile the
recording end-to-end — every second of source belongs to exactly one scene, so footage
can only be dropped by a [[Cut]], never by falling between scene windows (a fully-cut
scene is legal and renders as such). A scene is *built* once its per-scene work (clip
slice, dense contact sheets, [[Scene refiner]]) has run and the producer has signed off
its cuts; the [[Final cut]] assembles only from built scenes.
_Avoid_: Chapter, segment

**Master director**:
The whole-recording AI pass. Sees the full transcript and contact sheets, splits the
recording into titled scenes, and for each scene proposes coarse [[Cut]]s (an immediately
watchable baseline) plus a [[Cutting brief]] for the refiner. Big-picture judgment only —
precision belongs to the [[Scene refiner]].
_Avoid_: Shortener, script writer

**Cutting brief**:
The director's prose instructions to the [[Scene refiner]] for one scene — what to drop
and why, grounded in the whole recording (false starts, repeated takes, tangents).
Guidance, not spans.
_Avoid_: Scene prompt, notes

**Scene refiner**:
The per-scene, on-demand AI pass. Takes the scene's timed words, its [[Cutting brief]],
and the measured [[Dead space]], and returns precise cuts — snapping cut edges into
silence rather than clipping words. Refines the director's baseline; never rewrites text.
_Avoid_: Segment anchorer (obsolete role)

**Dead space**:
Spans of the source audio with no meaningful sound, measured from the extracted audio
itself (per-slice energy below a silence threshold) — not inferred from gaps between
transcript words. Rendered distinctly from speech and from non-speech noise (breaths,
clicks), because true silence is the prime territory for a [[Cut]] while noise may not
cut cleanly.
_Avoid_: Gap, blank space, pause (as the concept name)

**Video patch** (future, not built):
A recorded video-with-audio insert stitched into the final cut at a cut point. The only
sanctioned way words will ever be *added*: audio-only inserts don't work over footage of
the speaker talking, so additions must bring their own picture. Out of scope for now.
_Avoid_: Snippet, overlay

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

**Video backend**:
Where Studio's ffmpeg work runs this session: **Browser** (ffmpeg.wasm in the tab), **Server
(auto)** (CE's `ffmpeg_handler`, CE picks its default executor), **Local server** (CE, forcing
the Local executor) or **Remote** (CE, forcing the Remote executor — a Cloud Run Worker). Chosen
per browser (`?videoBackend=` / localStorage), validated against the capability probe's
`executors`; Auto Build's ffmpeg lane widens to min(8, scenes) when the *effective* executor
is Remote (Remote chosen, or Server (auto) on an instance whose default executor is Remote).
_Avoid_: "wasm mode" / "server mode" as user-facing labels
