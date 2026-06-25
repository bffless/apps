/**
 * The Handoff app's durable business state. Persisted to localStorage via
 * redux-persist (see `./index.ts`) so state survives hard reloads. Feature
 * slices #7+ will extend this with folder/file state.
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

interface HandoffState {
  // Placeholder — slices #7+ add fields here.
  _version: number
  /**
   * Active share-link session: when a visitor opens /s/<token> and the token
   * is valid, this is set to the folder id the link grants access to.
   * Used to build the Viewer object ({ shareLinkFolderId }) passed to evaluateAccess.
   * Cleared when null.
   */
  shareLinkFolderId: string | null
}

const initialState: HandoffState = {
  _version: 1,
  shareLinkFolderId: null,
}

const handoffSlice = createSlice({
  name: 'handoff',
  initialState,
  reducers: {
    setShareLinkFolderId(state, action: PayloadAction<string | null>) {
      state.shareLinkFolderId = action.payload
    },
  },
})

export const { setShareLinkFolderId } = handoffSlice.actions
export default handoffSlice.reducer
