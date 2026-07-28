/**
 * One thread in the comment gutter: the root comment, its replies, and every
 * affordance that acts on them (react, reply, resolve, edit, delete).
 *
 * Writes go straight through the RTK comment mutations — `patchComment` is
 * optimistic, so a reaction or a resolve lands instantly and rolls itself back
 * if the server says no. The optimistic react toggle needs the *real* session
 * user id (it is what the server keys the emoji bucket by), so every react
 * passes `userId` from `useSession()` and is disabled until the session
 * resolves — guessing here would desync the bucket on rollback.
 *
 * Card chrome (border/background/ring) lives here rather than on the gutter's
 * positioned wrapper, so the same component renders identically in the
 * absolutely-positioned canvas and in the flow-layout "Unanchored" list.
 */
import { useState } from 'react'
import type { CommentThread, HandoffComment } from '../../lib/comments'
import {
  usePatchCommentMutation,
  useDeleteCommentMutation,
  useAddCommentMutation,
} from '../../store/handoffApi'
import { useSession } from '../../lib/session'
import { toast } from '../../lib/toast'
import { Menu } from '../Menu'
import { CommentComposer } from './CommentComposer'

/** Offered in the "+" reaction picker. Existing reactions show regardless. */
const REACTION_PALETTE = ['👍', '❤️', '🎉', '🚀', '👀', '😕']

/**
 * Coarse relative time ("just now" … "3 mo ago"). Deliberately a handful of
 * lines rather than a date library — the gutter is the only consumer and the
 * app ships no i18n runtime to plug a formatter into.
 */
function timeAgo(ms: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - ms) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

export interface CommentCardProps {
  thread: CommentThread
  active: boolean
  canWrite: boolean
  onActivate: () => void
  nodeId: string
}

