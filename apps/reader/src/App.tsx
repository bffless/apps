import { Routes, Route, Navigate } from 'react-router-dom'
import { useSession, adminLoginUrl, logout } from './lib/session'
import { useReadingWidth } from './lib/useReadingWidth'
import type { WidthLevel } from './lib/width'
import { WidthControl } from './components/WidthControl'
import { ReaderApp } from './ReaderApp'

/** The Rivulet wordmark glyph — three flowing streams, matching the favicon. */
function RivuletMark() {
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white">
      <svg viewBox="0 0 32 32" className="h-5 w-5" aria-hidden="true">
        <path d="M6 11c4 0 4 2.5 8 2.5S18 11 22 11s4 2.5 4 2.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M6 16c4 0 4 2.5 8 2.5S18 16 22 16s4 2.5 4 2.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.8" />
        <path d="M6 21c4 0 4 2.5 8 2.5S18 21 22 21s4 2.5 4 2.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.6" />
      </svg>
    </span>
  )
}

/**
 * Login gate. Rivulet is personal + single-user per deploy (D1), so there is no
 * public surface in v1 (D11): an unauthenticated visitor gets a sign-in prompt
 * that bounces through the admin login relay; an authenticated user reaches the
 * app shell. The `/api/*` proxy rules are additionally guarded server-side by
 * SuperTokens `SessionAuthGuard`, so this gate is UX, not the security boundary.
 */
function Gate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession()

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center text-slate-400">
        <span>Loading…</span>
      </div>
    )
  }

  if (!session?.authenticated) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
        <div className="flex items-center gap-3">
          <RivuletMark />
          <span className="text-2xl font-semibold tracking-tight text-slate-900">Rivulet</span>
        </div>
        <p className="max-w-sm text-slate-500">
          A quiet RSS reader. Sign in to read your feeds.
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

  return <>{children}</>
}

/** Thin sticky header — wordmark + reading-width control + account. */
function Header({
  email,
  widthLevel,
  onWidthChange,
}: {
  email?: string
  widthLevel: WidthLevel
  onWidthChange: (level: WidthLevel) => void
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="flex h-14 items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <RivuletMark />
          <span className="text-lg font-semibold tracking-tight text-slate-900">Rivulet</span>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <WidthControl level={widthLevel} onChange={onWidthChange} />
          {email && <span className="hidden sm:inline">{email}</span>}
          <button
            type="button"
            onClick={() => {
              void logout()
            }}
            className="rounded-lg px-3 py-1.5 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}

/** The app shell an authenticated user lands on: header + the reading surface. */
function AppShell() {
  const { session } = useSession()
  const email = session?.authenticated ? session.user.email : undefined
  const { level, setLevel, preset } = useReadingWidth()
  return (
    <div className="flex min-h-svh flex-col bg-slate-50">
      <Header email={email} widthLevel={level} onWidthChange={setLevel} />
      <main className="flex flex-1 flex-col">
        <ReaderApp containerClass={preset.container} measureClass={preset.measure} />
      </main>
    </div>
  )
}

function App() {
  return (
    <Gate>
      <Routes>
        <Route index element={<AppShell />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Gate>
  )
}

export default App
