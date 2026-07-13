/**
 * Share-link gate for `/r/<path>?token=…` — the cookie-free read path for private content.
 *
 * This does NOT use the grant ACL. A share link is its own authority: it is valid only while
 * the link record is live (not revoked, not expired), the target is a real file with a storage
 * path, and that file sits at or below the folder the link was issued for — i.e. the link's
 * folder must appear in the file's ancestor chain. Anything else denies.
 *
 * `storagePath` is emitted only when allowed, so a later step can't accidentally serve it.
 */
import type { HandlerContext } from 'bffless/handlers';
import { folderChain, type NodeRow } from '../../../../_shared/acl';

/** The `handoff_share_links` record the token resolved to. */
interface ShareLink {
  folderId?: string | null;
  revoked?: unknown;
  expiresMs?: unknown;
  [key: string]: unknown;
}

interface CheckSteps {
  link?: ShareLink | null;
  node?: NodeRow | null;
  folders?: unknown;
}

export default function handler({ steps }: HandlerContext) {
  const s = (steps || {}) as CheckSteps;

  let link: ShareLink = (s.link || {}) as ShareLink;
  if (link == null || typeof link !== 'object') link = {};
  const folderId = (link.folderId || null) as string | null;
  const revoked = link.revoked === true || link.revoked === 'true';
  const exp = link.expiresMs != null ? Number(link.expiresMs) : null;
  const expired = exp != null && !isNaN(exp) ? Date.now() > exp : false;
  const tokenOk = !!folderId && !revoked && !expired;

  let node: NodeRow = (s.node || {}) as NodeRow;
  if (node == null || typeof node !== 'object') node = {} as NodeRow;
  const storagePath = (node.storage_path || '') as string;
  const isFile = node.nodeType === 'file';
  const nodeOk = isFile && !!storagePath;

  let inFolder = false;
  if (tokenOk && nodeOk) {
    let folders = (s.folders || []) as NodeRow[];
    if (!Array.isArray(folders)) folders = [];
    const ch = folderChain(folders, node.parentId);
    for (const link0 of ch) {
      if (link0.id === folderId) {
        inFolder = true;
        break;
      }
    }
  }

  const allow = tokenOk && nodeOk && inFolder;

  return { allow: allow, deny: !allow, storagePath: allow ? storagePath : '' };
}
