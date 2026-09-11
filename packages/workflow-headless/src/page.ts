/**
 * The Playwright seam.
 *
 * Every module below this one talks to a `PageLike`, never to Playwright, for
 * one reason: the unit suite must not launch a browser. `browser.ts` is the
 * single place that imports `playwright` (lazily, so `--help` costs nothing),
 * and it casts the real `Page` to this interface — Playwright's own generic
 * signatures (`evaluate<R, Arg>`) do not structurally satisfy a hand-written
 * one, and a cast at the boundary is honest about that rather than spreading
 * `any` through the driver.
 */

export interface ConsoleMessageLike {
  type(): string
  text(): string
}

/** The slice of Playwright's `APIResponse` a login needs. */
export interface ResponseLike {
  status(): number
  text(): Promise<string>
}

/**
 * The slice of Playwright's `APIRequestContext` the driver uses — `page.request`.
 * It shares the browser context's cookie jar, which is the one property that
 * matters: a `Set-Cookie` on its response is a cookie the page's own `fetch`
 * sends from then on. Everything *else* the driver does stays an in-page
 * `fetch` (see `api.ts`) — this is only for the call that has to happen
 * before there is a signed-in page to fetch from.
 */
export interface RequestLike {
  post(url: string, options?: { headers?: Record<string, string> }): Promise<ResponseLike>
}

/**
 * The slice of Playwright's intercepted `Route` that `driveKey.ts` needs —
 * enough to read the request's own headers and continue it with an added
 * one. Playwright's real `Route` satisfies this structurally.
 */
export interface RouteLike {
  request(): { headers(): Record<string, string> }
  continue(overrides?: { headers?: Record<string, string> }): Promise<void>
}

export interface PageLike {
  /** The context's request client; `loginViaAppToken` is its only caller. */
  request: RequestLike
  goto(
    url: string,
    options?: { waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle'; timeout?: number },
  ): Promise<unknown>
  /** Runs `fn` in the page. The argument must be structured-cloneable. */
  evaluate<Ret, Arg = undefined>(fn: (arg: Arg) => Ret | Promise<Ret>, arg?: Arg): Promise<Ret>
  url(): string
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>
  click(selector: string, options?: { timeout?: number }): Promise<void>
  waitForURL(predicate: (url: URL) => boolean, options?: { timeout?: number }): Promise<void>
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>
  on(event: 'console', handler: (message: ConsoleMessageLike) => void): void
  on(event: 'pageerror', handler: (error: Error) => void): void
  /**
   * Intercepts every request whose URL the matcher accepts, so the handler
   * can rewrite its headers before it goes out. `driveKey.ts`'s only caller —
   * an in-page seam (unlike `RequestLike`, which is the context's client),
   * because it has to catch the harness SPA's own `fetch`/`XHR` calls, not
   * just this driver's.
   */
  route(matcher: (url: URL) => boolean, handler: (route: RouteLike) => Promise<void>): Promise<unknown>
  close(): Promise<void>
}

export interface BrowserLike {
  newPage(options?: { viewport?: { width: number; height: number } }): Promise<PageLike>
  close(): Promise<void>
}
