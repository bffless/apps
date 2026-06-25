/**
 * ShareLinkEntry — handles /s/:token (no-account view).
 *
 * Validates the token against the backend (public endpoint, no auth required).
 * On success, sets the share-session (shareLinkFolderId) in the Redux store and
 * navigates to /folder/:folderId in share mode.
 * On failure, renders a clean "link no longer valid" page.
 *
 * The folder view rendered after navigation uses evaluateAccess with
 * { shareLinkFolderId } as the viewer — yielding at most 'view', scoped to
 * the link's folder and its descendants (same logic used everywhere).
 */

import { useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useDispatch } from 'react-redux'
import { useClaimShareLinkMutation } from '../store/handoffApi'
import { setShareLinkFolderId } from '../store/handoffSlice'
import type { AppDispatch } from '../store'

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <div className="flex min-h-svh items-center justify-center">
      <svg className="h-8 w-8 animate-spin text-gray-400" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// InvalidLink — shared "link no longer valid" UI
// ---------------------------------------------------------------------------

function InvalidLink() {
  return (
    <div className="flex min-h-svh items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <div className="mb-4 flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-7 w-7 text-gray-400">
              <path fillRule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z" clipRule="evenodd" />
            </svg>
          </div>
        </div>
        <h1 className="mb-2 text-lg font-semibold text-gray-900">This link is no longer valid</h1>
        <p className="text-sm text-gray-500">
          The share link may have expired or been revoked by the owner.
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ShareLinkEntry
// ---------------------------------------------------------------------------

export function ShareLinkEntry() {
  const { token = '' } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const dispatch = useDispatch<AppDispatch>()

  // Claim validates the token AND sets the signed hf_s view cookie the
  // server-side ACL gate requires (ADR-0002) — so a logged-out visitor can
  // actually load the shared folder's gated content, not just navigate to it.
  const [claim, { data, isLoading, isError }] = useClaimShareLinkMutation()

  useEffect(() => {
    if (token) claim(token)
  }, [token, claim])

  useEffect(() => {
    if (!data) return
    if (data.valid && data.folderId) {
      dispatch(setShareLinkFolderId(data.folderId))
      navigate(`/folder/${data.folderId}`, { replace: true })
    }
  }, [data, dispatch, navigate])

  if (!token || isError) {
    return <InvalidLink />
  }

  if (isLoading) {
    return <Spinner />
  }

  // data available but not yet navigated (valid=false)
  if (data && !data.valid) {
    return <InvalidLink />
  }

  // Valid — waiting for navigation effect
  return <Spinner />
}
