import { useState } from 'react'
import { Routes, Route, Navigate, Link } from 'react-router-dom'
import { useSession, adminLoginUrl, logout } from './lib/session'
import { useReadingWidth } from './lib/useReadingWidth'
import { useTheme } from './lib/useTheme'
import type { WidthLevel } from './lib/width'
import type { ThemeChoice } from './lib/theme'
import { WidthControl } from './components/WidthControl'
import { ThemeToggle } from './components/ThemeToggle'
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
      <div className="flex min-h-svh items-center justify-center text-slate-400 dark:text-slate-500">
        <span>Loading…</span>
      </div>
    )
  }

  if (!session?.authenticated) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
        <div className="flex items-center gap-3">
          <RivuletMark />
          <span className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">Rivulet</span>
        </div>
        <p className="max-w-sm text-slate-500 dark:text-slate-400">
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

/** Thin sticky header — hamburger (mobile) + wordmark + theme + reading-width control + account. */
function Header({
  email,
  widthLevel,
  onWidthChange,
  onMenuClick,
  themeChoice,
  onThemeChange,
}: {
  email?: string
  widthLevel: WidthLevel
  onWidthChange: (level: WidthLevel) => void
  /** Open the mobile nav drawer; the button is hidden at `lg` and up (#135). */
  onMenuClick: () => void
  themeChoice: ThemeChoice
  onThemeChange: (choice: ThemeChoice) => void
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
      <div className="flex h-14 items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onMenuClick}
            aria-label="Open menu"
            className="-ml-1.5 rounded-lg p-1.5 text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 lg:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="20" y2="17" />
            </svg>
          </button>
          <Link
            to="/"
            aria-label="Rivulet — go to the river"
            className="flex items-center gap-2.5 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <RivuletMark />
            <span className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">Rivulet</span>
          </Link>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
          <ThemeToggle choice={themeChoice} onChange={onThemeChange} />
          <WidthControl level={widthLevel} onChange={onWidthChange} />
          {email && <span className="hidden sm:inline">{email}</span>}
          <button
            type="button"
            onClick={() => {
              void logout()
            }}
            className="rounded-lg px-3 py-1.5 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
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
  const { choice, setChoice } = useTheme()
  // Mobile nav-drawer state lives here so the header hamburger can open it and
  // ReaderApp can render + close it (#135).
  const [menuOpen, setMenuOpen] = useState(false)
  // On desktop the shell is a fixed-height column (`lg:h-svh` + `overflow-hidden`)
  // so the page/body doesn't scroll — the reading surface fills the viewport
  // below the sticky header and each pane scrolls internally (#140). On mobile it
  // falls back to `min-h-svh` with normal page scroll.
  return (
    <div className="flex min-h-svh flex-col bg-slate-50 lg:h-svh lg:overflow-hidden dark:bg-slate-950">
      <Header
        email={email}
        widthLevel={level}
        onWidthChange={setLevel}
        onMenuClick={() => setMenuOpen(true)}
        themeChoice={choice}
        onThemeChange={setChoice}
      />
      <main className="flex flex-1 flex-col lg:min-h-0">
        <ReaderApp
          containerClass={preset.container}
          measureClass={preset.measure}
          drawerOpen={menuOpen}
          onDrawerOpenChange={setMenuOpen}
        />
      </main>
    </div>
  )
}

function App() {
  // Every navigable state is a route, and each renders the same <AppShell/> so
  // the shell + the loaded feeds/items in ReaderApp stay mounted across
  // navigation (React reconciles the identical element type in place). The view
  // is derived from the pathname and the folder / feed / item ids from the
  // dynamic segments (see lib/route.ts). Item forms nest under their view so an
  // open item carries its context; genuinely unmatched paths redirect to the
  // river. (#144)
  return (
    <Gate>
      <Routes>
        <Route index element={<AppShell />} />
        <Route path="item/:itemId" element={<AppShell />} />
        <Route path="all" element={<AppShell />} />
        <Route path="all/item/:itemId" element={<AppShell />} />
        <Route path="starred" element={<AppShell />} />
        <Route path="starred/item/:itemId" element={<AppShell />} />
        <Route path="folder/:folder" element={<AppShell />} />
        <Route path="folder/:folder/item/:itemId" element={<AppShell />} />
        <Route path="feed/:feedId" element={<AppShell />} />
        <Route path="feed/:feedId/item/:itemId" element={<AppShell />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Gate>
  )
}

export default App
