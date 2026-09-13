# Blog images are clean re-captured frames, not contact-sheet crops

The AI never cuts pixels. It reads the [[Contact sheet]]s as visual context and returns
**timestamps** (inline Markdown tokens it places in the prose, plus a caption). A **clean,
label-free** frame is then grabbed from the source video at each timestamp **on the server**,
by CE's ffmpeg `frames` op (`POST /api/video/frames`) at 1080 px tall, and referenced at its
`/api/uploads/projects/<id>/frames/server/...` serve URL, with no re-upload.

The obvious-looking alternative is to crop the chosen cell straight out of the existing
contact-sheet image (the `spriteStyle()` / `background-position` slice already exists). We
rejected it: every contact-sheet cell carries a **burned-in wall-clock timestamp** in the
corner and is at thumbnail resolution (~720px, often JPEG-compressed to fit Gemini's 7 MB
limit) — fine as the model's eyes, wrong as a hero blog image.

This is the deliberate deviation worth recording: a future reader will see contact sheets
already loaded and think "just crop the cell." Don't — re-capture from source. The contact
sheet is an **input** (the AI's vision and its timestamp source), never the source of the
final pixels.

_2026-09-13 (PR #699): the mechanism changed from browser capture + upload to server frame
grabs; the decision did not._
