# 03c — Wire the per-scene refiner (second-pass director)

> Read `00-architecture-and-state.md` first.

**Status:** ✅ shipped (FE + live pipeline) · **Backend: BFFless `replicate` →
`google/gemini-3.1-pro` (multimodal), based on the master director `/api/scenes`.
The second, zoomed-in pass.**

> **Live.** `/api/refine-scene` is in the `studio` rule set (rule
> `afacb572-dc8a-4e9c-bfb6-8369fb36ddc2`), built straight off the master director
> `138f27fb`: `prep` (storage paths + scene-focused system/prompt) → up to 10
> conditional `signed_url` steps (one per dense scene sheet) → `collect` →
> `replicate` `google/gemini-3.1-pro` (`images`, `prompt`, `system_instruction`,
> `thinking_level:high`) → `parse` (JSON-parse + clamp segments/cuts into the
> scene span, sort + de-overlap segments) → `respond`. Debug on. Validators
> deferred to story 07 like the other rules. ⚠️ Needs the project Replicate token
> (same as director/voice). The MSW mock stays as the `MOCK_STUDIO` offline
> fallback like every other endpoint.

> **FE shipped (mock-first).** Pure `src/lib/refiner.ts` (`toRefinement`,
> `effectiveSegments`/`effectiveCuts`, `segmentsToTimedWords` + 10 tests); the
> non-destructive `Scene.refined`/`Scene.sheets` model in `scenes.ts`; windowed
> `captureSceneContactSheet` (+ `planSceneContactSheet`); `studioApi.refineScene`;
> the two per-scene actions (`generateSceneSheets`, `refineScene`,
> `clearRefinement`) in `useScenePipeline`; the `SceneRefinePanel` (two buttons +
> status) in Build; and the MSW `/api/refine-scene` mock. **Mock is gated by
> `MOCK_STUDIO` (currently `false`)** — flip it to exercise 03c without the
> backend. Still TODO: build the real `/api/refine-scene` BFFless rule (mirrors
> `/api/scenes` `138f27fb`). Then **03d/03e** below.

> **Narration TTS (shipped).** `/api/voice/narrate` (rule
> `d94513f9-7681-415d-a898-c32a722dec45`) speaks a run of script in the saved
> voice via `minimax/speech-2.8-turbo` and **persists** the mp3 to the bucket
> (`narration/` subDir, served by rule `16781299-9367-462d-b7a2-a237d97d3324`) so
> it survives reload and feeds the eventual ffmpeg assemble (05) — unlike
> `/api/voice/say` (ephemeral preview URL). Per **segment**:
> `generateSceneNarration` voices each `NarrationSegment`, measures the real clip
> length client-side, and stores `audioUrl`/`audioSeconds`/`audioSource` on the
> segment. MSW mock returns a tone stand-in.

> **Per-segment voice, inline (shipped).** Voicing is **not** a top-level button —
> each narration run has its own inline control in the diff viewer's New pane
> (`SegmentVoiceControl`, one row tall so panes stay aligned; the Original pane
> renders a matching spacer). Two ways to voice a run: **record it yourself** (mic
> via `useRecorder` → re-encode WAV → upload to the `voice/` bucket → `audioSource:
> 'recorded'`) because the AI voice "sounds like a robot, not me", or **AI** (the
> `/api/voice/narrate` TTS, `audioSource: 'ai'`). Once voiced: ▶ play + length +
> "you"/"AI", with re-record / re-AI. Hook: `generateSegmentNarration` +
> `recordSegmentNarration` + `setSegmentAudio` (writes into `scene.refined`,
> non-destructive), keyed busy via `voicingSegKey`.

> **Voiced span + word fit (shipped).** Once a run is voiced, the New pane paints
> its cells **green** from the segment start across the clip's REAL measured
> length (`audioSeconds`) — so you see where the audio ends (cut-red wins on
> overlap; new `--color-voice` theme token). `segmentsToTimedWords` now spreads a
> voiced segment's words evenly across `audioSeconds` (they end exactly at the
> audio end) instead of the arbitrary words/sec rate; un-voiced runs still use the
> rate as a placeholder.

