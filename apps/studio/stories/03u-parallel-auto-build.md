# 03u — Parallel Auto Build (proposal, not yet approved)

> Status: **draft plan** — written 2026-08-08 for review. No code changed yet.

Auto Build (03s) is strictly sequential: one step, on one scene, at a time. Wall
clock is the *sum* of every step of every scene, even though most of that time is
spent in two very different resources that could overlap — the browser's ffmpeg
core (CPU) and server-side refine jobs (network polling). This story makes the
runner a small scheduler that keeps both resources busy at once, without
violating any of the constraints the sequential design was protecting.

## Why the current runner is sequential (the real constraints)

These are load-bearing; parallelism must respect all of them.

1. **One ffmpeg.wasm instance per session** (`lib/export/ffmpeg.ts`). `cut`
   (slice) and `assemble` (render) both `exec` on the same shared instance and
   stage files in the same wasm FS — two concurrent execs would interleave FS
   mounts/deletes. And the MT core already parallelizes the *encode* across all
   CPU cores, so running two renders at once wouldn't be faster anyway; it would
   just double peak memory against a **fixed 3 GiB heap**.
2. **Uploads must not fan out.** `sliceScene` uploads its two artifacts
   sequentially and `processAll` is serial for the same reason — parallel
   uploads trip the dev proxy's keep-alive sockets (502s).
3. **Seam-aware refine order (03r).** Scene N's refine request carries
   `sceneTail(prevScene)` = the last kept words of scene N−1 under its
   **effective** cuts (`refined ?? cuts`). In the sequential run, N−1 has always
   finished refining before N starts, so the tail reflects the refined cut.
   Refining out of order silently degrades the seam context to the director
   baseline.
