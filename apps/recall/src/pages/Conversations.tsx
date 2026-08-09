/**
 * Admin Conversations viewer (Task 11, read-only): a two-pane layout —
 * every `recall_conversations` row on the left (newest-first), and the
 * picked conversation's message thread on the right (oldest-first, role-
 * labeled bubbles), via `GET /api/messages`. There's no edit/delete here on
 * purpose; this is an inspection tool for what the public chat has been
 * asked, not a moderation surface.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useGetMessagesQuery,
  useListConversationsQuery,
  type ConversationMeta,
} from '../store/conversationsApi'

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (isNaN(t)) return '—'
  return new Date(t).toLocaleString()
}

function ConversationRow({
  conversation,
  selected,
  onSelect,
}: {
  conversation: ConversationMeta
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className={
        'flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors ' +
        (selected
          ? 'border-blue-400 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/40'
          : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-800')
      }
    >
      <span className="truncate font-medium text-slate-900 dark:text-slate-100">
        {conversation.title || 'Untitled conversation'}
      </span>
      <span className="text-xs text-slate-500 dark:text-slate-400">
        {conversation.message_count} message{conversation.message_count === 1 ? '' : 's'} ·{' '}
        {formatDate(conversation.createdAt)}
      </span>
    </button>
  )
}

function MessageThread({ conversationId }: { conversationId: string }) {
  const { data, isLoading, isError } = useGetMessagesQuery(conversationId)
  const messages = data?.messages ?? []

  if (isLoading) {
    return <p className="text-slate-500 dark:text-slate-400">Loading…</p>
  }

  if (isError) {
    return (
      <p className="text-red-600 dark:text-red-400">Couldn't load this conversation. Try again.</p>
    )
  }

  if (messages.length === 0) {
    return <p className="text-slate-500 dark:text-slate-400">No messages in this conversation.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      {messages.map((m) => (
        <div
          key={m.id}
          className={
            'max-w-[85%] rounded-lg px-3 py-2 text-sm ' +
            (m.role === 'user'
              ? 'self-end bg-blue-600 text-white'
              : 'self-start bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100')
          }
        >
          <div className="mb-1 text-xs font-medium opacity-70">{m.role}</div>
          <div className="whitespace-pre-wrap">{m.content}</div>
        </div>
      ))}
    </div>
  )
}

export function Conversations() {
  const { data, isLoading, isError } = useListConversationsQuery()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const conversations = data?.conversations ?? []

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Conversations
        </h1>
        <Link
          to="/admin"
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          ← Videos
        </Link>
      </div>

      {isLoading && <p className="text-slate-500 dark:text-slate-400">Loading…</p>}
      {isError && (
        <p className="text-red-600 dark:text-red-400">Couldn't load conversations. Try refreshing.</p>
      )}

      {!isLoading && !isError && conversations.length === 0 && (
        <p className="text-slate-500 dark:text-slate-400">No conversations yet.</p>
      )}

      {conversations.length > 0 && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-[280px_1fr]">
          <div className="flex flex-col gap-1">
            {conversations.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                selected={c.id === selectedId}
                onSelect={() => setSelectedId(c.id)}
              />
            ))}
          </div>

          <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
            {selectedId ? (
              <MessageThread key={selectedId} conversationId={selectedId} />
            ) : (
              <p className="text-slate-500 dark:text-slate-400">
                Pick a conversation to view its messages.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
