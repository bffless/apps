// @vitest-environment node
import { SCOPES } from '@bffless/workflow-agent-tools'
import { describe, expect, it } from 'vitest'
import { authorizationServerOf, documentFor, handler } from './wellKnown'

describe('the protected-resource document (RFC 9728)', () => {
  it('names this host’s endpoint, CE’s authorization server on admin.<domain>, and the catalog’s scopes', () => {
    const doc = documentFor('workflow.j5s.dev')
    expect(doc).toEqual({
      resource: 'https://workflow.j5s.dev/api/workflow/mcp',
      authorization_servers: ['https://admin.j5s.dev'],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'BFFless Workflow',
      resource_documentation: 'https://github.com/bffless/apps/blob/main/apps/workflow/docs/spec/10-agent-embedding.md',
    })
    expect(doc.scopes_supported).toEqual(['workflow:read', 'workflow:run', 'workflow:files'])
  })

  it('restates lib/adminOrigin’s rule: swap the first label for admin, keep a single-label host', () => {
    expect(authorizationServerOf('workflow-mcp.j5s.dev')).toBe('https://admin.j5s.dev')
    expect(authorizationServerOf('a.b.c.example')).toBe('https://admin.b.c.example')
    expect(authorizationServerOf('localhost:5173')).toBe('https://localhost:5173')
  })

  it('reads the host from x-forwarded-host, then host, and refuses none', () => {
    expect(JSON.parse(handler({ request: { headers: { 'x-forwarded-host': 'workflow.j5s.dev', host: 'localhost:3000' } } }).json).resource).toBe('https://workflow.j5s.dev/api/workflow/mcp')
    expect(JSON.parse(handler({ request: { headers: { host: 'only.example' } } }).json).authorization_servers).toEqual(['https://admin.example'])
    expect(handler({ request: { headers: {} } }).ok).toBe(false)
  })
})
