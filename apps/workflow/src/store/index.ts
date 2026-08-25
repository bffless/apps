/**
 * The store: the RTK Query cache, the live run, and view state (09). Nothing is
 * persisted client-side — a run's record lives on the server (05), written
 * through the runner middleware (Task 17) as the run progresses, so a reload
 * rebuilds from rows rather than from localStorage.
 */
import { configureStore } from '@reduxjs/toolkit'
import { createIslandHost } from '../islands/IslandHost'
import { httpJsonWithReauth } from '../lib/http'
import { createRunStore } from '../lib/runStore'
import { createScriptHost } from '../scripts/ScriptHost'
import { createRegisterFile, createRunnerMiddleware, realClock } from './runnerMiddleware'
import type { RunnerDeps } from './runnerMiddleware'
import { runSlice } from './runSlice'
import { uiSlice } from './uiSlice'
import { workflowApi } from './workflowApi'

/** The app's real `RunnerDeps` — fresh per store so tests can inject fakes instead. */
export function defaultRunnerDeps(): RunnerDeps {
  return {
    http: httpJsonWithReauth,
    clock: realClock,
    runStore: createRunStore(httpJsonWithReauth),
    registerFile: createRegisterFile(httpJsonWithReauth),
    islandHost: createIslandHost,
    scriptHost: createScriptHost,
  }
}

/** A fresh store; tests use one per case so no RTK Query cache leaks between them. */
export function makeStore(deps: RunnerDeps = defaultRunnerDeps()) {
  return configureStore({
    reducer: {
      [workflowApi.reducerPath]: workflowApi.reducer,
      run: runSlice.reducer,
      ui: uiSlice.reducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware()
        .prepend(createRunnerMiddleware(deps))
        .concat(workflowApi.middleware),
  })
}

export const store = makeStore()

export type AppStore = ReturnType<typeof makeStore>
export type RootState = ReturnType<AppStore['getState']>
export type AppDispatch = AppStore['dispatch']
/** The shape of the run lifecycle thunks (kickoff, resume, cancel — Phase 3). */
export type AppThunk<R = void> = (dispatch: AppDispatch, getState: () => RootState) => R
