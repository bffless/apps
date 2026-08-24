/**
 * View state that outlives a render but never leaves the tab (09): which step's
 * pane is open, the Past-runs status filter (client-side in M1, Decision 6),
 * and whether the mounted island is inline or filling the page.
 */
import { createSlice } from '@reduxjs/toolkit'
import type { PayloadAction } from '@reduxjs/toolkit'
import type { RunStatus, StepKey } from '../lib/runner/types'

export interface UiState {
  selectedStep: StepKey | null
  runsStatusFilter: RunStatus | 'all'
  /**
   * The display mode the mounted island last asked for through
   * `ui/request-display-mode` (04). It is view state, not run state: a reload
   * comes back inline, and no island is ever *told* to be fullscreen — it asks.
   */
  islandDisplay: 'inline' | 'fullscreen'
}

const initialState: UiState = {
  selectedStep: null,
  runsStatusFilter: 'all',
  islandDisplay: 'inline',
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
  },
})

export const { stepSelected, runsStatusFilterChanged, islandDisplayChanged } = uiSlice.actions
