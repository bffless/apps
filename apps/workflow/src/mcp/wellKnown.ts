/**
 * `wellknown` — the one function step of the harness's RFC 9728
 * protected-resource document rule (`rules/_custom/well-known/get.rule.yaml`;
 * spec 10 D23 rung 3; Phase 3 plan, Task C1). An MCP client reads this before
 * it has any credential, so the rule is served despite deployment visibility
 * (`bypassVisibility`, CE ≥ the story-7 release). Every URL is derived from
 * the request's host — the catalog app is instance-agnostic (06): the resource
 * is this host's MCP endpoint, the authorization server is CE on `admin.<the
 * rest of the host>` (the harness's own `lib/adminOrigin.ts` rule, restated
 * here because the bundle may not import it; `wellKnown.test.ts` holds the two
 * equal), and the scopes are the catalog's.
 */
import { SCOPES } from '@bffless/workflow-agent-tools'

export const MCP_PATH = '/api/workflow/mcp'

/** `workflow.j5s.dev` → `https://admin.j5s.dev`; a single-label host (localhost, with its port) keeps itself. */
export function authorizationServerOf(host: string): string {
  const hostname = host.split(':')[0]
  const labels = hostname.split('.')
  const adminHost = labels.length > 1 ? ['admin', ...labels.slice(1)].join('.') : host
  return `https://${adminHost}`
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' ? first.split(',')[0].trim() : ''
}

export interface ProtectedResourceDocument {
  resource: string
  authorization_servers: string[]
  scopes_supported: string[]
  bearer_methods_supported: ['header']
  resource_name: string
  resource_documentation: string
}

export function documentFor(host: string): ProtectedResourceDocument {
  return {
    resource: `https://${host}${MCP_PATH}`,
    authorization_servers: [authorizationServerOf(host)],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'BFFless Workflow',
    resource_documentation: 'https://github.com/bffless/apps/blob/main/apps/workflow/docs/spec/10-agent-embedding.md',
  }
}

export function handler(data: { request?: { headers?: Record<string, string | string[] | undefined> } }): { json: string; ok: boolean } {
  const headers = data.request?.headers ?? {}
  const host = header(headers, 'x-forwarded-host') || header(headers, 'host')
  if (host === '') return { json: JSON.stringify({ error: 'no_host', message: 'the request names no host' }), ok: false }
  return { json: JSON.stringify(documentFor(host)), ok: true }
}
