/**
 * "Nothing here, and here is why" (08 treats these as first-class): the shared
 * block behind the no-implementations screen and the card of an implementation
 * whose publish could not be read.
 */
import type { ReactNode } from 'react'

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  )
}
