# Studio Parallel Auto Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Studio's Auto Build run steps on different scenes concurrently (scene 1 assembling while scene 2 refines while scene 3 captures sheets), collapsing run wall-clock to roughly the ffmpeg lane's total.

**Architecture:** Generalize the pure decision layer from "the one next step" (`nextAction`) to "every runnable step" (`nextActions`) constrained by resource lanes: an ffmpeg lane (capacity 1: cut + assemble), a seam-ordered refine lane (capacity 1, scene order), a sheets lane (capacity 1), and a shared upload semaphore. The run's single pointer becomes an `active` set; the single shared `sceneError` becomes per-scene errors. Spec: `apps/studio/stories/03u-parallel-auto-build.md`.

**Tech Stack:** React 19 + Redux Toolkit + redux-persist, Vitest + Testing Library, ffmpeg.wasm. All paths below are relative to `apps/studio/`.

## Global Constraints

- **Workspace rule: NEVER commit without explicit user approval.** At each Commit step, stage the files, show `git status --short` + a one-line summary, and ask the user before running `git commit`.
- Work on a fresh branch off `origin/main` (the checkout currently sits on `feat/studio-firefox-banner` — do not build on it). Use a worktree per workspace convention: `git worktree add .claude/worktrees/parallel-auto-build -b feat/studio-parallel-auto-build origin/main` (run from `repos/apps`).
- Per stage: `pnpm --filter studio build`, `pnpm --filter studio lint`, `pnpm --filter studio test:run` must all pass. Repo convention is one stage per PR: Tasks 1–3 = PR 1 (behavior-neutral state refactor), Task 4 = PR 2 (behavior-neutral pipe prep), Task 5 = PR 3 (the parallel launch).
- Run single test files with: `pnpm --filter studio exec vitest run <path>`.
- No new dependencies.
- Never allow two concurrent `ffmpeg.exec` calls (shared wasm instance, fixed 3 GiB MT heap). Never fan out uploads (keep-alive 502 lesson). Refines stay in scene order (seam context, story 03r).

---

### Task 1: Semaphore primitive

A tiny counting semaphore used later by the upload slot (Task 4) and the ffmpeg mutex (Task 4). Pure, no React.

**Files:**
- Create: `src/lib/semaphore.ts`
- Test: `src/lib/semaphore.test.ts`

**Interfaces:**
- Produces: `createSemaphore(capacity: number): Semaphore` where `Semaphore = { run<T>(fn: () => Promise<T> | T): Promise<T> }`. `run` waits for a slot, runs `fn`, releases on settle (resolve or reject), FIFO fairness.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/semaphore.test.ts
import { describe, it, expect } from 'vitest'
import { createSemaphore } from './semaphore'

