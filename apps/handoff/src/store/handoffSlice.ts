/**
 * The Handoff app's durable business state. Persisted to localStorage via
 * redux-persist (see `./index.ts`) so state survives hard reloads. Feature
 * slices #7+ will extend this with folder/file state.
 */

import { createSlice } from '@reduxjs/toolkit'

interface HandoffState {
  // Placeholder — slices #7+ add fields here.
  _version: number
}

const initialState: HandoffState = {
  _version: 1,
}

const handoffSlice = createSlice({
  name: 'handoff',
  initialState,
  reducers: {},
})

export default handoffSlice.reducer