export function CommentCard({ thread, active, canWrite, onActivate, nodeId }: CommentCardProps) {
  const { root, replies } = thread
  const { session } = useSession()
  const userId = session?.authenticated ? session.user.id : null

  const [patchComment] = usePatchCommentMutation()
  const [addComment, { isLoading: replying }] = useAddCommentMutation()

  async function toggleResolved() {
    try {
      await patchComment({
        id: root.id,
        nodeId,
        op: root.resolved ? 'reopen' : 'resolve',
      }).unwrap()
    } catch {
      toast('Couldn’t update the thread. Please try again.', 'error')
    }
  }

  async function postReply(body: string) {
    try {
      await addComment({ nodeId, body, parentId: root.id }).unwrap()
    } catch {
      toast('Couldn’t post the reply. Please try again.', 'error')
    }
  }

  return (
    /* The whole card is the activation target — clicking anywhere in a thread
       is how a reader "selects" it (and scrolls its highlight into view). It is
       not itself focusable: every actionable control inside is a real button,
       and keyboard users reach the thread through those. */
    <div
      data-comment-id={root.id}
      onClick={onActivate}
      className={[
        'rounded-xl border bg-surface p-3 text-left shadow-sm transition-colors',
        active ? 'border-accent-600 ring-1 ring-accent-600' : 'border-border',
        root.resolved ? 'opacity-70' : '',
      ].join(' ')}
    >
      <CommentBody
        comment={root}
        nodeId={nodeId}
        canWrite={canWrite}
        userId={userId}
        trailing={
          canWrite && (
            <button
              type="button"
              onClick={toggleResolved}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {root.resolved ? 'Re-open' : 'Resolve'}
            </button>
          )
        }
      />

      {replies.length > 0 && (
        <ul className="mt-3 space-y-3 border-l border-border pl-3">
          {replies.map((reply) => (
            <li key={reply.id}>
              <CommentBody comment={reply} nodeId={nodeId} canWrite={canWrite} userId={userId} />
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <CommentComposer
          onSubmit={postReply}
          busy={replying}
          placeholder="Reply…"
          submitLabel="Reply"
        />
      )}
    </div>
  )
}

/**
 * A single comment (root or reply): header, body — or the husk placeholder for
 * a soft-deleted root — the reaction row, and the author-only ⋯ menu.
 */
function CommentBody({
  comment,
  nodeId,
  canWrite,
  userId,
  trailing,
}: {
  comment: HandoffComment
  nodeId: string
  canWrite: boolean
  userId: string | null
  trailing?: React.ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [patchComment, { isLoading: patching }] = usePatchCommentMutation()
  const [deleteComment] = useDeleteCommentMutation()
  const isAuthor = !!userId && userId === comment.authorId

  async function saveEdit(body: string) {
    try {
      await patchComment({ id: comment.id, nodeId, op: 'edit', body }).unwrap()
      setEditing(false)
    } catch {
      toast('Couldn’t save the edit. Please try again.', 'error')
    }
  }

  async function remove() {
    try {
      await deleteComment({ id: comment.id, nodeId }).unwrap()
    } catch {
      toast('Couldn’t delete the comment. Please try again.', 'error')
    }
  }

  async function toggleReaction(emoji: string) {
    if (!userId) return
    try {
      await patchComment({ id: comment.id, nodeId, op: 'react', emoji, userId }).unwrap()
    } catch {
      toast('Couldn’t update the reaction. Please try again.', 'error')
    }
  }

  return (
    <div>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-ink">
            {comment.authorName || 'Someone'}
          </p>
          <p className="text-xs text-muted">
            {timeAgo(comment.createdMs)}
            {comment.updatedMs !== null && !comment.deleted && ' (edited)'}
          </p>
        </div>
        {trailing}
        {!comment.deleted && isAuthor && canWrite && (
          <Menu
            label="Comment actions"
            items={[
              { label: 'Edit', onSelect: () => setEditing(true) },
              { label: 'Delete', onSelect: remove, danger: true },
            ]}
            trigger={({ ref, onClick, onKeyDown, ...aria }) => (
              <button
                type="button"
                ref={ref as React.Ref<HTMLButtonElement>}
                onClick={onClick}
                onKeyDown={onKeyDown}
                {...aria}
                aria-label="Comment actions"
                className="shrink-0 rounded-md px-1.5 py-0.5 text-sm leading-none text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                ⋯
              </button>
            )}
          />
        )}
      </div>

      {comment.deleted ? (
        <p className="mt-1.5 text-sm italic text-muted">Comment deleted</p>
      ) : editing ? (
        <CommentComposer
          onSubmit={saveEdit}
          busy={patching}
          placeholder="Edit comment…"
          submitLabel="Save"
          initialValue={comment.body}
          onCancel={() => setEditing(false)}
          autoFocus
        />
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-ink">{comment.body}</p>
      )}

      {!comment.deleted && (
        <ReactionRow
          reactions={comment.reactions}
          userId={userId}
          canWrite={canWrite}
          onToggle={toggleReaction}
        />
      )}
    </div>
  )
}

/**
 * Existing reactions as toggle chips (mine are accent-tinted), plus a "+"
 * picker for the fixed palette. Read-only visitors see the counts but get no
 * picker and no toggles.
 */
function ReactionRow({
  reactions,
  userId,
  canWrite,
  onToggle,
}: {
  reactions: Record<string, string[]>
  userId: string | null
  canWrite: boolean
  onToggle: (emoji: string) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const entries = Object.entries(reactions).filter(([, ids]) => ids.length > 0)
  if (!entries.length && !canWrite) return null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {entries.map(([emoji, ids]) => {
        const mine = !!userId && ids.includes(userId)
        return (
          <button
            key={emoji}
            type="button"
            disabled={!canWrite || !userId}
            aria-pressed={mine}
            aria-label={`${emoji} ${ids.length}`}
            onClick={() => onToggle(emoji)}
            className={[
              'rounded-full border px-1.5 py-0.5 text-xs transition-colors disabled:cursor-default',
              mine ? 'border-accent-600 bg-accent-bg text-ink' : 'border-border text-muted',
            ].join(' ')}
          >
            <span aria-hidden="true">{emoji}</span> {ids.length}
          </button>
        )
      })}
      {canWrite && (
        <span className="relative">
          <button
            type="button"
            disabled={!userId}
            aria-label="Add reaction"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((v) => !v)}
            className="rounded-full border border-border px-1.5 py-0.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
          >
            +
          </button>
          {pickerOpen && (
            <span
              role="group"
              aria-label="Pick a reaction"
              className="absolute bottom-full left-0 z-10 mb-1 flex gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-md"
            >
              {REACTION_PALETTE.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  onClick={() => {
                    setPickerOpen(false)
                    onToggle(emoji)
                  }}
                  className="rounded px-1 py-0.5 text-sm transition-colors hover:bg-surface-2"
                >
                  {emoji}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
    </div>
  )
}
