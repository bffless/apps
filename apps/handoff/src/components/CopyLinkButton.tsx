/**
 * CopyLinkButton — small status-aware button. preventDefault/stopPropagation so
 * it works inside clickable row links without triggering navigation.
 */
export type CopyStatus = 'idle' | 'busy' | 'copied' | 'error'

interface CopyLinkButtonProps {
  status: CopyStatus
  onClick: () => void
  label?: string
  className?: string
}

export function CopyLinkButton({ status, onClick, label = 'Copy link', className }: CopyLinkButtonProps) {
  const text =
    status === 'copied' ? 'Copied!' : status === 'busy' ? 'Copying…' : status === 'error' ? 'Failed' : label
  return (
    <button
      type="button"
      aria-live="polite"
      disabled={status === 'busy'}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClick()
      }}
      className={
        className ??
        'shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-900 disabled:opacity-50'
      }
    >
      {text}
    </button>
  )
}
