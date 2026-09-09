# Workflow run page in GitHub's shape — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Apps-only: **no CE change, no row/event/engine change.**

**Goal:** Reshape `apps/workflow`'s run page into GitHub's three screens — a Summary whose graph shows **jobs only**, a **job page** (left rail of jobs, the job's steps as rows that expand in place), and step detail **inside the expanded row** — with real routes, without changing what a run is.

**Architecture:** The run routes move under one layout route, `RunShell`, that owns everything `RunPage.tsx` owns today (live-or-replay data, `window.__workflow`, follow/pinned, backstage islands, fullscreen, fork, delete, diagnostics) and renders the shared top bar, a **run rail** in place of the implementation tree, the run header, and an `<Outlet>`. Two pages render inside it: `RunSummaryPage` (jobs-only graph + the run card) and `JobPage` (job head, a collapsed job inputs/outputs disclosure, step rows). The **selection** stays the one concept the follow logic already reasons about (`null` | `<job>` | `<job>/<i>/<step>`), but it is now derived from the **route** (`/job/:job/:index?step=`) instead of a `?step=` on one URL. Step chips leave the graph and become the job page's rows, carrying the same `step[data-key][data-state]` contract.

**Tech Stack:** TypeScript · React 19 + react-router 7 (`useOutletContext`, layout routes) + Redux Toolkit · Vitest + Testing Library + MSW (`src/mocks`) · Playwright 1.61 (`e2e/`, `packages/workflow-live`) · plain CSS (`src/index.css`, OKLCH tokens, `DESIGN.md`).

**Spec:** `docs/superpowers/specs/2026-09-08-workflow-run-page-github-shape-design.md` (Decisions 1–8; this plan argues from it) · `apps/workflow/docs/spec/08-harness-ui.md` (the IA this replaces) · `07-headless.md` §Page contract (the testids that move) · `05-runs-and-persistence.md` §Summaries · `apps/workflow/DESIGN.md`, `PRODUCT.md`.

## Decisions this plan makes (spec-ambiguous points, resolved here)

1. **The selection model survives; only its home changes.** `RunShell` keeps the exact `selectedStep: StepKey | string | null` + `level: 'run' | 'job' | 'step'` pair every follow effect reads today, derived by `selectionFromRoute(params, search)`; every page write goes through `write(key, replace)`, which now calls `navigate(pathForSelection(...))`. The follow effects move to the shell **unchanged** in PR 1; PR 4 only adds the new pin triggers.
2. **`?tab=Input|Output` replaces the `paneSide` counter.** An edge dot navigates to the job page with `?tab=`; `JobPage` reads it once as `initialTab` and opens the job disclosure on that side. Re-clicking the same dot is a no-op navigation (the URL does not change) — accepted.
3. **PR 1 lands the routes, the shell and the rail with the *existing* panes as the pages** (interim `JobPage` = `JobPane` + `StepPane` under it when `?step=`). Nothing visible changes except the rail and the URLs, so every existing suite is migrated once, mechanically, before any redesign.
4. **`StepPane` becomes `StepBody`.** The pane's head (crumbs, h3, key) goes; its controls (Input | Output, Show raw, YAML, pill, kind) become a toolbar at the top of the row body. `FormStepPane` / `IslandStepPane` are rendered as the body with an empty `trail`. The `step-pane` testid moves onto the body root.
5. **One `parseStepKey`.** The three private copies (`StepPane`, `JobCard`, `RunPage`) and `waitingOn.ts`'s become `parseStepKey` in `lib/runner/types.ts`.
6. **Job status/duration helpers are pure and live in `lib/runner/jobs.ts`.** `jobStatus` is lifted from `JobPane`; `stepsOfJob` from `JobPane`'s `rows`.
7. **Expansion is page state, not store state.** `JobPage` holds `open: Set<StepKey>`; `?step=` seeds it and tracks the last row opened. `ui.selectedStep` keeps being written from the shell's `selectedStep` (the read-model tests use).
8. **The rail is the shell's, not a portal.** `Shell` splits into `TopBar` + `ImplementationRail` + `Shell` (the old composition). `RunShell` composes `TopBar` + `RunRail` + content itself. Two layout routes, no slot/portal machinery.
9. **Walk and e2e helpers are two functions in one file per package**, `waitStepState(page, key, want, timeout)` over `window.__workflow.steps` and `openStep(page, runUrl, key)` (a `goto` to the step's job URL). Every `[data-testid="step"]` locator used from a run page goes through them.
10. **Definition mode's interim (PR 2):** once chips leave the graph, the workflow page's declaration panel shows the clicked **job's** `raw` block; PR 5 replaces it with declared rows.
11. **Branching.** Epic branch `epic/run-page-github-shape` off `main` with a draft master PR labelled `epic` (memory *Sandcastle epic mode needs a master PR*); the spec + this plan are its first commit; five story PRs stacked into it; the epic→main squash is the person's, with a release-notes override in the PR body (memory *release-please override lives in the PR body*).

## Global Constraints

- **Worktrees only, under `.claude/worktrees/`** (memory *use worktrees in repos/apps*). Every story branches off `origin/epic/run-page-github-shape`: `git worktree add .claude/worktrees/<name> -b <branch> origin/epic/run-page-github-shape`, then `pnpm install --frozen-lockfile`, then `pnpm workflow-lint:build && pnpm --filter @bffless/workflow-agent-tools build && pnpm --filter @bffless/workflow-headless build` (a fresh worktree's `apps/workflow` suites fail with `Failed to resolve import "@bffless/workflow-lint/..."` until `workflow-lint` is built), then `pnpm --filter workflow stage` (hello-dist, needed by the MSW island route and `test:e2e`). Never switch the shared checkout `repos/apps`. Never bare `git stash`.
- **Branching:** PRs target `epic/run-page-github-shape`, never `main`. Stacked: PR B bases on PR A's branch until A merges, then fetch + reset (memory *GitHub stacks rebase after squash*). Read the automated review comments on **every** push before merging (memory *in-process external siblings honour rule header controls* — read every pass).
- **Commands (from `apps/workflow`):** unit `pnpm test:run <path>`; lint `pnpm lint`; types + bundle `pnpm build`; e2e `pnpm test:e2e` (needs `pnpm --filter @bffless/workflow-headless build` first); the live walks `pnpm --filter @bffless/workflow-live build && node packages/workflow-live/dist/cli.js <walk> --harness https://workflow.j5s.dev --out ./walk-out` (credentials from the env the `apps-live-walk` agent uses).
- **Contracts stay put** (PRODUCT.md principle 6): `data-testid`, `data-state`, `data-key` on `run-status`, `run-outputs`, `step`, `step-pane`, `form-step`, `island-frame`, `island-display`, `island-backstage`, `island-strip`, `island-exit-fullscreen`, `run-follow`, `kickoff-*`, `annotations`, `job`, `job-head`, `pane-raw`, `script-log`, `renderer` keep their names. New ones are named in the spec's §Headless table and used verbatim here.
- **Design tokens only** (DESIGN.md): no new colours; status is the glyph; ids/durations mono; 150 ms transitions; every new control keyboard-reachable with a visible focus ring; `aria-expanded` on row heads, `aria-current` on rail rows.
- **react-hooks rules are strict** (`eslint-plugin-react-hooks` 7: purity, set-state-in-effect, immutability). No `Date.now()` in render; no synchronous `setState` in an effect body (use `queueMicrotask` as `RunHeader.useNow` does); no DOM mutation in callbacks (memory *Studio: DOM mutation in effects only*).
- **Moved code keeps its comments**; new comments follow the file's voice (why, not what).
- **A layout route never sees its children's params** (`Shell.tsx`'s own note): `RunShell` and `RunRail` read `job`/`index` with `useMatch('/:impl/:workflow/runs/:runId/job/:job/:index?')`, never `useParams`.
- **Every task ends green:** `pnpm lint && pnpm test:run && pnpm build` from `apps/workflow` before its commit.

## File structure

**New**

| file | responsibility |
|---|---|
| `src/lib/runRoutes.ts` (+ `.test.ts`) | pure route helpers: `RunSelection`, `runPath`, `jobPath`, `stepPath`, `pathForSelection`, `selectionFromRoute`, `redirectFor` |
| `src/lib/runner/jobs.ts` (+ `.test.ts`) | pure job helpers: `jobStatus`, `jobDuration`, `stepsOfJob`, `itemTotal`, `itemLabel` (moved from `JobCard`) |
| `src/components/TopBar.tsx` | the 56px bar (brand, breadcrumb, whoami), lifted from `Shell` |
| `src/components/ImplementationRail.tsx` | the implementation → workflow tree, lifted from `Shell` |
| `src/pages/run/RunShell.tsx` (+ tests) | layout route: data path, global publish, follow/pinned, backstage, fullscreen, fork/delete/diagnostics; `RunContextValue`, `useRunContext` |
| `src/pages/run/RunSummaryPage.tsx` (+ tests) | Summary: redirect, jobs-only graph, run card |
| `src/pages/run/JobPage.tsx` (+ tests) | job page: plain / matrix item / collect view; expansion state |
| `src/components/run/RunRail.tsx` (+ tests) | the run rail |
| `src/components/run/JobHead.tsx` | job head (name, id, pill, duration, note, actions) |
| `src/components/run/JobIo.tsx` | the collapsed "Job inputs and outputs" disclosure (today's `JobPane` body) |
| `src/components/run/StepRow.tsx` (+ tests) | one step row: head + `StepBody` when open |
| `src/components/run/StepBody.tsx` | today's `StepPane` minus its head (Decision 4) |
| `src/components/run/AnnotationsPanel.tsx` (+ tests) | the Summary's Annotations disclosure with links |
| `src/components/run/JobSummaries.tsx` (+ tests) | per-job summary sections (replaces `RunSummary`) |
| `src/components/run/DeclaredStepBody.tsx` | PR 5: a declared step's inputs/outputs + raw block |
| `packages/workflow-live/src/steps.ts`, `apps/workflow/e2e/steps.ts` | `waitStepState`, `openStep` |

**Modified**: `src/routes.tsx`, `src/components/Shell.tsx`, `src/pages/RunPage.tsx` (deleted in Task 3 after its body moves), `src/pages/RunsPage.tsx`, `src/components/AnnotationList.tsx`, `src/components/graph/{GraphView,JobCard,geometry,flow}.tsx`, `src/components/graph/StepChip.tsx` (deleted in PR 3), `src/components/run/{JobPane,StepPane,RunPane,RunSummary,PaneCrumbs}.tsx`, `src/pages/WorkflowPage.tsx`, `src/store/uiSlice.ts` (comment only), `src/index.css`, `docs/spec/{05,07,08}`, `DESIGN.md`, the e2e specs, the three walks.

---

# Phase 1 — Routes, run shell, run rail (PR 1)

### Task 1: Route helpers and `parseStepKey`

**Files:**
- Modify: `apps/workflow/src/lib/runner/types.ts` (add `parseStepKey` under `stepKey`)
- Create: `apps/workflow/src/lib/runRoutes.ts`
- Test: `apps/workflow/src/lib/runRoutes.test.ts`
- Modify: `apps/workflow/src/lib/waitingOn.ts` (use `parseStepKey`; delete its private `parseKey`)

**Interfaces:**
- Produces: `parseStepKey(key: StepKey): { job: string; index: number; stepId: string } | null`; `type RunSelection = { kind: 'run' } | { kind: 'job'; job: string; index?: number } | { kind: 'step'; key: StepKey }`; `runPath(base, runId)`, `jobPath(base, runId, job, index?)`, `stepPath(base, runId, key)`; `pathForSelection(base, runId, selection, search: URLSearchParams, tab?: 'Input'|'Output'): string`; `selectionFromRoute(params: { job?: string; index?: string }, search: URLSearchParams): RunSelection`; `selectionKey(selection): StepKey | string | null`; `redirectFor(base, runId, search): string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/workflow/src/lib/runRoutes.test.ts
import { describe, expect, it } from 'vitest'
import { parseStepKey } from './runner/types'
import {
  jobPath, pathForSelection, redirectFor, runPath, selectionFromRoute, selectionKey, stepPath,
} from './runRoutes'

const BASE = '/hello/hello'
const RUN = 'run_1'

describe('parseStepKey', () => {
  it('splits a step key into its parts', () => {
    expect(parseStepKey('greet/1/say')).toEqual({ job: 'greet', index: 1, stepId: 'say' })
  })
  it('rejects a bare job id and a non-integer index', () => {
    expect(parseStepKey('greet')).toBeNull()
    expect(parseStepKey('greet/x/say')).toBeNull()
  })
})

describe('paths', () => {
  it('builds the three levels', () => {
    expect(runPath(BASE, RUN)).toBe('/hello/hello/runs/run_1')
    expect(jobPath(BASE, RUN, 'greet')).toBe('/hello/hello/runs/run_1/job/greet')
    expect(jobPath(BASE, RUN, 'greet', 1)).toBe('/hello/hello/runs/run_1/job/greet/1')
    expect(stepPath(BASE, RUN, 'greet/1/say')).toBe('/hello/hello/runs/run_1/job/greet/1?step=greet%2F1%2Fsay')
  })
  it('keeps unrelated query parameters and drops `step` on the way up', () => {
    const search = new URLSearchParams('mocks=on&step=greet%2F0%2Fsay')
    expect(pathForSelection(BASE, RUN, { kind: 'run' }, search)).toBe('/hello/hello/runs/run_1?mocks=on')
    expect(pathForSelection(BASE, RUN, { kind: 'job', job: 'slow' }, search)).toBe('/hello/hello/runs/run_1/job/slow?mocks=on')
    expect(pathForSelection(BASE, RUN, { kind: 'step', key: 'slow/0/start' }, search)).toBe(
      '/hello/hello/runs/run_1/job/slow/0?mocks=on&step=slow%2F0%2Fstart',
    )
  })
  it('carries the side an edge dot asked for', () => {
    expect(pathForSelection(BASE, RUN, { kind: 'job', job: 'slow' }, new URLSearchParams(), 'Output')).toBe(
      '/hello/hello/runs/run_1/job/slow?tab=Output',
    )
  })
})

describe('selectionFromRoute', () => {
  it('reads the three levels off the params and the query', () => {
    expect(selectionFromRoute({}, new URLSearchParams())).toEqual({ kind: 'run' })
    expect(selectionFromRoute({ job: 'greet' }, new URLSearchParams())).toEqual({ kind: 'job', job: 'greet' })
    expect(selectionFromRoute({ job: 'greet', index: '1' }, new URLSearchParams())).toEqual({ kind: 'job', job: 'greet', index: 1 })
    expect(selectionFromRoute({ job: 'greet', index: '1' }, new URLSearchParams('step=greet%2F1%2Fsay'))).toEqual({
      kind: 'step', key: 'greet/1/say',
    })
  })
  it('ignores a `step` that is not a step key, and a bad index', () => {
    expect(selectionFromRoute({ job: 'greet' }, new URLSearchParams('step=greet'))).toEqual({ kind: 'job', job: 'greet' })
    expect(selectionFromRoute({ job: 'greet', index: 'x' }, new URLSearchParams())).toEqual({ kind: 'job', job: 'greet' })
  })
  it('maps a selection back to the key the follow logic reads', () => {
    expect(selectionKey({ kind: 'run' })).toBeNull()
    expect(selectionKey({ kind: 'job', job: 'greet', index: 1 })).toBe('greet')
    expect(selectionKey({ kind: 'step', key: 'greet/1/say' })).toBe('greet/1/say')
  })
})

describe('redirectFor', () => {
  it('sends an old `?step=<job>` on the Summary to the job page', () => {
    expect(redirectFor(BASE, RUN, new URLSearchParams('step=slow'))).toBe('/hello/hello/runs/run_1/job/slow')
  })
  it('sends an old `?step=<key>` to the job page with the step kept, other params riding along', () => {
    expect(redirectFor(BASE, RUN, new URLSearchParams('mocks=on&step=greet%2F1%2Fsay'))).toBe(
      '/hello/hello/runs/run_1/job/greet/1?mocks=on&step=greet%2F1%2Fsay',
    )
  })
  it('does nothing without a `step`', () => {
    expect(redirectFor(BASE, RUN, new URLSearchParams('resume=1'))).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/workflow && pnpm test:run src/lib/runRoutes.test.ts`
Expected: FAIL — `Cannot find module './runRoutes'` / `parseStepKey is not exported`.

- [ ] **Step 3: Implement**

In `src/lib/runner/types.ts`, directly under the existing `stepKey` helper:

```ts
/** `greet/1/say` → its parts; a step id cannot contain `/`, so the split is exact. `null` for a bare job id or a bad index. */
export function parseStepKey(key: StepKey): { job: string; index: number; stepId: string } | null {
  const [job, index, ...rest] = key.split('/')
  if (job === undefined || job === '' || index === undefined || rest.length === 0) return null
  const parsed = Number(index)
  const stepId = rest.join('/')
  return Number.isInteger(parsed) && stepId !== '' ? { job, index: parsed, stepId } : null
}
```

Create `src/lib/runRoutes.ts`:

```ts
/**
 * The run's routes (spec 2026-09-08, Decision 1): the Summary at
 * `/runs/:runId`, a job at `/job/:job`, a matrix item at `/job/:job/:index`,
 * and `?step=<key>` on a job page for the expanded step row. Pure — the shell
 * derives its selection from these and writes navigations through them, so
 * the two directions cannot disagree.
 */
import type { StepKey } from './runner/types'
import { parseStepKey } from './runner/types'

export type RunSelection =
  | { kind: 'run' }
  | { kind: 'job'; job: string; index?: number }
  | { kind: 'step'; key: StepKey }

export const STEP_PARAM = 'step'
export const TAB_PARAM = 'tab'

export function runPath(base: string, runId: string): string {
  return `${base}/runs/${runId}`
}

export function jobPath(base: string, runId: string, job: string, index?: number): string {
  const item = index === undefined ? '' : `/${index}`
  return `${runPath(base, runId)}/job/${encodeURIComponent(job)}${item}`
}

export function stepPath(base: string, runId: string, key: StepKey): string {
  const parts = parseStepKey(key)
  if (!parts) return runPath(base, runId)
  return `${jobPath(base, runId, parts.job, parts.index)}?${STEP_PARAM}=${encodeURIComponent(key)}`
}

/** The URL for a selection, keeping every query parameter that is not ours (`?mocks=`, `?resume=1`). */
export function pathForSelection(
  base: string,
  runId: string,
  selection: RunSelection,
  search: URLSearchParams,
  tab?: 'Input' | 'Output',
): string {
  const next = new URLSearchParams(search)
  next.delete(STEP_PARAM)
  next.delete(TAB_PARAM)
  let path: string
  if (selection.kind === 'run') path = runPath(base, runId)
  else if (selection.kind === 'job') path = jobPath(base, runId, selection.job, selection.index)
  else {
    const parts = parseStepKey(selection.key)
    path = parts ? jobPath(base, runId, parts.job, parts.index) : runPath(base, runId)
    if (parts) next.set(STEP_PARAM, selection.key)
  }
  if (tab && selection.kind !== 'run') next.set(TAB_PARAM, tab)
  const query = next.toString()
  return query === '' ? path : `${path}?${query}`
}

export function selectionFromRoute(
  params: { job?: string; index?: string },
  search: URLSearchParams,
): RunSelection {
  if (params.job === undefined) return { kind: 'run' }
  const step = search.get(STEP_PARAM)
  if (step !== null && parseStepKey(step)) return { kind: 'step', key: step }
  const index = params.index === undefined ? undefined : Number(params.index)
  return index !== undefined && Number.isInteger(index) && index >= 0
    ? { kind: 'job', job: params.job, index }
    : { kind: 'job', job: params.job }
}

/** The one value the follow logic reads: `null` (run), a bare job id, or a step key. */
export function selectionKey(selection: RunSelection): StepKey | string | null {
  if (selection.kind === 'run') return null
  return selection.kind === 'job' ? selection.job : selection.key
}

/** An old `?step=` on the Summary URL → where it lives now; `null` when there is nothing to redirect. */
export function redirectFor(base: string, runId: string, search: URLSearchParams): string | null {
  const step = search.get(STEP_PARAM)
  if (step === null) return null
  const parts = parseStepKey(step)
  const selection: RunSelection = parts ? { kind: 'step', key: step } : { kind: 'job', job: step }
  return pathForSelection(base, runId, selection, search)
}
```

In `src/lib/waitingOn.ts`, delete the private `parseKey` and import `parseStepKey` from `./runner/types`; replace the one call site (`const parsed = parseKey(key)` → `parseStepKey(key)`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/workflow && pnpm test:run src/lib/runRoutes.test.ts src/lib/waitingOn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/workflow/src/lib/runRoutes.ts apps/workflow/src/lib/runRoutes.test.ts apps/workflow/src/lib/runner/types.ts apps/workflow/src/lib/waitingOn.ts
git commit -m "feat(workflow): route helpers for the run's three levels, and one parseStepKey"
```

### Task 2: Split `Shell` into `TopBar`, `ImplementationRail`, `Shell`

**Files:**
- Create: `apps/workflow/src/components/TopBar.tsx`, `apps/workflow/src/components/ImplementationRail.tsx`
- Modify: `apps/workflow/src/components/Shell.tsx`
- Test: `apps/workflow/src/components/Shell.test.tsx` (exists? if not, create with the two cases below)

**Interfaces:**
- Produces: `TopBar()` — renders `header.shell-header` exactly as `Shell` does today (brand link, divider, `Breadcrumb`, `Whoami`); `ImplementationRail()` — renders `nav.rail[aria-label="Implementations"]` with the eyebrow and the tree; `Shell()` — unchanged output.
- `Breadcrumb` moves into `TopBar.tsx` and gains one rule: path segments `job`, `<job>`, `<i>` after `runs/<runId>` render as `<job>` and `item <i+1>` (the `job` segment itself is skipped).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/workflow/src/components/Shell.test.tsx (append, or create with the imports below)
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { makeStore } from '../store'
import { TopBar } from './TopBar'

function at(path: string) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[path]}>
        <TopBar />
      </MemoryRouter>
    </Provider>,
  )
}

describe('TopBar breadcrumb', () => {
  it('reads a job route as the job and its item', () => {
    at('/hello/hello/runs/run_1/job/greet/1')
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(crumbs).toHaveTextContent('Implementations')
    expect(crumbs).toHaveTextContent('run_1')
    expect(crumbs).toHaveTextContent('greet')
    expect(crumbs).toHaveTextContent('item 2')
    expect(crumbs).not.toHaveTextContent(/\bjob\b/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/workflow && pnpm test:run src/components/Shell.test.tsx`
Expected: FAIL — `Cannot find module './TopBar'`.

- [ ] **Step 3: Implement**

`src/components/TopBar.tsx` — move `Whoami`, `Breadcrumb` and the `<header className="shell-header">` block out of `Shell.tsx` verbatim, exporting `TopBar`. Replace `Breadcrumb`'s `rest.map(...)` with:

```tsx
/** `runs/run_1/job/greet/1` → `runs`, `run_1`, `greet`, `item 2` — the `job` segment is a route word, not a place. */
function crumbsAfterWorkflow(rest: string[]): string[] {
  const out: string[] = []
  rest.forEach((segment, i) => {
    if (segment === 'job') return
    if (rest[i - 1] === 'job') out.push(decodeURIComponent(segment))
    else if (rest[i - 2] === 'job' && /^\d+$/.test(segment)) out.push(`item ${Number(segment) + 1}`)
    else out.push(segment)
  })
  return out
}
```

and render `crumbsAfterWorkflow(rest).map((segment, index) => <span key={`${index}-${segment}`}>{segment}</span>)`.

`src/components/ImplementationRail.tsx` — move `Rail` out verbatim and export:

```tsx
export function ImplementationRail() {
  return (
    <nav className="rail" aria-label="Implementations">
      <p className="rail-eyebrow">Implementations</p>
      <Rail />
    </nav>
  )
}
```

`src/components/Shell.tsx` becomes:

```tsx
import { Outlet, useLocation } from 'react-router-dom'
import { ErrorBoundary } from './ErrorBoundary'
import { ImplementationRail } from './ImplementationRail'
import { TopBar } from './TopBar'

export function Shell() {
  const { pathname } = useLocation()
  return (
    <div className="shell">
      <TopBar />
      <div className="shell-body">
        <ImplementationRail />
        <main className="content">
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the suite**

Run: `cd apps/workflow && pnpm test:run src/components && pnpm lint`
Expected: PASS (every existing Shell/rail assertion still finds the same DOM).

- [ ] **Step 5: Commit**

```bash
git add apps/workflow/src/components/TopBar.tsx apps/workflow/src/components/ImplementationRail.tsx apps/workflow/src/components/Shell.tsx apps/workflow/src/components/Shell.test.tsx
git commit -m "refactor(workflow): split Shell into TopBar, ImplementationRail and the layout"
```

### Task 3: `RunShell` layout route, interim pages, and the route table

This is the big move. `RunPage.tsx` is deleted; its body becomes `RunShell.tsx` plus two thin pages. **Behaviour is unchanged** except that the selection now lives on the route.

**Files:**
- Create: `apps/workflow/src/pages/run/RunShell.tsx`, `apps/workflow/src/pages/run/RunSummaryPage.tsx`, `apps/workflow/src/pages/run/JobPage.tsx`, `apps/workflow/src/pages/run/runContext.ts`
- Modify: `apps/workflow/src/routes.tsx`
- Delete: `apps/workflow/src/pages/RunPage.tsx`
- Test: `apps/workflow/src/pages/run/RunShell.test.tsx` (new, two cases) — the existing `RunPage.*.test.tsx` suites are migrated in Task 5

**Interfaces:**
- Produces (`runContext.ts`):

```ts
import { createContext } from 'react'
import type { Definition, RunState, Annotation, StepKey } from '../../lib/runner/types'
import type { ServerRunRow, ServerStepRow } from '../../lib/coerce'
import type { YamlSource } from '../../components/run/YamlDrawer'
import type { RunSelection } from '../../lib/runRoutes'

export interface RunContextValue {
  base: string                 // `/<impl>/<workflow>`
  runId: string
  def: Definition
  state: RunState
  run: ServerRunRow | null     // null on the live path
  steps: ServerStepRow[]
  isLive: boolean
  impl: string | undefined     // implForView, trust-gated (apps#364)
  annotations: Annotation[]
  yamlSource: YamlSource
  workflowName: string
  selection: RunSelection
  /** The follow logic's value: null | job id | step key (Decision 1). */
  selectedStep: StepKey | string | null
  /** A person's navigation to a selection: pushes, pins. */
  select: (selection: RunSelection, tab?: 'Input' | 'Output') => void
  /** Up one level (Esc, crumbs): pushes, pins. */
  back: () => void
  toRun: () => void
  forkable: (job: string) => boolean
  fork: (job: string) => Promise<void>
}
export const RunContext = createContext<RunContextValue | null>(null)
export function useRunContext(): RunContextValue  // throws outside RunShell
```

- `RunShell` renders `TopBar` + `RunRail` (Task 4; in this task a placeholder `<nav className="rail run-rail" aria-label="Run" />`) + `main.content` holding `RunHeader`, the banners, and `<Outlet />` inside `FileRefProvider` / `ImplContext` / `ImplWithheldContext`, plus the backstage and the fullscreen strip. The three guards (`Loading…`, `LoadError`, `No such run`) and `RawRows` render **in place of the outlet** (the rail still shows the back link).

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/workflow/src/pages/run/RunShell.test.tsx
import { render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import App from '../../App'
import { resetDb, seedFinishedRun } from '../../mocks/db'
import { FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { makeStore } from '../../store'

afterEach(() => resetDb())

function renderAt(path: string) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

describe('RunShell', () => {
  it('renders the run header and the run card on the Summary route, with the run rail instead of the implementation tree', async () => {
    seedFinishedRun()
    renderAt(`/hello/hello/runs/${FIXTURE_RUN_ID}`)
    const page = screen.getByRole('main')
    await within(page).findByTestId('run-status')
    expect(within(page).getByTestId('run-pane')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Run' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Implementations' })).not.toBeInTheDocument()
  })

  it('redirects an old `?step=` on the Summary URL to the job page, keeping the step', async () => {
    seedFinishedRun()
    renderAt(`/hello/hello/runs/${FIXTURE_RUN_ID}?step=slow%2F0%2Fstart`)
    const page = screen.getByRole('main')
    await within(page).findByTestId('step-pane')
    expect(within(page).getByTestId('job-pane')).toBeInTheDocument()
    expect(within(page).queryByTestId('run-pane')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/workflow && pnpm test:run src/pages/run/RunShell.test.tsx`
Expected: FAIL — no `Run` navigation; `step-pane` not found (the old page renders it under the graph, but the rail assertion fails first).

- [ ] **Step 3: Implement — `runContext.ts`**

```ts
// apps/workflow/src/pages/run/runContext.ts
import { createContext, useContext } from 'react'
// (the interface from the Interfaces block above, verbatim)
export const RunContext = createContext<RunContextValue | null>(null)
export function useRunContext(): RunContextValue {
  const value = useContext(RunContext)
  if (!value) throw new Error('useRunContext: no RunShell above this page')
  return value
}
```

- [ ] **Step 4: Implement — `RunShell.tsx`**

Copy `RunPage.tsx` to `src/pages/run/RunShell.tsx` (fix the relative imports: one directory deeper). Rename the component `RunShell`. Then make exactly these changes:

1. **Params and selection.** Replace the `useSearchParams` / `STEP_PARAM` / `selectedStep` / `level` / `setStep` block with:

```tsx
const { impl, workflow, runId } = useParams()
// A layout route's `useParams` never carries its children's params (Global Constraints).
const jobMatch = useMatch('/:impl/:workflow/runs/:runId/job/:job/:index?')
const [searchParams] = useSearchParams()
const location = useLocation()
const selection = selectionFromRoute({ job: jobMatch?.params.job, index: jobMatch?.params.index }, searchParams)
const selectedStep: StepKey | string | null = selectionKey(selection)
const level: 'run' | 'job' | 'step' = selection.kind
// `base` is computed later (it needs `shown`); the navigation helpers close over a ref so they can be defined here.
const baseRef = useRef('')
const go = (target: RunSelection, replace: boolean, tab?: 'Input' | 'Output') =>
  void navigate(pathForSelection(baseRef.current, runId ?? '', target, new URLSearchParams(location.search), tab), { replace })
const toSelection = (key: StepKey | string | null): RunSelection =>
  key === null ? { kind: 'run' } : parseStepKey(key) ? { kind: 'step', key } : { kind: 'job', job: key }
const setStep = (key: StepKey | string | null, replace: boolean) => go(toSelection(key), replace)
```

   and set `baseRef.current = base` immediately after `base` is computed (`const base = ...`; then `baseRef.current = base`).

2. **`write`, `pin`, `back`, `toRun`, `select`, `onFollowChange`** keep their bodies; `select` becomes:

```tsx
const select = (target: RunSelection, tab?: 'Input' | 'Output') => {
  const key = selectionKey(target)
  if (key === selectedStep && tab === undefined) { back(); return }
  pin()
  go(target, false, tab)
}
```

   Delete the `side` / `paneSide` state (Decision 2).

3. **The pin-on-arrival effect** (`pageWrote`) is unchanged: it compares `pageWrote.current === selectedStep`.

4. **Render.** Replace everything from `return (` to the end with:

```tsx
const ctx: RunContextValue | null =
  state && def
    ? {
        base, runId: shownRunId, def, state, run: isLive ? null : run!, steps, isLive,
        impl: implForView ?? undefined, annotations, yamlSource,
        workflowName: isLive ? sliceMeta!.workflowName : run!.workflowName || run!.workflow,
        selection, selectedStep, select, back, toRun, forkable, fork,
      }
    : null

return (
  <div className="shell">
    <TopBar />
    <div className="shell-body">
      <RunRail base={base} runId={shownRunId} def={def} state={state} yaml={yamlSource.yaml} />
      <main className="content">
        <ErrorBoundary key={location.pathname}>
          <ImplContext.Provider value={implForView}>
          <ImplWithheldContext.Provider value={implWithheld}>
            <section className="page">
              <RunHeader ... (unchanged props) />
              {/* banners unchanged */}
              {!ctx ? (
                <RawRows run={run!} steps={steps} />
              ) : (
                <FileRefProvider state={ctx.state}>
                  <RunContext.Provider value={ctx}>
                    <div className={fullscreen ? 'run-canvas island-fullscreen' : 'run-canvas'}>
                      {fullscreen && (
                        <div className="island-strip" data-testid="island-strip">
                          <span className="island-strip-title">
                            <span className="island-strip-crumb">Run › {selectedStep!.split('/')[0]}</span>
                            <span className="island-strip-key">{selectedStep}</span>
                          </span>
                          <button type="button" data-testid="island-exit-fullscreen" onClick={() => dispatch(islandDisplayChanged('inline'))}>
                            Exit fullscreen <kbd>Esc</kbd>
                          </button>
                        </div>
                      )}
                      <Outlet />
                      {backstage.length > 0 && (
                        <div className="island-backstage" data-testid="island-backstage" aria-hidden="true" inert>
                          {backstage.map((key) => <BackstageIsland key={key} runId={ctx.state.runId} stepKey={key} />)}
                        </div>
                      )}
                    </div>
                  </RunContext.Provider>
                </FileRefProvider>
              )}
            </section>
          </ImplWithheldContext.Provider>
          </ImplContext.Provider>
        </ErrorBoundary>
      </main>
    </div>
  </div>
)
```

   The three early-return guards (`Loading…`, `LoadError`, `No such run`) wrap their content in the same `shell` / `TopBar` / `RunRail` (with `def={null} state={null}`) / `main.content` frame, so the rail's back link is always there. Extract that frame as a local `Frame({ children })` component inside the file to avoid repeating it.

5. Until Task 4 lands, `RunRail` is a stub in `src/components/run/RunRail.tsx`:

```tsx
export interface RunRailProps { base: string; runId: string; def: Definition | null; state: RunState | null; yaml?: string }
export function RunRail(_: RunRailProps) { return <nav className="rail run-rail" aria-label="Run" /> }
```

- [ ] **Step 5: Implement — the interim pages**

```tsx
// apps/workflow/src/pages/run/RunSummaryPage.tsx
import { Navigate, useLocation } from 'react-router-dom'
import { GraphView } from '../../components/graph/GraphView'
import { RunPane } from '../../components/run/RunPane'
import { parseStepKey } from '../../lib/runner/types'
import { redirectFor } from '../../lib/runRoutes'
import { useRunContext } from './runContext'

export function RunSummaryPage() {
  const ctx = useRunContext()
  const { search } = useLocation()
  const redirect = redirectFor(ctx.base, ctx.runId, new URLSearchParams(search))
  if (redirect) return <Navigate to={redirect} replace />
  return (
    <>
      <GraphView
        def={ctx.def}
        mode="run"
        state={ctx.state}
        selectedKey={null}
        onSelect={(key, side) =>
          ctx.select(parseStepKey(key) ? { kind: 'step', key } : { kind: 'job', job: key }, side)
        }
      />
      <RunPane
        key={ctx.state.runId}
        def={ctx.def}
        state={ctx.state}
        workflowName={ctx.workflowName}
        annotations={ctx.annotations}
        impl={ctx.impl}
        onJump={(key) => ctx.select({ kind: 'step', key })}
      />
    </>
  )
}
```

```tsx
// apps/workflow/src/pages/run/JobPage.tsx  (interim — replaced in Phase 3)
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { JobPane } from '../../components/run/JobPane'
import { StepPane } from '../../components/run/StepPane'
import { parseStepKey } from '../../lib/runner/types'
import { STEP_PARAM, TAB_PARAM, stepPath } from '../../lib/runRoutes'
import { useRunContext } from './runContext'

export function JobPage() {
  const ctx = useRunContext()
  const { job = '' } = useParams()
  const [search] = useSearchParams()
  const step = search.get(STEP_PARAM)
  const tab = search.get(TAB_PARAM) === 'Output' ? 'Output' : search.get(TAB_PARAM) === 'Input' ? 'Input' : undefined
  const parts = step ? parseStepKey(step) : null
  // A `?step=` of another job belongs on that job's page (spec §Error states).
  if (parts && parts.job !== job) return <Navigate to={stepPath(ctx.base, ctx.runId, step!)} replace />
  return (
    <>
      <JobPane
        key={`${job}#${tab ?? ''}`}
        def={ctx.def}
        state={ctx.state}
        job={job}
        impl={ctx.impl}
        initialTab={tab}
        onSelect={(key) => ctx.select({ kind: 'step', key })}
        onBack={ctx.toRun}
        onFork={ctx.forkable(job) ? () => void ctx.fork(job) : undefined}
        source={ctx.yamlSource}
      />
      {parts && (
        <StepPane
          key={step!}
          def={ctx.def}
          state={ctx.state}
          stepKey={step!}
          impl={ctx.impl}
          live={ctx.isLive}
          initialTab={tab}
          onBack={ctx.back}
          onRun={ctx.toRun}
          source={ctx.yamlSource}
        />
      )}
    </>
  )
}
```

- [ ] **Step 6: Route table**

```tsx
// apps/workflow/src/routes.tsx
import { Route } from 'react-router-dom'
import { Shell } from './components/Shell'
import { FilePage } from './pages/FilePage'
import { ImplementationsPage } from './pages/ImplementationsPage'
import { KickoffPage } from './pages/KickoffPage'
import { JobPage } from './pages/run/JobPage'
import { RunShell } from './pages/run/RunShell'
import { RunSummaryPage } from './pages/run/RunSummaryPage'
import { RunsPage } from './pages/RunsPage'
import { WorkflowPage } from './pages/WorkflowPage'
import { WorkflowsPage } from './pages/WorkflowsPage'

export const routes = (
  <>
    <Route element={<Shell />}>
      <Route index element={<ImplementationsPage />} />
      <Route path=":impl" element={<WorkflowsPage />} />
      <Route path=":impl/:workflow" element={<WorkflowPage />} />
      <Route path=":impl/:workflow/run" element={<KickoffPage />} />
      <Route path=":impl/:workflow/runs" element={<RunsPage />} />
      <Route path=":impl/:workflow/file" element={<FilePage />} />
    </Route>
    {/* The run's own layout: the run rail replaces the implementation tree (spec Decision 3). */}
    <Route path=":impl/:workflow/runs/:runId" element={<RunShell />}>
      <Route index element={<RunSummaryPage />} />
      <Route path="job/:job" element={<JobPage />} />
      <Route path="job/:job/:index" element={<JobPage />} />
    </Route>
  </>
)
```

`createRoutesFromElements(routes)` (used by `RunPage.selection.test.tsx`) accepts a fragment of `<Route>`s; keep the fragment.

- [ ] **Step 7: Delete `RunPage.tsx`, run the new tests, then lint and build**

Run: `cd apps/workflow && git rm src/pages/RunPage.tsx && pnpm test:run src/pages/run/RunShell.test.tsx && pnpm lint && pnpm build`
Expected: the two new tests PASS; lint clean; build clean. The old `RunPage.*.test.tsx` suites fail to import `../pages/RunPage`? No — they import `App`/`routes`, so they compile; several of their assertions fail (chips no longer `aria-pressed` on the job page, `step-pane` under a different parent). That is Task 5.

- [ ] **Step 8: Commit**

```bash
git add -A apps/workflow/src/pages apps/workflow/src/routes.tsx apps/workflow/src/components/run/RunRail.tsx
git commit -m "feat(workflow): RunShell layout route — Summary and job routes, the selection derived from the URL"
```

### Task 4: Pure job helpers and the run rail

**Files:**
- Create: `apps/workflow/src/lib/runner/jobs.ts`, `apps/workflow/src/lib/runner/jobs.test.ts`
- Modify: `apps/workflow/src/components/run/RunRail.tsx` (replace the stub), `apps/workflow/src/components/run/JobPane.tsx` (import `jobStatus`, `stepsOfJob` instead of its private copies), `apps/workflow/src/components/graph/JobCard.tsx` (import `itemLabel`)
- Test: `apps/workflow/src/components/run/RunRail.test.tsx`
- CSS: `apps/workflow/src/index.css` (append a `Run rail` block after `.rail-workflow.active`)

**Interfaces:**
- Produces (`jobs.ts`):

```ts
export function jobStatus(steps: StepState[]): StepStatus            // lifted from JobPane, same rules
export function jobDuration(steps: StepState[]): number | undefined  // earliest startedAt → latest finishedAt, only when every started step has finished
export function itemTotal(state: RunState, job: string): number      // state.expansions[job]?.total ?? 1
export function itemLabel(item: Record<string, unknown>, index: number): string   // moved from JobCard (uses matrixItemLabel)
export interface JobStepRow { key: StepKey; step: Step; index: number; state: StepState | undefined }
export function stepsOfJob(def: Definition, state: RunState, job: string, index?: number): JobStepRow[]  // every item when index is undefined, declaration order within an item
```

- Produces (`RunRail`): `RunRail({ base, runId, def, state, yaml })` — `nav.rail.run-rail[aria-label="Run"]`; rows: `rail-back` (link to `base`), `rail-summary` (`NavLink end` to `runPath`), one `rail-job[data-job]` per job in `jobOrder(def)` — for a matrix job a `rail-matrix[data-job]` group (button with `aria-expanded`, the fraction, a chevron) whose items are `rail-job[data-job][data-index]` links; then `Past runs` (`${base}/runs`) and `Workflow file` (`${base}/file`, `state: { yaml, runId }`).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/workflow/src/lib/runner/jobs.test.ts
import { describe, expect, it } from 'vitest'
import { replayRun } from './replay'
import { definitionOf } from '../runDefinition'
import { FINISHED_RUN } from '../../mocks/fixtures/finishedRun'
import { toRunRow, toStepRow } from '../coerce'
import { itemTotal, jobDuration, jobStatus, stepsOfJob } from './jobs'

const run = toRunRow(FINISHED_RUN.run)
const def = definitionOf(run)!
const state = replayRun(run, FINISHED_RUN.steps.map(toStepRow), def)

describe('jobs', () => {
  it('lists every item of a matrix job, in item then declaration order', () => {
    expect(stepsOfJob(def, state, 'greet').map((r) => r.key)).toEqual(['greet/0/say', 'greet/1/say'])
    expect(stepsOfJob(def, state, 'greet', 1).map((r) => r.key)).toEqual(['greet/1/say'])
    expect(itemTotal(state, 'greet')).toBe(2)
    expect(itemTotal(state, 'slow')).toBe(1)
  })
  it('reads a job status as the worst of its steps', () => {
    expect(jobStatus(stepsOfJob(def, state, 'greet').map((r) => r.state!))).toBe('succeeded')
    expect(jobStatus([])).toBe('queued')
    expect(jobStatus([{ ...state.steps['slow/0/start']!, status: 'failed' }])).toBe('failed')
  })
  it('spans a job from its first start to its last finish, and is undefined while a step is still open', () => {
    const rows = stepsOfJob(def, state, 'slow').map((r) => r.state!)
    expect(jobDuration(rows)).toBe(rows[0]!.finishedAt! - rows[0]!.startedAt!)
    expect(jobDuration([{ ...rows[0]!, finishedAt: undefined }])).toBeUndefined()
  })
})
```

```tsx
// apps/workflow/src/components/run/RunRail.test.tsx
import { render, screen, within, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { replayRun } from '../../lib/runner/replay'
import { definitionOf } from '../../lib/runDefinition'
import { toRunRow, toStepRow } from '../../lib/coerce'
import { FINISHED_RUN, FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { RunRail } from './RunRail'

const run = toRunRow(FINISHED_RUN.run)
const def = definitionOf(run)!
const state = replayRun(run, FINISHED_RUN.steps.map(toStepRow), def)

function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RunRail base="/hello/hello" runId={FIXTURE_RUN_ID} def={def} state={state} yaml={run.yaml} />
    </MemoryRouter>,
  )
}

describe('RunRail', () => {
  it('lists Summary, every job in scheduling order, and the run details', () => {
    at(`/hello/hello/runs/${FIXTURE_RUN_ID}`)
    const rail = screen.getByRole('navigation', { name: 'Run' })
    expect(within(rail).getByTestId('rail-summary')).toHaveAttribute('aria-current', 'page')
    // Job rows only (no item rows: the matrix group starts collapsed) — topo order, ids sorted within a layer.
    const jobs = within(rail).getAllByTestId('rail-job').filter((el) => !el.hasAttribute('data-index')).map((el) => el.getAttribute('data-job'))
    expect(jobs).toEqual(['greet', 'flaky', 'slow', 'confirm'])
    expect(within(rail).getByRole('link', { name: 'Past runs' })).toHaveAttribute('href', '/hello/hello/runs')
    expect(within(rail).getByRole('link', { name: 'Workflow file' })).toHaveAttribute('href', '/hello/hello/file')
    expect(within(rail).getByTestId('rail-back')).toHaveAttribute('href', '/hello/hello')
  })

  it('shows a matrix job as a group with its fraction, collapsed until opened or current', () => {
    at(`/hello/hello/runs/${FIXTURE_RUN_ID}`)
    const rail = screen.getByRole('navigation', { name: 'Run' })
    const group = within(rail).getByTestId('rail-matrix')
    expect(group).toHaveTextContent('2 of 2')
    expect(within(rail).getAllByTestId('rail-job').every((el) => !el.hasAttribute('data-index'))).toBe(true)
    fireEvent.click(within(group).getByRole('button', { name: /show items/i }))
    const items = within(rail).getAllByTestId('rail-job').filter((el) => el.hasAttribute('data-index'))
    expect(items.map((el) => el.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('who: world'), expect.stringContaining('who: studio')]))
    expect(items[1]).toHaveAttribute('href', `/hello/hello/runs/${FIXTURE_RUN_ID}/job/greet/1`)
  })

  it('opens the group and marks the item current on an item route', () => {
    at(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/greet/1`)
    const rail = screen.getByRole('navigation', { name: 'Run' })
    const current = within(rail).getAllByTestId('rail-job').find((el) => el.getAttribute('aria-current') === 'page')
    expect(current).toHaveAttribute('data-job', 'greet')
    expect(current).toHaveAttribute('data-index', '1')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/workflow && pnpm test:run src/lib/runner/jobs.test.ts src/components/run/RunRail.test.tsx`
Expected: FAIL — `./jobs` missing; the stub rail has no rows.

- [ ] **Step 3: Implement `jobs.ts`**

```ts
// apps/workflow/src/lib/runner/jobs.ts
/**
 * Pure job-level readings of a run (spec 2026-09-08): what the rail, the job
 * head and the graph node all print, in one place so they cannot disagree.
 */
import { matrixItemLabel } from '../../components/graph/geometry'
import type { Definition, RunState, Step, StepKey, StepState, StepStatus } from './types'
import { stepKey } from './types'

export function jobStatus(steps: StepState[]): StepStatus {
  if (steps.some((s) => s.status === 'failed')) return 'failed'
  if (steps.some((s) => s.status === 'cancelled')) return 'cancelled'
  if (steps.some((s) => s.status === 'waiting')) return 'waiting'
  if (steps.some((s) => s.status === 'running' || s.status === 'polling')) return 'running'
  if (steps.length > 0 && steps.every((s) => s.status === 'succeeded' || s.status === 'skipped')) {
    return steps.every((s) => s.status === 'skipped') ? 'skipped' : 'succeeded'
  }
  return 'queued'
}

export function jobDuration(steps: StepState[]): number | undefined {
  const started = steps.filter((s) => s.startedAt !== undefined)
  if (started.length === 0 || started.some((s) => s.finishedAt === undefined)) return undefined
  const start = Math.min(...started.map((s) => s.startedAt!))
  const end = Math.max(...started.map((s) => s.finishedAt!))
  return end - start
}

export function itemTotal(state: RunState, job: string): number {
  return state.expansions[job]?.total ?? 1
}

/** `who: world` — how one matrix item names itself (moved from `JobCard`). */
export function itemLabel(item: Record<string, unknown>, index: number): string {
  const bindings = Object.entries(item).map(([name, value]) => `${name}: ${matrixItemLabel(value, index)}`)
  return bindings.length > 0 ? bindings.join(', ') : `Item ${index + 1}`
}

export interface JobStepRow { key: StepKey; step: Step; index: number; state: StepState | undefined }

export function stepsOfJob(def: Definition, state: RunState, job: string, index?: number): JobStepRow[] {
  const decl = def.jobs[job]
  if (!decl) return []
  const items = index === undefined ? Array.from({ length: itemTotal(state, job) }, (_, i) => i) : [index]
  return items.flatMap((i) =>
    decl.steps.map((step) => {
      const key = stepKey(job, i, step.id)
      return { key, step, index: i, state: state.steps[key] }
    }),
  )
}
```

Note `geometry.ts` must not import `jobs.ts` (cycle): `matrixItemLabel` stays in geometry; `itemLabel` moves here and `JobCard` imports it from here.

- [ ] **Step 4: Implement `RunRail`**

```tsx
// apps/workflow/src/components/run/RunRail.tsx
/**
 * The run's rail (spec 2026-09-08 §The run rail): in place of the
 * implementation tree while inside a run — a way back to the workflow,
 * Summary, one row per job (a matrix job a group of its items), then the run
 * details. Every row is a NavLink, so a click is a person's navigation.
 */
import { useState } from 'react'
import { Link, NavLink, useMatch } from 'react-router-dom'
import { formatDuration } from '../../lib/duration'
import { jobOrder } from '../../lib/runner/graph'
import { itemLabel, itemTotal, jobDuration, jobStatus, stepsOfJob } from '../../lib/runner/jobs'
import type { Definition, RunState } from '../../lib/runner/types'
import { jobPath, runPath } from '../../lib/runRoutes'
import { StatusGlyph } from '../StatusPill'
import { jobLabel } from '../graph/geometry'

export interface RunRailProps {
  base: string
  runId: string
  def: Definition | null
  state: RunState | null
  yaml?: string
}

export function RunRail({ base, runId, def, state, yaml }: RunRailProps) {
  // Rendered by the layout, so `useParams` would not see the job route's params (Global Constraints).
  const currentJob = useMatch('/:impl/:workflow/runs/:runId/job/:job/:index?')?.params.job
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const isOpen = (job: string) => opened.has(job) || currentJob === job
  const toggle = (job: string) =>
    setOpened((prev) => {
      const next = new Set(prev)
      if (next.has(job) || currentJob === job) next.delete(job)
      else next.add(job)
      return next
    })

  return (
    <nav className="rail run-rail" aria-label="Run">
      <Link className="rail-back" data-testid="rail-back" to={base}>← Workflow</Link>
      <NavLink className="rail-row rail-summary" data-testid="rail-summary" to={runPath(base, runId)} end>
        {state && <StatusGlyph status={state.status} />}
        <span className="rail-row-name">Summary</span>
      </NavLink>

      {def && state && (
        <>
          <p className="rail-eyebrow">Jobs</p>
          <ul className="rail-jobs">
            {jobOrder(def).map((job) => {
              const decl = def.jobs[job]!
              const rows = stepsOfJob(def, state, job)
              const states = rows.flatMap((r) => (r.state ? [r.state] : []))
              const duration = jobDuration(states)
              if (decl.matrix === undefined) {
                return (
                  <li key={job}>
                    <NavLink className="rail-row rail-job" data-testid="rail-job" data-job={job} to={jobPath(base, runId, job)} end>
                      <StatusGlyph status={jobStatus(states)} />
                      <span className="rail-row-name">{jobLabel(decl)}</span>
                      {duration !== undefined && <span className="rail-row-meta">{formatDuration(duration)}</span>}
                    </NavLink>
                  </li>
                )
              }
              const total = itemTotal(state, job)
              const done = Array.from({ length: total }).filter((_, i) =>
                stepsOfJob(def, state, job, i).every((r) => r.state && ['succeeded', 'failed', 'skipped', 'cancelled'].includes(r.state.status)),
              ).length
              const open = isOpen(job)
              return (
                <li key={job}>
                  <div className="rail-matrix" data-testid="rail-matrix" data-job={job}>
                    <NavLink className="rail-row rail-job" data-testid="rail-job" data-job={job} to={jobPath(base, runId, job)} end>
                      <StatusGlyph status={jobStatus(states)} />
                      <span className="rail-row-name">{jobLabel(decl)}</span>
                      <span className="rail-row-meta">{done} of {total}</span>
                    </NavLink>
                    <button type="button" className="rail-chevron" aria-expanded={open} aria-label={open ? 'Hide items' : 'Show items'} onClick={() => toggle(job)}>
                      {open ? '▾' : '▸'}
                    </button>
                  </div>
                  {open && (
                    <ul className="rail-items">
                      {Array.from({ length: total }, (_, i) => {
                        const item = state.expansions[job]?.items[i] ?? {}
                        const itemStates = stepsOfJob(def, state, job, i).flatMap((r) => (r.state ? [r.state] : []))
                        return (
                          <li key={i}>
                            <NavLink className="rail-row rail-job rail-item" data-testid="rail-job" data-job={job} data-index={i} to={jobPath(base, runId, job, i)} end>
                              <StatusGlyph status={jobStatus(itemStates)} />
                              <span className="rail-row-name">{itemLabel(item, i)}</span>
                            </NavLink>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}

      <p className="rail-eyebrow">Run details</p>
      <ul className="rail-details">
        <li><Link className="rail-row" to={`${base}/runs`}>Past runs</Link></li>
        <li><Link className="rail-row" to={`${base}/file`} state={{ yaml, runId }}>Workflow file</Link></li>
      </ul>
    </nav>
  )
}
```

`NavLink` sets `aria-current="page"` on the active row by itself; `.active` is the class it adds — reuse the `.rail-workflow.active` look.

CSS (append after `.rail-workflow.active { … }` in `index.css`):

```css
/* The run rail (spec 2026-09-08): the same rows as the implementation tree,
   one level of the run each. */
.run-rail .rail-back { display: block; margin: 0 0 14px 8px; color: var(--ink-mute); font-family: var(--font-mono); font-size: 11.5px; text-decoration: none; }
.run-rail .rail-back:hover { color: var(--ink); }
.rail-jobs, .rail-items, .rail-details { margin: 0; padding: 0; list-style: none; }
.rail-items { margin: 2px 0 6px; padding-left: 18px; }
.rail-row { display: flex; align-items: center; gap: 9px; min-height: 32px; padding: 5px 10px; color: var(--ink-soft); font-size: 13px; text-decoration: none; border-radius: var(--radius-control); transition: background-color var(--fast) var(--ease-out), color var(--fast) var(--ease-out); }
.rail-row .glyph { flex: none; width: 11px; height: 11px; font-size: 7px; }
.rail-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-row-meta { flex: none; color: var(--ink-mute); font-family: var(--font-mono); font-size: 11px; }
.rail-row:hover { color: var(--ink); background-color: var(--surface-dim); }
.rail-row.active { color: var(--ink); font-weight: 600; background-color: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
.rail-summary { margin-bottom: 14px; }
.rail-matrix { display: flex; align-items: center; }
.rail-matrix .rail-row { flex: 1; }
.rail-chevron { flex: none; width: 24px; height: 24px; padding: 0; color: var(--ink-mute); font: inherit; background: transparent; border: 0; border-radius: var(--radius-control); cursor: pointer; }
.rail-chevron:hover { color: var(--ink); background-color: var(--surface-dim); }
.run-rail .rail-eyebrow { margin-top: 18px; }
```

Update `JobPane.tsx` to import `jobStatus` and build `rows` with `stepsOfJob(def, state, job)`; delete its private `jobStatus`. Update `JobCard.tsx` to import `itemLabel` from `../../lib/runner/jobs` and delete its private one.

- [ ] **Step 5: Run the tests, lint, build**

Run: `cd apps/workflow && pnpm test:run src/lib/runner/jobs.test.ts src/components/run/RunRail.test.tsx src/components/run/JobPane.test.tsx src/components/graph && pnpm lint && pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/workflow/src/lib/runner/jobs.ts apps/workflow/src/lib/runner/jobs.test.ts apps/workflow/src/components/run/RunRail.tsx apps/workflow/src/components/run/RunRail.test.tsx apps/workflow/src/components/run/JobPane.tsx apps/workflow/src/components/graph/JobCard.tsx apps/workflow/src/index.css
git commit -m "feat(workflow): the run rail — Summary, jobs (matrix items as a group), run details"
```

### Task 5: Migrate the run page suites to the routes

The nine `RunPage.*.test.tsx` files keep their assertions; what changes is *where* the DOM is after a click. Do this mechanically, file by file, running each after its edit.

**Files:**
- Move: `src/pages/RunPage.test.tsx` → `src/pages/run/RunShell.summary.test.tsx` (the header/outputs/summary/annotations/delete/fork/degraded cases) and `src/pages/run/JobPage.interim.test.tsx` (the step-pane cases: input origins, renderers, form `with`, attempt details, yaml)
- Move + rename each of `RunPage.{follow,headless,live,resume,selection,trust,yaml}.test.tsx` → `src/pages/run/RunShell.<same>.test.tsx`
- Modify: `src/test/helloHarness.ts` (no change needed), `src/mocks/fixtures/*` (none)

**Rules for the edit (apply to every file):**

1. Imports: `'../App'` → `'../../App'`, `'../routes'` → `'../../routes'`, `'../mocks/…'` → `'../../mocks/…'`, `'../test/…'` → `'../../test/…'`, `'../store…'` → `'../../store…'`, `'../lib/…'` → `'../../lib/…'`.
2. **Opening a step**: a chip click on the Summary now navigates to the job page. Keep `fireEvent.click(chip(key))` where the test starts on the Summary; the assertions that follow find `step-pane` inside `page` as before. Where a test then asserts on the **chip** (`aria-pressed`, `chip(key)` non-null after selection), replace with a URL/route assertion: render with a `createMemoryRouter` (as `RunPage.selection.test.tsx` already does) and assert `router.state.location.pathname` / `.search`. Example, from the "replaces the run card with the step pane on a chip click; Back climbs to the job, then the run" case:

```tsx
fireEvent.click(chip(page, 'slow/0/start')!)
expect(router.state.location.pathname).toBe(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/slow/0`)
expect(router.state.location.search).toBe('?step=slow%2F0%2Fstart')
fireEvent.click(within(page).getByTestId('step-pane-back'))   // the pane's job crumb
expect(router.state.location.search).toBe('')
expect(within(page).getByTestId('job-pane')).toBeInTheDocument()
fireEvent.click(within(within(page).getByTestId('job-pane')).getByRole('button', { name: 'Run' }))
expect(router.state.location.pathname).toBe(`/hello/hello/runs/${FIXTURE_RUN_ID}`)
```

3. **Deep links**: `?step=<key>` on the run URL still works (redirect) — the "opens the step a `?step=` deep link names" case passes unchanged; add one assertion that the location was replaced (`router.state.location.pathname` ends with `/job/<job>/<i>`).
4. **Edge dots**: "opens the job card on Output from the right dot" — the `?tab=Output` lands on the job page; assert the `job-pane`'s selected tab as before.
5. **Follow tests**: `write(null, true)` now navigates to the Summary; assertions of "returns to the run card" (`run-pane` present) hold. The "pins on a chip click" case: after the click the page is the job page — the `run-follow` toggle in the header reads `off` as before.
6. **Headless/backstage tests**: unchanged logic; the backstage container is rendered by the shell, `island-backstage` is still under `main`.
7. **Selection test** (`resets a selection made on one run when navigating to another`): the first run's selection is a route now, so `router.navigate('/hello/hello/runs/<runB>')` lands on run B's **Summary** and its waiting form auto-opens by navigating to its job page; the assertions (`approved` checkbox, `Finish`) hold.

- [ ] **Step 1: Move the files with `git mv`, fix imports, run the whole run suite**

Run: `cd apps/workflow && pnpm test:run src/pages/run`
Expected: a handful of failures, each one of the categories above.

- [ ] **Step 2: Apply the rules until green**

Run: `cd apps/workflow && pnpm test:run && pnpm lint && pnpm build`
Expected: PASS, no skipped tests, no deleted assertions (a case that no longer applies — the chip's `aria-pressed` after selection — is rewritten as a route assertion, never removed).

- [ ] **Step 3: Commit**

```bash
git add -A apps/workflow/src/pages
git commit -m "test(workflow): run page suites follow the run to its new routes"
```

### Task 6: Readers of `?step=` outside the run page, and the interim docs

**Files:**
- Modify: `apps/workflow/src/pages/RunsPage.tsx:81` (the "waiting on" link)
- Modify: `apps/workflow/src/components/AnnotationList.tsx` (keep the button; the shell's `select` navigates — no change needed; update the header comment: "The jump navigates to the step's job page")
- Modify: `apps/workflow/src/pages/RunsPage.test.tsx` (the link assertion)
- Modify: `apps/workflow/docs/spec/08-harness-ui.md` (§Routes table: add the two job routes; §Run page sections item 3: "the selection is the route" and the redirect rule)

- [ ] **Step 1: Failing test**

In `RunsPage.test.tsx`, find the case asserting the waiting link (`?step=`), and change the expectation to the job page URL:

```tsx
expect(link).toHaveAttribute('href', `/hello/hello/runs/${runId}/job/confirm/0?step=confirm%2F0%2Freview`)
```

Run: `cd apps/workflow && pnpm test:run src/pages/RunsPage.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement**

In `RunsPage.tsx` import `stepPath` from `../lib/runRoutes` and replace the `to` with `stepPath(base, run.runId, first.key)`.

- [ ] **Step 3: Docs**

In `08-harness-ui.md` §Routes add rows for `/<impl>/<workflow>/runs/<runId>/job/<job>` and `/…/job/<job>/<index>`; in §Run page sections item 3 replace "the selection is the URL: `?step=` absent (run), a bare job id (job), or `<job>/<index>/<step>` (step)" with "the selection is the **route**: the Summary, `/job/<job>[/<index>]` (job), and `?step=<key>` on a job route (step); an old `?step=` on the Summary URL redirects (replace) to where it lives now". Leave the rest for Phase 3's rewrite.

- [ ] **Step 4: Run, commit, open PR 1**

Run: `cd apps/workflow && pnpm test:run && pnpm lint && pnpm build`
Expected: PASS.

```bash
git add apps/workflow/src/pages/RunsPage.tsx apps/workflow/src/pages/RunsPage.test.tsx apps/workflow/src/components/AnnotationList.tsx apps/workflow/docs/spec/08-harness-ui.md
git commit -m "feat(workflow): Past runs and annotation jumps link to the job page; 08 names the routes"
git push -u origin HEAD
gh pr create --base epic/run-page-github-shape --title "feat(workflow): run routes, RunShell and the run rail (1/5)" --body "$(cat <<'EOF'
Phase 1 of docs/superpowers/plans/2026-09-08-workflow-run-page-github-shape.md.

- `/runs/:runId` is the Summary; `/job/:job[/:index]` the job page; `?step=` expands a step on it; old `?step=` links on the Summary redirect.
- `RunShell` layout route owns the data path, `window.__workflow`, follow/pinned, backstage, fullscreen; the run rail replaces the implementation tree.
- Pages are the existing panes re-homed — nothing visible changes but the rail and the URLs.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Read the automated review pass before merging (Global Constraints).

---

# Phase 2 — Jobs-only graph and the Summary (PR 2)

### Task 7: Geometry for a jobs-only node

**Files:**
- Modify: `apps/workflow/src/components/graph/geometry.ts`
- Test: `apps/workflow/src/components/graph/geometry.test.ts` (create)

**Interfaces:**
- `CARD` gains `status: 42` (the run-mode status line) and `out: 20` (a definition-mode `OUT` line), keeps `strip`, `note`, `border`; `select` is deleted.
- `declaredJobOutputs(job: Job): Array<[name: string, type: string]>` — the job's `outputs:` names with the type of the step output each alias resolves to (`resolveOutput(def, { kind: 'job', job }, name).decl.type` needs `def`; so the signature is `declaredJobOutputs(def: Definition, job: string)`), `json` when unresolvable.
- `cardHeight(def: Definition, job: string, mode): number` — **new signature** (needs `def` for the outputs): `CARD.strip + (matrixNote ? CARD.note : 0) + (mode === 'run' ? CARD.status : CARD.status + outputs * CARD.out + (outputs ? CHIP.outPad : 0)) + CARD.border`. Definition mode's status line shows the step count (`3 steps`) in the status slot.
- `chipHeight`, `declaredOutputs` stay (PR 5's declared rows use them); `hasSelector` is deleted.

- [ ] **Step 1: Failing test**

```ts
// apps/workflow/src/components/graph/geometry.test.ts
import { describe, expect, it } from 'vitest'
import { hello } from '../../test/helloHarness'
import { CARD, CHIP, cardHeight, declaredJobOutputs } from './geometry'

describe('geometry — jobs-only nodes', () => {
  it('gives every run-mode job one strip and one status line, plus the matrix note', () => {
    expect(cardHeight(hello, 'slow', 'run')).toBe(CARD.strip + CARD.status + CARD.border)
    expect(cardHeight(hello, 'greet', 'run')).toBe(CARD.strip + CARD.note + CARD.status + CARD.border)
  })
  it('adds one OUT line per declared job output in definition mode', () => {
    expect(declaredJobOutputs(hello, 'slow')).toEqual([['report', 'markdown'], ['poster', 'file']])
    expect(cardHeight(hello, 'slow', 'definition')).toBe(CARD.strip + CARD.status + 2 * CARD.out + CHIP.outPad + CARD.border)
    expect(cardHeight(hello, 'flaky', 'definition')).toBe(CARD.strip + CARD.status + CARD.border)
  })
})
```

Run: `cd apps/workflow && pnpm test:run src/components/graph/geometry.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement** per the Interfaces block. `declaredJobOutputs`:

```ts
import { resolveOutput } from '../../lib/outputDecls'
export function declaredJobOutputs(def: Definition, job: string): Array<[string, string]> {
  const decl = def.jobs[job]
  if (!decl) return []
  return Object.keys(decl.outputs ?? {}).map((name) => {
    const type = resolveOutput(def, { kind: 'job', job }, name).decl.type
    return [name, typeof type === 'string' ? type : 'json']
  })
}
```

Update every `cardHeight(def.jobs[job]!, mode, state)` call in `GraphView.tsx` to `cardHeight(def, job, mode)`.

- [ ] **Step 3: Run, commit**

Run: `cd apps/workflow && pnpm test:run src/components/graph/geometry.test.ts && pnpm build`
Expected: PASS (GraphView tests may fail on chips — Task 8 fixes them).

```bash
git add apps/workflow/src/components/graph/geometry.ts apps/workflow/src/components/graph/geometry.test.ts apps/workflow/src/components/graph/GraphView.tsx
git commit -m "feat(workflow): graph geometry for jobs-only nodes"
```

### Task 8: `JobCard` becomes a job node; `flow` at job granularity

**Files:**
- Modify: `apps/workflow/src/components/graph/JobCard.tsx`, `apps/workflow/src/components/graph/flow.ts`, `apps/workflow/src/components/graph/GraphView.tsx`
- Modify tests: `JobCard.test.tsx`, `GraphView.test.tsx`, `GraphView.memo.test.tsx`, `flow.test.ts`
- CSS: `.job-card` block — replace `.job-steps`/`.job-items` with `.job-status` and `.job-outs`

**Interfaces:**
- `JobCardProps` becomes `{ job: Job; def: Definition; col; row; mode; state?; selected?: boolean; onPick: (job: string, side?: 'Input'|'Output') => void; flow?: GraphFlow; style? }`. The whole card is one `<button class="job-card" data-testid="job" data-job aria-pressed data-flow>`; inside: `.job-head` (name + fraction for a matrix job), `.job-note`, then `.job-status` (`StatusGlyph` + status word or `N of M done` + mono duration) in run mode, or `.job-status` (`N steps`) + `.job-outs` (`OUT name · type` lines) in definition mode.
- `GraphFlow` gains `targetJobs: ReadonlySet<string>` (every matching edge's `to.job`) and always fills `sourceJobs` with the hovered `job`; it **keeps** `sourceSteps` / `targetSteps` — the graph reads the job sets, the job page's step rows (Task 12) read the step sets.
- `GraphView`: `onSelect?: (job: string, side?: PaneSide) => void`; `selectedJob?: string | null`; the definition-mode `declared` panel shows `def.jobs[job].raw` (Decision 10) under the heading `<job id>`; the `StepChip` import goes.

- [ ] **Step 1: Rewrite the graph tests first**

In `GraphView.test.tsx` replace the chip cases with:

```tsx
it('draws one node per job with its status and duration in run mode', () => {
  renderRun()   // the file's existing run-mode render of the finished hello fixture (keep it)
  const slow = document.querySelector('[data-testid="job"][data-job="slow"]')!
  expect(slow).toHaveTextContent('Succeeded')
  expect(document.querySelectorAll('[data-testid="step"]')).toHaveLength(0)
})
it('shows a matrix job as one node with its fraction and note', () => {
  renderRun()
  const greet = document.querySelector('[data-testid="job"][data-job="greet"]')!
  expect(greet).toHaveTextContent('For each who · max 2 at once')
  expect(greet).toHaveTextContent('2 of 2 done')
})
it('reports the clicked job to its owner, with the side an edge dot asked for', () => {
  const onSelect = vi.fn()
  renderRun({ onSelect })
  fireEvent.click(document.querySelector('[data-testid="job"][data-job="slow"]')!)
  expect(onSelect).toHaveBeenCalledWith('slow', undefined)
  fireEvent.click(screen.getByRole('button', { name: 'Output of A slow server job' }))
  expect(onSelect).toHaveBeenCalledWith('slow', 'Output')
})
it('lists a job’s declared outputs with their types in definition mode, and opens its declaration on click', () => {
  renderDefinition()
  const slow = document.querySelector('[data-testid="job"][data-job="slow"]')!
  expect(slow).toHaveTextContent('report')
  expect(slow).toHaveTextContent('markdown')
  fireEvent.click(slow)
  expect(screen.getByTestId('step-declaration')).toHaveTextContent('"needs": "greet"')
})
it('marks the target jobs and the source job when a value is hovered', () => {
  // dispatch valueHovered({ job: 'greet', output: 'lines' }) as the existing hover test does
  expect(document.querySelector('[data-job="greet"]')).toHaveAttribute('data-flow', 'source')
  expect(document.querySelector('[data-job="slow"]')).toHaveAttribute('data-flow', 'target')
})
```

Delete the matrix item selector cases (`switches a matrix job to another item`, `shows the matrix item its owner has selected`) — the selector is gone by design (Decision: items live in the rail); the `data-flow` clear case stays. In `JobCard.test.tsx` keep the `matrixItemLabel` cases (they test `geometry`) and delete the `[object Object]` selector case. In `flow.test.ts` assert `targetJobs` instead of `targetSteps`.

Run: `cd apps/workflow && pnpm test:run src/components/graph` — Expected: FAIL.

- [ ] **Step 2: Implement `JobCard`**

```tsx
export function JobCard({ job, def, col, row, mode, state, selected, onPick, flow, style }: JobCardProps) {
  const rows = state ? stepsOfJob(def, state, job.id) : []
  const states = rows.flatMap((r) => (r.state ? [r.state] : []))
  const status = jobStatus(states)
  const duration = jobDuration(states)
  const isMatrix = job.matrix !== undefined
  const total = state ? itemTotal(state, job.id) : 1
  const done = state
    ? Array.from({ length: total }).filter((_, i) => stepsOfJob(def, state, job.id, i).every((r) => r.state && TERMINAL.has(r.state.status))).length
    : 0
  const jobFlow = flow?.sourceJobs.has(job.id) ? 'source' : flow?.targetJobs.has(job.id) ? 'target' : undefined
  const note = matrixNote(job)
  const outs = mode === 'definition' ? declaredJobOutputs(def, job.id) : []

  return (
    <button
      type="button"
      className="job-card"
      data-testid="job"
      data-job={job.id}
      data-col={col}
      data-row={row}
      data-flow={jobFlow}
      data-state={mode === 'run' ? status : 'declared'}
      aria-pressed={selected ?? false}
      aria-label={`Job ${jobLabel(job)}`}
      style={style}
      onClick={() => onPick(job.id)}
    >
      <span className="job-head">
        {isMatrix && <span className="job-eyebrow">Matrix · {job.id}</span>}
        <span className="job-name">{jobLabel(job)}</span>
      </span>
      {note && <span className="job-note">{note}</span>}
      <span className="job-status">
        {mode === 'run' ? (
          <>
            <StatusGlyph status={status} />
            <span className="job-status-word">{isMatrix && state ? `${done} of ${total} done` : STATUS_LABEL[status]}</span>
            {duration !== undefined && <span className="job-meta">{formatDuration(duration)}</span>}
          </>
        ) : (
          <span className="job-status-word">{pluralize(job.steps.length, 'step')}</span>
        )}
      </span>
      {outs.length > 0 && (
        <span className="job-outs">
          {outs.map(([name, type]) => (
            <span className="step-output" key={name}>
              <span className="out-tag" aria-hidden="true">out</span>
              <span className="out-name">{name}</span>
              <span className="out-type">{type}</span>
            </span>
          ))}
        </span>
      )}
    </button>
  )
}
```

`STATUS_LABEL` is `StatusPill.tsx`'s private `LABELS` map — export it: `export const STATUS_LABEL = LABELS` (and export the `Status` type).

The edge dots stay in `GraphView`, unchanged, calling `onSelect(job, side)`. `pick`/`pickJob` collapse into one `pickJob(job, side?)`: run mode → `onSelect?.(job, side)`; definition mode → `setDeclared({ job })` and render `def.jobs[job]!.raw` in the panel (`data-testid="step-declaration"` kept for the e2e/live locators; rename in PR 5).

- [ ] **Step 3: Delete `StepChip` from the graph**

Remove the `StepChip` import and `job-steps` block from `JobCard`; keep `StepChip.tsx` and its test on disk for Task 13 (the row head reuses its markup) — mark the file header `// Only the row head (Task 13) uses this now`.

- [ ] **Step 4: CSS**

Replace the `.job-steps` / `.job-items` rules with:

```css
.job-card { /* now a button */ padding: 0; text-align: left; font: inherit; color: var(--ink); cursor: pointer; }
.job-card[aria-pressed='true'] { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
.job-card[data-flow='target'] { outline: 1px dashed var(--ink); outline-offset: 1px; }
.job-head { display: flex; flex-direction: column; justify-content: center; height: 39px; padding: 0 13px; background-color: var(--surface-dim); border-bottom: 1px solid var(--line); }
.job-eyebrow { color: var(--ink-mute); font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; }
.job-status { display: flex; align-items: center; gap: 9px; height: 42px; padding: 0 13px; font-size: 13px; }   /* CARD.status */
.job-status-word { flex: 1; }
.job-meta { color: var(--ink-mute); font-family: var(--font-mono); font-size: 11px; }
.job-outs { display: flex; flex-direction: column; padding: 0 13px 8px; }   /* CHIP.outPad */
.job-outs .step-output { height: 20px; }                                     /* CARD.out */
```

(Keep the existing `.step-output`, `.out-tag`, `.out-name`, `.out-type` rules.)

- [ ] **Step 5: Run, lint, build, commit**

Run: `cd apps/workflow && pnpm test:run src/components/graph src/pages/run && pnpm lint && pnpm build`
Expected: PASS. The `RunShell.summary` cases that clicked a chip on the Summary now need a node click + a rail/row click — update them: `fireEvent.click(node('slow'))` then, on the job page, `fireEvent.click(within(page).getByRole('button', { name: /A slow server job/ }))` on the `job-pane-step` row.

```bash
git add -A apps/workflow/src/components/graph apps/workflow/src/index.css apps/workflow/src/pages/run apps/workflow/src/components/StatusPill.tsx
git commit -m "feat(workflow): the graph draws jobs only — one node per job, data-flow by job"
```

### Task 9: Summary page: Annotations panel and per-job summaries

**Files:**
- Create: `apps/workflow/src/components/run/AnnotationsPanel.tsx` (+ `.test.tsx`), `apps/workflow/src/components/run/JobSummaries.tsx` (+ `.test.tsx`)
- Modify: `apps/workflow/src/components/run/RunPane.tsx` (Output: `RunOutputs` → `AnnotationsPanel` → `JobSummaries`), `apps/workflow/src/pages/run/RunSummaryPage.tsx` (pass `base`/`runId`)
- Delete: `apps/workflow/src/components/run/RunSummary.tsx`, `apps/workflow/src/components/AnnotationList.tsx` (its cases move to `AnnotationsPanel.test.tsx`)

**Interfaces:**
- `AnnotationsPanel({ annotations, base, runId })` — `<details class="annotations-panel" data-testid="annotations" open={hasError}>`, `<summary>` "Annotations · 1 warning, 2 notices" (or "No annotations"), the list as today with each step annotation's key rendered as a `<Link to={stepPath(base, runId, key)}>`.
- `JobSummaries({ def, state, base, runId })` — `section.run-summary[data-testid="run-summary"]`; for each job in `jobOrder(def)` and each item, a `<article class="summary-entry" data-job data-index>` headed by `<h4><Link to={jobPath(...)}>{label} summary</Link></h4>` (matrix: `{label} ({itemLabel}) summary`) holding that item's step summaries in declaration order as `MarkdownView`s; none anywhere → `<p class="note">No step wrote a summary.</p>`.

- [ ] **Step 1: Failing tests**

```tsx
// JobSummaries.test.tsx
it('groups step summaries by job in scheduling order, each heading linking to the job', () => {
  render(<MemoryRouter><JobSummaries def={def} state={state} base="/hello/hello" runId={FIXTURE_RUN_ID} /></MemoryRouter>)
  const entries = screen.getAllByRole('article')
  expect(entries.map((e) => e.getAttribute('data-job'))).toEqual(['greet', 'greet'])   // only greet writes summaries in the fixture
  expect(within(entries[1]!).getByRole('link')).toHaveAttribute('href', `/hello/hello/runs/${FIXTURE_RUN_ID}/job/greet/1`)
  expect(within(entries[1]!).getByRole('heading')).toHaveTextContent('Greet each name (who: studio) summary')
  expect(entries[1]).toHaveTextContent('Hello, studio!')
})
// AnnotationsPanel.test.tsx
it('sums the counts in its summary line and links each step annotation to its step', () => {
  render(<MemoryRouter><AnnotationsPanel annotations={annotations} base="/hello/hello" runId={FIXTURE_RUN_ID} /></MemoryRouter>)
  expect(screen.getByRole('group')).not.toHaveAttribute('open')       // notices + warnings only
  expect(screen.getByText(/Annotations · 1 warning, 1 notice/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'flaky/0/after' })).toHaveAttribute('href', `/hello/hello/runs/${FIXTURE_RUN_ID}/job/flaky/0?step=flaky%2F0%2Fafter`)
})
it('opens by itself when any annotation is an error', () => { /* pass one { level: 'error' } */ expect(details).toHaveAttribute('open') })
```

(`annotations` = `collectAnnotations(state)` — export `collectAnnotations` from `RunShell.tsx` into `src/lib/runner/annotations.ts` in this task so tests can import it.)

Run: `cd apps/workflow && pnpm test:run src/components/run/JobSummaries.test.tsx src/components/run/AnnotationsPanel.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement** both components per the Interfaces; `RunPane` Output becomes:

```tsx
<RunOutputs def={def} state={state} impl={impl} />
<div className="pane-trail">
  <AnnotationsPanel annotations={annotations} base={base} runId={state.runId} />
  <JobSummaries def={def} state={state} base={base} runId={state.runId} />
</div>
```

`RunPaneProps` gains `base: string` and loses `onJump`. `RunSummaryPage` passes `base={ctx.base}`.

CSS: `.annotations-panel > summary { cursor: pointer; font-weight: 600; font-size: 15px; margin: 24px 0 10px; }`; `.summary-entry h4 a { color: inherit; text-decoration: none; } .summary-entry h4 a:hover { text-decoration: underline; }`.

- [ ] **Step 3: Migrate the old cases** — `RunShell.summary.test.tsx`'s "concatenates the step summaries in job order" → assert the grouped headings; "jumps to the step an annotation came from" → click the link and assert the route. `hello.spec.ts` (e2e) asserts `getByTestId('annotations').getByText(/boom failed with TEAPOT/)` — the panel is closed by default; add `await page.getByTestId('annotations').locator('summary').click()` before it.

- [ ] **Step 4: Run, lint, build, commit**

Run: `cd apps/workflow && pnpm test:run && pnpm lint && pnpm build`
Expected: PASS.

```bash
git add -A apps/workflow/src/components apps/workflow/src/pages/run apps/workflow/src/lib/runner/annotations.ts apps/workflow/src/index.css apps/workflow/e2e/hello.spec.ts
git commit -m "feat(workflow): the Summary's Output — outputs, an Annotations panel, per-job summaries"
```

### Task 10: The workflow page and the e2e locators for a jobs-only definition graph

**Files:**
- Modify: `apps/workflow/src/pages/WorkflowPage.tsx` (no code change needed — `GraphView mode="definition"` now draws jobs; verify), `apps/workflow/src/pages/WorkflowPage.test.tsx` (chip assertions → node assertions)
- Modify: `apps/workflow/e2e/hello.spec.ts:13`, `e2e/interactive.spec.ts:21` — `getByTestId('step').first()` → `getByTestId('job').first()`
- Modify: `packages/workflow-live/src/walks/m1.ts:22`, `hello.ts`, `interactive.ts` — the same definition-graph wait
- Modify: `apps/workflow/docs/spec/08-harness-ui.md` §The graph — rewrite to the jobs-only description (nodes = jobs; run-mode status line; matrix eyebrow + `N of M done`; definition-mode `OUT` lines; hover by job); `DESIGN.md` §Graph bullet accordingly.

- [ ] **Step 1: Update tests and locators, run the unit suite and the e2e smoke**

Run: `cd apps/workflow && pnpm test:run && pnpm lint && pnpm build && pnpm --filter @bffless/workflow-headless build && pnpm test:e2e`
Expected: PASS. (`interactive.spec.ts` still clicks `[data-testid="step"]` on the run page for `pick/0/choose` — that waits on the job page after follow navigates there; if the wait fails because the page is the Summary, the spec is on the wrong page: replace that locator with a wait on `window.__workflow.steps['pick/0/choose'] === 'waiting'` via `page.waitForFunction` now, ahead of Task 16's helper.)

- [ ] **Step 2: Commit and open PR 2**

```bash
git add -A apps/workflow packages/workflow-live/src/walks
git commit -m "feat(workflow): definition graph draws jobs; locators and 08 follow"
git push -u origin HEAD
gh pr create --base epic/run-page-github-shape --title "feat(workflow): jobs-only graph and the Summary's per-job summaries (2/5)" --body "Phase 2 of the run-page plan: one node per job in both modes, data-flow by job, Annotations panel + per-job summary sections on the Summary. 🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

# Phase 3 — The job page and step rows (PR 3)

### Task 11: `StepBody` — the step pane without its head

**Files:**
- Create: `apps/workflow/src/components/run/StepBody.tsx` (from `StepPane.tsx`)
- Delete: `apps/workflow/src/components/run/StepPane.tsx` (after Task 12 switches the interim `JobPage`; until then both exist)
- Test: `apps/workflow/src/components/run/StepBody.test.tsx` — `git mv StepPane.test.tsx StepBody.test.tsx`, then every `render(<StepPane …/>)` → `render(<StepBody …/>)`; the cases stay.

**Interfaces:**
- `StepBodyProps = { def; state; stepKey; live: boolean; initialTab?: Tab; source?: YamlSource; impl?: string; onClose?: () => void }` — no `onBack`/`onRun` (no crumbs). Renders `<div class="step-body" data-testid="step-pane" aria-label="Step">` with `.step-toolbar` (the `segmented` tabs, `RawToggle`, `YamlControl`, `StatusPill`, `.pane-kind`) and `.pane-body` exactly as `StepPane` renders them; Esc inside calls `onClose`. The live `form`/`island` branches render `FormStepPane`/`IslandStepPane` with `trail={[]}`.

- [ ] **Step 1: Move the test, run it to see it fail on the import**

Run: `cd apps/workflow && git mv src/components/run/StepPane.test.tsx src/components/run/StepBody.test.tsx && sed -i 's/StepPane/StepBody/g' src/components/run/StepBody.test.tsx && pnpm test:run src/components/run/StepBody.test.tsx`
Expected: FAIL — `./StepBody` missing.

- [ ] **Step 2: Implement** — copy `StepPane.tsx` to `StepBody.tsx`; rename the component and props; delete the `PaneCrumbs`/`h3`/`pane-key` markup and the `onBack`/`onRun` props; the `<aside className="step-pane" …>` becomes `<div className="step-body" data-testid="step-pane" aria-label="Step" onKeyDown={onKeyDown}>`, its `<header className="pane-head">` becomes `<div className="step-toolbar">`; the "no record" branch keeps the note. Esc → `onClose?.()`.

- [ ] **Step 3: Run, commit**

Run: `cd apps/workflow && pnpm test:run src/components/run/StepBody.test.tsx && pnpm lint`
Expected: PASS.

```bash
git add -A apps/workflow/src/components/run
git commit -m "refactor(workflow): StepBody — the step pane's body without the card head"
```

### Task 12: `StepRow`, `JobHead`, `JobIo`, and the real `JobPage`

**Files:**
- Create: `apps/workflow/src/components/run/StepRow.tsx` (+ `.test.tsx`), `JobHead.tsx`, `JobIo.tsx`
- Rewrite: `apps/workflow/src/pages/run/JobPage.tsx` (+ `JobPage.test.tsx`, replacing `JobPage.interim.test.tsx`)
- Delete: `apps/workflow/src/components/run/StepPane.tsx`, `JobPane.tsx` (+ `JobPane.test.tsx` — its three fork cases move to `JobPage.test.tsx`), `PaneCrumbs.tsx` (still used by `FormStepPane`/`IslandStepPane` for their own head — keep it; only the run/job/step crumbs go), `graph/StepChip.tsx` (+ test; its `headless` badge cases move to `StepRow.test.tsx`)
- CSS: new `.job-page`, `.job-head`, `.job-io`, `.step-list`, `.step-row`, `.step-row-head`, `.item-list` blocks; retire `.step-chip` rules by renaming them `.step-row-head`

**Interfaces:**
- `StepRow({ def, state, row: JobStepRow, open: boolean, onToggle: () => void, live, impl?, source?, initialTab?, mode?: 'run' | 'declared' })` — `<li class="step-row" data-open>` holding `<button class="step-row-head" data-testid="step" data-key data-state aria-expanded aria-controls>` (glyph · `.step-label` (title + id) · `.step-kind-word` · `attempt n` badge when `> 1` · `.step-meta` duration or status word · chevron), then `<StepBody>` while `open`. A row with no `state` (`queued`, not reached) has `disabled` on its chevron and never opens. `data-state` = `row.state?.status ?? 'queued'` in run mode, `'declared'` in declared mode (PR 5).
- `JobHead({ def, state, job, index?, onFork?, source })` — `<header class="job-head" data-testid="job-head">`: eyebrow `RUN › JOB` (`RUN › JOB › ITEM` with an index), `h2` label, `.pane-key` id, `StatusPill`, duration, `matrixNote`, item note `item i+1 of N` + the item's `itemLabel`; actions: `job-fork` button when `onFork`, `YamlControl` (`target={{ job }}`).
- `JobIo({ def, state, job, index?, impl, initialTab?, open? })` — `<details class="job-io" data-testid="job-io" open={open}>` with `<summary>Job inputs and outputs</summary>` and today's `JobPane` body: Input = `needs` (plus, with an index, the item's `matrix.<var>` values first), Output = declared outputs evaluated — with an index, element `[index]` of each collected list (spec §The job page).
- `JobPage` reads `useRunContext()`, `useParams().job/index`, `?step=`, `?tab=`; three variants:
  - **plain / item**: `JobHead` → `JobIo` → `<ul class="step-list" data-testid="job-steps">` of `StepRow`s from `stepsOfJob(def, state, job, index ?? 0)`;
  - **matrix collect** (a matrix job, no index): `JobHead` → `JobIo` (collected) → `<ul class="item-list" data-testid="job-items">` of `<Link>` rows (glyph · `itemLabel` · `item i+1` · duration) to `jobPath(base, runId, job, i)`;
  - a `?step=` naming another job → `<Navigate replace>` (kept from the interim); an undeclared job → `JobHead` fallback + note; an index ≥ total → `<Navigate replace to={jobPath(base, runId, job)}>`.
- Expansion state: `const [open, setOpen] = useState<Set<StepKey>>(() => new Set(step ? [step] : []))`; an effect keyed on `step` adds it (`queueMicrotask` → `setOpen`, per the hooks rule) and scrolls the row into view (`document.getElementById(rowId)?.scrollIntoView({ block: 'nearest' })`, in the effect). `onToggle(key)`: opening → `setOpen(add)` and `ctx.select({ kind: 'step', key })` (push, pins); closing → `setOpen(delete)` and, when `key === step`, `ctx.select({ kind: 'job', job, index })` (push). Esc inside a body → close that row the same way. Rows mid-interaction (live island `running`/`waiting`, form `waiting`) are never closed by the page (only by the person's toggle — and the toggle is still offered).

- [ ] **Step 1: Failing tests**

```tsx
// apps/workflow/src/pages/run/JobPage.test.tsx  (uses the createMemoryRouter helper from RunShell.selection.test.tsx)
describe('JobPage', () => {
  it('lists the job’s steps as rows, closed, with their status and duration', async () => {
    const { page } = await openAt(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/slow/0`)
    const rows = within(page).getAllByTestId('step')
    expect(rows.map((r) => r.getAttribute('data-key'))).toEqual(['slow/0/start'])
    expect(rows[0]).toHaveAttribute('data-state', 'succeeded')
    expect(rows[0]).toHaveAttribute('aria-expanded', 'false')
    expect(within(page).queryByTestId('step-pane')).not.toBeInTheDocument()
  })
  it('expands the row `?step=` names on arrival, and a click writes `?step=` and opens another', async () => {
    const { page, router } = await openAt(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/flaky/0?step=flaky%2F0%2Fboom`)
    expect(within(page).getAllByTestId('step-pane')).toHaveLength(1)
    fireEvent.click(within(page).getByRole('button', { name: /after/ }))
    expect(router.state.location.search).toBe('?step=flaky%2F0%2Fafter')
    expect(within(page).getAllByTestId('step-pane')).toHaveLength(2)          // any number open (Decision 7)
    fireEvent.click(within(page).getByRole('button', { name: /after/ }))     // collapse the one ?step= names
    expect(router.state.location.search).toBe('')
    expect(within(page).getAllByTestId('step-pane')).toHaveLength(1)
  })
  it('shows the collect view for a matrix job: collected outputs and one row per item', async () => {
    const { page } = await openAt(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/greet`)
    expect(within(page).getByTestId('job-items').querySelectorAll('a')).toHaveLength(2)
    fireEvent.click(within(page).getByText('Job inputs and outputs'))
    fireEvent.click(within(page).getByRole('tab', { name: 'Output' }))
    expect(within(page).getByTestId('job-io')).toHaveTextContent('Hello, studio!')
    expect(within(page).queryByTestId('job-steps')).not.toBeInTheDocument()
  })
  it('shows an item’s own bindings and its element of the collected outputs', async () => {
    const { page } = await openAt(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/greet/1`)
    expect(within(page).getByTestId('job-head')).toHaveTextContent('item 2 of 2')
    fireEvent.click(within(page).getByText('Job inputs and outputs'))
    expect(within(page).getByTestId('job-io')).toHaveTextContent('who')
    fireEvent.click(within(page).getByRole('tab', { name: 'Output' }))
    expect(within(page).getByTestId('job-io')).toHaveTextContent('Hello, studio!')
    expect(within(page).getByTestId('job-io')).not.toHaveTextContent('Hello, world!')
  })
  it('opens the job disclosure on the side an edge dot asked for', async () => {
    const { page } = await openAt(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/slow?tab=Output`)
    expect(within(page).getByTestId('job-io')).toHaveAttribute('open')
    expect(within(page).getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true')
  })
  it('redirects a `?step=` of another job to that job', async () => {
    const { router } = await openAt(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/slow/0?step=flaky%2F0%2Fboom`)
    expect(router.state.location.pathname).toBe(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/flaky/0`)
  })
  // + the three fork cases from JobPane.test.tsx, asserting `job-fork` in `job-head`
})
```

```tsx
// StepRow.test.tsx — a live form is the body
it('renders the waiting form inside the open row on the live path, and the tabs on a replay', async () => {
  const { store } = await startHelloAtConfirmWaiting()
  const state = store.getState().run.state!
  render(<Provider store={store}><MemoryRouter><ul><StepRow def={hello} state={state} row={stepsOfJob(hello, state, 'confirm', 0)[0]!} open live onToggle={() => {}} /></ul></MemoryRouter></Provider>)
  expect(screen.getByTestId('form-step')).toBeInTheDocument()
})
it('never opens a step the run has not reached', () => { /* row.state undefined → chevron disabled, click does nothing */ })
it('reads `headless: skip` as a badge in declared mode only', () => { /* from StepChip.test.tsx */ })
```

Run: `cd apps/workflow && pnpm test:run src/pages/run/JobPage.test.tsx src/components/run/StepRow.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement `StepRow`**

```tsx
export function StepRow({ def, state, row, open, onToggle, live, impl, source, initialTab, mode = 'run' }: StepRowProps) {
  const { key, step, index, state: s } = row
  const status = mode === 'run' ? (s?.status ?? 'queued') : 'declared'
  const reachable = mode === 'declared' || s !== undefined
  const label = stepLabel(step)
  const elapsed = s?.startedAt !== undefined && s?.finishedAt !== undefined ? s.finishedAt - s.startedAt : undefined
  const bodyId = `step-body-${key.replace(/[^a-z0-9]/gi, '-')}`
  return (
    <li className="step-row" data-open={open || undefined} id={`row-${bodyId}`}>
      <button
        type="button"
        className="step-row-head"
        data-testid="step"
        data-key={key}
        data-state={status}
        aria-expanded={open}
        aria-controls={bodyId}
        disabled={!reachable}
        onClick={() => reachable && onToggle(key)}
      >
        {mode === 'run' ? <StatusGlyph status={status} /> : <span className="step-kind" aria-hidden="true">{KIND_ICON[step.uses]}</span>}
        <span className="step-label">
          <span className="step-title">{label}</span>
          {label !== step.id && <span className="step-id">{step.id}</span>}
          {mode === 'declared' && headlessMode(step) && <span className="badge">{`headless: ${headlessMode(step)}`}</span>}
        </span>
        <span className="step-kind-word">{step.uses}</span>
        {s && s.attempt > 1 && <span className="badge">attempt {s.attempt}</span>}
        <span className="step-meta">{mode === 'run' ? (elapsed === undefined ? status : formatDuration(elapsed)) : ''}</span>
        <span className="step-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && mode === 'run' && (
        <div id={bodyId} className="step-row-body">
          <StepBody def={def} state={state} stepKey={key} live={live} impl={impl} source={source} initialTab={initialTab} onClose={() => onToggle(key)} />
        </div>
      )}
      {open && mode === 'declared' && (
        <div id={bodyId} className="step-row-body">
          <DeclaredStepBody def={def} job={parseStepKey(key)?.job ?? ''} step={step} />
        </div>
      )}
    </li>
  )
}
```

`StepRowProps` also takes `flow?: GraphFlow` (Task 8's step sets): the head gets `data-flow="source" | "target"` when `flow.sourceSteps` / `flow.targetSteps` has `${job}::${step.id}`; `JobPage` computes `flowFor(def, useAppSelector((s) => s.ui.hoveredValue))` once and passes it to every row, so a hovered output lights up the rows it came from and goes to within the job (spec §The graph). The `JobPage` root is `<section className="job-page" data-testid="job-page" data-job={job}>`.

(`KIND_ICON` and `headlessMode` move from `StepChip.tsx` into `StepRow.tsx`; `DeclaredStepBody` is a PR 5 file — in this PR export a stub `DeclaredStepBody` that renders `<pre className="declaration">{JSON.stringify(step.raw, null, 2)}</pre>` so the `declared` branch compiles; PR 5 fills it.)

`JobIo` is `JobPane`'s body lifted into a `<details>`; with an `index`, Input prepends one `ValueView` per `matrix` binding (`state.expansions[job]?.items[index]`, `decl` inferred via `inferDecl` — move `inferDecl` from `StepBody` into `src/components/values/inferDecl.ts` and import it in both) and Output takes `(outputs?.[name] as unknown[])?.[index] ?? null` for each declared name.

`JobHead` is `JobPane`'s header lifted; keep `data-testid="job-fork"`; `pane-kind` reads `job`, `matrix · N items`, or `item`.

CSS: rename `.step-chip*` selectors to `.step-row-head*` (same rules), plus:

```css
.job-page { display: flex; flex-direction: column; gap: 16px; }
.job-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; padding: 14px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-card); }
.job-io { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-card); }
.job-io > summary { padding: 12px 20px; font-weight: 600; cursor: pointer; }
.step-list, .item-list { margin: 0; padding: 0; list-style: none; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-card); overflow: hidden; }
.step-row + .step-row { border-top: 1px solid var(--hairline); }
.step-row-head { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 42px; padding: 0 16px; }
.step-row-head:disabled { cursor: default; color: var(--ink-faint); }
.step-row[data-open] > .step-row-head { background: var(--surface-dim); }
.step-row-body { border-top: 1px solid var(--hairline); }
.step-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; padding: 10px 20px; border-bottom: 1px solid var(--hairline); }
.step-chevron { margin-left: auto; color: var(--ink-mute); }
.island-fullscreen .step-row[data-open] .step-row-body { position: fixed; inset: 56px 0 0 0; z-index: var(--z-overlay); overflow: auto; background: var(--paper); }
```

- [ ] **Step 3: Run, lint, build; migrate the interim tests**

`JobPage.interim.test.tsx` cases (input origins, renderers, form `with`, attempt details, yaml drawer) move into `JobPage.test.tsx` with `openTab(page, key, tab)` = click the row head, then the tab inside `step-pane`.

Run: `cd apps/workflow && pnpm test:run && pnpm lint && pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A apps/workflow/src
git commit -m "feat(workflow): the job page — job head, job inputs/outputs, step rows that expand in place"
```

### Task 13: Live rows: the waiting form/island inside its row, Expand, Esc, the fullscreen strip

**Files:**
- Modify: `apps/workflow/src/pages/run/RunShell.tsx` (the strip's crumb reads `Run › <job> › <step>` and links up; `fullscreen` holds only while the open island's row is on the current job page), `apps/workflow/src/components/run/IslandStepPane.tsx` (Expand/Exit unchanged; `trail={[]}` renders no crumbs)
- Tests: `RunShell.follow.test.tsx`, `RunShell.headless.test.tsx`, `RunShell.live.test.tsx` — replace `chip(page, key)` clicks with `openRow(page, key)` (click the `step` head) and assert `form-step` / `island-display` inside `step-pane`; add to `RunShell.live.test.tsx`:

```tsx
it('opens the waiting form’s row on its job page while following, and the form is the row body', async () => {
  const { store, runId } = await startHelloAtConfirmWaiting()
  const router = createMemoryRouter(createRoutesFromElements(routes), { initialEntries: [`/hello/hello/runs/${runId}`] })
  render(<Provider store={store}><RouterProvider router={router} /></Provider>)
  const page = screen.getByRole('main')
  await within(page).findByTestId('form-step')
  expect(router.state.location.pathname).toBe(`/hello/hello/runs/${runId}/job/confirm/0`)
  expect(router.state.location.search).toBe('?step=confirm%2F0%2Freview')
  const row = within(page).getByTestId('step')                       // the one row of `confirm`
  expect(row).toHaveAttribute('data-key', 'confirm/0/review')
  expect(row).toHaveAttribute('aria-expanded', 'true')
  expect(within(within(page).getByTestId('step-pane')).getByTestId('form-step')).toBeInTheDocument()
  fireEvent.click(within(page).getByRole('button', { name: 'Finish' }))
  await waitFor(() => expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'succeeded'))
  // Following: a finished run returns to the Summary.
  expect(router.state.location.pathname).toBe(`/hello/hello/runs/${runId}`)
  expect(within(page).getByTestId('run-outputs')).toBeInTheDocument()
})
```

and to `RunShell.headless.test.tsx` (next to the existing "opens the first active island with no selection at all" case, reusing its island harness setup):

```tsx
it('Expand overlays the open island row and the strip names the step; Esc exits', async () => {
  // …the case's existing setup: an `interactive` run held at its island step, rendered through the router…
  fireEvent.click(within(page).getByRole('button', { name: 'Expand' }))
  expect(document.querySelector('.run-canvas.island-fullscreen')).toBeTruthy()
  expect(within(page).getByTestId('island-strip')).toHaveTextContent('pick/0/choose')
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(document.querySelector('.run-canvas.island-fullscreen')).toBeNull()
  expect(within(page).getByTestId('island-display')).toBeInTheDocument()       // same frame, still mounted
})
```

- [ ] **Step 1: Update the tests, run to see the failures, fix `RunShell`/`JobPage` until green**

Run: `cd apps/workflow && pnpm test:run src/pages/run && pnpm lint && pnpm build`
Expected: PASS.

- [ ] **Step 2: Docs** — rewrite `08-harness-ui.md` §Step panes and §Run page sections to the spec's §The job page / §Step rows / §Follow wording; `DESIGN.md` §"The pane under the graph" → "The job page" (job head, job-io, step rows, toolbar).

- [ ] **Step 3: Commit and open PR 3**

```bash
git add -A apps/workflow
git commit -m "feat(workflow): waiting forms and islands live inside their step row; 08 and DESIGN describe the job page"
git push -u origin HEAD
gh pr create --base epic/run-page-github-shape --title "feat(workflow): the job page and step rows (3/5)" --body "Phase 3 of the run-page plan. 🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

# Phase 4 — Follow re-map, the headless contract, the walks (PR 4)

### Task 14: Pin on any navigation the shell did not make; Esc climbs; Follow returns to the Summary

**Files:**
- Modify: `apps/workflow/src/pages/run/RunShell.tsx`
- Test: `apps/workflow/src/pages/run/RunShell.follow.test.tsx` (three new cases)

**Interfaces:** the `pageWrote` ref compares **paths** now: `write()` records `pathForSelection(...)` (path + search) and the effect compares `location.pathname + location.search`; any run-route location change that is not the recorded one pins (rail click, node click, row toggle, Back, typed URL). `onFollowChange(true)` writes `{ kind: 'run' }` with `replace`. Esc on a job page with no open row → `toRun()`; on the Summary → nothing. `ui.selectedStep` = `selectedStep`.

- [ ] **Step 1: Failing tests**

```tsx
/** hello held at its waiting form, rendered through the router, following (the form's row is open on `confirm/0`). */
async function followingAtForm() {
  const { store, runId } = await startHelloAtConfirmWaiting()
  const router = createMemoryRouter(createRoutesFromElements(routes), { initialEntries: [`/hello/hello/runs/${runId}`] })
  render(<Provider store={store}><RouterProvider router={router} /></Provider>)
  const page = screen.getByRole('main')
  await within(page).findByTestId('form-step')
  const toggle = () => within(page).getByTestId('run-follow')
  return { page, router, runId, toggle }
}

it('pins on a rail click', async () => {
  const { toggle } = await followingAtForm()
  expect(toggle()).toHaveAttribute('data-state', 'on')
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Run' })).getByTestId('rail-summary'))
  expect(toggle()).toHaveAttribute('data-state', 'off')
  expect(screen.getByTestId('run-pane')).toBeInTheDocument()            // and nothing moves it back
})

it('pins on the browser’s Back', async () => {
  const { page, router, runId, toggle } = await followingAtForm()
  await act(async () => { await router.navigate(`/hello/hello/runs/${runId}/job/slow/0`) })   // a person's move: pins
  fireEvent.click(toggle())                                                                   // follow on again → Summary, then the form row
  await within(page).findByTestId('form-step')
  expect(toggle()).toHaveAttribute('data-state', 'on')
  await act(async () => { await router.navigate(-1) })                                        // Back: a person's move
  expect(toggle()).toHaveAttribute('data-state', 'off')
})

it('Follow on returns to the Summary, then the waiting step reopens by itself', async () => {
  const { page, router, runId, toggle } = await followingAtForm()
  fireEvent.click(within(page).getByTestId('step'))                       // collapse the form row: pins
  expect(toggle()).toHaveAttribute('data-state', 'off')
  fireEvent.click(toggle())
  await within(page).findByTestId('form-step')
  expect(router.state.location.pathname).toBe(`/hello/hello/runs/${runId}/job/confirm/0`)
})

it('Esc on a job page with nothing open climbs to the Summary', async () => {
  const { page, router, runId } = await followingAtForm()
  fireEvent.click(within(page).getByTestId('step'))
  fireEvent.keyDown(page, { key: 'Escape' })
  expect(router.state.location.pathname).toBe(`/hello/hello/runs/${runId}`)
})
```

Run: `cd apps/workflow && pnpm test:run src/pages/run/RunShell.follow.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement; run the whole suite; commit**

Run: `cd apps/workflow && pnpm test:run && pnpm lint && pnpm build` — Expected: PASS.

```bash
git add -A apps/workflow/src/pages/run
git commit -m "feat(workflow): following is navigation — every route change a person makes pins"
```

### Task 15: The contract moves: helpers for the walks and the e2e specs

**Files:**
- Create: `packages/workflow-live/src/steps.ts`, `apps/workflow/e2e/steps.ts`
- Modify: `packages/workflow-live/src/walks/{m1,hello,interactive}.ts`, `apps/workflow/e2e/{hello,interactive,page-tools}.spec.ts`
- Modify: `apps/workflow/docs/spec/07-headless.md` (the `data-testid` paragraph: `step[data-key][data-state]` lives on the job page's rows; waits go through `window.__workflow.steps`; a step is reached by URL), `08-harness-ui.md` §Headless-visible contract

**Interfaces (both files, identical bodies):**

```ts
import type { Page } from 'playwright'   // e2e: from '@playwright/test'

/** Wait for a step's status off the page contract (07) — the DOM row may be on another page. */
export function waitStepState(page: Page, key: string, want: string, timeout: number) {
  return page.waitForFunction(
    ([k, w]) => (window as unknown as { __workflow?: { steps?: Record<string, string> } }).__workflow?.steps?.[k] === w,
    [key, want] as const,
    { timeout },
  )
}

/** Open a step's row: navigate to its job page with `?step=` (spec 2026-09-08). `runUrl` is the Summary URL. */
export async function openStep(page: Page, runUrl: string, key: string) {
  const [job, index] = key.split('/')
  const url = new URL(runUrl)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/job/${encodeURIComponent(job!)}/${index}`
  url.searchParams.set('step', key)
  await page.goto(url.toString(), { waitUntil: 'networkidle' })
  await page.locator(`[data-testid="step"][data-key="${key}"]`).waitFor()
}
```

- [ ] **Step 1: Replace every `[data-testid="step"]` use from a run page**

In each walk/spec: `waitState(...)` → `waitStepState(page, key, want, timeout)`; `page.locator('[data-testid="step"][data-key="…"]').click()` → `await openStep(page, runUrl, key)` (capture `runUrl = page.url()` right after `run-status` appears, before any follow navigation — or rebuild it from the run id: `${harness}/hello/hello/runs/${runId}`); `page.getByTestId('step-pane')` assertions stay. In `e2e/interactive.spec.ts` the `expect(chooseStep).toHaveAttribute('data-state', 'waiting')` lines become `await waitStepState(page, 'pick/0/choose', 'waiting', 60_000)`; the follow navigation puts the island's row on screen, so `island-display` resolves as before. The definition-graph `getByTestId('job').first()` waits stay (Task 10).

- [ ] **Step 2: Run e2e locally, lint the packages**

Run: `cd apps/workflow && pnpm --filter @bffless/workflow-headless build && pnpm --filter @bffless/workflow-live build && pnpm --filter @bffless/workflow-live lint && pnpm --filter @bffless/workflow-live test:run && pnpm test:e2e`
Expected: PASS.

- [ ] **Step 3: Docs, commit, push, open PR 4**

```bash
git add -A packages/workflow-live apps/workflow/e2e apps/workflow/docs/spec
git commit -m "feat(workflow-live): walks and e2e reach steps by URL and wait on the page contract"
git push -u origin HEAD
gh pr create --base epic/run-page-github-shape --title "feat(workflow): following is navigation; the step contract moves to the job page (4/5)" --body "Phase 4 of the run-page plan. 🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

### Task 16: Live walks against the epic deployment

The `workflow.j5s.dev` harness is deployed from the epic branch for the gate (memory *j5s harness serves the epic branch*): dispatch `deploy-workflow.yml` on `epic/run-page-github-shape` once PR 4 is merged into it, then run the walks with the `apps-live-walk` agent: `hello`, `interactive`, `m1`, `headless`, `page-tools`. Record PASS/FAIL per walk in the master PR body. A FAIL in a walk is a bug in PR 1–4 — fix on a follow-up branch stacked on the epic, never by loosening the walk.

- [ ] **Step 1: Deploy and walk** — `gh workflow run deploy-workflow.yml --ref epic/run-page-github-shape`, wait for it, then the agent runs the five walks.
- [ ] **Step 2: Paste the five verdicts into the master PR body.**

---

# Phase 5 — Definition mode rows, the docs rewrite, the visual pass (PR 5)

### Task 17: Declared rows on the workflow page

**Files:**
- Create: `apps/workflow/src/components/run/DeclaredStepBody.tsx` (replace the stub)
- Modify: `apps/workflow/src/pages/WorkflowPage.tsx`, `apps/workflow/src/components/graph/GraphView.tsx` (remove the `declared` panel and `step-declaration`; definition mode reports `onSelect(job)` like run mode)
- Test: `apps/workflow/src/pages/WorkflowPage.test.tsx`

**Interfaces:**
- `DeclaredStepBody({ def, job, step })` — `.step-body` with two value lists: **Inputs** (`with` entries as `ValueView` with `decl` `{ type: 'string' }` for expressions and inferred otherwise, `origin` from `refsIn`) and **Outputs** (`declaredOutputs(step)` as `OUT name · type` rows), then `<details><summary>Declaration</summary><pre class="declaration" data-testid="step-declaration">…step.raw…</pre></details>`.
- `WorkflowPage` holds `selectedJob: string | null`; under the graph it renders `<section class="job-page">` with `JobHead` (definition variant: no pill/duration; `pane-kind` = `job` / `matrix`) and a `step-list` of `StepRow mode="declared"` rows with local `open` state; `?step=` is not used here.

- [ ] **Step 1: Failing test**

```tsx
it('lists a job’s declared steps under the graph on a node click, and expands one to its declaration', async () => {
  // The file's existing render: <App/> in a MemoryRouter at `/hello/hello` over the MSW mock (discovery + the hello YAML).
  render(<Provider store={makeStore()}><MemoryRouter initialEntries={['/hello/hello']}><App /></MemoryRouter></Provider>)
  await screen.findByTestId('job')
  fireEvent.click(document.querySelector('[data-testid="job"][data-job="slow"]')!)
  const rows = screen.getAllByTestId('step')
  expect(rows[0]).toHaveAttribute('data-state', 'declared')
  fireEvent.click(rows[0]!)
  expect(screen.getByTestId('step-declaration')).toHaveTextContent('"path": "slow"')
  expect(screen.getByText('report')).toBeInTheDocument()   // an OUT row
})
```

Run: `cd apps/workflow && pnpm test:run src/pages/WorkflowPage.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement; update the e2e definition-graph step (`getByTestId('job').first()` stays); run, lint, build; commit**

```bash
git add -A apps/workflow/src
git commit -m "feat(workflow): the workflow page lists a job's declared steps as rows under the jobs-only graph"
```

### Task 18: Docs rewrite and the visual pass

**Files:**
- Modify: `apps/workflow/docs/spec/08-harness-ui.md` (full rewrite of §Routes, §The graph, §Step panes → §The job page, §Run page sections, §Follow or pinned, §Headless-visible contract to the spec's wording), `05-runs-and-persistence.md` §Summaries ("grouped per job on the Summary, each linking to the job page"), `DESIGN.md` §Graph, §The job page, §Layout (run page: header → run bar → graph → run card; job page: rail → job head → job-io → rows), `PRODUCT.md` (no change)
- Visual: `localdev-tools/shot.mjs` against `pnpm --filter workflow dev` with `?mocks=on` — the hello fixture run's Summary, `slow` job page with its row open, `greet` collect view, `greet/1`, and a live hello run parked on its form (mock backend); each shot `consoleErrors:0, failedRequests:0`; attach the PNGs to PR 5.

- [ ] **Step 1: Docs, shots, fix anything the shots show (spacing, wrapping, the rail under 900px)**

Run: `cd /home/rico/bffless/localdev-tools && node shot.mjs 'http://localhost:5173/hello/hello/runs/run_01hellofixture000000000000?mocks=on' --out summary.png --full` (and the four other URLs: `…/job/slow/0?step=slow%2F0%2Fstart`, `…/job/greet`, `…/job/greet/1`, and a live run started from `/hello/hello/run?mocks=on` — `src/mocks/browser.ts` already seeds the finished fixture run).

- [ ] **Step 2: Commit, open PR 5**

```bash
git add -A apps/workflow
git commit -m "docs(workflow): 08, 05 and DESIGN describe the run page in GitHub's shape"
git push -u origin HEAD
gh pr create --base epic/run-page-github-shape --title "feat(workflow): declared rows on the workflow page; docs for the redesign (5/5)" --body "Phase 5 of the run-page plan. Screenshots attached. 🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

### Task 19: Epic → main (the person's)

- [ ] Merge PRs 1–5 into the epic in order (each after its automated review pass is read).
- [ ] Re-run the five live walks on the epic deployment (Task 16) after PR 5.
- [ ] Master PR body gets the release-notes override block (memory *release-please override lives in the PR body*), naming: routes, jobs-only graph, job page, step rows, run rail, the contract move (a **driver-visible change**: `step[data-key]` on the job page), definition rows.
- [ ] The person squash-merges the epic; dispatch `release.yml`; deploy `main` to `workflow.j5s.dev` (overwriting the epic deployment).
- [ ] Remove the worktrees.
