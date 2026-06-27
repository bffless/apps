import { useEffect } from 'react'
import { Routes, Route, Navigate, Outlet, useLocation, Link } from 'react-router-dom'
import { HandoffHome } from './pages/HandoffHome'
import { HandoffViewer } from './pages/HandoffViewer'
import { HandoffFolder } from './pages/HandoffFolder'
import { ShareLinkEntry } from './pages/ShareLinkEntry'
import { useState } from 'react'
import { useSession, adminLoginUrl } from './lib/session'
import { useTheme } from './lib/theme'
import { Menu } from './components/Menu'
import { FolderTree } from './components/FolderTree'
import { Toaster } from './components/Toaster'
import { SunIcon, MoonIcon, ChevronDownIcon, XIcon } from './components/icons'

function BarsIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <path fillRule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 5A.75.75 0 0 1 2.75 9h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 9.75Zm0 5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z" clipRule="evenodd" />
    </svg>
  )
}

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const dark = theme === 'dark'
  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? 'Switch to light' : 'Switch to dark'}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {dark ? <MoonIcon className="h-5 w-5" /> : <SunIcon className="h-5 w-5" />}
    </button>
  )
}

function HandoffMark() {
  // The favicon glyph, inlined so it inherits the accent and scales crisply.
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-600 text-white shadow-sm">
      <svg viewBox="0 0 32 32" className="h-[18px] w-[18px]" fill="none" aria-hidden="true">
        <path d="M11 20h9.2" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M17.4 16.2 21.8 20l-4.4 3.8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9 8.5A1.5 1.5 0 0 1 10.5 7h6.2a1.5 1.5 0 0 1 1.06.44l2.3 2.3A1.5 1.5 0 0 1 20.5 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
      </svg>
    </span>
  )
}

function AccountMenu({ email }: { email?: string }) {
  const label = email ?? 'Account'
  const initial = label.trim().charAt(0).toUpperCase() || '?'
  return (
    <Menu
      label="Account"
      align="end"
      items={[
        { heading: label },
        'separator',
        { label: 'Sign out', onSelect: () => { window.location.href = '/_bffless/auth/logout' } },
      ]}
      trigger={({ ref, onClick, onKeyDown, ...aria }) => (
        <button
          type="button"
          ref={ref as React.Ref<HTMLButtonElement>}
          onClick={onClick}
          onKeyDown={onKeyDown}
          {...aria}
          title={label}
          className="flex items-center gap-1.5 rounded-lg p-0.5 pr-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-100 text-sm font-semibold text-accent-700">
            {initial}
          </span>
          <ChevronDownIcon className="h-4 w-4" />
        </button>
      )}
    />
  )
}

/**
 * App shell. Handoff owns the whole app at root, so this is a thin sticky bar
 * (wordmark + theme toggle + account) over the page `<Outlet>`.
 */
function Shell() {
  const { session, loading } = useSession()
  const { pathname } = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Folder tree only makes sense on listing routes (not the viewer).
  const showTree = pathname === '/' || pathname.startsWith('/folder/')

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrawerOpen(false)
  }, [pathname])

  return (
    <div className="flex min-h-svh flex-col bg-bg">
      <ScrollToTop />
      <header
        className="sticky top-0 border-b border-border bg-surface/80 backdrop-blur"
        style={{ zIndex: 'var(--z-sticky)' }}
      >
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-1.5">
            {showTree && (
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open folders"
                className="-ml-1 flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink lg:hidden"
              >
                <BarsIcon />
              </button>
            )}
            <Link to="/" className="flex items-center gap-2.5 no-underline">
              <HandoffMark />
              <span className="wordmark text-lg">Handoff</span>
            </Link>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            {!loading && session?.authenticated && <AccountMenu email={session.user.email} />}
            {!loading && !session?.authenticated && (
              <button
                type="button"
                onClick={() => {
                  window.location.href = adminLoginUrl(window.location.href)
                }}
                className="ml-1 rounded-lg bg-accent-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-700"
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        {showTree && (
          <aside className="hidden w-64 shrink-0 border-r border-border bg-surface-2/40 lg:block">
            <div className="sticky top-14 max-h-[calc(100svh-3.5rem)] overflow-y-auto p-3">
              <FolderTree />
            </div>
          </aside>
        )}
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      {/* Mobile folder drawer */}
      {showTree && drawerOpen && (
        <div className="lg:hidden" style={{ zIndex: 'var(--z-modal)', position: 'fixed', inset: 0 }}>
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute left-0 top-0 flex h-full w-72 flex-col bg-surface shadow-lg">
            <div className="flex items-center justify-between border-b border-border px-3 py-3">
              <span className="wordmark">Handoff</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close folders"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <FolderTree />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function App() {
  return (
    <>
      <Routes>
        {/* /s/:token — public share-link entry, no auth required, no Shell chrome */}
        <Route path="s/:token" element={<ShareLinkEntry />} />
        <Route element={<Shell />}>
          <Route index element={<HandoffHome />} />
          <Route path="view/:id" element={<HandoffViewer />} />
          <Route path="folder/:id" element={<HandoffFolder />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  )
}

export default App
