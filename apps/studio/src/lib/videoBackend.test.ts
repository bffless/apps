import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  asBackend,
  parseCapabilities,
  resolveVideoBackend,
  stepExecutor,
  getVideoBackend,
  getResolvedVideoBackend,
  setVideoBackend,
  subscribeVideoBackend,
  resetVideoBackendForTests,
  type VideoCapabilities,
} from './videoBackend'

const NONE: VideoCapabilities = { server: false, executors: [], defaultExecutor: null, remote: null }
const LOCAL_ONLY: VideoCapabilities = { server: true, executors: ['local'], defaultExecutor: 'local', remote: null }
const REMOTE_ONLY: VideoCapabilities = {
  server: true, executors: ['remote'], defaultExecutor: 'remote', remote: { ready: true, version: 'preview' },
}
const BOTH: VideoCapabilities = { server: true, executors: ['local', 'remote'], defaultExecutor: 'remote', remote: { ready: true } }

describe('asBackend', () => {
  it('accepts the four choices and the browser alias', () => {
    expect(asBackend('wasm')).toBe('wasm')
    expect(asBackend('browser')).toBe('wasm')
    expect(asBackend('server')).toBe('server')
    expect(asBackend('local')).toBe('local')
    expect(asBackend('remote')).toBe('remote')
    expect(asBackend('nope')).toBeNull()
    expect(asBackend(null)).toBeNull()
  })
})

describe('parseCapabilities', () => {
  it('reads the CE >= 0.4.31 payload', () => {
    expect(
      parseCapabilities({ server: true, ops: ['probe'], version: null, executors: ['remote'], defaultExecutor: 'remote', remote: { ready: true, version: 'v' } }),
    ).toEqual({ server: true, executors: ['remote'], defaultExecutor: 'remote', remote: { ready: true, version: 'v' } })
  })
  it('reads remote.maxInflight (CE >= 0.4.31 Plan 4) and ignores a non-numeric one', () => {
    expect(
      parseCapabilities({ server: true, executors: ['remote'], defaultExecutor: 'remote', remote: { ready: true, maxInflight: 4 } }).remote,
    ).toEqual({ ready: true, maxInflight: 4 })
    expect(
      parseCapabilities({ server: true, executors: ['remote'], defaultExecutor: 'remote', remote: { ready: true, maxInflight: 'lots' } }).remote,
    ).toEqual({ ready: true })
  })
  it('tolerates the pre-remote payload (no executors): server:true means local only', () => {
    expect(parseCapabilities({ server: true, ops: ['probe'], version: 'ffmpeg 7' })).toEqual({
      server: true, executors: ['local'], defaultExecutor: 'local', remote: null,
    })
    expect(parseCapabilities({ server: false, ops: [], version: null })).toEqual(NONE)
  })
  it('drops unknown executor names and garbage', () => {
    expect(parseCapabilities({ server: true, executors: ['local', 'gpu'], defaultExecutor: 'gpu' })).toEqual({
      server: true, executors: ['local'], defaultExecutor: 'local', remote: null,
    })
    expect(parseCapabilities(null)).toEqual(NONE)
  })
})

