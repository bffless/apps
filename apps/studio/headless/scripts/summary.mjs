#!/usr/bin/env node
// Job summary + step outputs for the studio-headless action.
//
// Reads <out>/run-summary.json (written by src/run.spec.ts's `finally` block,
// on success AND failure) and optional <out>/post.md, then:
//   • appends a markdown summary to $GITHUB_STEP_SUMMARY (if set)
//   • appends step outputs to $GITHUB_OUTPUT (if set)
//   • prints the markdown to stdout
// <out> = $STUDIO_HEADLESS_OUT, default ../output relative to this file.
import { readFileSync, appendFileSync, realpathSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const MAX_POST_CHARS = 100_000

/** What the summary looks like when the run never got to write one. */
export const DEFAULT_SUMMARY = Object.freeze({
  ok: false,
  phase: 'no-summary',
  openUrl: null,
  projectId: null,
  error: null,
  title: null,
  description: null,
  thumbnail: false,
  blogBundle: false,
  timings: {},
})

/** Load run-summary.json + post.md from outDir; falls back to DEFAULT_SUMMARY. */
export function readSummary(outDir) {
  let summary = DEFAULT_SUMMARY
  try { summary = { ...DEFAULT_SUMMARY, ...JSON.parse(readFileSync(join(outDir, 'run-summary.json'), 'utf8')) } } catch {}
  let postMd = null
  if (summary.blogBundle) {
    try { postMd = readFileSync(join(outDir, 'post.md'), 'utf8') } catch {}
  }
  return { summary, postMd }
}

/** Pure: summary object (+ optional post.md text) → { markdown, outputs }. */
export function buildSummary(s, postMd) {
  const lines = [
    s.ok ? '## ✅ Studio headless run complete' : `## ❌ Studio headless run failed (during: ${s.phase})`,
    '',
  ]
  if (s.openUrl) {
    lines.push(`**Open the project:** ${s.openUrl}`)
    if (s.projectId) lines.push(`**Project ID:** ${s.projectId}`)
  } else if (s.projectId) {
    lines.push(`**Project ID:** ${s.projectId}`)
  } else {
    lines.push('_No project was created._')
  }
  if (s.error) lines.push(`**Error:** ${s.error}`)
  if (!s.ok && s.openUrl) lines.push('\nThe project is resumable — open the link and continue from where the run halted.')
  if (s.title) lines.push('', `### ${s.title}`)
  if (s.description) lines.push('', '**YouTube description**', '', '```', s.description, '```')
  if (s.thumbnail) lines.push('', '**Thumbnail:** `thumbnail.png` in the run-output artifact.')
  if (s.blogBundle) {
    lines.push('', '**Blog bundle:** `blog-bundle.zip` (post.md + images) in the run-output artifact.')
    if (postMd != null) {
      // Image links inside the post point at auth-gated serve paths, so they
      // render only inside the app — the text is still worth reading here.
      const clipped = postMd.length > MAX_POST_CHARS
        ? postMd.slice(0, MAX_POST_CHARS) + '\n\n… (truncated — full post in the artifact)'
        : postMd
      lines.push('', '<details><summary>Blog post (post.md)</summary>', '', clipped, '', '</details>')
    }
  }
  lines.push('', '| Phase | Elapsed |', '| --- | --- |')
  lines.push(...Object.entries(s.timings ?? {}).map(([k, v]) => `| ${k} | ${Math.round(v / 1000)}s |`))

  const outputs = {
    ok: s.ok ? 'true' : 'false',
    phase: s.phase ?? 'no-summary',
    'project-url': s.openUrl ?? '',
    'project-id': s.projectId ?? '',
    title: s.title ?? '',
    description: s.description ?? '',
  }
  return { markdown: lines.join('\n') + '\n', outputs }
}

/** $GITHUB_OUTPUT text. Every value uses a heredoc delimiter (multi-line safe). */
export function formatOutputs(outputs) {
  let text = ''
  for (const [key, value] of Object.entries(outputs)) {
    const delim = 'ghadelim_' + randomBytes(8).toString('hex')
    text += `${key}<<${delim}\n${value}\n${delim}\n`
  }
  return text
}

function main() {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(process.env.STUDIO_HEADLESS_OUT || join(here, '..', 'output'))
  const { summary, postMd } = readSummary(outDir)
  const { markdown, outputs } = buildSummary(summary, postMd)
  outputs['output-dir'] = outDir
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, formatOutputs(outputs))
  process.stdout.write(markdown)
}

/** realpathSync, tolerant of a path that doesn't resolve (falls back to itself). */
function realOrSelf(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// Only run when invoked as a script. A published `bin` (or a symlinked
// checkout) is launched through a symlink — Node resolves the main module
// through the link, so import.meta.url is already the realpath while
// process.argv[1] is still the link path. Compare realpaths on both sides,
// or this guard is false through a symlink and the script silently no-ops
// (bffless/apps#401).
if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url))) main()
