/**
 * Composer for the chat tab (Task 10). Ported from the chat-pipelines demo's
 * `ChatPopup/ChatInput.tsx` (Enter to send, Shift+Enter for a newline, an
 * auto-growing textarea, and a send/stop button that swaps based on status).
 */

import { useRef, useEffect } from 'react'
import type { KeyboardEvent } from 'react'
import type { ChatStatus } from './types'

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  status: ChatStatus
  disabled?: boolean
  rateLimitCountdown?: number
}

export function ChatInput({ value, onChange, onSend, onStop, status, disabled, rateLimitCountdown }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '48px'
      const scrollHeight = textareaRef.current.scrollHeight
      textareaRef.current.style.height = `${Math.min(scrollHeight, 120)}px`
    }
  }, [value])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!disabled && value.trim() && status !== 'streaming') {
        onSend()
      }
    }
  }

  const isStreaming = status === 'streaming' || status === 'submitted'
  const isDisabled = disabled || (!isStreaming && !value.trim())

  return (
    <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
      {rateLimitCountdown !== undefined && rateLimitCountdown > 0 && (
        <p className="mb-2 text-center text-xs text-amber-600 dark:text-amber-400">
          Rate limited — try again in {rateLimitCountdown}s
        </p>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about the video library…"
          aria-label="Chat message"
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder-slate-500 dark:focus:border-blue-400"
          style={{ minHeight: '48px', maxHeight: '120px' }}
        />
        <button
          type="button"
          onClick={isStreaming ? onStop : onSend}
          disabled={isDisabled && !isStreaming}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
          aria-label={isStreaming ? 'Stop generating' : 'Send message'}
        >
          {isStreaming ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          )}
        </button>
      </div>
      <p className="mt-2 text-center text-xs text-slate-400 dark:text-slate-500">
        Press Enter to send, Shift+Enter for a new line
      </p>
    </div>
  )
}
