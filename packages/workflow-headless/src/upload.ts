/**
 * `file` inputs, uploaded before the page opens (07).
 *
 * A `file` input's value on the wire is a **whole File ref** —
 * `{ path, name, contentType, size, url }` — because `validateValue('file', …)`
 * wants every field and the page deliberately never turns a path into a ref
 * (nothing on that side fetches a url a caller handed it). So the driver runs
 * the same three calls the kickoff form runs (06): `files/prepare`, a plain
 * PUT of the bytes, `files/register`.
 */
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { ApiLike } from './api.js'
import { DriverError, EXIT } from './errors.js'

export interface FileRef {
  path: string
  name: string
  contentType: string
  size: number
  url: string
}

/** Only what the driver needs off an `on.manual.inputs` declaration. */
export interface InputDecl {
  type?: string
  list?: boolean
}

export interface UploadDeps {
  readFile(path: string): Promise<Uint8Array>
  basename(path: string): string
  contentTypeFor(path: string): string
}

/** The serve route a File ref's `url` points at — CE's `file_serve_handler` (06). */
const SERVE_PREFIX = '/api/uploads/'

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

export function contentTypeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export const nodeUploadDeps: UploadDeps = {
  readFile: async (path) => new Uint8Array(await readFile(path)),
  basename,
  contentTypeFor,
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The register answer, normalised — the same tolerance the harness's own
 * `coerce.ts` applies, so a rule that answers `storagePath`/`originalName`
 * instead of `path`/`name` still yields a ref the page will validate.
 */
export function toFileRef(raw: unknown): FileRef {
  const r = (raw ?? {}) as Record<string, unknown>
  const path = str(r.path) ?? str(r.storagePath) ?? str(r.storageKey) ?? ''
  const name = str(r.name) ?? str(r.fileName) ?? str(r.originalName) ?? path.split('/').pop() ?? 'file'
  const size = typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : 0
  return {
    path,
    name,
    contentType: str(r.contentType) ?? 'application/octet-stream',
    size,
    url: str(r.url) ?? `${SERVE_PREFIX}${path.replace(/^\/+/, '')}`,
  }
}

/** `{uploadUrl,storageKey}` or the shorter `{url,key}` — the rule may answer either (06). */
function prepared(raw: unknown): { uploadUrl: string; storageKey: string } {
  const r = (raw ?? {}) as Record<string, unknown>
  const uploadUrl = str(r.uploadUrl) ?? str(r.url)
  const storageKey = str(r.storageKey) ?? str(r.key)
  if (!uploadUrl || !storageKey) {
    throw new DriverError(
      'files/prepare did not answer an upload url and storage key',
      EXIT.USAGE,
    )
  }
  return { uploadUrl, storageKey }
}

export interface UploadContext {
  impl: string
  workflow: string
  /** `'inputs'` for kickoff values (06). */
  scope?: string
}

/** One local file → a registered File ref. */
export async function uploadOne(
  api: ApiLike,
  ctx: UploadContext,
  localPath: string,
  deps: UploadDeps,
): Promise<FileRef> {
  const scope = ctx.scope ?? 'inputs'
  const bytes = await deps.readFile(localPath)
  const filename = deps.basename(localPath)
  const contentType = deps.contentTypeFor(localPath)

  const prepare = await api.json('/api/workflow/files/prepare', {
    method: 'POST',
    body: {
      impl: ctx.impl,
      workflow: ctx.workflow,
      scope,
      filename,
      contentType,
      size: bytes.byteLength,
    },
  })
  if (prepare.status < 200 || prepare.status >= 300) {
    throw new DriverError(
      `files/prepare answered ${prepare.status} for ${localPath}`,
      EXIT.USAGE,
    )
  }
  const { uploadUrl, storageKey } = prepared(prepare.body)

  const put = await api.put(uploadUrl, bytes, contentType)
  if (put.status === 0) {
    // No status at all: the browser refused to send (or to read) the request.
    // For a direct-to-bucket PUT that is almost always the bucket's CORS
    // allow-list missing this origin — the harness's own upload says exactly
    // this, and it is the first thing a live run trips over.
    throw new DriverError(
      "the upload PUT failed before a response — usually the storage bucket's CORS allow-list " +
        `does not include this origin (${put.error ?? 'no detail'}) while uploading ${localPath}`,
      EXIT.USAGE,
    )
  }
  if (put.status < 200 || put.status >= 300) {
    throw new DriverError(`the upload PUT answered ${put.status} for ${localPath}`, EXIT.USAGE)
  }

  const register = await api.json('/api/workflow/files/register', {
    method: 'POST',
    body: { impl: ctx.impl, workflow: ctx.workflow, scope, storageKey, originalName: filename },
  })
  if (register.status < 200 || register.status >= 300) {
    throw new DriverError(
      `files/register answered ${register.status} for ${localPath}`,
      EXIT.USAGE,
    )
  }
  return toFileRef(register.body)
}

/** Already a ref? Then the caller did the upload itself — leave it alone. */
function isRef(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The `--inputs` object, with every `file` input's local path replaced by the
 * ref the harness registered. Everything else passes through untouched —
 * including an input the caller left out, which the page resolves to its
 * declared `default`.
 */
export async function uploadFileInputs(
  api: ApiLike,
  ctx: UploadContext,
  decls: Record<string, InputDecl>,
  supplied: Record<string, unknown>,
  deps: UploadDeps = nodeUploadDeps,
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = { ...supplied }

  for (const [name, decl] of Object.entries(decls)) {
    if (decl.type !== 'file' || !(name in values)) continue
    const value = values[name]
    if (value === null || value === undefined) continue

    if (decl.list === true && Array.isArray(value)) {
      const refs: unknown[] = []
      for (const entry of value) {
        refs.push(typeof entry === 'string' ? await uploadOne(api, ctx, entry, deps) : entry)
      }
      values[name] = refs
      continue
    }
    if (typeof value === 'string') {
      values[name] = await uploadOne(api, ctx, value, deps)
      continue
    }
    if (isRef(value)) continue
  }

  return values
}
