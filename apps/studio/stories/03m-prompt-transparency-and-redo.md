# 03m — prompt transparency + re-run the master director

> Read `00-architecture-and-state.md` first, then `03l-scene-prompt-context.md`
> (this builds directly on its UI surfaces and the creator-prompt plumbing).

**Status:** ✅ shipped (2026-06-11; FE + schema v2 + rules `138f27fb`/`afacb572`/
`a486eb93`, see "Built" below). Rides PR #20 with 03l.

## Why

Two gaps in the director-run experience, one story:

1. **Prompt transparency.** The pipeline stitches the real Gemini prompt together
   server-side (`prep` in rules `138f27fb` / `afacb572`) — transcript, draft,
   cuts, and now the creator's 03l prompts — and the creator never sees what was
   actually sent. After a run, show it: a **collapsed, low-key disclosure**
   ("only if you're curious, not in your face") for both the master director and
   each scene's refine.
2. **Re-run the master director.** `DirectorPanel` renders only while the
   director stage is *current* (`Studio.tsx`), so once it's done the panel
   vanishes — there's no way to tweak the direction and try again. Allow a
   redo: same panel, re-run variant, with a confirm (it replaces all scenes and
   their build work).

## Design decisions (from the brainstorm, 2026-06-11)

- **The prompt comes from the job row, fetched on demand.** `studio_jobs` gains
  `prompt` + `system` string fields; the `createJob` step in both AI rules
  stores `steps.prep.prompt` / `steps.prep.system` (prep runs first — no prep or
  postSteps changes); the poll endpoint returns them; the FE lazy-fetches on
  first expand and holds the text in **transient** React state. Rejected:
  persisting the prompt text in Redux (the director prompt embeds the whole-talk
  transcript — tens of KB duplicated into localStorage, against the lean-persist
  value) and rebuilding the prompt client-side (drifts from the authoritative
  pipeline template — the disclosure could show something Gemini never saw).
- **Job ids for the disclosure are separate from the resume ids.** The existing
  `scenesJobId` / `scene.refineJobId` are cleared on terminal status so the
  resume-on-mount poller never re-runs a finished job — that stays untouched. New
  persisted pointers: slice `directorPromptJobId: string | null` (set on
  successful director completion; cleared by `resetStudio`) and
  `scene.promptJobId?: string` (set on successful refine; **cleared on revert** —
  the prompt belongs to the refinement just discarded).
- **Disclosure shows both pieces**: the stitched per-run **prompt** AND the
  standing **system instruction**, each its own collapsed sub-section.
- **Redo replaces everything, behind a confirm.** No fuzzy old↔new scene
  matching (rejected as a lot of machinery for uncertain benefit). The confirm
  states what's lost: all N scenes + their refinements / voiced segments / cut
  clips. Voice choice, transcript, and prep contact sheets are untouched. Redo
  reuses whatever's currently in the direction textarea (the natural
  tweak-and-retry loop 03l set up).
- **Redo needs its own hook action.** `next()` runs the *current* stage — wrong
  once the director is done (it would run clone). New `rerunDirector(ctx)`
  drives the director step directly: patch `director` active → same enqueue +
  poll path → `setScenes` replaces → selection resets to the first new scene.
  `scenesJobId` persists during the redo, so a mid-redo reload resumes polling
  exactly like a first run.

## Data model

```ts
// studio_jobs pipeline schema (additive; old rows simply lack the fields)
prompt?: string   // the stitched per-run Gemini prompt (steps.prep.prompt)
system?: string   // the system instruction (steps.prep.system)

// studioSlice.ts — persisted
directorPromptJobId: string | null   // last successful director job; resetStudio clears
setDirectorPromptJobId(id)

// scenes.ts
type Scene = {
  promptJobId?: string   // last successful refine job; cleared on revert
}
```

## Backend (bffless-pipeline skill; record edits here)

- **Schema `studio_jobs`** (`acdca97c`): add optional string fields `prompt`,
  `system` via `update_pipeline_schema`.
- **Rules `138f27fb` (`/api/scenes`) + `afacb572` (`/api/refine-scene`)**: the
  `createJob` (`data_create`) step's `fields` gain
  `prompt: "steps.prep.prompt"`, `system: "steps.prep.system"`. Nothing else in
  either rule changes.
- **Poll rule `a486eb93` (`GET /api/studio/job`)**: response body adds
  `"prompt"` and `"system"` from the queried row.

## Front-end

### RTK Query / slice / orchestration

- `studioApi.ts` — `getStudioJob`'s response type gains `prompt?: string` and
  `system?: string`; export a lazy hook for on-demand fetches if not already
  exported.
- `studioSlice.ts` — `directorPromptJobId: string | null` + setter (cleared by
  `resetStudio` via `initialState`).
- `useScenePipeline.ts` —
  - `completeDirectorJob`: on success, `dispatch(setDirectorPromptJobId(jobId))`.
  - `completeRefineJob`: on success, `patchScene(sceneId, { promptJobId: jobId })`.
  - `clearRefinement`: also clears `promptJobId` (`patchScene(id, { refined:
    null, promptJobId: undefined })` — match the existing revert shape).
  - New `rerunDirector(ctx: StepContext)` (see design decisions); exposed by the
    hook alongside a `directorPromptJobId` selector read.

