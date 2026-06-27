# Handoff Frictionless File Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "share a file with someone" effortless in handoff: drag a file into a folder, click one "Copy link", and paste a single URL that opens the recipient straight to that file.

**Architecture:** All frontend, no backend changes. A file-direct URL `/view/{fileId}?token={shareToken}` reuses the existing folder-scoped share token; the viewer claims the token (same effect as `/s/{token}`) then loads the file. Pure helpers carry the testable logic (URL formatting, token reuse, claim decision); thin hooks wrap RTK Query for claim and one-click copy; `FolderView` gains drag-and-drop upload, per-file "Copy link", and a post-upload copy prompt.

**Tech Stack:** React 19 + TypeScript + Vite, RTK Query (`store/handoffApi.ts`), Redux slice (`store/handoffSlice.ts`), Vitest (pure-function unit tests only — no component/RTL harness), Tailwind. Validation via MSW mocks + `localdev-tools/` headless Chromium.

## Global Constraints

- **No backend / proxy-rule / schema / `acl.ts` changes.** The token stays folder-scoped; reuse existing hooks `useClaimShareLinkMutation`, `useMintShareLinkMutation`, `useListShareLinksQuery`, `useRevokeShareLinkMutation`, `useGetNodeQuery`, `useUploadFileMutation`.
- **File-direct URL format (exact):** `${origin}/view/${nodeId}?token=${token}`. Folder URL stays `${origin}${link.url}` (i.e. `/s/{token}`).
- **One token per folder:** reuse the first active (non-revoked, non-expired) folder link; mint only when none exists; default mint expiry = **No expiry** (omit `expiresMs`).
- **Gating:** per-file "Copy link" and the post-upload prompt show only to folder **managers** (`canManage`, i.e. `effectiveLevel === 'owner'`). Drag-and-drop upload only for **writers** (`canWrite`).
- **App directory (run all commands here):** `/home/rico/bffless/repos/apps/apps/handoff`. Source root `src/`. Test a file with `pnpm exec vitest run <path>`; full gate `pnpm exec tsc -b && pnpm lint && pnpm test:run`.
- **Git root:** `/home/rico/bffless/repos/apps`; already on branch `feat/handoff-file-direct-share` (stacked on `feat/handoff-viewer-share-button` / PR #27). Do NOT create a branch. `cd` to the git root for git. Commit per task (pre-approved, "commit as you go").
- **Spec:** `docs/superpowers/specs/2026-06-27-handoff-frictionless-file-sharing-design.md`.

---

### Task 1: Pure share helpers

**Files:**
- Create: `apps/handoff/src/lib/share.ts`
- Test: `apps/handoff/src/lib/share.test.ts`

**Interfaces:**
- Consumes: `ShareLink` from `../store/handoffApi` (`{ token, folderId, url, expiresAt: number|null, revoked: boolean }`).
- Produces (used by Tasks 2, 3, 4):
  - `shareLinkCopyUrl(origin: string, link: { token: string; url: string }, nodeId?: string): string`
  - `pickReusableToken(links: ShareLink[] | undefined, nowMs: number): ShareLink | null`
  - `shouldClaimToken(input: { token: string | null; authenticated: boolean }): boolean`

- [ ] **Step 1: Write the failing test** — create `apps/handoff/src/lib/share.test.ts`:

```ts
/**
 * TDD tests for pure share helpers — written BEFORE the implementation.
 */
import { describe, it, expect } from 'vitest'
import { shareLinkCopyUrl, pickReusableToken, shouldClaimToken } from './share'
import type { ShareLink } from '../store/handoffApi'

function link(over: Partial<ShareLink> = {}): ShareLink {
  return { token: 't1', folderId: 'f1', url: '/s/t1', expiresAt: null, revoked: false, ...over }
}

describe('shareLinkCopyUrl', () => {
  it('builds a file-direct URL when nodeId is provided', () => {
    expect(shareLinkCopyUrl('https://h.dev', link({ token: 'abc' }), 'n9')).toBe('https://h.dev/view/n9?token=abc')
  })
  it('builds the folder /s URL when nodeId is absent', () => {
    expect(shareLinkCopyUrl('https://h.dev', link({ url: '/s/abc' }))).toBe('https://h.dev/s/abc')
  })
})

describe('pickReusableToken', () => {
  it('returns the first active link', () => {
    expect(pickReusableToken([link({ token: 'a' }), link({ token: 'b' })], 1000)?.token).toBe('a')
  })
  it('skips revoked and expired links', () => {
    const rev = link({ token: 'r', revoked: true })
    const exp = link({ token: 'e', expiresAt: 500 })
    const ok = link({ token: 'ok' })
    expect(pickReusableToken([rev, exp, ok], 1000)?.token).toBe('ok')
  })
  it('returns null when none usable / empty / undefined', () => {
    expect(pickReusableToken([link({ revoked: true })], 1000)).toBeNull()
    expect(pickReusableToken([], 1000)).toBeNull()
    expect(pickReusableToken(undefined, 1000)).toBeNull()
  })
  it('treats a null-expiry link as active far in the future', () => {
    expect(pickReusableToken([link({ expiresAt: null })], 9e15)?.token).toBe('t1')
  })
})

describe('shouldClaimToken', () => {
  it('claims when token present and not authenticated', () => {
    expect(shouldClaimToken({ token: 'x', authenticated: false })).toBe(true)
  })
  it('does not claim without a token', () => {
    expect(shouldClaimToken({ token: null, authenticated: false })).toBe(false)
  })
  it('does not claim when authenticated', () => {
    expect(shouldClaimToken({ token: 'x', authenticated: true })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/share.test.ts`
Expected: FAIL — cannot resolve `./share`.

- [ ] **Step 3: Write minimal implementation** — create `apps/handoff/src/lib/share.ts`:

```ts
/**
 * Pure helpers for share-link URLs and reuse decisions. No backend coupling.
 */
import type { ShareLink } from '../store/handoffApi'

/**
 * Copy URL for a share link. With `nodeId` → a file-direct URL that lands the
 * recipient on the file (`/view/{id}?token=`); without → the folder `/s/{token}`
 * URL (`link.url`). The token is always the existing folder-scoped token.
 */
export function shareLinkCopyUrl(
  origin: string,
  link: { token: string; url: string },
  nodeId?: string,
): string {
  return nodeId ? `${origin}/view/${nodeId}?token=${link.token}` : `${origin}${link.url}`
}

/**
 * First active (non-revoked, non-expired) link, or null. Used to reuse one
 * folder token across files instead of minting a new one each copy.
 */
export function pickReusableToken(links: ShareLink[] | undefined, nowMs: number): ShareLink | null {
  if (!links) return null
  for (const l of links) {
    if (l.revoked) continue
    if (l.expiresAt != null && l.expiresAt < nowMs) continue
    return l
  }
  return null
}

/**
 * Whether a viewer arriving with `?token` should claim it: only when there is a
 * token and the user is not already authenticated (authed users have access).
 */
export function shouldClaimToken(input: { token: string | null; authenticated: boolean }): boolean {
  return !!input.token && !input.authenticated
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/share.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/src/lib/share.ts apps/handoff/src/lib/share.test.ts
git commit -m "feat(handoff): pure share-link url/reuse/claim helpers"
```

---

### Task 2: ShareLinksSection — file-direct URLs, Copy on listed links, per-link Copied

**Files:**
- Modify: `apps/handoff/src/components/ShareLinksSection.tsx`

**Interfaces:**
- Consumes: `shareLinkCopyUrl` (Task 1).
- Produces: `ShareLinksSection` gains optional `nodeId?: string` prop; when set, all copy/display URLs are file-direct.

This component has no unit-test harness; verification is typecheck + lint + the existing suite.

- [ ] **Step 1: Add the import.** In `ShareLinksSection.tsx`, after the `import type { ShareLink }` line, add:

```tsx
import { shareLinkCopyUrl } from '../lib/share'
```

- [ ] **Step 2: Add the `nodeId` prop.** Replace the `ShareLinksSectionProps` interface body's end and the function signature:

Change the interface to add (inside `ShareLinksSectionProps`, after `topDivider?: boolean`):

```tsx
  /** When set, copy/display URLs are file-direct (/view/{nodeId}?token=) for this file. */
  nodeId?: string
```

Change the signature line from:

```tsx
export function ShareLinksSection({ folderId, topDivider = true }: ShareLinksSectionProps) {
```

to:

```tsx
export function ShareLinksSection({ folderId, topDivider = true, nodeId }: ShareLinksSectionProps) {
```

- [ ] **Step 3: Per-link copied state.** Replace:

```tsx
  const [copied, setCopied] = useState(false)
```

with:

```tsx
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
```

- [ ] **Step 4: Rework `handleCopy` to take a link and use the formatter.** Replace the whole `handleCopy` function:

```tsx
  function handleCopy(url: string) {
    const fullUrl = `${window.location.origin}${url}`
    void navigator.clipboard.writeText(fullUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
```

with:

```tsx
  function handleCopy(link: ShareLink) {
    const fullUrl = shareLinkCopyUrl(window.location.origin, link, nodeId)
    void navigator.clipboard.writeText(fullUrl).then(() => {
      setCopiedToken(link.token)
      setTimeout(() => setCopiedToken((t) => (t === link.token ? null : t)), 2000)
    })
  }
```

- [ ] **Step 5: Update the green "just created" box.** Replace its code/display + button block:

```tsx
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-xs text-gray-700 border border-green-200">
              {window.location.origin}{newLink.url}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(newLink.url)}
              className="shrink-0 rounded-lg border border-green-300 bg-white px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-50"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
```

with:

```tsx
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-xs text-gray-700 border border-green-200">
              {shareLinkCopyUrl(window.location.origin, newLink, nodeId)}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(newLink)}
              className="shrink-0 rounded-lg border border-green-300 bg-white px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-50"
            >
              {copiedToken === newLink.token ? 'Copied!' : 'Copy'}
            </button>
```

- [ ] **Step 6: Add a Copy button to each listed (active) link.** In the active-links `<li>`, insert a Copy button immediately before the Revoke button. Replace:

```tsx
              <span className="shrink-0 text-xs text-gray-400">{formatExpiry(link)}</span>
              <button
                type="button"
                disabled={revoking || revokingToken === link.token}
                onClick={() => handleRevoke(link.token)}
                className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 hover:text-red-600 disabled:opacity-50"
              >
                {revokingToken === link.token ? 'Revoking…' : 'Revoke'}
              </button>
```

with:

```tsx
              <span className="shrink-0 text-xs text-gray-400">{formatExpiry(link)}</span>
              <button
                type="button"
                onClick={() => handleCopy(link)}
                className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-900"
              >
                {copiedToken === link.token ? 'Copied!' : 'Copy'}
              </button>
              <button
                type="button"
                disabled={revoking || revokingToken === link.token}
                onClick={() => handleRevoke(link.token)}
                className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 hover:text-red-600 disabled:opacity-50"
              >
                {revokingToken === link.token ? 'Revoking…' : 'Revoke'}
              </button>
```

- [ ] **Step 7: Verify**

Run: `pnpm exec tsc -b && pnpm lint && pnpm test:run`
Expected: typecheck clean, lint clean, 181 tests pass (175 prior + 6 new from Task 1). No `copied`/`setCopied` references remain.

- [ ] **Step 8: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/src/components/ShareLinksSection.tsx
git commit -m "feat(handoff): file-direct copy URLs + re-copyable listed links in ShareLinksSection"
```

---

### Task 3: Token-aware viewer + shared claim hook

**Files:**
- Create: `apps/handoff/src/store/useClaimShareToken.ts`
- Create: `apps/handoff/src/components/InvalidLink.tsx`
- Modify: `apps/handoff/src/pages/ShareLinkEntry.tsx`
- Modify: `apps/handoff/src/pages/HandoffViewer.tsx`

**Interfaces:**
- Consumes: `shouldClaimToken` (Task 1); `useClaimShareLinkMutation` returning `{ valid: boolean; folderId: string | null }`; `setShareLinkFolderId` (`store/handoffSlice`); `useSession` (`{ session, loading }`).
- Produces: `useClaimShareToken()` → `{ run(token): Promise<...>, data, isLoading, isError }`; `InvalidLink` component.

No component test harness; verify via tsc/lint/suite. The pure `shouldClaimToken` is already tested.

- [ ] **Step 1: Create the shared claim hook** — `apps/handoff/src/store/useClaimShareToken.ts`:

```tsx
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
```

- [ ] **Step 2: Extract `InvalidLink`** — create `apps/handoff/src/components/InvalidLink.tsx` with the exact markup currently in `ShareLinkEntry.tsx`:

```tsx
/**
 * InvalidLink — shared "this share link is no longer valid" page.
 * Used by ShareLinkEntry (/s/:token) and HandoffViewer (/view/:id?token=).
 */
export function InvalidLink() {
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
```

- [ ] **Step 3: Refactor `ShareLinkEntry.tsx`** to use the hook and the extracted component (behavior unchanged). Replace the imports block:

```tsx
import { useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useDispatch } from 'react-redux'
import { useClaimShareLinkMutation } from '../store/handoffApi'
import { setShareLinkFolderId } from '../store/handoffSlice'
import type { AppDispatch } from '../store'
```

with:

```tsx
import { useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useClaimShareToken } from '../store/useClaimShareToken'
import { InvalidLink } from '../components/InvalidLink'
```

Delete the local `InvalidLink` function definition from `ShareLinkEntry.tsx` (now imported). Keep `Spinner`.

Replace the component body (from `export function ShareLinkEntry()` through the end) with:

```tsx
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
```

- [ ] **Step 4: Make `HandoffViewer` token-aware.** In `apps/handoff/src/pages/HandoffViewer.tsx`:

(a) Add imports near the top (after the existing `react-router-dom` import line):

```tsx
import { useSearchParams } from 'react-router-dom'
import { useClaimShareToken } from '../store/useClaimShareToken'
import { InvalidLink } from '../components/InvalidLink'
import { shouldClaimToken } from '../lib/share'
```

Note: `useParams` is already imported from `react-router-dom`; add `useSearchParams` to that existing import instead of a duplicate import line if your linter prefers — either is fine as long as `tsc`/`lint` pass.

(b) Replace the top of the `HandoffViewer` function:

```tsx
export function HandoffViewer() {
  const { id } = useParams<{ id: string }>()
  const { data: node, isLoading, isError } = useGetNodeQuery(id ?? '')
  const contentRef = useRef<HTMLDivElement>(null)
```

with:

```tsx
export function HandoffViewer() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const { session, loading: sessionLoading } = useSession()
  const authed = session?.authenticated === true

  // Claim the share token first (guest only) so the gated node fetch succeeds.
  const needClaim = !sessionLoading && shouldClaimToken({ token, authenticated: authed })
  const { run: claimToken, data: claimData, isError: claimError } = useClaimShareToken()
  const claimSettled = claimData !== undefined || claimError
  const claimPending = needClaim && !claimSettled

  useEffect(() => {
    if (needClaim && token) void claimToken(token)
  }, [needClaim, token, claimToken])

  const { data: node, isLoading, isError } = useGetNodeQuery(id ?? '', {
    skip: !id || sessionLoading || claimPending,
  })
  const contentRef = useRef<HTMLDivElement>(null)

  if (sessionLoading || claimPending) {
    return <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
  }
  if (needClaim && (claimError || claimData?.valid === false)) {
    return <InvalidLink />
  }
```

(`HandoffViewer` already imports `useSession` and `useRef`/`useEffect` from #27; if `useEffect` is not yet imported, add it to the existing `react` import.)

(c) Pass the file id to the viewer popover's `ShareLinksSection`. In `ControlBar`, change:

```tsx
              <ShareLinksSection folderId={node.parentId} topDivider={false} />
```

to:

```tsx
              <ShareLinksSection folderId={node.parentId} topDivider={false} nodeId={node.id} />
```

- [ ] **Step 5: Verify**

Run: `pnpm exec tsc -b && pnpm lint && pnpm test:run`
Expected: typecheck clean, lint clean, 181 tests pass. No unused-import or hooks-order lint errors.

- [ ] **Step 6: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/src/store/useClaimShareToken.ts apps/handoff/src/components/InvalidLink.tsx apps/handoff/src/pages/ShareLinkEntry.tsx apps/handoff/src/pages/HandoffViewer.tsx
git commit -m "feat(handoff): token-aware viewer (/view/{id}?token=) + shared claim hook"
```

---

### Task 4: One-click "Copy link" hook, button, and per-file row action

**Files:**
- Create: `apps/handoff/src/store/useCopyFileShareLink.ts`
- Create: `apps/handoff/src/components/CopyLinkButton.tsx`
- Modify: `apps/handoff/src/pages/FolderView.tsx`

**Interfaces:**
- Consumes: `pickReusableToken`, `shareLinkCopyUrl` (Task 1); `useMintShareLinkMutation`, `useListShareLinksQuery` (handoffApi); `ShareLink`.
- Produces:
  - `useCopyFileShareLink(folderId: string, links: ShareLink[] | undefined)` → `{ copyLink(nodeId: string): Promise<void>; copiedId: string|null; busyId: string|null; errorId: string|null }`
  - `CopyLinkButton({ status: 'idle'|'busy'|'copied'|'error', onClick, label?, className? })`

No component test harness; verify via tsc/lint/suite + Task 7 visual.

- [ ] **Step 1: Create the copy hook** — `apps/handoff/src/store/useCopyFileShareLink.ts`:

```tsx
/**
 * One-click "copy a file-direct share link". Reuses the first active folder
 * token (mints one only if none exists) and writes /view/{nodeId}?token= to the
 * clipboard. State is keyed by nodeId so multiple rows track independently.
 */
import { useCallback, useState } from 'react'
import { useMintShareLinkMutation } from './handoffApi'
import type { ShareLink } from './handoffApi'
import { pickReusableToken, shareLinkCopyUrl } from '../lib/share'

export function useCopyFileShareLink(folderId: string, links: ShareLink[] | undefined) {
  const [mint] = useMintShareLinkMutation()
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorId, setErrorId] = useState<string | null>(null)

  const copyLink = useCallback(
    async (nodeId: string) => {
      setErrorId(null)
      setCopiedId(null)
      setBusyId(nodeId)
      try {
        let token = pickReusableToken(links, Date.now())?.token
        if (!token) {
          const res = await mint({ folderId })
          if ('error' in res) throw new Error('mint failed')
          token = res.data.token
        }
        const url = shareLinkCopyUrl(window.location.origin, { token, url: `/s/${token}` }, nodeId)
        await navigator.clipboard.writeText(url)
        setBusyId(null)
        setCopiedId(nodeId)
        setTimeout(() => setCopiedId((c) => (c === nodeId ? null : c)), 2000)
      } catch {
        setBusyId(null)
        setErrorId(nodeId)
        setTimeout(() => setErrorId((e) => (e === nodeId ? null : e)), 3000)
      }
    },
    [folderId, links, mint],
  )

  return { copyLink, copiedId, busyId, errorId }
}
```

- [ ] **Step 2: Create the button** — `apps/handoff/src/components/CopyLinkButton.tsx`:

```tsx
/**
 * CopyLinkButton — small status-aware button. preventDefault/stopPropagation so
 * it works inside clickable row links without triggering navigation.
 */
export type CopyStatus = 'idle' | 'busy' | 'copied' | 'error'

interface CopyLinkButtonProps {
  status: CopyStatus
  onClick: () => void
  label?: string
  className?: string
}

export function CopyLinkButton({ status, onClick, label = 'Copy link', className }: CopyLinkButtonProps) {
  const text =
    status === 'copied' ? 'Copied!' : status === 'busy' ? 'Copying…' : status === 'error' ? 'Failed' : label
  return (
    <button
      type="button"
      disabled={status === 'busy'}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClick()
      }}
      className={
        className ??
        'shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-900 disabled:opacity-50'
      }
    >
      {text}
    </button>
  )
}
```

- [ ] **Step 3: Refactor `FileRow`** in `FolderView.tsx` so the row is a container (Link for the main area) with an optional copy button sibling. Add the import near the top of `FolderView.tsx`:

```tsx
import { CopyLinkButton, type CopyStatus } from '../components/CopyLinkButton'
```

Replace the entire `FileRow` function:

```tsx
function FileRow({ node }: { node: HandoffNode }) {
  const hint = node.mime ?? node.type
  return (
    <Link
      to={`/view/${node.id}`}
      className="flex items-center gap-3 rounded-lg border border-gray-100 bg-white px-4 py-3 shadow-sm transition-colors hover:bg-gray-50"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gray-50 text-gray-400">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
          <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900">{node.name}</p>
        <p className="truncate text-xs text-gray-400">{hint}</p>
      </div>
      {node.size !== null && (
        <span className="shrink-0 text-xs text-gray-400">{formatBytes(node.size)}</span>
      )}
    </Link>
  )
}
```

with:

```tsx
function FileRow({
  node,
  copyStatus,
  onCopyLink,
}: {
  node: HandoffNode
  copyStatus?: CopyStatus
  onCopyLink?: () => void
}) {
  const hint = node.mime ?? node.type
  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-100 bg-white px-4 py-3 shadow-sm transition-colors hover:bg-gray-50">
      <Link to={`/view/${node.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gray-50 text-gray-400">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
            <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-900">{node.name}</p>
          <p className="truncate text-xs text-gray-400">{hint}</p>
        </div>
      </Link>
      {node.size !== null && (
        <span className="shrink-0 text-xs text-gray-400">{formatBytes(node.size)}</span>
      )}
      {onCopyLink && <CopyLinkButton status={copyStatus ?? 'idle'} onClick={onCopyLink} />}
    </div>
  )
}
```

- [ ] **Step 4: Wire the hook in `FolderView`.** Add the imports near the top of `FolderView.tsx`:

```tsx
import { useListShareLinksQuery } from '../store/handoffApi'
import { useCopyFileShareLink } from '../store/useCopyFileShareLink'
```

(If `useListShareLinksQuery` is already imported from `../store/handoffApi`, add it to the existing import rather than duplicating.)

Immediately AFTER the line `const canManage = chainReady && effectiveLevel === 'owner'`, add:

```tsx
  // Manager-only: load folder links so "Copy link" can reuse one token per folder.
  const { data: folderLinks } = useListShareLinksQuery({ folderId }, { skip: !canManage })
  const copy = useCopyFileShareLink(folderId, folderLinks)

  function fileCopyStatus(nodeId: string): CopyStatus {
    if (copy.busyId === nodeId) return 'busy'
    if (copy.copiedId === nodeId) return 'copied'
    if (copy.errorId === nodeId) return 'error'
    return 'idle'
  }
```

In the listing, change the `FileRow` render to pass copy props for managers. Replace:

```tsx
            ) : (
              <FileRow key={node.id} node={node} />
            )
```

with:

```tsx
            ) : (
              <FileRow
                key={node.id}
                node={node}
                copyStatus={fileCopyStatus(node.id)}
                onCopyLink={canManage ? () => void copy.copyLink(node.id) : undefined}
              />
            )
