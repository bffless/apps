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
