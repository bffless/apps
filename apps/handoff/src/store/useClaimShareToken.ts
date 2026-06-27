/**
 * Claim a share token and, on success, set the share-link folder in the store.
 * Shared by ShareLinkEntry (/s/:token → navigate to folder) and HandoffViewer
 * (/view/:id?token= → load the file). Mirrors the original ShareLinkEntry logic.
 */
import { useCallback } from 'react'
import { useDispatch } from 'react-redux'
import { useClaimShareLinkMutation } from './handoffApi'
import { setShareLinkFolderId } from './handoffSlice'
import type { AppDispatch } from '.'

export function useClaimShareToken() {
  const dispatch = useDispatch<AppDispatch>()
  const [claim, state] = useClaimShareLinkMutation()

  const run = useCallback(
    async (token: string) => {
      const res = await claim(token)
      if ('data' in res && res.data?.valid && res.data.folderId) {
        dispatch(setShareLinkFolderId(res.data.folderId))
      }
      return res
    },
    [claim, dispatch],
  )

  return { run, data: state.data, isLoading: state.isLoading, isError: state.isError }
}
