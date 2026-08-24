/**
 * The run this tab is showing (09, table row 2): the engine's `RunState` in a
 * Redux slice, plus what the UI needs around it — the definition snapshot, and
 * whether we are *driving* the run or only watching a replay of it.
 *
 * The slice owns no run semantics: every transition goes through the pure
 * `runReducer`, so a live run and a resumed one cannot drift. Its one rule is
 * that an event before `run.started` has nothing to fold — that is a scheduling
 * bug elsewhere, and a reducer is the wrong place to throw, so it is ignored.
 */
import { createSlice, current, isDraft } from '@reduxjs/toolkit'
import type { PayloadAction } from '@reduxjs/toolkit'
import { initialRunState, runReducer } from '../lib/runner/reducer'
import type { Definition, RunEvent, RunState } from '../lib/runner/types'

export interface RunMeta {
  def: Definition
  yaml: string
  workflowName: string
  workflowVersion?: string
}

/** `readonly` = replayed rows; another tab holds the lease (05 Resume). */
export type RunMode = 'live' | 'readonly'

export interface RunSliceState {
  meta: RunMeta | null
  state: RunState | null
  mode: RunMode | null
  /** Set when a write failed and the run was parked: the 05 banner's message. */
  paused?: string
}

const initialState: RunSliceState = { meta: null, state: null, mode: null }

/** Immer hands the reducer a draft; the engine is pure and wants plain values. */
function plain(state: RunState): RunState {
  return isDraft(state) ? (current(state) as RunState) : state
}

export const runSlice = createSlice({
  name: 'run',
  initialState,
  reducers: {
    /** The definition snapshot, set before the first event can arrive. */
    runOpened(_state, action: PayloadAction<{ meta: RunMeta }>): RunSliceState {
      return { meta: action.payload.meta, state: null, mode: null }
    },

    runEvent(state, action: PayloadAction<RunEvent>) {
      const event = action.payload
      if (event.type === 'run.started') {
        state.state = initialRunState({
          runId: event.runId,
          impl: event.impl,
          workflow: event.workflow,
          inputs: event.inputs,
          headless: event.headless,
          startedAt: event.at,
        })
        // Only the tab driving the run emits events into the slice.
        state.mode = 'live'
        return
      }
      if (!state.state) return
      state.state = runReducer(plain(state.state as RunState), event)
    },

    /**
     * Adopt a state rebuilt from rows: Resume (`live`) or the read-only view.
     * A replaced run has no driver yet, so any stale persistence-pause banner
     * from the state being replaced must not survive onto it.
     */
    runReplaced(state, action: PayloadAction<{ state: RunState; mode: RunMode }>) {
      state.state = action.payload.state
      state.mode = action.payload.mode
      state.paused = undefined
    },

    runModeChanged(state, action: PayloadAction<RunMode>) {
      state.mode = action.payload
    },

    /** A persistence failure parked the run; `undefined` clears the banner. */
    runPaused(state, action: PayloadAction<string | undefined>) {
      state.paused = action.payload
    },

    runClosed(): RunSliceState {
      return initialState
    },
  },
})

export const { runOpened, runEvent, runReplaced, runModeChanged, runPaused, runClosed } =
  runSlice.actions
