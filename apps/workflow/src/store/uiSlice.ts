/**
 * View state that outlives a render but never leaves the tab (09): which step's
 * pane is open, the Past-runs status filter (client-side in M1, Decision 6),
 * and whether the mounted island is inline or filling the page.
 */
import { createSlice } from '@reduxjs/toolkit'
import type { PayloadAction } from '@reduxjs/toolkit'
import type { RunStatus, StepKey } from '../lib/runner/types'

export interface UiState {
  /** A read-model of the run page's `?step=` (08) — written by RunPage, never the source of the selection. */
  selectedStep: StepKey | null
  runsStatusFilter: RunStatus | 'all'
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

const initialState: UiState = {
  selectedStep: null,
  runsStatusFilter: 'all',
  islandDisplay: 'inline',
  hoveredValue: null,
  follow: null,
}

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
  islandDisplayChanged,
  valueHovered,
  followChanged,
} = uiSlice.actions
