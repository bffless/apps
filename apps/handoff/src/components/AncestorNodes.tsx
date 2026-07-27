/**
 * AncestorNodes — renderless ancestor-chain resolver. Starting from `folderId`,
 * fetches each node and walks `parentId` upward until 'root', reporting the
 * accumulated node map and whether the walk has reached the root (`complete`)
 * via `onUpdate`. Extracted verbatim from FolderView (where it drives the
 * breadcrumb AND ACL eval) so the file viewer can resolve the same chain for
 * its effective-visibility badge and ShareDialog `parentChain` (#253/#254).
 *
 * Note: the map is first-write-wins (`if (prev[node.id]) return prev`) — a
 * later refetch of an already-resolved node never replaces its cached entry.
 * Hosts that show live-mutable state for the chain TAIL must swap in their own
 * live node query for it (see FolderView's `liveFolderChain`).
 *
 * Key the component by `folderId` so navigation restarts the walk.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useGetNodeQuery } from '../store/handoffApi'
import type { HandoffNode } from '../lib/nodes'

function AncestorNodeResolver({
  folderId,
  onResolved,
}: {
  folderId: string
  onResolved: (node: HandoffNode) => void
}) {
  const { data: node } = useGetNodeQuery(folderId, { skip: folderId === 'root' })
  useEffect(() => {
    if (node) onResolved(node)
  }, [node, onResolved])
  return null
}

export function AncestorNodes({
  folderId,
  onUpdate,
}: {
  folderId: string
  onUpdate: (nodesById: Record<string, HandoffNode>, complete: boolean) => void
}) {
  const [nodesById, setNodesById] = useState<Record<string, HandoffNode>>({})
  const [toResolve, setToResolve] = useState<string[]>(folderId !== 'root' ? [folderId] : [])
  const visitedRef = useRef<Set<string>>(new Set(folderId !== 'root' ? [folderId] : []))

  const handleResolved = useCallback((node: HandoffNode) => {
    setNodesById((prev) => {
      if (prev[node.id]) return prev
      const next = { ...prev, [node.id]: node }
      if (node.parentId !== 'root' && !visitedRef.current.has(node.parentId)) {
        visitedRef.current.add(node.parentId)
        setToResolve((q) => [...q, node.parentId])
      }
      return next
    })
  }, [])

  const complete =
    folderId === 'root' ||
    (() => {
      let cur = folderId
      let hops = 0
      while (cur !== 'root' && hops < 64) {
        const n = nodesById[cur]
        if (!n) return false
        cur = n.parentId
        hops++
      }
      return cur === 'root'
    })()

  useEffect(() => {
    onUpdate(nodesById, complete)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesById, complete])

  return (
    <>
      {toResolve.map((id) => (
        <AncestorNodeResolver key={id} folderId={id} onResolved={handleResolved} />
      ))}
    </>
  )
}
