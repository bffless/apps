import { readFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { checkBlogZip, checkStudioCommon, checkStudioHeadless } from '../src/checks/studio.js'
import { parseRecord } from '../src/record.js'
import { Report } from '../src/report.js'

const load = (f: string) => parseRecord(JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')))

describe('checkStudioCommon', () => {
  it('passes on the by-hand 2026-08-29 run', () => {
    const r = new Report('studio-audit', 'h'); checkStudioCommon(load('studio-interactive.json'), r)
    const out = r.finish()
    expect(out.ok, JSON.stringify(out.checks, null, 1)).toBe(true)
    expect(Object.keys(out.checks)).toEqual(['run.succeeded', 'R.scenesCarrySourceSpans', 'D2.sheetsDrawn', 'trim.keepRecorded', 'outputs.shortBlogCoverAreFileRefs', 'D16.wordsNotOffloaded'])
  })
  it('fails on a run that did not succeed', () => {
    const r = new Report('studio-audit', 'h'); checkStudioCommon(load('studio-cancelled.json'), r)
    const out = r.finish()
    expect(out.ok).toBe(false)
    expect(out.checks['run.succeeded']?.pass).toBe(false)
  })
  it('flags undrawn sheets', () => {
    const rec = load('studio-interactive.json')
    for (const s of rec.steps.filter((s) => /^sheets\/\d+\/sheets$/.test(s.key))) {
      const resp = s.response as { last: { result: { drawn: boolean } } }
      resp.last.result.drawn = false
    }
    const r = new Report('studio-audit', 'h'); checkStudioCommon(rec, r)
    expect(r.finish().checks['D2.sheetsDrawn']?.pass).toBe(false)
  })
})

describe('checkStudioHeadless', () => {
  it('passes on the real 2026-08-30 headless run', () => {
    const r = new Report('studio-headless', 'h'); checkStudioHeadless(load('studio-headless.json'), r)
    const out = r.finish()
    expect(out.ok, JSON.stringify(out.checks, null, 1)).toBe(true)
    expect(Object.keys(out.checks)).toEqual(['run.succeeded', 'R.scenesCarrySourceSpans', 'D2.sheetsDrawn', 'trim.keepRecorded', 'outputs.shortBlogCoverAreFileRefs', 'D16.wordsNotOffloaded', 'run.headlessFlag', 'D11.blogReviewSkippedWithPost', 'D11.coverFormsSkipped', 'cover.rendered', 'D7.trimAutoAccepted'])
  })
  it('requires the headless flag and the skipped forms', () => {
    const rec = load('studio-interactive.json')   // an interactive run (old YAML) must FAIL the headless check
    const r = new Report('studio-headless', 'h'); checkStudioHeadless(rec, r)
    const c = r.finish().checks
    expect(c['run.headlessFlag']?.pass).toBe(false)
    expect(c['D11.blogReviewSkippedWithPost']?.pass).toBe(false)   // absent: `blog/0/review` doesn't exist on the old YAML
  })
  it('D7.trimAutoAccepted fails when there are no trim steps', () => {
    const rec = load('studio-interactive.json')
    rec.steps = rec.steps.filter((s) => s.step !== 'trim')
    const r = new Report('studio-headless', 'h'); checkStudioHeadless(rec, r)
    expect(r.finish().checks['D7.trimAutoAccepted']?.pass).toBe(false)
  })
})

describe('checkBlogZip', () => {
  it('accepts post + frames', () => {
    const r = new Report('studio-headless', 'h')
    checkBlogZip(zipSync({ 'post.md': strToU8('# t'), 'images/frame-01.jpg': new Uint8Array([0xff, 0xd8]) }), r)
    expect(r.finish().ok).toBe(true)
  })
  it('rejects a bundle with no frames', () => {
    const r = new Report('studio-headless', 'h')
    checkBlogZip(zipSync({ 'post.md': strToU8('# t') }), r)
    expect(r.finish().checks['blog.zipHasFrames']?.pass).toBe(false)
  })
})
