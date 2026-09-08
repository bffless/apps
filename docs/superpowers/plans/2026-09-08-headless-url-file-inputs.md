# URL values for `file` inputs over the MCP endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude session hands `workflow.start` an `https://` URL for a `file` input, and the dispatched headless driver downloads it and registers it into the bucket, so a `capture/capture` run goes from URL to zip with no person in the loop.

**Architecture:** One new branch in the headless driver's `uploadFileInputs`: a string beginning `https?://` on a `type: file` input is streamed to a temp file in Node, then pushed to the bucket with a Node-side streaming PUT and registered through the harness's files trio exactly as a local path is today. Nothing server-side changes; the `workflow.start` description text says a URL is accepted over the endpoint. A live walk proves it against `workflow.j5s.dev`, and a published skill teaches a Claude session the start-to-zip loop.

**Tech Stack:** TypeScript (ES2023, NodeNext), Node ≥ 20 (`fetch`, `Readable.fromWeb`/`toWeb`, `stream/promises`), Vitest 4, Playwright driver (`@bffless/workflow-headless`), MCP SDK client (`@bffless/workflow-live`), `fflate` for reading the zip, release-please.

**Spec:** `docs/superpowers/specs/2026-09-08-headless-url-file-inputs-design.md`

## Global Constraints

- **Additive only.** Local-path and File-ref values keep their exact behaviour and error messages; the only newly accepted value is a `file` input string matching `^https?://`. The local-path PUT still goes through the page (spec D2; streaming it is a follow-up).
- **Declared type decides, never the value's shape.** Only inputs the workflow declares `type: file` are touched (spec D1).
- **Failures are `DriverError` with `EXIT.USAGE` (2)**, naming the input and the URL (spec D4). Never exit 1 for a driver-side fault.
- **Size cap 5 GB** = `5368709120` bytes, the files trio's server backstop (spec D4).
- **`--mocks` refuses URL values** with `URL file inputs are not supported under --mocks; pass a local path` (spec D5).
- **Node-side PUT sends an explicit `Content-Length`** (a presigned S3/GCS PUT refuses a chunked body) and a `Content-Type` (spec D2).
- **Filename comes from `Content-Disposition`, else the last path segment of the URL the caller gave**, percent-decoded, query dropped; `download<ext>` when empty. **Content type from the response header unless it is `application/octet-stream`**, else the extension map, else `application/octet-stream` (spec D3).
- **Tool text**: the `workflow.start` `inputs` description reads exactly:
  `Values for `on.manual.inputs`, keyed by input name. An omitted input takes its declared default; a `file` input is a whole File ref (`{ path, name, contentType, size, url }`); over the MCP endpoint it may also be an `https://` URL the dispatched driver downloads and registers before the run starts. Never a bare path. Pass `{}` for a workflow with no inputs.` (spec D6). The generated copies under `apps/workflow/.bffless/proxy-rules/workflow/` are rebuilt with `pnpm --filter workflow mcp:build`, never hand-edited.
