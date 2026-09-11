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
import type { BrowserLike, ConsoleMessageLike, PageLike, RouteLike } from '../src/page.js'

/** One canned answer to an in-page `fetch`, keyed by `pathname + search`. */
export interface Route {
  status: number
  text?: string
}

export interface FakeOptions {
  /** Successive `window.__workflow` reads; the last entry repeats forever. */
  globals: Array<Partial<Snapshot> | undefined>
  /** An array is successive answers to the same key; the last entry repeats forever. */
  routes?: Record<string, Route | Route[]>
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
  /**
   * What `page.request.post` answers the app-token exchange with. The
   * default is CE's 200 — the user object `signin` returns.
   */
  exchange?: { status: number; text?: string }
}

export interface FakePage extends PageLike {
  gotos: string[]
  clicks: string[]
  screenshots: string[]
  fetched: string[]
  /** Every in-page fetch with the headers it carried, in order — what `fetched` keys. */
  requests: Array<{ key: string; method: string; headers: Record<string, string> }>
  /** What went through the context's request client (the app-token exchange). */
  posts: Array<{ url: string; headers: Record<string, string> | undefined }>
  globalReads: number
  /** Every `page.route(...)` install, in order — `driveKey.ts`'s only caller. */
  routes: Array<{ matcher: (url: URL) => boolean; handler: (route: RouteLike) => Promise<void> }>
}

/** Discovery for `hello/demo`, plus the run record `run.json` is written from. */
export function helloRoutes(status: string, runId = 'run_1'): Record<string, Route | Route[]> {
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
    // `impl`/`workflow` are on the row because `resume` has nothing else to go
    // on: a run id alone does not say which run page to open.
    [`/api/workflow/run?id=${runId}`]: {
      status: 200,
      text: JSON.stringify({
        run: { runId, status, impl: 'hello', workflow: 'demo', outputs: {} },
        steps: [],
      }),
    },
  }
}

/**
 * A synthetic Playwright `route` callback, for calling an installed
 * `driveKey.ts` handler directly. Shared by `cli.test.ts`, `run.test.ts` and
 * `resume.test.ts`, which otherwise each carried an identical copy.
 */
export function fakeRoute(headers: Record<string, string> = {}) {
  const calls: Array<{ headers?: Record<string, string> } | undefined> = []
  const route: RouteLike = {
    request: () => ({ headers: () => headers }),
    continue: async (overrides) => {
      calls.push(overrides)
    },
  }
  return { route, calls }
}

export function fakeBrowser(o: FakeOptions): { browser: BrowserLike; page: FakePage } {
  const consoleHandlers: Array<(message: ConsoleMessageLike) => void> = []
  let emitted = false

  const page = {
    gotos: [] as string[],
    clicks: [] as string[],
    screenshots: [] as string[],
    fetched: [] as string[],
    requests: [] as FakePage['requests'],
    posts: [] as FakePage['posts'],
    globalReads: 0,
    routes: [] as FakePage['routes'],

    request: {
      async post(url: string, options?: { headers?: Record<string, string> }) {
        page.posts.push({ url, headers: options?.headers })
        const answer = o.exchange ?? { status: 200, text: JSON.stringify({ id: 'member-1' }) }
        return { status: () => answer.status, text: async () => answer.text ?? '' }
      },
    },

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
      const request = arg as { url: string; method: string; headers: Record<string, string> }
      const parsed = new URL(request.url)
      const key = `${parsed.pathname}${parsed.search}`
      page.fetched.push(key)
      page.requests.push({ key, method: request.method, headers: request.headers })
      const answers = o.routes?.[key]
      const nth = (page.fetched.filter((k) => k === key).length) - 1
      const route = Array.isArray(answers)
        ? answers[Math.min(nth, answers.length - 1)]
        : answers
      return {
        status: route?.status ?? 404,
        text: route?.text ?? '',
        base64: '',
        error: null,
      }
    },

    // Nowhere until the first navigation — how a refused exchange is told apart from a stuck relay form.
    url: () => (page.gotos.length === 0 ? 'about:blank' : o.login === 'stuck' ? 'https://admin.test/login' : 'https://harness.test/'),
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
    async route(matcher: (url: URL) => boolean, handler: (route: RouteLike) => Promise<void>) {
      page.routes.push({ matcher, handler })
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
