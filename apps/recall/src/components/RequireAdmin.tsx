/**
 * Gate for `/admin/*` (Task 5). Recall's `/api/*` rules already enforce
 * `auth_required { roles: ['admin'] }` server-side — that's the real security
 * boundary — but without a client-side gate an unauthenticated visitor would
 * hit a wall of failed requests instead of a clear sign-in prompt. Mirrors the
 * shape of Reader's `Gate` in `App.tsx`.
 */

import type { ReactNode } from 'react'
import { useSession, adminLoginUrl } from '../lib/auth'

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, loading } = useSession()

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center text-slate-400 dark:text-slate-500">
        <span>Loading…</span>
      </div>
    )
  }

  if (!session?.authenticated) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Recall admin
        </h1>
        <p className="max-w-sm text-slate-500 dark:text-slate-400">
          Sign in with an admin account to manage videos.
        </p>
        <button
          type="button"
          onClick={() => {
            window.location.href = adminLoginUrl(window.location.href)
          }}
          className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700"
        >
          Sign in
        </button>
      </div>
    )
  }

  if (session.user.role !== 'admin') {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Not authorized
        </h1>
        <p className="max-w-sm text-slate-500 dark:text-slate-400">
          Your account doesn't have admin access to Recall.
        </p>
      </div>
    )
  }

  return <>{children}</>
}
