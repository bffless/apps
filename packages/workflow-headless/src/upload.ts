/**
 * `file` inputs, uploaded before the page opens (07).
 *
 * A `file` input's value on the wire is a **whole File ref** —
 * `{ path, name, contentType, size, url }` — because `validateValue('file', …)`
 * wants every field and the page deliberately never turns a path into a ref
 * (nothing on that side fetches a url a caller handed it). So the driver runs
 * the same three calls the kickoff form runs (06): `files/prepare`, a plain
 * PUT of the bytes, `files/register`.
 *
 * A `file` input's value may also be an `https://` URL (spec 2026-09-08): the
 * driver downloads it first, then PUTs the bytes from disk rather than
 * through the page. The URL may also arrive **wrapped in an object** —
 * `{ url, name? }`, not a registered ref — because a tool-calling model given
 * the whole-ref shape in `workflow.start`'s description may wrap a URL in one
 * rather than pass it as a plain string; the driver treats it the same as the
 * bare URL, optionally renaming the stored object from the wrapper's `name`.
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ApiLike } from './api.js'
import { downloadToTemp, isHttpUrl, safeFilename, type Downloaded } from './download.js'
import { DriverError, EXIT } from './errors.js'
import { contentTypeFor } from './mime.js'
import { putFromDisk, type PutFromDisk } from './putFromDisk.js'
export { contentTypeFor } from './mime.js'

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
  /** URL-sourced files (spec 2026-09-08, D2). Optional: existing callers and tests need not supply them. */
  download?(url: string, input: string): Promise<Downloaded>
  putFromDisk?: PutFromDisk
}

export interface UploadOptions {
  /** `--mocks`: a URL value is refused (D5) — the Node-side download and PUT would bypass MSW. */
  mocks?: boolean
}

/** The serve route a File ref's `url` points at — CE's `file_serve_handler` (06). */
const SERVE_PREFIX = '/api/uploads/'

/** The Node-side defaults for the two URL-branch deps, bound so `uploadFromUrl` never needs a non-null assertion. */
const defaultDownload: (url: string, input: string) => Promise<Downloaded> = (url, input) => downloadToTemp(url, input)
const defaultPutFromDisk: PutFromDisk = putFromDisk

export const nodeUploadDeps: UploadDeps = {
  readFile: async (path) => new Uint8Array(await readFile(path)),
  basename,
  contentTypeFor,
  download: defaultDownload,
  putFromDisk: defaultPutFromDisk,
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

async function prepareUpload(
  api: ApiLike,
  ctx: UploadContext,
  file: { filename: string; contentType: string; size: number },
  label: string,
): Promise<{ uploadUrl: string; storageKey: string; scope: string }> {
  const scope = ctx.scope ?? 'inputs'
  const prepare = await api.json('/api/workflow/files/prepare', {
    method: 'POST',
    body: {
      impl: ctx.impl,
      workflow: ctx.workflow,
      scope,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
    },
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

/** One local file → a registered File ref. */
export async function uploadOne(
  api: ApiLike,
  ctx: UploadContext,
  localPath: string,
  deps: UploadDeps,
): Promise<FileRef> {
  const bytes = await deps.readFile(localPath)
  const filename = deps.basename(localPath)
  const contentType = deps.contentTypeFor(localPath)

  const { uploadUrl, storageKey, scope } = await prepareUpload(
    api,
    ctx,
    { filename, contentType, size: bytes.byteLength },
    localPath,
  )

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

  return registerUpload(api, ctx, scope, storageKey, filename, localPath)
}

/**
 * One `https://` URL → a registered File ref: download to disk, PUT from
 * disk, register (D2). `opts.name` — a wrapped-URL object's own `name`
 * (below) — overrides `got.name` for `files/prepare`'s `filename` and
 * `files/register`'s `originalName`, sanitised the same way the download
 * module names a file itself; a dot/empty override falls back to `got.name`.
 * The content type stays what the download determined, unless the override
 * name's extension maps to a known type and the download's own type was the
 * generic `application/octet-stream`.
 */
export async function uploadFromUrl(
  api: ApiLike,
  ctx: UploadContext,
  input: string,
  url: string,
  deps: UploadDeps,
  opts: { name?: string } = {},
): Promise<FileRef> {
  const download = deps.download ?? defaultDownload
  const put = deps.putFromDisk ?? defaultPutFromDisk
  const got = await download(url, input)
  try {
    const name = (opts.name ? safeFilename(opts.name) : undefined) ?? got.name
    const contentType =
      name !== got.name && got.contentType === 'application/octet-stream' ? contentTypeFor(name) : got.contentType
    const { uploadUrl, storageKey, scope } = await prepareUpload(
      api,
      ctx,
      { filename: name, contentType, size: got.size },
      url,
    )
    const result = await put(uploadUrl, got.path, got.size, contentType)
    if (result.status === 0) {
      throw new DriverError(
        `the upload PUT failed before a response (${result.error ?? 'no detail'}) while uploading ${url}`,
        EXIT.USAGE,
      )
    }
    if (result.status < 200 || result.status >= 300) {
      throw new DriverError(`the upload PUT answered ${result.status} for ${url}`, EXIT.USAGE)
    }
    return await registerUpload(api, ctx, scope, storageKey, name, url)
  } finally {
    await got.cleanup()
  }
}

/** `files/register`'s own shape (06) — a `path` under `workflows/`. Passed through even if it also carries a `url`. */
function isRegisteredRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const path = (value as Record<string, unknown>).path
  return typeof path === 'string' && path.startsWith('workflows/')
}

/**
 * An object that is NOT a registered ref but names an `https://` url — the
 * shape a tool-calling model produces when it wraps a URL rather than passing
 * it as a plain string. `undefined` for anything else (a bare object, a
 * `http://` url, a non-string `url`).
 */
function wrappedUrl(value: unknown): { url: string; name?: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const r = value as Record<string, unknown>
  const url = str(r.url)
  if (!url || !isHttpUrl(url)) return undefined
  return { url, name: str(r.name) }
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
  opts: UploadOptions = {},
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = { ...supplied }

  const viaUrl = async (name: string, url: string, overrideName?: string): Promise<FileRef> => {
    if (opts.mocks) {
      throw new DriverError(
        `URL file inputs are not supported under --mocks; pass a local path (input ${name}: ${url})`,
        EXIT.USAGE,
      )
    }
    return uploadFromUrl(api, ctx, name, url, deps, overrideName !== undefined ? { name: overrideName } : undefined)
  }

  const one = async (name: string, value: string): Promise<FileRef> => {
    if (!isHttpUrl(value)) return uploadOne(api, ctx, value, deps)
    return viaUrl(name, value)
  }

  /** A non-string entry: a registered ref and anything unrecognised pass through; a wrapped URL is uploaded. */
  const orPassthrough = async (name: string, entry: unknown): Promise<unknown> => {
    if (isRegisteredRef(entry)) return entry
    const wrapped = wrappedUrl(entry)
    return wrapped ? viaUrl(name, wrapped.url, wrapped.name) : entry
  }

  for (const [name, decl] of Object.entries(decls)) {
    if (decl.type !== 'file' || !(name in values)) continue
    const value = values[name]
    if (value === null || value === undefined) continue

    if (decl.list === true && Array.isArray(value)) {
      const refs: unknown[] = []
      for (const entry of value) {
        refs.push(typeof entry === 'string' ? await one(name, entry) : await orPassthrough(name, entry))
      }
      values[name] = refs
      continue
    }
    if (typeof value === 'string') {
      values[name] = await one(name, value)
      continue
    }
    values[name] = await orPassthrough(name, value)
  }

  return values
}