- **Live fixture**: `https://handoff.j5s.dev/api/uploads/content/test-public/anatomy.mp4` (41 MB `video/mp4`, 200 direct, no expiry), overridable with `CAPTURE_FIXTURE_URL`.
- **Commits** use conventional scopes that release-please maps to components: `feat(workflow-headless): …`, `feat(workflow-live): …`, `docs(workflow): …`, `chore(workflow): …`. Every commit ends with the `Co-Authored-By` and `Claude-Session` trailers used on this branch. **Never commit without the person's approval** — each task's commit step is the point to show the diff and ask (the branch owner has approved committing on this branch for this plan's tasks; still show what is committed).
- Work in the worktree `/home/rico/bffless/repos/apps/.claude/worktrees/url-file-inputs` on branch `feat/headless-url-file-inputs`. Run package commands with `pnpm --filter @bffless/workflow-headless <script>` etc. from the worktree root.

---

## File structure

| file | responsibility |
| --- | --- |
| `packages/workflow-headless/src/mime.ts` (new) | The extension ↔ media-type map, `contentTypeFor(path)` (moved from `upload.ts`, re-exported there) and the new `extensionFor(contentType)`. Pure. |
| `packages/workflow-headless/src/download.ts` (new) | `isHttpUrl`, `filenameFromDisposition`, `filenameFromUrl`, `contentTypeFromResponse`, `downloadToTemp` — URL → temp file, streamed, capped. Depends on `mime.ts`, `errors.ts`. |
| `packages/workflow-headless/src/putFromDisk.ts` (new) | `putFromDisk(url, path, size, contentType, fetchImpl)` — the Node-side streaming PUT with explicit `Content-Length`. |
| `packages/workflow-headless/src/upload.ts` (modify) | `uploadOne` split into `prepareUpload` + `registerUpload` helpers (behaviour unchanged); new `uploadFromUrl`; `uploadFileInputs` gains the URL branch, `opts.mocks`, and optional `download`/`putFromDisk` deps. |
| `packages/workflow-headless/src/run.ts` (modify, ~L469) | Passes `{ mocks: o.mocks }` to `uploadFileInputs`. |
| `packages/workflow-headless/src/index.ts` (modify) | Exports the new modules. |
| `packages/workflow-headless/test/{mime,download,putFromDisk}.test.ts` (new), `test/upload.test.ts` (extend) | Unit tests. |
| `packages/workflow-headless/README.md` (modify) | The "file input's value" paragraph. |
| `apps/workflow/docs/spec/07-headless.md` (modify, L18–24) | The same paragraph; drop "`https://` input values are deliberately not supported". |
| `packages/workflow-agent-tools/src/schemas.ts` (modify, L59) | `START_SCHEMA.properties.inputs.description`. |
| `apps/workflow/.bffless/proxy-rules/workflow/mcp-fn/*.fn.js`, `rules/api/workflow/mcp/any.rule.yaml` (regenerated) | By `pnpm --filter workflow mcp:build`. |
| `packages/workflow-live/src/walks/capture-url.ts` (new), `src/walks/index.ts`, `src/args.ts` (USAGE), `README.md` (modify) | The live proof. |
| `bffless/skills` repo: `plugins/bffless/skills/capture-recording/SKILL.md` (new), `README.md` (row) | The skill (separate repo, separate PR). |
| `bffless/workflow-implementations` repo: `workflows/capture/README.md` (modify) | Link the skill from "Reading a run from a Claude session" (separate repo, separate PR). |

---

### Task 1: `mime.ts` — move the extension map, add `extensionFor`

**Files:**
- Create: `packages/workflow-headless/src/mime.ts`
- Modify: `packages/workflow-headless/src/upload.ts` (remove the `MIME` map + `contentTypeFor` body; re-export)
- Test: `packages/workflow-headless/test/mime.test.ts`

**Interfaces:**
- Produces: `export function contentTypeFor(path: string): string` (unchanged signature, now in `mime.ts`, still re-exported from `upload.ts` so `test/upload.test.ts` and `index.ts` keep importing it from there); `export function extensionFor(contentType: string): string` — the dotted extension for a media type from the same map (`'video/mp4' → '.mp4'`), `''` when unknown. Media type comparison is case-insensitive and ignores parameters.

- [ ] **Step 1: Write the failing test**

`packages/workflow-headless/test/mime.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { contentTypeFor, extensionFor } from '../src/mime.js'

describe('contentTypeFor', () => {
  test('maps the extensions a driver actually sends, and falls back to octet-stream', () => {
    expect(contentTypeFor('a/b/clip.mp4')).toBe('video/mp4')
    expect(contentTypeFor('clip.MOV')).toBe('video/quicktime')
    expect(contentTypeFor('mystery.qqq')).toBe('application/octet-stream')
  })
})

describe('extensionFor', () => {
  test('is the inverse of the map, ignoring case and parameters', () => {
    expect(extensionFor('video/mp4')).toBe('.mp4')
    expect(extensionFor('Video/MP4; codecs=avc1')).toBe('.mp4')
    expect(extensionFor('application/zip')).toBe('.zip')
  })
  test('is empty for a type the map does not know', () => {
    expect(extensionFor('application/x-unknown')).toBe('')
    expect(extensionFor('')).toBe('')
  })
  test('prefers the canonical extension when two share a type', () => {
    // .jpg and .jpeg both map to image/jpeg; .htm/.html to text/html; .yml/.yaml to application/yaml
    expect(extensionFor('image/jpeg')).toBe('.jpg')
    expect(extensionFor('text/html')).toBe('.html')
    expect(extensionFor('application/yaml')).toBe('.yaml')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @bffless/workflow-headless exec vitest run test/mime.test.ts`
Expected: FAIL — `Cannot find module '../src/mime.js'`.

- [ ] **Step 3: Create `mime.ts` and re-export from `upload.ts`**

`packages/workflow-headless/src/mime.ts`:

```ts
/**
 * The extension ↔ media-type map the driver uses when a file's own metadata
 * says nothing: a local path has only its extension; a downloaded response
 * may answer `application/octet-stream` or no `Content-Type` at all.
 *
 * `.mov` is here because Capture's `recording` input is usually a macOS
 * screen recording, and the harness's own kickoff form would have sent
 * `video/quicktime` for it.
 */
const MIME: Record<string, string> = {
  '.bin': 'application/octet-stream',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
}

/** The extension `extensionFor` answers when several share one media type. */
const CANONICAL: Record<string, string> = {
  'image/jpeg': '.jpg',
  'text/html': '.html',
  'application/yaml': '.yaml',
}

function extname(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

/** The media type for a path's extension; `application/octet-stream` when unknown. */
export function contentTypeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** The dotted extension for a media type (parameters and case ignored); `''` when unknown. */
export function extensionFor(contentType: string): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (type === '') return ''
  if (CANONICAL[type]) return CANONICAL[type]
  for (const [ext, mime] of Object.entries(MIME)) if (mime === type) return ext
  return ''
}
```

In `packages/workflow-headless/src/upload.ts`: delete the `MIME` constant and the `contentTypeFor` function body, delete the `import { basename, extname } from 'node:path'` line's `extname` (keep `basename`), and add at the top:

```ts
import { contentTypeFor } from './mime.js'
export { contentTypeFor } from './mime.js'
```

Keep `nodeUploadDeps.contentTypeFor` pointing at the imported function.

- [ ] **Step 4: Run the package's tests and lint**

Run: `pnpm --filter @bffless/workflow-headless test:run && pnpm --filter @bffless/workflow-headless lint && pnpm --filter @bffless/workflow-headless build`
Expected: all green; `test/upload.test.ts`'s existing `contentTypeFor` test still passes through the re-export.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-headless/src/mime.ts packages/workflow-headless/src/upload.ts packages/workflow-headless/test/mime.test.ts
git commit -m "refactor(workflow-headless): the extension map moves to mime.ts, with extensionFor"
```

---

### Task 2: `download.ts` — URL → temp file, streamed and capped

**Files:**
- Create: `packages/workflow-headless/src/download.ts`
- Test: `packages/workflow-headless/test/download.test.ts`

**Interfaces:**
- Consumes: `contentTypeFor`, `extensionFor` from `./mime.js`; `DriverError`, `EXIT` from `./errors.js`.
- Produces:

```ts
export const MAX_DOWNLOAD_BYTES = 5_368_709_120
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
export interface Downloaded { path: string; name: string; contentType: string; size: number; cleanup(): Promise<void> }
export function isHttpUrl(value: string): boolean
export function filenameFromDisposition(header: string | null): string | undefined
export function filenameFromUrl(url: string, contentType: string): string
export function contentTypeFromResponse(header: string | null, name: string): string
export async function downloadToTemp(url: string, input: string, fetchImpl?: FetchLike, maxBytes?: number): Promise<Downloaded>
```

`input` is the kickoff input's name, used only in error messages.

- [ ] **Step 1: Write the failing tests**

`packages/workflow-headless/test/download.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
import { describe, test, expect } from 'vitest'
import {
  contentTypeFromResponse,
  downloadToTemp,
  filenameFromDisposition,
  filenameFromUrl,
  isHttpUrl,
  MAX_DOWNLOAD_BYTES,
} from '../src/download.js'
import { DriverError, EXIT } from '../src/errors.js'

const URL_ = 'https://cdn.test/media/anatomy.mp4?x=1'

/** A fake `fetch` answering one Response built from bytes and headers. */
function answering(status: number, bytes: Uint8Array | null, headers: Record<string, string> = {}) {
  return async () => new Response(bytes === null ? null : bytes, { status, headers })
}

describe('isHttpUrl', () => {
  test('is true only for http(s) schemes', () => {
    expect(isHttpUrl('https://x/y.mp4')).toBe(true)
    expect(isHttpUrl('HTTP://x/y')).toBe(true)
    expect(isHttpUrl('./clip.mp4')).toBe(false)
    expect(isHttpUrl('/abs/clip.mp4')).toBe(false)
    expect(isHttpUrl('file:///x.mp4')).toBe(false)
    expect(isHttpUrl('ftp://x/y')).toBe(false)
  })
})

describe('filenameFromDisposition', () => {
  test('prefers RFC 5987 filename*, then a quoted or bare filename', () => {
    expect(filenameFromDisposition(`attachment; filename="plain.mov"; filename*=UTF-8''caf%C3%A9.mov`)).toBe('café.mov')
    expect(filenameFromDisposition('attachment; filename="quoted name.mp4"')).toBe('quoted name.mp4')
    expect(filenameFromDisposition('inline; filename=bare.mp4')).toBe('bare.mp4')
  })
  test('is undefined when the header is absent or names nothing', () => {
    expect(filenameFromDisposition(null)).toBeUndefined()
    expect(filenameFromDisposition('attachment')).toBeUndefined()
    expect(filenameFromDisposition('attachment; filename=""')).toBeUndefined()
  })
})

describe('filenameFromUrl', () => {
  test('is the last path segment, percent-decoded, query dropped', () => {
    expect(filenameFromUrl('https://h/r/abc/anatomy.mp4?token=t', 'video/mp4')).toBe('anatomy.mp4')
    expect(filenameFromUrl('https://h/a/Screen%20Recording.mov', 'video/quicktime')).toBe('Screen Recording.mov')
  })
  test('falls back to download + the extension the content type implies', () => {
    expect(filenameFromUrl('https://h/dir/', 'video/mp4')).toBe('download.mp4')
    expect(filenameFromUrl('https://h', 'application/x-unknown')).toBe('download')
  })
  test('never contains a path separator', () => {
    expect(filenameFromUrl('https://h/a%2Fb.mp4', 'video/mp4')).toBe('a_b.mp4')
  })
})

describe('contentTypeFromResponse', () => {
  test('takes the response media type, parameters dropped', () => {
    expect(contentTypeFromResponse('video/mp4; charset=binary', 'x.bin')).toBe('video/mp4')
  })
  test('falls back to the extension when the header is missing or octet-stream', () => {
    expect(contentTypeFromResponse(null, 'clip.mov')).toBe('video/quicktime')
    expect(contentTypeFromResponse('application/octet-stream', 'clip.mp4')).toBe('video/mp4')
    expect(contentTypeFromResponse('application/octet-stream', 'mystery.qqq')).toBe('application/octet-stream')
  })
})

describe('downloadToTemp', () => {
  test('streams a 2xx body to a temp file named after the URL, and cleans up', async () => {
    const bytes = new TextEncoder().encode('twelve bytes')
    const got = await downloadToTemp(URL_, 'recording', answering(200, bytes, { 'content-type': 'video/mp4' }))
    expect(got.name).toBe('anatomy.mp4')
    expect(got.contentType).toBe('video/mp4')
    expect(got.size).toBe(12)
    expect(readFileSync(got.path, 'utf8')).toBe('twelve bytes')
    await got.cleanup()
    expect(existsSync(got.path)).toBe(false)
  })

  test('Content-Disposition wins over the URL for the name', async () => {
    const got = await downloadToTemp(URL_, 'recording', answering(200, new Uint8Array(3), {
      'content-disposition': 'attachment; filename="talk.mov"',
    }))
    expect(got.name).toBe('talk.mov')
    expect(got.contentType).toBe('video/quicktime') // no header → from the name
    await got.cleanup()
  })

  test('a non-2xx answer is a usage fault naming the input and the URL', async () => {
    const error = await downloadToTemp(URL_, 'recording', answering(404, new Uint8Array(0))).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toBe(`download of recording answered 404 for ${URL_}`)
  })

  test('a fetch that rejects is a usage fault too', async () => {
    const failing = async () => { throw new Error('getaddrinfo ENOTFOUND cdn.test') }
    const error = await downloadToTemp(URL_, 'recording', failing).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toBe(`download of recording failed before a response (getaddrinfo ENOTFOUND cdn.test) for ${URL_}`)
  })

  test('a 2xx with no body is a usage fault', async () => {
    const error = await downloadToTemp(URL_, 'recording', answering(200, null)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as Error).message).toBe(`download of recording failed before a response (empty body) for ${URL_}`)
  })

  test('a Content-Length over the cap is refused before any byte is read', async () => {
    const error = await downloadToTemp(URL_, 'recording', answering(200, new Uint8Array(1), {
      'content-length': String(MAX_DOWNLOAD_BYTES + 1),
    })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as Error).message).toBe(`download of recording is ${MAX_DOWNLOAD_BYTES + 1} bytes, over the 5 GB cap, for ${URL_}`)
  })

  test('a body that grows past the cap while streaming is refused and the temp file removed', async () => {
    // A 10-byte cap; the body is 16 bytes with no Content-Length.
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(8)); c.enqueue(new Uint8Array(8)); c.close() },
    })
    const fetchImpl = async () => new Response(stream, { status: 200 })
    const error = await downloadToTemp(URL_, 'recording', fetchImpl, 10).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toMatch(/over the 5 GB cap/)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @bffless/workflow-headless exec vitest run test/download.test.ts`
Expected: FAIL — `Cannot find module '../src/download.js'`.

- [ ] **Step 3: Implement `download.ts`**

```ts
/**
 * A `file` input's value may be an `https://` URL (spec 2026-09-08, D1): the
 * driver fetches it to the runner's disk and then registers that file the
 * way it registers a local path. Streamed, never buffered — a recording is
 * gigabytes — and capped at the files trio's own 5 GB backstop (D4).
 *
 * Naming (D3): the object's name is what the run and the zip are named after,
 * so it is the recording's name — `Content-Disposition` if the server says,
 * else the last segment of the URL **the caller gave** (a redirect target may
 * be a hashed storage key).
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { DriverError, EXIT } from './errors.js'
import { contentTypeFor, extensionFor } from './mime.js'

/** The files trio's `maxFileSize` (rules `files/prepare` + `files/register`), 5 GB. */
export const MAX_DOWNLOAD_BYTES = 5_368_709_120

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface Downloaded {
  /** The temp file. */
  path: string
  /** The name the bucket object and the File ref carry. */
  name: string
  contentType: string
  size: number
  /** Removes the temp directory; safe to call twice. */
  cleanup(): Promise<void>
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

const noSeparators = (name: string) => name.replace(/[\\/]/g, '_')

export function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined
  const star = /filename\*\s*=\s*(?:utf-8)''([^;]+)/i.exec(header)
  if (star?.[1]) {
    try {
      const decoded = decodeURIComponent(star[1].trim())
      if (decoded !== '') return noSeparators(decoded)
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header)
  const name = (plain?.[1] ?? plain?.[2] ?? '').trim()
  return name === '' ? undefined : noSeparators(name)
}

export function filenameFromUrl(url: string, contentType: string): string {
  let segment = ''
  try {
    segment = new URL(url).pathname.split('/').filter((s) => s !== '').pop() ?? ''
  } catch {
    segment = ''
  }
  try {
    segment = decodeURIComponent(segment)
  } catch {
    /* keep it encoded */
  }
  segment = noSeparators(segment)
  return segment === '' ? `download${extensionFor(contentType)}` : segment
}

export function contentTypeFromResponse(header: string | null, name: string): string {
  const type = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (type !== '' && type !== 'application/octet-stream') return type
  return contentTypeFor(name)
}

const detail = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function downloadToTemp(
  url: string,
  input: string,
  fetchImpl: FetchLike = fetch,
  maxBytes: number = MAX_DOWNLOAD_BYTES,
): Promise<Downloaded> {
  let res: Response
  try {
    res = await fetchImpl(url)
  } catch (e) {
    throw new DriverError(`download of ${input} failed before a response (${detail(e)}) for ${url}`, EXIT.USAGE)
  }
  if (res.status < 200 || res.status >= 300) {
    throw new DriverError(`download of ${input} answered ${res.status} for ${url}`, EXIT.USAGE)
  }
  if (!res.body) {
    throw new DriverError(`download of ${input} failed before a response (empty body) for ${url}`, EXIT.USAGE)
  }
  const overCap = (bytes: number) =>
    new DriverError(`download of ${input} is ${bytes} bytes, over the 5 GB cap, for ${url}`, EXIT.USAGE)
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) throw overCap(declared)

  const headerType = res.headers.get('content-type')
  const name =
    filenameFromDisposition(res.headers.get('content-disposition')) ??
    filenameFromUrl(url, (headerType ?? '').split(';')[0]?.trim() ?? '')
  const contentType = contentTypeFromResponse(headerType, name)

  const dir = await mkdtemp(join(tmpdir(), 'workflow-headless-'))
  const path = join(dir, name)
  const cleanup = () => rm(dir, { recursive: true, force: true })

  let seen = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length
      if (seen > maxBytes) callback(overCap(seen))
      else callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), counter, createWriteStream(path))
  } catch (e) {
    await cleanup()
    if (e instanceof DriverError) throw e
    throw new DriverError(`download of ${input} failed mid-stream (${detail(e)}) for ${url}`, EXIT.USAGE)
  }
  return { path, name, contentType, size: seen, cleanup }
}
```

- [ ] **Step 4: Run the tests, lint, build**

Run: `pnpm --filter @bffless/workflow-headless exec vitest run test/download.test.ts && pnpm --filter @bffless/workflow-headless lint && pnpm --filter @bffless/workflow-headless build`
Expected: PASS ×14 (all `describe` blocks green), lint clean, `tsc -b` clean. If `tsc` complains about `Readable.fromWeb`'s parameter type, the cast to `WebReadableStream<Uint8Array>` is the accepted shape for `@types/node` 24.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-headless/src/download.ts packages/workflow-headless/test/download.test.ts
git commit -m "feat(workflow-headless): downloadToTemp — a URL streamed to the runner's disk, named and capped"
```

