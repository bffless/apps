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
  let segment: string
  try {
    const { pathname } = new URL(url)
    segment = pathname.endsWith('/') ? '' : pathname.split('/').filter((s) => s !== '').pop() ?? ''
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
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), counter, createWriteStream(path))
  } catch (e) {
    await cleanup()
    if (e instanceof DriverError) throw e
    throw new DriverError(`download of ${input} failed mid-stream (${detail(e)}) for ${url}`, EXIT.USAGE)
  }
  return { path, name, contentType, size: seen, cleanup }
}
