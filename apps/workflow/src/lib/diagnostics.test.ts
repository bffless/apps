/**
 * The client diagnostics buffer (apps#526): what the run page's Copy / Attach
 * report is made of. The capture is deliberately generic — `console.error`,
 * window `error`, `unhandledrejection` — because everything the hosts fail on
 * already lands there; these tests hold the buffer to its cap and the payload
 * to its decided shape, and the replace-not-stack rule to the record path
 * (`withDiagnostics`; the live path's copy of the same rule is the reducer's,
 * tested in `runner/reducer.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildDiagnostics,
  copyDiagnostics,
  diagnosticsAnnotation,
  installDiagnostics,
  recentErrors,
  resetDiagnostics,
  withDiagnostics,
} from './diagnostics'
import type { Annotation } from './runner/types'

let uninstall: (() => void) | null = null

function install() {
  uninstall = installDiagnostics()
}

afterEach(() => {
  uninstall?.()
  uninstall = null
  resetDiagnostics()
  vi.restoreAllMocks()
})

describe('installDiagnostics', () => {
  it('captures console.error and window error events, and calls the real console through', () => {
    const real = vi.spyOn(console, 'error').mockImplementation(() => {})
    install()

    console.error('island handshake', 'timed out')
    window.dispatchEvent(new ErrorEvent('error', { message: 'worker died' }))

    const entries = recentErrors()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ source: 'console', message: 'island handshake timed out' })
    expect(entries[1]).toMatchObject({ source: 'error', message: 'worker died' })
    expect(real).toHaveBeenCalledWith('island handshake', 'timed out')
  })

  it('caps the buffer at the last 50 entries', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    install()

    for (let n = 0; n < 60; n += 1) console.error(`boom ${n}`)

    const entries = recentErrors()
    expect(entries).toHaveLength(50)
    expect(entries[0]?.message).toBe('boom 10')
    expect(entries[49]?.message).toBe('boom 59')
  })

  it('is idempotent, and uninstall restores console.error', () => {
    const real = console.error
    install()
    const second = installDiagnostics() // no-op: already installed
    expect(console.error).not.toBe(real)
    second()
    expect(console.error).not.toBe(real) // the no-op's uninstall removes nothing
    uninstall?.()
    uninstall = null
    expect(console.error).toBe(real)
  })
})

describe('buildDiagnostics', () => {
  it('carries the decided payload shape, with `dev` for an unbaked build', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    install()
    console.error('boom')

    const payload = buildDiagnostics({
      runId: 'run_1',
      steps: [{ key: 'main/0/hello', status: 'failed' }],
    })

    expect(payload.buildSha).toBe('dev')
    expect(payload.url).toBe(window.location.href)
    expect(payload.userAgent).toBe(navigator.userAgent)
    expect(payload.runId).toBe('run_1')
    expect(payload.steps).toEqual([{ key: 'main/0/hello', status: 'failed' }])
    expect(payload.errors).toHaveLength(1)
    expect(payload.errors[0]?.message).toBe('boom')
    expect(typeof payload.at).toBe('number')
  })
})

describe('copyDiagnostics', () => {
  const payload = () => buildDiagnostics({ runId: 'run_1', steps: [] })

  it('writes the payload as JSON and reports success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      await expect(copyDiagnostics(payload())).resolves.toBe(true)
      expect(JSON.parse(writeText.mock.calls[0]?.[0] as string).runId).toBe('run_1')
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    }
  })

  it('reports false, and never throws, when there is no clipboard or it refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    await expect(copyDiagnostics(payload())).resolves.toBe(false)

    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      await expect(copyDiagnostics(payload())).resolves.toBe(false)
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    }
  })
})

describe('withDiagnostics', () => {
  it('replaces the previous diagnostics annotation instead of stacking, and keeps the rest', () => {
    const warning: Annotation = { level: 'warning', message: 'already there' }
    const first = diagnosticsAnnotation(buildDiagnostics({ runId: 'run_1', steps: [] }))
    const second = diagnosticsAnnotation(buildDiagnostics({ runId: 'run_1', steps: [] }))

    const once = withDiagnostics([warning], first)
    const twice = withDiagnostics(once, second)

    expect(twice).toEqual([warning, second])
    expect(second.level).toBe('notice')
    expect(second.title).toBe('Diagnostics')
    expect(second.message).toBe(`Client diagnostics attached from ${window.location.href}`)
  })
})
