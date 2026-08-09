/**
 * RTK Query endpoints for the admin Conversations viewer (Task 11,
 * read-only). Split out of `videosApi.ts` since conversations/messages are
 * a distinct feature area from video CRUD — mirrors the existing
 * one-file-per-feature layout (`searchApi.ts`).
 */

import { recallApi } from './recallApi'

/**
 * A `recall_conversations` row's summary, as `GET /api/conversations` shapes it.
 *
 * `chat_id` is the client-generated id `useChat` sends and the id CE's
 * ai_handler chat persistence actually writes onto each `recall_messages`
 * row's `conversation_id` field -- NOT `id` (the record's own UUID). Fetch a
 * conversation's messages by `chat_id`, falling back to `id` only for
 * legacy/malformed rows that somehow lack it.
 */
export type ConversationMeta = {
  id: string
  chat_id: string | null
  title: string | null
  model: string
  message_count: number
  total_tokens: number
  createdAt: string | null
}

/** A `recall_messages` row, as `GET /api/messages` shapes it. */
export type ConversationMessage = {
  id: string
  role: string
  content: string
  createdAt: string | null
}

export const conversationsApi = recallApi.injectEndpoints({
  endpoints: (builder) => ({
    // GET /api/conversations → { conversations: ConversationMeta[] }.
    // Admin-only, newest-first. No tags — this viewer never mutates
    // anything, so there's nothing to invalidate.
    listConversations: builder.query<{ conversations: ConversationMeta[] }, void>({
      query: () => 'api/conversations',
    }),

    // GET /api/messages?conversationId=<id> → { messages: ConversationMessage[] }.
    // Admin-only, oldest-first (a thread reads top-to-bottom).
    getMessages: builder.query<{ messages: ConversationMessage[] }, string>({
      query: (conversationId) => `api/messages?conversationId=${encodeURIComponent(conversationId)}`,
    }),
  }),
})

export const { useListConversationsQuery, useGetMessagesQuery } = conversationsApi
