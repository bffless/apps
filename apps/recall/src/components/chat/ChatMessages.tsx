/**
 * Message list for the chat tab (Task 10). Ported from the chat-pipelines
 * demo's `ChatPopup/ChatMessages.tsx` (Tailwind, dark-mode aware, matches
 * Recall's existing design system) with one addition: the markdown `a`
 * renderer is `CitationChip` instead of a plain anchor, so a citation the
 * assistant writes (per the chat rule's system prompt) becomes a clickable
 * chip that seeks the shared player rather than a link that navigates away.
 */

import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { UIMessage } from '@ai-sdk/react'
import { CitationChip, type SeekTarget } from '../CitationChip'
import type { ChatStatus, SuggestionItem } from './types'

interface ChatMessagesProps {
  messages: UIMessage[]
  status: ChatStatus
  suggestions: SuggestionItem[]
  onSuggestionClick: (prompt: string) => void
  onSeek: (target: SeekTarget) => void
}

function getMessageText(message: UIMessage): string {
  if (!message.parts || message.parts.length === 0) return ''
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

function EmptyState({
  suggestions,
  onSuggestionClick,
}: {
  suggestions: SuggestionItem[]
  onSuggestionClick: (prompt: string) => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-10 text-center">
      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        Ask about the video library
      </h3>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Answers cite the exact moment they came from.
      </p>
      <div className="mt-6 w-full max-w-md space-y-2">
        {suggestions.map((s) => (
          <button
            key={s.prompt}
            type="button"
            onClick={() => onSuggestionClick(s.prompt)}
            className="w-full rounded-lg border border-slate-200 bg-white px-4 py-3 text-left text-sm text-slate-700 transition-colors hover:border-blue-300 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-blue-500 dark:hover:bg-slate-700"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ChatMessages({ messages, status, suggestions, onSuggestionClick, onSeek }: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (messages.length === 0) {
    return <EmptyState suggestions={suggestions} onSuggestionClick={onSuggestionClick} />
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      {messages.map((message) => {
        const text = getMessageText(message)
        const isUser = message.role === 'user'

        return (
          <div key={message.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2 ${
                isUser
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
              }`}
            >
              {isUser ? (
                <p className="text-sm whitespace-pre-wrap">{text}</p>
              ) : (
                <div className="prose prose-sm prose-slate dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-slate-800 [&_pre]:p-2 [&_pre]:text-xs [&_pre]:text-slate-100 [&_code]:text-xs">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children }) => (
                        <CitationChip href={href} onSeek={onSeek}>
                          {children}
                        </CitationChip>
                      ),
                    }}
                  >
                    {text}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        )
      })}
      {status === 'streaming' && messages[messages.length - 1]?.role === 'user' && (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-2xl bg-slate-100 px-4 py-2 dark:bg-slate-800">
            <div className="flex gap-1">
              <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400" />
            </div>
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  )
}