```

- [ ] **Step 5: Verify**

Run: `pnpm exec tsc -b && pnpm lint && pnpm test:run`
Expected: typecheck clean, lint clean, 181 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/src/store/useCopyFileShareLink.ts apps/handoff/src/components/CopyLinkButton.tsx apps/handoff/src/pages/FolderView.tsx
git commit -m "feat(handoff): one-click Copy link per file (reuses one folder token)"
```

---

### Task 5: Post-upload copy prompt

**Files:**
- Modify: `apps/handoff/src/pages/FolderView.tsx`

**Interfaces:**
- Consumes: `useUploadFileMutation` (returns `HandoffNode` on success), the `copy` hook + `CopyLinkButton` from Task 4.
- Produces: after an upload, a prompt listing uploaded file(s) each with a Copy-link button (manager-gated).

- [ ] **Step 1: Track uploaded nodes.** In `FolderView`, add state near the other `useState` calls (after `const [uploadDone, setUploadDone] = useState(false)`):

```tsx
  const [uploadedNodes, setUploadedNodes] = useState<HandoffNode[]>([])
```

- [ ] **Step 2: Capture the uploaded node in `handleFile`.** Replace the existing `handleFile`:

```tsx
  async function handleFile(file: File) {
    setUploadDone(false)
    const result = await uploadFile({ file, parentId: folderId })
    if (!('error' in result)) {
      setUploadDone(true)
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setUploadDone(false), 3000)
    }
  }
```

