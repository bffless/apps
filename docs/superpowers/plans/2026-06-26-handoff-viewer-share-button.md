# Handoff Viewer Share Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a folder-scoped **Share** control to the handoff viewer's control bar so a user viewing a file/site can mint, copy, and revoke a share link for the item's parent folder.

**Architecture:** A pure gating helper (`canShareParentFolder`) decides — mirroring the server's mint authorization (parent folder `ownerId` or admin). The existing `ShareLinksSection` UI is extracted from `ManageAccessPanel` into its own exported component and reused inside a popover anchored to a new Share button in `HandoffViewer`'s `ControlBar`. Root-level items (`parentId === 'root'`) render a disabled, explanatory state.

**Tech Stack:** React 19 + TypeScript + Vite, RTK Query (`store/handoffApi.ts`), Vitest (pure-function unit tests), Tailwind. Validation via MSW mocks + the `localdev-tools/` headless Chromium.

## Global Constraints

- **Spec:** `repos/apps/docs/superpowers/specs/2026-06-26-handoff-viewer-share-button-design.md`. Implements issue [bffless/apps#23](https://github.com/bffless/apps/issues/23), **Option A only** (folder-scoped). Per-item links (Option B) and grants/people management in the viewer are out of scope.
- **No backend / proxy-rule changes.** Reuse existing endpoints via existing RTK Query hooks: `useMintShareLinkMutation`, `useListShareLinksQuery`, `useRevokeShareLinkMutation`.
- **App directory (run all commands here):** `/home/rico/bffless/repos/apps/apps/handoff`. Source root is `src/` (`src/lib`, `src/components`, `src/pages`, `src/store`).
- **Git repo root:** `/home/rico/bffless/repos/apps` (the monorepo). `cd` there for `git` commands; paths below are repo-root-relative. **Do not commit without the user's approval** (workspace rule) — the commit steps stage + prepare the message; pause for approval before running `git commit` if the user has not pre-approved.
- **Tests are pure-function unit tests only** — there is no component/RTL harness. UI changes are verified by typecheck + lint + headless-browser screenshots, not unit tests.
- **Gate predicate (exact):** `isAdmin || parentNode?.ownerId === userId`. Never broaden to `edit` grants; mint requires owner.
- **Scope-clarifier copy (exact):** `Anyone with the link can view this folder and everything in it.`
- **Control-bar order (from the spec):** Back, title, **Share**, Open in new tab, Fullscreen, Download.

---

### Task 1: `canShareParentFolder` pure gating helper

**Files:**
- Create: `apps/handoff/src/lib/shareGate.ts`
- Test: `apps/handoff/src/lib/shareGate.test.ts`

**Interfaces:**
- Consumes: `Session` from `src/lib/session.ts` (`{ authenticated: true; user: { id: string; role?: string; ... } } | { authenticated: false }`); `HandoffNode` from `src/lib/nodes.ts` (has `ownerId: string | null`).
- Produces: `canShareParentFolder(input: { session: Session | null; parentNode: HandoffNode | undefined }): boolean` — consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `apps/handoff/src/lib/shareGate.test.ts`:

```ts
/**
 * TDD tests for canShareParentFolder — written BEFORE the implementation.
 * Run to confirm RED, then implement shareGate.ts to go GREEN.
 */

import { describe, it, expect } from 'vitest'
import { canShareParentFolder } from './shareGate'
import type { Session } from './session'
import type { HandoffNode } from './nodes'

const ownerSession: Session = { authenticated: true, user: { id: 'u1' } }
const adminSession: Session = { authenticated: true, user: { id: 'u2', role: 'admin' } }
const guestSession: Session = { authenticated: false }

function folder(ownerId: string | null): HandoffNode {
  return {
    id: 'f1', type: 'folder', name: 'F', mime: null, size: null, url: null,
    storageKey: null, parentId: 'root', createdAt: 0, ownerId, grants: [], mode: 'inheriting',
  }
}

describe('canShareParentFolder', () => {
  it('returns true for admin regardless of ownership', () => {
    expect(canShareParentFolder({ session: adminSession, parentNode: folder('someone-else') })).toBe(true)
  })
  it('returns true when the user owns the parent folder', () => {
    expect(canShareParentFolder({ session: ownerSession, parentNode: folder('u1') })).toBe(true)
  })
  it('returns false when the user does not own the parent folder', () => {
    expect(canShareParentFolder({ session: ownerSession, parentNode: folder('other') })).toBe(false)
  })
  it('returns false while the parent node is still loading (undefined)', () => {
    expect(canShareParentFolder({ session: ownerSession, parentNode: undefined })).toBe(false)
  })
  it('returns false for guests (share-link visitors)', () => {
    expect(canShareParentFolder({ session: guestSession, parentNode: folder('u1') })).toBe(false)
  })
  it('returns false when session is null', () => {
    expect(canShareParentFolder({ session: null, parentNode: folder('u1') })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/shareGate.test.ts`
Expected: FAIL — cannot resolve `./shareGate` / `canShareParentFolder is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/handoff/src/lib/shareGate.ts`:

```ts
/**
 * Pure gate for the viewer's Share control.
 *
 * Decides whether the current viewer may create share links for a node's parent
 * folder. Mirrors the server's mint authorization exactly: a user may share a
 * folder if they are an admin or own that folder. Never throws.
 */

import type { Session } from './session'
import type { HandoffNode } from './nodes'

export function canShareParentFolder(input: {
  session: Session | null
  /** The node.parentId folder, or undefined while loading / for root items. */
  parentNode: HandoffNode | undefined
}): boolean {
  const { session, parentNode } = input
  if (!session || !session.authenticated) return false
  if (session.user.role === 'admin') return true
  return parentNode != null && parentNode.ownerId === session.user.id
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/shareGate.test.ts`
Expected: PASS (6 passing).

- [ ] **Step 5: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/src/lib/shareGate.ts apps/handoff/src/lib/shareGate.test.ts
git commit -m "feat(handoff): add canShareParentFolder gate helper"
```

---

### Task 2: Extract `ShareLinksSection` into its own reusable component

**Files:**
- Create: `apps/handoff/src/components/ShareLinksSection.tsx`
- Modify: `apps/handoff/src/components/ManageAccessPanel.tsx` (remove the inline section + its imports; import the extracted one)

**Interfaces:**
- Produces: `export function ShareLinksSection({ folderId }: { folderId: string })` and `export interface ShareLinksSectionProps` — consumed by `ManageAccessPanel` (Task 2) and `ControlBar` (Task 3).
- This is a **refactor with one additive change** (the scope clarifier). No behavior change to mint/list/copy/revoke.

- [ ] **Step 1: Create the extracted component file**

Create `apps/handoff/src/components/ShareLinksSection.tsx`. Move the existing `EXPIRY_OPTIONS`, `ShareLinksSectionProps`, and `ShareLinksSection` (currently `ManageAccessPanel.tsx` lines ~149–335) verbatim, export the interface + component, and add the scope-clarifier line under the "Share links" heading:

```tsx
/**
 * ShareLinksSection — create, list, copy, and revoke folder-scoped share links.
 *
 * Extracted from ManageAccessPanel so both the folder "Manage access" panel and
 * the viewer's Share popover reuse the same mint/list/copy/revoke UI. Renders a
 * folder-scope clarifier so users understand a link grants View to the whole
 * folder and its contents.
 */

import { useState } from 'react'
import {
  useMintShareLinkMutation,
  useListShareLinksQuery,
  useRevokeShareLinkMutation,
} from '../store/handoffApi'
import type { ShareLink } from '../store/handoffApi'

const EXPIRY_OPTIONS: { label: string; ms: number | undefined }[] = [
  { label: 'No expiry', ms: undefined },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
]

export interface ShareLinksSectionProps {
  folderId: string
}

export function ShareLinksSection({ folderId }: ShareLinksSectionProps) {
  const { data: links, isLoading: loadingLinks } = useListShareLinksQuery({ folderId })
  const [mintShareLink, { isLoading: minting }] = useMintShareLinkMutation()
  const [revokeShareLink, { isLoading: revoking }] = useRevokeShareLinkMutation()

  const [expiryIdx, setExpiryIdx] = useState(0)
  const [mintError, setMintError] = useState<string | null>(null)
  const [newLink, setNewLink] = useState<ShareLink | null>(null)
  const [copied, setCopied] = useState(false)
  const [revokingToken, setRevokingToken] = useState<string | null>(null)

  async function handleCreate() {
    setMintError(null)
    setNewLink(null)
    const expiresMs = EXPIRY_OPTIONS[expiryIdx]?.ms
    const result = await mintShareLink({ folderId, expiresMs })
    if ('error' in result) {
      const status = (result.error as { status?: number }).status
      if (status === 403) {
        setMintError('You do not have permission to create share links for this folder.')
      } else {
        setMintError('Failed to create share link. Please try again.')
      }
    } else {
      setNewLink(result.data)
    }
  }

  async function handleRevoke(token: string) {
    setRevokingToken(token)
    try {
      await revokeShareLink({ token, folderId })
      if (newLink?.token === token) setNewLink(null)
    } finally {
      setRevokingToken(null)
    }
  }

  function handleCopy(url: string) {
    const fullUrl = `${window.location.origin}${url}`
    void navigator.clipboard.writeText(fullUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const nowMs = new Date().getTime()

  function formatExpiry(link: ShareLink): string {
    if (link.revoked) return 'Revoked'
    if (!link.expiresAt) return 'No expiry'
    if (link.expiresAt < nowMs) return 'Expired'
    const daysLeft = Math.ceil((link.expiresAt - nowMs) / (24 * 60 * 60 * 1000))
    return `Expires in ${daysLeft}d`
  }

  const activeLinks = (links ?? []).filter((l) => !l.revoked)
  const revokedLinks = (links ?? []).filter((l) => l.revoked)

  return (
    <div className="mt-5 border-t border-gray-100 pt-5">
      <p className="mb-1 text-xs font-medium text-gray-500 uppercase tracking-wide">Share links</p>
      <p className="mb-3 text-xs text-gray-400">Anyone with the link can view this folder and everything in it.</p>

      {/* Create row */}
      <div className="mb-3 flex items-center gap-2">
        <select
          value={expiryIdx}
          onChange={(e) => setExpiryIdx(Number(e.target.value))}
          disabled={minting}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-gray-500 focus:outline-none disabled:opacity-50"
        >
          {EXPIRY_OPTIONS.map((opt, i) => (
            <option key={i} value={i}>{opt.label}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={minting}
          onClick={handleCreate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {minting ? (
            <>
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Creating…
            </>
          ) : (
            'Create link'
          )}
        </button>
      </div>

      {mintError && (
        <p className="mb-3 text-xs text-red-600">{mintError}</p>
      )}

      {/* Newly-created link — show URL + copy */}
      {newLink && !newLink.revoked && (
        <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
          <p className="mb-1.5 text-xs font-medium text-green-800">Share link created</p>
          <div className="flex items-center gap-2">
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
          </div>
          {newLink.expiresAt && (
            <p className="mt-1 text-xs text-green-700">{formatExpiry(newLink)}</p>
          )}
        </div>
      )}

      {/* Active links list */}
      {loadingLinks && (
        <div className="py-2 text-sm text-gray-400">Loading links…</div>
      )}

      {!loadingLinks && activeLinks.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {activeLinks.map((link) => (
            <li
              key={link.token}
              className="flex items-center gap-2 rounded-lg border border-gray-100 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-600">
                {link.url}
              </span>
              <span className="shrink-0 text-xs text-gray-400">{formatExpiry(link)}</span>
              <button
                type="button"
                disabled={revoking || revokingToken === link.token}
                onClick={() => handleRevoke(link.token)}
                className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 hover:text-red-600 disabled:opacity-50"
              >
                {revokingToken === link.token ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loadingLinks && revokedLinks.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {revokedLinks.map((link) => (
            <li
              key={link.token}
              className="flex items-center gap-2 rounded-lg border border-gray-100 px-3 py-2 opacity-50"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-400 line-through">
                {link.url}
              </span>
              <span className="shrink-0 text-xs text-gray-400">Revoked</span>
            </li>
          ))}
        </ul>
      )}

      {!loadingLinks && (links ?? []).length === 0 && (
        <p className="text-xs text-gray-400">No share links yet.</p>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Update `ManageAccessPanel.tsx` to import the extracted component**

In `apps/handoff/src/components/ManageAccessPanel.tsx`:

1. In the `from '../store/handoffApi'` import block, **remove** these three hook imports (they move to the new file): `useMintShareLinkMutation`, `useListShareLinksQuery`, `useRevokeShareLinkMutation`. Keep `useGetGrantsQuery`, `useAddGrantMutation`, `useRevokeGrantMutation`, `useSearchDirectoryQuery`.
2. **Remove** the line `import type { ShareLink } from '../store/handoffApi'` (no longer used here).
3. **Add** the import: `import { ShareLinksSection } from './ShareLinksSection'`.
4. **Delete** the moved block: the `// ShareLinksSection` section comment, `const EXPIRY_OPTIONS`, `interface ShareLinksSectionProps`, and the entire `function ShareLinksSection(...)` (the old lines ~149–335).
5. Leave the usage site unchanged — `<ShareLinksSection folderId={folderId} />` near the end of `ManageAccessPanel` now resolves to the imported component.

After editing, the resulting import region at the top of `ManageAccessPanel.tsx` should read:

```tsx
import { useState, useEffect, useRef } from 'react'
import {
  useGetGrantsQuery,
  useAddGrantMutation,
  useRevokeGrantMutation,
  useSearchDirectoryQuery,
} from '../store/handoffApi'
import { ShareLinksSection } from './ShareLinksSection'
```

- [ ] **Step 3: Typecheck, lint, and run the existing test suite**

Run: `pnpm exec tsc -b && pnpm lint && pnpm test:run`
Expected: typecheck clean, lint clean, all existing tests PASS (the refactor changes no pure logic; `ShareLink` is still exported from `store/handoffApi`).

- [ ] **Step 4: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/src/components/ShareLinksSection.tsx apps/handoff/src/components/ManageAccessPanel.tsx
git commit -m "refactor(handoff): extract ShareLinksSection into its own component"
```

---

### Task 3: Add the Share control to the viewer `ControlBar`

**Files:**
- Modify: `apps/handoff/src/pages/HandoffViewer.tsx` (the `ControlBar` component + its imports)

**Interfaces:**
- Consumes: `canShareParentFolder` (Task 1), `ShareLinksSection` (Task 2), `useSession` (`src/lib/session.ts`), `useGetNodeQuery` (`src/store/handoffApi.ts`).
- Produces: no new exports; updates `ControlBar`'s rendered output.

- [ ] **Step 1: Add imports**

At the top of `apps/handoff/src/pages/HandoffViewer.tsx`, extend the imports. The React import already includes `useRef, useState, useEffect`. Add:

```tsx
import { useSession } from '../lib/session'
import { canShareParentFolder } from '../lib/shareGate'
import { ShareLinksSection } from '../components/ShareLinksSection'
```

- [ ] **Step 2: Add a shared `ShareIcon` helper (DRY) above `ControlBar`**

Insert just above the `ControlBar` function (after the `ControlBarProps` interface):

```tsx
function ShareIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path d="M13 4.5a2.5 2.5 0 1 1 .702 1.737L6.97 9.604a2.518 2.518 0 0 1 0 .792l6.733 3.367a2.5 2.5 0 1 1-.671 1.341L6.3 11.737a2.5 2.5 0 1 1 0-3.474l6.733-3.367A2.515 2.515 0 0 1 13 4.5Z" />
    </svg>
  )
}
```

- [ ] **Step 3: Rewrite `ControlBar` to compute the gate and render the Share control**

Replace the existing `ControlBar` function body. Add session + parent-folder lookup + popover state at the top, and insert the Share control immediately **after the Title `<span>` and before "Open in new tab"**:

```tsx
function ControlBar({ node, contentRef }: ControlBarProps) {
  const navigate = useNavigate()
  const { session } = useSession()

  const isRoot = node.parentId === 'root'
  // Look up the parent folder to read its ownerId for the share gate.
  const { data: parentNode } = useGetNodeQuery(node.parentId, { skip: isRoot })
  const canShare = canShareParentFolder({ session, parentNode })

  const [shareOpen, setShareOpen] = useState(false)
  const shareRef = useRef<HTMLDivElement>(null)

  // Close the Share popover on outside click or Escape (mirrors DirectorySearch).
  useEffect(() => {
    if (!shareOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (shareRef.current && !shareRef.current.contains(e.target as Node)) {
        setShareOpen(false)
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setShareOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [shareOpen])

  function handleFullscreen() {
    if (contentRef.current) {
      contentRef.current.requestFullscreen().catch(() => { /* ignore */ })
    }
  }

  return (
    <div className="sticky top-14 z-30 flex items-center gap-2 border-b border-gray-200 bg-white/90 px-4 py-2 backdrop-blur">
      {/* Back */}
      <button
        type="button"
        onClick={() => navigate('/')}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
        </svg>
        Back
      </button>

      {/* Title */}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">{node.name}</span>

      {/* Share — owners/admins of the parent folder. Root items: disabled + explanation. */}
      {isRoot ? (
        session?.authenticated ? (
          <button
            type="button"
            disabled
            title="Move this into a folder to share it"
            className="inline-flex cursor-not-allowed items-center gap-1 rounded px-2 py-1 text-sm text-gray-300"
          >
            <ShareIcon />
            <span className="hidden sm:inline">Share</span>
          </button>
        ) : null
      ) : canShare ? (
        <div ref={shareRef} className="relative">
          <button
            type="button"
            onClick={() => setShareOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
            title="Share"
            aria-haspopup="dialog"
            aria-expanded={shareOpen}
          >
            <ShareIcon />
            <span className="hidden sm:inline">Share</span>
          </button>
          {shareOpen && (
            <div className="absolute right-0 z-50 mt-1 w-80 rounded-xl border border-gray-200 bg-white p-4 shadow-lg">
              <ShareLinksSection folderId={node.parentId} />
            </div>
          )}
        </div>
      ) : null}

      {/* Open in new tab */}
      {node.url && (
        <a
          href={node.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
          title="Open in new tab"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path fillRule="evenodd" d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" clipRule="evenodd" />
            <path fillRule="evenodd" d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z" clipRule="evenodd" />
          </svg>
          <span className="hidden sm:inline">Open</span>
        </a>
      )}

      {/* Fullscreen */}
      <button
        type="button"
        onClick={handleFullscreen}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
        title="Fullscreen"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path d="M13.28 7.78a.75.75 0 0 0-1.06-1.06l-1.97 1.97V5.75a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 .75.75h4.5a.75.75 0 0 0 0-1.5h-2.94l1.97-1.97ZM6.72 12.22a.75.75 0 0 0 1.06 1.06l1.97-1.97v2.94a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.94l-1.97 1.97Z" />
        </svg>
        <span className="hidden sm:inline">Fullscreen</span>
      </button>

      {/* Download — not shown for sites (use Open-in-new-tab instead) */}
      {node.url && node.type !== 'site' && (
        <a
          href={node.url}
          download={node.name}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
          title="Download"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
            <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
          </svg>
          <span className="hidden sm:inline">Download</span>
        </a>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Typecheck, lint, and run tests**

Run: `pnpm exec tsc -b && pnpm lint && pnpm test:run`
Expected: typecheck clean, lint clean, all existing tests PASS (no pure logic changed; the gate is covered by Task 1).

- [ ] **Step 5: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/src/pages/HandoffViewer.tsx
git commit -m "feat(handoff): add Share control to the viewer control bar (#23)"
```

---

### Task 4: Visual + live validation

**Files:** none (validation only). Uses the local-dev worktree and `localdev-tools/`.

**Interfaces:** none. Confirms the three rendered states + the end-to-end share-link path.

- [ ] **Step 1: Inspect the MSW mock surface for the viewer**

Find how the handoff app's MSW mocks supply the session and nodes so you can drive the three states:

Run: `cd /home/rico/bffless/repos/apps/apps/handoff && grep -rn "auth/session\|getNode\|/api/node\|parentId\|ownerId" src/mocks 2>/dev/null; ls src/mocks 2>/dev/null`
Expected: locate the handlers for `/_bffless/auth/session` and the node-fetch endpoint. Confirm you can mock (a) an authenticated owner whose `id` matches a folder's `ownerId`, (b) a node whose `parentId` points at that folder, and (c) a root-level node (`parentId: 'root'`). If the mocks can't express owner identity + a folder parent, add a minimal fixture in the mocks following the existing pattern — do **not** change app logic.

- [ ] **Step 2: Run the app headless and screenshot the three states**

Start the dev server (per the app's README / `vite`), then use the headless tooling from `/home/rico/bffless/localdev-tools`:

```bash
cd /home/rico/bffless/localdev-tools
node shot.mjs http://localhost:5173/view/<owned-folder-child-id> --out /tmp/claude-1000/-home-rico-bffless/63ca8623-dec0-4d2a-b0a1-5b2fc118efc5/scratchpad/share-owner.png
node shot.mjs http://localhost:5173/view/<root-level-item-id> --out /tmp/claude-1000/-home-rico-bffless/63ca8623-dec0-4d2a-b0a1-5b2fc118efc5/scratchpad/share-root.png
```

Verify by viewing the screenshots:
- Owner viewing a folder child → **Share** button present in the bar; clicking it (use `chrome-devtools` MCP `click` then screenshot) opens the popover with the expiry select, "Create link", and the scope clarifier "Anyone with the link can view this folder and everything in it."
- Root-level item (authenticated) → **Share** button **disabled** with the tooltip text "Move this into a folder to share it".
- Non-owner / guest session → **no** Share button. (Toggle the MSW mock to a non-matching user id or guest and re-shoot.)

Report each screenshot with `SendUserFile` so the user can confirm the UX.

- [ ] **Step 3: Live dogfood the end-to-end share path**

Using the `j5s-dev` MCP (API key already wired), mint a real share link for a real handoff folder and confirm the claim → view path still works after the change:

1. `mcp__j5s-dev__list_aliases` / locate the `handoff` deployment; identify a folder id you own.
2. `POST /api/share-links` for that folder (via the MCP API key) → get `/s/{token}`.
3. Open `https://handoff.j5s.dev/s/{token}` headless (`node shot.mjs ... --out .../share-claim.png`) → confirm it claims and renders the folder in view mode (no Share button, since the visitor is a guest).
4. Revoke the test link afterward (`POST /api/share-links/revoke`) to avoid leaving a live link.

- [ ] **Step 4: Finalize**

Confirm the four acceptance criteria from the spec are met (Share visible to managers; mint/copy/revoke works; root disabled state; scope-clarifying copy). No commit (validation only); if any state is wrong, return to Task 3.

---

## Notes for the executor

- **`useGetNodeQuery(node.parentId, { skip: isRoot })`** is the same hook `FolderView` uses to fetch a folder by id; the parent folder carries `ownerId`. While it loads, `parentNode` is `undefined` → `canShare` is `false` → no button flash. This mirrors `FolderView`'s "wait until resolved" approach.
- **Why gate on the immediate parent, not the full ancestor chain:** the mint endpoint authorizes on the target folder's `ownerId`/admin, so immediate-parent ownership is exactly what the server will accept. The server remains the source of truth regardless of the client gate.
- **Do not** add `useMintShareLinkMutation` etc. back into `ManageAccessPanel` — they live in `ShareLinksSection` now.
