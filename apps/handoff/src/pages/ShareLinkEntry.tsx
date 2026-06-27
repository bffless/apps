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
import { useClaimShareToken } from '../store/useClaimShareToken'
import { InvalidLink } from '../components/InvalidLink'

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-bg">
      <svg className="h-8 w-8 animate-spin text-muted" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ShareLinkEntry
// ---------------------------------------------------------------------------

export function ShareLinkEntry() {
  const { token = '' } = useParams<{ token: string }>()
  const navigate = useNavigate()

  // Claim validates the token AND sets the signed hf_s view cookie the
  // server-side ACL gate requires (ADR-0002), then sets shareLinkFolderId.
  const { run, data, isLoading, isError } = useClaimShareToken()

  useEffect(() => {
    if (token) void run(token)
  }, [token, run])

  useEffect(() => {
    if (data?.valid && data.folderId) {
      navigate(`/folder/${data.folderId}`, { replace: true })
    }
  }, [data, navigate])

  if (!token || isError) return <InvalidLink />
  if (isLoading) return <Spinner />
  if (data && !data.valid) return <InvalidLink />
  return <Spinner />
}
