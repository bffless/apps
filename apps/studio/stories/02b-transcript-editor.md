# 02b — Transcript time-grid editor + dev mocks

> Read `00-architecture-and-state.md` first. Follow-on to `02-wire-transcription.md`.

**Status:** ✅ done · **Front-end only** (plus MSW dev mocks; no new backend).

## Goal

Show the transcript that story 02 produces, and stop paying Replicate while we
iterate on the UI.

1. **A transcript editor** under the video, modelled on **GitHub's diff viewer**:
   two panes (left = original transcription, right = the new/shortened version),
   with **timestamps as the line numbers**. Each row is a fixed time window and
   words sit where they fall on the clock, so reading left→right then down
   follows the audio.
2. **Dev mocking** so importing a clip and running prep never hits the bucket or
   the **paid** transcription model.

## Front-end (done)

- **`src/lib/transcriptGrid.ts`** (+ `transcriptGrid.test.ts`) — pure layout
  logic. `buildTranscriptGrid(words, secondsPerLine, segmentSeconds)` buckets
  word-level timestamps into rows of `secondsPerLine` seconds, each sliced into
  `segmentSeconds`-wide cells. **Defaults: 5 s rows, 0.25 s cells** — real speech
  is 2–3 words/second, so one-second cells piled words up; quarter-second slices
  give each word its own slot. Empty rows are emitted for silence so the grid
  stays continuous. Also `segmentsPerLine`, `gridPosition` (playhead → row/col),
  `formatClock` (`m:ss`).
- **`src/components/Studio/TranscriptDiff.tsx`** — the two-pane renderer.
  - Configurable **seconds/line** (2 · 3 · 5 · 10) and **segment** (1 · 0.5 ·
    0.25 · 0.1 s) via header selects. Column separators are drawn only on
    **whole-second** boundaries so the sub-second slices stay quiet.
  - Rows are **single-line**: a word sits at its slot with `nowrap` and bleeds
    right over the (usually empty) neighbouring slices instead of wrapping;
    overflow is **clipped to the pane** so it never spills into the other side.
    Words are **vertically centered**.
  - **Playhead**: the cell under `currentTime` highlights, and each pane
    **auto-scrolls** to keep the active row in view (scrolls only its own
    container, never the page, and only when the row drifts out of sight).
  - Right pane currently **mirrors** the left (labelled "copy — shorten in
    prep"); it becomes the genuinely-different shortened transcript when story 03
    lands. That's when the diff earns its keep.
- **`src/pages/Studio.tsx`** — mounts `TranscriptDiff` full-width under the
  video in the **prep** phase once transcription returns words; wires the video
  `onTime` to a `currentTime` playhead.

## Dev mocks (done)

`src/mocks/handlers.ts` gained `studioHandlers`, gated by **`const MOCK_STUDIO =
true`** (dev only — MSW isn't started in prod). They return the **same shapes**
the real pipelines do, so the FE is identical either way:

- `POST /api/uploads/:kind/prepare` → fake bucket PUT URL + storageKey
- `PUT <mock bucket>/*` → 200 (swallow the bytes)
- `POST /api/uploads/:kind/register` → `{ url }`
- `POST /api/transcribe` → **`src/mocks/transcribeFixture.ts`**, a **real
  captured WhisperX response** (82 words with timestamps, pulled from a live run)
  so the editor has realistic data for free.

Flip `MOCK_STUDIO` to `false` to exercise the live endpoints (unhandled `/api/*`
then bypasses to the Vite proxy). The audio is still **extracted in-browser**
either way — the mocks only short-circuit the network.

## Bug fix (done)

A fast double-click fired the **paid** `/api/transcribe` twice: the `next` guard
in `useScenePipeline` checked the `running` **state**, which only updates on the
next render, so both clicks read it as false. Added a synchronous `runningRef`
that flips immediately — the duplicate bails before any work.

## Acceptance criteria

- [x] Transcript renders in a two-pane, timestamp-lined time grid under the video.
- [x] Line length + segment size configurable; words placed by their timestamp.
- [x] Dev never hits the bucket or paid Replicate (MSW), via a real fixture.
- [x] No duplicate transcribe calls. build/lint/tests pass (55 tests).

## Out of scope / follow-ons

- The right pane stays a copy until **story 03** feeds it the shortened
  transcript — then it's a real diff.
- Editing the right pane (re-time / re-word) is not wired yet.
- Open question for later: at 0.1 s, words still **overlap**; the alternative is
  content-sized columns (no overlap, slightly looser cross-pane alignment).
