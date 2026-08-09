/**
 * Shared types for the chat tab (Task 10, ported from the chat-pipelines demo's
 * `ChatPopup` — see `ChatTab.tsx` for what was kept vs. adapted).
 *
 * `BackendMessage` is the shape `GET /api/chat` returns for one row: the
 * `data_query` step's default output spreads the schema's own fields
 * (`conversation_id`, `role`, `content`) plus the record's `id`/`createdAt`/
 * `updatedAt` — camelCase, per the backend's `data_query` handler (which
 * always emits `createdAt`/`updatedAt`, never a snake_case variant). The
 * source repo's popup variant assumed `created_at`/`updated_at` here, which
 * doesn't match the actual handler output; fixed during the Task 10 GET-rule
 * follow-up.
 */
export interface BackendMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  conversation_id?: string
  createdAt?: string
  updatedAt?: string
}

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'

export interface SuggestionItem {
  label: string
  prompt: string
}
