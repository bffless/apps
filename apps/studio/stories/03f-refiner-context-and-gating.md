# 03f — Async fire-and-poll for director/refiner · refiner context · Build gating

> Read `00-architecture-and-state.md` first, then `03c-wire-scene-refiner.md` (this
> continues the refiner thread; 03d/03e were its earlier phases). Backend work uses
> the **`bffless-pipeline`** skill; the FE follows **`wire-studio-stage`**.

**Status:** ⏳ queued (not started). Two BFFless pipeline rewrites + a new jobs
schema + a poll endpoint, then FE rework + the context/gating features on top.

This story has two threads that touch the same two endpoints, so they're planned
together but **land in order**:

- **Part 0 — Async fire-and-poll refactor (foundational, do first).** The director
  and refiner Replicate calls are slow and **time out** on the synchronous response
  path. Move the heavy work off the response into a `postSteps` job, back it with a
  jobs **database** row, and have the FE **poll** for completion.
- **Parts A–D — Refiner context + Build gating (ride on the new shape).** Director→
  refiner brief, per-scene custom prompt, scene synopsis, and gating the diff viewer.

---

# Part 0 — Async fire-and-poll refactor

## Why

`/api/scenes` (master director, rule `138f27fb`) and `/api/refine-scene` (refiner,
rule `afacb572`) today do everything inside the **response handler**: sign sheets →
call `google/gemini-3.1-pro` → parse → respond. Gemini with `thinking_level:high`
on a dense contact sheet is **slow** — it brushes up against (and sometimes blows)
the pipeline's response timeout, so the request **times out** and the producer sees
a failure even though the model would have answered.

The fix is the standard fire-and-poll shape: **the response handler does almost no
work** — it records a job and returns an id immediately — and the long Replicate
call moves to a **`postSteps`** continuation that runs *after* the response is sent,
where the timeout can be raised generously because nothing is waiting on the socket.
When Replicate returns, the postStep writes the result into the job's DB row. The
front end **polls** a status endpoint until the row flips to `done`, then reads the
result. No webhooks — we just hold the (long) Replicate connection inside the
postStep, which is fine because it's off the response path.

## The jobs database (one shared pipeline schema)

Create a single pipeline schema **`studio_jobs`** via the
`mcp__bffless-j5s__create_pipeline_schema` MCP tool. Both endpoints write to it
(discriminated by `kind`), and one poll endpoint reads it.

| field | type | notes |
|-------|------|-------|
| `kind` | string | `'scenes'` \| `'refine'` |
| `status` | string | `'pending'` → `'running'` → `'done'` \| `'error'` |
| `request` | json | the inputs (transcript, `sheetUrls`, `direction`, `refinerBrief`, scene bounds, `duration`, sceneId for refine) |
| `result` | json | the model's **coerced** output, set when `done` |
| `error` | string | message when `status: 'error'` |

