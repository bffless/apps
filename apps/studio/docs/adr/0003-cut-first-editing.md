# Cut-first editing: the AI proposes cuts, never rewritten narration

Studio was originally built around AI-*rewritten* narration: the director produced a
shortened script (`draftText`/`segments`), and a whole voice system (clone, presets,
per-run record/AI controls) existed to speak that new text over the footage. In practice
this can never work for on-camera screencasts — rewritten words don't match footage of
the speaker talking, and fixing that would mean AI-altered video, which we are not
pursuing. The owner-producer never once used AI voicing.

**Decision:** the cut is the only edit primitive. There is one text — the original
transcript — and the final cut is the original recording minus cuts, always in the
speaker's own recorded voice. The two-pass AI survives with new jobs: the master
director tiles the recording into scenes (windows touch end-to-end; footage can only be
dropped by a cut, never by scene omission) and emits per-scene *cutting briefs* plus
coarse baseline cuts; the scene refiner turns a brief plus *measured* dead space
(per-slice audio energy, not transcript gaps) into precise cuts. Adding words is out of
scope until a future **video patch** feature (a video-with-audio insert at a cut point);
audio-only additions are rejected because they can't line up with on-camera footage.

**Consequences:** the voice system (Voice prep stage, `VoiceStudio`/`CastStudio`,
`SegmentVoiceControl`, narration runs, snippet/adopt-original drags, overlap conflicts)
is deleted outright, not flagged off. The rewrite-reconciliation machinery (stories
03d/03h/03j/03k/03n/03o/03p) loses its rationale. `/api/scenes` and `/api/refine-scene`
change contract (and their live proxy rules must be updated to match). Existing projects
migrate by dropping narration/voice fields; scene windows and both cut layers survive.
The non-destructive layering (director baseline vs `refined` ai/manual) is unchanged.
