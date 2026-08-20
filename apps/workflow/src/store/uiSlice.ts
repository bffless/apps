/**
 * View state that outlives a render but never leaves the tab (09): which step's
 * pane is open, and the Past-runs status filter (client-side in M1, Decision 6).
 */
import { createSlice } from '@reduxjs/toolkit'
import type { PayloadAction } from '@reduxjs/toolkit'
import type { RunStatus, StepKey } from '../lib/runner/types'

export interface UiState {
  selectedStep: StepKey | null
  runsStatusFilter: RunStatus | 'all'
}

const initialState: UiState = { selectedStep: null, runsStatusFilter: 'all' }

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
  },
})

export const { stepSelected, runsStatusFilterChanged } = uiSlice.actions
