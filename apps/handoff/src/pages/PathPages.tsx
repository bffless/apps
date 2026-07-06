/**
 * Path-URL route components (spec 2026-07-06): GitHub-style /tree/<path> and
 * /blob/<path> pages that resolve the path server-side (GET /api/resolve/*),
 * plus redirects that keep the legacy /folder/:id and /view/:id URLs working.
 * Resolution must be server-side: ACL filtering hides ancestors from nested
 * grantees and share visitors, so a client-side walk cannot see the way down.
 */

import { useEffect } from 'react'
import { useLocation, useParams, useSearchParams, Navigate } from 'react-router-dom'
import { useResolvePathQuery, useGetNodeQuery } from '../store/handoffApi'
import { pathFromPathname, treeUrl, blobUrl, nodeUrl } from '../lib/pathUrl'
import { useSession, adminLoginUrl } from '../lib/session'
import { shouldClaimToken } from '../lib/share'
import { useClaimShareToken } from '../store/useClaimShareToken'
import { FolderView } from './FolderView'
import { ViewerBody } from './HandoffViewer'
import { InvalidLink } from '../components/InvalidLink'

/** Shared error rendering for a failed path resolution. */
function ResolveError({ status }: { status?: number }) {
  if (status === 401) {
    return (
      <div className="container-page py-16 text-center">
        <p className="mb-3 text-sm text-ink">Sign in to view this item</p>
        <button
          type="button"
          onClick={() => {
            window.location.href = adminLoginUrl(window.location.href)
          }}
          className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-700"
        >
          Sign in
        </button>
      </div>
    )
  }
  if (status === 403) {
    return (
      <div className="container-page py-16 text-center text-sm text-danger">
        You don&apos;t have access to this item.
      </div>
    )
  }
  return (
    <div className="container-page py-16 text-center">
      <p className="text-sm text-muted">Nothing found at this path.</p>
    </div>
  )
}

function Loading() {
  return <div className="py-16 text-center text-sm text-muted">Loading…</div>
}

/** /tree/<path> — folder listing at a path. */
export function TreePage() {
  const { pathname } = useLocation()
  const path = pathFromPathname(pathname, '/tree/')
  const { data: node, isLoading, isError, error } = useResolvePathQuery(path, { skip: !path })

  if (!path) return <Navigate to="/" replace />
  if (isLoading) return <Loading />
  if (isError || !node) {
    return <ResolveError status={(error as { status?: number } | undefined)?.status} />
  }
  // Self-heal a type/route mismatch (file URL pasted under /tree/).
  if (node.type !== 'folder') return <Navigate to={nodeUrl(node)} replace />
  return <FolderView folderId={node.id} />
}

/** /blob/<path> — file/site viewer at a path (share-token aware). */
export function BlobPage() {
  const { pathname } = useLocation()
  const path = pathFromPathname(pathname, '/blob/')
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const { session, loading: sessionLoading } = useSession()
  const authed = session?.authenticated === true

  // Claim the share token BEFORE resolving, so the hf_s cookie gates the
  // resolve call for guests (same ordering the viewer uses for its node fetch).
  const needClaim = !sessionLoading && shouldClaimToken({ token, authenticated: authed })
  const { run: claimToken, data: claimData, isError: claimError } = useClaimShareToken()
  const claimSettled = claimData !== undefined || claimError
  const claimPending = needClaim && !claimSettled

  useEffect(() => {
    if (needClaim && token) void claimToken(token)
  }, [needClaim, token, claimToken])

  const { data: node, isLoading, isError, error } = useResolvePathQuery(path, {
    skip: !path || sessionLoading || claimPending || (needClaim && claimData?.valid === false),
  })

  if (!path) return <Navigate to="/" replace />
  if (sessionLoading || claimPending) return <Loading />
  if (needClaim && (claimError || claimData?.valid === false)) return <InvalidLink />
  if (isLoading) return <Loading />
  if (isError || !node) {
    return <ResolveError status={(error as { status?: number } | undefined)?.status} />
  }
  if (node.type === 'folder') return <Navigate to={nodeUrl(node)} replace />
  return <ViewerBody id={node.id} />
}

/** /folder/:id — legacy URL; redirect to the canonical /tree URL. */
export function LegacyFolderRedirect() {
  const { id } = useParams<{ id: string }>()
  const { data: node, isLoading } = useGetNodeQuery(id ?? '', { skip: !id })
  if (!id) return <Navigate to="/" replace />
  if (node?.path != null) return <Navigate to={treeUrl(node.path)} replace />
  if (!isLoading && node === null) {
    return (
      <div className="container-page py-16 text-center">
        <p className="text-sm text-muted">Folder not found.</p>
      </div>
    )
  }
  // Query error (401/403) or path missing: keep the legacy render so ACL error
  // states behave exactly as before.
  if (!isLoading && node && node.path == null) return <FolderView folderId={id} />
  if (!isLoading && !node) return <FolderView folderId={id} />
  return <Loading />
}

/** /view/:id — legacy URL; redirect to the canonical /blob URL. */
export function LegacyViewRedirect() {
  const { id } = useParams<{ id: string }>()
  const { search } = useLocation()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const { session, loading: sessionLoading } = useSession()
  const authed = session?.authenticated === true

  const needClaim = !sessionLoading && shouldClaimToken({ token, authenticated: authed })
  const { run: claimToken, data: claimData, isError: claimError } = useClaimShareToken()
  const claimSettled = claimData !== undefined || claimError
  const claimPending = needClaim && !claimSettled

  useEffect(() => {
    if (needClaim && token) void claimToken(token)
  }, [needClaim, token, claimToken])

  const { data: node, isLoading } = useGetNodeQuery(id ?? '', {
    skip: !id || sessionLoading || claimPending || (needClaim && claimData?.valid === false),
  })

  if (!id) return <Navigate to="/" replace />
  if (sessionLoading || claimPending) return <Loading />
  if (needClaim && (claimError || claimData?.valid === false)) return <InvalidLink />
  // Canonical redirect, preserving the query string (?token=… survives).
  if (node?.path) return <Navigate to={blobUrl(node.path) + search} replace />
  // Fallback: render in place when the path is unavailable.
  if (!isLoading && node) return <ViewerBody id={id} />
  if (!isLoading && !node) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-muted">File not found.</p>
      </div>
    )
  }
  return <Loading />
}
