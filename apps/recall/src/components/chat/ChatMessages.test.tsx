/**
 * Autoscroll behavior for the chat message list. The original implementation
 * called `scrollIntoView` on every `messages` change, which scrolls every
 * scrollable ancestor — including the *document* — so during streaming the
 * whole page jumped to the bottom of the chat on each token and fought the
 * user's own scrolling. The fix scrolls only the list's own container
 * (`el.scrollTop = el.scrollHeight`) and is sticky-bottom: once the user
 * scrolls up, autoscroll disengages until they either return to the bottom or
 * send a new message themselves.
 *
 * jsdom has no layout, so scroll geometry (`scrollHeight`/`clientHeight`/
 * `scrollTop`) is stubbed onto the container element directly.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { UIMessage } from '@ai-sdk/react'
import { ChatMessages } from './ChatMessages'

function msg(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] } as UIMessage
}

const baseProps = {
  status: 'ready' as const,
  suggestions: [],
  onSuggestionClick: vi.fn(),
  onSeek: vi.fn(),
}

/** Stub scroll geometry: content is 1000px tall inside a 400px viewport. */
function stubScrollGeometry(el: HTMLElement) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 })
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: 600 })
}

function renderList(messages: UIMessage[]) {
  const result = render(<ChatMessages {...baseProps} messages={messages} />)
  const scrollEl = result.container.firstElementChild as HTMLElement
  stubScrollGeometry(scrollEl)
  return {
    scrollEl,
    update(next: UIMessage[]) {
      result.rerender(<ChatMessages {...baseProps} messages={next} />)
    },
  }
}

describe('ChatMessages autoscroll', () => {
  it('renders its own scroll container (never scrolls the page)', () => {
    const { scrollEl } = renderList([msg('u1', 'user', 'hi')])
    expect(scrollEl.className).toContain('overflow-y-auto')
  })

  it('follows the stream while the user is at the bottom', () => {
    const messages = [msg('u1', 'user', 'hi')]
    const { scrollEl, update } = renderList(messages)

    update([...messages, msg('a1', 'assistant', 'Hello there')])
    expect(scrollEl.scrollTop).toBe(1000)
  })

  it('stops following once the user scrolls up', () => {
    const messages = [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'Hello')]
    const { scrollEl, update } = renderList(messages)

    scrollEl.scrollTop = 100
    fireEvent.scroll(scrollEl)

    update([...messages.slice(0, 1), msg('a1', 'assistant', 'Hello there, more text')])
    expect(scrollEl.scrollTop).toBe(100)
  })

  it('re-engages when the user sends a new message', () => {
    const messages = [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'Hello')]
    const { scrollEl, update } = renderList(messages)

    scrollEl.scrollTop = 100
    fireEvent.scroll(scrollEl)

    update([...messages, msg('u2', 'user', 'follow-up')])
    expect(scrollEl.scrollTop).toBe(1000)
  })

  it('re-engages when the user scrolls back to the bottom', () => {
    const messages = [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'Hello')]
    const { scrollEl, update } = renderList(messages)

    scrollEl.scrollTop = 100
    fireEvent.scroll(scrollEl)
    scrollEl.scrollTop = 590 // within the near-bottom threshold of 1000 - 400
    fireEvent.scroll(scrollEl)

    update([...messages.slice(0, 1), msg('a1', 'assistant', 'Hello there, more')])
    expect(scrollEl.scrollTop).toBe(1000)
  })
})
