/**
 * Global site header, mounted once in `App.tsx` above the routes so every
 * page — public and `/admin/*` alike — gets the same navigation. Before this
 * existed, admin detail pages (`/admin/video/:id`) had no way back to the
 * admin home at all.
 *
 * Left: brand link home, plus Videos/Conversations admin nav once the session
 * resolves to an admin (guests never see admin links; the `/api/*` rules'
 * `auth_required` gate is the real boundary — see `RequireAdmin`). Right: a
 * GitHub link to this app's source and a user menu showing the signed-in
 * account's email + role, or a sign-in path (the admin login relay, same as
 * `RequireAdmin`'s) for guests.
 */

import { useEffect, useRef, useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { adminLoginUrl, useSession, type Session } from '../lib/auth'

const GITHUB_URL = 'https://github.com/bffless/apps/tree/main/apps/recall'

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-5 w-5 fill-current">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.8 19.4a7.5 7.5 0 0 1 14.4 0" strokeLinecap="round" />
    </svg>
  )
}

function UserMenu({ session, loading }: { session: Session | null; loading: boolean }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const authed = session?.authenticated === true
  const user = authed ? session.user : null

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-label="Account"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
      >
        <UserIcon />
        {authed && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-slate-950"
          />
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-64 rounded-lg border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {loading ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Checking session…</p>
          ) : user ? (
            <>
              <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {user.email ?? user.id}
              </p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Role: {user.role ?? 'member'}
              </p>
              {user.role === 'admin' && (
                <Link
                  to="/admin"
                  onClick={() => setOpen(false)}
                  className="mt-3 block text-sm text-blue-600 hover:underline dark:text-blue-400"
                >
                  Admin dashboard →
                </Link>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-slate-500 dark:text-slate-400">Not signed in.</p>
              <button
                type="button"
                onClick={() => {
                  window.location.href = adminLoginUrl(window.location.href)
                }}
                className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700"
              >
                Sign in
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return (
    'text-sm font-medium transition-colors ' +
    (isActive
      ? 'text-blue-600 dark:text-blue-400'
      : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100')
  )
}

export function AppHeader() {
  const { session, loading } = useSession()
  const isAdmin = session?.authenticated === true && session.user.role === 'admin'

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-6">
        <nav className="flex items-center gap-5">
          <Link
            to="/"
            className="font-semibold tracking-tight text-slate-900 dark:text-slate-100"
          >
            Recall
          </Link>
          {isAdmin && (
            <>
              <NavLink to="/admin" end className={navLinkClass}>
                Admin
              </NavLink>
              <NavLink to="/admin/conversations" className={navLinkClass}>
                Conversations
              </NavLink>
            </>
          )}
        </nav>

        <div className="flex items-center gap-1">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="View source on GitHub"
            className="rounded-md p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            <GitHubIcon />
          </a>
          <UserMenu session={session} loading={loading} />
        </div>
      </div>
    </header>
  )
}