describe('resolveVideoBackend (pure)', () => {
  it('a ?videoBackend override beats everything, and browser is an alias of wasm', () => {
    expect(resolveVideoBackend('?videoBackend=wasm', 'remote', BOTH)).toMatchObject({ backend: 'wasm', executor: null, source: 'override' })
    expect(resolveVideoBackend('?videoBackend=browser', null, BOTH).backend).toBe('wasm')
    expect(resolveVideoBackend('?videoBackend=server', null, NONE)).toMatchObject({ backend: 'server', source: 'override', note: null })
  })
  it('a stored choice beats the probe', () => {
    expect(resolveVideoBackend('', 'wasm', BOTH)).toMatchObject({ backend: 'wasm', source: 'stored' })
  })
  it('defaults by probe capability', () => {
    expect(resolveVideoBackend('', null, LOCAL_ONLY)).toMatchObject({ backend: 'server', executor: 'local', source: 'probe' })
    expect(resolveVideoBackend('', null, NONE)).toMatchObject({ backend: 'wasm', executor: null, source: 'probe' })
    expect(resolveVideoBackend('', null, null)).toMatchObject({ backend: 'wasm', executor: null, source: 'probe' })
  })
  it('server (auto) reports the instance default as its effective executor', () => {
    expect(resolveVideoBackend('', 'server', REMOTE_ONLY).executor).toBe('remote')
    expect(resolveVideoBackend('', 'server', LOCAL_ONLY).executor).toBe('local')
    // no probe / pre-remote CE: assume local (conservative for the lane cap)
    expect(resolveVideoBackend('', 'server', null).executor).toBe('local')
  })
  it('remote / local are honoured only when the probe lists them', () => {
    expect(resolveVideoBackend('', 'remote', BOTH)).toMatchObject({ backend: 'remote', executor: 'remote', note: null })
    expect(resolveVideoBackend('?videoBackend=local', null, BOTH)).toMatchObject({ backend: 'local', executor: 'local', note: null })
  })
  it('falls back to server (auto) with a note when the executor is missing but server ops exist', () => {
    const r = resolveVideoBackend('', 'remote', LOCAL_ONLY)
    expect(r).toMatchObject({ backend: 'server', executor: 'local', source: 'stored' })
    expect(r.note).toMatch(/Remote isn't enabled on this instance/)
    const l = resolveVideoBackend('?videoBackend=local', null, REMOTE_ONLY)
    expect(l).toMatchObject({ backend: 'server', executor: 'remote', source: 'override' })
    expect(l.note).toMatch(/Local server isn't enabled/)
  })
  it('falls back to wasm with a note when there are no server ops at all', () => {
    const r = resolveVideoBackend('', 'remote', NONE)
    expect(r).toMatchObject({ backend: 'wasm', executor: null })
    expect(r.note).toMatch(/Remote isn't enabled/)
  })
  it('does not honour local/remote when server:false, even if executors lists them (operator-config-only payload)', () => {
    const r = resolveVideoBackend('', 'local', { server: false, executors: ['local'], defaultExecutor: 'local', remote: null })
    expect(r).toMatchObject({ backend: 'wasm', executor: null })
    expect(r.note).toMatch(/Local server isn't enabled/)
  })
  it('falls back to server (auto) when the probe failed (executors unknown)', () => {
    const r = resolveVideoBackend('', 'remote', null)
    expect(r).toMatchObject({ backend: 'server', executor: 'local' })
    expect(r.note).toMatch(/couldn't be verified/)
  })
  it('garbage values fall through to the probe default', () => {
    expect(resolveVideoBackend('?videoBackend=nope', 'nope', LOCAL_ONLY).backend).toBe('server')
  })
})

describe('stepExecutor', () => {
  it('names the executor only for explicit choices', () => {
    expect(stepExecutor('remote')).toBe('remote')
    expect(stepExecutor('local')).toBe('local')
    expect(stepExecutor('server')).toBeUndefined()
    expect(stepExecutor('wasm')).toBeUndefined()
  })
})

describe('getVideoBackend / getResolvedVideoBackend (session memo)', () => {
  afterEach(() => {
    resetVideoBackendForTests()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  const probeReply = (caps: object) => new Response(JSON.stringify(caps))

  it('probes once and memoizes — concurrent callers share one fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(probeReply({ server: true, executors: ['local'], defaultExecutor: 'local' }))
    vi.stubGlobal('fetch', fetchMock)
    const [a, b] = await Promise.all([getVideoBackend(), getVideoBackend()])
    expect(a).toBe('server')
    expect(b).toBe('server')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never rejects: probe failure resolves wasm (older CE runs exactly as today)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(getVideoBackend()).resolves.toBe('wasm')
  })

  it('a non-ok probe response (e.g. 404, no rule imported) resolves wasm', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })))
    await expect(getVideoBackend()).resolves.toBe('wasm')
  })

  it('a non-JSON 200 probe response resolves wasm', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>')))
    await expect(getVideoBackend()).resolves.toBe('wasm')
  })

  it('a stored wasm choice never touches the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.setItem('videoBackend', 'wasm')
    await expect(getVideoBackend()).resolves.toBe('wasm')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a stored server-side choice still probes (to validate it and learn the default executor)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(probeReply({ server: true, executors: ['remote'], defaultExecutor: 'remote', remote: { ready: true } }))
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.setItem('videoBackend', 'remote')
    const r = await getResolvedVideoBackend()
    expect(r).toMatchObject({ backend: 'remote', executor: 'remote', source: 'stored', note: null })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a stored server choice survives a failed probe (today’s behaviour), with a local cap', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    window.localStorage.setItem('videoBackend', 'server')
    expect(await getResolvedVideoBackend()).toMatchObject({ backend: 'server', executor: 'local', source: 'stored' })
  })

  it('setVideoBackend persists, resets the memo and notifies subscribers', async () => {
    // mockImplementation (not mockResolvedValue) — this test calls getResolvedVideoBackend
    // twice (before and after setVideoBackend resets the memo), and a real Response body
    // can only be read once; a fresh Response must be minted per fetch call.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          probeReply({ server: true, executors: ['local', 'remote'], defaultExecutor: 'local', remote: { ready: true } }),
        ),
      ),
    )
    const listener = vi.fn()
    const unsub = subscribeVideoBackend(listener)
    expect((await getResolvedVideoBackend()).backend).toBe('server')
    setVideoBackend('remote')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem('videoBackend')).toBe('remote')
    expect((await getResolvedVideoBackend()).backend).toBe('remote')
    unsub()
    setVideoBackend('wasm')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('getResolvedVideoBackend — a failed probe is not memoised', () => {
  afterEach(() => {
    resetVideoBackendForTests()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('retries the probe on the next call after a failure (older CE / network / pre-login), and memoises the success', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(async () =>
        new Response(JSON.stringify({ server: true, executors: ['remote'], defaultExecutor: 'remote', remote: { ready: true } })),
      )
    vi.stubGlobal('fetch', fetchMock)
    expect((await getResolvedVideoBackend()).probe).toBeNull()
    expect((await getResolvedVideoBackend()).backend).toBe('server')
    expect((await getResolvedVideoBackend()).backend).toBe('server')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
