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
    } as RequestInit & { duplex: 'half' })
    return { status: res.status }
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause
    const message = e instanceof Error ? e.message : String(e)
    const causeMessage = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : ''
    return { status: 0, error: causeMessage ? `${message}: ${causeMessage}` : message }
  }
}
