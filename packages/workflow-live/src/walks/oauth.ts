/**
 * OAuth 2.1 against the harness: the M5 Phase-3 walk (spec 10, D23 rung 3;
 * apps#554 story 9; Phase 3 plan, Task C3). Drives the code flow the way
 * claude.ai's connector does, headlessly: RFC 9728 discovery on the harness →
 * RFC 8414 metadata on CE's admin host → dynamic client registration → the
 * authorize step in the signed-in member's browser (the consent page, Allow) →
 * the callback on a local listener → the PKCE exchange → an MCP call as the
 * member → refresh rotation → a narrowed consent that cannot run → revocation.
 * Runs against a public host (the scratch project) and the private harness
 * alike; on the private one the anonymous 401 is the visibility gate's.
 */
import { writeFile } from 'node:fs/promises'
import { callPageTool, waitForPageTools } from '@bffless/workflow-headless'
import { credentials } from '../env.js'
import { openMcp, rawPost } from '../mcp-client.js'
import { fetchJson, metadataUrlOf, pkcePair, postForm, waitForCallback, type AuthorizationServerMetadata, type ProtectedResourceDocument } from '../oauth-client.js'
import { openSession } from '../session.js'
import type { Walk } from './index.js'

interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
}
interface ToolAnswer {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
}
const text = (r: ToolAnswer) => (r.content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n')
const errorsOf = (r: ToolAnswer) => ((r.structuredContent ?? {}).errors ?? {}) as Record<string, string>
const brief = (r: ToolAnswer) => ({ isError: r.isError ?? false, text: text(r).slice(0, 200) })

const STEP = 'pick/0/choose'

export const oauth: Walk = async ({ args, env, report }) => {
  const log: string[] = []
  const say = (line: string) => {
    log.push(line)
  }
  const mcpUrl = `${args.harness}/api/workflow/mcp`
  const creds = credentials(env)
  if (!creds) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing (the member who consents)')
  let browser: Awaited<ReturnType<typeof openSession>> | null = null
  try {
    // --- D23: discovery, pre-credential
    const prm = await fetchJson<ProtectedResourceDocument>(`${args.harness}/.well-known/oauth-protected-resource`)
    const issuer = prm.body?.authorization_servers?.[0] ?? ''
    const meta = issuer ? await fetchJson<AuthorizationServerMetadata>(metadataUrlOf(issuer)) : { status: 0, body: null, headers: new Headers() }
    report.expect(
      'D23.prmServed',
      prm.status === 200 && prm.body?.resource === mcpUrl && meta.status === 200 && (meta.body?.code_challenge_methods_supported ?? []).includes('S256') && typeof meta.body?.registration_endpoint === 'string',
      { prm: prm.status, resource: prm.body?.resource, issuer, metadata: meta.status, methods: meta.body?.code_challenge_methods_supported },
    )
    if (!meta.body) return report.block(`no authorization-server metadata at ${issuer || '(no issuer)'}`)
    say(`issuer ${issuer}`)

    const anon = await rawPost(mcpUrl, { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'anon', version: '0' } } })
    const hint = anon.headers['www-authenticate'] ?? ''
    report.expect('D23.anon401Hints', anon.status === 401 && hint.includes(`resource_metadata="${args.harness}/.well-known/oauth-protected-resource"`), { status: anon.status, hint })

    // --- RFC 7591
    const port = 41000 + Math.floor(Math.random() * 1000)
    const listener = waitForCallback(port, 120_000)
    const registered = await fetchJson<{ client_id?: string }>(meta.body.registration_endpoint!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'workflow-live', redirect_uris: [listener.url], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    })
    const clientId = registered.body?.client_id ?? ''
    report.expect('D23.dcr', registered.status === 201 && clientId !== '', { status: registered.status, clientId })
    if (!clientId) {
      listener.close()
      return
    }

    // --- the member consents in the browser
    browser = await openSession({ base: args.harness, out: args.out, credentials: creds })
    const who = await browser.api.json('/api/workflow/whoami')
    const memberId = String((who.body as { id?: string } | null)?.id ?? '')
    const consentFlow = async (scope: string, untick: string[], stamp: string) => {
      const pkce = pkcePair()
      const state = `st-${Math.random().toString(36).slice(2)}`
      const authorize = new URL(meta.body!.authorization_endpoint)
      authorize.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: listener.url, code_challenge: pkce.challenge, code_challenge_method: 'S256', state, scope, resource: mcpUrl }).toString()
      const cb = waitForCallback(port, 120_000)
      await browser!.page.goto(authorize.toString(), { waitUntil: 'networkidle' })
      await browser!.page.waitForURL((u) => u.pathname === '/oauth/consent', { timeout: 30_000 })
      await browser!.page.waitForSelector('button:has-text("Allow")', { timeout: 15_000 })
      const boxes = await browser!.page.$$('[role="checkbox"]')
      for (const s of untick) await browser!.page.click(`label[for="scope-${s}"]`)
      await browser!.shot(`consent-${stamp}`)
      await browser!.page.click('button:has-text("Allow")')
      const callback = await cb.done
      return { pkce, state, callback, boxes: boxes.length }
    }
    listener.close() // the per-flow listeners take over the port
    const first = await consentFlow('workflow:read workflow:run workflow:files', [], '1-all')
    report.expect('D23.consentGrants', first.boxes === 3 && typeof first.callback.code === 'string' && first.callback.state === first.state, { boxes: first.boxes, callback: { ...first.callback, code: first.callback.code ? '…' : undefined } })
    if (!first.callback.code) return

    // --- the exchange: the access token is an app token
    const tokens = await postForm<TokenResponse>(meta.body.token_endpoint, { grant_type: 'authorization_code', code: first.callback.code, redirect_uri: listener.url, client_id: clientId, code_verifier: first.pkce.verifier })
    const t = tokens.body
    report.expect('D23.tokenIsAppToken', tokens.status === 200 && /^bfat_/.test(t?.access_token ?? '') && t?.expires_in === 3600 && typeof t?.refresh_token === 'string' && t?.scope === 'workflow:read workflow:run workflow:files', { status: tokens.status, scope: t?.scope, expires_in: t?.expires_in })
    if (!t) return

    // --- as the member: park a run through the page, read it back through the token
    // The consent flow left the page on the callback listener; the page tools live on the harness.
    await browser.page.goto(args.harness, { waitUntil: 'networkidle' })
    await waitForPageTools(browser.page, { timeoutMs: 30_000 })
    const started = await callPageTool(browser.page, 'workflow.start', { impl: 'hello', workflow: 'interactive', inputs: { greeting: 'Hello', names: ['world', 'studio'] } })
    const runId = String(((started.structuredContent ?? {}) as { runId?: string }).runId ?? '')
    const awaited = await callPageTool(browser.page, 'workflow.await', { until: 'waiting', timeoutMs: 120_000 })
    report.note(`page workflow.start → ${JSON.stringify(started).slice(0, 300)}; await → ${JSON.stringify(awaited).slice(0, 200)}`)
    const session = await openMcp(args.harness, { token: t.access_token })
    try {
      const status = (await session.client.callTool({ name: 'workflow.status', arguments: { runId } })) as ToolAnswer
      const runs = (await session.client.callTool({ name: 'workflow.runs', arguments: { impl: 'hello', workflow: 'interactive', limit: 50 } })) as ToolAnswer
      const mine = (((runs.structuredContent ?? {}).runs ?? []) as Array<{ runId: string; startedBy?: string }>).find((r) => r.runId === runId)
      report.expect('D23.statusAsMember', !status.isError && !runs.isError && mine?.startedBy === memberId && memberId !== '', { ...brief(status), startedBy: mine?.startedBy, memberId })
    } finally {
      await session.close()
    }

    // --- refresh rotation
    const refreshed = await postForm<TokenResponse>(meta.body.token_endpoint, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId })
    const reused = await postForm<{ error?: string }>(meta.body.token_endpoint, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId })
    report.expect('D23.refreshRotates', refreshed.status === 200 && /^bfat_/.test(refreshed.body?.access_token ?? '') && refreshed.body?.refresh_token !== t.refresh_token && reused.status === 400 && reused.body?.error === 'invalid_grant', { refreshed: refreshed.status, reused: reused.status, error: reused.body?.error })

    // --- a narrowed consent cannot run
    const narrow = await consentFlow('workflow:read workflow:run workflow:files', ['workflow:run', 'workflow:files'], '2-read-only')
    const narrowTokens = narrow.callback.code
      ? await postForm<TokenResponse>(meta.body.token_endpoint, { grant_type: 'authorization_code', code: narrow.callback.code, redirect_uri: listener.url, client_id: clientId, code_verifier: narrow.pkce.verifier })
      : { status: 0, body: null }
    let denied: ToolAnswer = {}
    let allowed: ToolAnswer = {}
    if (narrowTokens.body) {
      const ro = await openMcp(args.harness, { token: narrowTokens.body.access_token })
      try {
        denied = (await ro.client.callTool({ name: 'workflow.submit', arguments: { runId, step: STEP, outputs: { line: 'x', index: 0 } } })) as ToolAnswer
        allowed = (await ro.client.callTool({ name: 'workflow.status', arguments: { runId } })) as ToolAnswer
      } finally {
        await ro.close()
      }
    }
    report.expect('D23.narrowedConsent', narrowTokens.body?.scope === 'workflow:read' && denied.isError === true && /workflow:run/.test(errorsOf(denied).scope ?? '') && !allowed.isError, { scope: narrowTokens.body?.scope, denied: { ...brief(denied), errors: errorsOf(denied) }, allowed: brief(allowed) })

    // --- RFC 7009
    const revoked = await postForm<Record<string, unknown>>(meta.body.revocation_endpoint ?? `${issuer}/api/oauth/revoke`, { token: refreshed.body?.access_token ?? t.access_token })
    const after = await rawPost(mcpUrl, { id: 2, method: 'tools/list' }, { token: refreshed.body?.access_token ?? t.access_token })
    report.expect('D23.revoke', revoked.status === 200 && after.status === 401, { revoked: revoked.status, after: after.status })
    if (narrowTokens.body) await postForm(meta.body.revocation_endpoint ?? `${issuer}/api/oauth/revoke`, { token: narrowTokens.body.access_token })
  } finally {
    await writeFile(`${args.out}/oauth.log`, log.join('\n'), 'utf8').catch(() => undefined)
    await browser?.close()
  }
}
