/**
 * Harness coverage for `api/transcribe/post/{flatten,check}.fn.js` — the
 * postSteps guard that decides whether a WhisperX run counts as a success.
 *
 * postSteps never abort on a failed step, and a failed step writes NO output
 * (see CLAUDE.md's "CE facts learned building this app"): when the `whisper`
 * Replicate call fails, `steps.whisper` is simply absent downstream. Without
 * this test, a regression back to "any well-formed `{words, text}` shape is
 * ok" would silently mark a failed transcription 'transcribed' with an empty
 * transcript instead of 'error' — the dead-branch bug this file guards
 * against (mirrors `zipCheck.test.ts`/`storeCheck` coverage on the index
 * pipeline).
 */

import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

type FlattenOutput = { words: { text: string; start: number | null; end: number | null }[]; text: string }
type CheckOutput = { ok: boolean; notOk: boolean; error: string; data: FlattenOutput | null }

const flattenFnSrc = loadFnSource('api/transcribe/post/flatten.fn.js')
const checkFnSrc = loadFnSource('api/transcribe/post/check.fn.js')

function flatten(steps: Record<string, unknown>): FlattenOutput {
  return runFn(flattenFnSrc, { steps }) as FlattenOutput
}

function check(flattenOutput: FlattenOutput | null): CheckOutput {
  return runFn(checkFnSrc, { steps: { flatten: flattenOutput } }) as CheckOutput
}

const WHISPER_SEGMENTS = {
  output: {
    segments: [
      {
        text: 'hello world',
        words: [
          { word: 'hello', start: 0, end: 0.4 },
          { word: 'world', start: 0.5, end: 0.9 },
        ],
      },
    ],
  },
}

describe('flatten.fn.js', () => {
  test('flattens WhisperX segments to { words: [{text,start,end}], text } with no speaker field', () => {
    const out = flatten({ whisper: WHISPER_SEGMENTS })
    expect(out).toEqual({
      words: [
        { text: 'hello', start: 0, end: 0.4 },
        { text: 'world', start: 0.5, end: 0.9 },
      ],
      text: 'hello world',
    })
  })

  test('returns an empty-but-well-formed shape, not a throw, when steps.whisper is absent (a failed Replicate call)', () => {
    expect(flatten({})).toEqual({ words: [], text: '' })
    expect(flatten({ whisper: undefined })).toEqual({ words: [], text: '' })
  })
})

describe('check.fn.js', () => {
  test('rejects the whisper-failed case: empty flatten output reads as notOk, not ok', () => {
    // Simulates the real failure path end-to-end: whisper never ran (absent
    // from steps) -> flatten still runs and produces its empty shape -> check
    // must NOT treat that as a pass.
    const flattenOutput = flatten({})
    const out = check(flattenOutput)
    expect(out).toEqual({ ok: false, notOk: true, error: 'Transcription failed', data: null })
  })

  test('rejects a null flatten step outright (defensive)', () => {
    const out = check(null)
    expect(out).toEqual({ ok: false, notOk: true, error: 'Transcription failed', data: null })
  })

  test('passes the happy case: non-empty words', () => {
    const flattenOutput = flatten({ whisper: WHISPER_SEGMENTS })
    const out = check(flattenOutput)
    expect(out.ok).toBe(true)
    expect(out.notOk).toBe(false)
    expect(out.error).toBe('')
    expect(out.data).toEqual(flattenOutput)
  })
})
