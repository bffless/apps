# 03s — Auto build (one-press unattended Build + final stitch)

> Read `00-architecture-and-state.md` first. This adds a pure step model, a
> durable run pointer in the Redux slice, an orchestrator hook, and a task-tree
> dashboard to the Build phase. All per-scene actions already existed in
> `useScenePipeline.ts` — this story wires them into an automated loop.
> Design: `docs/superpowers/specs/2026-06-14-studio-auto-build-design.md`.
> Plan: `docs/superpowers/plans/2026-06-14-studio-auto-build.md`.

**Status:** ✅ shipped (2026-06-14, branch `studio/03s-auto-build`).

## Why

Building each scene manually means firing the same five-step chain (cut → contact
sheets → refine → voice → assemble+save) one scene at a time. "Auto build" adds a
one-press mode — analogous to auto-approve in Claude Code — that drives every
pending scene through that chain unattended, then stitches the final cut, stopping
only on the first error so the user can inspect and resume from exactly where it
left off.

## The locked per-scene step order

`src/lib/autoBuild.ts` defines the sequence as data (mirroring `pipeline.ts`'s
`StageDef` pattern):

```
cut       → isDone: scene.clipUrl && scene.clipAudioUrl
sheets    → isDone: scene.sheets?.length > 0
refine    → isDone: scene.refined present
voice     → isDone: every effective segment has audioUrl
assemble  → isDone: scene.assembledUrl present   (render + save, one step)
```

"Done" is derived entirely from existing scene fields — the same fields the manual
UI writes — so there is never a second source of truth. After all pending scenes
complete, the orchestrator runs the **final stitch** (concat of all assembled
scenes → `finalCutUrl`). One press = export-ready cut.

## Durable run pointer

A `autoBuild: AutoBuildRun` field is added to the Redux `studio` slice (persisted):

```ts
{ status: 'idle' | 'running' | 'paused' | 'halted' | 'done',
  currentSceneId: string | null,
  currentStepId:  AutoStepId | 'stitch' | null,
  error:          string | null }
```

Per-step status for the dashboard is **computed** (not stored): steps before the
pointer whose predicate is true = `done`; step at the pointer = `running` or
`error`; steps after = `pending`. Reducers: `startAutoBuild` / `pauseAutoBuild` /
`resumeAutoBuild` / `stopAutoBuild` / `haltAutoBuild` / `completeAutoBuild` /
`setAutoPointer`.

## Halt + resume from the failed step

On the first error the run halts: the pointer stays at the failing
`(sceneId, stepId)` and `status` becomes `halted`. **Resume** flips status back
to `running` and re-runs the step at the pointer — all prior completed work
(written to scene fields) is intact and the predicates skip it automatically.

The four locked design decisions:

1. **Auto voicing: AI TTS honoring `original` tags.** Segments the refiner tagged
   `original` reuse source audio (already auto-adopted by the refiner and present
   on the segment); every other unvoiced segment gets AI TTS in its resolved voice
   (`seg.voiceId ?? speakerVoice ?? global voice`). Recording is not automatable
   and is excluded from auto runs.
2. **Error recovery: halt + resume from failure.** Stopped at the first error;
   Resume re-runs from the pointer, not from the beginning.
3. **Run scope: pending scenes, then final stitch.** Already-built scenes (status
   `'built'`) are skipped; pending scenes run in order, then the final concat fires
   automatically.
4. **Sequential within a scene.** Cut and contact sheets are independent in
   principle but run sequentially in v1 for legibility.

## Reload → paused behavior

The `studio` slice is persisted (redux-persist). If a browser reload happens while
the run is `running`, it rehydrates back to `running` — but the orchestrator's
`liveRef` (set only by an explicit Start or Resume **in the current session**) is
`false`, so the mount effect coerces the status to `paused` rather than
auto-firing. The user presses **Resume** to continue. A refine step that was
in-progress resumes its existing poll via `scene.refineJobId` (the async
fire-and-poll pattern from story 03f). Cut/sheets/assemble are not resumable
across reload, so they simply re-run from the pointer.

## Dashboard + drill-in

A new **Auto build ▶ / Manual scene tabs** toggle at the top of the Build phase
switches between modes. The **`AutoBuildBoard`** (the auto view) is a pure render
of slice state:

- **Run header:** headline (`▶ Running · Scene 2/5`, paused, halted, done counts)
  + **Start / Pause / Resume / Stop** controls. Pause waits for the current
  in-flight step to finish before stopping — never aborts mid-ffmpeg or mid-refine.
- **Scene tree:** one row per scene with rolled-up status. The active scene (and
  the selected scene) auto-expands to show all five steps with per-step icons
  (`✓ ⟳ · ✗`) and a `Voice (n/m)` sub-progress count.
- **Drill-in:** clicking a scene row selects it, revealing the existing manual
  editor (`TranscriptDiff` + bars) as the detail view — unchanged; watch segments
  populate live, or hand-edit when paused/halted.

## What shipped

**`src/lib/autoBuild.ts`** — pure step model: `AUTO_STEPS`, `nextStep`,
`nextAction`, `voiceProgress`, `sceneStepStatuses`, `sceneRunStatus`, and the
`AutoBuildRun` / `AutoStepId` / `AutoRunStatus` types. Unit-tested
(`autoBuild.test.ts`).

**`src/lib/export/assembleScene.ts`** — `assembleSceneBlob` / `assembleFinalCutBlob`,
extracted from `SceneAssembleBar`/`FinalCutBar` so the orchestrator can render
scenes headlessly. Both bars now call these same functions (no behavior change to
the manual path).

**`src/store/studioSlice.ts`** — `autoBuild` field + seven reducers
(`startAutoBuild` / `pauseAutoBuild` / `resumeAutoBuild` / `stopAutoBuild` /
`haltAutoBuild` / `completeAutoBuild` / `setAutoPointer`). Reducer tests in
`src/store/studioSlice.autoBuild.test.ts`.

**`src/components/Studio/useScenePipeline.ts`** — `voiceAllSegments` (voices an
entire scene: skips already-voiced segments, reuses source audio for refiner
`original`-tagged segments, AI TTS for the rest; writes one patch at commit time
to avoid stale-merge clobber); `markBuilt` and `autoBuildError` exported.

**`src/components/Studio/useAutoBuild.ts`** — state-driven orchestrator. When
`status === 'running'` the effect calls `nextAction(scenes)`, fires the one next
step via the matching `pipe` action, and lets Redux state changes (scene fields,
`sceneError`) re-trigger it — no tight loop, so callbacks are always fresh.
`liveRef` gates reload-resume as described above.

**`src/components/Studio/AutoBuildBoard.tsx`** — the task-tree dashboard (pure
render, no logic).

**`src/pages/Studio.tsx`** — **Auto build ▶ / Manual scene tabs** toggle in the
Build phase; mounts `useAutoBuild` and passes controls to `AutoBuildBoard`.

## Edge cases covered

- **No voice configured:** voice step halts with a clear message before the first
  TTS call.
- **Zero non-original segments:** voice step is a no-op (all segments already have
  audio after the refiner auto-adopts them), predicate satisfied.
- **Already-built scenes:** skipped by `nextAction`.
- **Replicate not configured / out of credit:** surfaces as the halt message via
  the existing `stageError()` / `autoBuildError()` extraction.

## Out of scope

Auto-running the Prep phase; parallelizing cut + contact sheets within a scene;
recording-based voicing in auto runs; auth validators (story 07).
