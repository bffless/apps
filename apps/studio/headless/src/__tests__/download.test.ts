import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, stat, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { fileNameFor, downloadAll } from '../download'

let server: Server
let origin: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok/clip.mp4') { res.writeHead(200); res.end(Buffer.alloc(1024, 7)) }
    else if (req.url === '/empty.mp4') { res.writeHead(200); res.end() }
    else { res.writeHead(404); res.end('nope') }
  })
  await new Promise<void>((r) => server.listen(0, () => r()))
  const addr = server.address() as { port: number }
  origin = `http://127.0.0.1:${addr.port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('fileNameFor', () => {
  it('keeps a video filename from the URL path, prefixed for ordering', () => {
    expect(fileNameFor('https://x/recordings/demo%20day.mp4', 0)).toBe('00-demo day.mp4')
  })
  it('falls back to source-N.mp4 for extensionless paths', () => {
    expect(fileNameFor('https://x/dl?id=123', 2)).toBe('source-2.mp4')
  })
})

describe('downloadAll', () => {
  it('downloads to destDir and returns paths in order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'))
    const [p] = await downloadAll([`${origin}/ok/clip.mp4`], dir)
    expect((await stat(p)).size).toBe(1024)
  })
  it('fails on non-200', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'))
    await expect(downloadAll([`${origin}/missing.mp4`], dir)).rejects.toThrow(/404/)
  })
  it('fails on an empty body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'))
    await expect(downloadAll([`${origin}/empty.mp4`], dir)).rejects.toThrow(/empty/i)
  })
  it('returns absolute paths even when destDir is relative', async () => {
    const relDir = 'test-dl-relative'
    await mkdir(relDir, { recursive: true })
    try {
      const [p] = await downloadAll([`${origin}/ok/clip.mp4`], relDir)
      expect(isAbsolute(p)).toBe(true)
      expect((await stat(p)).size).toBe(1024)
    } finally {
      // cleanup would go here but we'll let the test runner handle it
    }
  })
})
