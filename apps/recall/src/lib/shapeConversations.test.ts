import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

type ConversationMeta = {
  id: string
  title: string | null
  model: string
  message_count: number
  total_tokens: number
  createdAt: string | null
}
type ShapeOutput = { conversations: ConversationMeta[] }

const shapeFnSrc = loadFnSource('api/conversations/get/shape.fn.js')

function run(rows: Record<string, unknown>[]): ShapeOutput {
  return runFn(shapeFnSrc, { steps: { query: rows } }) as ShapeOutput
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    user_id: 'guest-1',
    chat_id: 'c1',
    title: 'About the pipeline',
    model: 'claude-sonnet-4-5',
    message_count: 4,
    total_tokens: 1200,
    createdAt: '2023-11-14T00:00:00.000Z',
    ...overrides,
  }
}

describe('api/conversations/get/shape.fn.js', () => {
  test('maps to the summary shape', () => {
    const out = run([row()])
    expect(out.conversations[0]).toEqual({
      id: 'c1',
      title: 'About the pipeline',
      model: 'claude-sonnet-4-5',
      message_count: 4,
      total_tokens: 1200,
      createdAt: '2023-11-14T00:00:00.000Z',
    })
  })

  test('title defaults to null when missing (Untitled is a display concern)', () => {
    const out = run([row({ title: undefined })])
    expect(out.conversations[0].title).toBeNull()
  })

  test('sorts newest-first by createdAt', () => {
    const out = run([
      row({ id: 'old', createdAt: '2023-01-01T00:00:00.000Z' }),
      row({ id: 'new', createdAt: '2023-11-01T00:00:00.000Z' }),
      row({ id: 'mid', createdAt: '2023-06-01T00:00:00.000Z' }),
    ])
    expect(out.conversations.map((c) => c.id)).toEqual(['new', 'mid', 'old'])
  })

  test('an empty row list returns an empty conversations array', () => {
    expect(run([])).toEqual({ conversations: [] })
  })
})