with:

```tsx
  async function handleFile(file: File) {
    setUploadDone(false)
    const result = await uploadFile({ file, parentId: folderId })
    if (!('error' in result)) {
      setUploadDone(true)
      setUploadedNodes((prev) => [...prev, result.data])
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setUploadDone(false), 3000)
    }
  }
```

- [ ] **Step 3: Render the post-upload prompt (managers).** Replace the existing `uploadDone` feedback block:

```tsx
      {uploadDone && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          File uploaded successfully.
        </div>
      )}
```

with:

```tsx
      {uploadDone && uploadedNodes.length === 0 && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          File uploaded successfully.
        </div>
      )}
      {uploadedNodes.length > 0 && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-green-800">Uploaded — copy a share link</p>
            <button
              type="button"
              onClick={() => setUploadedNodes([])}
              className="rounded p-1 text-green-700 hover:bg-green-100"
              aria-label="Dismiss"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
              </svg>
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {uploadedNodes.map((n) => (
              <li key={n.id} className="flex items-center gap-2 rounded-lg border border-green-200 bg-white px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-gray-800">{n.name}</span>
                <CopyLinkButton
                  status={fileCopyStatus(n.id)}
                  onClick={() => void copy.copyLink(n.id)}
                  className="shrink-0 rounded-lg border border-green-300 bg-white px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
                />
              </li>
            ))}
          </ul>
        </div>
      )}
```