### UI

- **`PromptDisclosure.tsx`** (new, `src/components/Studio/`): props
  `{ jobId?: string | null, label: string }`. Native `<details>`/`<summary>`,
  collapsed by default, muted summary text ("View the prompt sent to the AI").
  On first open, lazy-fetch the job; inside, two sub-`<details>` — **Prompt**
  and **System instruction** — each a scrollable mono `<pre
  className="whitespace-pre-wrap">` block. Row absent entirely when `jobId` is
  missing; "Not available for this run." when the row has no stored prompt (old
  jobs); muted error line on fetch failure.
- **Director placement** — rendered directly under `SynopsisCard` in both the
  Prep right column and the Build header area (`Studio.tsx`), wired to
  `pipe.directorPromptJobId`.
- **Scene placement** — bottom of `SceneRefinePanel`, wired to
  `scene.promptJobId` (shown once the scene has been refined).
- **`DirectorPanel` re-run variant** — in Prep, the panel now also renders when
  the director stage is done and scenes exist, with `rerun: boolean`. Rerun
  mode: same textarea, button "Re-run the AI director →"; clicking flips an
  inline confirm — "This replaces your N scenes and any build work." with
  **Replace & re-run** / **Cancel**. Confirm calls `rerunStep()` in `Studio.tsx`
  (mirrors `runStep`'s clip-rehydration, calls `pipe.rerunDirector`).

### MSW mocks (`src/mocks/handlers.ts`)

- The `/api/scenes` and `/api/refine-scene` handlers stash a small deterministic
  `prompt` + `system` per jobId (echoing the posted direction fields, clearly
  marked as mock text); the `/api/studio/job` mock returns them with the job —
  the disclosure works fully offline.

## Tests

- Slice: `setDirectorPromptJobId` stores; `resetStudio` clears.
- RTL `PromptDisclosure`: collapsed by default (no fetch); expand fetches and
  renders prompt + system; "Not available" fallback when the job lacks a prompt;
  absent entirely without a jobId.
- RTL `DirectorPanel` rerun: rerun variant shows the confirm on click; Cancel
  returns without firing; Replace & re-run fires the callback.
- `refineDirections` / refine request tests untouched.

## Acceptance criteria

- [x] `studio_jobs` has `prompt`/`system`; both AI rules store them at enqueue;
      the poll endpoint returns them (rule edits recorded below; curl-verified).
- [x] After a director run, a collapsed disclosure under the synopsis shows the
      exact prompt + system instruction on expand (lazy-fetched, not persisted) —
      in both Prep and Build.
- [x] After a scene refine, the same disclosure appears in that scene's refine
      panel; revert removes it (`clearRefinement` drops `promptJobId`).
- [x] The director can be re-run from Prep after completion: confirm-gated
      (RTL-tested), replaces all scenes (build work included), selection resets
      (`completeDirectorJob`), direction textarea feeds the new run, mid-redo
      reload resumes polling (`scenesJobId` path unchanged).
- [x] Old jobs / old persisted sessions degrade gracefully (no disclosure
      without a pointer; "Not available for this run." on pre-03m rows —
      curl-verified null, never an error).
- [x] MSW mocks cover stash + return of prompt/system; mock and real share the
      poll shape.
- [x] `npm run build` / `npm run lint` / `npm run test:run` green (modulo the
      two known ChatPanel lint errors; zero findings in 03m files).

## Built — backend edits (2026-06-11)

- **Schema `studio_jobs`** (`acdca97c`) → v2: added optional `prompt` + `system`
  as **`text`** fields (not `string` — the director prompt embeds the whole-talk
  transcript, tens of KB).
- **Rule `138f27fb` (`/api/scenes`)** and **rule `afacb572`
  (`/api/refine-scene`)**: `createJob` (`data_create`) fields gained
  `prompt: "steps.prep.prompt"` + `system: "steps.prep.system"`. Nothing else
  changed (prep/postSteps untouched). Pre-edit backups:
  `.bffless-backups/2026-06-11-03m-scenes.json` / `…-03m-refine-scene.json`
  (gitignored, local-only).
- **Poll rule `a486eb93`**: the `shape` function returns `prompt`/`system`
  (null when absent). Backup: `.bffless-backups/2026-06-11-03m-job-poll.json`.
- **Verified live by curl**: a fresh refine enqueue → poll returns the full
  stitched prompt (both 03l creator labels present) + system instruction while
  the job is still `running` (stored at enqueue — no model run needed); a
  pre-03m job id returns `prompt: null` / `system: null`, not an error.

## Out of scope

- Prompts for the transcribe / voice / search jobs (director + refiner only).
- Editing the prompt text or system instruction from the UI.
- Preserving build work across a director re-run (fuzzy scene matching).
- Validators (`auth_required`/`rate_limit`) — still story 07.
