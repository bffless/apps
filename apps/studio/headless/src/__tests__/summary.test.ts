import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSummary, formatOutputs, DEFAULT_SUMMARY } from '../../scripts/summary.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const okSummary = {
  ok: true,
  projectId: 'p1',
  openUrl: 'https://studio.example.com/project/p1/export',
  phase: 'done',
  error: null,
  title: 'My Video',
  description: 'line one\nline two',
  thumbnail: true,
  blogBundle: true,
  timings: { import: 1200, prep: 61000 },
}

describe('buildSummary', () => {
  it('renders a success summary with project link, title, description and timings', () => {
    const { markdown, outputs } = buildSummary(okSummary, '# Post body')
    expect(markdown).toContain('## ✅ Studio headless run complete')
    expect(markdown).toContain('**Open the project:** https://studio.example.com/project/p1/export')
    expect(markdown).toContain('**Project ID:** p1')
    expect(markdown).toContain('### My Video')
    expect(markdown).toContain('line one\nline two')
    expect(markdown).toContain('`thumbnail.png`')
    expect(markdown).toContain('<details><summary>Blog post (post.md)</summary>')
    expect(markdown).toContain('# Post body')
    expect(markdown).toContain('| import | 1s |')
    expect(markdown).toContain('| prep | 61s |')
    expect(outputs).toEqual({
      ok: 'true',
      phase: 'done',
      'project-url': 'https://studio.example.com/project/p1/export',
      'project-id': 'p1',
      title: 'My Video',
      description: 'line one\nline two',
    })
  })

  it('renders a failure summary with the phase, error and resume hint', () => {
    const { markdown, outputs } = buildSummary(
      { ...okSummary, ok: false, phase: 'build', error: 'boom', openUrl: 'https://s/project/p1/build', title: null, description: null, thumbnail: false, blogBundle: false },
      null,
    )
    expect(markdown).toContain('## ❌ Studio headless run failed (during: build)')
    expect(markdown).toContain('**Error:** boom')
    expect(markdown).toContain('The project is resumable')
    expect(markdown).not.toContain('thumbnail.png')
    expect(outputs.ok).toBe('false')
    expect(outputs.phase).toBe('build')
    expect(outputs.title).toBe('')
    expect(outputs.description).toBe('')
  })

  it('handles the no-summary fallback (run never wrote the file)', () => {
    const { markdown, outputs } = buildSummary(DEFAULT_SUMMARY, null)
    expect(markdown).toContain('failed (during: no-summary)')
    expect(markdown).toContain('_No project was created._')
    expect(outputs).toMatchObject({ ok: 'false', phase: 'no-summary', 'project-url': '', 'project-id': '' })
  })

  it('truncates a very long blog post', () => {
    const { markdown } = buildSummary(okSummary, 'x'.repeat(100_001))
    expect(markdown).toContain('… (truncated — full post in the artifact)')
  })
})

describe('formatOutputs', () => {
  it('writes every value as a heredoc so multi-line values survive', () => {
    const text = formatOutputs({ a: 'one', description: 'l1\nl2' })
    expect(text).toMatch(/^a<<ghadelim_[a-f0-9]+\none\nghadelim_[a-f0-9]+\n/)
    expect(text).toMatch(/description<<ghadelim_[a-f0-9]+\nl1\nl2\nghadelim_[a-f0-9]+\n/)
  })
})

describe('summary.mjs CLI', () => {
  it('writes GITHUB_OUTPUT and GITHUB_STEP_SUMMARY from run-summary.json', () => {
    const tmpDir = resolve(mkdtempSync(join(tmpdir(), 'studio-headless-out-')))
    const outFile = join(tmpDir, 'github-output')
    const sumFile = join(tmpDir, 'github-summary')

    writeFileSync(
      join(tmpDir, 'run-summary.json'),
      JSON.stringify({
        ok: true,
        phase: 'done',
        openUrl: 'https://studio.example.com/project/p1/export',
        projectId: 'p1',
        error: null,
        title: 'My Video',
        description: 'a description',
        thumbnail: false,
        blogBundle: false,
        timings: {},
      }),
    )

    execFileSync(process.execPath, [join(__dirname, '../../scripts/summary.mjs')], {
      env: {
        ...process.env,
        STUDIO_HEADLESS_OUT: tmpDir,
        GITHUB_OUTPUT: outFile,
        GITHUB_STEP_SUMMARY: sumFile,
      },
    })

    const outputText = readFileSync(outFile, 'utf8')
    const summaryText = readFileSync(sumFile, 'utf8')

    expect(outputText).toMatch(/ok<<ghadelim_[a-f0-9]+\ntrue\nghadelim_[a-f0-9]+/)
    expect(outputText).toMatch(
      /project-url<<ghadelim_[a-f0-9]+\nhttps:\/\/studio\.example\.com\/project\/p1\/export\nghadelim_[a-f0-9]+/,
    )
    const outputDirMatch = outputText.match(/output-dir<<(ghadelim_[a-f0-9]+)\n([\s\S]*?)\n\1/)
    expect(outputDirMatch?.[2]).toBe(tmpDir)
    expect(summaryText).toContain('## ✅ Studio headless run complete')
  })

  // bffless/apps#401: the main-module guard used to compare process.argv[1] (the
  // as-invoked path) against realpath'd import.meta.url, which is false when the
  // script is launched through a symlink — the script would silently no-op.
  it('runs when invoked through a symlink, same as invoked directly', () => {
    const tmpDir = resolve(mkdtempSync(join(tmpdir(), 'studio-headless-out-')))
    const outFile = join(tmpDir, 'github-output')
    const sumFile = join(tmpDir, 'github-summary')
    const linkDir = mkdtempSync(join(tmpdir(), 'studio-headless-link-'))
    try {
      writeFileSync(
        join(tmpDir, 'run-summary.json'),
        JSON.stringify({
          ok: true,
          phase: 'done',
          openUrl: 'https://studio.example.com/project/p1/export',
          projectId: 'p1',
          error: null,
          title: 'My Video',
          description: 'a description',
          thumbnail: false,
          blogBundle: false,
          timings: {},
        }),
      )

      const link = join(linkDir, 'summary.mjs')
      symlinkSync(join(__dirname, '../../scripts/summary.mjs'), link)

      const stdout = execFileSync(process.execPath, [link], {
        encoding: 'utf8',
        // GITHUB_OUTPUT points at a temp file, same as the sibling test above — without
        // it a CI run would append to the real runner's step-output file.
        env: { ...process.env, STUDIO_HEADLESS_OUT: tmpDir, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: sumFile },
      })

      expect(stdout).toContain('## ✅ Studio headless run complete')
      expect(readFileSync(sumFile, 'utf8')).toContain('## ✅ Studio headless run complete')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
      rmSync(linkDir, { recursive: true, force: true })
    }
  })
})
