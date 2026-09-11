// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { fieldsOf, recordIdOf, rows, runsWithWaiting, withoutDriveKey } from './rows'

describe('rows', () => {
  it('reads every data_query envelope', () => {
    expect(rows([{ a: 1 }])).toEqual([{ a: 1 }])
    expect(rows({ records: [{ a: 1 }] })).toEqual([{ a: 1 }])
    expect(rows({ data: [{ a: 1 }] })).toEqual([{ a: 1 }])
    expect(rows({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }])
    expect(rows(null)).toEqual([])
    expect(rows('x')).toEqual([])
  })

  it('reads flattened or nested columns, and the record id', () => {
    expect(fieldsOf({ id: 'x', runId: 'r' })).toEqual({ id: 'x', runId: 'r' })
    expect(fieldsOf({ id: 'x', fields: { runId: 'r' } })).toEqual({ runId: 'r' })
    expect(recordIdOf({ id: 'x', fields: { runId: 'r' } })).toBe('x')
    expect(recordIdOf({ fields: { id: 'y' } })).toBe('y')
    expect(recordIdOf({ runId: 'r' })).toBeNull()
  })

  it('joins waiting step keys onto runs, sorted, always present', () => {
    const joined = runsWithWaiting(
      [{ id: '1', fields: { runId: 'a', status: 'running' } }, { runId: 'b', status: 'succeeded' }],
      [{ runId: 'a', key: 'z/0/s' }, { runId: 'a', key: 'b/0/s' }, { runId: 'other', key: 'x' }, { key: 'no-run' }],
    )
    expect(joined).toEqual([
      { runId: 'a', status: 'running', waitingOn: ['b/0/s', 'z/0/s'] },
      { runId: 'b', status: 'succeeded', waitingOn: [] },
    ])
  })

  // The driver's nonce (spec 11 D28) must never ride a row that feeds a
  // response — `withoutDriveKey` is a no-op when the row never had one, so a
  // caller need not check before calling it.
  it('strips driveKey, and is a no-op when the row never carried one', () => {
    expect(withoutDriveKey({ runId: 'a', driveKey: 'k' })).toEqual({ runId: 'a' })
    expect(withoutDriveKey({ runId: 'a' })).toEqual({ runId: 'a' })
  })

  it('never carries driveKey onto a listed run, even when the row has one', () => {
    const joined = runsWithWaiting([{ runId: 'a', status: 'running', driveKey: 'k' }], [])
    expect(joined).toEqual([{ runId: 'a', status: 'running', waitingOn: [] }])
  })
})