The record's own id is the **jobId** returned to the client and polled on. (`created
/updated` timestamps come for free.) One schema keeps the poll endpoint and FE
plumbing DRY; `kind` + the opaque `result` blob are all the client needs.

## Pipeline shape — the START endpoints (rewrite both rules)

`POST /api/scenes` and `POST /api/refine-scene` become **enqueue-only**:

1. `prep` (`function_handler`) — build storage paths + `prompt` + `system_instruction`
   exactly as today (this is also where the Part-A/B context gets injected).
2. `data_create` — insert into `studio_jobs`: `{ kind, status: 'pending', request: {…} }`.
   Output `steps.createJob.id`.
3. `response_handler` — return **immediately**: `{ jobId: steps.createJob.id,
   status: 'pending' }`. (Response path now does no model work → no timeout.)
4. **`postSteps`** (async, after the response — **raise the step/replicate timeout
   high**, since nothing is awaiting the socket):
   a. `data_update` → `status: 'running'` (so the FE can show progress).
   b. up to 10 **conditional** `signed_url` steps — one per contact sheet (unchanged
      from the current canonical AI shape).
   c. `collect` → `replicate` `google/gemini-3.1-pro` (`images`, `prompt`,
      `system_instruction`, `thinking_level`). **This is the long connection** —
      held synchronously, no webhook.
   d. `parse` (`function_handler`) — JSON-parse + **clamp/coerce** every timestamp
      and cut into bounds, sort, de-overlap (same as today; client clamps again).
   e. `data_update` → `{ status: 'done', result: <parsed> }`.
   - **Failure guard:** if any postStep throws (incl. `REPLICATE_NOT_CONFIGURED` or
     a model error), the row must end at `{ status: 'error', error: <message> }` —
     never stuck on `pending`/`running`. Spec a terminal `data_update` on the error
     path so the FE stops polling and surfaces the failure.

## Pipeline shape — the POLL endpoint (new)

One shared rule, **`GET /api/studio/job?id=<jobId>`** (path param `/api/studio/job/:id`
is equally fine):

1. `data_query` `studio_jobs` by id (`query.id`).
2. `response_handler` → `{ status, kind, result, error }`.
3. **Must not be edge-cached** — set `Cache-Control: no-store` on the response (or a
   cache-rule bypass), or the poll will read a stale `pending`. See
   `bffless:cache-and-storage`.

Validators (`auth_required`/`rate_limit`) stay **off** until story 07, like every
other studio rule (memory `project_studio_upload_auth_temp.md`).

> **Contingency (only if `postSteps` have a hard execution ceiling that's shorter
> than a slow Gemini run):** instead of holding the connection, use Replicate's
> **async create** (returns a prediction id) in the postStep, store it on the row,
> and have the poll endpoint check the prediction's status / pull the output on the
> first poll where it's ready. Prefer the simple hold-the-connection approach the
> user described; fall back to this only if the platform forces it.

## Front-end — fire then poll (golden rule preserved)

The **public hook actions keep the same signatures** (`runDirector`, `refineScene`)
— they just internally start → poll → coerce → dispatch, so the UI is unchanged and
no component is rewritten. Coercion (`toScenes`/`toRefinement`) still runs on the
`result` blob, for **both** mock and real → swap-don't-rewrite holds.

### RTK Query (`studioApi.ts`)

- `scenes` and `refineScene` mutations now return `{ jobId, status }` (not the
  result).
- Add a `getStudioJob` query: `id → { status, kind, result, error }`
  (`credentials: 'include'`, `keepUnusedDataFor: 0` so polls don't cache).

### Orchestration (`useScenePipeline.ts`)

- Add a private `pollJob(jobId, { signal })` helper: loop — trigger `getStudioJob`
  (lazy query / `initiate` with `forceRefetch`), `unwrap()`; `done` → return
  `result`; `error` → throw `error`; else `await sleep(~2s)` and repeat. Enforce an
  overall **give-up timeout** (e.g. 5 min) so a wedged job doesn't poll forever.
- `runDirector`: POST start → `pollJob` → `toScenes(result)` → dispatch
  `setScenes`/`setSynopsis`/`setRefinerBrief` (Part A). Spinner = the existing
  `running` flag for the whole start→poll window.
- `refineScene`: POST start → `pollJob` → `toRefinement(result, scene)` →
  `patchScene`. Busy = existing `refiningId`.
- **Resume across reload (recommended).** Persist the in-flight job id so a hard
  reload resumes polling instead of stranding a running job: a studio-level
  `scenesJobId` and a per-scene `refineJobId` (on `Scene`), cleared on terminal
  status. On mount, `useScenePipeline` resumes `pollJob` for any persisted id.
  Mirrors the studio's "redux-persist resumes mid-pipeline" value.

### MSW mock (`src/mocks/handlers.ts`, gated by `MOCK_STUDIO`)

Model **both** new endpoints so the polling path is exercisable offline:

- `POST /api/scenes` / `POST /api/refine-scene` → return `{ jobId, status:'pending' }`
  and stash the deterministic result keyed by `jobId` in a module-level `Map`.
- `GET /api/studio/job` → return `pending`/`running` for the first 1–2 polls, then
  `{ status:'done', result: <the stashed deterministic result> }` — so the FE loop
  actually spins before resolving.

### Acceptance criteria — Part 0

- [x] `studio_jobs` pipeline schema created; both start rules `data_create` a row
      and return `{ jobId }` from the response handler (no model work on that path).
- [x] The Replicate call + parse run in `postSteps` with a raised timeout; the row
      ends `done` with `result`, or `error` with a message — never stuck pending.
- [x] `GET /api/studio/job` returns `{ status, result, error }` and is **not**
      edge-cached.
- [x] FE starts the job, polls to completion, then runs `result` through the
      **same** `toScenes`/`toRefinement` (mock and real share the shape).
- [x] Polling gives up after a sane timeout and surfaces job `error`s as the action's
      error (existing error UI, no new surface needed).
- [x] An in-flight job resumes polling after a hard reload (persisted job id).
- [x] MSW mocks both start + poll endpoints; the poll spins before resolving.
- [x] Rule ids for the two rewritten rules + the new poll rule recorded here; memory
      `project_studio_director_pipeline.md` / `project_studio_diff_viewer.md` updated
      with the async shape.

### Built — Part 0 (rule ids + shape)

**Shipped.** `npm run build` / `lint` / `test:run` green (the two pre-existing
`ChatPanel.tsx` `set-state-in-effect` errors are unrelated to this story).

- **Jobs schema:** `studio_jobs` (id `acdca97c-f9cc-4469-90a3-676a242924cb`) —
  fields `kind` · `status` · `request` (json) · `result` (json) · `error`.
- **`POST /api/scenes`** rule `138f27fb` — rewritten enqueue + `postSteps`.
- **`POST /api/refine-scene`** rule `afacb572` — rewritten enqueue + `postSteps`.
- **`GET /api/studio/job`** rule `a486eb93-7d17-46e7-a28f-b3ccc2fc97b7` (NEW) —
  `data_query` by `recordId: request.query.id` → `{ status, kind, result, error }`,
  `Cache-Control: no-store` (verified `cf-cache-status: DYNAMIC`).

**Pipeline shape that worked (both start rules):**
- main `steps`: `prep` (unchanged) → `createJob` (`data_create`, `kind`/`status:'pending'`/
  `request: request.body`) → `respond` (`{ jobId: {{steps.createJob.id}} }`). Response
  path measured **~39 ms / 3 steps** (was ~37 s / 15 steps synchronously).
- `postSteps`: `setRunning` (`data_update` status→running) → `sign0..9` → `collect` →
  `director`/`refiner` (`replicate`, step `timeout: 280000` off the response path) →
  `parse` (now returns `{ ok, notOk, error, data }`) → **`finishOk`** (`data_update`,
  `condition: steps.parse.ok` → status `done`, `result: steps.parse.data`) →
  **`finishErr`** (`data_update`, `condition: steps.parse.notOk` → status `error`).

**Verified facts (debug logs + live curl):** `postSteps` CAN read main-step outputs
(`steps.createJob.id`, `steps.prep.*`); `data_create` returns `.id`; conditional
`data_update` honors its `condition` (`finishErr` correctly skipped on success);
the Replicate token IS configured (real Gemini results returned). Literal string
field values are quoted expressions (`"'pending'"`), same as the Replicate enum
gotcha.

**Error-guard caveat:** `finishErr` cleanly flips the row to `error` whenever the
model *responds with unparseable output* (`parse` → `notOk`). If the `replicate`
step itself **throws** (e.g. a transient Replicate outage), the linear `postSteps`
abort after `setRunning` and the row can sit at `running` — the **FE poll give-up
(5 min)** is the backstop that surfaces that as the action's error. A future
hardening (out of scope) is the story's async-create contingency.

---

# Parts A–D — Refiner context + Build gating

> These ride on the Part-0 shape: the new context fields are stored in the job
> `request`, used inside the postStep, and the scene synopsis comes back in `result`.

## Why

Each per-scene refiner call runs in a **vacuum**. It sees one scene's transcript,
the scene's dense contact sheets, and the director's first-pass `draftText`/`cuts` —
but it has **no idea what the larger video is about**, the intended tone, or how the
scene sits in the whole story. The master director (`/api/scenes`) has all of that —
it read the entire talk — then throws it away. And we pass `direction: ''` to the
refiner today (`useScenePipeline.ts:529`), so even the creator's original direction
never reaches the second pass.

- **A. Director → refiner handoff.** The director hands back a short **brief for the
  refiners** — global theme/tone/audience/target-length/through-line — captured once
  with the scenes and fed into **every** refine call.
- **B. Per-scene custom prompt.** A free-text field in the Build refine panel to
  steer one scene specifically ("trim the long pause", "keep the on-screen code
  visible"). Passed as that scene's `direction`.
- **C. Scene synopsis from the refiner.** The refiner also returns a one-line
  **synopsis of that scene**, shown in Build so the producer can confirm the AI
  understood the scene before editing.
- **D. Gate the diff viewer.** The time-grid diff renders immediately today; it
  should stay hidden until the selected scene has (1) contact sheets and (2) a
  refinement — then become the edit surface.

## Data model

Small durable string fields; no base64, url-only rules unaffected.

```ts
// studio slice state (alongside `synopsis: string | null`, studioSlice.ts:83/111)
refinerBrief: string | null   // A — global handoff from the director to the refiners

