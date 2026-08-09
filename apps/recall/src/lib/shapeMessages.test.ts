import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

type MessageMeta = { id: string; role: string; content: string; createdAt: string | null }
type ShapeOutput = { messages: MessageMeta[] }

const shapeFnSrc = loadFnSource('_custom/messages-get/get/shape.fn.js')

function run(rows: Record<string, unknown>[]): ShapeOutput {
  return runFn(shapeFnSrc, { steps: { query: rows } }) as ShapeOutput
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    conversation_id: 'c1',
    role: 'user',
    content: 'What did the video say about X?',
    createdAt: '2023-11-14T00:00:00.000Z',
    ...overrides,
  }
}

describe('_custom/messages-get/get/shape.fn.js', () => {
  test('maps to the message shape', () => {
    const out = run([row()])
    expect(out.messages[0]).toEqual({
      id: 'm1',
      role: 'user',
      content: 'What did the video say about X?',
      createdAt: '2023-11-14T00:00:00.000Z',
    })
  })

  test('sorts oldest-first by createdAt (a thread reads top-to-bottom)', () => {
    const out = run([
      row({ id: 'newest', createdAt: '2023-11-01T00:00:00.000Z' }),
      row({ id: 'oldest', createdAt: '2023-01-01T00:00:00.000Z' }),
      row({ id: 'mid', createdAt: '2023-06-01T00:00:00.000Z' }),
    ])
    expect(out.messages.map((m) => m.id)).toEqual(['oldest', 'mid', 'newest'])
  })

  test('an empty row list returns an empty messages array', () => {
    expect(run([])).toEqual({ messages: [] })
  })
})