---

### Task 3: `putFromDisk.ts` — the Node-side streaming PUT

**Files:**
- Create: `packages/workflow-headless/src/putFromDisk.ts`
- Test: `packages/workflow-headless/test/putFromDisk.test.ts`

**Interfaces:**
- Consumes: `FetchLike` from `./download.js`.
- Produces: `export type PutFromDisk = (url: string, path: string, size: number, contentType: string) => Promise<{ status: number; error?: string }>` and `export function putFromDisk(url, path, size, contentType, fetchImpl?: FetchLike): Promise<{ status: number; error?: string }>` — `status: 0` + `error` when the request produced no response (same contract as `ApiLike.put`).

- [ ] **Step 1: Write the failing test**

`packages/workflow-headless/test/putFromDisk.test.ts`:

```ts
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, test, expect } from 'vitest'
import { putFromDisk } from '../src/putFromDisk.js'

interface Seen { method: string; contentLength: string | undefined; transferEncoding: string | undefined; contentType: string | undefined; bytes: number }

let server: Server
let base = ''
const seen: Seen[] = []
let answer = 200

beforeAll(async () => {
  server = createServer((req, res) => {
    let bytes = 0
    req.on('data', (chunk: Buffer) => { bytes += chunk.length })
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        contentLength: req.headers['content-length'],
        transferEncoding: req.headers['transfer-encoding'],
        contentType: req.headers['content-type'],
        bytes,
      })
      res.statusCode = answer
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const tempFile = (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'wfh-put-'))
  const path = join(dir, 'clip.mp4')
  writeFileSync(path, content)
  return path
}

describe('putFromDisk', () => {
  test('PUTs the file with an explicit Content-Length and Content-Type, never chunked', async () => {
    seen.length = 0
    answer = 200
    const path = tempFile('x'.repeat(70_000)) // past one highWaterMark chunk
    const result = await putFromDisk(`${base}/bucket/key`, path, 70_000, 'video/mp4')
    expect(result).toEqual({ status: 200 })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe('PUT')
    expect(seen[0]!.contentLength).toBe('70000')
    expect(seen[0]!.transferEncoding).toBeUndefined()
    expect(seen[0]!.contentType).toBe('video/mp4')
    expect(seen[0]!.bytes).toBe(70_000)
  })

  test('hands back the bucket\'s status verbatim', async () => {
    seen.length = 0
    answer = 403
    const path = tempFile('abc')
    expect(await putFromDisk(`${base}/bucket/key`, path, 3, 'text/plain')).toEqual({ status: 403 })
  })

  test('a request that never gets a response is status 0 with the failure', async () => {
    const path = tempFile('abc')
    const result = await putFromDisk('http://127.0.0.1:1/nothing-listens-here', path, 3, 'text/plain')
    expect(result.status).toBe(0)
    expect(result.error).toMatch(/ECONNREFUSED|fetch failed/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @bffless/workflow-headless exec vitest run test/putFromDisk.test.ts`
