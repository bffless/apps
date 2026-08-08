/**
 * The Redux store. The `studio` slice is wrapped in redux-persist so its state
 * is mirrored to localStorage and rehydrated on load — that's what lets a hard
 * reload resume mid-pipeline. The RTK Query `studioApi` cache is intentionally
 * NOT persisted (it's transient request state).
 */

import { configureStore, combineReducers } from '@reduxjs/toolkit'
import {
  persistStore,
  persistReducer,
  createMigrate,
  FLUSH,
  REHYDRATE,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
  type WebStorage,
} from 'redux-persist'
import studioReducer from './studioSlice'
import { studioApi } from './studioApi'
import { projectMetaSync } from './projectMetaSync'

/**
 * A localStorage-backed redux-persist storage, defined inline rather than
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
  typeof window !== 'undefined' && window.localStorage
    ? {
        getItem: (key) => Promise.resolve(window.localStorage.getItem(key)),
        setItem: (key, value) => Promise.resolve(window.localStorage.setItem(key, value)),
        removeItem: (key) => Promise.resolve(window.localStorage.removeItem(key)),
      }
    : noopStorage

/**
 * v2 — the cut-first pivot (ADR-0003). Old projects carry the narration era:
 * a project `voice`/`cast`/`speakerAssignments`, a root `savedVoices` library,
 * and per-scene narration (`refined.segments`, `narrationSeconds`, `voicing`).
 * Cuts and scene windows map 1:1 onto the new model, so the migration is pure
 * deletion — every project opens in the cut editor with its cut work intact.
 * Written against the raw persisted shape (not current types), hence the loose
 * record casts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const drop = (obj: Record<string, any>, keys: string[]) => {
  const out = { ...obj }
  for (const k of keys) delete out[k]
  return out
}

const migrations = {
  2: (state: any) => {
    if (!state) return state
    const rest = drop(state, ['savedVoices'])
    const working = Object.fromEntries(
      Object.entries(rest.working ?? {}).map(([id, w]: [string, any]) => {
        const keep = drop(w ?? {}, ['voice', 'cast', 'speakerAssignments'])
        keep.scenes = (keep.scenes ?? []).map((sc: any) => {
          const scene = drop(sc ?? {}, ['narrationSeconds', 'voicing'])
          if (scene.refined) scene.refined = { cuts: scene.refined.cuts ?? [], source: scene.refined.source ?? 'ai' }
          return scene
        })
        return [id, keep]
      }),
    )
    return { ...rest, working }
  },
  // v3 — parallel auto build (story 03u): the run's single pointer
  // (`currentSceneId`/`currentStepId`) becomes the `active` set, and the string
  // `error` becomes the structured `halt`. A rehydrated run is never actually
  // executing (the orchestrator coerces `running` → `paused`), so `active`
  // migrates to empty; a persisted halt keeps its subject so the board still
  // points at the failing step.
  3: (state: any) => {
    if (!state) return state
    const working = Object.fromEntries(
      Object.entries(state.working ?? {}).map(([id, w]: [string, any]) => {
        const run = w?.autoBuild ?? {}
        const halt =
          run.status === 'halted'
            ? {
                sceneId: run.currentSceneId ?? null,
                stepId: run.currentStepId ?? 'assemble',
                message: run.error ?? 'Halted',
              }
            : null
        return [id, { ...w, autoBuild: { status: run.status ?? 'idle', active: [], halt } }]
      }),
    )
    return { ...state, working }
  },
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const persistConfig = {
  key: 'studio-projects', // new key → clean slate; old `studio` localStorage is ignored
  version: 3,
  storage,
  migrate: createMigrate(migrations, { debug: false }),
}

const rootReducer = combineReducers({
  studio: persistReducer(persistConfig, studioReducer),
  [studioApi.reducerPath]: studioApi.reducer,
})

export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        // redux-persist dispatches these non-serializable lifecycle actions.
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }).concat(projectMetaSync, studioApi.middleware),
})

export const persistor = persistStore(store)

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
