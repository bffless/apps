import { describe, expect, it } from 'vitest'
import { loginUrl } from '@bffless/workflow-headless'
import { adminOriginOf, mintAppToken, type RequestLike } from '../src/token.js'

describe('adminOriginOf', () => {
  it('is the harness\'s own adminOrigin rule (parity with loginUrl)', () => {
    for (const h of ['https://workflow-mcp.j5s.dev', 'https://workflow.j5s.dev', 'http://localhost:5173']) {
      expect(adminOriginOf(h)).toBe(new URL(loginUrl(h)).origin)
    }
    expect(adminOriginOf('https://workflow-mcp.j5s.dev')).toBe('https://admin.j5s.dev')
    expect(adminOriginOf('http://localhost:5173')).toBe('http://localhost:5173')
  })
})

describe('mintAppToken', () => {
  it('posts to admin.<domain>/api/app-tokens with the project, scopes and a 1-day expiry, and revokes by id', async () => {
    const calls: Array<{ method: string; url: string; data?: unknown }> = []
    const request: RequestLike = {
      async post(url, options) {
        calls.push({ method: 'POST', url, data: options.data })
        return { status: () => 201, json: async () => ({ data: { id: 'tok-1', scopes: ['workflow:read'] }, token: 'bfat_raw' }), text: async () => '' }
      },
      async delete(url) {
        calls.push({ method: 'DELETE', url })
        return { status: () => 204 }
      },
    }
    const minted = await mintAppToken(request, 'https://workflow-mcp.j5s.dev', 'bffless/workflow-mcp', ['workflow:read'], 'walk')
    expect(minted.token).toBe('bfat_raw')
    expect(calls[0]!.url).toBe('https://admin.j5s.dev/api/app-tokens')
    const data = calls[0]!.data as { name: string; project: string; scopes: string[]; expiresAt: string }
    expect(data).toMatchObject({ name: 'walk', project: 'bffless/workflow-mcp', scopes: ['workflow:read'] })
    const ttl = new Date(data.expiresAt).getTime() - Date.now()
    expect(ttl).toBeGreaterThan(23 * 3600_000)
    expect(ttl).toBeLessThanOrEqual(24 * 3600_000)
    await minted.revoke()
    expect(calls[1]).toEqual({ method: 'DELETE', url: 'https://admin.j5s.dev/api/app-tokens/tok-1' })
  })

  it('throws with the status when the mint is refused', async () => {
    const request: RequestLike = {
      async post() {
        return { status: () => 403, json: async () => ({}), text: async () => 'not a member' }
      },
      async delete() {
        return { status: () => 204 }
      },
    }
    await expect(mintAppToken(request, 'https://h.example', 'o/r', ['a:b'], 'x')).rejects.toThrow(/403 not a member/)
  })
})
