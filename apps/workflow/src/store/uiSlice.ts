/**
 * View state that outlives a render but never leaves the tab (09): which step's
 * pane is open, the Past-runs status filter (client-side in M1, Decision 6),
 * whose runs that list shows (the "All runs" ask, spec 11 D27), and whether the
 * mounted island is inline or filling the page.
 */
import { createSlice } from '@reduxjs/toolkit'
import type { PayloadAction } from '@reduxjs/toolkit'
import { readScope, writeScope } from '../lib/scope'
import type { RunsScope } from '../lib/scope'
import type { RunStatus, StepKey } from '../lib/runner/types'

export interface UiState {
  /** A read-model of the run page's `?step=` (08) — written by RunShell, never the source of the selection. */
  selectedStep: StepKey | null
  runsStatusFilter: RunStatus | 'all'
  /**
   * Whose runs Past runs shows (spec 11 D27): the caller's own until an
   * owner/admin turns the "All runs" toggle on. A **mirror** of
   * `lib/scope.ts`'s `localStorage` value, not the source of truth — the ask
   * has to ride requests built outside React (`http.ts`,
   * `fetchBaseQuery`'s `prepareHeaders`), and this copy exists so the checkbox
   * re-renders when it changes.
   */
  runsScope: RunsScope
  /**
   * The mounted island's display mode (04): `inline` on every open, then
   * whatever the person's Expand / Exit or the island's own
   * `ui/request-display-mode` moved it to. It is view state, not run state: a
   * reload comes back inline, and a declared `display: fullscreen` only ever
   * *offers* the overlay — it never opens in it (apps#432).
   */
  islandDisplay: 'inline' | 'fullscreen'
  /**
   * The value under the pointer, so the graph can highlight where it came
   * from and where it goes (08, Task 22). `step` absent means a job-level
   * `outputs` alias — no one step declares it, so the whole job stands in.
   */
  hoveredValue: { job: string; step?: string; output?: string } | null
  /**
   * Whether the run page's selection **follows** the run (apps#452): tracks the
   * step the run is at, as it always did, until the person picks a step — a
   * chip, a crumb, Esc, a `?step=` they typed or stepped Back to — at which
   * point it is **pinned** and moves only when they move it. Keyed by the run
   * it was decided for: step keys repeat across runs of one workflow, and the
   * page never remounts on a run-to-run navigation, so an entry for another
   * run is simply not this run's answer (the page then derives one from the
   * URL). `null` until a page has decided anything.
   */
  follow: { runId: string; on: boolean } | null
}

/**
 * A lazy initializer, not a constant: `runsScope` is read from `localStorage`
 * (the ask outlives the tab), and a constant would freeze whatever storage
 * happened to hold when this module was first imported.
 */
const initialState = (): UiState => ({
  selectedStep: null,
  runsStatusFilter: 'all',
  runsScope: readScope(),
  islandDisplay: 'inline',
  hoveredValue: null,
  follow: null,
})

export const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    stepSelected(state, action: PayloadAction<StepKey | null>) {
      state.selectedStep = action.payload
    },
    runsStatusFilterChanged(state, action: PayloadAction<RunStatus | 'all'>) {
      state.runsStatusFilter = action.payload
    },
    /**
     * The "All runs" toggle (spec 11 D27). The write to `localStorage` is a
     * side effect in a reducer, which is normally a rule worth keeping — it is
     * tolerated here because the value has to be readable **synchronously** by
     * `lib/http.ts` and `prepareHeaders` on the very next request, and a
     * listener/middleware would land a tick later, after the refetch this
     * change triggers has already built its headers. The effect is idempotent
     * and derived purely from the payload, so a replayed action cannot mean
     * anything different from the first one.
     */
    runsScopeChanged(state, action: PayloadAction<RunsScope>) {
      state.runsScope = action.payload
      writeScope(action.payload)
    },
    islandDisplayChanged(state, action: PayloadAction<'inline' | 'fullscreen'>) {
      state.islandDisplay = action.payload
    },
    valueHovered(state, action: PayloadAction<UiState['hoveredValue']>) {
      state.hoveredValue = action.payload
    },
    followChanged(state, action: PayloadAction<{ runId: string; on: boolean }>) {
      state.follow = action.payload
    },
  },
})

export const {
  stepSelected,
  runsStatusFilterChanged,
  runsScopeChanged,
  islandDisplayChanged,
  valueHovered,
  followChanged,
} = uiSlice.actions
