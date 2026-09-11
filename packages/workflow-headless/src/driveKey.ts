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

/**
 * Same-origin API paths the header rides on: the SPA's runs/post and every read/write
 * in resume mode, the run page's file loads. Tests `url.pathname` only, deliberately —
 * scoping to the harness origin too would silently drop the key on a harness redirect,
 * and a dropped key is a 409, worse than a header sent one hop too far. The bucket is
 * never matched not because it's a different origin but because no presigned URL's path
 * begins `/api/`: the harness mints keys under `workflows/<impl>/<workflow>/<scope>/`
 * (`apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/files/prepare/post/rule.yaml:11`),
 * so a virtual-host URL is `/workflows/…` and a path-style one is `/<bucket>/workflows/…`.
 */
export const isHarnessApiPath = (url: URL): boolean => /^\/api\/(workflow|uploads)\//.test(url.pathname)

export async function installDriveKey(page: PageLike, key: string): Promise<void> {
  await page.route(isHarnessApiPath, async (route: RouteLike) => {
    try {
      await route.continue({ headers: { ...route.request().headers(), [DRIVE_KEY_HEADER]: key } })
    } catch {
      // The SPA polls `/api/workflow/run` continuously, and the driver closes the
      // page/browser the moment a run goes terminal — so a `continue()` can lose the
      // race and reject with a `TargetClosedError` for a request that no longer
      // matters. Playwright rethrows that out of this handler; left uncaught it's an
      // unhandled rejection that aborts the Node process on an otherwise-successful
      // run. The request died with the page it belonged to — nothing to do here.
    }
  })
}
