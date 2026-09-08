/**
 * URL file inputs over the MCP endpoint (spec 2026-09-08): `workflow.start`
 * is handed an `https://` URL for `capture/capture`'s `recording`, the
 * harness dispatches the implementation's driver (ADR-0006), the driver
 * downloads the recording, registers it and runs the workflow to `succeeded`,
 * and the bundle it produces is fetched through `workflow.sign` and read.
 *
 * The fixture is a public, tokenless Handoff content URL (41 MB `video/mp4`,
 * 200 direct, no expiry); `CAPTURE_FIXTURE_URL` overrides it. One Capture
 * kickoff: ffmpeg + WhisperX on the instance's executor, one Actions job in
 * `bffless/workflow-implementations`.
 *
 * Blocks (never fails) while a precondition is missing: no token or
 * credentials, `capture` not published on the harness, `NO_DRIVER`.
 * A dispatched driver that predates `@bffless/workflow-headless` 1.4.0
 * (the release carrying URL inputs) refuses the URL as a missing local
 * file, so the row never appears: that is `captureUrl.rowAppears` FAIL with
 * the hint below, not a block — it is the thing this walk exists to catch.
 *
 * The expected recording name is derived from the URL's last path segment,
 * while the driver prefers `Content-Disposition` when the server sends one
 * (spec D3) — a fixture host that answers a different disposition name would
 * FAIL `captureUrl.manifestNamesTheRecording`; the committed fixture sends
 * none.
 */
import { strFromU8, unzipSync } from 'fflate'
import { appToken, credentials } from '../env.js'
import { openMcp, type McpSession } from '../mcp-client.js'
import type { Report } from '../report.js'
import { openSession, sessionLogin, type Session } from '../session.js'
import { mintAppToken, WALK_SCOPES, type MintedToken } from '../token.js'
import { pollStatus } from './driven.js'
import type { Walk } from './index.js'

const IMPL = 'capture'
const WORKFLOW = 'capture'
export const DEFAULT_FIXTURE_URL = 'https://handoff.j5s.dev/api/uploads/content/test-public/anatomy.mp4'
const DIRECTION = 'workflow-live capture-url walk — prove a URL file input over the MCP endpoint'
/** Actions cold start (~2 min) + a 41 MB download + ffmpeg + WhisperX on a 4-minute clip. */
const ROW_TIMEOUT_MS = 6 * 60_000
const RUN_TIMEOUT_MS = 25 * 60_000

interface ToolAnswer { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }
interface FileRef { path?: string; name?: string; url?: string; size?: number; contentType?: string }
type Call = (name: string, args?: Record<string, unknown>) => Promise<ToolAnswer>

