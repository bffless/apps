# Studio — story backlog

`/studio` turns one long, rambly recording into a short video **re-voiced in the
user's own cloned voice**. The AI shortens the transcript and groups it into
scenes (chapters) with timestamps; the producer then builds each scene one at a
time. Each story is written to be picked up **with fresh context**: read
`00-architecture-and-state.md`, then the one story.

## 📍 Where we are now

**Prototype shipped + stories 01 / 01b / 02 done.** Prep is now a **manual,
step-by-step flow** under a top-level **stepper** (Import → Prep → Build →
Export) so it's clear where you are and what's next. Each real prep step has its
own button; the still-mocked downstream (shorten/segment/clone) is grouped behind
one "Finish prep" action. Story 01b added an **extract→upload-audio** step (the
WAV gets its own bucket upload so Replicate can transcribe it). Story 02 wired
**real transcription**: `/api/transcribe` mints a presigned audio URL and runs
Replicate **WhisperX** (`align_output:true` for word timestamps). ⚠️ Needs the
**Replicate API token** set in BFFless Settings → AI before it returns live.
Story 02b added the **transcript editor** (a GitHub-diff-style time grid under
the video) and **MSW dev mocks** (`MOCK_STUDIO`) so iterating never hits the
bucket or the paid model — `/api/transcribe` returns a real captured fixture.
**Story 03 shipped the AI master director**: `/api/scenes` (live, rule
`138f27fb`) signs each contact sheet and hands it + the timestamped transcript +
the creator's free-text direction to **`google/gemini-3.1-pro`**, which returns a
one-line **synopsis** plus **scenes** (tightened script, original-video span,
parseable `cuts`). The prep page got a **Director panel** (direction input + send
action), Build shows the synopsis + per-scene cuts, and the shortened script now
fills the 02b diff's right pane. **Story 04 shipped the voice step**: a
**VoiceStudio** resource at the bottom of prep where you either **clone your own
voice** (mic recorder + live level meter → `/api/voice/clone`), **reuse a saved
`voice_id`**, or **pick a MiniMax preset**, then **Generate a sample** to hear it
(live `/api/voice/say`, `speech-2.8-turbo`). The **$3 clone is now ENABLED**
(`minimax/voice-cloning`; recording re-encoded to WAV first; minted ids auto-saved
for free reuse) — built disabled-first behind a preset stub, flipped on after
verification. **Story 03c shipped the per-scene refiner + diff-viewer rework**: a
second, zoomed-in pass — `/api/refine-scene` (rule `afacb572`, Gemini 3.1 Pro fed
**dense per-scene** contact sheets) returns anchored narration **segments** +
refined **cuts**, written non-destructively to `scene.refined` (the director's
first pass is never overwritten; revert = clear it). The Build diff viewer is now
the edit surface: scene **tabs** + a `SceneMeta` panel beside the video, the
time-grid diff full-width below with **cuts as red cells**, equal-height panes,
and **per-segment inline voicing** — **record it yourself** (mic → WAV → bucket)
or **AI** (`/api/voice/narrate`, persisted mp3) — plus a **green** span showing
each clip's real length with the words fit to it. **Story 03e shipped the sprite
filmstrip gutter**: a fixed ~150px column down the left of the diff viewer showing
the contact-sheet frame nearest each row's time — reusing the already-captured
sheets as CSS sprites (`src/lib/filmstrip.ts`, `cellWidth/cellHeight/gap` now
persisted on `ContactSheet`), row-aligned to the grid (incl. segment spacers) so
it scrolls in lockstep. **The diff grid now draws out to the full clip
`duration`** (not just the last transcript word/cut), so trailing footage where the
talk ends before the clip does (e.g. speech stops ~0:50 on a 0:53 clip) renders as
**editable** rows the producer can hand-cut — it was previously invisible. **Story
05 shipped the ffmpeg assemble MVP**: the export step is now a single **walk of the
original timeline** — pure, unit-tested `src/lib/export/assemble.ts` (`buildSlices`
→ `planAssembly` → `buildFfmpegCommand`) tags every slice **cut** (drop) /
**segment** (keep + that clip's audio) / **dead** (keep + silence), **cut wins on
overlap**, and emits the `filter_complex` that trims+concats the kept footage
against the resampled narration clips + generated silence (one common 48 kHz mono
format; no loudnorm/crossfades yet). `src/lib/export/ffmpeg.ts` lazy-loads the
**single-threaded** ESM wasm core on first assemble (bundled locally from the
`@ffmpeg/core` npm package via Vite `?url` — no CDN; the 32 MB wasm is a hashed
asset fetched only on first assemble — no COOP/COEP needed), and `AssembleBar` drives it
from the Build view's **Export** step once every scene is built: progress bar,
errors surfaced, inline `<video>` preview + **Download MP4**. Trailing dead space
is **honored** (kept silent) so export = what the grid shows. The cut also **saves
like every other resource**: **Save to my library** uploads the MP4 via a new
presigned `export` flow (rules `2ec4f942`/`7459fb60`/`bea10a3d`) and persists only
the serve URL (`finalCutUrl`), so a refresh brings the saved cut back to
play/download — re-assemble + save overwrites it. Scenes carry a manual **Mark
built / re-open** toggle (tab ✓ + readiness line; never auto-set). **Story 05
optimizations are slated next but NOT done**: audio polish (per-segment `loudnorm`
+ short `acrossfade`), a stream-copy/no-re-encode speed path, and — **parked** —
multithreaded ffmpeg.wasm (`core-mt` is incompatible with `@ffmpeg/ffmpeg@0.12.15`'s
module worker + classic pthread workers; reverted to single-threaded). See story 05's
"Optimizations — slated next". **Stories 10a–10d shipped speaker diarization + per-person voices** (branch
`studio/diarization-cast-voices`): WhisperX now runs with `diarization:true` and
carries a per-word `speaker` label through the transcript; a new project **cast**
(`Person[]`) lets the producer name people and assign each one a voice; the
director receives a speaker-labelled transcript; and at Build each narration
segment defaults to its dominant speaker's voice with a per-segment override
`<select>`. **Next up overall: manual cut editing (03d phase) —
let the user add/remove cuts directly in the diff viewer** — then the wps knob.
(Per-scene scope shipped: the Build diff is now windowed to the selected scene tab
via `windowLines`, instead of rendering the whole talk.)

**The `studio/projects` initiative (stories 11a–11d) is COMPLETE.** All four
stories have shipped: 11a introduced projects as first-class entities
(local-first, keyed Redux collection, list/create/open/rename/delete UI, metadata
middleware, `savedVoices` hoisted to a shared library, clean-slate persist key
bump); 11b added URL-driven routing (`/studio/project/:id/:phase`,
`StudioProjectGuard`, phase clamp/resume via `resolvePhase`/`maxPhaseFor`, keyed
workspace remount, `revisitPrep`/`inExport` removed); 11c nested every upload under
`uploads/projects/<id>/<type>/…` via dynamic `subDir` interpolation (enabled by
`bffless/ce#324`) across all 6 prepare + 6 register rules + the narrate step,
added a new `GET /api/uploads/projects/*` serve rule (id `30355b6d`), and wired
project-delete to wipe the entire bucket prefix via `POST /api/projects/delete`
(`file_delete`, rule `67359cca`, best-effort client call + immediate local remove).
**11d (server-side project sync) shipped the durable home:** a `studio_projects`
data-table schema (`d183deed-…`) + CRUD rules (create `25fc934e`, list `d48bca6d`,
get `9f8c5a94`, save `1b510d2d`, delete extended on `67359cca` to also `data_delete`
the record), records addressed by a `projectId` field filter with timestamps stored
as `createdMs`/`updatedMs`; a pure `projectSync.ts` (last-write-wins reconcile,
local-only projects pushed up — no clean-slate); slice
`hydrateProject`/`evictWorking`/`evictOthers`/`reconcileServerIndex`; RTK CRUD +
MSW mocks; `useProjectAutosave` (debounced save · flush-on-exit · evict-others,
StrictMode-safe); list-from-server, create-on-server, and hydrate-or-redirect on
open. **Net: projects are now first-class, URL-addressable, per-project
bucket-stored, AND server-synced — they survive a cleared browser and follow the
user across devices.** Story **07** will layer auth / per-user scoping across the
studio routes (the destructive project + upload routes are flagged for
`auth_required` there).

```
done/        ✅ 00-scene-producer-prototype  ✅ 01-wire-upload-bucket
             ✅ 05 ffmpeg assemble (timeline walk → MP4 + save + loudnorm/fades)
inprogress/  ✅ 01b-wire-audio-bucket (stepper + manual prep + audio→bucket)
             ✅ 02-wire-transcription (WhisperX; needs Replicate token)
             ✅ 02b-transcript-editor (time-grid diff view + dev mocks)
             ✅ 03 master director (Gemini 3.1 Pro → synopsis + scenes + cuts)
             ✅ 04 voice step (clone enabled / preset + live TTS preview)
             🔨 03c refiner + diff-viewer (segments + cuts, per-segment voice, green/fit)
                 ↳ ✅ 03e sprite filmstrip · ✅ per-scene scope (diff windowed to the selected tab) · ▶ next: manual cut editing · then wps knob
             🔨 03f refiner context+gating · ✅ Part 0 async fire-and-poll (jobs DB + postSteps + poll, no more timeouts) · ▶ next: Parts A–D (handoff · synopsis · prompt · gate)
             ✅ 03j ai voicing source (director `voicing` plan · refiner segment `source` · auto-adopt original)
             ✅ 03k scene audio → refiner (cut audio saved with the clip · Gemini hears it · audio-aware cuts)
             ✅ 03l scene prompts (per-scene direction · director-prompt passthrough + include-checkbox)
             ✅ 03m prompt transparency (collapsed "what we sent Gemini" disclosure) · re-run the master director (confirm-gated)
             ✅ 03n snap-to-verbatim (original tags drive; boundaries snapped to the real word run instead of demoting)
             ✅ 03o trust-the-tag (model's original/revoice tag + its timestamps are authoritative; verbatim gate + snap removed)
             ✅ 03p word timings + refine-from-scratch (send per-word times, drop the first pass; rule afacb572 prompt rewritten)
             ✅ 03r seam-aware context (refiner gets the previous scene's lead-in + position in the talk; rule afacb572 prep)
             ✅ 03s auto build (one-press unattended Build: cut → sheets → refine → voice → assemble+save → final stitch; halt+resume)
             ·  06 · 07                                (queued)
```

## Order & status

| # | Story | Stage(s) wired | Status |
|---|-------|----------------|--------|
| — | `../../done/00-scene-producer-prototype.md` | board + scene UX | ✅ done |
| — | `00-architecture-and-state.md` | — | reference (read first) |
| 00c | `00c-redux-state-persistence.md` | Redux + localStorage persist · RTK Query · mocks on | ✅ done (infra) |
| 01 | `01-wire-upload-bucket.md` | ① bucket upload | ✅ done |
| 01b | `01b-wire-audio-bucket.md` | ② extract + audio→bucket · stepper | ✅ done |
| 02 | `02-wire-transcription.md` | ③ transcribe (WhisperX) | ✅ done* |
| 02b | `02b-transcript-editor.md` | transcript time-grid editor · dev mocks | ✅ done |
| 03 | `03-wire-shorten-segment.md` | ⑤⑥ master director (synopsis + scenes + script + cuts) | ✅ done |
| 04 | `../../done/04-wire-voice-clone.md` | ⑥ voice step (clone enabled · saved-id reuse · preset · TTS preview) | ✅ done |
| 03c | `03c-wire-scene-refiner.md` | per-scene refiner (`/api/refine-scene`) · diff-viewer rework · per-segment record/AI voice · narrate TTS | 🔨 in progress (next: **manual cut editing**, see the 03d phase in-file) |
| 03f | `03f-refiner-context-and-gating.md` | **async fire-and-poll** for director/refiner (jobs DB + `postSteps` + poll, no more timeouts) · director→refiner story-context handoff · per-scene synopsis · custom refine prompt · gate diff viewer behind sheets+refine | 🔨 Part 0 ✅ (async poll); Parts A–D next |
| 03h | `../../done/03h-free-segment-editing.md` | free segment editing — drop original audio **anywhere** (overlap flagged amber, not blocked) · drag a run's ⠿ handle to re-time it · assemble gated on overlaps | ✅ done |
| 03i | `../../done/03i-scene-preview-player.md` | scene preview player — flipbook of filmstrip frames + narration stitched via Web Audio scheduling, simulating `planScene()` with **no ffmpeg**; modal `<dialog>` opened from the sticky tabs + Assemble bar | ✅ done |
| 05 | `../../done/05-wire-ffmpeg-assemble.md` | assemble (timeline walk: cut/segment/dead) + save + audio polish | ✅ done† |
| 08 | `08-transcript-search.md` | transcript search (`/api/search-transcript`, rule `504a39bd`, Gemini text-only, sync) — find-by-meaning over the whole talk · Play preview · Grab → existing place mode | ✅ done |
| 03j | `03j-ai-voicing-source.md` | director per-scene `voicing` plan · refiner per-segment `source` (original/revoice) · auto-adopt original audio | ✅ done* |
| 03k | `03k-scene-audio-refiner.md` | scene cut saves audio too (`clipAudioUrl`) · `/api/refine-scene` hears it (audio-aware cut/segment boundaries) | ✅ done* |
| 03l | `03l-scene-prompt-context.md` | per-scene refine direction + director-prompt passthrough (persisted `direction`, include-checkbox, two labeled fields to rule `afacb572`) — absorbs 03f Part B | ✅ done* |
| 03m | `03m-prompt-transparency-and-redo.md` | prompt transparency (jobs rows store `prompt`/`system` → poll returns them → collapsed `PromptDisclosure`) · re-run the master director (confirm-gated, replaces scenes) | ✅ done |
| 03n | `03n-snap-to-verbatim.md` | `toRefinement` snaps mistimed `original` tags to the real WhisperX word run (nearest occurrence; cuts follow) instead of demoting — fixes the "asked for original, got revoice" bug | ✅ done |
| 03o | `03o-trust-the-tag.md` | `toRefinement` trusts the model's `source` tag + its own `start`/`end`; the 03j verbatim gate, the 03n snap, and the contraction map are all removed — text is a label, not a gate (fixes the "asked for original, got revoice" bug at the root) | ✅ done |
| 03p | `03p-word-timings-from-scratch.md` | refine request sends per-word `wordTimings` (drops `transcript`/`draftText`/first-pass `cuts`); rule `afacb572` prompt rewritten to build the cut FROM SCRATCH off exact word times — so the trusted timestamps are accurate | ✅ done |
| 03q | `03q-director-scene-prompts.md` | master director stops drafting `draftText`, instead authors a **default per-scene refine prompt** that prepopulates 03l's `scene.refinePrompt`; `draftText` removed (refiner already ignored it since 03p) + orphaned code cleaned; rule `138f27fb` `prep`+`parse` rewritten (live-verified) | ✅ done |
| 03r | `03r-seam-aware-refiner-context.md` | refiner gets the **previous scene's narration tail** + position-in-talk (`sceneTail`, 3 new `RefineSceneRequest` fields) so stitched seams flow instead of being written independently; dedicated fields (not folded into `direction`); rule `afacb572` `prep` adds a `CONTINUITY` rule + two prompt blocks (backward-compatible) | ✅ done* |
| 03s | `03s-auto-build.md` | one-press unattended Build: pure step model (`autoBuild.ts`, derived from scene fields) + durable run pointer in Redux slice (persisted) + state-driven orchestrator (`useAutoBuild`) + task-tree dashboard (`AutoBuildBoard`); halt+resume-from-pointer; reload coerces running→paused; AI-TTS honoring `original` tags; pending scenes → final stitch | ✅ done |
| 06 | `06-thumbnail-nano-banana.md` | Export-phase YouTube thumbnail: `ai_handler` (+ `image-prompts` skill) drafts the nano-banana prompt → editable → `google/nano-banana` renders → saved to bucket + project (url-only, re-signed). FE + MSW mock shipped; live BFFless rules pending | ✅ FE shipped · ⏳ live rules |
| 07 | `07-stripe-gating.md` | billing | ⏳ queued |
| 11a | `11a-projects-entity.md` | projects as a first-class entity — keyed slice (index/working/activeProjectId) · list/create/open/rename/delete · metadata middleware · savedVoices hoisted · clean-slate persist key | ✅ done |
| 11b | `11b-url-routing.md` | URL-driven routing — /studio/project/:id/:phase · guard (unknown-id redirect · active-sync · phase clamp/resume via phaseOf) · keyed remount · revisitPrep/inExport removed | ✅ done |
| 11c | `11c-per-project-storage.md` | per-project GCS layout — uploads/projects/<id>/<type>/... via dynamic subDir (ce#324) + nested serve rule; projectId threaded client-side; project-delete wipes the bucket prefix via `file_delete` | ✅ done |
| 11d | `11d-server-sync.md` | server-side project sync — `studio_projects` CRUD (create/list/get/save/delete rules) · pure `projectSync` reconcile (last-write-wins, push-up local-only) · `useProjectAutosave` (debounced save · flush-on-exit · evict-others) · hydrate-on-open guard · list-from-server | ✅ done |
| 10a | `10a-diarization.md` | `/api/transcribe` rule `972a6dc5` runs `diarization:true` + `huggingface_access_token: secrets.HF_TOKEN`; flatten step carries per-word `speaker`; `TranscriptWord`/`TWord` gain `speaker?` | ✅ done* |
| 10b | `10b-cast-and-voice-step.md` | prep reordered thumbnails→voice→director; project **cast** (`Person[]`) + per-video `speakerAssignments`; people count control (default 1 = auto-assign, grid at N≥2); `src/lib/speakers.ts` resolution helpers; `CastStudio` UI | ✅ done |
| 10c | `10c-speaker-aware-director.md` | `speakerTimedTranscript` groups words by speaker + labels each run with the cast name; `SpeakerNamer` threaded through `combinedTimedTranscript`; back-compat when no namer — director rule `138f27fb` prompt intentionally unchanged (self-describing `Name:` format) | ✅ done* |
| 10d | `10d-per-segment-voice.md` | `NarrationSegment.voiceId?` override; `dominantSpeaker` → assignment → person → voice default per segment; per-segment voice `<select>` in Build diff; `/api/voice/narrate` uses resolved id (override ?? speaker default ?? global); export unchanged | ✅ done* |
| 10e | async transcribe + optional diarization | diarization is a project-level opt-in (default off; "more than one speaker" checkbox in the source queue, threaded into the enqueue body); `/api/transcribe` rebuilt to the fire-and-poll shape (`prep → createJob → respond {jobId}`, postSteps `setRunning → sign → whisper(diarization=steps.prep.diarize) → flatten → check → finishOk/finishErr`) so diarization can't hit the 30s edge timeout; client polls the shared `/api/studio/job` (new `transcribe` kind) with per-source `transcribeJobId` + reload-resume; speakers also shown in the transcript preview + playable samples in the assignment grid | ✅ done* |
| 12 | `12-companion-blog-post.md` | Export-phase **companion blog post**: new async `/api/blog` (Gemini 3.1 Pro, transcript+sheets → faithful Markdown with inline `frame:<t>` image tokens) → browser re-captures clean frames at those timestamps, uploads them as a new `blog` asset type → resolved Markdown persisted (slice + `studio_projects` DB) → read-only preview + download as a portable bundle (`post.md` + `images/`). Not editable; no gating. See ADR-0001/0002. | 🎯 designed |

Legend: ✅ done · ▶ next up · 🔨 in progress · 📝 spec ready · ⏳ queued. `*` = code done, needs
the Replicate API token in BFFless Settings → AI to run. `†` = shipped; open
non-blocking follow-ups (speed/smart-cut spike, encode-quality toggle). Stories 10a–10d shipped
together on one branch `studio/diarization-cast-voices` (one-branch-per-refactor convention).
Finish a story → set it ✅, move the file to `stories/done/`, promote the next to ▶.

## How to work it

1. Read `00-architecture-and-state.md`.
2. Each new `/api/*` gets an **MSW mock** in `src/mocks/handlers.ts` first;
   build/adjust the UI, then swap the stage's mock in
   `src/components/Studio/useScenePipeline.ts` for the real call.
3. One stage per PR — keep stories small and context cheap.

## Story 05 model (resolved — see `05-wire-ffmpeg-assemble.md`)

Assemble is a **walk of the original timeline** with three states per slice:
**cut** (drop video), **segment** (keep video + play that clip's audio), **dead
space** (keep video, silence). **Cut wins on overlap.** Video and audio build from
the same walk, so they're the same length and in sync — **no footage-fit step**
(the edit UI already prevents cutting more time than the audio occupies). The old
"speed up / trim to fit the narration" question is therefore moot.

**MVP first** (cut/keep/silence + plain concat + resample-to-common-format), then
sprinkle on loudness-normalization + crossfades. **First bug to fix:** trailing
dead space after the last segment leaks silent video onto the end of the export.
