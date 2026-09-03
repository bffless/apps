/**
 * The official MCP client over the endpoint's stateless Streamable HTTP
 * profile (spec 10, D22) — the same transport claude.ai's connector uses, so a
 * walk that passes here has exercised the wire shape a host will.
 *
 * `openMcp` connects (which runs `initialize` + `notifications/initialized`)
 * and hands back the client; `rawPost` sends one JSON-RPC message with plain
 * `fetch` for the checks the SDK cannot express (a `GET`, an unknown method).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export const MCP_PATH = '/api/workflow/mcp'

export interface McpSession {
  client: Client
  url: string
  close(): Promise<void>
}

export interface McpAuth {
  /** An app token, sent as `Authorization: Bearer` on every message (spec 10, D23 rung 2). */
  token?: string
}

const authHeaders = (auth?: McpAuth): Record<string, string> => (auth?.token ? { authorization: `Bearer ${auth.token}` } : {})

export async function openMcp(base: string, auth: McpAuth = {}): Promise<McpSession> {
  const url = `${base.replace(/\/+$/, '')}${MCP_PATH}`
  const client = new Client({ name: 'workflow-live', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: authHeaders(auth) } })
  await client.connect(transport)
  return {
    client,
    url,
    close: async () => {
      await client.close().catch(() => undefined)
    },
  }
}

export interface RawAnswer {
  status: number
  headers: Record<string, string>
  body: unknown
}

/** One JSON-RPC message by plain fetch; `body` is parsed when JSON, else the text. */
export async function rawPost(url: string, message: Record<string, unknown>, auth: McpAuth = {}): Promise<RawAnswer> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...authHeaders(auth) },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  })
  return answerOf(res)
}

export async function rawGet(url: string, auth: McpAuth = {}): Promise<RawAnswer> {
  return answerOf(await fetch(url, { headers: { accept: 'text/event-stream', ...authHeaders(auth) } }))
}

async function answerOf(res: Response): Promise<RawAnswer> {
  const text = await res.text()
  const body: unknown = (() => {
    try {
      return text === '' ? '' : JSON.parse(text)
    } catch {
      return text
    }
  })()
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })
  return { status: res.status, headers, body }
}
