import { describe, expect, it, vi } from 'vitest'
import type { FileRef } from './types'
import { RegisterFileError, withRegisterRetry, REGISTER_RETRY_DELAYS_MS } from './registerRetry'

const ref = (path: string): FileRef => ({ path, name: 'f.jpg', contentType: 'image/jpeg', size: 1, url: `/api/uploads/${path}` })

function sleeper() {
  const slept: number[] = []
  const sleep = vi.fn(async (ms: number) => {
    slept.push(ms)
  })
  return { sleep, slept }
}

describe('withRegisterRetry', () => {
  it('retries a 5xx answer, sleeping the ladder between attempts, and returns the eventual ref', async () => {
    const { sleep, slept } = sleeper()
    let calls = 0
    const flaky = async (path: string) => {
      calls += 1
      if (calls <= 2) throw new RegisterFileError(path, 500)
      return ref(path)
    }
    const out = await withRegisterRetry(flaky, sleep)('workflows/x/a.jpg')
    expect(out.path).toBe('workflows/x/a.jpg')
    expect(calls).toBe(3)
    expect(slept).toEqual(REGISTER_RETRY_DELAYS_MS)
  })

  it('retries a network failure (no status) the same way', async () => {
    const { sleep, slept } = sleeper()
    let calls = 0
    const flaky = async (path: string) => {
      calls += 1
      if (calls === 1) throw new TypeError('Failed to fetch')
      return ref(path)
    }
    await expect(withRegisterRetry(flaky, sleep)('workflows/x/a.jpg')).resolves.toMatchObject({ path: 'workflows/x/a.jpg' })
    expect(calls).toBe(2)
    expect(slept).toEqual([REGISTER_RETRY_DELAYS_MS[0]])
  })

  it('does not retry a 4xx — the request itself is wrong, and asking again will not fix it', async () => {
    const { sleep, slept } = sleeper()
    let calls = 0
    const refused = async (path: string) => {
      calls += 1
      throw new RegisterFileError(path, 400)
    }
    await expect(withRegisterRetry(refused, sleep)('workflows/x/a.jpg')).rejects.toBeInstanceOf(RegisterFileError)
    expect(calls).toBe(1)
    expect(slept).toEqual([])
  })

  it('gives up after the ladder is spent and throws the last error, which names the file', async () => {
    const { sleep, slept } = sleeper()
    let calls = 0
    const down = async (path: string) => {
      calls += 1
      throw new RegisterFileError(path, 503)
    }
    await expect(withRegisterRetry(down, sleep)('workflows/x/frame-159.jpg')).rejects.toThrow(
      'registerFile workflows/x/frame-159.jpg: files/register answered 503',
    )
    expect(calls).toBe(REGISTER_RETRY_DELAYS_MS.length + 1)
    expect(slept).toEqual(REGISTER_RETRY_DELAYS_MS)
  })

  it('passes an abort signal to the sleep so a cancelled run does not linger in a backoff', async () => {
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
    })
    let calls = 0
    const flaky = async (path: string) => {
      calls += 1
      if (calls === 1) throw new RegisterFileError(path, 502)
      return ref(path)
    }
    const controller = new AbortController()
    await withRegisterRetry(flaky, sleep, controller.signal)('workflows/x/a.jpg')
    expect(sleep).toHaveBeenCalledTimes(1)
  })
})
