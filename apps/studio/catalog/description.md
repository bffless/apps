Studio turns one long, rambly screen recording into a short, watchable video —
in your own recorded voice. Nothing is re-voiced and the AI never rewrites what
you said.

**How it works**

1. **Import** a screen recording. It uploads straight to your storage bucket
   (presigned, so big files are fine).
2. **Prep** runs the locked pipeline: audio extraction, word-level
   transcription (WhisperX), a contact sheet of frames, and the AI "master
   director" that splits the recording into scenes and proposes cuts.
3. **Build** is where you produce: tune each scene's cuts on the transcript
   grid, optionally run the per-scene refiner, and assemble kept spans with the
   clip's own audio.
4. **Export** stitches the final cut entirely in your browser with ffmpeg.wasm
   — no render farm, nothing leaves your machine.

There's also a companion blog writer that drafts a post (with pulled stills)
from the finished video's transcript, and an AI thumbnail workflow.

**What it needs**

Studio is a static app; every backend step is a BFFless pipeline on your own
instance. Bring a Replicate token (transcription, scene direction, voice,
thumbnails), an Anthropic key (thumbnail drafts, blog writer),
a storage bucket with presigned uploads, and one cross-origin isolation
response-header rule for the in-browser exporter. A Hugging Face `HF_TOKEN`
is optional, for speaker diarization. The install steps walk through each.