Expected: FAIL — `Cannot find module '../src/putFromDisk.js'`.

- [ ] **Step 3: Implement**

`packages/workflow-headless/src/putFromDisk.ts`:

```ts
/**
 * The direct-to-bucket PUT for a URL-sourced file, sent from Node rather than
 * through the page (spec 2026-09-08, D2). The page route base64s the whole
 * file across the Playwright bridge — fine for a poster, a ceiling for a
 * recording. A presigned URL needs no cookie, so nothing is lost by leaving
 * the browser out.
 *
 * `Content-Length` is explicit and mandatory: a presigned S3/GCS PUT refuses
 * a chunked body (501), and undici only sends a fixed length when the header
 * is set. `duplex: 'half'` is what Node's fetch requires for a stream body.
 */
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { FetchLike } from './download.js'

export type PutFromDisk = (
  url: string,
  path: string,
  size: number,
  contentType: string,
) => Promise<{ status: number; error?: string }>

export async function putFromDisk(
  url: string,
  path: string,
  size: number,
  contentType: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ status: number; error?: string }> {
  try {
    const res = await fetchImpl(url, {
      method: 'PUT',
      headers: { 'content-type': contentType, 'content-length': String(size) },
      body: Readable.toWeb(createReadStream(path)) as unknown as BodyInit,
      // Node's fetch requires this for a streaming request body.
      duplex: 'half',
    } as RequestInit)
    return { status: res.status }
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause
    const message = e instanceof Error ? e.message : String(e)
    const causeMessage = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : ''
    return { status: 0, error: causeMessage ? `${message}: ${causeMessage}` : message }
  }
}
```

- [ ] **Step 4: Run the tests, lint, build**