4. **One un-saved render blob at a time.** `renderRef` in `useAutoBuild` holds
   at most one rendered-but-not-uploaded MP4 (issue #220 retry path) — a
   deliberate memory cap.
5. **Single-flight guards + one shared error.** `useScenePipeline` gates with
   scalar ids (`slicingId`, `sheetingId || refiningId`) and reports every scene
   failure through the single `sceneError` string; the orchestrator's
   halt-detection (`attemptRef` + `sceneError` on the next tick) assumes exactly
   one attempt is ever pending.

## What actually dominates wall clock

| Step | Resource | Typical cost |
| --- | --- | --- |
| cut | ffmpeg (short re-encode) + 2 uploads | tens of seconds |
| sheets | `<video>` seek + canvas + uploads (no ffmpeg) | seconds–tens of seconds |
| refine | server job (enqueue + poll) | ~1–5 min, near-zero client cost |
| assemble | ffmpeg render (minutes) + 1 upload | minutes |

The ffmpeg lane (cuts + assembles) is irreducible local CPU work. Everything
else can hide underneath it. Done right, a run's wall clock collapses from
`Σ(all steps)` to roughly `Σ(cuts + assembles) + one refine tail`.

## Approaches considered

**A. Prefetch-next (minimal).** Keep the sequential runner, but when scene N
enters its assemble render, fire scene N+1's refine job (and maybe its sheets)
in the background. Small diff, maybe 60–70 % of the win — but the overlap logic
is ad-hoc special cases bolted onto a runner whose invariants (one attempt, one
error) it quietly breaks anyway, so it pays most of the refactor cost for a
fraction of the benefit.

**B. Lane scheduler (recommended).** Generalize the pure decision layer: instead
of `nextAction(scenes)` returning the one next `(scene, step)`, a
`nextActions(scenes, inFlight)` returns *every* runnable `(scene, step)` subject
to lane capacities. The orchestrator fires whatever is runnable and not already
in flight. Lanes encode the constraints above directly:

- **ffmpeg lane, capacity 1** — at most one `cut` *or* `assemble` in flight,
  taken in scene order. Preserves constraints 1 and 4 for free.
- **refine lane, capacity 1, scene order** — refines stay ordered N−1 → N
  (constraint 3), but a refine is just polling, so it overlaps the ffmpeg lane
  completely. (Serializing refines costs almost no wall clock: each assemble
  render is minutes, plenty of time for the next refine to land.)
- **sheets lane, capacity 1** — capture is main-thread canvas work; one at a
  time, overlapping both other lanes.
- **upload semaphore, capacity 1, shared** — every upload inside auto-build
  steps (slice's two, sheets', saveSceneCut's) acquires it (constraint 2).

**C. K parallel scene-workers.** Run whole scenes concurrently, each stepping
sequentially, with a global ffmpeg mutex. Simpler to picture, but both workers
mostly queue on the ffmpeg mutex (head-of-line blocking), and it needs all the
same guard/error/state surgery as B while utilizing resources worse.

**Recommendation: B.** It's the same "derived from durable scene state" design
03s already has — just returning a set instead of a single action.

## Design (approach B)

### 1. Pure layer — `lib/autoBuild.ts`

- `type InFlight = { sceneId: string; stepId: AutoStepId }[]`
- `nextActions(scenes, inFlight): Action[]` — walks scenes in order, derives
  each scene's next not-done step exactly as today (`nextStep`), then filters by
  lane capacity:
  - `LANES: Record<AutoStepId, 'ffmpeg' | 'refine' | 'sheets'>` = cut→ffmpeg,
    assemble→ffmpeg, refine→refine, sheets→sheets.
  - a lane admits a step only if nothing in `inFlight` occupies it;
  - **refine ordering rule:** scene N's refine is runnable only when every
    earlier scene has its `refined` set (or is built) — the seam-context
    invariant, stated in code instead of implied by sequentiality;
  - `{ scene, step: null }` (mark-built) and the final stitch keep today's
    semantics — stitch runs only when no scene work remains and nothing is in
    flight.
- `AutoBuildRun` state widens the single pointer to the set:
  `active: { sceneId: string; stepId: AutoStepId | 'stitch' }[]`, and the halt
  gains its subject: `error: { sceneId: string | null; stepId; message } | null`.
  `sceneStepStatuses` / `sceneRunStatus` / `isHaltStale` read `active` +
  `error` instead of `currentSceneId/currentStepId` (same derivations, plural).

### 2. Slice — `store/studioSlice.ts`

- `setAutoPointer` → `autoStepStarted({sceneId, stepId})` /
  `autoStepFinished({sceneId, stepId})` (add/remove from `active`).
  `haltAutoBuild` takes the structured error; pause/stop/complete clear `active`.
- redux-persist: a rehydrated `running` run is already coerced to `paused` by
  the orchestrator; add shape-normalization there too (old persisted
  `currentSceneId/currentStepId` → empty `active`), so no formal migration is
  needed.

### 3. Pipeline guards & errors — `useScenePipeline.ts`

- Scalar busy ids become sets: `slicingIds: Set<string>`, `sheetingIds`,
  `refiningIds` (exposed both ways — keep the old scalar names as
  first-element derivations so the manual UI (`CutEditor`, `SceneRefinePanel`)
  doesn't change in this story).
- Per-scene errors: `sceneErrors: Record<sceneId, string>` replaces the single
  `sceneError` for the swallowing steps; `sceneError` stays as "most recent"
  for existing UI. The orchestrator's failure detection reads the *scene's own*
  error, which also fixes a latent sequential-mode bug (any stale `sceneError`
  from an unrelated scene can currently halt the wrong attempt).
- Upload semaphore: a tiny module-level `withUploadSlot(fn)` queue (capacity 1)
  wrapped around the upload calls in `sliceScene`, `generateSceneSheets`,
  `saveSceneCut`, `saveFinalCut`. Manual single-action flows behave identically
  (they're alone in the queue).
- Defensive ffmpeg mutex inside `lib/export/ffmpeg.ts` (`slice`/`assemble`/
  `concat` serialize on a module promise-chain) so a scheduler bug can't
  interleave wasm FS staging. The scheduler's ffmpeg lane means it never
  actually queues, but the invariant belongs where it can't be bypassed.

### 4. Orchestrator — `useAutoBuild.ts`

- `inFlightRef: boolean` → `inFlightRef: Map<'sceneId:stepId', true>`;
  `attemptRef` → per-scene map. Each effect pass: if `running`, compute
  `nextActions(scenes, active)`, fire every returned step not already in the
  map (each step still bumps `tick` after clearing its map entry — same
  advancement-nudge pattern, now per step).
- **Failure policy (unchanged in spirit):** first detected failure halts the
  run — stop launching, let in-flight steps run to completion (they're not
  cancellable today either), record the structured error. Other scenes' durable
  progress is kept, so Resume after a fix picks up everything.
- `renderRef` unchanged: the ffmpeg lane guarantees one assemble at a time, so
  the single slot still holds.
- Pause/Stop/rehydration-coercion logic carries over verbatim (they gate
  *launching*, which is exactly what the scheduler does).

### 5. UI — `AutoBuildBoard.tsx`

Rows already derive per-scene step status; they just start showing more than
one `running` at once. Add the halt badge to the failing scene's row (from the
structured error) instead of the global pointer.

### 6. Tests

- `autoBuild.test.ts`: `nextActions` table tests — lane exclusivity (never two
  ffmpeg steps), refine ordering rule, overlap cases (assemble N + refine N+1 +
  sheets N+2 simultaneously runnable), stitch gating on empty in-flight,
  mark-built passthrough.
- `studioSlice.autoBuild.test.ts`: started/finished set arithmetic, structured
  halt, rehydration normalization.
- `useAutoBuild.test.tsx`: concurrent-step launch, per-scene failure halts
  without mis-attributing another scene's error, resume-after-halt re-derives
  the runnable set.

## Sequencing (PR-sized stages)

1. **Pure layer + slice** — `nextActions`, `active` set, structured halt,
   normalization, tests. Behavior-neutral (orchestrator still calls it with the
   old single-step usage).
2. **Guards + errors + upload semaphore + ffmpeg mutex** in
   `useScenePipeline.ts` / `ffmpeg.ts`. Still behavior-neutral for manual use.
3. **Orchestrator + board** — the actual parallel launch. Feature lands here.

## Open decisions (defaults chosen, flag if you disagree)

1. **Refine ordering:** kept seam-ordered (serial in scene order). The
   alternative — fully parallel refines — is faster only when refine jobs are
   slower than assemble renders, and costs seam quality. Default: ordered.
2. **Failure policy:** halt the whole run on first error (today's semantics)
   vs. keep building unaffected scenes and report failures at the end. Default:
   halt (matches producer expectations from 03s; continue-on-error can be a
   follow-up).
3. **Upload concurrency:** 1 (proven safe). Could try 2 later behind the same
   semaphore constant.