(The prompt's Copy buttons reuse the Task 4 `copy` hook + `fileCopyStatus`. Minting is manager-gated server-side; uploaders are writers and typically managers of their own folder. If a non-manager writer ever uploads, the copy will surface a "Failed" state rather than crash — acceptable.)

- [ ] **Step 4: Clear the prompt on folder change.** Add an effect after the existing cleanup effect:

```tsx
  useEffect(() => {
    setUploadedNodes([])
  }, [folderId])
```

- [ ] **Step 5: Verify**

Run: `pnpm exec tsc -b && pnpm lint && pnpm test:run`
Expected: typecheck clean, lint clean, 181 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/src/pages/FolderView.tsx
git commit -m "feat(handoff): post-upload Copy link prompt"
```

---

### Task 6: Drag-and-drop upload

**Files:**
- Modify: `apps/handoff/src/pages/FolderView.tsx`

**Interfaces:**
- Consumes: `canWrite`, `handleFile` (existing). Produces: drop-to-upload on the folder view with a drag-active highlight; uploaded files flow into the Task 5 prompt.

- [ ] **Step 1: Add drag state.** In `FolderView`, add near the other `useState` calls:

```tsx
  const [dragActive, setDragActive] = useState(false)
```

- [ ] **Step 2: Add drop handlers.** Add these functions inside `FolderView` (after `handleFile`):

```tsx
  function handleDragOver(e: React.DragEvent) {
    if (!canWrite) return
    e.preventDefault()
    setDragActive(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    // Only clear when leaving the container itself, not its children.
    if (e.currentTarget === e.target) setDragActive(false)
  }

  async function handleDrop(e: React.DragEvent) {
    if (!canWrite) return
    e.preventDefault()
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files)
    for (const f of files) {
      await handleFile(f)
    }
  }
```

- [ ] **Step 3: Attach to the page container and add the highlight.** The `FolderView` return currently opens with `<div className="container-page py-10">`. Replace that opening tag with:

```tsx
    <div
      className={`container-page py-10 ${dragActive ? 'rounded-xl outline-dashed outline-2 outline-offset-4 outline-gray-400' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
```

Add a drop hint banner immediately inside that container, before the `<Breadcrumb ... />` line, shown only while dragging and only for writers:

```tsx
      {dragActive && canWrite && (
        <div className="mb-4 rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
          Drop files to upload to this folder
        </div>
      )}
```

- [ ] **Step 4: Verify**

Run: `pnpm exec tsc -b && pnpm lint && pnpm test:run`
Expected: typecheck clean, lint clean, 181 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/src/pages/FolderView.tsx
git commit -m "feat(handoff): drag-and-drop upload to a folder"
```

---

### Task 7: Visual + live validation

**Files:** none (validation only). Uses the dev server + `localdev-tools/` + the `j5s-dev` MCP.

**Interfaces:** none. Confirms the full journey across the four parts.

- [ ] **Step 1: Start the dev server.**

```bash
cd /home/rico/bffless/repos/apps/apps/handoff && pnpm dev
```

Run in the background; wait for `Local: http://localhost:5173/`.

- [ ] **Step 2: Seed fixtures + drive states (MSW, mocks on).** Open `http://localhost:5173/?mocks=on` (chrome-devtools MCP), then in the page (`evaluate_script`) create a folder + two files (the default mock user `user-owner` is an admin owner, so `canManage`/`canWrite` are true):

```js
async () => {
  const j = async (u,b)=> (await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})).json();
  const folder = await j('/api/folders',{name:'Shared'});
  const a = await j('/api/nodes',{originalName:'a.png',displayName:'a.png',parentId:folder.node.id,createdMs:1735000000000});
  const b = await j('/api/nodes',{originalName:'b.png',displayName:'b.png',parentId:folder.node.id,createdMs:1735000000001});
  return { folderId: folder.node.id, a: a.node.id, b: b.node.id };
}
```

SPA-navigate with `history.pushState('/folder/{folderId}')` + `popstate` (a full reload wipes the in-memory mock store). Verify and screenshot:
- Each file row shows a **Copy link** button (manager). Click it; assert clipboard / "Copied!"; click the second file and assert it reused the **same** token (inspect via `GET /api/share-links?folderId=...` → one link).
- A `/view/{a}?token=...` URL (build it from the copied link) opens directly on the file.
- The viewer Share popover (open it) copies a `/view/{id}?token=` URL; listed links each have Copy.
- Invalid token → `/view/{a}?token=bogus` shows the "no longer valid" state (set mock user to guest via reload+guest, or assert the claim path).

Report screenshots with `SendUserFile`.

- [ ] **Step 3: Drag-and-drop check.** With mocks on and an owner session, simulate a drop on the folder container (chrome-devtools: dispatch a `drop` DataTransfer, or use `upload_file` against the hidden input as a fallback) and confirm the post-upload prompt appears with a working Copy-link button.

- [ ] **Step 4: Live curl dogfood** (mirrors the earlier manual check; no live mint needed if a link already exists). Against a real folder share token you control: `claim` it, then `GET /api/node?id={fileId}` with the `hf_s` cookie succeeds, and the file-direct URL `/view/{fileId}?token={token}` resolves. Do not leave stray live links — revoke any you mint.

- [ ] **Step 5: Stop the dev server and finalize.** Confirm all acceptance criteria from the spec; no commit (validation only). If any state is wrong, return to the relevant task.

---

## Notes for the executor

- **Hooks order:** every `useXxx` must be called unconditionally and in stable order. `useListShareLinksQuery({folderId},{skip:!canManage})` and `useCopyFileShareLink(...)` must be placed where `canManage`/`folderId` are already defined but still above any early `return`. `FolderView` has no early returns before its JSX, so placing them right after `canManage` is defined is correct.
- **`navigator.clipboard`** may be unavailable in insecure contexts; the catch in `useCopyFileShareLink` / the `.then` in `ShareLinksSection` already degrade to an error state rather than throwing.
- **`Date.now()`** is fine in app code (the no-`Date.now` rule applies only to Workflow scripts).
- **Test count** "181" assumes the branch starts from #27's 175 + Task 1's 6. If the base differs, match the actual reported number; the gate is "all pass," not the exact integer.
- **Do not** add backend, proxy-rule, schema, or `acl.ts` changes — the token stays folder-scoped.
```
