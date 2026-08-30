/**
 * The persisted tail (apps#527): `persistableScriptLog` is what the terminal
 * events attach to the row, so its caps are the record's caps — the store's
 * own last-50 tail, byte-bounded at 64 KB JSON with the oldest lines dropped
 * first. The live-store behaviour itself (tail, snapshots, reset) is proven
 * through the card's tests; this file is only about what the record takes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOG_BUDGET_BYTES,
  appendScriptLog,
  clearAllScriptLogs,
  persistableScriptLog,
} from './logStore'

const RUN = 'run_tail'
const KEY = 'make/0/poster'

const jsonBytes = (lines: string[]) => new TextEncoder().encode(JSON.stringify(lines)).length

afterEach(() => {
  clearAllScriptLogs()
})

describe('persistableScriptLog', () => {
  it('is undefined when the script logged nothing — the row keeps no column, not `[]`', () => {
    expect(persistableScriptLog(RUN, KEY)).toBeUndefined()
  })

  it('hands back the store tail as-is when it fits the budget', () => {
    appendScriptLog(RUN, KEY, 'frame 1')
    appendScriptLog(RUN, KEY, 'frame 2')
    expect(persistableScriptLog(RUN, KEY)).toEqual(['frame 1', 'frame 2'])
  })

  it('drops the oldest lines first until the JSON fits 64 KB', () => {
    // 50 lines of 4 KB each ≈ 200 KB JSON — well over budget, so the head goes.
    for (let i = 0; i < 50; i++) appendScriptLog(RUN, KEY, `line ${i} ${'x'.repeat(4096)}`)

    const tail = persistableScriptLog(RUN, KEY)!
    expect(jsonBytes(tail)).toBeLessThanOrEqual(LOG_BUDGET_BYTES)
    expect(tail.length).toBeLessThan(50)
    // The newest line survives; the oldest went first.
    expect(tail[tail.length - 1].startsWith('line 49 ')).toBe(true)
    expect(tail[0].startsWith('line 0 ')).toBe(false)
  })

  it('truncates a single line that alone busts the budget, keeping its head', () => {
    appendScriptLog(RUN, KEY, `head${'y'.repeat(2 * LOG_BUDGET_BYTES)}`)

    const tail = persistableScriptLog(RUN, KEY)!
    expect(tail).toHaveLength(1)
    expect(jsonBytes(tail)).toBeLessThanOrEqual(LOG_BUDGET_BYTES)
    expect(tail[0].startsWith('head')).toBe(true)
    expect(tail[0].endsWith('… [truncated]')).toBe(true)
  })
})
