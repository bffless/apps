/**
 * The Redux store. Unlike Studio, Recall keeps its server state in RTK Query
 * (`recallApi`) and any transient UI state local to components — there's no
 * durable client-side business state to persist, so there's no redux-persist
 * here.
 */

import { configureStore } from '@reduxjs/toolkit'
import { recallApi } from './recallApi'

export const store = configureStore({
  reducer: {
    [recallApi.reducerPath]: recallApi.reducer,
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(recallApi.middleware),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
