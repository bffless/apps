/**
 * The Redux store. The `handoff` slice is wrapped in redux-persist so its state
 * is mirrored to **sessionStorage** and rehydrated on load. The RTK Query
 * `handoffApi` cache is intentionally NOT persisted (it's transient request
 * state).
 *
 * sessionStorage (not localStorage) is deliberate: the only persisted field is
 * `shareLinkFolderId`, an ephemeral share-visit session. sessionStorage scopes
 * it to the tab and auto-clears on tab close, so opening a `/s/:token` link in
 * one tab can't leak share-mode into another tab or persist indefinitely — it
 * still survives a reload within the same tab (guest share UX). NOTE: if a
 * future field added to this slice is meant to be *durable* across tabs/restart,
 * split it into its own localStorage-backed persist rather than widening this one.
 */

import { configureStore, combineReducers } from '@reduxjs/toolkit'
import {
  persistStore,
  persistReducer,
  FLUSH,
  REHYDRATE,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
  type WebStorage,
} from 'redux-persist'
import handoffReducer from './handoffSlice'
import { handoffApi } from './handoffApi'

/**
 * A sessionStorage-backed redux-persist storage, defined inline rather than
 * imported from `redux-persist/lib/storage`. That package is CJS and, under
 * Vite's ESM interop, its default export can resolve to a module namespace
 * (so `storage.getItem` is undefined → "storage.getItem is not a function").
 * Implementing the tiny async interface here avoids the interop entirely and
 * stays SSR/non-browser safe via a noop fallback.
 */
const noopStorage: WebStorage = {
  getItem: () => Promise.resolve(null),
  setItem: () => Promise.resolve(),
  removeItem: () => Promise.resolve(),
}

const storage: WebStorage =
  typeof window !== 'undefined' && window.sessionStorage
    ? {
        getItem: (key) => Promise.resolve(window.sessionStorage.getItem(key)),
        setItem: (key, value) => Promise.resolve(window.sessionStorage.setItem(key, value)),
        removeItem: (key) => Promise.resolve(window.sessionStorage.removeItem(key)),
      }
    : noopStorage

const persistConfig = {
  key: 'handoff',
  version: 1,
  storage,
}

const rootReducer = combineReducers({
  handoff: persistReducer(persistConfig, handoffReducer),
  [handoffApi.reducerPath]: handoffApi.reducer,
})

export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        // redux-persist dispatches these non-serializable lifecycle actions.
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }).concat(handoffApi.middleware),
})

export const persistor = persistStore(store)

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
