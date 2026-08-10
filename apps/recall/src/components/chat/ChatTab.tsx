/**
 * Chat tab (Task 10): RAG chat over the video library, grounded by the
 * `search_videos` tool the `/api/chat` rule wires up (see
 * `.bffless/proxy-rules/recall/rules/api/chat/post/rule.yaml`). Citation
 * links the assistant writes become `CitationChip`s (via `ChatMessages`)
 * that seek the page's shared player instead of opening YouTube.
 *
 * Ported from the chat-pipelines demo's `ChatPopup/ChatPanel.tsx` — the
 * popup's *composition* (header bar with close/collapse, floating panel
 * chrome) is popup-only and was dropped per the brief, but its *hook logic*
 * (localStorage conversation persistence, rate-limit countdown parsing,
 * suggestion buttons, stop-generation) is what "full-page chat" in this
 * brief actually names, and it's what's reused here — the standalone
 * `App.tsx` full-page demo instead resumes conversations via a `/chat/:id`
 * URL route, which doesn't fit a tab inside Recall's single-page `Home`
 * (there's no route to rewrite). Rebuilt as a page-embedded tab: no
 * close/collapse controls, styled with Tailwind to match the rest of Recall
 * instead of the demo's inline styles.
 *
 * State-update style follows `Home.tsx`'s `SearchTab` convention: transitions
 * happen where they're triggered (an event handler, or a value comparison
 * during render — see `ChatSession`'s rate-limit block) rather than inside a
 * `useEffect` that turns around and calls `setState` synchronously, which is
 * exactly the cascading-render pattern `react-hooks/set-state-in-effect`
 * guards against. `New chat` resets by remounting `ChatSession` under a new
 * `key` (same technique the source demo's popup wrapper uses), which is
 * simpler than trying to reset half a dozen pieces of hook-internal state by
 * hand.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useChat, type UIMessage } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { ChatMessages } from './ChatMessages'
import { ChatInput } from './ChatInput'
import type { BackendMessage, ChatStatus, SuggestionItem } from './types'
import type { SeekTarget } from '../CitationChip'

const STORAGE_KEY = 'recall_chat_conversation_id'

const suggestions: SuggestionItem[] = [
  { label: 'What topics does this video library cover?', prompt: 'What topics does this video library cover?' },
  { label: 'Find videos about getting started', prompt: 'Find videos about getting started.' },
  { label: 'Summarize what was covered recently', prompt: 'What was covered in the most recently published video?' },
]

function readStoredConversationId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function statusLabel(status: ChatStatus): string | null {
  if (status === 'streaming') return 'Streaming…'
  if (status === 'submitted') return 'Sending…'
  return null
}

interface RateLimitInfo {
  retryAfter: number
  message: string
}

function parseRateLimitError(err: Error | undefined): RateLimitInfo | null {
  if (!err) return null
  try {
    const match = err.message.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0])
      const errorObj = parsed.error || parsed
      if (errorObj.code === 'RATE_LIMIT_EXCEEDED' && errorObj.details?.retryAfter) {
        return { retryAfter: errorObj.details.retryAfter as number, message: (errorObj.message as string) || 'Rate limit exceeded' }
      }
    }
  } catch {
    // Not a rate limit error.
  }
  return null
}

function ChatSession({ onSeek, onNewChat }: { onSeek: (target: SeekTarget) => void; onNewChat: () => void }) {
  // Read once per mount (a fresh mount only happens via the `New chat` remount below).
  const [initialConversationId] = useState<string | null>(readStoredConversationId)
  const [isLoadingHistory, setIsLoadingHistory] = useState(!!initialConversationId)
  const [input, setInput] = useState('')

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      }),
    [],
  )

  const {
    messages,
    setMessages,
    status: rawStatus,
    stop,
    sendMessage,
    id: chatId,
    error,
  } = useChat({
    ...(initialConversationId ? { id: initialConversationId } : {}),
    transport,
  })

  const status: ChatStatus = useMemo(() => {
    if (rawStatus === 'streaming') return 'streaming'
    if (rawStatus === 'submitted') return 'submitted'
    if (rawStatus === 'error') return 'error'
    return 'ready'
  }, [rawStatus])

  // Pure side effect (write to storage), not a React state update — safe to
  // run whenever the SDK-assigned id changes.
  useEffect(() => {
    if (!chatId) return
    try {
      localStorage.setItem(STORAGE_KEY, chatId)
    } catch {
      // Private browsing / storage disabled — conversation just won't resume on reload.
    }
  }, [chatId])

  // Fetch conversation history exactly once, triggered by the mount itself
  // (there's no user event to hang this off, so it stays an effect) —
  // `setMessages` here runs after the awaited fetch, not synchronously in
  // the effect body.
  useEffect(() => {
    if (!initialConversationId) return
    let cancelled = false

    async function loadHistory() {
      try {
        const response = await fetch(`/api/chat?conversationId=${encodeURIComponent(initialConversationId!)}`)
        if (cancelled || !response.ok) return
        const result = await response.json()
        if (cancelled || !result.success || !Array.isArray(result.data) || result.data.length === 0) return
        const sorted = [...result.data].sort(
          (a: BackendMessage, b: BackendMessage) => new Date(a.createdAt || '').getTime() - new Date(b.createdAt || '').getTime(),
        )
        setMessages(
          sorted.map(
            (msg: BackendMessage): UIMessage => ({
              id: msg.id,
              role: msg.role,
              parts: [{ type: 'text', text: msg.content }],
            }),
          ),
        )
      } catch {
        // Silently fail — start fresh conversation.
      } finally {
        if (!cancelled) setIsLoadingHistory(false)
      }
    }

    loadHistory()
    return () => {
      cancelled = true
    }
  }, [initialConversationId, setMessages])

  // Rate limit tracking: derive from `error` directly during render (guarded
  // by comparing against the previously-seen error) rather than in an
  // effect — see the file header for why. Once armed, a plain effect ticks
  // it down once a second; that setState lives inside the interval
  // callback, not the effect body itself.
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null)
  const [seenError, setSeenError] = useState<Error | undefined>(undefined)
  if (error !== seenError) {
    setSeenError(error)
    const info = parseRateLimitError(error)
    if (info) setRateLimit(info)
  }

  useEffect(() => {
    if (!rateLimit || rateLimit.retryAfter <= 0) return
    const timer = setInterval(() => {
      setRateLimit((prev) => {
        if (!prev) return prev
        const next = prev.retryAfter - 1
        return next <= 0 ? null : { ...prev, retryAfter: next }
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [rateLimit])

  const handleSend = useCallback(async () => {
    if (!input.trim() || status === 'streaming' || rateLimit) return
    const message = input
    setInput('')
    await sendMessage({ text: message })
  }, [input, status, rateLimit, sendMessage])

  const handleSuggestionClick = useCallback((prompt: string) => {
    setInput(prompt)
  }, [])

  const isRateLimited = !!rateLimit && rateLimit.retryAfter > 0
  const label = isRateLimited ? `Rate limited — try again in ${rateLimit!.retryAfter}s` : statusLabel(status)
  const showError = status === 'error' && error && !parseRateLimitError(error)

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="flex min-h-9 items-center justify-between border-b border-slate-200 px-4 py-2 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs">
          {label && (
            <span
              className={
                isRateLimited
                  ? 'rounded-full bg-amber-100 px-2.5 py-0.5 font-medium text-amber-700 dark:bg-amber-900 dark:text-amber-300'
                  : 'rounded-full bg-blue-100 px-2.5 py-0.5 font-medium text-blue-700 dark:bg-blue-900 dark:text-blue-300'
              }
            >
              {label}
            </span>
          )}
          {showError && (
            <span className="rounded-full bg-red-100 px-2.5 py-0.5 font-medium text-red-700 dark:bg-red-900 dark:text-red-300">
              Something went wrong. Try again.
            </span>
          )}
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={onNewChat}
            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            New chat
          </button>
        )}
      </div>

      {/* Fixed height so `ChatMessages` scrolls internally instead of growing
          the page — growing is what made its autoscroll drag the whole page
          down past the library grid on every streamed token. */}
      <div className="h-[420px] px-4 sm:h-[65svh] sm:max-h-[560px]">
        {isLoadingHistory ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            Loading conversation…
          </div>
        ) : (
          <ChatMessages
            messages={messages}
            status={status}
            suggestions={suggestions}
            onSuggestionClick={handleSuggestionClick}
            onSeek={onSeek}
          />
        )}
      </div>

      <div className="px-4 pb-4">
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          onStop={stop}
          status={status}
          disabled={isRateLimited || isLoadingHistory}
          rateLimitCountdown={rateLimit?.retryAfter ?? 0}
        />
      </div>
    </div>
  )
}

export function ChatTab({ onSeek }: { onSeek: (target: SeekTarget) => void }) {
  const [sessionKey, setSessionKey] = useState(0)

  const handleNewChat = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Ignore.
    }
    setSessionKey((k) => k + 1)
  }, [])

  return <ChatSession key={sessionKey} onSeek={onSeek} onNewChat={handleNewChat} />
}
