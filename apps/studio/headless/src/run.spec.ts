import { test, expect, type Locator } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { loadConfig } from './config'
import { downloadAll, downloadImage } from './download'
import { JOB_POLL_PATH, transcribeWordCount, videoJobStats, formatVideoJobLine, type VideoJobStats } from './jobs'
import { createStallWatch } from './stall'

const OUT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'output')
mkdirSync(OUT, { recursive: true })

/** How often the long phases re-read the page state. */
const POLL_MS = 5_000
/** Re-emit an unchanged progress line after this long, so the CI log shows life. */
const HEARTBEAT_MS = 60_000
/** Ceiling for the instant state reads inside describe/tick callbacks — these
 *  must never inherit the 120s actionTimeout or a heartbeat would stall. */
const PEEK_MS = 1_000

test('studio headless run', async ({ page }, testInfo) => {
  const timings: Record<string, number> = {}
  let phase = 'start'
  let projectId: string | null = null
  let cfg: ReturnType<typeof loadConfig> | null = null
  let exportTitle: string | null = null
  let exportDescription: string | null = null
  let thumbnailSaved = false
  let blogSaved = false
  const t0 = Date.now()
  const mark = (name: string) => { timings[name] = Date.now() - t0 }
  const shot = async (name: string) => {
    const path = join(OUT, `${name}.png`)
    await page.screenshot({ path, fullPage: true })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  const logLine = (line: string) => appendFile(join(OUT, 'console.log'), line + '\n').catch(() => {})
  // Playwright forwards worker stdout to the reporter as it happens, so
  // progress() lines show up live in the GitHub Actions log.
  const progress = (line: string) => {
    const msg = `[${new Date().toISOString().slice(11, 19)}] ${line}`
    console.log(msg)
    void logLine(msg)
  }
  page.on('console', (m) => logLine(`[console:${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logLine(`[pageerror] ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 400) logLine(`[http ${r.status()}] ${r.url()}`) })

  // Watch the app's job polls for finished transcribe jobs and remember each
  // job's word count. The DOM only shows a "done" badge either way, but a
  // silent recording (muted mic) transcribes to 0 words — and everything
  // downstream (director cuts, refine, describe, thumbnail, blog) is built on
  // those words, so the run must fail HERE, not 30 credit-burning minutes
  // later at the export step.
  const transcribeWords = new Map<string, number>()
  // Server video jobs (CE >= 0.4.31) also report which ffmpeg executor ran them
  // and for how long (apps#605) — the DOM never shows it, so log one line per
  // finished job as it lands and keep the list for run-summary.json. Keyed by
  // poll URL (= job id) so a re-polled done row isn't logged twice.
  const videoJobs = new Map<string, VideoJobStats>()
  page.on('response', (r) => {
    if (!r.url().includes(JOB_POLL_PATH) || r.status() !== 200) return
    void r
      .json()
      .then((body) => {
        const count = transcribeWordCount(body)
        if (count != null) transcribeWords.set(r.url(), count)
        const stats = videoJobStats(body)
        if (stats && !videoJobs.has(r.url())) {
          videoJobs.set(r.url(), stats)
          progress(formatVideoJobLine(stats))
        }
      })
      .catch(() => {})
  })

  const peek = (l: Locator, attr: string) => l.getAttribute(attr, { timeout: PEEK_MS }).catch(() => null)

  /** Poll until done() — logging describe()'s state on change and as a
   *  heartbeat, and running tick() (optional actions) every round. */
  const pollUntil = async (
    label: string,
    deadlineMs: number,
    done: () => Promise<boolean>,
    describe?: () => Promise<string | null>,
    tick?: () => Promise<void>,
  ) => {
    const deadline = Date.now() + deadlineMs
    let lastDesc = ''
    let lastEmit = 0
    for (;;) {
      if (await done()) return
      if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
      await tick?.()
      const desc = (await describe?.().catch(() => null)) ?? label
      if (desc !== lastDesc || Date.now() - lastEmit > HEARTBEAT_MS) {
        const elapsed = Math.round((Date.now() - t0) / 60_000)
        progress(`${desc} (${elapsed}m elapsed)`)
        lastDesc = desc
        lastEmit = Date.now()
      }
      await page.waitForTimeout(POLL_MS)
    }
  }

  let errorMessage: string | null = null
  try {
    // ---- config ----
    phase = 'config'
    cfg = loadConfig()
    mark('config')

    // ---- files ----
    progress(cfg.mockMode ? 'using fixture clip(s)' : `downloading ${cfg.videoUrls.length} source video(s)`)
    const files = cfg.mockMode
      ? cfg.fixturePaths
      : await downloadAll(cfg.videoUrls, await mkdtemp(join(tmpdir(), 'studio-src-')))
    // The optional thumbnail reference downloads up front too — a bad URL should
    // fail the run before any credits are spent, not two hours in.
    const referenceFile = cfg.thumbnailReferenceUrl
      ? await downloadImage(cfg.thumbnailReferenceUrl, await mkdtemp(join(tmpdir(), 'studio-ref-')))
      : null
    mark('download')

    // ---- login (real mode only; the site 302s /api/* to the admin relay) ----
    phase = 'login'
    // Land with the explicit core override: MT hangs its first exec in
    // headless CI Firefox, so default to the single-threaded core. The app
    // persists the choice to localStorage, so later SPA navigations keep it.
    // Same for the optional video-backend override (`?videoBackend=`, apps#605).
    const landUrl = `${cfg.baseUrl}/?ffmpegCore=${cfg.ffmpegMt ? 'mt' : 'st'}`
      + (cfg.videoBackend ? `&videoBackend=${cfg.videoBackend}` : '')
    progress(`opening ${landUrl}`)
    await page.goto(landUrl, { waitUntil: 'domcontentloaded' })
    if (!cfg.mockMode) {
      // Either we land authenticated (rare in CI) or the first project fetch
      // bounces us to the admin login page on the admin origin.
      await page.waitForURL(/\/login/, { timeout: 30_000 }).catch(() => {})
      if (/\/login/.test(page.url())) {
        progress('logging in via the admin relay')
        await page.fill('input[type="email"], input[name="email"]', cfg.credentials!.email)
        await page.fill('input[type="password"]', cfg.credentials!.password)
        await page.click('button[type="submit"]')
        const studioOrigin = new URL(cfg.baseUrl).origin
        await page.waitForURL((u) => u.origin === studioOrigin, { timeout: 60_000 })
      }
    }
    await shot('01-landed')
    progress('logged in')
    mark('login')

    // ---- create project ----
    phase = 'create-project'
    await page.getByTestId('new-project').click()
    await page.waitForURL(/\/project\//, { timeout: 30_000 })
    projectId = page.url().match(/\/project\/([0-9a-f-]+)/)?.[1] ?? null
    progress(`created project ${projectId}`)

    // ---- import ----
    phase = 'import'
    await page.getByTestId('media-import-input').setInputFiles(files)
    await expect(page.getByTestId('source-row')).toHaveCount(files.length, { timeout: 60_000 })
    await shot('02-imported')
    progress(`imported ${files.length} clip(s)`)
    mark('import')

    // ---- prep: per-source stages ----
    phase = 'prep-sources'
    await page.getByTestId('process-all').click()
    progress('prep: processing source clips (upload → audio → transcribe)')
    // sources-ready renders exactly when every per-source stage is done
    const sourcesReady = page.getByTestId('sources-ready')
    await pollUntil(
      'prep: waiting for source clips to process',
      cfg.prepTimeoutMs * files.length,
      () => sourcesReady.isVisible().catch(() => false),
      async () => {
        const rows = await page.getByTestId('source-row').all()
        const parts: string[] = []
        for (const [i, row] of rows.entries()) {
          const badges = await row.locator('[data-testid^="stage-"]').all()
          const states: string[] = []
          for (const b of badges) {
            const id = (await peek(b, 'data-testid'))?.replace('stage-', '')
            const st = await peek(b, 'data-state')
            if (id && st) states.push(`${id}:${st}`)
          }
          parts.push(`clip ${i + 1} [${states.join(' ')}]`)
        }
        return parts.length ? `prep: ${parts.join(' · ')}` : null
      },
    )
    await shot('03-sources-processed')
    progress('prep: all source clips processed')
    // Fail fast on silent audio: a muted-mic recording transcribes to 0 words
    // with a clean "done" badge, and every later stage (director cuts, refine,
    // describe, thumbnail, blog) is built on those words. Real mode always
    // polls at least one transcribe job per source; observing NONE would mean
    // the wire-watch itself broke, so that fails too rather than passing blind.
    // (Mock mode is exempt — MSW answers from a service worker the CDP response
    // event doesn't reliably see, and its canned transcript is never silent.)
    if (!cfg.mockMode) {
      const counts = [...transcribeWords.values()]
      if (counts.length < files.length) {
        throw new Error(
          `only ${counts.length} of ${files.length} transcribe jobs were observed on the wire — cannot confirm every source transcribed`,
        )
      }
      if (counts.some((c) => c === 0)) {
        throw new Error(
          'transcription produced 0 words for a source — the recording’s audio track is silent or ' +
            'undecodable (muted mic?). Fix the recording and dispatch again; nothing downstream is worth building without words.',
        )
      }
      progress(`prep: transcribed ${counts.map((c) => c.toLocaleString()).join(' + ')} words`)
    }
    mark('prep-sources')

    // ---- prep: global plan (contact sheets → director) ----
    phase = 'prep-plan'
    await page.getByTestId('continue-plan').click()
    // The board surfaces one current stage at a time; start each stage when its
    // action button is visible AND enabled (a running stage renders it
    // disabled — clicking would block until the 120s actionTimeout and fail,
    // even though the stage is progressing fine). The director panel owns its
    // own run button, so its appearance ends the loop.
    const directorInput = page.getByTestId('director-input')
    const action = page.getByTestId('stage-action')
    await pollUntil(
      'prep: waiting for the director panel',
      cfg.prepTimeoutMs,
      () => directorInput.isVisible().catch(() => false),
      async () => {
        const states: string[] = []
        for (const id of ['thumbnails', 'director']) {
          const st = await peek(page.getByTestId(`stage-${id}`), 'data-state')
          if (st) states.push(`${id}:${st}`)
        }
        return states.length ? `prep plan: ${states.join(' ')}` : 'prep plan: starting'
      },
      async () => {
        const clickable = (await action.isVisible().catch(() => false)) &&
          (await action.isEnabled({ timeout: PEEK_MS }).catch(() => false))
        if (clickable) {
          progress('prep: starting next plan stage')
          // A stage flipping to busy mid-click just detaches the button; the
          // next poll round picks the board back up.
          await action.click({ timeout: PEEK_MS }).catch(() => {})
        }
      },
    )
    if (cfg.directorPrompt) await directorInput.fill(cfg.directorPrompt)
    await shot('04-director-ready')
    await page.getByTestId('director-run').click()
    progress('prep: master director running')
    const continueBuild = page.getByTestId('continue-build')
    await pollUntil(
      'prep: waiting for the director',
      cfg.directorTimeoutMs,
      () => continueBuild.isVisible().catch(() => false),
      async () => 'prep: master director running',
    )
    await shot('05-prep-complete')
    progress('prep complete — scenes ready')
    mark('prep-plan')

    // ---- build: auto build ----
    phase = 'build'
    await continueBuild.click()
    await page.getByTestId('auto-mode-toggle').click()
    // The board lists the director's chapters — log them before starting so the
    // CI log records what the director decided.
    const sceneRows = page.getByTestId('auto-scene')
    await sceneRows.first().waitFor({ timeout: 30_000 })
    const chapterTitles = await sceneRows.allInnerTexts()
    progress(`build: ${chapterTitles.length} chapter(s) from the director:`)
    for (const t of chapterTitles) progress(`  · ${t.replace(/\s+/g, ' ').trim()}`)
    await page.getByTestId('auto-build-start').click()
    progress('build: auto build started')
    const board = page.getByTestId('auto-build-board')
    if (cfg.smokeStopAfterStart) {
      // Smoke asserts the full click-path is intact; the mocked build itself is
      // not the subject. Leaving idle proves the runner engaged.
      await expect(board).not.toHaveAttribute('data-state', 'idle', { timeout: 60_000 })
      await shot('06-smoke-autobuild-engaged')
      phase = 'done'
      return
    }
    // Scene/step-level progress: which scene is on which step, plus a stall
    // screenshot if nothing observable changes for 10 minutes (a silent wasm
    // hang — or a server job that never settles — looks exactly like "running"
    // forever; the screenshots and the frozen describe-line are the post-mortem
    // evidence). Past `buildStallTimeoutMs` the freeze IS the verdict: fail with
    // the frozen state rather than burn the rest of the build budget (apps#339).
    const stallWatch = createStallWatch({
      shotEveryMs: 10 * 60_000,
      failAfterMs: cfg.buildStallTimeoutMs,
      maxShots: 5,
    })
    let stallError: string | null = null
    await pollUntil(
      'build: waiting for auto build',
      cfg.buildTimeoutMs,
      async () => {
        // Thrown from done() — describe()'s errors are swallowed by pollUntil.
        if (stallError) throw new Error(stallError)
        return /^(done|halted)$/.test((await peek(board, 'data-state')) ?? '')
      },
      async () => {
        const states: string[] = []
        for (const row of await sceneRows.all()) {
          states.push((await peek(row, 'data-state')) ?? '?')
        }
        const built = states.filter((s) => s === 'built').length
        const runningIdx = states.findIndex((s) => s === 'running')
        let stepNote = ''
        if (runningIdx >= 0) {
          for (const chip of await page.locator('[data-testid^="auto-step-"]').all()) {
            if ((await peek(chip, 'data-state')) === 'running') {
              const id = (await peek(chip, 'data-testid'))?.replace('auto-step-', '')
              if (id) { stepNote = ` — ${id} running`; break }
            }
          }
        }
        const desc = `build: ${built}/${states.length} scenes built` +
          (runningIdx >= 0 ? `, scene ${runningIdx + 1}${stepNote}` : '') +
          ` [board ${(await peek(board, 'data-state')) ?? '?'}]`
        const stall = stallWatch.observe(desc, Date.now())
        const stalledMin = Math.round(stall.stalledMs / 60_000)
        if (stall.action === 'shot') {
          progress(`build: no observable change for ${stalledMin}m — capturing stall screenshot ${stall.shot}`)
          await shot(`build-stall-${stall.shot}`)
        } else if (stall.action === 'fail') {
          await shot('06-build-stalled')
          stallError =
            `build stalled: no observable change for ${stalledMin}m at "${desc}". ` +
            'Nothing is progressing — this is a wedge, not slow work.'
        }
        return desc
      },
    )
    if ((await peek(board, 'data-state')) === 'halted') {
      const msg = await page.getByTestId('auto-build-halt').innerText().catch(() => 'halted (no message)')
      await shot('06-halted')
      throw new Error(`auto build halted: ${msg}`)
    }
    await shot('06-build-done')
    progress('build: done — final cut stitched')
    mark('build')

    // ---- export: title + description (auto-generated on arrival) ----
    phase = 'export'
    await page.getByTestId('continue-export').click()
    progress('export: generating the title + description')
    const summaryCard = page.getByTestId('export-summary')
    await pollUntil(
      'export: waiting for the title + description',
      cfg.describeTimeoutMs,
      async () => (await peek(summaryCard, 'data-state')) === 'done',
      async () => `export: description ${(await peek(summaryCard, 'data-state')) ?? '?'}`,
    )
    exportTitle = await page.getByTestId('export-title').inputValue()
    exportDescription = await page.getByTestId('export-description').inputValue()
    progress(`export: title — ${exportTitle}`)
    await shot('07-description')
    mark('export-describe')

    // ---- export: YouTube thumbnail (optional reference → draft → render) ----
    // The reference goes on BEFORE drafting: the draft call carries whether one
    // is attached, and only then does the drafted prompt tell nano-banana to
    // build around the photo. Attach it after drafting and the prompt describes
    // a self-contained illustration (and bans photorealistic humans), so the
    // photo is passed but ignored.
    phase = 'export-thumbnail'
    const thumbCard = page.getByTestId('thumbnail-studio')
    if (cfg.thumbnailPrompt) await page.getByTestId('thumb-notes').fill(cfg.thumbnailPrompt)
    if (referenceFile) {
      progress('export: attaching the reference image')
      await page.getByTestId('thumb-reference').setInputFiles(referenceFile)
      // The preview only appears once the presigned upload finished and the
      // serve path signed — drafting before that would draft without it.
      await page.getByTestId('thumb-reference-preview').waitFor({ timeout: 120_000 })
    }
    progress('export: drafting the thumbnail prompt')
    await page.getByTestId('thumb-draft').click()
    const promptBox = page.getByTestId('thumb-prompt')
    await pollUntil(
      'export: waiting for the drafted thumbnail prompt',
      cfg.thumbnailTimeoutMs,
      async () =>
        (await peek(thumbCard, 'data-state')) !== 'drafting' &&
        ((await promptBox.inputValue({ timeout: PEEK_MS }).catch(() => '')) ?? '').trim() !== '',
      async () => 'export: drafting the thumbnail prompt',
    )
    progress('export: rendering the thumbnail')
    await page.getByTestId('thumb-render').click()
    await pollUntil(
      'export: waiting for the rendered thumbnail',
      cfg.thumbnailTimeoutMs,
      async () => (await peek(thumbCard, 'data-state')) === 'done',
      async () => `export: thumbnail ${(await peek(thumbCard, 'data-state')) ?? '?'}`,
    )
    // The result <img> carries a signed direct-bucket URL — fetchable from Node
    // without cookies, so save a copy into the artifact.
    const thumbSrc = await page.getByTestId('thumb-result').getAttribute('src')
    if (thumbSrc) {
      const res = await fetch(thumbSrc).catch(() => null)
      if (res?.ok) {
        await writeFile(join(OUT, 'thumbnail.png'), Buffer.from(await res.arrayBuffer()))
        thumbnailSaved = true
      } else {
        progress(`export: thumbnail fetch failed (${res?.status ?? 'network error'}) — artifact will lack thumbnail.png`)
      }
    }
    await shot('08-thumbnail')
    progress('export: thumbnail rendered')
    mark('export-thumbnail')

    // ---- export: blog post (opt-in) ----
    if (cfg.generateBlog) {
      phase = 'export-blog'
      const blogCard = page.getByTestId('blog-card')
      if (cfg.blogDirection) await page.getByTestId('blog-direction').fill(cfg.blogDirection)
      progress('export: writing the blog post')
      await page.getByTestId('blog-generate').click()
      await pollUntil(
        'export: waiting for the blog post',
        cfg.blogTimeoutMs,
        async () => {
          const st = (await peek(blogCard, 'data-state')) ?? ''
          if (st === 'error') throw new Error('blog generation failed — see the 09 screenshot + console log')
          return st === 'done' || st === 'stale'
        },
        async () => `export: blog ${(await peek(blogCard, 'data-state')) ?? '?'}`,
      )
      // Capture the app's own "Download bundle" (post.md + images zip) as an
      // artifact, and unzip post.md next to it for the job summary.
      progress('export: capturing the blog bundle')
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        page.getByTestId('blog-download').click(),
      ])
      const bundlePath = join(OUT, 'blog-bundle.zip')
      await download.saveAs(bundlePath)
      const post = unzipSync(new Uint8Array(await readFile(bundlePath)))['post.md']
      if (post) await writeFile(join(OUT, 'post.md'), post)
      blogSaved = true
      await shot('09-blog')
      progress('export: blog post written + bundle captured')
      mark('export-blog')
    }

    // ---- settle: autosave ----
    phase = 'settle'
    await expect(page.getByTestId('save-indicator')).toHaveAttribute('data-state', 'saved', { timeout: 120_000 })
    progress('project saved to server')
    mark('settle')
    phase = 'done'
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    // Deep-link to where the user should pick up: the Export page once the run
    // got that far (or finished), the Build page for earlier failures.
    const reachedExport = phase === 'done' || phase === 'settle' || phase.startsWith('export')
    const openUrl = cfg && projectId
      ? `${cfg.baseUrl}/project/${projectId}/${reachedExport ? 'export' : 'build'}`
      : null
    progress(phase === 'done' ? `run complete: ${openUrl}` : `run failed during ${phase}${openUrl ? ` — resume at ${openUrl}` : ''}`)
    await writeFile(join(OUT, 'run-summary.json'), JSON.stringify({
      ok: phase === 'done',
      projectId,
      openUrl,
      phase,
      error: phase === 'done' ? null : (errorMessage ?? `failed during: ${phase}`),
      title: exportTitle,
      description: exportDescription,
      thumbnail: thumbnailSaved,
      blogBundle: blogSaved,
      timings,
      videoJobs: [...videoJobs.values()],
    }, null, 2))
  }
})
