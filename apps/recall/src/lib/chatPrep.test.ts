/**
 * TDD for `api/chat/post/prep.fn.js` — derives a conversation title from the
 * first user message in `request.body.messages`, for the ai step's
 * `extraConversationFields: { title: "steps.prep.title" }` (title-
 * conversations-from-first-message).
 *
 * The PRIMARY fixture uses useChat v5's `parts` array shape — confirmed
 * against `ChatTab.tsx`'s transport (`@ai-sdk/react`'s `useChat` +
 * `DefaultChatTransport`) and its own history-load code, which constructs
 * `UIMessage`s as `{ id, role, parts: [{ type: 'text', text: msg.content }] }`.
 * That's the real shape `request.body.messages` carries in production; the
 * legacy `content: string` and `content: [{type,text}]` shapes are secondary,
 * defensive cases (CE's ai.handler.ts itself supports the same two: string
 * content, then parts — see its message-extraction loop).
 */
import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

type PrepOutput = { title: string }

const prepFnSrc = loadFnSource('api/chat/post/prep.fn.js')

function run(messages: unknown[]): PrepOutput {
  return runFn(prepFnSrc, { request: { body: { messages } } }) as PrepOutput
}

describe('api/chat/post/prep.fn.js', () => {
  test('derives the title from the first user message (parts array — the real useChat v5 shape)', () => {
    const out = run([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What topics does this library cover?' }] },
    ])
    expect(out.title).toBe('What topics does this library cover?')
  })

  test('handles legacy string content', () => {
    const out = run([{ id: 'u1', role: 'user', content: 'Find videos about getting started' }])
    expect(out.title).toBe('Find videos about getting started')
  })

  test('handles content as an array of {type,text} parts', () => {
    const out = run([
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Summarize the latest video' }] },
    ])
    expect(out.title).toBe('Summarize the latest video')
  })

  test('skips a leading assistant/system message and uses the first user message', () => {
    const out = run([
      { id: 's1', role: 'system', parts: [{ type: 'text', text: 'You are a helpful assistant.' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi, how can I help?' }] },
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What did the last video cover?' }] },
    ])
    expect(out.title).toBe('What did the last video cover?')
  })

  test('collapses internal whitespace and newlines', () => {
    const out = run([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '  What   about\n\nthe   pipeline?  ' }] },
    ])
    expect(out.title).toBe('What about the pipeline?')
  })

  test('truncates over 60 chars on a word boundary with a trailing ellipsis', () => {
    const longText =
      'Can you give me a detailed summary of everything covered in the onboarding video series'
    expect(longText.length).toBeGreaterThan(60)
    const out = run([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: longText }] }])
    expect(out.title.length).toBeLessThanOrEqual(61) // <=60 content chars + ellipsis
    expect(out.title.endsWith('…')).toBe(true)
    expect(out.title).not.toMatch(/\s…$/) // no trailing space before the ellipsis
    expect(longText.startsWith(out.title.slice(0, -1))).toBe(true) // cut on a real word boundary
  })

  test('does not truncate or append an ellipsis to text at or under 60 chars', () => {
    const exact60 = 'x'.repeat(60)
    const out = run([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: exact60 }] }])
    expect(out.title).toBe(exact60)
    expect(out.title.endsWith('…')).toBe(false)
  })

  test('returns an empty title when there is no user message', () => {
    const out = run([{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hello!' }] }])
    expect(out.title).toBe('')
  })

  test('returns an empty title for an empty or missing messages array', () => {
    expect(run([])).toEqual({ title: '' })
    expect(runFn(prepFnSrc, { request: { body: {} } })).toEqual({ title: '' })
  })
})