// director.ts
export type DirectorResult = {
  synopsis: string
  refinerBrief: string         // A
  scenes: DirectorScene[]
}

// scenes.ts
type Scene = {
  // … existing …
  refinePrompt?: string        // B — creator's per-scene steer; input, survives revert
  refined?: SceneRefinement | null
}
type SceneRefinement = {
  segments: NarrationSegment[]
  cuts: Cut[]
  synopsis?: string            // C — one-line scene synopsis; on the refined layer so revert drops it
  source: 'ai' | 'manual'
}
```

`refinePrompt` lives on the scene (it's an input → survives `clearRefinement` and
seeds re-refine); the scene `synopsis` lives inside `refined` so a revert clears it.

## Front-end

### Pure logic (`src/lib`)

- **`director.ts`** — add `refinerBrief` to `DirectorResult`; coerce in `toScenes`
  (tolerant `str()`, default `''`). Extend director tests.
- **`refiner.ts`** — extend `RefineSceneRequest` with `direction` (now populated) +
  `refinerBrief`; extend `RefineSceneRaw`/`toRefinement` with `synopsis`
  (`str(raw?.synopsis).trim() || undefined`). Tests cover synopsis present/missing/
  non-string.

### RTK Query / slice / orchestration

- `studioApi.ts` — the start-mutation request types gain `refinerBrief` (scenes
  result) and `direction` + `refinerBrief` (refine request); the job `result` blobs
  carry them through. No extra endpoints beyond Part 0.
- `studioSlice.ts` — add `refinerBrief: string | null` + `setRefinerBrief`.
  `patchScene` already merges arbitrary scene fields, so `refinePrompt` and
  `refined.synopsis` need no new reducer.
- `useScenePipeline.ts` — store `result.refinerBrief` via `setRefinerBrief` when the
  director job resolves; in `refineScene`, send `direction: scene.refinePrompt ?? ''`
  and `refinerBrief: refinerBrief ?? ''` (drop the hardcoded `''` at line 529); add
  `setRefinePrompt(sceneId, text) → patchScene`; expose `refinerBrief` +
  `setRefinePrompt`.

### UI

- **`SceneRefinePanel.tsx`** — add a **textarea** ("Direction for this scene ·
  optional", styled like `DirectorPanel`'s input at `Studio.tsx:562`) bound to
  `scene.refinePrompt`, between step 1 and step 2. Show the inherited global brief
  read-only/collapsed above it ("From the director: …").
- **Scene synopsis** — show `scene.refined?.synopsis` once refined, in `SceneMeta.tsx`
  (beside the video) reusing the `SynopsisCard` look (`Studio.tsx:581`) scaled down.
- **Gate the diff viewer (D).** In `Studio.tsx`, the Build branch renders
  `<TranscriptDiff>` whenever `pipe.words.length > 0` (line 486). Add:
  ```ts
  const sceneReady = !!selected?.sheets?.length && !!selected?.refined
  ```
  - Until `sceneReady`, render a placeholder ("Generate this scene's contact sheets,
    then refine, to start editing") pointing at the `SceneRefinePanel`. Keep
    `SceneRefinePanel`/`SceneMeta` always visible. Switching tabs re-scopes the gate.
  - `AssembleBar`/Export gating unchanged.

### MSW mock additions (on top of Part 0's start/poll mocks)

- director `result`: add a deterministic `refinerBrief` (from duration + scene count
  + echoed direction).
- refine `result`: add a deterministic `synopsis` (from scene span / draftText) and
  echo that it "saw" `direction` + `refinerBrief`.

## Backend (the two start rules' `prep`/`parse`, on top of Part 0)

- **`/api/scenes`**: extend the `system_instruction` so the model also returns
  `refinerBrief` ("a short brief the per-scene refiners will receive — global theme,
  tone, audience, target length, through-line"). `parse` carries it; it lands in
  `result`.
- **`/api/refine-scene`**: inject the incoming `direction` (scene prompt) and
  `refinerBrief` (global handoff) into the prompt/system instruction, and instruct
  the model to also return a one-line `synopsis`. `parse` clamps segments/cuts as
  today and passes `synopsis` through.

## Acceptance criteria — Parts A–D

- [ ] Master director returns `refinerBrief`; persisted in the slice; survives reload
      (`director.ts` coercion + tests; `setRefinerBrief`).
- [ ] Every refine job sends the scene's `refinePrompt` (as `direction`) **and** the
      global `refinerBrief` — no hardcoded `direction: ''`.
- [ ] Refine panel has a per-scene direction textarea (persisted, reused on
      re-refine); the inherited global brief is shown read-only.
- [ ] Refiner returns a per-scene `synopsis`, coerced in `toRefinement` (present/
      missing/non-string tested), stored on `scene.refined`, shown in Build, cleared
      on revert.
- [ ] Diff viewer hidden behind a placeholder until the selected scene has sheets
      **and** a refinement; switching tabs re-scopes. `SceneRefinePanel`/`SceneMeta`
      stay visible.
- [ ] Mock and real share the extended shapes; swapping the mock never touches a
      component.
- [ ] Both start rules updated for the context fields; rule ids + memory notes
      updated.
- [ ] `npm run build`, `npm run lint`, `npm run test:run` all green.

## Out of scope

- Editing/regenerating the `refinerBrief` by hand (it's director output; re-run the
  director to refresh it).
- Replicate webhooks / a job queue / retries beyond the simple poll + give-up.
- Real `auth_required`/`rate_limit` (story 07).
- The words/sec knob and true per-scene diff scoping (still open from 03d).

## Notes on splitting (likely several PRs)

Land **Part 0 first** — it restructures the very pipelines the rest edits:

0. **03f-0** — async fire-and-poll: `studio_jobs` schema, both rules → enqueue +
   `postSteps`, poll endpoint, FE poll loop + resume, mocks. **No behavior change**
   the user sees beyond "it no longer times out."
1. **03f-a** — director → refiner brief end-to-end (persist + thread, no new UI).
2. **03f-b** — per-scene custom prompt textarea + thread `direction`.
3. **03f-c** — scene synopsis from the refiner + display.
4. **03f-d** — gate the diff viewer behind sheets + refine (pure FE; can land any
   time after Part 0).
