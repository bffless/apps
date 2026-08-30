/**
 * M1: the first-success checkpoint. A faithful port of `m1()` in
 * `localdev-tools/workflow-live.mjs` — Hello workflow → Finish → succeeded.
 */
import { openSession } from '../session.js'
import { credentials } from '../env.js'
import type { Walk } from './index.js'

export const m1: Walk = async ({ args, env, report }) => {
  const creds = credentials(env)
  if (!creds) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing')
  const s = await openSession({ base: args.harness, out: args.out, credentials: creds })
  try {
    const { page } = s
    await s.shot('01-landing')
    const impls = page.getByTestId('implementations')
    await impls.waitFor({ timeout: 30_000 })
    report.expect('discovery.listsHello', /hello/i.test((await impls.textContent()) ?? ''), await impls.textContent())
    await page.getByRole('link', { name: /hello/i }).first().click()
    await page.getByTestId('workflow-list').getByRole('link', { name: 'Hello workflow' }).click()
    await page.getByTestId('step').first().waitFor()
    await page.getByRole('link', { name: /start a run/i }).click()
    await page.getByTestId('kickoff-form').waitFor()
    await page.getByTestId('kickoff-start').click()
    await page.getByTestId('run-status').waitFor()
    report.run(page.url().split('/').pop() ?? '')
    await page.waitForFunction(() => document.querySelector('[data-testid="step"][data-key="confirm/0/review"]')?.getAttribute('data-state') === 'waiting', null, { timeout: 120_000 })
    await page.getByTestId('form-step').waitFor({ timeout: 30_000 })
    await s.shot('05-waiting-form')
    await page.getByRole('button', { name: 'Finish' }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="run-status"]')?.getAttribute('data-state') === 'succeeded', null, { timeout: 60_000 })
    const outputs = (await page.getByTestId('run-outputs').textContent()) ?? ''
    await s.shot('06-succeeded')
    report.expect('run.succeededWithOutputs', /report/.test(outputs) && /poster/.test(outputs) && /lines/.test(outputs) && /Hello, world!/.test(outputs), outputs.slice(0, 200))
    report.expect('page.noConsoleErrors', s.consoleErrors.length === 0, s.consoleErrors)
    report.expect('page.noFailedRequests', s.failed.length === 0, s.failed)
  } finally { await s.close() }
}
