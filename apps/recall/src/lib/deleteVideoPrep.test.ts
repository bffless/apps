import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

type PrepOutput = {
  videoId: string
  prefix: string
  sheetsPrefix: string
  sourceSubDir: string
  audioSubDir: string
  sheetsSubDir: string
}

const prepFnSrc = loadFnSource('api/videos/delete/post/prep.fn.js')

function run(body: unknown): PrepOutput {
  return runFn(prepFnSrc, { request: { body } }) as PrepOutput
}

const EXPECTED_V1: PrepOutput = {
  videoId: 'v1',
  prefix: 'videos/v1/',
  sheetsPrefix: 'sheets/v1/',
  sourceSubDir: 'videos/v1/source',
  audioSubDir: 'videos/v1/audio',
  sheetsSubDir: 'sheets/v1',
}

describe('api/videos/delete/post/prep.fn.js', () => {
  test('builds both the videos/ and sheets/ bucket prefixes for the given id', () => {
    expect(run({ videoId: 'v1' })).toEqual(EXPECTED_V1)
  })

  test('the sheets prefix is top-level, not nested under the video prefix', () => {
    const out = run({ videoId: 'v1' })
    expect(out.sheetsPrefix.startsWith('videos/')).toBe(false)
    expect(out.sheetsPrefix).toBe('sheets/v1/')
  })

  test('builds the literal recall_uploads sub_dir values register_upload wrote at upload time', () => {
    const out = run({ videoId: 'v1' })
    expect(out.sourceSubDir).toBe('videos/v1/source')
    expect(out.audioSubDir).toBe('videos/v1/audio')
    expect(out.sheetsSubDir).toBe('sheets/v1')
    // sub_dir values never have a trailing slash (register_upload records the
    // resolved subDir expression as-is).
    expect(out.sourceSubDir.endsWith('/')).toBe(false)
    expect(out.audioSubDir.endsWith('/')).toBe(false)
    expect(out.sheetsSubDir.endsWith('/')).toBe(false)
  })

  test('trims whitespace around videoId', () => {
    expect(run({ videoId: '  v1  ' })).toEqual(EXPECTED_V1)
  })

  test('throws when videoId is missing or blank (fails closed)', () => {
    expect(() => run({})).toThrow('videoId required')
    expect(() => run({ videoId: '' })).toThrow('videoId required')
    expect(() => run({ videoId: '   ' })).toThrow('videoId required')
    expect(() => run(undefined)).toThrow('videoId required')
  })
})
