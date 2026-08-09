/**
 * Shared types for the chat tab (Task 10, ported from the chat-pipelines demo's
 * `ChatPopup` — see `ChatTab.tsx` for what was kept vs. adapted).
 */

export interface BackendMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  conversation_id?: string
  created_at?: string
  updated_at?: string
}

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'

export interface SuggestionItem {
  label: string
  prompt: string
}
