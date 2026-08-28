/**
 * A `BrowserLike` with no browser behind it.
 *
 * `run.ts` and `cli.ts` are the two modules that only exist as a whole — the
 * exit codes are a property of the flow, not of any function in it — so their
 * tests drive the *real* functions and replace only the seam the package was
 * built around: `PageLike`/`BrowserLike`. Nothing here re-implements the
 * driver; the page just answers two questions, `window.__workflow` and an
 * in-page `fetch`, the way a harness would.
 */
import { writeFileSync } from 'node:fs'
import type { Snapshot } from '../src/observe.js'
import type { BrowserLike, ConsoleMessageLike, PageLike } from '../src/page.js'

/** One canned answer to an in-page `fetch`, keyed by `pathname + search`. */
export interface Route {
  status: number
  text?: string
}

export interface FakeOptions {
  /** Successive `window.__workflow` reads; the last entry repeats forever. */
  globals: Array<Partial<Snapshot> | undefined>
  routes?: Record<string, Route>
  /** Run just before the n-th (1-based) global read answers — the test's clock. */
  onGlobalRead?: (n: number) => void
  /** Console lines the page emits on its first navigation. */
  consoleLines?: string[]
  /**
   * `'stuck'` makes the page sit on the relay's `/login` and never come back —
   * a bot challenge, a wrong password, a changed form. The default signs in.
   */
  login?: 'ok' | 'stuck'
  /** What the page reports as `document.title | innerText` for the login diagnostic. */
  pageText?: string
}

export interface FakePage extends PageLike {
  gotos: string[]
  clicks: string[]
  screenshots: string[]
  fetched: string[]
  globalReads: number
}

/** Discovery for `hello/demo`, plus the run record `run.json` is written from. */
export function helloRoutes(status: string, runId = 'run_1'): Record<string, Route> {
  return {
    '/w/hello/.bffless/workflows/index.json': {
      status: 200,
      text: JSON.stringify({
        workflows: [{ file: 'demo.workflow.yaml', name: 'Demo', headlessSafe: true }],
      }),
    },
    '/w/hello/.bffless/workflows/demo.workflow.yaml': {
      status: 200,
      text: 'name: Demo\non:\n  manual:\n    inputs: {}\n',
    },
    [`/api/workflow/run?id=${runId}`]: {
      status: 200,
      text: JSON.stringify({ run: { runId, status, outputs: {} }, steps: [] }),
    },
  }
}

export function fakeBrowser(o: FakeOptions): { browser: BrowserLike; page: FakePage } {
  const consoleHandlers: Array<(message: ConsoleMessageLike) => void> = []
  let emitted = false

  const page = {
    gotos: [] as string[],
    clicks: [] as string[],
    screenshots: [] as string[],
    fetched: [] as string[],
    globalReads: 0,

    async goto(url: string) {
      page.gotos.push(url)
      if (!emitted) {
        emitted = true
        for (const line of o.consoleLines ?? []) {
          for (const handler of consoleHandlers) {
            handler({ type: () => 'log', text: () => line })
          }
        }
      }
      return null
    },

    async evaluate(_fn: unknown, arg?: unknown) {
      // Two no-argument evaluates exist: the login diagnostic reads the page's
      // own title and text, everything else is `readGlobal`.
      if (arg === undefined && /document\.title/.test(String(_fn))) {
        return o.pageText ?? 'Just a moment… | Checking your browser'
      }
      // No argument is `readGlobal`; an argument is the in-page fetch (api.ts).
      if (arg === undefined) {
        page.globalReads += 1
        o.onGlobalRead?.(page.globalReads)
        return o.globals[Math.min(page.globalReads - 1, o.globals.length - 1)]
      }
      const request = arg as { url: string }
      const parsed = new URL(request.url)
      const key = `${parsed.pathname}${parsed.search}`
      page.fetched.push(key)
      const route = o.routes?.[key]
      return {
        status: route?.status ?? 404,
        text: route?.text ?? '',
        base64: '',
        error: null,
      }
    },

    url: () => (o.login === 'stuck' ? 'https://admin.test/login' : 'https://harness.test/'),
    async fill() {},
    async click(selector: string) {
      page.clicks.push(selector)
    },
    async waitForURL() {
      // The relay bounce resolves either way; only the return trip hangs.
      if (o.login === 'stuck' && page.clicks.includes('button[type="submit"]')) {
        throw new Error('page.waitForURL: Timeout 30000ms exceeded.')
      }
    },
    async screenshot(options: { path: string }) {
      page.screenshots.push(options.path)
      writeFileSync(options.path, 'png')
      return null
    },
    on(event: string, handler: (value: never) => void) {
      if (event === 'console') consoleHandlers.push(handler as (m: ConsoleMessageLike) => void)
    },
    async close() {},
  } as unknown as FakePage

  const browser: BrowserLike = {
    async newPage() {
      return page
    },
    async close() {},
  }
  return { browser, page }
}
