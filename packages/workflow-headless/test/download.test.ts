import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, expect } from 'vitest'
import {
  contentTypeFromResponse,
  downloadToTemp,
  filenameFromDisposition,
  filenameFromUrl,
  isHttpUrl,
  safeFilename,
  MAX_DOWNLOAD_BYTES,
} from '../src/download.js'
import { DriverError, EXIT } from '../src/errors.js'

const URL_ = 'https://cdn.test/media/anatomy.mp4?x=1'

/** A fake `fetch` answering one Response built from bytes and headers. */
function answering(status: number, bytes: Uint8Array | null, headers: Record<string, string> = {}) {
  return async () => new Response(bytes === null ? null : bytes, { status, headers })
}

describe('isHttpUrl', () => {
  test('is true only for the https scheme, case-insensitively', () => {
    expect(isHttpUrl('https://x/y.mp4')).toBe(true)
    expect(isHttpUrl('HTTPS://x/y')).toBe(true)
    expect(isHttpUrl('http://x/y.mp4')).toBe(false)
    expect(isHttpUrl('./clip.mp4')).toBe(false)
    expect(isHttpUrl('/abs/clip.mp4')).toBe(false)
    expect(isHttpUrl('file:///x.mp4')).toBe(false)
    expect(isHttpUrl('ftp://x/y')).toBe(false)
  })
})

describe('safeFilename', () => {
  test('replaces path separators with `_`', () => {
    expect(safeFilename('../evil.mp4')).toBe('.._evil.mp4')
    expect(safeFilename('a/b\\c.mp4')).toBe('a_b_c.mp4')
  })
  test('is undefined for `\'\'`, `.` or `..` — even after separators are stripped', () => {
    expect(safeFilename('')).toBeUndefined()
    expect(safeFilename('.')).toBeUndefined()
    expect(safeFilename('..')).toBeUndefined()
  })
  test('leaves an ordinary name untouched', () => {
    expect(safeFilename('anatomy.mp4')).toBe('anatomy.mp4')
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
  test('is undefined for a dot or dot-dot name — it must not escape the temp dir', () => {
    expect(filenameFromDisposition('attachment; filename=".."')).toBeUndefined()
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
  test('falls back to download + extension for a dot or dot-dot segment — it must not escape the temp dir', () => {
    expect(filenameFromUrl('https://h/%2E%2E', 'video/mp4')).toBe('download.mp4')
    expect(filenameFromUrl('https://h/a/.', 'video/mp4')).toBe('download.mp4')
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

  test('cleanup never rejects, even called twice on an already-removed dir', async () => {
    const bytes = new TextEncoder().encode('twelve bytes')
    const got = await downloadToTemp(URL_, 'recording', answering(200, bytes, { 'content-type': 'video/mp4' }))
    await expect(got.cleanup()).resolves.toBeUndefined()
    await expect(got.cleanup()).resolves.toBeUndefined()
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
    const root = mkdtempSync(join(tmpdir(), 'workflow-headless-download-test-'))
    const error = await downloadToTemp(URL_, 'recording', fetchImpl, 10, root).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toMatch(/over the 5 GB cap/)
    expect(readdirSync(root).some((name) => name.startsWith('workflow-headless-'))).toBe(false)
  })

  test('a temp-dir fault (not a response fault) is a usage fault too', async () => {
    const noSuchRoot = join('/nonexistent-workflow-headless-download-test', 'deeper')
    const error = await downloadToTemp(
      URL_,
      'recording',
      answering(200, new Uint8Array(3), { 'content-type': 'video/mp4' }),
      MAX_DOWNLOAD_BYTES,
      noSuchRoot,
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toMatch(
      new RegExp(`^download of recording could not open a temp dir \\(.+\\) for ${URL_.replace(/[.?]/g, '\\$&')}$`),
    )
  })
})
