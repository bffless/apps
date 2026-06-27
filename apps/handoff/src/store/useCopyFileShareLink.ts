/**
 * One-click "copy a file-direct share link". Reuses the first active folder
 * token (mints one only if none exists) and writes /r/{nodeId}?token= to the
 * clipboard. State is keyed by nodeId so multiple rows track independently.
 */
import { useCallback, useState } from 'react'
import { useMintShareLinkMutation } from './handoffApi'
import type { ShareLink } from './handoffApi'
import { pickReusableToken, shareLinkCopyUrl } from '../lib/share'
import { toast } from '../lib/toast'

export function useCopyFileShareLink(folderId: string, links: ShareLink[] | undefined) {
  const [mint] = useMintShareLinkMutation()
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorId, setErrorId] = useState<string | null>(null)

  const copyLink = useCallback(
    async (nodeId: string, fileName?: string) => {
      setErrorId(null)
      setCopiedId(null)
      setBusyId(nodeId)
      try {
        let token = pickReusableToken(links, Date.now())?.token
        if (!token) {
          const res = await mint({ folderId })
          if ('error' in res) throw new Error('mint failed')
          token = res.data.token
        }
        const url = shareLinkCopyUrl(window.location.origin, { token, url: `/s/${token}` }, nodeId, fileName)
        await navigator.clipboard.writeText(url)
        setBusyId(null)
        setCopiedId(nodeId)
        toast('Link copied to clipboard')
        setTimeout(() => setCopiedId((c) => (c === nodeId ? null : c)), 2000)
      } catch {
        setBusyId(null)
        setErrorId(nodeId)
        toast('Couldn’t copy link', 'error')
        setTimeout(() => setErrorId((e) => (e === nodeId ? null : e)), 3000)
      }
    },
    [folderId, links, mint],
  )

  return { copyLink, copiedId, busyId, errorId }
}
