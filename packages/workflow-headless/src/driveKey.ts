/**
 * `WORKFLOW_DRIVE_KEY` / `--drive-key` → `x-workflow-drive-key` on every
 * request the driven page makes.
 *
 * Spec 11, D28 (Attribution: a claim, not a stub row): a run dispatched from
 * the MCP endpoint is created by the *driver's* identity, not the
 * requester's, because `runs/post` runs inside the browser this package
 * opens. The harness hands the driver a per-run nonce
 * (`client_payload.drive_key`) so it can tie the run back to whoever asked
 * for it — but only if every request the *page* makes carries it, not just
 * this driver's own `api.ts` calls. `runs/post` in particular is issued by
 * the harness SPA itself, never by `api.ts`, so the header has to be
 * injected at the page level with a Playwright route, not in `headersFor`.
 *
 * Harmless without a key: `installDriveKey` is only ever called when one is
 * set (`run.ts`, `resume.ts`), so no key means no route and no behaviour
 * change — which is why this ships ahead of the harness change that reads
 * the header.
 */
import type { PageLike, RouteLike } from './page.js'

export const DRIVE_KEY_HEADER = 'x-workflow-drive-key'

/** Same-origin API paths the header rides on: the SPA's runs/post and every read/write in resume mode, the run page's file loads. Never the bucket (different origin, never matched). */
export const isHarnessApiPath = (url: URL): boolean => /^\/api\/(workflow|uploads)\//.test(url.pathname)

export async function installDriveKey(page: PageLike, key: string): Promise<void> {
  await page.route(isHarnessApiPath, async (route: RouteLike) => {
    await route.continue({ headers: { ...route.request().headers(), [DRIVE_KEY_HEADER]: key } })
  })
}
