import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkHeadlessHello } from '../src/checks/hello-headless.js'
import { parseRecord } from '../src/record.js'
import { Report } from '../src/report.js'

const load = () => parseRecord(JSON.parse(readFileSync(new URL('./fixtures/headless-hello.json', import.meta.url), 'utf8')))

describe('checkHeadlessHello', () => {
  it('passes on the real headless run', () => {
    const r = new Report('headless', 'h'); checkHeadlessHello(load(), r)
    const out = r.finish()
    expect(out.ok, JSON.stringify(out.checks)).toBe(true)
    expect(Object.keys(out.checks)).toEqual(['run.succeeded', 'run.headlessFlag', 'D7.islandSelfSubmitted', 'D11.reviewSkippedWithOutputs', 'run.posterIsFileRef'])
  })
  it('fails when the review step ran instead of skipping', () => {
    const rec = load()
    const review = rec.steps.find((s) => s.key === 'review/0/confirm')!
    review.status = 'succeeded'
    const r = new Report('headless', 'h'); checkHeadlessHello(rec, r)
    expect(r.finish().checks['D11.reviewSkippedWithOutputs']?.pass).toBe(false)
  })
  it('fails when headless is not flagged on the row', () => {
    const rec = load(); rec.run!.headless = false
    const r = new Report('headless', 'h'); checkHeadlessHello(rec, r)
    expect(r.finish().checks['run.headlessFlag']?.pass).toBe(false)
  })
  it('fails when the island step did not succeed on its own', () => {
    const rec = load()
    rec.steps.find((s) => s.key === 'pick/0/choose')!.status = 'failed'
    const r = new Report('headless', 'h'); checkHeadlessHello(rec, r)
    expect(r.finish().checks['D7.islandSelfSubmitted']?.pass).toBe(false)
  })
  it('fails when the poster output is not a File ref', () => {
    const rec = load(); rec.run!.outputs!.poster = 'poster.svg'
    const r = new Report('headless', 'h'); checkHeadlessHello(rec, r)
    expect(r.finish().checks['run.posterIsFileRef']?.pass).toBe(false)
  })
})
