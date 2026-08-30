import { describe, expect, it } from 'vitest'
import { Report, exitCodeOf, toMarkdown } from '../src/report.js'

describe('Report', () => {
  it('passes when every check passes', () => {
    const r = new Report('hello', 'https://x.test')
    expect(r.expect('a', true, 1)).toBe(true)
    const out = r.finish()
    expect(out.ok).toBe(true)
    expect(exitCodeOf(out)).toBe(0)
    expect(out.checks.a).toEqual({ pass: true, evidence: 1 })
  })
  it('fails on one FAIL and keeps recording after it', () => {
    const r = new Report('hello', 'https://x.test')
    r.expect('a', false, { got: 1 })
    r.expect('b', true)
    const out = r.finish()
    expect(out.ok).toBe(false)
    expect(exitCodeOf(out)).toBe(1)
    expect(Object.keys(out.checks)).toEqual(['a', 'b'])
  })
  it('blocked wins over fail and exits 2', () => {
    const r = new Report('studio-headless', 'https://x.test')
    r.expect('a', false)
    r.block('no credentials')
    const out = r.finish()
    expect(out.blocked).toBe('no credentials')
    expect(exitCodeOf(out)).toBe(2)
  })
  it('dedups run ids and counts kickoffs', () => {
    const r = new Report('w', 'h')
    r.run('run_1'); r.run('run_1'); r.kickoff()
    const out = r.finish()
    expect(out.runIds).toEqual(['run_1'])
    expect(out.spend.studioKickoffs).toBe(1)
  })
  it('renders README-style rows', () => {
    const r = new Report('hello', 'https://x.test')
    r.expect('D6.signedImg', true, 'https://storage.googleapis.com/…')
    r.expect('D4.sandboxed', false, 'origin=https://workflow.j5s.dev')
    const md = toMarkdown(r.finish())
    expect(md).toContain('- [x] **D6.signedImg — PASS.** "https://storage.googleapis.com/…"')
    expect(md).toContain('- [ ] **D4.sandboxed — FAIL.** "origin=https://workflow.j5s.dev"')
  })
  it('renders a BLOCKED header', () => {
    const r = new Report('hello', 'h'); r.block('harness unreachable')
    expect(toMarkdown(r.finish())).toMatch(/^\*\*BLOCKED — harness unreachable\*\*/)
  })
  it('scoped() prefixes check names but records on the parent report', () => {
    const r = new Report('w', 'h')
    const scoped = r.scoped('dispatch.')
    expect(scoped.expect('a', true, 1)).toBe(true)
    const out = r.finish()
    expect(out.checks['dispatch.a']).toEqual({ pass: true, evidence: 1 })
  })
  it('throws on a duplicate check name, but scoped names do not collide with the same short name', () => {
    const r = new Report('w', 'h')
    r.expect('a', true)
    expect(() => r.expect('a', false)).toThrow(/duplicate check name: a/)
    expect(() => r.scoped('p.').expect('a', true)).not.toThrow()
  })
})
