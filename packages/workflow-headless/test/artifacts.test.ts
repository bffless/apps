import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, expect } from 'vitest'
import type { ApiLike } from '../src/api.js'
import {
  downloadOutputs,
  extensionFor,
  fileOutputs,
  writeConsoleLog,
  writeRunRecord,
  writeStepsLog,
} from '../src/artifacts.js'

const out = () => mkdtempSync(join(tmpdir(), 'wfh-art-'))

const ref = (name: string, contentType: string, path = `workflows/hello/${name}`) => ({
  path,
  name,
  contentType,
  size: 7,
  url: `/api/uploads/${path}`,
})

/** Answers bytes for any `/api/uploads/…` url, and 404 for one it was not given. */
function fakeApi(served: Record<string, string>): { api: ApiLike; fetched: string[] } {
  const fetched: string[] = []
  const api: ApiLike = {
    async json() {
      throw new Error('not used')
    },
    async text() {
      throw new Error('not used')
    },
    async bytes(url) {
      fetched.push(url)
      const body = served[url]
      if (body === undefined) return { status: 404, bytes: new Uint8Array() }
      return { status: 200, bytes: new TextEncoder().encode(body) }
    },
    async put() {
      return { status: 200 }
    },
  }
  return { api, fetched }
}

describe('writeRunRecord', () => {
  test('writes the `/api/workflow/run?id=` record verbatim as run.json', async () => {
    const dir = out()
    const record = { run: { runId: 'run_9', status: 'succeeded' }, steps: [{ key: 'a/0/x' }] }
    const path = await writeRunRecord(dir, record)
    expect(path).toBe(join(dir, 'run.json'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record)
    // Pretty-printed: a CI artifact a person reads.
    expect(readFileSync(path, 'utf8')).toContain('\n  "run"')
  })
})

describe('fileOutputs', () => {
  test('picks out File refs, flattens lists, and ignores everything else', () => {
    const poster = ref('poster.svg', 'image/svg+xml')
    const a = ref('a.png', 'image/png')
    const b = ref('b.png', 'image/png')
    expect(
      fileOutputs({ poster, posters: [a, b], line: 'Hello, world!', view: { some: 'json' } }),
    ).toEqual([
      { file: 'poster.svg', ref: poster, output: 'poster' },
      { file: 'posters-1.png', ref: a, output: 'posters' },
      { file: 'posters-2.png', ref: b, output: 'posters' },
    ])
  })
})

describe('extensionFor', () => {
  test('reads the content type first, then the ref name, then gives up', () => {
    expect(extensionFor('image/svg+xml', 'poster')).toBe('svg')
    expect(extensionFor('application/octet-stream', 'clip.mp4')).toBe('mp4')
    expect(extensionFor(undefined, undefined)).toBe('bin')
  })
})

describe('downloadOutputs', () => {
  test('saves every file output under outputs/, named by the output', async () => {
    const dir = out()
    const poster = ref('poster.svg', 'image/svg+xml')
    const a = ref('a.png', 'image/png')
    const { api, fetched } = fakeApi({
      [poster.url]: '<svg/>',
      [a.url]: 'PNG',
    })
    const result = await downloadOutputs(api, dir, { poster, posters: [a], line: 'Hello' })

    expect(fetched).toEqual([poster.url, a.url])
    expect(result.written).toEqual([join(dir, 'outputs', 'poster.svg'), join(dir, 'outputs', 'posters-1.png')])
    expect(result.failed).toEqual([])
    expect(readFileSync(join(dir, 'outputs', 'poster.svg'), 'utf8')).toBe('<svg/>')
    expect(readFileSync(join(dir, 'outputs', 'posters-1.png'), 'utf8')).toBe('PNG')
  })

  test('an output that will not download is reported, not thrown — the rest still land', async () => {
    const dir = out()
    const poster = ref('poster.svg', 'image/svg+xml')
    const gone = ref('gone.png', 'image/png')
    const { api } = fakeApi({ [poster.url]: '<svg/>' })
    const result = await downloadOutputs(api, dir, { poster, gone })
    expect(result.written).toEqual([join(dir, 'outputs', 'poster.svg')])
    expect(result.failed).toEqual(['gone (404)'])
  })

  test('a run with no file outputs writes no outputs/ directory at all', async () => {
    const dir = out()
    const { api } = fakeApi({})
    const result = await downloadOutputs(api, dir, { line: 'Hello' })
    expect(result.written).toEqual([])
    expect(existsSync(join(dir, 'outputs'))).toBe(false)
  })
})

describe('writeStepsLog / writeConsoleLog', () => {
  test('steps.log is one timestamped transition per line', async () => {
    const dir = out()
    const path = await writeStepsLog(dir, [
      { at: 1_700_000_000_000, key: 'a/0/x', status: 'running' },
      { at: 1_700_000_001_000, key: 'run', status: 'succeeded' },
    ])
    expect(readFileSync(path, 'utf8')).toBe(
      '2023-11-14T22:13:20.000Z\ta/0/x\trunning\n2023-11-14T22:13:21.000Z\trun\tsucceeded\n',
    )
  })

  test('console.log carries the page console, one line each', async () => {
    const dir = out()
    const path = await writeConsoleLog(dir, ['error: boom', 'log: fine'])
    expect(readFileSync(path, 'utf8')).toBe('error: boom\nlog: fine\n')
  })
})
