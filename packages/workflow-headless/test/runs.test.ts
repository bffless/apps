import { describe, expect, test } from 'vitest'
import type { ApiLike } from '../src/api.js'
import { DriverError, EXIT } from '../src/errors.js'
import { formatRunsTable, listRuns, toRunRows } from '../src/runs.js'

const unusable: ApiLike = {
  async json() {
    throw new Error('not used')
  },
  async text() {
    throw new Error('not used')
  },
  async bytes() {
    throw new Error('not used')
  },
  async put() {
    return { status: 200 }
  },
}

describe('toRunRows', () => {
  test('reads flattened rows, `fields` rows and every list wrapper, newest first', () => {
    const rows = toRunRows({
      records: [
        { fields: { runId: 'run_a', status: 'succeeded', startedAt: 10, workflowName: 'Hello' } },
        { runId: 'run_b', status: 'failed', startedAt: 20, workflowName: 'Hello', headless: true },
      ],
    })
    expect(rows.map((r) => r.runId)).toEqual(['run_b', 'run_a'])
    expect(rows[0]!.headless).toBe(true)
    expect(rows[1]!.headless).toBe(false)
  })
})

describe('formatRunsTable', () => {
  test('says so when there are none', () => {
    expect(formatRunsTable([])).toBe('no runs')
  })

  test('is a padded table with the terminal status and the run id', () => {
    const text = formatRunsTable(
      toRunRows([{ runId: 'run_a', status: 'succeeded', startedAt: 1_700_000_000_000 }]),
    )
    expect(text.split('\n')[0]).toContain('RUN ID')
    expect(text).toContain('2023-11-14T22:13:20.000Z')
    expect(text).toContain('run_a')
  })
})

describe('listRuns', () => {
  test('a non-200 is a DriverError with a driver-side code, never a bare Error', async () => {
    // errors.ts's rule: a driver that could not reach the harness must not look
    // like a run that ran and failed, so this may not fall into a catch-all
    // that returns 1.
    const api: ApiLike = { ...unusable, async json() {
      return { status: 503, body: { error: 'down' } }
    } }
    const error = await listRuns(api, 'hello', 'interactive', 10).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toContain('503')
  })

  test('trims to --last', async () => {
    const api: ApiLike = { ...unusable, async json() {
      return {
        status: 200,
        body: [
          { runId: 'run_a', status: 'succeeded', startedAt: 3 },
          { runId: 'run_b', status: 'succeeded', startedAt: 2 },
          { runId: 'run_c', status: 'succeeded', startedAt: 1 },
        ],
      }
    } }
    expect((await listRuns(api, 'hello', 'interactive', 2)).map((r) => r.runId)).toEqual([
      'run_a',
      'run_b',
    ])
  })
})