/** A promise you resolve from the outside, to control interleaving. */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('createSemaphore', () => {
  it('capacity 1 serializes: the second task waits for the first', async () => {
    const sem = createSemaphore(1)
    const gate = deferred()
    const order: string[] = []
    const a = sem.run(async () => { order.push('a:start'); await gate.promise; order.push('a:end') })
    const b = sem.run(async () => { order.push('b:start') })
    await Promise.resolve() // let the queue settle
    expect(order).toEqual(['a:start']) // b has NOT started
    gate.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('capacity 2 admits two at once but not three', async () => {
    const sem = createSemaphore(2)
    const gate = deferred()
    const started: string[] = []
    const tasks = ['a', 'b', 'c'].map((id) =>
      sem.run(async () => { started.push(id); await gate.promise }),
    )
    await Promise.resolve()
    expect(started).toEqual(['a', 'b'])
    gate.resolve()
    await Promise.all(tasks)
    expect(started).toEqual(['a', 'b', 'c'])
  })

  it('releases the slot when the task rejects', async () => {
    const sem = createSemaphore(1)
    await expect(sem.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('returns the task result', async () => {
    const sem = createSemaphore(1)
    await expect(sem.run(() => 42)).resolves.toBe(42)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter studio exec vitest run src/lib/semaphore.test.ts`
Expected: FAIL — `Cannot find module './semaphore'` (or "createSemaphore is not a function").

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/semaphore.ts
/**
 * A tiny counting semaphore. Auto Build uses it two ways: capacity 1 as the
 * upload slot (parallel uploads trip the dev proxy's keep-alive sockets — the
 * 502 lesson from `sliceScene`/`processAll`) and capacity 1 as the ffmpeg
 * mutex (one shared wasm instance; two concurrent `exec`s would interleave FS
 * staging). FIFO: waiters run in the order they asked.
 */
export type Semaphore = { run<T>(fn: () => Promise<T> | T): Promise<T> }

export function createSemaphore(capacity: number): Semaphore {
  let active = 0
  const waiters: (() => void)[] = []
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < capacity) {
        active++
        resolve()
      } else {
        waiters.push(() => { active++; resolve() })
      }
    })
  const release = () => {
    active--
    waiters.shift()?.()
  }
  return {
    async run<T>(fn: () => Promise<T> | T): Promise<T> {
      await acquire()
      try {
        return await fn()
      } finally {
        release()
      }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter studio exec vitest run src/lib/semaphore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit (ask user first — see Global Constraints)**

```bash
git add apps/studio/src/lib/semaphore.ts apps/studio/src/lib/semaphore.test.ts
git commit -m "feat(studio): add semaphore primitive for auto-build lanes"
```

---

### Task 2: `nextActions` lane scheduler (pure layer, additive)

Add the multi-step scheduler alongside the existing `nextAction`. Nothing else changes yet — this task is purely additive and behavior-neutral.

**Files:**
- Modify: `src/lib/autoBuild.ts` (append after `nextAction`, ~line 91)
- Test: `src/lib/autoBuild.test.ts` (append a new describe block)

**Interfaces:**
- Consumes: existing `nextStep(scene)`, `AUTO_STEPS`, `AutoStepId`, `Scene`.
- Produces (Tasks 3 and 5 rely on these exact names):
  - `type ActiveStep = { sceneId: string | null; stepId: AutoStepId | 'stitch' }` (`sceneId: null` only for `'stitch'`)
  - `const STEP_LANE: Record<AutoStepId, 'ffmpeg' | 'refine' | 'sheets'>`
  - `type AutoAction = { kind: 'step'; scene: Scene; step: AutoStepId } | { kind: 'markBuilt'; scene: Scene } | { kind: 'stitch' }`
  - `nextActions(scenes: Scene[], inFlight: ActiveStep[]): AutoAction[]`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/autoBuild.test.ts` (reuse the file's existing `scene()` helper; add stage-builder helpers local to the new block):

```ts
import { nextActions, STEP_LANE, type ActiveStep } from './autoBuild'

describe('nextActions (lane scheduler)', () => {
  // Scenes staged at a given step, built with the same fields nextStep derives from.
  const atCut = (id: string, index: number) => scene({ id, index })
  const atSheets = (id: string, index: number) =>
    scene({ id, index, clipUrl: 'c', clipAudioUrl: 'a' })
  const atRefine = (id: string, index: number) =>
    scene({ id, index, clipUrl: 'c', clipAudioUrl: 'a', sheets: [{} as ContactSheet] })
  const atAssemble = (id: string, index: number) =>
    scene({
      id, index, clipUrl: 'c', clipAudioUrl: 'a', sheets: [{} as ContactSheet],
      refined: { cuts: [{ start: 1, end: 2 }], source: 'ai' },
    })
  const complete = (id: string, index: number) =>
    scene({
      id, index, clipUrl: 'c', clipAudioUrl: 'a', sheets: [{} as ContactSheet],
      refined: { cuts: [], source: 'ai' }, assembledUrl: 'done',
    })
  const built = (id: string, index: number) => ({ ...complete(id, index), status: 'built' as const })

  const stepsOf = (actions: ReturnType<typeof nextActions>) =>
    actions.filter((a) => a.kind === 'step').map((a) => `${a.scene.id}:${a.step}`)

  it('maps cut+assemble to the ffmpeg lane, refine and sheets to their own', () => {
    expect(STEP_LANE).toEqual({ cut: 'ffmpeg', assemble: 'ffmpeg', refine: 'refine', sheets: 'sheets' })
  })

  it('offers only one ffmpeg step: assemble of the earlier scene wins over cut of a later one', () => {
    const actions = nextActions([atAssemble('s1', 0), atCut('s2', 1)], [])
    expect(stepsOf(actions)).toEqual(['s1:assemble'])
  })

  it('overlaps the three lanes across scenes', () => {
    const actions = nextActions([atAssemble('s1', 0), atRefine('s2', 1), atSheets('s3', 2)], [])
    // s2 refine is allowed: the only earlier scene (s1) already has `refined`.
    expect(stepsOf(actions)).toEqual(['s1:assemble', 's2:refine', 's3:sheets'])
  })

  it('blocks a lane already in flight', () => {
    const inFlight: ActiveStep[] = [{ sceneId: 's1', stepId: 'assemble' }]
    const actions = nextActions([atAssemble('s1', 0), atCut('s2', 1), atSheets('s3', 2)], inFlight)
    // s2's cut needs the busy ffmpeg lane; s3's sheets lane is free.
    expect(stepsOf(actions)).toEqual(['s3:sheets'])
  })

  it('never offers a second step on a scene that already has one in flight', () => {
    const inFlight: ActiveStep[] = [{ sceneId: 's1', stepId: 'sheets' }]
    const actions = nextActions([atSheets('s1', 0)], inFlight)
    expect(actions).toEqual([])
  })

  it('holds scene N refine until every earlier scene is refined or built (seam order, 03r)', () => {
    // s1 is only at cut — its refine hasn't happened, so s2 must wait even
    // though the refine lane is free.
    const actions = nextActions([atCut('s1', 0), atRefine('s2', 1)], [])
    expect(stepsOf(actions)).toEqual(['s1:cut'])
    // Once s1 is built, s2's refine unblocks.
    const after = nextActions([built('s1', 0), atRefine('s2', 1)], [])
    expect(stepsOf(after)).toEqual(['s2:refine'])
  })

  it('emits markBuilt for a complete-but-pending scene', () => {
    const actions = nextActions([complete('s1', 0)], [])
    expect(actions).toEqual([{ kind: 'markBuilt', scene: expect.objectContaining({ id: 's1' }) }])
  })

  it('emits stitch only when all scenes are built AND nothing is in flight', () => {
    expect(nextActions([built('s1', 0)], [])).toEqual([{ kind: 'stitch' }])
    expect(nextActions([built('s1', 0)], [{ sceneId: null, stepId: 'stitch' }])).toEqual([])
    expect(nextActions([built('s1', 0), atAssemble('s2', 1)], [{ sceneId: 's2', stepId: 'assemble' }])).toEqual([])
  })

  it('skips built scenes entirely', () => {
    const actions = nextActions([built('s1', 0), atCut('s2', 1)], [])
    expect(stepsOf(actions)).toEqual(['s2:cut'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter studio exec vitest run src/lib/autoBuild.test.ts`
Expected: FAIL — `nextActions`/`STEP_LANE` not exported. Existing tests still PASS.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/autoBuild.ts` after `nextAction`:

```ts
/** One step currently executing. `sceneId: null` only for the final `'stitch'`. */
export type ActiveStep = { sceneId: string | null; stepId: AutoStepId | 'stitch' }

/**
 * Which shared resource each step occupies. cut + assemble both `exec` on the
 * ONE ffmpeg.wasm instance (and the MT core already saturates every CPU core,
 * with a fixed 3 GiB heap), so they share a lane of capacity 1. refine is a
 * server job the browser merely polls; sheets is main-thread canvas capture.
 */
export const STEP_LANE: Record<AutoStepId, 'ffmpeg' | 'refine' | 'sheets'> = {
  cut: 'ffmpeg',
  assemble: 'ffmpeg',
  refine: 'refine',
  sheets: 'sheets',
}

export type AutoAction =
  | { kind: 'step'; scene: Scene; step: AutoStepId }
  | { kind: 'markBuilt'; scene: Scene }
  | { kind: 'stitch' }

/**
 * Every step the run may start RIGHT NOW, given what's already in flight — the
 * parallel generalization of `nextAction`. Walks scenes in order; each scene
 * offers at most its single `nextStep` (the intra-scene cut → sheets → refine
 * → assemble dependency is enforced by derivation, exactly as in the
 * sequential runner). A step is admitted only if:
 *  - its scene has nothing in flight,
 *  - its lane (see `STEP_LANE`) is free — counting both `inFlight` and steps
 *    admitted earlier in this same pass (earlier scene wins the lane),
 *  - for `refine`: every earlier scene is built or already has `refined` — the
 *    seam-context ordering (story 03r: scene N's refine reads scene N−1's
 *    refined tail).
 * `markBuilt` is instant bookkeeping, never lane-capped. `stitch` is offered
 * only when no scene work remains AND nothing is in flight (it concats every
 * scene's saved cut).
 */
export function nextActions(scenes: Scene[], inFlight: ActiveStep[]): AutoAction[] {
  const busyLanes = new Set(
    inFlight
      .filter((a): a is ActiveStep & { stepId: AutoStepId } => a.stepId !== 'stitch')
      .map((a) => STEP_LANE[a.stepId]),
  )
  const busyScenes = new Set(inFlight.map((a) => a.sceneId))
  const actions: AutoAction[] = []
  let sceneWorkRemains = false

  for (const [i, sc] of scenes.entries()) {
    if (sc.status === 'built') continue
    sceneWorkRemains = true
    const step = nextStep(sc)
    if (step === null) {
      if (!busyScenes.has(sc.id)) actions.push({ kind: 'markBuilt', scene: sc })
      continue
    }
    if (busyScenes.has(sc.id)) continue
    if (step === 'refine' && !scenes.slice(0, i).every((p) => p.status === 'built' || !!p.refined))
      continue
    const lane = STEP_LANE[step]
    if (busyLanes.has(lane)) continue
    busyLanes.add(lane)
    actions.push({ kind: 'step', scene: sc, step })
  }

  if (!sceneWorkRemains && inFlight.length === 0) actions.push({ kind: 'stitch' })
  return actions
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter studio exec vitest run src/lib/autoBuild.test.ts`
Expected: PASS (all, old and new).

- [ ] **Step 5: Commit (ask user first)**

```bash
git add apps/studio/src/lib/autoBuild.ts apps/studio/src/lib/autoBuild.test.ts
git commit -m "feat(studio): add nextActions lane scheduler to auto-build pure layer"
```

---

### Task 3: Run state — `active` set + structured halt (breaking, coordinated)

Replace the run's single pointer (`currentSceneId`/`currentStepId`) with the `active: ActiveStep[]` set and the string `error` with a structured `halt`. One coordinated task because the type change ripples through the slice, derivations, orchestrator, board, and tests — but **behavior stays sequential**: the orchestrator still runs one step at a time; it just records it in the set.

**Files:**
- Modify: `src/lib/autoBuild.ts` (types + `sceneStepStatuses` + `sceneRunStatus` + `isHaltStale`)
- Modify: `src/store/studioSlice.ts:541-590` (reducers) and the `freshWorkingState` initial `autoBuild` (~line 267)
- Modify: `src/store/index.ts` (persist migration v3)
- Modify: `src/components/Studio/useAutoBuild.ts` (dispatch the new actions, still sequential)
- Modify: `src/components/Studio/AutoBuildBoard.tsx` (read the new shape)
- Test: `src/lib/autoBuild.test.ts`, `src/store/studioSlice.autoBuild.test.ts`, `src/components/Studio/useAutoBuild.test.tsx`

**Interfaces:**
- Consumes: `ActiveStep` from Task 2.
- Produces (Task 5 relies on these exact names):
  - `type AutoHalt = ActiveStep & { message: string }`
  - `type AutoBuildRun = { status: AutoRunStatus; active: ActiveStep[]; halt: AutoHalt | null }`
  - Slice actions: `autoStepStarted(a: ActiveStep)`, `autoStepFinished(a: ActiveStep)`, `haltAutoBuild(h: AutoHalt)`; `setAutoPointer` is DELETED. `startAutoBuild`/`pauseAutoBuild`/`resumeAutoBuild`/`stopAutoBuild`/`clearAutoHalt`/`completeAutoBuild` keep their names.

- [ ] **Step 1: Update the pure-layer tests**

In `src/lib/autoBuild.test.ts`, replace the run literals and the pointer-based cases:

```ts
const idle: AutoBuildRun = { status: 'idle', active: [], halt: null }
```

Update the `sceneStepStatuses` / `sceneRunStatus` / `isHaltStale` describe blocks — every run literal changes shape. Representative replacements (apply the same pattern to each existing case):

```ts
// was: { status: 'running', currentSceneId: 's1', currentStepId: 'refine', error: null }
const running: AutoBuildRun = {
  status: 'running',
  active: [{ sceneId: 's1', stepId: 'refine' }],
  halt: null,
}

// was: { status: 'halted', currentSceneId: 's1', currentStepId: 'assemble', error: 'boom' }
const halted: AutoBuildRun = {
  status: 'halted',
  active: [],
  halt: { sceneId: 's1', stepId: 'assemble', message: 'boom' },
}

// stitch halt (isHaltStale):
const stitchHalt: AutoBuildRun = {
  status: 'halted',
  active: [],
  halt: { sceneId: null, stepId: 'stitch', message: 'save failed' },
}
```

Add one new case — two scenes running at once (the shape Task 5 produces):

```ts
it('marks both scenes running when both have active steps', () => {
  const run: AutoBuildRun = {
    status: 'running',
    active: [{ sceneId: 's1', stepId: 'assemble' }, { sceneId: 's2', stepId: 'refine' }],
    halt: null,
  }
  expect(sceneRunStatus(scene({ id: 's1' }), run)).toBe('running')
  expect(sceneRunStatus(scene({ id: 's2' }), run)).toBe('running')
  expect(sceneRunStatus(scene({ id: 's3' }), run)).toBe('pending')
})
```

- [ ] **Step 2: Update the slice tests**

Rewrite `src/store/studioSlice.autoBuild.test.ts` — same file skeleton (`withOneProject`, `freshWorkingState`), new expectations:

```ts
import { describe, it, expect } from 'vitest'
import reducer, {
  startAutoBuild,
  pauseAutoBuild,
  resumeAutoBuild,
  stopAutoBuild,
  haltAutoBuild,
  completeAutoBuild,
  autoStepStarted,
  autoStepFinished,
  freshWorkingState,
  type StudioState,
} from './studioSlice'

const withOneProject = (): StudioState => ({
  index: { p1: { id: 'p1', name: 'A', createdAt: 1, updatedAt: 1, phase: 'import', thumbnailUrl: null } },
  working: { p1: freshWorkingState() },
  activeProjectId: 'p1',
})

const initial = withOneProject()
const boom = { sceneId: 's1', stepId: 'assemble' as const, message: 'boom' }

describe('autoBuild reducers', () => {
  it('defaults to idle with an empty active set', () => {
    expect(initial.working.p1.autoBuild).toEqual({ status: 'idle', active: [], halt: null })
  })

  it('start → running and clears any prior halt', () => {
    const halted = reducer(initial, haltAutoBuild(boom))
    const s = reducer(halted, startAutoBuild())
    expect(s.working.p1.autoBuild.status).toBe('running')
    expect(s.working.p1.autoBuild.halt).toBeNull()
  })

  it('pause only from running', () => {
    const running = reducer(initial, startAutoBuild())
    expect(reducer(running, pauseAutoBuild()).working.p1.autoBuild.status).toBe('paused')
    expect(reducer(initial, pauseAutoBuild()).working.p1.autoBuild.status).toBe('idle')
  })

  it('resume from paused or halted → running, halt cleared', () => {
    const halted = reducer(initial, haltAutoBuild(boom))
    const r = reducer(halted, resumeAutoBuild())
    expect(r.working.p1.autoBuild.status).toBe('running')
    expect(r.working.p1.autoBuild.halt).toBeNull()
  })

  it('halt records the failing step', () => {
    const s = reducer(reducer(initial, startAutoBuild()), haltAutoBuild(boom))
    expect(s.working.p1.autoBuild).toMatchObject({ status: 'halted', halt: boom })
  })

  it('stop resets the run and empties the active set', () => {
    const started = reducer(initial, autoStepStarted({ sceneId: 's1', stepId: 'refine' }))
    const s = reducer(started, stopAutoBuild())
    expect(s.working.p1.autoBuild).toEqual({ status: 'idle', active: [], halt: null })
  })

  it('started/finished add and remove exactly that step', () => {
    let s = reducer(initial, autoStepStarted({ sceneId: 's1', stepId: 'assemble' }))
    s = reducer(s, autoStepStarted({ sceneId: 's2', stepId: 'refine' }))
    expect(s.working.p1.autoBuild.active).toEqual([
      { sceneId: 's1', stepId: 'assemble' },
      { sceneId: 's2', stepId: 'refine' },
    ])
    s = reducer(s, autoStepFinished({ sceneId: 's1', stepId: 'assemble' }))
    expect(s.working.p1.autoBuild.active).toEqual([{ sceneId: 's2', stepId: 'refine' }])
  })

  it('started is idempotent for the same step', () => {
    let s = reducer(initial, autoStepStarted({ sceneId: 's1', stepId: 'cut' }))
    s = reducer(s, autoStepStarted({ sceneId: 's1', stepId: 'cut' }))
    expect(s.working.p1.autoBuild.active).toHaveLength(1)
  })

  it('complete → done', () => {
    const s = reducer(reducer(initial, startAutoBuild()), completeAutoBuild())
    expect(s.working.p1.autoBuild.status).toBe('done')
  })
})
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `pnpm --filter studio exec vitest run src/lib/autoBuild.test.ts src/store/studioSlice.autoBuild.test.ts`
Expected: FAIL — type errors / missing exports.

- [ ] **Step 4: Change the types + derivations in `src/lib/autoBuild.ts`**

Replace `AutoBuildRun` (keep `AutoRunStatus` as is; the widened-with-'stitch' comment moves to `ActiveStep`):

```ts
export type AutoHalt = ActiveStep & { message: string }

/** The run state, persisted in the studio slice. `active` is every step
 *  currently executing (the parallel runner's in-flight set, mirrored for the
 *  board); `halt` names the ONE failed step that stopped the run. */
export type AutoBuildRun = {
  status: AutoRunStatus
  active: ActiveStep[]
  halt: AutoHalt | null
}
```

Replace the run-reading derivations:

```ts
/** Per-step display status for one scene, given the live run state. */
export function sceneStepStatuses(scene: Scene, run: AutoBuildRun): Record<AutoStepId, AutoStepStatus> {
  const status = (step: AutoStepDef): AutoStepStatus => {
    if (step.isDone(scene)) return 'done'
    if (run.status === 'halted' && run.halt?.sceneId === scene.id && run.halt.stepId === step.id)
      return 'error'
    if (run.status === 'running' && run.active.some((a) => a.sceneId === scene.id && a.stepId === step.id))
      return 'running'
    return 'pending'
  }
  return Object.fromEntries(AUTO_STEPS.map((step) => [step.id, status(step)])) as Record<
    AutoStepId,
    AutoStepStatus
  >
}

/** Rolled-up status for a scene row in the dashboard. */
export function sceneRunStatus(
  scene: Scene,
  run: AutoBuildRun,
): 'built' | 'error' | 'running' | 'pending' {
  if (scene.status === 'built') return 'built'
  if (run.status === 'halted' && run.halt?.sceneId === scene.id) return 'error'
  if (run.status === 'running' && run.active.some((a) => a.sceneId === scene.id)) return 'running'
  return 'pending'
}
```

In `isHaltStale`, replace the pointer reads (the doc comment stays):

```ts
export function isHaltStale(
  scenes: Scene[],
  run: AutoBuildRun,
  finalCutUrl: string | null,
): boolean {
  if (run.status !== 'halted' || !run.halt) return false
  if (run.halt.stepId === 'stitch') return !!finalCutUrl
  const scene = scenes.find((s) => s.id === run.halt!.sceneId)
  if (!scene) return false
  if (scene.status === 'built') return true
  const step = AUTO_STEPS.find((s) => s.id === run.halt!.stepId)
  return !!step && step.isDone(scene)
}
```

- [ ] **Step 5: Change the slice (`src/store/studioSlice.ts`)**

Initial state (~line 267): `autoBuild: { status: 'idle', active: [], halt: null }`.
Import `AutoHalt` and `ActiveStep` alongside `AutoBuildRun` from `../lib/autoBuild`.
Replace the reducer block at lines 541–590:

```ts
    /** Begin / restart an auto-build run; clears any prior halt. */
    startAutoBuild(state) {
      const w = active(state); if (!w) return
      w.autoBuild.status = 'running'
      w.autoBuild.halt = null
    },
    /** Pause: no NEW steps start; in-flight steps run to completion. */
    pauseAutoBuild(state) {
      const w = active(state); if (!w) return
      if (w.autoBuild.status === 'running') w.autoBuild.status = 'paused'
    },
    /** Resume a paused or halted run; clears the halt. */
    resumeAutoBuild(state) {
      const w = active(state); if (!w) return
      if (w.autoBuild.status === 'paused' || w.autoBuild.status === 'halted') {
        w.autoBuild.status = 'running'
        w.autoBuild.halt = null
      }
    },
    /** End the run, leaving completed scene work intact. */
    stopAutoBuild(state) {
      const w = active(state); if (!w) return
      w.autoBuild = { status: 'idle', active: [], halt: null }
    },
    /** Stop on an error, recording WHICH step failed. In-flight siblings still
     *  finish (their autoStepFinished lands after this). */
    haltAutoBuild(state, action: PayloadAction<AutoHalt>) {
      const w = active(state); if (!w) return
      w.autoBuild.status = 'halted'
      w.autoBuild.halt = action.payload
    },
    /** Drop a halt whose step has since been done by hand (`isHaltStale`),
     *  leaving the run paused and resumable. */
    clearAutoHalt(state) {
      const w = active(state); if (!w) return
      if (w.autoBuild.status !== 'halted') return
      w.autoBuild.status = 'paused'
      w.autoBuild.halt = null
    },
    /** The run finished every scene (and the final stitch). */
    completeAutoBuild(state) {
      const w = active(state); if (!w) return
      w.autoBuild.status = 'done'
    },
    /** A step began executing (idempotent per step). */
    autoStepStarted(state, action: PayloadAction<ActiveStep>) {
      const w = active(state); if (!w) return
      const a = action.payload
      if (!w.autoBuild.active.some((x) => x.sceneId === a.sceneId && x.stepId === a.stepId))
        w.autoBuild.active.push(a)
    },
    /** A step finished (successfully or not) — drop it from the active set. */
    autoStepFinished(state, action: PayloadAction<ActiveStep>) {
      const w = active(state); if (!w) return
      const a = action.payload
      w.autoBuild.active = w.autoBuild.active.filter(
        (x) => !(x.sceneId === a.sceneId && x.stepId === a.stepId),
      )
    },
```

Update the export list (~line 650): remove `setAutoPointer`, add `autoStepStarted`, `autoStepFinished`.

- [ ] **Step 6: Add persist migration v3 (`src/store/index.ts`)**

In `migrations`, after the `2:` entry:

```ts
  // v3 — parallel auto build (story 03u): the run's single pointer
  // (`currentSceneId`/`currentStepId`) becomes the `active` set, and the string
  // `error` becomes the structured `halt`. A rehydrated run is never actually
  // executing (the orchestrator coerces `running` → `paused`), so `active`
  // migrates to empty; a persisted halt keeps its subject so the board still
  // points at the failing step.
  3: (state: any) => {
    if (!state) return state
    const working = Object.fromEntries(
      Object.entries(state.working ?? {}).map(([id, w]: [string, any]) => {
        const run = w?.autoBuild ?? {}
        const halt =
          run.status === 'halted'
            ? {
                sceneId: run.currentSceneId ?? null,
                stepId: run.currentStepId ?? 'assemble',
                message: run.error ?? 'Halted',
              }
            : null
        return [id, { ...w, autoBuild: { status: run.status ?? 'idle', active: [], halt } }]
      }),
    )
    return { ...state, working }
  },
```

Bump `persistConfig.version` from `2` to `3`.

- [ ] **Step 7: Update the orchestrator (`src/components/Studio/useAutoBuild.ts`) — still sequential**

Import changes: drop `setAutoPointer`, add `autoStepStarted`, `autoStepFinished`; import `type ActiveStep` from `../../lib/autoBuild`.

In the stitch branch, replace `dispatch(setAutoPointer({ sceneId: null, stepId: 'stitch' }))` and the halt with:

```ts
    if (!action) {
      inFlightRef.current = true
      const a: ActiveStep = { sceneId: null, stepId: 'stitch' }
      dispatch(autoStepStarted(a))
      ;(async () => {
        try {
          if (!p.finalCutUrl) {
            const blob = await assembleFinalCutBlob({ scenes: p.scenes, fetchBytes })
            await p.saveFinalCut(blob)
          }
          liveRef.current = false
          dispatch(completeAutoBuild())
        } catch (e) {
          liveRef.current = false
          dispatch(haltAutoBuild({ ...a, message: autoBuildError(e) }))
        } finally {
          dispatch(autoStepFinished(a))
          inFlightRef.current = false
          bump()
        }
      })()
      return
    }
```

In the step branch, replace `dispatch(setAutoPointer(...))` with `dispatch(autoStepStarted({ sceneId: scene.id, stepId: step }))`, the attempt-detected halt with `dispatch(haltAutoBuild({ sceneId: scene.id, stepId: step, message: p.sceneError }))`, the thrown-error halt with `dispatch(haltAutoBuild({ sceneId: scene.id, stepId: step, message: autoBuildError(e) }))`, and add `dispatch(autoStepFinished({ sceneId: scene.id, stepId: step }))` as the first line of the `finally`.

- [ ] **Step 8: Update the board (`src/components/Studio/AutoBuildBoard.tsx`)**

Written generically so Task 5 needs no board changes:

```tsx
  const builtCount = scenes.filter((s) => s.status === 'built').length
  const activeSceneIds = new Set(run.active.map((a) => a.sceneId))
  // The final stitch has no scene — give it its own headline + spinner.
  const stitching = run.status === 'running' && run.active.some((a) => a.stepId === 'stitch')
  const runningCount = run.active.filter((a) => a.stepId !== 'stitch').length
  const headline = stitching
    ? 'Stitching the final cut…'
    : run.status === 'running'
      ? `Running · ${runningCount || 1} step${runningCount === 1 ? '' : 's'} · ${builtCount} / ${scenes.length} built`
      : run.status === 'paused'
        ? '⏸ Paused'
        : run.status === 'halted'
          ? '✗ Halted'
          : run.status === 'done'
            ? '✓ Done'
            : `${builtCount} / ${scenes.length} scenes built`
```

Replace `run.error` (line 97) with `run.halt`: `{run.status === 'halted' && run.halt && (<p ...>{run.halt.message}</p>)}`.
Replace `expanded` (line 105): `const expanded = activeSceneIds.has(scene.id) || scene.id === selectedId`.
Delete the now-unused `activeIndex`.

- [ ] **Step 9: Update the orchestrator tests**

In `src/components/Studio/useAutoBuild.test.tsx`, the only shape-dependent assertions are in the first test (lines 162–163). Replace:

```ts
    expect(runOf(store).halt).toEqual({
      sceneId: 's1',
      stepId: 'assemble',
      message: expect.stringContaining('Failed to fetch'),
    })
```

(The `error()` testid reads `run.halt?.message ?? ''` — update the Harness's `<span data-testid="error">` accordingly: `{run.halt?.message ?? ''}`.)

- [ ] **Step 10: Run the full suite, build, lint**

Run: `pnpm --filter studio test:run && pnpm --filter studio build && pnpm --filter studio lint`
Expected: all PASS. (Grep for leftovers: `grep -rn "currentSceneId\|currentStepId\|setAutoPointer" src/` must return nothing.)

- [ ] **Step 11: Commit (ask user first)**

```bash
git add apps/studio/src/lib/autoBuild.ts apps/studio/src/lib/autoBuild.test.ts \
  apps/studio/src/store/studioSlice.ts apps/studio/src/store/studioSlice.autoBuild.test.ts \
  apps/studio/src/store/index.ts apps/studio/src/components/Studio/useAutoBuild.ts \
  apps/studio/src/components/Studio/AutoBuildBoard.tsx apps/studio/src/components/Studio/useAutoBuild.test.tsx
git commit -m "refactor(studio): auto-build run state becomes an active-step set with structured halt"
```

---

### Task 4: Concurrent-safe pipe — per-scene guards & errors, upload slot, ffmpeg mutex

Make `useScenePipeline` safe for concurrent per-scene callers, without changing manual-UI behavior. Also the clobber-safe `markBuilt` and the defensive ffmpeg mutex.

**Files:**
- Modify: `src/components/Studio/useScenePipeline.ts`
- Modify: `src/pages/Studio.tsx:693-695` (three lines)
- Modify: `src/lib/export/ffmpeg.ts`
- Test: covered by the existing suite (behavior-neutral) + Task 1's semaphore tests; Task 5's tests exercise the concurrency.

**Interfaces:**
- Consumes: `createSemaphore` from Task 1.
- Produces (Task 5 and Studio.tsx rely on these): `useScenePipeline()` return gains `sceneErrors: Record<string, string>`, and `slicingIds` / `sheetingIds` / `refiningIds` as `ReadonlySet<string>` **replacing** the scalar `slicingId` / `sheetingId` / `refiningId`. `sceneError: string | null` (most recent) stays. `markBuilt(id)` keeps its signature.

- [ ] **Step 1: Per-scene busy sets and errors in `useScenePipeline.ts`**

Replace the three scalar states (lines ~306–310):

```ts
  // Per-scene busy sets (story 03u): auto build runs steps on DIFFERENT scenes
  // concurrently, so "busy" is per scene now. Guards stay belt-and-braces — the
  // scheduler already never double-fires a scene/lane.
  const [sheetingIds, setSheetingIds] = useState<ReadonlySet<string>>(new Set())
  const [refiningIds, setRefiningIds] = useState<ReadonlySet<string>>(new Set())
  const [slicingIds, setSlicingIds] = useState<ReadonlySet<string>>(new Set())
  // Last error per scene, plus the legacy "most recent" scalar the manual
  // editor still shows. The orchestrator reads the per-scene map, so one
  // scene's stale error can never halt another scene's attempt.
  const [sceneErrors, setSceneErrors] = useState<Record<string, string>>({})
  const [sceneError, setSceneError] = useState<string | null>(null)

  const toggleId = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
    const next = new Set(set)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }
  const setSceneErrorFor = useCallback((id: string, msg: string | null) => {
    setSceneErrors((prev) => {
      const next = { ...prev }
      if (msg) next[id] = msg
      else delete next[id]
      return next
    })
    setSceneError(msg)
  }, [])
```

Then mechanically update every user of the old scalars **inside this file** (grep `slicingId`, `sheetingId`, `refiningId`, `setSceneError(`):

- `sliceScene`: guard `if (slicingIds.has(sceneId)) return`; `setSlicingIds((s) => toggleId(s, sceneId, true))` / `false` in place of `setSlicingId(...)`; `setSceneError(null)` → `setSceneErrorFor(sceneId, null)`; catch → `setSceneErrorFor(sceneId, stageError(e))`. Dep array: swap `slicingId` for `slicingIds`, add `setSceneErrorFor`.
- `generateSceneSheets`: guard `if (sheetingIds.has(id) || refiningIds.has(id)) return`; same busy-set/error swaps.
- `refineScene`: guard `if (sheetingIds.has(id) || refiningIds.has(id)) return`; same swaps (including the catch).
- `completeRefineJob`: `setRefiningId(sceneId)` → `setRefiningIds((s) => toggleId(s, sceneId, true))` (and `false` in `finally`); `setSceneError(...)` → `setSceneErrorFor(sceneId, ...)`.
- All other `setSceneError(...)` call sites (describe/blog/thumbnail/export-gate messages) are project-level, not per-scene — leave them on the scalar.
- Return object: remove `sheetingId`, `refiningId`, `slicingId`; add `sheetingIds`, `refiningIds`, `slicingIds`, `sceneErrors`.

- [ ] **Step 2: Upload slot**

Top of `useScenePipeline.ts` (module level, near `stepInFlight`):

```ts
import { createSemaphore } from '../../lib/semaphore'

/**
 * One upload at a time across every concurrent build step — parallel uploads
 * trip the dev proxy's keep-alive sockets (the 502 lesson `sliceScene` and
 * `processAll` already encode). Module-level so all hook instances share it.
 */
const uploadSlot = createSemaphore(1)
```

Wrap the upload calls in the four build-phase actions (prep-phase uploads stay as they are — already strictly sequential):

- `sliceScene`: `const { url } = await uploadSlot.run(() => uploadReq({ file: clip, kind: 'scene-clip' }).unwrap())` and the same for the audio upload below it.
- `generateSceneSheets`: inside the loop, `const { url } = await uploadSlot.run(() => uploadReq({ file: sheetFile, kind: 'thumbnails' }).unwrap())`.
- `saveSceneCut`: `const { url } = await uploadSlot.run(() => uploadReq({ file, kind: 'export' }).unwrap())`.
- `saveFinalCut`: `const { url } = await uploadSlot.run(() => uploadReq({ file, kind: 'export' }).unwrap())`.

- [ ] **Step 3: Clobber-safe `markBuilt`**

The current `markBuilt` rebuilds the whole scenes array from its render snapshot (`scenes.map` → `setScenes`) — under concurrency that overwrites any patch another step landed after this render. Replace with targeted patches:

```ts
  const markBuilt = useCallback(
    (id: string) => {
      // Targeted patch, NOT a wholesale setScenes — a concurrent step's write
      // to another scene must survive this (story 03u).
      patchScene(id, { status: 'built' })
      const stillPending = scenes.find((s) => s.id !== id && s.status === 'pending')
      if (stillPending) dispatch(setSelected(stillPending.id))
    },
    [scenes, patchScene, dispatch],
  )
```

- [ ] **Step 4: Studio.tsx call sites**

Lines 693–695:

```tsx
                    slicing={pipe.slicingIds.has(selected.id)}
                    sheeting={pipe.sheetingIds.has(selected.id)}
                    refining={pipe.refiningIds.has(selected.id)}
```

- [ ] **Step 5: ffmpeg mutex (`src/lib/export/ffmpeg.ts`)**

```ts
import { createSemaphore } from '../semaphore'

/**
 * One exec at a time. There is ONE core instance per session with one wasm FS;
 * two concurrent execs would interleave FS staging (and the MT heap is fixed).
 * The auto-build scheduler's ffmpeg lane already guarantees this — the mutex
 * lives here so the invariant can't be bypassed by any other caller.
 */
const execLock = createSemaphore(1)
```

Wrap each of the three exported function bodies. Pattern (same for `slice` and `concat`):

```ts
export async function assemble({ source, command, onProgress, onLog }: AssembleAssets): Promise<Blob> {
  return execLock.run(async () => {
    const ff = await getFFmpeg()
    // ...entire existing body unchanged...
  })
}
```

- [ ] **Step 6: Run the full suite, build, lint**

Run: `pnpm --filter studio test:run && pnpm --filter studio build && pnpm --filter studio lint`
Expected: all PASS — this task is behavior-neutral (`grep -rn "slicingId\b\|sheetingId\b\|refiningId\b" src/` must return nothing).

- [ ] **Step 7: Commit (ask user first)**

```bash
git add apps/studio/src/components/Studio/useScenePipeline.ts apps/studio/src/pages/Studio.tsx \
  apps/studio/src/lib/export/ffmpeg.ts
git commit -m "refactor(studio): per-scene pipeline guards/errors, upload slot, ffmpeg mutex"
```

---

### Task 5: Parallel orchestrator

Rewrite `useAutoBuild`'s runner effect around `nextActions`: launch every runnable step, track in-flight steps in a map, detect failures per scene. Delete the now-unused `nextAction`.

**Files:**
- Modify: `src/components/Studio/useAutoBuild.ts`
- Modify: `src/lib/autoBuild.ts` (delete `nextAction`)
- Test: `src/components/Studio/useAutoBuild.test.tsx`, `src/lib/autoBuild.test.ts` (delete `nextAction` cases)

**Interfaces:**
- Consumes: `nextActions`, `nextStep`, `ActiveStep`, `AutoHalt` (Tasks 2–3); `sceneErrors` from the pipe (Task 4).
- Produces: `useAutoBuild(pipe)` keeps its signature; its `Pipe` type swaps `sceneError: string | null` for `sceneErrors: Record<string, string>`. Studio.tsx passes the whole pipe object, so no page change.

- [ ] **Step 1: Write the failing tests**

In `src/components/Studio/useAutoBuild.test.tsx`:

1. Update the Harness: prop `sceneErrors = {}` (type `Record<string, string>`) replacing `sceneError`; pass it through to the hook; make `sliceScene`/`generateSceneSheets`/`refineScene` overridable props (default `async () => {}`).
2. Update the last existing test ("retries the step on Resume even when a stale sceneError is still set") to pass `sceneErrors={{ s1: 'an older, already-fixed hiccup' }}`.
3. Add the concurrency block:

```ts
function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/** A scene cut + sheeted but not yet refined — its next step is refine. */
function atRefine(id: string, index: number): Scene {
  return { ...prepped(id, index), refined: undefined }
}

describe('useAutoBuild — parallel launch', () => {
  it('runs scene 2 refine while scene 1 assembles', async () => {
    const store = makeStore([prepped('s1', 0), atRefine('s2', 1)])
    const renderGate = deferred<Blob>()
    assembleSceneBlobMock.mockReturnValue(renderGate.promise) // s1 assemble hangs
    const refineGate = deferred()
    const refineScene = vi.fn().mockReturnValue(refineGate.promise) // s2 refine hangs
    const upload = vi.fn().mockResolvedValue('s1.mp4')
    render(
      <Provider store={store}>
        <Harness upload={upload} refineScene={refineScene} />
      </Provider>,
    )

    await click('start')
    // BOTH steps are in flight at once — the sequential runner could never
    // show two entries here.
    await waitFor(() =>
      expect(runOf(store).active).toEqual(
        expect.arrayContaining([
          { sceneId: 's1', stepId: 'assemble' },
          { sceneId: 's2', stepId: 'refine' },
        ]),
      ),
    )
    expect(refineScene).toHaveBeenCalledWith('s2')

    // Finish s2's refine (write the durable field, as the real pipe would),
    // then release s1's render; the run drives both scenes home.
    await act(async () => {
      store.dispatch(patchScene({ id: 's2', patch: { refined: { cuts: [], source: 'ai' } } }))
      refineGate.resolve()
    })
    await act(async () => {
      renderGate.resolve(new Blob(['mp4'], { type: 'video/mp4' }))
    })
    await waitFor(() => expect(scenesOf(store)[0].assembledUrl).toBe('s1.mp4'))
  })

  it('never runs two ffmpeg-lane steps at once', async () => {
    // s1 is at assemble (ffmpeg), s2 is bare — its cut also needs ffmpeg.
    const store = makeStore([prepped('s1', 0), { ...prepped('s2', 1), clipUrl: undefined, clipAudioUrl: undefined, sheets: undefined, refined: undefined }])
    const renderGate = deferred<Blob>()
    assembleSceneBlobMock.mockReturnValue(renderGate.promise)
    const sliceScene = vi.fn().mockResolvedValue(undefined)
    render(
      <Provider store={store}>
        <Harness upload={vi.fn().mockResolvedValue('s1.mp4')} sliceScene={sliceScene} />
      </Provider>,
    )

    await click('start')
    await waitFor(() =>
      expect(runOf(store).active).toEqual([{ sceneId: 's1', stepId: 'assemble' }]),
    )
    expect(sliceScene).not.toHaveBeenCalled() // ffmpeg lane is busy with s1
  })

  it('halts on the failing scene without blaming a concurrent healthy one', async () => {
    // s2's refine fails the way the real pipe fails: the action resolves
    // (swallowed error), writes NO durable `refined`, and the scene's entry in
    // `sceneErrors` carries the message. Passing the error from the start is
    // deterministic: the attempt scan runs BEFORE any relaunch on the pass
    // after the refine settles, so the run halts instead of looping.
    const store = makeStore([prepped('s1', 0), atRefine('s2', 1)])
    assembleSceneBlobMock.mockResolvedValue(new Blob(['mp4'], { type: 'video/mp4' }))
    const refineScene = vi.fn().mockResolvedValue(undefined)
    const upload = vi.fn().mockResolvedValue('s1.mp4')
    render(
      <Provider store={store}>
        <Harness
          upload={upload}
          refineScene={refineScene}
          sceneErrors={{ s2: 'REPLICATE_NOT_CONFIGURED' }}
        />
      </Provider>,
    )

    await click('start')
    await waitFor(() => expect(status()).toBe('halted'))
    expect(runOf(store).halt).toEqual({
      sceneId: 's2',
      stepId: 'refine',
      message: 'REPLICATE_NOT_CONFIGURED',
    })
    expect(refineScene).toHaveBeenCalledTimes(1) // halted, not relaunched
  })
})
```

(Name the deferreds `renderGate`/`refineGate` rather than `render` so they don't shadow Testing Library's `render` import — adjust the first two tests accordingly.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter studio exec vitest run src/components/Studio/useAutoBuild.test.tsx`
Expected: new tests FAIL (only one step ever in flight); existing tests still PASS.

- [ ] **Step 3: Rewrite the runner effect**

In `src/components/Studio/useAutoBuild.ts`:

Imports: `nextActions`, `nextStep`, `type ActiveStep` from `../../lib/autoBuild` (drop `nextAction`).

`Pipe` type: replace `sceneError: string | null` with `sceneErrors: Record<string, string>`.

Refs (replace `inFlightRef` + `attemptRef`; `liveRef`, `renderRef`, `tick`/`bump`, `pipeRef`, the halt-stale effect, and `start/pause/resume/stop` all stay — but `pause`/`stop` now call `attemptRef.current.clear()`):

```ts
  // Steps currently executing, keyed `${sceneId}:${stepId}` — the runner's
  // source of truth for what's in flight (the Redux `active` set mirrors it
  // for the board, but a rehydrated run must start empty, so we never read it back).
  const inFlightRef = useRef(new Map<string, ActiveStep>())
  // The last step ATTEMPTED per scene, to tell a genuine failure (step still
  // next + that scene's error set) from a benign warning that left it done.
  const attemptRef = useRef(new Map<string, AutoStepId>())
  const keyOf = (a: ActiveStep) => `${a.sceneId ?? ''}:${a.stepId}`
```

The runner effect:

```ts
  useEffect(() => {
    if (run.status !== 'running') return
    if (!liveRef.current) {
      // A persisted `running` rehydrated after a reload is not actually in
      // flight — coerce it to `paused` and wait for an explicit Resume.
      dispatch(pauseAutoBuild())
      return
    }
    const p = pipeRef.current

    // Failure detection for the swallowing steps (cut/sheets/refine): an
    // attempt that's no longer in flight, whose step is STILL the scene's next
    // step, with THAT scene's error present → halt. Per-scene errors mean a
    // stale error from one scene can never halt another's attempt.
    for (const [sceneId, stepId] of attemptRef.current) {
      if (inFlightRef.current.has(keyOf({ sceneId, stepId }))) continue
      const scene = p.scenes.find((s) => s.id === sceneId)
      if (!scene || nextStep(scene) !== stepId) {
        attemptRef.current.delete(sceneId) // step advanced (or scene gone) — benign
        continue
      }
      const message = p.sceneErrors[sceneId]
      if (message) {
        attemptRef.current.delete(sceneId)
        liveRef.current = false
        dispatch(haltAutoBuild({ sceneId, stepId, message }))
        return
      }
    }

    const actions = nextActions(p.scenes, [...inFlightRef.current.values()])

    // Mark-built is instant bookkeeping — do ONE per pass (it reads the scenes
    // snapshot for the selection advance) and let the state change re-run us.
    const done = actions.find((a) => a.kind === 'markBuilt')
    if (done) {
      p.markBuilt(done.scene.id)
      return
    }

    for (const action of actions) {
      if (action.kind === 'stitch') {
        const a: ActiveStep = { sceneId: null, stepId: 'stitch' }
        inFlightRef.current.set(keyOf(a), a)
        dispatch(autoStepStarted(a))
        ;(async () => {
          try {
            if (!p.finalCutUrl) {
              const blob = await assembleFinalCutBlob({ scenes: p.scenes, fetchBytes })
              await p.saveFinalCut(blob)
            }
            liveRef.current = false
            dispatch(completeAutoBuild())
          } catch (e) {
            liveRef.current = false
            dispatch(haltAutoBuild({ ...a, message: autoBuildError(e) }))
          } finally {
            dispatch(autoStepFinished(a))
            inFlightRef.current.delete(keyOf(a))
            bump()
          }
        })()
        continue
      }
      if (action.kind !== 'step') continue
      const { scene, step } = action
      const a: ActiveStep = { sceneId: scene.id, stepId: step }
      if (inFlightRef.current.has(keyOf(a))) continue
      inFlightRef.current.set(keyOf(a), a)
      attemptRef.current.set(scene.id, step)
      dispatch(autoStepStarted(a))
      ;(async () => {
        try {
          await runStep(step, scene, p, fetchBytes, renderRef)
        } catch (e) {
          // Only assemble / save throw; the swallowing steps are caught by the
          // attempt scan above on a later pass. Clear the attempt so Resume
          // retries instead of re-halting on a leftover error (issue #220).
          attemptRef.current.delete(scene.id)
          liveRef.current = false
          dispatch(haltAutoBuild({ sceneId: scene.id, stepId: step, message: autoBuildError(e) }))
        } finally {
          dispatch(autoStepFinished(a))
          inFlightRef.current.delete(keyOf(a))
          bump()
        }
      })()
    }
  }, [run.status, pipe.scenes, pipe.sceneErrors, pipe.finalCutUrl, tick, dispatch, fetchBytes])
```

`runStep` and `RenderRef` are unchanged (the ffmpeg lane guarantees one assemble at a time, so the single `renderRef` slot still holds). Update the module doc comment at the top of the file to describe the lane scheduler (state-driven launch of every runnable step; pause/stop still only prevent the NEXT steps; in-flight steps always run to completion).

Delete `nextAction` from `src/lib/autoBuild.ts` and its describe block from `src/lib/autoBuild.test.ts`.

- [ ] **Step 4: Run the full suite, build, lint**

Run: `pnpm --filter studio test:run && pnpm --filter studio build && pnpm --filter studio lint`
Expected: all PASS, including the three new concurrency tests and all five pre-existing #220 regression tests.

- [ ] **Step 5: Manual smoke check (headless)**

From `repos/apps`: `pnpm install && pnpm studio:dev`, then from `/home/rico/bffless/localdev-tools`: `node shot.mjs http://localhost:5173/ --out /tmp/claude-1000/-home-rico-bffless/43a18827-4f25-4a25-941b-a17c0c959f5e/scratchpad/studio-smoke.png --full`. Expected: `consoleErrors:0, failedRequests:0` (a cold session's gated `/api` fallback is expected per workspace docs). A full auto-build run needs a real project + auth — flag to the user that live validation of an actual parallel run is theirs to do (or seed a session cookie per `localdev-tools/README.md`).

- [ ] **Step 6: Commit (ask user first)**

```bash
git add apps/studio/src/components/Studio/useAutoBuild.ts apps/studio/src/components/Studio/useAutoBuild.test.tsx \
  apps/studio/src/lib/autoBuild.ts apps/studio/src/lib/autoBuild.test.ts
git commit -m "feat(studio): auto build runs scene steps in parallel across resource lanes"
```

---

## Self-review notes

- **Spec coverage:** lanes (Task 2), run-state set + structured halt + migration (Task 3), per-scene guards/errors + upload slot + ffmpeg mutex + clobber-safe markBuilt (Task 4), parallel launch + failure policy + renderRef retention (Task 5), board multi-running display (folded into Task 3), tests per area. Spec's "3 PR stages" → Tasks 1–3 / 4 / 5.
- **Deliberately out of scope (per spec):** continue-on-error runs, upload concurrency > 1, parallel (non-seam-ordered) refines.
- **Known judgment calls encoded above:** `active` is mirrored to Redux for display but the runner trusts only `inFlightRef` (rehydrated `active` is stale by definition); one `markBuilt` per effect pass; prep-phase uploads left outside the upload slot (already sequential).