Done in three phases, all specced in this file (scroll down): **03c** (this part —
the pipeline + data model + the two buttons, minimal UI), then **03d** (diff-viewer
rework: per-scene scope, no playhead, equal/aligned panes, cuts as red cells,
global words/sec knob, segmented rate-based right pane), then **03e** (sprite
filmstrip gutter). Ship 03c first so the heavy viewer work builds against real
refiner output.

## Why

The master director (03) sees the **whole talk** and spends its ≤10-image / ≤7 MB
Gemini budget across every scene — so each scene gets only a few frames, and it
returns a flat `draftText` + `cuts` with **no placement** for the new words. Today
`scenesToTimedWords` papers over that by smearing the words evenly across the
scene span.

The refiner is a **second pass on one scene**: it spends the whole image budget on
that single scene → a far **denser contact sheet** → and we ask it to *refine* the
first-pass suggestion, returning **where the new text actually lands** (anchored,
possibly in multiple sections with kept pauses between them) and **better cuts**.

## The two explicit buttons (Build, per scene)

Neither auto-runs — both are manual (paid model call + frame capture):

1. **Generate scene contact sheets** — capture denser frames windowed to
   `[scene.start, scene.end]`, compose + upload them. These are **separate** from
   the prep stage-④ whole-clip sheets. Stored on the scene.
2. **Refine scene** — feed those sheets + the scene transcript + the director's
   `draftText`/`cuts` (passed in **labeled as the first-pass suggestion**, to
   refine not regenerate) to `/api/refine-scene`; store the result into
   `scene.refined`.

## Data model (non-destructive — must be revertible)

The master director's output is an **immutable baseline**. The refiner (and, later,
manual edits in the diff viewer) write to a **separate layer**. Reverting = drop
the layer.

```ts
type NarrationSegment = { text: string; start: number; end: number }

type Scene = {
  // ── master director, first pass — NEVER overwritten ──
  draftText: string
  cuts?: Cut[]
  // ── per-scene dense contact sheets (button 1) ──
  //    url-only when persisted (base64 dataUrl stays transient/local, like the
  //    prep `pendingSheets` pattern in useScenePipeline).
  sheets?: ContactSheet[]
  // ── second-pass layer (button 2) — absent until refined; null again to revert ──
  refined?: {
    segments: NarrationSegment[]   // anchored; >1 when there are kept pauses
    cuts: Cut[]                    // refined cuts
    source: 'ai' | 'manual'        // refiner output vs. hand-edits (03d)
  } | null
}
```

"Throw it out, start from the original" → `refined = null`. Everything downstream
reads `refined ?? { from draftText + cuts }`.

## Backend (`/api/refine-scene` pipeline — mirrors `/api/scenes`)

1. `prep` — build storage paths + the prompt + system instruction. Prompt: "Here
   is one scene of a talk. First pass already suggested this shortened script and
   these cuts. Using the words and these (denser) frames, **refine** it: return the
   cuts that should actually be dropped, and the new script split into timed
   sections — each with the original-video start/end it should occupy. Add a
   section break wherever kept dead-air/pause should separate two runs of speech."
2. up to 10 conditional `signed_url` steps — one per scene contact sheet (same as
   `/api/scenes` signs each sheet so Replicate can fetch it).
3. `collect` → `replicate` `google/gemini-3.1-pro` (`images`, `prompt`,
   `system_instruction`, `thinking_level`).
4. `parse` — JSON-parse + **clamp/coerce**: every segment and cut clamped within
   `[scene.start, scene.end]`, segments sorted ascending and non-overlapping.
5. `respond` — `{ segments: [{ text, start, end }], cuts: [{ start, end }] }`.
6. Validators: `auth_required` + `rate_limit` deferred (mirrors 03/upload/transcribe).

## Front-end

