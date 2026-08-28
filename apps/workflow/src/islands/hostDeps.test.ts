/**
 * `signFile` is the one host dep with a decision in it — the client-side half
 * of the `files/sign` rule's confinement — so it is the one that needs tests:
 * a path outside the harness prefix must never reach the network, and the
 * rule's own refusal must reach the island as a message, not a bare status.
 */
import { describe, expect, it, vi } from 'vitest'
import { signFile } from './hostDeps'
import type { HttpJson } from '../lib/runner/adapters/pipeline'

const okHttp = () =>
  vi.fn(async () => ({ status: 200, ok: true, body: { url: 'https://b/p.svg?sig=1', expiresIn: 3600 } }))

describe('signFile', () => {
  it('posts the path to the sign rule and answers with the presigned url', async () => {
    const http = okHttp()
    const signed = await signFile(http as unknown as HttpJson)('workflows/hello/runs/r1/poster.svg')

    expect(http).toHaveBeenCalledWith('/api/workflow/files/sign', {
      method: 'POST',
      body: { path: 'workflows/hello/runs/r1/poster.svg' },
    })
    expect(signed).toEqual({ url: 'https://b/p.svg?sig=1', expiresIn: 3600 })
  })

  it.each(['uploads/other/x.svg', '/workflows/x.svg', 'workflows/../secrets/x', 'workflows//x', ''])(
    'refuses %o before any request',
    async (path) => {
      const http = okHttp()
      await expect(signFile(http as unknown as HttpJson)(path)).rejects.toThrow(/workflows\//)
      expect(http).not.toHaveBeenCalled()
    },
  )

  it('surfaces the rule refusal message on a non-2xx answer', async () => {
    const http = vi.fn(async () => ({ status: 400, ok: false, body: { error: 'nope, not confined' } }))
    await expect(signFile(http as unknown as HttpJson)('workflows/x.svg')).rejects.toThrow(
      'nope, not confined',
    )
  })

  it('rejects an answer with no usable url', async () => {
    const http = vi.fn(async () => ({ status: 200, ok: true, body: { url: '' } }))
    await expect(signFile(http as unknown as HttpJson)('workflows/x.svg')).rejects.toThrow(/no url/)
  })
})
