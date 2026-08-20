/**
 * The store: the RTK Query cache, the live run, and view state (09). Nothing is
 * persisted — a run's record lives on the server (05), so a reload rebuilds from
 * rows rather than from localStorage.
 */
import { configureStore } from '@reduxjs/toolkit'
import { runSlice } from './runSlice'
import { uiSlice } from './uiSlice'
import { workflowApi } from './workflowApi'

/** A fresh store; tests use one per case so no RTK Query cache leaks between them. */
export function makeStore() {
  return configureStore({
    reducer: {
      [workflowApi.reducerPath]: workflowApi.reducer,
      run: runSlice.reducer,
      ui: uiSlice.reducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(workflowApi.middleware),
  })
}

export const store = makeStore()

export type AppStore = ReturnType<typeof makeStore>
export type RootState = ReturnType<AppStore['getState']>
export type AppDispatch = AppStore['dispatch']
/** The shape of the run lifecycle thunks (kickoff, resume, cancel — Phase 3). */
export type AppThunk<R = void> = (dispatch: AppDispatch, getState: () => RootState) => R
