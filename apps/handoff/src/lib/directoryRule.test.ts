// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural guard for the /api/directory people-picker proxy rule.
 *
 * The directory autocomplete (DirectorySearch in ManageAccessPanel) calls
 * GET /api/directory?search=<q>. That path must be a real proxy rule — without
 * it the request falls through to the SPA index.html (200 text/html), the query
 * parses zero users, and the picker shows "No people found" with no way to add
 * anyone. This asserts the rule exists and forwards to the CE backend's
 * member-accessible user directory, carrying the session cookie (no admin key).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const proxy = JSON.parse(
  readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, any>> }

const rule = proxy.rules.find((r) => r.pathPattern === '/api/directory')

describe('handoff /api/directory proxy rule', () => {
  it('exists as an enabled GET proxy rule', () => {
    expect(rule).toBeTruthy()
    expect(rule!.method).toBe('GET')
    expect(rule!.proxyType).toBe('external_proxy')
    expect(rule!.isEnabled).toBe(true)
  })

  it('forwards to the CE backend member-accessible directory endpoint', () => {
    expect(rule!.targetUrl).toBe('http://localhost:3000/api/users/directory')
    expect(rule!.stripPrefix).toBe(true)
  })

  it('carries the session cookie so the requester is authed as themselves (no admin key)', () => {
    expect(rule!.forwardCookies).toBe(true)
  })
})
