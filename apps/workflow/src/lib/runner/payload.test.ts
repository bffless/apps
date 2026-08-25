/**
 * `payload.ts` (Task 12): `isFilePayload`/`byteSize` as pure predicates, and
 * the `offloadOutputs`/`hydrateOutputs` round trip against a fake `store`/
 * `fetchJson` pair (this module itself does no IO).
 */
import { describe, expect, it } from 'vitest'
import type { FileRef } from './types'
import {
  PAYLOAD_BUDGET_BYTES,
  byteSize,
  hydrateOutputs,
  isFilePayload,
  isUnavailablePayload,
  offloadOutputs,
} from './payload'

function fileRef(path: string): FileRef {
  return { path, name: path.split('/').pop() ?? path, contentType: 'application/json', size: 1, url: `/api/uploads/${path}` }
}

/** A fake `store`: records every call, answers a deterministic `FileRef`. */
function fakeStore(): { store: (name: string, json: string) => Promise<FileRef>; calls: { name: string; json: string }[] } {
  const calls: { name: string; json: string }[] = []
  const store = async (name: string, json: string): Promise<FileRef> => {
    calls.push({ name, json })
    return fileRef(`stored/${name}`)
  }
  return { store, calls }
}

describe('byteSize', () => {
  it('is the UTF-8 byte length of JSON.stringify(v)', () => {
    expect(byteSize('hi')).toBe(JSON.stringify('hi').length)
    expect(byteSize({ a: 1 })).toBe(new TextEncoder().encode(JSON.stringify({ a: 1 })).length)
    // Multi-byte UTF-8 characters cost more bytes than `.length` (UTF-16 code units) would say.
    expect(byteSize('日本語')).toBeGreaterThan('日本語'.length)
  })
})

describe('isFilePayload', () => {
  const ref = fileRef('workflows/x/y/runs/r/k/big.json')

  it('is true for a plain object with exactly one own key `$file` holding a File ref', () => {
    expect(isFilePayload({ $file: ref })).toBe(true)
  })

  it('is false for a bare FileRef (no $file wrapper)', () => {
    expect(isFilePayload(ref)).toBe(false)
  })

  it('is false when other keys are present alongside $file', () => {
    expect(isFilePayload({ $file: ref, note: 'x' })).toBe(false)
  })

  it('is false when $file does not hold a valid File ref', () => {
    expect(isFilePayload({ $file: { path: 'x' } })).toBe(false)
    expect(isFilePayload({ $file: 'not-a-ref' })).toBe(false)
  })

  it('is false for null, arrays, primitives', () => {
    expect(isFilePayload(null)).toBe(false)
    expect(isFilePayload([ref])).toBe(false)
    expect(isFilePayload('hi')).toBe(false)
    expect(isFilePayload(42)).toBe(false)
  })
})

describe('offloadOutputs', () => {
  it('offloads an output over the budget: stores it once under `<name>.json`, substitutes {$file}', async () => {
    const big = 'x'.repeat(PAYLOAD_BUDGET_BYTES + 1024)
    const { store, calls } = fakeStore()

    const result = await offloadOutputs({ big }, store)

    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('big')
    expect(JSON.parse(calls[0].json)).toBe(big)
    expect(isFilePayload(result.big)).toBe(true)
    expect((result.big as { $file: FileRef }).$file.path).toBe('stored/big')
  })

  it('leaves a 10 KB output inline (no store call)', async () => {
    const small = 'y'.repeat(10 * 1024)
    const { store, calls } = fakeStore()

    const result = await offloadOutputs({ small }, store)

    expect(calls).toHaveLength(0)
    expect(result.small).toBe(small)
  })

  it('handles a mixed map: offloads only the outputs over budget, both intact', async () => {
    const big = 'x'.repeat(PAYLOAD_BUDGET_BYTES + 1)
    const small = 'ok'
    const { store, calls } = fakeStore()

    const result = await offloadOutputs({ big, small }, store)

    expect(calls.map((c) => c.name)).toEqual(['big'])
    expect(isFilePayload(result.big)).toBe(true)
    expect(result.small).toBe('ok')
  })

  it('does not mutate the input map — the caller keeps the inline value for live state', async () => {
    const big = 'x'.repeat(PAYLOAD_BUDGET_BYTES + 1)
    const outputs = { big }
    const { store } = fakeStore()

    const result = await offloadOutputs(outputs, store)

    expect(outputs.big).toBe(big)
    expect(result).not.toBe(outputs)
  })

  it('leaves a nested $file-shaped value alone — offload is decided per top-level output only', async () => {
    const ref = fileRef('already/offloaded.json')
    const nested = { deeper: { $file: ref } } // not itself over budget, and not top-level $file-shaped
    const { store, calls } = fakeStore()

    const result = await offloadOutputs({ nested }, store)

    expect(calls).toHaveLength(0)
    expect(result.nested).toEqual(nested)
  })
})

describe('hydrateOutputs', () => {
  it('replaces every top-level {$file} with the fetched JSON it points to', async () => {
    const ref = fileRef('workflows/x/y/runs/r/k/big.json')
    const fetchJson = async (r: FileRef) => (r.path === ref.path ? 'the-big-value' : null)

    const result = await hydrateOutputs({ big: { $file: ref }, small: 'inline' }, fetchJson)

    expect(result).toEqual({ big: 'the-big-value', small: 'inline' })
  })

  it('passes null/undefined through unchanged', async () => {
    const fetchJson = async () => {
      throw new Error('fetchJson: should not be called')
    }
    expect(await hydrateOutputs(null, fetchJson)).toBeNull()
    expect(await hydrateOutputs(undefined, fetchJson)).toBeUndefined()
  })

  it('leaves a nested $file object (deeper than top level) alone', async () => {
    const ref = fileRef('nested.json')
    const fetchJson = async () => {
      throw new Error('fetchJson: should not be called for a non-top-level $file')
    }
    const outputs = { table: { columns: [], rows: [{ file: { $file: ref } }] } }

    const result = await hydrateOutputs(outputs, fetchJson)

    expect(result).toEqual(outputs)
  })
})

describe('isUnavailablePayload', () => {
  const ref = fileRef('workflows/x/big.json')

  it('recognises the two-key sentinel a failed payload fetch leaves behind', () => {
    expect(isUnavailablePayload({ $file: ref, $error: '500' })).toBe(true)
  })

  it('is not a plain {$file} payload, and a plain {$file} payload is not it', () => {
    expect(isUnavailablePayload({ $file: ref })).toBe(false)
    expect(isFilePayload({ $file: ref, $error: '500' })).toBe(false)
  })

  it('rejects a partial or over-wide match', () => {
    expect(isUnavailablePayload({ $file: ref, $error: 404 })).toBe(false)
    expect(isUnavailablePayload({ $file: { path: 'p' }, $error: 'x' })).toBe(false)
    expect(isUnavailablePayload({ $file: ref, $error: 'x', extra: 1 })).toBe(false)
    expect(isUnavailablePayload(null)).toBe(false)
    expect(isUnavailablePayload([{ $file: ref, $error: 'x' }])).toBe(false)
  })
})
