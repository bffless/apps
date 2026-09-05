/** Typed Redux hooks — use these instead of the untyped `react-redux` ones. */
import { useDispatch, useSelector, useStore } from 'react-redux'
import type { AppDispatch, AppStore, RootState } from './index'

export const useAppDispatch = useDispatch.withTypes<AppDispatch>()
export const useAppSelector = useSelector.withTypes<RootState>()
/**
 * The store itself, for reading state at a moment a *selector* cannot name —
 * the outcome of an async dispatch, right after it resolves (`RunPage.tsx`'s
 * `?resume=1`). Not a substitute for `useAppSelector`: a read through this
 * does not subscribe, so anything rendered from it would not re-render when it
 * changed.
 */
export const useAppStore = useStore.withTypes<AppStore>()