const text = (r: ToolAnswer) => (r.content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n')
const structured = (r: ToolAnswer) => r.structuredContent ?? {}
const errorsOf = (r: ToolAnswer) => (structured(r).errors ?? {}) as Record<string, string>
const brief = (r: ToolAnswer) => ({ isError: r.isError ?? false, text: text(r).slice(0, 300) })
const isFileRef = (v: unknown): v is Required<Pick<FileRef, 'path' | 'name'>> & FileRef =>
  typeof v === 'object' && v !== null && typeof (v as FileRef).path === 'string' && typeof (v as FileRef).name === 'string'

/** The pure half: the bundle's contents against the recording's name (spec D3). */
export function checkCaptureZip(bytes: Uint8Array, expectedSourceName: string, report: Report): void {
  let entries: Record<string, Uint8Array> = {}
  let unzipError = ''
  try {
    entries = unzipSync(bytes)
  } catch (e) {
    unzipError = e instanceof Error ? e.message : String(e)
  }
  const files = Object.keys(entries)
  const manifestRaw = entries['manifest.json']
  report.expect('captureUrl.zipHasManifest', manifestRaw !== undefined, { files: files.slice(0, 20), unzipError })
  let sourceName: unknown = undefined
  if (manifestRaw) {
    try {
      const manifest = JSON.parse(strFromU8(manifestRaw)) as { source?: { name?: unknown } }
      sourceName = manifest.source?.name
    } catch (e) {
      sourceName = `unparseable: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  report.expect('captureUrl.manifestNamesTheRecording', sourceName === expectedSourceName, { sourceName, expectedSourceName })
  report.expect('captureUrl.zipHasTranscript', 'transcript.md' in entries, { files: files.slice(0, 20) })
}

export const captureUrl: Walk = async ({ args, env, report }) => {
  let mcp: McpSession | null = null
  let browser: Session | null = null
  const minted: MintedToken[] = []
  const fixtureUrl = env.CAPTURE_FIXTURE_URL || DEFAULT_FIXTURE_URL
  let expectedName: string
  try {
    expectedName = decodeURIComponent(new URL(fixtureUrl).pathname.split('/').pop() ?? '')
  } catch {
    return report.block(`CAPTURE_FIXTURE_URL is not a valid URL: ${fixtureUrl}`)
  }
  try {
    let token = appToken(env)
    const login = sessionLogin(token, credentials(env))
    if (!login) return report.block('WORKFLOW_APP_TOKEN (minted with auth:session) or WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing')
    browser = await openSession({ base: args.harness, out: args.out, ...login })
    if (!token) {
      const project = await browser.api.json('/api/workflow/project')
      const repository = String((project.body as { repository?: string } | null)?.repository ?? '')
      if (repository === '') return report.block('GET /api/workflow/project answered no repository — cannot bind a token')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const all = await mintAppToken(browser.request, args.harness, repository, [...WALK_SCOPES], `workflow-live capture-url ${stamp}`)
      minted.push(all)
      token = all.token
    }
    try {
      mcp = await openMcp(args.harness, { token })
    } catch (e) {
      return report.block(`initialize failed against ${args.harness}/api/workflow/mcp: ${e instanceof Error ? e.message : String(e)}`)
    }
    const call: Call = async (name, toolArgs = {}) => (await mcp!.client.callTool({ name, arguments: toolArgs })) as ToolAnswer

    // --- start: a URL where a File ref would go
    report.kickoff()
    const start = await call('workflow.start', { impl: IMPL, workflow: WORKFLOW, inputs: { recording: fixtureUrl, direction: DIRECTION } })
    if (start.isError && /NO_DRIVER/.test(text(start))) return report.block(`${IMPL} publishes no driver on this harness: ${text(start).slice(0, 200)}`)
    if (start.isError && ('impl' in errorsOf(start) || 'workflow' in errorsOf(start))) return report.block(`${IMPL}/${WORKFLOW} is not published on this harness: ${text(start).slice(0, 200)}`)
    const runId = String(structured(start).runId ?? '')
    report.expect('captureUrl.startPending', !start.isError && structured(start).pending === true && runId !== '', { ...brief(start), runId })
    if (runId === '') return report.block('workflow.start answered no runId — nothing to poll')
    report.run(runId)

    // --- the dispatched driver downloaded, registered and started the run: a row exists
    const row = await pollStatus(call, runId, (s) => typeof s.status === 'string' && s.status !== 'pending', ROW_TIMEOUT_MS)
    report.expect('captureUrl.rowAppears', row !== null, {
      waitedMs: row === null ? ROW_TIMEOUT_MS : undefined,
      hint: row === null ? 'no row: the dispatched job refused the start — read its log in bffless/workflow-implementations (Actions → Workflow drive). A driver older than @bffless/workflow-headless 1.4.0 treats the URL as a missing local file.' : undefined,
    })
    if (row === null) return

    // --- the run finishes
    const done = await pollStatus(call, runId, (s) => s.status !== 'running' && s.status !== 'pending', RUN_TIMEOUT_MS)
    report.expect('captureUrl.succeeded', done?.status === 'succeeded', { status: done?.status ?? 'timeout', currentSteps: done?.currentSteps })
    if (done?.status !== 'succeeded') return

    // --- outputs: the bundle is a File ref; sign gives a presigned URL; the zip reads
    const outputs = await call('workflow.outputs', { runId })
    const bundle = (structured(outputs).outputs as Record<string, unknown> | undefined)?.bundle
    report.expect('captureUrl.bundleIsFileRef', isFileRef(bundle), { bundle })
    if (!isFileRef(bundle)) return
    const signed = await call('workflow.sign', { runId, path: bundle.path })
    const signedUrl = String(structured(signed).url ?? '')
    // Same signature-marker test as `hello.ts`'s `D6.viewerImgIsPresigned` and
    // `page-tools.ts`'s `D6.signIsPresigned`, kept identical so the three never drift.
    const hasSignature = /X-Goog-Signature=|X-Amz-Signature=|[?&]sig(nature)?=/.test(signedUrl)
    report.expect('captureUrl.signIsPresigned', !signed.isError && /^https:\/\//.test(signedUrl) && !signedUrl.startsWith(args.harness) && hasSignature, { ...brief(signed), signedUrl: signedUrl.slice(0, 120), hasSignature })
    if (signedUrl === '') return
    await report.guard(
      ['captureUrl.zipHasManifest', 'captureUrl.manifestNamesTheRecording', 'captureUrl.zipHasTranscript'],
      async () => {
        const res = await fetch(signedUrl)
        if (!res.ok) {
          report.expect('captureUrl.zipHasManifest', false, { fetchStatus: res.status })
          return
        }
        checkCaptureZip(new Uint8Array(await res.arrayBuffer()), expectedName, report)
      },
    )
  } finally {
    await mcp?.close()
    for (const t of minted) await t.revoke()
    await browser?.close()
  }
}