Run: `pnpm --filter @bffless/workflow-headless exec vitest run test/putFromDisk.test.ts && pnpm --filter @bffless/workflow-headless lint && pnpm --filter @bffless/workflow-headless build`
Expected: PASS ×3. If `tsc` rejects `duplex`, the `as RequestInit` cast on the whole init object covers it (the field is not in lib.dom's type).

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-headless/src/putFromDisk.ts packages/workflow-headless/test/putFromDisk.test.ts
git commit -m "feat(workflow-headless): putFromDisk — the bucket PUT streamed from Node with an explicit Content-Length"
```

---

### Task 4: `upload.ts` — the URL branch

**Files:**
- Modify: `packages/workflow-headless/src/upload.ts`
- Test: `packages/workflow-headless/test/upload.test.ts` (extend)

**Interfaces:**
- Consumes: `downloadToTemp`, `isHttpUrl`, `Downloaded` from `./download.js`; `putFromDisk`, `PutFromDisk` from `./putFromDisk.js`.
- Produces (all exported from `upload.ts`):

```ts
export interface UploadDeps {
  readFile(path: string): Promise<Uint8Array>
  basename(path: string): string
  contentTypeFor(path: string): string
  /** URL-sourced files (spec D2). Optional so existing callers and tests need not supply them. */
  download?(url: string, input: string): Promise<Downloaded>
  putFromDisk?: PutFromDisk
}
export interface UploadOptions { mocks?: boolean }
export async function uploadFromUrl(api: ApiLike, ctx: UploadContext, input: string, url: string, deps: UploadDeps): Promise<FileRef>
export async function uploadFileInputs(api, ctx, decls, supplied, deps = nodeUploadDeps, opts: UploadOptions = {}): Promise<Record<string, unknown>>
```

`uploadOne`'s signature and every existing error message are unchanged.

- [ ] **Step 1: Write the failing tests** (append to `test/upload.test.ts`, inside the existing `describe('uploadFileInputs', …)` block or a new `describe('uploadFileInputs — URL values', …)`):

```ts
import type { Downloaded } from '../src/download.js'

/** A fake download: no network, one temp-less "file" whose cleanup is observable. */
function fakeDownload(over: Partial<Downloaded> = {}) {
  const calls: Array<{ url: string; input: string }> = []
  let cleaned = 0
  const download = async (url: string, input: string): Promise<Downloaded> => {
    calls.push({ url, input })
    return {
      path: '/tmp/fake/anatomy.mp4',
      name: 'anatomy.mp4',
      contentType: 'video/mp4',
      size: 40_826_579,
      cleanup: async () => { cleaned += 1 },
      ...over,
    }
  }
  return { download, calls, cleaned: () => cleaned }
}

describe('uploadFileInputs — URL values (spec 2026-09-08)', () => {
  const URL_ = 'https://handoff.j5s.dev/api/uploads/content/test-public/anatomy.mp4'

  test('a `file` input given an https:// URL is downloaded, PUT from disk, registered, and replaced by the ref', async () => {
    const { api, calls, puts } = fakeApi()
    const dl = fakeDownload()
    const disk: Array<{ url: string; path: string; size: number; contentType: string }> = []
    const values = await uploadFileInputs(
      api,
      ctx,
      { recording: { type: 'file' }, direction: { type: 'string' } },
      { recording: URL_, direction: 'see https://example.com/notes' },
      {
        ...deps,
        download: dl.download,
        putFromDisk: async (url, path, size, contentType) => { disk.push({ url, path, size, contentType }); return { status: 200 } },
      },
    )
    expect(dl.calls).toEqual([{ url: URL_, input: 'recording' }])
    expect(calls.map((c) => c.path)).toEqual(['/api/workflow/files/prepare', '/api/workflow/files/register'])
    expect(calls[0]!.body).toEqual({
      impl: 'hello', workflow: 'interactive', scope: 'inputs',
      filename: 'anatomy.mp4', contentType: 'video/mp4', size: 40_826_579,
    })
    // The bucket PUT came from disk, never through the page.
    expect(puts).toEqual([])
    expect(disk).toEqual([{ url: 'https://bucket.test/workflows/hello/interactive/inputs/anatomy.mp4', path: '/tmp/fake/anatomy.mp4', size: 40_826_579, contentType: 'video/mp4' }])
    expect(calls[1]!.body).toMatchObject({ storageKey: 'workflows/hello/interactive/inputs/anatomy.mp4', originalName: 'anatomy.mp4' })
    expect(values.recording).toMatchObject({ path: 'workflows/hello/interactive/inputs/anatomy.mp4', name: 'anatomy.mp4' })
    // A URL in a `string` input is text, untouched (D1: the declared type decides).
    expect(values.direction).toBe('see https://example.com/notes')
    expect(dl.cleaned()).toBe(1)
  })

  test('a `list: true` file input mixes URLs and local paths per entry', async () => {
    const { api, puts } = fakeApi()
    const dl = fakeDownload()
    const values = await uploadFileInputs(
      api, ctx,
      { shots: { type: 'file', list: true } },
      { shots: ['./a.png', URL_] },
      { ...deps, download: dl.download, putFromDisk: async () => ({ status: 200 }) },
    )
    expect(puts).toHaveLength(1) // only the local path went through the page
    expect(dl.calls).toHaveLength(1)
    expect((values.shots as Array<{ name: string }>).map((r) => r.name)).toEqual(['a.png', 'anatomy.mp4'])
  })

  test('a failed download surfaces as the DriverError it threw, and nothing is prepared', async () => {
    const { api, calls } = fakeApi()
    const download = async () => { throw new DriverError(`download of recording answered 404 for ${URL_}`, EXIT.USAGE) }
    const error = await uploadFileInputs(api, ctx, { recording: { type: 'file' } }, { recording: URL_ }, { ...deps, download }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as Error).message).toBe(`download of recording answered 404 for ${URL_}`)
    expect(calls).toEqual([])
  })

  test('a from-disk PUT that never got a response is a usage fault naming the URL, and the temp file is cleaned up', async () => {
    const { api } = fakeApi()
    const dl = fakeDownload()
    const error = await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: URL_ },
      { ...deps, download: dl.download, putFromDisk: async () => ({ status: 0, error: 'fetch failed: ECONNRESET' }) },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toBe(`the upload PUT failed before a response (fetch failed: ECONNRESET) while uploading ${URL_}`)
    expect(dl.cleaned()).toBe(1)
  })

  test('a non-2xx from-disk PUT is a usage fault naming the URL', async () => {
    const { api } = fakeApi()
    const dl = fakeDownload()
    const error = await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: URL_ },
      { ...deps, download: dl.download, putFromDisk: async () => ({ status: 403 }) },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as Error).message).toBe(`the upload PUT answered 403 for ${URL_}`)
  })

  test('under --mocks a URL value is refused before any call', async () => {
    const { api, calls } = fakeApi()
    const dl = fakeDownload()
    const error = await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: URL_ },
      { ...deps, download: dl.download }, { mocks: true },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toBe(`URL file inputs are not supported under --mocks; pass a local path (input recording: ${URL_})`)
    expect(dl.calls).toEqual([])
    expect(calls).toEqual([])
  })

  test('a local path still goes through the page PUT, exactly as before', async () => {
    const { api, puts } = fakeApi()
    let fromDisk = 0
    await uploadFileInputs(api, ctx, { clip: { type: 'file' } }, { clip: './clip.png' }, {
      ...deps,
      putFromDisk: async () => { fromDisk += 1; return { status: 200 } },
    })
    expect(puts).toHaveLength(1)
    expect(fromDisk).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @bffless/workflow-headless exec vitest run test/upload.test.ts`
Expected: the seven new tests FAIL (URL treated as a local path → `readFile` fake returns bytes → the ref is named after the URL string; the `mocks` test gets no refusal); the existing tests still PASS.

- [ ] **Step 3: Implement**

In `packages/workflow-headless/src/upload.ts`:

1. Imports:

```ts
import { downloadToTemp, isHttpUrl, type Downloaded } from './download.js'
import { putFromDisk, type PutFromDisk } from './putFromDisk.js'
```

2. Extend `UploadDeps` and `nodeUploadDeps`:

```ts
export interface UploadDeps {
  readFile(path: string): Promise<Uint8Array>
  basename(path: string): string
  contentTypeFor(path: string): string
  /** URL-sourced files (spec 2026-09-08, D2). Optional: existing callers and tests need not supply them. */
  download?(url: string, input: string): Promise<Downloaded>
  putFromDisk?: PutFromDisk
}

export const nodeUploadDeps: UploadDeps = {
  readFile: async (path) => new Uint8Array(await readFile(path)),
  basename,
  contentTypeFor,
  download: (url, input) => downloadToTemp(url, input),
  putFromDisk,
}

export interface UploadOptions {
  /** `--mocks`: a URL value is refused (D5) — the Node-side download and PUT would bypass MSW. */
  mocks?: boolean
}
```

3. Split `uploadOne` into two helpers it calls, keeping its body's messages byte-for-byte. `label` is what the messages name — the local path today, the URL for `uploadFromUrl`:

```ts
async function prepareUpload(
  api: ApiLike,
  ctx: UploadContext,
  file: { filename: string; contentType: string; size: number },
  label: string,
): Promise<{ uploadUrl: string; storageKey: string; scope: string }> {
  const scope = ctx.scope ?? 'inputs'
  const prepare = await api.json('/api/workflow/files/prepare', {
    method: 'POST',
    body: { impl: ctx.impl, workflow: ctx.workflow, scope, filename: file.filename, contentType: file.contentType, size: file.size },
  })
  if (prepare.status < 200 || prepare.status >= 300) {
    throw new DriverError(`files/prepare answered ${prepare.status} for ${label}`, EXIT.USAGE)
  }
  return { ...prepared(prepare.body), scope }
}

async function registerUpload(
  api: ApiLike,
  ctx: UploadContext,
  scope: string,
  storageKey: string,
  originalName: string,
  label: string,
): Promise<FileRef> {
  const register = await api.json('/api/workflow/files/register', {
    method: 'POST',
    body: { impl: ctx.impl, workflow: ctx.workflow, scope, storageKey, originalName },
  })
  if (register.status < 200 || register.status >= 300) {
    throw new DriverError(`files/register answered ${register.status} for ${label}`, EXIT.USAGE)
  }
  return toFileRef(register.body)
}
```

`uploadOne` becomes: read bytes → `prepareUpload(api, ctx, { filename, contentType, size: bytes.byteLength }, localPath)` → the existing `api.put` + its two existing error branches (unchanged text) → `registerUpload(api, ctx, scope, storageKey, filename, localPath)`.

4. Add `uploadFromUrl`:

```ts
/** One `https://` URL → a registered File ref: download to disk, PUT from disk, register (D2). */
export async function uploadFromUrl(
  api: ApiLike,
  ctx: UploadContext,
  input: string,
  url: string,
  deps: UploadDeps,
): Promise<FileRef> {
  const download = deps.download ?? nodeUploadDeps.download!
  const put = deps.putFromDisk ?? nodeUploadDeps.putFromDisk!
  const got = await download(url, input)
  try {
    const { uploadUrl, storageKey, scope } = await prepareUpload(
      api, ctx, { filename: got.name, contentType: got.contentType, size: got.size }, url,
    )
    const result = await put(uploadUrl, got.path, got.size, got.contentType)
    if (result.status === 0) {
      throw new DriverError(
        `the upload PUT failed before a response (${result.error ?? 'no detail'}) while uploading ${url}`,
        EXIT.USAGE,
      )
    }
    if (result.status < 200 || result.status >= 300) {
      throw new DriverError(`the upload PUT answered ${result.status} for ${url}`, EXIT.USAGE)
    }
    return await registerUpload(api, ctx, scope, storageKey, got.name, url)
  } finally {
    await got.cleanup()
  }
}
```

5. The branch in `uploadFileInputs` (new trailing `opts` parameter; `one` is the per-value dispatcher used by both the list and scalar cases):

```ts
export async function uploadFileInputs(
  api: ApiLike,
  ctx: UploadContext,
  decls: Record<string, InputDecl>,
  supplied: Record<string, unknown>,
  deps: UploadDeps = nodeUploadDeps,
  opts: UploadOptions = {},
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = { ...supplied }

  const one = async (name: string, value: string): Promise<FileRef> => {
    if (!isHttpUrl(value)) return uploadOne(api, ctx, value, deps)
    if (opts.mocks) {
      throw new DriverError(
        `URL file inputs are not supported under --mocks; pass a local path (input ${name}: ${value})`,
        EXIT.USAGE,
      )
    }
    return uploadFromUrl(api, ctx, name, value, deps)
  }

  for (const [name, decl] of Object.entries(decls)) {
    if (decl.type !== 'file' || !(name in values)) continue
    const value = values[name]
    if (value === null || value === undefined) continue

    if (decl.list === true && Array.isArray(value)) {
      const refs: unknown[] = []
      for (const entry of value) refs.push(typeof entry === 'string' ? await one(name, entry) : entry)
      values[name] = refs
      continue
    }
    if (typeof value === 'string') {
      values[name] = await one(name, value)
      continue
    }
    if (isRef(value)) continue
  }
  return values
}
```

6. Update the file's header comment: a `file` input's value may also be an `https://` URL (spec 2026-09-08) — the driver downloads it first.

- [ ] **Step 4: Run the whole package suite, lint, build**

Run: `pnpm --filter @bffless/workflow-headless test:run && pnpm --filter @bffless/workflow-headless lint && pnpm --filter @bffless/workflow-headless build`
Expected: every test green, including the seven pre-existing `uploadFileInputs` tests untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-headless/src/upload.ts packages/workflow-headless/test/upload.test.ts
git commit -m "feat(workflow-headless): a file input's value may be an https:// URL — downloaded, PUT from disk, registered"
```

---

### Task 5: Wire `run.ts`, export, document the driver

**Files:**
- Modify: `packages/workflow-headless/src/run.ts:469-475`
- Modify: `packages/workflow-headless/src/index.ts` (exports)
- Modify: `packages/workflow-headless/README.md:35-40`
- Modify: `apps/workflow/docs/spec/07-headless.md:18-24`

**Interfaces:**
- Consumes: `uploadFileInputs(..., opts)` from Task 4.

- [ ] **Step 1: Thread `mocks` into the upload**

In `run.ts` the call becomes:

```ts
    const values = await uploadFileInputs(
      api,
      { impl: o.impl, workflow: o.workflow },
      definition?.inputs ?? {},
      o.inputs,
      deps.uploadDeps ?? nodeUploadDeps,
      { mocks: o.mocks },
    )
```

- [ ] **Step 2: Export the new modules**

In `src/index.ts`, next to the existing `uploadFileInputs` export line (L69), add:

```ts
export { uploadFromUrl, type UploadOptions } from './upload.js'
export { downloadToTemp, isHttpUrl, filenameFromDisposition, filenameFromUrl, contentTypeFromResponse, MAX_DOWNLOAD_BYTES, type Downloaded, type FetchLike } from './download.js'
export { putFromDisk, type PutFromDisk } from './putFromDisk.js'
export { contentTypeFor, extensionFor } from './mime.js'
```

(If `index.ts` already re-exports `contentTypeFor` from `./upload.js`, remove that one so it is exported exactly once.)

- [ ] **Step 3: README paragraph**

Replace the README's "A `file` input's value is a **local path**…" paragraph with:

```markdown
A `file` input's value is a **local path** or an **`https://` URL**. Either way the
driver ends up with a registered File ref in the URL, because that is what the page
validates: a whole `{ path, name, contentType, size, url }`, never a bare string.

- A local path is read and uploaded through the page (`files/prepare` → `PUT` →
  `files/register`).
- A URL is **downloaded first**, streamed to the runner's temp dir, then PUT to the
  bucket **from Node** with an explicit `Content-Length` (a presigned PUT refuses a
  chunked body), and registered. The stored object is named from `Content-Disposition`
  or, failing that, the last path segment of the URL you gave (`…/anatomy.mp4` →
  `anatomy.mp4`), so the run and its outputs carry the recording's name. A non-2xx
  download, a body over the files trio's 5 GB cap, or a URL under `--mocks` is a
  driver-side fault (exit `2`) naming the input and the URL. This is how a run started
  over the harness's MCP endpoint (`workflow.start`, ADR-0006) takes a recording: the
  caller passes the URL, the dispatched job does the fetch.

A `list: true` file input takes an array, mixing paths and URLs per entry.
```

- [ ] **Step 4: Spec 07 paragraph**

Replace the bullet at `apps/workflow/docs/spec/07-headless.md:18-24` with:

```markdown
- A `file` input's value is a **whole File ref** — `{ path, name, contentType, size, url }`,
  exactly the object `/api/workflow/files/register` hands back (06) — not a bare path. The
  driver uploads through `prepare` → PUT → `register` before it opens the page and puts the
  registered ref in the JSON; run inputs are stored verbatim, and nothing on this side turns a
  path into a ref, so a bare string fails validation like any other wrong-shaped value. The
  page never fetches a url a caller handed it. The **driver** does (spec
  `2026-09-08-headless-url-file-inputs-design.md`): an `https://` value for a `file` input in
  `--inputs` — which is how `workflow.start` over the MCP endpoint passes a recording — is
  streamed to the runner's disk, PUT to the bucket from Node, and registered, so the page
  still only ever sees a ref.
```

- [ ] **Step 5: Build, test, lint the package; run the apps `run.test.ts` suite too**

Run: `pnpm --filter @bffless/workflow-headless build && pnpm --filter @bffless/workflow-headless test:run && pnpm --filter @bffless/workflow-headless lint`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/workflow-headless/src/run.ts packages/workflow-headless/src/index.ts packages/workflow-headless/README.md apps/workflow/docs/spec/07-headless.md
git commit -m "feat(workflow-headless): --mocks refuses URL file inputs; README and spec 07 say a URL is downloaded by the driver"
```

---

### Task 6: The `workflow.start` tool text, regenerated bundles

**Files:**
- Modify: `packages/workflow-agent-tools/src/schemas.ts:59`
- Regenerate: `apps/workflow/.bffless/proxy-rules/workflow/mcp-fn/*.fn.js`, `apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/mcp/any.rule.yaml`
- Test: `apps/workflow/src/mcp/bundle.test.ts` (existing; fails while the committed bundles are stale)

- [ ] **Step 1: Prove the guard sees the drift** — edit the text first, then run the bundle test before rebuilding.

In `schemas.ts` set `START_SCHEMA.properties.inputs.description` to exactly:

```ts
        'Values for `on.manual.inputs`, keyed by input name. An omitted input takes its declared default; a `file` input is a whole File ref (`{ path, name, contentType, size, url }`); over the MCP endpoint it may also be an `https://` URL the dispatched driver downloads and registers before the run starts. Never a bare path. Pass `{}` for a workflow with no inputs.',
```

Run: `pnpm --filter @bffless/workflow-agent-tools build && pnpm --filter workflow exec vitest run src/mcp/bundle.test.ts`
Expected: FAIL — the committed `mcp-fn` bundles / `any.rule.yaml` no longer match a fresh build (the test names the stale files).

- [ ] **Step 2: Rebuild the bundles**

Run: `pnpm --filter workflow mcp:build`
Expected: the six `mcp-fn/*.fn.js` files that embed the catalog and `rules/api/workflow/mcp/any.rule.yaml` change; `git diff --stat apps/workflow/.bffless` shows only description text hunks.

- [ ] **Step 3: Verify**

Run: `pnpm --filter workflow exec vitest run src/mcp/bundle.test.ts && pnpm --filter @bffless/workflow-agent-tools test:run && grep -rn "never a bare path or a URL" packages apps --include=*.ts --include=*.js --include=*.yaml -l | grep -v node_modules | grep -v dist`
Expected: both suites green; the grep prints nothing (every copy now carries the new sentence).

- [ ] **Step 4: Commit**

```bash
git add packages/workflow-agent-tools/src/schemas.ts apps/workflow/.bffless/proxy-rules/workflow
git commit -m "feat(workflow): workflow.start says a file input may be an https:// URL over the MCP endpoint"
```

---

### Task 7: The `capture-url` live walk

**Files:**
- Create: `packages/workflow-live/src/walks/capture-url.ts`
- Modify: `packages/workflow-live/src/walks/index.ts` (register), `packages/workflow-live/src/args.ts:9` (USAGE), `packages/workflow-live/README.md` (walk row + env)
- Test: `packages/workflow-live/test/capture-url.test.ts` (the pure zip check)

**Interfaces:**
- Consumes: `Walk`, `WalkContext` from `./index.js`; `pollStatus` exported from `./driven.js`; `openMcp` from `../mcp-client.js`; `openSession`, `sessionLogin` from `../session.js`; `mintAppToken`, `WALK_SCOPES` from `../token.js`; `appToken`, `credentials` from `../env.js`; `unzipSync`, `strFromU8` from `fflate`.
- Produces: `export function checkCaptureZip(bytes: Uint8Array, expectedSourceName: string, report: Report): void` — the pure assertions on the downloaded zip, unit-tested; `export const captureUrl: Walk`.

Checks (names are the contract — keep them stable): `captureUrl.startPending`, `captureUrl.rowAppears`, `captureUrl.succeeded`, `captureUrl.bundleIsFileRef`, `captureUrl.signIsPresigned`, `captureUrl.zipHasManifest`, `captureUrl.manifestNamesTheRecording`, `captureUrl.zipHasTranscript`. Spend: **one Capture kickoff** (ffmpeg + WhisperX on the instance's executor; one Actions job in the implementation repo).

- [ ] **Step 1: Write the failing unit test for the zip check**

`packages/workflow-live/test/capture-url.test.ts`:

```ts
import { zipSync, strToU8 } from 'fflate'
import { describe, test, expect } from 'vitest'
import { Report } from '../src/report.js'
import { checkCaptureZip } from '../src/walks/capture-url.js'

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))

/** `WalkReport.checks` is a Record<name, { pass, evidence }> (report.ts:12). */
const names = (r: Report) => Object.fromEntries(Object.entries(r.finish().checks).map(([name, c]) => [name, c.pass]))

describe('checkCaptureZip', () => {
  test('passes on a bundle whose manifest names the recording and carries the transcript', () => {
    const report = new Report('capture-url', 'https://h')
    checkCaptureZip(zip({
      'manifest.json': JSON.stringify({ version: 1, source: { name: 'anatomy.mp4' }, sheets: [] }),
      'transcript.md': '# anatomy.mp4\n',
      'transcript.json': '[]',
      'README.md': '',
    }), 'anatomy.mp4', report)
    expect(names(report)).toEqual({
      'captureUrl.zipHasManifest': true,
      'captureUrl.manifestNamesTheRecording': true,
      'captureUrl.zipHasTranscript': true,
    })
  })

  test('fails the name check when the manifest names something else, and the manifest check when it is missing', () => {
    const wrong = new Report('capture-url', 'https://h')
    checkCaptureZip(zip({ 'manifest.json': JSON.stringify({ source: { name: 'download.mp4' } }), 'transcript.md': '' }), 'anatomy.mp4', wrong)
    expect(names(wrong)['captureUrl.manifestNamesTheRecording']).toBe(false)

    const missing = new Report('capture-url', 'https://h')
    checkCaptureZip(zip({ 'transcript.md': '' }), 'anatomy.mp4', missing)
    expect(names(missing)['captureUrl.zipHasManifest']).toBe(false)
    expect(names(missing)['captureUrl.manifestNamesTheRecording']).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @bffless/workflow-live exec vitest run test/capture-url.test.ts`
Expected: FAIL — `Cannot find module '../src/walks/capture-url.js'`.

- [ ] **Step 3: Write the walk**

`packages/workflow-live/src/walks/capture-url.ts`:

```ts
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
  const expectedName = decodeURIComponent(new URL(fixtureUrl).pathname.split('/').pop() ?? '')
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
    report.expect('captureUrl.signIsPresigned', !signed.isError && /^https:\/\//.test(signedUrl) && !signedUrl.startsWith(args.harness), { ...brief(signed), signedUrl: signedUrl.slice(0, 120) })
    if (signedUrl === '') return
    const res = await fetch(signedUrl)
    if (!res.ok) {
      report.expect('captureUrl.zipHasManifest', false, { fetchStatus: res.status })
      return
    }
    checkCaptureZip(new Uint8Array(await res.arrayBuffer()), expectedName, report)
  } finally {
    await mcp?.close()
    for (const t of minted) await t.revoke()
    await browser?.close()
  }
}
```

Register it: in `src/walks/index.ts` add `import { captureUrl } from './capture-url.js'` and `'capture-url': captureUrl` to `WALKS` (not to `ALL_ORDER` — it spends a kickoff). In `src/args.ts:9` add `capture-url` to the USAGE list between `driven` and `all`.

- [ ] **Step 4: README row and env line**

Add to the README's walks table:

```markdown
| `capture-url` | URL file inputs over the MCP endpoint (spec `2026-09-08-headless-url-file-inputs-design.md`): `workflow.start` given an `https://` URL for `capture/capture`'s `recording` — `captureUrl.startPending`, `captureUrl.rowAppears` (the dispatched driver downloaded and registered the recording; FAILs with a hint when the implementation repo's driver predates `@bffless/workflow-headless` 1.4.0), `captureUrl.succeeded`, `captureUrl.bundleIsFileRef`, `captureUrl.signIsPresigned`, then on the fetched zip `captureUrl.zipHasManifest`, `captureUrl.manifestNamesTheRecording` (`manifest.source.name` is the URL's last segment, D3), `captureUrl.zipHasTranscript`. Fixture: the public `https://handoff.j5s.dev/api/uploads/content/test-public/anatomy.mp4` (41 MB), `CAPTURE_FIXTURE_URL` overrides. Not part of `all` | **one Capture kickoff**: ffmpeg + WhisperX, one Actions job in the implementation repo |
```

and to the Usage block: `pnpm workflow-live:walk capture-url --harness https://workflow.j5s.dev --out /tmp/walk-capture-url`, and to Env: "`CAPTURE_FIXTURE_URL` (optional) — the recording URL `capture-url` starts with."

- [ ] **Step 5: Test, lint, build**

Run: `pnpm --filter @bffless/workflow-live test:run && pnpm --filter @bffless/workflow-live lint && pnpm --filter @bffless/workflow-live exec tsc -p tsconfig.json --noEmit`
Expected: green (the zip test passes; the walk compiles).

- [ ] **Step 6: Commit**

```bash
git add packages/workflow-live/src/walks/capture-url.ts packages/workflow-live/src/walks/index.ts packages/workflow-live/src/args.ts packages/workflow-live/README.md packages/workflow-live/test/capture-url.test.ts
git commit -m "feat(workflow-live): capture-url walk — a URL file input over the MCP endpoint, start to zip"
```

---

### Task 8: Open the apps PR

**Files:** none new.

- [ ] **Step 1: Full verify chain from the worktree root**

Run:
```bash
pnpm --filter @bffless/workflow-headless build && pnpm --filter @bffless/workflow-headless test:run && pnpm --filter @bffless/workflow-headless lint
pnpm --filter @bffless/workflow-agent-tools build && pnpm --filter @bffless/workflow-agent-tools test:run
pnpm --filter workflow exec vitest run src/mcp
pnpm --filter @bffless/workflow-live test:run && pnpm --filter @bffless/workflow-live lint
pnpm skills:check
```
Expected: all green; `skills:check` unaffected (no `.claude/skills` change in this repo).

- [ ] **Step 2: Push and open the PR** (ask the person first — pushing is outward-facing)

```bash
git push -u origin feat/headless-url-file-inputs
gh pr create --title "feat(workflow-headless): a file input may be an https:// URL over the MCP endpoint" --body-file - <<'EOF'
## What

A `type: file` kickoff input may now be an `https://` URL when the run is started over the harness's MCP endpoint. The dispatched headless driver streams the download to the runner's disk, PUTs it to the bucket from Node (explicit `Content-Length`), and registers it through the files trio — the page still only ever sees a File ref. `workflow.start`'s description says so; a `capture-url` live walk proves it start to zip against `capture/capture`.

Spec: `docs/superpowers/specs/2026-09-08-headless-url-file-inputs-design.md` · Plan: `docs/superpowers/plans/2026-09-08-headless-url-file-inputs.md`

## Writes to a live instance

- **On merge**: the harness rule set republishes with the changed `workflow.start` description (`mcp-fn` bundles + `any.rule.yaml`, regenerated). No rule shape or scope changes.
- **Release**: release-please cuts `@bffless/workflow-headless` 1.4.0; `workflow-implementations`' `workflow-drive.yml` installs `^1.2`, so the next dispatched job picks it up with no change there.
- Nothing is written on open.

## Additive

Local paths and File refs behave byte-for-byte as before (existing tests untouched). The local-path PUT still goes through the page; streaming it is a recorded follow-up.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_0156BKKew9wBW5kXoexVvLU7
EOF
```

- [ ] **Step 3: Run `/code-review` on the PR and address findings before requesting a human merge.**

---

### Task 9: The `capture-recording` skill (`bffless/skills` repo)

**Files:**
- Create: `/home/rico/bffless/repos/skills/plugins/bffless/skills/capture-recording/SKILL.md`
- Modify: `/home/rico/bffless/repos/skills/README.md` (walks table row, in alphabetical position after `cache-and-storage`)

Work on a branch `feat/capture-recording-skill` in that repo. The skill is host-agnostic: it names the harness MCP tools by their dot names as the connector exposes them (`workflow.start` …; in Claude Code they surface as `workflow_start`).

- [ ] **Step 1: Write `SKILL.md`**

```markdown
---
name: capture-recording
description: Turn a screen recording at a URL into a Capture bundle (transcript with word timings, contact sheets, manifest) by starting and following a run of the Workflow harness's capture/capture workflow over its MCP connector — start to unzipped zip, no person in the loop
---

# Capture a recording

You are connected to a BFFless Workflow harness (e.g. `workflow.bffless.dev`) over MCP, which
exposes `workflow.list`, `workflow.describe`, `workflow.start`, `workflow.status`,
`workflow.outputs`, `workflow.sign` (and a few more). The person gives you a **URL to a video**
and a **direction** — what they want a later session to do with the recording. You run the
`capture` implementation's `capture` workflow and hand back the bundle's contents.

## Inputs

- `recording` — the video's `https://` URL. Public, or a signed/share link that fetches without
  cookies (a Handoff `/api/uploads/content/...` or `/r/<id>/<name>?token=` link, a presigned
  bucket URL). Not a file: attachments are never reachable by the harness, and video cannot be
  attached to a chat at all. If the person has only a file, ask them to put it somewhere with a
  URL (Handoff's drag-and-drop) and paste the link.
- `direction` — their words, verbatim. Carried into the bundle for the session that reads it.
- Optional: `language` (default `en`; pick it rather than `auto` — a wrong guess loses every
  word timing), `interval` (seconds between stills, default 5).

## Steps

1. **Describe once.** `workflow.describe { impl: "capture", workflow: "capture" }` — confirm
   `headlessSafe: true` and that `recording` is a `file` input. (Over the MCP endpoint a `file`
   input accepts an `https://` URL: the dispatched driver downloads and registers it.)
2. **Start.** `workflow.start { impl: "capture", workflow: "capture", inputs: { recording: <url>, direction: <text>, language?, interval? } }`.
   The answer is `pending` with a `runId`. **Keep that id; it is the only id you use.** Never
   pick a run from `workflow.runs` by recency — two recordings run at once finish out of order.
3. **Wait for the row.** Poll `workflow.status { runId }` every 15–20 s. For the first ~2 minutes
   "no such run" is normal (a GitHub Actions cold start). If there is still no row after ~5
   minutes, the dispatched driver refused the start — most often a URL that did not answer 2xx,
   or one over 5 GB. Say so, name the URL, and stop.
4. **Follow the run.** Keep polling until `status` is `succeeded`, `failed` or `cancelled`. A
   4-minute recording takes 2–3 minutes; budget ~1 minute per minute of recording. On `failed`,
   report the failed step from the snapshot (`steps[*].status`, its `error`) — a transcript with
   fewer than 50 words usually means silent audio; `language: auto` guessing wrong empties the
   word list.
5. **Fetch the bundle.** `workflow.outputs { runId }` → `outputs.bundle` is a File ref
   `{ path, name, contentType, size, url }`. Its `url` is session-only; exchange `path` with
   `workflow.sign { runId, path }` for a presigned URL and fetch that (it expires in minutes —
   sign right before fetching). Save the zip, unzip it.
6. **Read it.** `manifest.json` first (`source.name`, `direction`, `plan`, `sheets[].times`,
   `embedded`), then `transcript.md` (8-second `[m:ss]` lines, the direction quoted at the top),
   `transcript.json` for word timings. Open `sheets/*.jpg` as images; each cell is a still
   labelled with its clock, and `manifest.sheets[i].times[j]` is cell `j` (row-major) of sheet
   `i` in seconds. When `manifest.embedded` is `false` (over 150 MB of sheets) the zip lists
   sheets instead of containing them: sign each `manifest.sheets[].path` to view it.
7. **Report.** Give the person the run id, the recording's name and spoken duration, the word
   count and sheet count, and what the transcript says in a few sentences — then do what the
   direction asked, with the transcript and sheets as your context.

## Why the URL, and not the file

The workflow's `recording` input is bytes in the harness project's bucket. Only a File ref or a
URL can name those bytes from an MCP call; there is no way to pass a file through a tool call,
and chat attachments are not addressable by remote servers. Getting the recording to a URL is
the person's step; everything after it is yours.
```

- [ ] **Step 2: README row**

```markdown
| **capture-recording** | Start, follow and read a Capture run of a recording at a URL over the harness MCP |
```

- [ ] **Step 3: Commit on the skills branch and open its PR** (release-please bumps the plugin version):

```bash
cd /home/rico/bffless/repos/skills && git checkout -b feat/capture-recording-skill
git add plugins/bffless/skills/capture-recording/SKILL.md README.md
git commit -m "feat: capture-recording skill — a recording at a URL to a Capture bundle over the harness MCP"
```

Push and `gh pr create` only after the person approves (outward-facing).

---

### Task 10: Point the capture README at the skill (`bffless/workflow-implementations` repo)

**Files:**
- Modify: `/home/rico/bffless/repos/workflow-implementations/workflows/capture/README.md` — the "Reading a run from a Claude session" section.

- [ ] **Step 1: Replace the section's first paragraph and list with**

```markdown
## Running and reading a capture from a Claude session

Any Claude session connected to the harness MCP can run a capture **from a URL** and read the
result — the `capture-recording` skill in [`bffless/skills`](https://github.com/bffless/skills)
is the written-down version of this loop:

1. `workflow_start { impl: "capture", workflow: "capture", inputs: { recording: "<https:// URL>", direction: "…" } }`
   — over the MCP endpoint a `file` input takes an `https://` URL; the dispatched driver
   downloads it into the project's bucket and registers it (`@bffless/workflow-headless` ≥ 1.4).
   Keep the `runId` it answers.
2. `workflow_status { runId }` until `succeeded` (the row appears after the Actions cold start,
   ~1–2 minutes).
3. `workflow_outputs { runId }` — the `bundle` File ref's `url` is host-relative
   (`/api/uploads/…`) and private to the project, so exchange its `path` for a short-lived
   presigned link with `workflow_sign { runId, path }` and fetch that.
4. Unzip; read `manifest.json` first, then `transcript.md`; open `sheets/*.jpg` as images (or,
   past the cap, sign each `manifest.sheets[].path`). `manifest.sheets[].times` maps each cell
   (row-major) to a second.
```

Keep the existing "Want a share link?" paragraph.

- [ ] **Step 2: Commit on a branch there (`docs/capture-readme-url-start`) and open its PR after approval.** Merging touches `workflows/capture/**`, which triggers `deploy-capture.yml` — a doc-only change still republishes the alias; that is fine and expected, say so in the PR body.

---

### Task 11: Live proof

Preconditions: the apps PR merged, release-please's release PR merged so `@bffless/workflow-headless@1.4.0` is on npm (`npm view @bffless/workflow-headless version`), and the harness rule set redeployed.

- [ ] **Step 1: Run the walk against j5s** with the `apps-live-walk` agent (or by hand):

```bash
source ~/.config/bffless/workflow-ci.env
pnpm workflow-live:walk capture-url --harness https://workflow.j5s.dev --out /tmp/walk-capture-url
cat /tmp/walk-capture-url/report.md
```
Expected: eight `PASS` rows. A `captureUrl.rowAppears` FAIL with the 1.4.0 hint means the dispatched job installed an older driver — check `npm view` and the job log.

- [ ] **Step 2: Run it against prod** (`--harness https://workflow.bffless.dev`) once j5s is green.

- [ ] **Step 3: Prove it from a Claude Desktop session** with the prod connector: paste the fixture URL and a direction, follow the skill, confirm the zip's `manifest.source.name` is `anatomy.mp4`. Record the run id in the apps PR thread.

---

## Self-review

- **Spec coverage.** D1 (Task 4), D2 (Tasks 2–4), D3 (Task 2), D4 (Tasks 2, 4), D5 (Tasks 4–5), D6 (Task 6), D7 (Task 9); testing section (Tasks 1–4, 7); rollout (Tasks 8, 11); the capture README link (Task 10). Follow-ups stay follow-ups (no task streams the local-path PUT; no `maxSize` from the declaration).
- **Placeholders.** None; every code step is complete. The one "if tsc rejects" note (Task 3 `duplex` typing) is a verification instruction, not a gap.
- **Type consistency.** `Downloaded`, `FetchLike`, `PutFromDisk`, `UploadOptions`, `uploadFromUrl(api, ctx, input, url, deps)`, `downloadToTemp(url, input, fetchImpl?, maxBytes?)`, `putFromDisk(url, path, size, contentType, fetchImpl?)` are used with the same names and parameter orders in Tasks 2–5 and 7; error message strings in Task 4's tests match Task 4's implementation and Task 2's `downloadToTemp` messages verbatim.
