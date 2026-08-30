/**
 * Interactive: a faithful port of `m2()` in `localdev-tools/workflow-live.mjs`
 * — the M2 Phase 3 walk mirroring `apps/workflow/e2e/interactive.spec.ts`
 * against the live instance, plus the API-level probes CI cannot make
 * (delete 409/403 matrix, the delete 200 body's counts, post-delete 404 vs
 * the surviving inputs/ upload, whoami, ?download=1, the scoped aliases call
 * in the network log). Optional: ADMIN_API_KEY proves the API-key 403 path.
 *
 * Every check name below (`D8.aliasesScoped` … `D7.runGoneFromList`) is kept
 * unchanged from the source — the README rows cite them.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { request as pwRequest } from 'playwright'
import type { FileRef } from '@bffless/workflow-headless'
import { openSession } from '../session.js'
import { credentials, adminKey } from '../env.js'
import type { Walk } from './index.js'

const EXTRA_PNG = fileURLToPath(new URL('../../../../apps/workflow/e2e/fixtures/extra.png', import.meta.url))

export const interactive: Walk = async ({ args, env, report }) => {
  const creds = credentials(env)
  if (!creds) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing')
  const s = await openSession({ base: args.harness, out: args.out, credentials: creds })
  try {
    const { page } = s

    const stateOf = (key: string) => page.locator(`[data-testid="step"][data-key="${key}"]`).getAttribute('data-state')
    const waitState = (key: string, want: string, timeout: number) =>
      page.waitForFunction(
        ([k, w]) => document.querySelector(`[data-testid="step"][data-key="${k}"]`)?.getAttribute('data-state') === w,
        [key, want] as const,
        { timeout },
      )

    await s.shot('01-landing')
    const impls = page.getByTestId('implementations')
    await impls.waitFor({ timeout: 30_000 })
    if (!/hello/i.test((await impls.textContent()) ?? '')) {
      throw new Error(`hello not listed: ${(await impls.textContent()) ?? ''}`)
    }
    await page.getByTestId('implementations').getByRole('link', { name: /^hello$/i }).click()

    // --- Decision 8: discovery is scoped (only the harness's own project is probed)
    const aliasCalls = s.log.filter((l) => /\/api\/workflow\/aliases/.test(l))
    report.expect('D8.aliasesScoped', aliasCalls.length > 0 && aliasCalls.every((l) => /\?repository=bffless%2Fworkflow|\?repository=bffless\/workflow/.test(l)), aliasCalls)
    const probes = s.log.filter((l) => /\/w\/[^/]+\/\.bffless\/workflows\/index\.json/.test(l))
    // The harness's own alias (`workflow`) is probed too — same project, and its SPA fallback answers 200 HTML (no index.json); what must NOT appear is any other project's alias.
    report.expect('D8.noForeignProbes', probes.length > 0 && probes.every((l) => /\/w\/(hello|workflow)\//.test(l)), probes)

    const { status: meStatus, body: meBody } = await s.api.json('/api/workflow/whoami')
    const me = meBody as { id?: string; email?: string; role?: string }
    const meRes = await s.page.request.fetch(s.base + '/api/workflow/whoami')
    const shellWhoami = (await page.getByTestId('whoami').textContent().catch(() => '')) ?? ''
    report.expect('whoami.session', meStatus === 200 && !!me.id && me.email === creds.email && ['admin', 'user', 'member'].includes(me.role ?? ''), { status: meStatus, me, shell: shellWhoami, cacheControl: meRes.headers()['cache-control'] })

    await page.getByTestId('workflow-list').getByRole('link', { name: 'Interactive hello' }).click()
    await page.getByTestId('step').first().waitFor()
    await s.shot('03-definition')
    await page.getByRole('link', { name: /start a run/i }).click()
    await page.getByTestId('kickoff-form').waitFor()
    await page.getByTestId('kickoff-start').click()
    await page.getByTestId('run-status').waitFor()
    const runUrl = page.url()
    const runId = runUrl.split('/').pop() ?? ''
    report.run(runId)
    await s.shot('04-running')

    // --- Decision 9: the island step
    await waitState('pick/0/choose', 'waiting', 120_000)
    const stepFrame = page.locator('[data-testid="island-display"] [data-testid="island-frame"]').contentFrame()
    await stepFrame.getByTestId('words').filter({ hasText: '2 lines · 4 words' }).waitFor({ timeout: 30_000 })
    await s.shot('05-island')
    const firstLine = stepFrame.getByTestId('line').first()
    const firstText = (await firstLine.textContent()) ?? ''
    await firstLine.click()
    await stepFrame.getByTestId('shouted').filter({ hasText: 'HELLO, WORLD!' }).waitFor({ timeout: 30_000 })
    report.expect('D9.echoRoundTrip', /Hello, world!/.test(firstText), { firstText })
    await stepFrame.getByTestId('submit-nothing').click()
    await stepFrame.getByTestId('submit-error').filter({ hasText: 'This field is required' }).waitFor({ timeout: 10_000 })
    report.expect('D9.rejectKeepsWaiting', (await stateOf('pick/0/choose')) === 'waiting', await stateOf('pick/0/choose'))

    // --- Decision 7 (409): a still-running run refuses deletion
    const r409 = await s.api.json('/api/workflow/run/delete', { method: 'POST', body: { id: runId } })
    report.expect('D7.runningIs409', r409.status === 409, { status: r409.status, body: r409.body })
    s.deleteBody = null
    s.deleteStatus = null

    await stepFrame.getByTestId('submit').click()

    // --- Decision 14: the review form
    await waitState('review/0/confirm', 'waiting', 120_000)
    await page.locator('[data-testid="step"][data-key="review/0/confirm"]').click()
    const form = page.getByTestId('form-step')
    await form.waitFor()
    const tiles = form.getByTestId('tile-picker').getByTestId('tile')
    await tiles.first().waitFor()
    const tileCount = await tiles.count()
    await tiles.first().click()
    report.expect('D14.tilePicker', tileCount === 1 && (await tiles.first().getAttribute('aria-checked')) === 'true', { tileCount })
    await form.getByRole('button', { name: 'Preview' }).click()
    await form.getByTestId('markdown-preview').locator('h2').filter({ hasText: 'Notes' }).waitFor()
    const before = s.registered.length
    await form.locator('input[type="file"]').setInputFiles(EXTRA_PNG)
    await form.locator('.field-file-list').filter({ hasText: 'extra.png' }).waitFor({ timeout: 60_000 })
    await Promise.all(s.pending)
    const extraRef: FileRef | undefined = s.registered.slice(before).find((r) => /extra\.png$/.test(r.name || '') || /extra\.png$/.test(r.path || ''))
    report.expect('D14.extraUnderInputs', !!extraRef && /^workflows\/hello\/interactive\/inputs\//.test(extraRef.path), extraRef)
    await s.shot('06-form')
    await form.getByRole('button', { name: 'Approve' }).click()

    await page.waitForFunction(() => document.querySelector('[data-testid="run-status"]')?.getAttribute('data-state') === 'succeeded', null, { timeout: 120_000 })
    await Promise.all(s.pending)
    await s.shot('07-succeeded')
    const outputs = page.getByTestId('run-outputs')
    const outText = (await outputs.textContent()) ?? ''
    report.expect('run.outputsLine', /Hello, world!/.test(outText), outText.slice(0, 200))

    // --- viewer island + annotations
    // Two `render: island` outputs since M3 Phase 3a: `view` (the picked line, json)
    // and `poster_view` (the poster File ref, drawn as a signed <img>) — both through
    // islands/line-viewer.html, in declaration order. An unscoped locator matches
    // both and Playwright's strict mode throws, so take the first and pin the count:
    // a third viewer should fail this walk loudly rather than be silently skipped.
    const viewers = page.locator('[data-testid="renderer"][data-render="island"] [data-testid="island-frame"]')
    await viewers.first().waitFor({ timeout: 30_000 })
    report.expect('M3.twoViewerIslands', (await viewers.count()) === 2, await viewers.count())
    const viewerFrame = viewers.first().contentFrame()
    await viewerFrame.getByTestId('viewer-value').filter({ hasText: 'Hello, world!' }).waitFor({ timeout: 30_000 })
    const ann = (await page.getByTestId('annotations').textContent()) ?? ''
    report.expect('D9.annotateLands', /Previewed Hello, world!/.test(ann) && /card drawn/.test(ann), ann)

    // --- Decision 2/5: script step, poster + big.json under the step prefix
    const runPrefix = `workflows/hello/interactive/runs/${runId}/`
    const runFiles = s.registered.filter((r) => r.path?.startsWith(runPrefix))
    const posters = runFiles.filter((r) => /poster\.svg$/.test(r.path))
    const bigs = runFiles.filter((r) => /big\.json$/.test(r.path))
    report.expect('D2.twoPosterObjects', posters.length === 2 && new Set(posters.map((p) => p.path)).size === 2 && posters.every((p) => p.path.startsWith(`${runPrefix}card/0/draw/`)), posters.map((p) => p.path))
    report.expect('D5.bigJsonUnderStepPrefix', bigs.length === 1 && (bigs[0]?.path ?? '').startsWith(`${runPrefix}card/0/draw/`), bigs.map((b) => b.path))
    const posterHref = (await outputs.locator('[data-output="poster"] .file-card-download').getAttribute('href')) ?? ''
    report.expect('D2.posterDownloadHref', /\/api\/uploads\/workflows\/hello\/interactive\/runs\/.*poster\.svg\?download=1$/.test(posterHref), posterHref)
    const { body: recBody } = await s.api.json(`/api/workflow/run?id=${runId}`)
    const rec = recBody as { steps?: Array<{ key?: string; job?: string; step?: string; outputs?: unknown; output?: unknown }> }
    const drawRow = (rec.steps ?? []).find((row) => row.key === 'card/0/draw' || (row.job === 'card' && row.step === 'draw'))
    const drawOut = (drawRow?.outputs ?? drawRow?.output ?? {}) as Record<string, unknown>
    report.expect('D2.bigIsFilePointerInRow', !!drawOut.big && typeof drawOut.big === 'object' && '$file' in (drawOut.big as object), { big: drawOut.big, keys: Object.keys(drawRow ?? {}) })
    // `big` is a *step* output, not a run-level one (`data-output` names the run's
    // own outputs), and the pane is Input | Output only since apps#384 folded the
    // third `Details` tab into Output. A script's live log and its hydrated
    // `{"$file"}` outputs both ride there, so one click reaches both.
    await page.locator('[data-testid="step"][data-key="card/0/draw"]').click()
    await page.getByTestId('step-pane').getByRole('tab', { name: 'Output' }).click()
    const paneText = (await page.getByTestId('step-pane').textContent().catch(() => '')) ?? ''
    report.expect('run.bigHydrated', /\[12000\]|12000/.test(paneText), paneText.slice(0, 300))
    const scriptLogText = (await page.getByTestId('script-log').textContent().catch(() => '')) ?? ''
    report.expect('D2.scriptLog', /drawing/.test(scriptLogText), 'script-log has "drawing"')

    // --- renderers
    // Each named renderer is declared on the *step* that produces it, so it draws
    // in that step's Output pane, not in the run's outputs: `transcript`/`chart`/
    // `code` on analyze's `run`, `images` on card's `draw` (`posters`). The run's
    // own outputs are line/view/poster/poster_view/cover.
    const pane = page.getByTestId('step-pane')
    const openOutput = async (key: string) => {
      await page.locator(`[data-testid="step"][data-key="${key}"]`).click()
      await pane.getByRole('tab', { name: 'Output' }).click()
    }
    const renderers: Record<string, boolean | number> = {}
    await openOutput('analyze/0/run')
    for (const r of ['transcript', 'chart', 'code']) {
      renderers[r] = await pane.locator(`[data-testid="renderer"][data-render="${r}"]`).first().isVisible().catch(() => false)
    }
    renderers.chartCanvas = await pane.locator('[data-testid="renderer"][data-render="chart"] canvas').count()
    renderers.codeHighlighted = await pane.locator('[data-testid="renderer"][data-render="code"] .hljs, [data-testid="renderer"][data-render="code"] [class*="hljs"]').count()
    await openOutput('card/0/draw')
    renderers.images = await pane.locator('[data-testid="renderer"][data-render="images"]').first().isVisible().catch(() => false)
    renderers.imagesImg = await pane.locator('[data-testid="renderer"][data-render="images"] img').count()
    report.expect('renderers', Object.values(renderers).every((v) => v === true || (typeof v === 'number' && v > 0)), renderers)

    await page.goto(runUrl, { waitUntil: 'networkidle' })
    await outputs.waitFor({ timeout: 30_000 })
    // `cover` is the whole File ref, not a bare path: a `choice` over File refs is
    // *picked* by path but *recorded* as the ref it named (2026-08-26), which is
    // also what M3's headless skip relies on. So it renders as a file card with a
    // download, and the old "path chip, no download" expectation is superseded.
    const coverText = (await outputs.locator('[data-output="cover"]').textContent()) ?? ''
    report.expect('P5.coverIsFileRef', /poster\.svg/.test(coverText) && (await outputs.locator('[data-output="cover"] .file-card-download').count()) === 1, coverText)
    await s.shot('08-outputs')

    // --- apps#362: ?download=1
    if (!posterHref) {
      report.expect('apps362.download', false, 'posterHref empty')
    } else {
      const dl = await s.page.request.fetch(s.base + posterHref)
      const inline = await s.page.request.fetch(s.base + posterHref.replace(/\?download=1$/, ''))
      report.expect('apps362.download', dl.status() === 200, { status: dl.status(), contentDisposition: dl.headers()['content-disposition'] ?? null, contentType: dl.headers()['content-type'], inlineDisposition: inline.headers()['content-disposition'] ?? null })
    }

    // --- Decision 7: pre-delete state, the API-key 403, then the owner delete
    const posterUrls = posters.map((p) => p.url)
    const pre: Record<string, number> = {}
    for (const u of posterUrls) pre[u] = await s.api.bytes(u).then((r) => r.status)
    if (extraRef) pre[extraRef.url] = await s.api.bytes(extraRef.url).then((r) => r.status)
    report.expect('D7.preDeleteServes', Object.values(pre).every((st) => st === 200), pre)

    const admin = adminKey(env)
    if (admin) {
      const ctx = await pwRequest.newContext({ baseURL: args.harness, extraHTTPHeaders: { 'X-API-Key': admin } })
      try {
        const who = await ctx.get('/api/workflow/whoami')
        const whoBody = (await who.json().catch(() => null)) as { role?: string } | null
        const r403 = await ctx.post('/api/workflow/run/delete', { data: { id: runId } })
        report.expect('whoami.apiKey', who.status() === 200 && whoBody?.role === 'user', { status: who.status(), whoBody })
        report.expect('D7.adminApiKeyIs403', r403.status() === 403, { status: r403.status(), body: await r403.text() })
      } finally {
        await ctx.dispose()
      }
    } else {
      report.note('ADMIN_API_KEY unset — API-key 403 / whoami rows skipped')
    }

    const del = page.getByTestId('run-delete')
    await del.waitFor()
    page.once('dialog', (d) => void d.accept())
    await del.click()
    await page.waitForURL(/\/hello\/interactive\/runs$/, { timeout: 30_000 })
    await Promise.all(s.pending)
    await s.shot('09-after-delete')
    const deleteBody = s.deleteBody as { ok?: boolean; deleted?: { files?: number; records?: number } } | null
    report.expect('D7.deleteBody', s.deleteStatus === 200 && deleteBody?.ok === true && (deleteBody?.deleted?.files ?? 0) > 0 && (deleteBody?.deleted?.records ?? 0) > 0, { deleteStatus: s.deleteStatus, deleteBody, expectedFiles: runFiles.length })
    report.expect('D7.deleteRecordsMatchRegistered', deleteBody?.deleted?.records === runFiles.length && deleteBody?.deleted?.files === runFiles.length, { deleted: deleteBody?.deleted, registeredUnderRun: runFiles.map((r) => r.path) })
    const { body: goneBody } = await s.api.json(`/api/workflow/run?id=${runId}`)
    const gone = goneBody as { run: unknown }
    report.expect('D7.runNullAfterDelete', gone.run === null, gone)
    const post: Record<string, number> = {}
    for (const u of posterUrls) post[u] = await s.api.bytes(u).then((r) => r.status)
    const extraAfter = extraRef ? await s.api.bytes(extraRef.url).then((r) => r.status) : -1
    report.expect('D7.posters404AfterDelete', Object.values(post).every((st) => st === 404), post)
    report.expect('D7.inputsSurvive', extraAfter === 200, { url: extraRef?.url, status: extraAfter })
    report.expect('D7.runGoneFromList', (await page.getByRole('link', { name: runId }).count()) === 0, runId)
  } catch (e) {
    await s.shot('99-failed')
    throw e
  } finally {
    await writeFile(`${args.out}/network.log`, s.log.join('\n'), 'utf8').catch(() => undefined)
    await s.close()
  }
}