- **Mock `/api/refine-scene` in MSW** (gated by `MOCK_STUDIO`) first: canned
  `segments` + `cuts` derived deterministically from the scene span (e.g. split the
  `draftText` into 2 sections around the suggested cut, anchored start/end).
- Pure `src/lib/refiner.ts` (mirrors `director.ts`): `RefineSceneRequest`,
  `RefineSceneResult`, `toRefinement(raw, scene)` (clamp/coerce), and
  `segmentsToTimedWords(segments, wordsPerSecond)` — rate-based: words flow from
  each segment's start at the configurable rate, with real gaps between segments.
  Unit-tested like director.
- `studioApi.refineScene` mutation.
- Windowed contact sheets: extend `src/lib/frames.ts` /`contactSheet.ts` so capture
  can target `[start, end]` (today `captureContactSheet`/`planContactSheet` take
  only `duration`). Add `captureSceneContactSheet(src, start, end)`.
- `useScenePipeline.ts`: two new per-scene actions — `generateSceneSheets(id)` and
  `refineScene(id)` — writing `scene.sheets` (url-only persisted) and
  `scene.refined`. Plus `clearRefinement(id)` (sets `refined = null`).
- Minimal Build UI only: the two buttons + status. The segmented right pane,
  cuts-as-red-cells, equal heights, wps knob, and filmstrip are **03d/03e**.

## Acceptance criteria

- [x] Two manual buttons per scene in Build: generate scene sheets, then refine.
      Refine is disabled until the scene has sheets.
- [x] `/api/refine-scene` returns `segments` (anchored, ≥1, splitting on pauses)
      and refined `cuts`, clamped **both** server-side (`parse` step in rule
      `afacb572`) and client-side (`toRefinement`).
- [x] The director's `draftText` and `cuts` are never mutated; `refined` is a
      separate field; `clearRefinement` reverts to the first-pass cleanly.
- [x] Scene contact sheets are distinct from prep sheets, url-only when persisted
      (no base64 in Redux/localStorage).
