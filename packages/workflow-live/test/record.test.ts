import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isFileRef, isOffloaded, parseRecord, stepByKey, stepsOfJob } from '../src/record.js'

const rec = parseRecord(JSON.parse(readFileSync(new URL('./fixtures/headless-hello.json', import.meta.url), 'utf8')))

describe('record', () => {
  it('parses { run, steps }', () => {
    expect(rec.run?.status).toBe('succeeded')
    expect(rec.steps.length).toBeGreaterThan(3)
  })
  it('rejects a non-record', () => {
    expect(() => parseRecord({ nope: 1 })).toThrow(/no `run`/)
    expect(() => parseRecord({ run: null, steps: 'x' })).toThrow(/`steps` is not an array/)
  })
  it('rejects a step row without a string key and status', () => {
    expect(() => parseRecord({ run: null, steps: [{ key: 'a/0/b', status: 'succeeded' }, { key: 'a/1/b' }] })).toThrow(/steps\[1\] has no string `key`\/`status`/)
    expect(() => parseRecord({ run: null, steps: ['a/0/b'] })).toThrow(/steps\[0\]/)
    expect(() => parseRecord({ run: null, steps: [{ key: 1, status: 'succeeded' }] })).toThrow(/steps\[0\]/)
    expect(parseRecord({ run: null, steps: [] }).steps).toEqual([])
  })
  it('finds steps by key and by job', () => {
    expect(stepByKey(rec, 'pick/0/choose')?.status).toBe('succeeded')
    expect(stepsOfJob(rec, 'review').map((s) => s.key)).toEqual(['review/0/confirm'])
  })
  it('sorts a job\'s steps by index, not array order', () => {
    expect(stepsOfJob(rec, 'greet').map((s) => s.key)).toEqual(['greet/0/say', 'greet/1/say'])
  })
  it('recognises File refs and offload pointers', () => {
    expect(isFileRef(rec.run?.outputs?.poster)).toBe(true)
    expect(isFileRef({ path: 'x' })).toBe(false)
    expect(isOffloaded(stepByKey(rec, 'card/0/draw')!.outputs!.big)).toBe(true)
    expect(isOffloaded(rec.run?.outputs?.poster)).toBe(false)
    expect(isOffloaded([1, 2])).toBe(false)
  })
})
