/**
 * Hello: Task 25 Step 1 — the first walk in `ALL_ORDER`. Confirms hello is
 * discoverable through the generated forwarder, runs the interactive hello
 * workflow to completion (island step + review form), and checks two
 * cross-cutting decisions on the way: the poster viewer's `<img>` draws a
 * presigned URL with no credentials (Decision 6), and the card-drawing
 * script ran in a sandboxed Worker with an opaque origin (Decision 4) — the
 * latter needs bffless/workflow-hello#5 merged + deployed, and is recorded
 * as a FAIL with evidence "log line absent" until then.
 */
import { openSession } from '../session.js'
import { credentials } from '../env.js'
import type { Walk } from './index.js'

const waitState = (page: import('playwright').Page, key: string, want: string, timeout: number) =>
  page.waitForFunction(([k, w]) => document.querySelector(`[data-testid="step"][data-key="${k}"]`)?.getAttribute('data-state') === w, [key, want], { timeout })

export const hello: Walk = async ({ args, env, report }) => {
  const creds = credentials(env)
  if (!creds) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing')
  const s = await openSession({ base: args.harness, out: args.out, credentials: creds })
  try {
    const { page } = s
    // Step 1a — discovery lists hello through the generated forwarder
    const impls = page.getByTestId('implementations')
    await impls.waitFor({ timeout: 30_000 })
    const probes = s.log.filter((l) => /\/w\/hello\/\.bffless\/workflows\/index\.json/.test(l))
    report.expect('D5.helloDiscoveredViaForwarder', /hello/i.test((await impls.textContent()) ?? '') && probes.some((l) => l.startsWith('200 ')), probes)
    await page.getByRole('link', { name: /hello/i }).first().click()
    await page.getByTestId('workflow-list').getByRole('link', { name: 'Interactive hello' }).click()
    await page.getByTestId('step').first().waitFor()
    await page.getByRole('link', { name: /start a run/i }).click()
    await page.getByTestId('kickoff-form').waitFor()
    await page.getByTestId('kickoff-start').click()
    await page.getByTestId('run-status').waitFor()
    const runId = page.url().split('/').pop() ?? ''
    report.run(runId)
    // Step 1b — the island step, submitted
    await waitState(page, 'pick/0/choose', 'waiting', 120_000)
    const island = page.locator('[data-testid="island-display"] [data-testid="island-frame"]').contentFrame()
    await island.getByTestId('line').first().waitFor({ timeout: 30_000 })
    await island.getByTestId('line').first().click()
    await island.getByTestId('submit').click()
    await waitState(page, 'review/0/confirm', 'waiting', 120_000)
    await page.locator('[data-testid="step"][data-key="review/0/confirm"]').click()
    const form = page.getByTestId('form-step')
    await form.waitFor()
    await form.getByTestId('tile-picker').getByTestId('tile').first().click()
    await form.getByRole('button', { name: 'Approve' }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="run-status"]')?.getAttribute('data-state') === 'succeeded', null, { timeout: 120_000 })
    report.expect('run.succeeded', (await page.getByTestId('run-status').getAttribute('data-state')) === 'succeeded', runId)
    await s.shot('07-succeeded')
    // Step 1c — Decision 6: the poster viewer draws a presigned URL, credential-less
    const viewers = page.locator('[data-testid="renderer"][data-render="island"] [data-testid="island-frame"]')
    await viewers.first().waitFor({ timeout: 30_000 })
    const posterFrame = viewers.nth(1).contentFrame()
    const img = posterFrame.locator('img').first()
    await img.waitFor({ timeout: 30_000 })
    const src = (await img.getAttribute('src')) ?? ''
    const natural = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)
    const presigned = /^https?:\/\//.test(src) && !src.startsWith(args.harness) && /X-Goog-Signature=|X-Amz-Signature=|[?&]sig(nature)?=/.test(src)
    report.expect('D6.viewerImgIsPresigned', presigned && natural > 0, { src: src.slice(0, 120), naturalWidth: natural })
    report.expect('D6.noSignError', ((await page.getByTestId('island-sign-error').textContent().catch(() => '')) ?? '') === '', 'island-sign-error empty')
    // Step 1d — Decision 4: the script ran in a sandboxed Worker (opaque origin)
    await page.locator('[data-testid="step"][data-key="card/0/draw"]').click()
    await page.getByTestId('step-pane').getByRole('tab', { name: 'Output' }).click()
    const scriptLog = (await page.getByTestId('script-log').textContent().catch(() => '')) ?? ''
    const originLine = scriptLog.match(/origin=(\S+)/)?.[1]
    report.expect('D4.scriptSandboxed', originLine === 'null', originLine ? { origin: originLine } : 'log line absent — needs bffless/workflow-hello PR merged + deployed')
    report.expect('page.noConsoleErrors', s.consoleErrors.length === 0, s.consoleErrors)
  } catch (e) {
    await s.shot('99-failed')
    throw e
  } finally {
    await s.close()
  }
}
