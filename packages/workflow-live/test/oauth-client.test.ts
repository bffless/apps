import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { metadataUrlOf, pkcePair, waitForCallback } from '../src/oauth-client.js'

describe('oauth-client', () => {
  it('makes an S256 PKCE pair of the right shape', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('captures one callback and answers the browser', async () => {
    const port = 40000 + Math.floor(Math.random() * 2000)
    const listener = waitForCallback(port, 5_000)
    const res = await fetch(`${listener.url}?code=abc&state=xyz`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('close this tab')
    await expect(listener.done).resolves.toEqual({ code: 'abc', state: 'xyz' })
  })

  it('names the RFC 8414 document', () => {
    expect(metadataUrlOf('https://admin.j5s.dev/')).toBe('https://admin.j5s.dev/.well-known/oauth-authorization-server')
  })
})
