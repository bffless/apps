import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config'
import { downloadAll } from './download'

const OUT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'output')
mkdirSync(OUT, { recursive: true })

test('studio headless run', async ({ page }, testInfo) => {
  const timings: Record<string, number> = {}
  let phase = 'start'
  let projectId: string | null = null
  let cfg: ReturnType<typeof loadConfig> | null = null
  const t0 = Date.now()
  const mark = (name: string) => { timings[name] = Date.now() - t0 }
  const shot = async (name: string) => {
    const path = join(OUT, `${name}.png`)
    await page.screenshot({ path, fullPage: true })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  const logLine = (line: string) => appendFile(join(OUT, 'console.log'), line + '\n').catch(() => {})
  page.on('console', (m) => logLine(`[console:${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logLine(`[pageerror] ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 400) logLine(`[http ${r.status()}] ${r.url()}`) })

  let errorMessage: string | null = null
  try {
    // ---- config ----
    phase = 'config'
    cfg = loadConfig()
    mark('config')

    // ---- files ----
    const files = cfg.mockMode
      ? cfg.fixturePaths
      : await downloadAll(cfg.videoUrls, await mkdtemp(join(tmpdir(), 'studio-src-')))
    mark('download')

    // ---- login (real mode only; the site 302s /api/* to the admin relay) ----
    phase = 'login'
    await page.goto(cfg.baseUrl, { waitUntil: 'domcontentloaded' })
    if (!cfg.mockMode) {
      // Either we land authenticated (rare in CI) or the first project fetch
      // bounces us to the admin login page on the admin origin.
      await page.waitForURL(/\/login/, { timeout: 30_000 }).catch(() => {})
      if (/\/login/.test(page.url())) {
        await page.fill('input[type="email"], input[name="email"]', cfg.credentials!.email)
        await page.fill('input[type="password"]', cfg.credentials!.password)
        await page.click('button[type="submit"]')
        const studioOrigin = new URL(cfg.baseUrl).origin
        await page.waitForURL((u) => u.origin === studioOrigin, { timeout: 60_000 })
      }
    }
    await shot('01-landed')
    mark('login')

    // ---- create project ----
    phase = 'create-project'
    await page.getByTestId('new-project').click()
    await page.waitForURL(/\/project\//, { timeout: 30_000 })
    projectId = page.url().match(/\/project\/([0-9a-f-]+)/)?.[1] ?? null

    // ---- import ----
    phase = 'import'
    await page.getByTestId('media-import-input').setInputFiles(files)
    await expect(page.getByTestId('source-row')).toHaveCount(files.length, { timeout: 60_000 })
    await shot('02-imported')
    mark('import')

    // ---- prep: per-source stages ----
    phase = 'prep-sources'
    await page.getByTestId('process-all').click()
    // sources-ready renders exactly when every per-source stage is done
    await expect(page.getByTestId('sources-ready'))
      .toBeVisible({ timeout: cfg.prepTimeoutMs * files.length })
    await shot('03-sources-processed')
    mark('prep-sources')

    // ---- prep: global plan (contact sheets → director) ----
    phase = 'prep-plan'
    await page.getByTestId('continue-plan').click()
    // The board surfaces one current stage at a time; click stage actions until
    // the director panel (which owns its own run button) is on screen.
    const directorInput = page.getByTestId('director-input')
    const deadline = Date.now() + cfg.prepTimeoutMs
    while (!(await directorInput.isVisible().catch(() => false))) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the director panel')
      const action = page.getByTestId('stage-action')
      if (await action.isVisible().catch(() => false)) await action.click()
      await page.waitForTimeout(5_000)
    }
    if (cfg.directorPrompt) await directorInput.fill(cfg.directorPrompt)
    await shot('04-director-ready')
    await page.getByTestId('director-run').click()
    await expect(page.getByTestId('continue-build')).toBeVisible({ timeout: cfg.directorTimeoutMs })
    await shot('05-prep-complete')
    mark('prep-plan')

    // ---- build: auto build ----
    phase = 'build'
    await page.getByTestId('continue-build').click()
    await page.getByTestId('auto-mode-toggle').click()
    await page.getByTestId('auto-build-start').click()
    const board = page.getByTestId('auto-build-board')
    await expect(board).toHaveAttribute('data-state', /^(done|halted)$/, { timeout: cfg.buildTimeoutMs })
    if ((await board.getAttribute('data-state')) === 'halted') {
      const msg = await page.getByTestId('auto-build-halt').innerText().catch(() => 'halted (no message)')
      await shot('06-halted')
      throw new Error(`auto build halted: ${msg}`)
    }
    await shot('06-build-done')
    mark('build')

    // ---- settle: autosave ----
    phase = 'settle'
    await expect(page.getByTestId('save-indicator')).toHaveAttribute('data-state', 'saved', { timeout: 120_000 })
    mark('settle')
    phase = 'done'
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    const buildUrl = cfg && projectId ? `${cfg.baseUrl}/project/${projectId}/build` : null
    await writeFile(join(OUT, 'run-summary.json'), JSON.stringify({
      ok: phase === 'done',
      projectId,
      buildUrl,
      phase,
      error: phase === 'done' ? null : (errorMessage ?? `failed during: ${phase}`),
      timings,
    }, null, 2))
  }
})
