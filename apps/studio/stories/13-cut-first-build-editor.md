# 13 — Cut-first Build editor

> Read `00-architecture-and-state.md` first, then `docs/adr/0003-cut-first-editing.md`
> (the decision this story implements) and `CONTEXT.md` (the vocabulary). This story is
> the umbrella plan; each phase below is **one PR** (`build`, `lint`, `test:run` green).

## Why

The Build screen was designed as a GitHub-style *diff*: original transcript on the left,
AI-rewritten narration on the right, a voice system to speak the rewritten words. Real
use is nothing like that: the producer always keeps the original voice, never reads the
left pane, finds two texts confusing, and edits by **cutting dead space** — and inserted
audio snippets could never be made to line up with on-camera footage. ADR-0003 pivots
the model: **one text (the original transcript), cuts as the only edit, original audio
always.**

## The target experience

One full-width **cut editor** per scene (replaces the two-pane `TranscriptDiff`):

- The grid shows the **original words** on the time grid (rows = seconds, cells = 0.1 s
  slices), with the filmstrip gutter kept on the left, row-aligned as today.
- Every cell reads as one of: **speech** (words), **dead space** (measured true silence —
  dimmed), **noise** (energy but no words — breath/click marker), **cut** (red, on top of
  any of the above), **playhead** (highlight while playing).
- Dead space comes from the **extracted 16 kHz WAV** (RMS per grid slice against a
  silence threshold), *not* from gaps between word timestamps.
- Drag on cells to cut / un-cut exactly as today (`onEditCut` semantics unchanged).
- **Play = the stitched result**: click a timestamp and playback skips red spans
  (audio + video), playhead tracking the grid. Modifier-click plays the raw source
  through cuts. A keyboard-reachable **audition** gesture on a cut plays ~1.5 s before
  the cut through ~1.5 s after — the edit-listen loop. No auto-play on edit.
- Header shows a live duration readout: `final cut 4:32 · source 12:10` (pure arithmetic
  over cuts).
- An **auto-trim dead space** tool (deterministic, client-side) cuts silences given
  threshold / minimum-pause / keep-padding knobs. Not AI.
- Toolbar keeps **Search** (story 08; hits jump the grid) and the density controls
  (seconds/line, segment size, compact rows). **Add snippet is gone.**

## Model changes

- **Director** (`/api/scenes`): returns `{ synopsis, scenes[{ title, start, end, brief,
  cuts[] }] }`. No `draftText`. Scenes **tile** the recording (`scenes[n].end ===
  scenes[n+1].start`, first 0, last duration) — coercion (`toScenes`) enforces tiling by
  snapping gaps shut. `brief` is the cutting brief for the refiner (story 03q's scene
  prompts, promoted to the contract).
- **Refiner** (`/api/refine-scene`): input = scene's timed words + dense contact sheets
  + `brief` + **measured dead-space spans**; output = precise `cuts[]` only. No
  `segments`. Prompted to snap cut edges into silence, never mid-word.
- **Layering unchanged**: director cuts = immutable baseline; refiner/hand edits →
  `scene.refined` (`source: 'ai' | 'manual'`); revert = `refined = null`; reads via
  `effectiveCuts`.
- **Dead space** is derived data: computed once per project from the WAV (decode →
  RMS per 0.1 s → spans via threshold + min duration), stored as spans in the slice
  (small; url-only rule untouched), fed to the refiner and the grid.
- **Scene lifecycle kept** (deliberate): walking into a scene runs its per-scene work —
  clip slice (03g) → dense sheets → refiner — on demand, never auto-fanned. *Built* now
  means "pipeline ran + cuts signed off"; assemble still gates on all scenes built.
  Auto-build board (03s) survives as the explicit "run every scene's pipeline" batch.
- **Prep pipeline**: upload → extract audio → transcribe → contact sheet → director.
  The Voice stage is deleted.
- **Export**: assemble = per-scene ffmpeg cut + concat of the **source** footage with
  its own audio. All narration-mixing paths go.

## What is deleted outright (ADR-0003)

Voice prep stage, `VoiceStudio`, `CastStudio`, `SegmentVoiceControl`, narration runs
(`segments`, move-run drag, overlap conflicts + amber fill), snippet add/drop,
adopt-original drag (03d/03h), per-run voice picker (10d), Re-record / Re-AI header, the
green "voiced" cell state, voicing `/api` calls from the app flow, and the
rewrite-reconciliation machinery (03n snap-to-verbatim, 03o trust-the-tag, 03p
word-timings-from-scratch). Git history is the archive.

## Phases (one PR each)

Ordered so the app ships green at every step:

1. **13a — Single-pane cut editor.** Collapse `TranscriptDiff` → `CutEditor.tsx`:
   remove the Original pane, split divider (`studio.diff.leftPct`), adopt-original,
   add-snippet, and the spacer machinery. Grid shows original `words` + `effectiveCuts`
   + filmstrip. Voice header/runs untouched for one PR (still rendered from old state)
   to keep the diff reviewable.
2. **13b — Delete the voice system + export on original audio.** Remove the components,
   the runs/overlap model, the Voice prep stage, and switch assemble to cut+concat of
   source audio. Persist-version bump + migration: keep projects/scenes/windows/titles/
   both cut layers; strip `draftText`, `segments`, narration audio, voice/cast state.
   (Land 13b before or with 13a if reviewable — 13a must not ship a broken voice UI.)
3. **13c — Measured dead space.** `lib/deadSpace.ts` (decode WAV → RMS/slice → spans;
   unit-tested), spans in the slice, three-state cell rendering (speech / dead / noise).
4. **13d — Stitched playback + seam audition.** Kept-span playback skipping cuts
   (extend `clipPlayer`/`usePreviewTransport`), raw-source modifier, audition gesture,
   live duration readout.
5. **13e — Auto-trim dead space.** Deterministic tool + knobs; writes manual cuts.
6. **13f — Director/refiner contract.** New prompts + `toScenes`/`toRefined` coercion
   (tiling enforced, briefs, cuts-only refiner, dead space in the refiner request); MSW
   fixtures updated to the same shape. ⚠️ After merge, update the **live proxy rules**
   on the `studio` set via MCP (sandcastle doesn't deploy them) and re-export
   `bffless/studio.proxy-rules.json`.
7. **13g — Lifecycle polish.** *Built* = pipeline ran + signed off; auto-build board
   repurposed to the per-scene pipeline batch; stale voice gating removed from
   assemble; stories/README "where we are" updated.

## Out of scope

- **Video patch** (recorded video-with-audio insert at a cut point) — the only future
  way words get *added*. Gets its own story when wanted.
- Any AI rewriting of narration, ever (ADR-0003).