- [x] Mock and real share the result shape (`toRefinement` coerces both; swap,
      don't rewrite the UI).
- [x] `segmentsToTimedWords` lays words rate-based per segment (unit-tested).
- [x] build/lint/tests pass (114 tests).
- [x] Real `/api/refine-scene` BFFless pipeline built (rule `afacb572`, based on
      the master director `/api/scenes`).

## Out of scope (for 03c itself)

The diff-viewer rework and the sprite filmstrip — both specced below as later
phases of this same effort; manual cut-toggling in the grid; voice/assemble (05).
Real `auth_required`/`rate_limit` (07). 03c lands the pipeline + data + the two
buttons with minimal UI; the phases below build the actual viewer on top.

---

# 03d — Diff-viewer rework (later phase)

> Builds on 03c. The diff viewer becomes the main editing surface, scoped to one
> scene and reading the refiner's output.

**Status:** mostly shipped — no playhead, **cuts as red cells**, equal/aligned
panes, segmented right pane, **green voiced span + word-fit**, per-segment inline
voicing (record/AI), and now **manual cut editing** (below) all landed. Still
after that: global wps knob, true per-scene scoping.

## ✅ Manual cut editing (add / extend / contract) — shipped

Let the user fix the AI's cuts by hand, directly in the diff viewer. Non-destructive,
like everything else in the refiner layer.

- **Drag-to-paint** on the grid cells. The cell the drag *starts* on fixes the op:
  start on **kept** footage → **add** (drag to size a new cut, or drag from a cell
  adjacent to an existing cut to **extend** it — the merge grows it); start on a
  **red** cell → **remove** (drag to **contract** a cut from its edge, or carve the
  middle to split it). A single click is a one-cell edit.
- Pure cut math in `refiner.ts`: `addCut(cuts, span, scene)` (clamp + merge),
  `removeCut(cuts, span)` (subtract/split), `normalizeCuts` (sort/coalesce/drop
  slivers) — all unit-tested. Both ops fold into ONE flat `refined.cuts` list (no
  separate additive "user cuts" overlay — un-cutting is a subtraction, which an
  additive layer can't express).
- `useScenePipeline.editSceneCut(sceneId, span, op)` writes `scene.refined.cuts`
  with `source: 'manual'`, materializing the refinement from the director baseline
  on the first edit (same `setSegmentAudio`-style merge). `scene.cuts` is never
  touched, so `clearRefinement` still reverts cleanly.
- Edits route to the scene that owns the drag's start time (`sceneAtTime`), clamped
  to that scene. Spans snap to whole cells (current `segmentSeconds` granularity).
- Re-uses the existing `effectiveCuts` read path + red-cell rendering; this added
  only the *write* side + a drag preview (terracotta ring = add, neutral = remove).

## ✅ Reuse original audio + delete runs — shipped

Use a slice of the source clip's OWN audio as a New-pane run (no re-voicing) and
delete runs to make room. Fill-gaps-only, non-destructive (writes
`scene.refined`, `source: 'manual'`).

- **Two-step grab → place.** Drag-select a span on the **Original** pane to grab
  it (green outline, "Placing Xs" banner); the **New** pane then glows its gaps
  and a click on a gap the clip fits drops it there. Esc / Cancel aborts. Chosen
  click-to-place over free cross-pane drag (far more reliable; same two-step feel).
- **Real audio clip.** `sliceAudioWav(audioUrl, start, end)` slices the whole-clip
  WAV (original-video second = audio second) and uploads it (`kind: 'voice'`) → a
  standalone clip played like any other run, `audioSource: 'original'`.
- **Pure helpers** (`refiner.ts`, tested): `gaps`, `fitsGap` (placement guard),
  `insertSegment`/`removeSegment`. `useScenePipeline.adoptOriginalAudio` (slice →
  upload → fit-check → insert) + `deleteSegment` (reopens the gap).
- **Delete a run**: an ✕ on each inline `SegmentVoiceControl` removes that run;
  the source label now reads you / AI / **original**.

## Goal

Turn the transcript time-grid (`TranscriptDiff`) into the per-scene edit surface.

## Changes

- **Per-scene scope.** The viewer renders only the **selected** scene's window
  (its slice of `words` on the left; its `refined.segments ?? draftText` on the
  right), driven by the `SceneTabs` selection — not the whole talk.
- **Remove the playhead.** Drop the `currentTime` highlighting entirely (the red
  cells today are the cell under the video time — no value here). `currentTime`
  prop goes away.
- **Cuts as red cells.** Color the grid cells that fall inside a cut span red, on
  the **original/left** pane (the footage being dropped). Source = `refined.cuts ??
  cuts`.
- **Equal, row-aligned heights.** Left and right panes share row height and total
  height so timestamps line up across the divider (and so the 03e filmstrip can
  align to them).
- **Global words/sec knob.** A select in the diff header (next to seconds/line)
  driving `segmentsToTimedWords` — the right pane flows rate-based per segment.
- **Manual cut-toggling.** Click a cell to add/remove it from the cut set; writes
  `scene.refined` with `source: 'manual'` (never touches the director baseline).

## Acceptance criteria

- [x] Viewer shows only the selected scene; switching tabs re-scopes it.
      _(Studio derives `sceneWords`/`editedWords`/`cutSpans`/`segmentControls`/
      `gapSpans` from `selected` only and passes `windowStart`/`windowEnd`;
      `TranscriptDiff` crops both panes + the filmstrip via the pure
      `windowLines` helper. Timestamps stay absolute — scene 2 reads from 1:44.)_
- [x] No playhead/`currentTime` code path remains. _(removed from TranscriptDiff,
      PreviewPlayer `onTime` now optional, Studio `currentTime` state dropped)_
- [x] Cut spans render as red cells (`bg-terracotta/30`) on **both** panes via
      `cutColumns`; reflect `refined.cuts` when present, else the director `cuts`
      (`effectiveCuts`).
- [x] Panes are row-aligned and equal height — `buildTranscriptGrid(minSeconds)`
      pins both to the longer of the two transcripts + the cuts, so a trailing cut
      with no words still shows.
- [ ] Global wps knob re-flows the right pane (rate-based, per segment). _(rate is
      `WORDS_PER_SECOND` default for now; knob TBD)_
- [x] Drag-paint edits cuts into `refined` (`source: 'manual'`), revertible —
      add/extend (start on kept) and contract/split (start on red). Pure
      `addCut`/`removeCut`/`normalizeCuts` in `refiner.ts`, unit-tested.
- [x] Reuse original audio: grab a span on the Original pane → place into a New
      gap as an `audioSource:'original'` run (sliced + uploaded clip), fill-gaps
      only; delete runs to make room. Pure `gaps`/`fitsGap`/`insert/removeSegment`.
- [x] build/lint/tests pass (141 tests).

---

# 03e — Sprite filmstrip gutter (later phase)

> Builds on 03c/03d. A visual time ruler down the left of the diff viewer.

## Goal

A ~160px-wide column on the left of the diff viewer, running top→bottom
**time-aligned to the grid**, so the row at 0:12 shows the 0:12 frame — you can see
where the text lands visually as you scroll.

## Approach (shipped)

- Reuse the **contact sheets as sprites** — no new image generation. The frame
  index (`src/lib/filmstrip.ts`, pure + tested) flattens every sheet's cells into
  one time-sorted list: per-scene dense `sheets` first (so they win on overlap),
  then the whole-clip prep sheets fill everywhere else. `frameAt` finds the cell
  nearest a row's time; `spriteStyle` crops it via `background-position`.
- **Cell geometry is now persisted metadata.** `composeContactSheet` stamps
  `cellWidth`/`cellHeight`/`gap` onto each `ContactSheet` (alongside the existing
  `width/height/cols/rows/times[]`) — derivable, but saved so the sprite math is
  self-contained and survives any change to the gap/layout. Both prep and refiner
  sheets get it for free (one shared compositor).
- **Alignment, not a time→pixel ruler.** The original spec planned to size each
  frame by `interval / secondsPerLine` rows — but the panes have **non-uniform**
  row heights (a per-segment voice control injects an `h-9` spacer above some
  rows), so a pure time ruler would drift. Instead the `Filmstrip` column runs the
  **same** `buildTranscriptGrid` + segment-row mapping as the Original pane and
  emits the same spacer, so it stays in lockstep row-for-row at any zoom. One
  frame per row (nearest its start second), centre-cropped to the flat row box.
- Layout: a fixed ~150px gutter, **left of the resizable Original|New split** (so
  the divider's percentage math is unaffected); `hidden lg:block` like the divider.
- **Hover-to-peek:** at rest each cell shows the centred band (frame scaled to the
  gutter width, vertically centred, clipped to the row); on hover the whole frame
  pops over its neighbours with a slight border + shadow.
- **Tall-rows toggle** (`tall frames` / `compact rows` in the diff header): grows
  **every** row — the gutter cell AND the Original/New panes (via a `rowHeight`
  threaded into `Row`'s `grid-auto-rows`) — to a full frame's height, so frames
  show in full while staying row-aligned to the words. The row divider lives on a
  wrapper outside the sized box so the gutter and panes don't drift by 1px/row.

## Acceptance criteria

- [x] Left gutter of time-aligned thumbnails, sliced from contact sheets (sprite),
      no extra image generation.
- [x] Frame shown at a given row matches that row's time; aligned to the grid rows
      (incl. the segment spacers), so it scrolls in lockstep.
- [x] Uses the scene's dense sheets when present, else the prep sheets
      (`buildFilmstrip` order + `frameAt` nearest).
- [x] Cell geometry (`cellWidth/cellHeight/gap`) persisted on `ContactSheet` via
      the shared compositor; `filmstrip.ts` unit-tested (9 tests).
- [x] build/lint/tests pass (150 tests; the 2 lint errors are pre-existing in
      `ChatPopup/ChatPanel.tsx`, untouched here).
