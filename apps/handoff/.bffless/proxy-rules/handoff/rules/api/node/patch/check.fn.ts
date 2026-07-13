import type { HandlerContext } from 'bffless/handlers';

/** What `pre` normalized out of the PATCH body plus the caller's identity. */
interface PreStep {
  id?: string;
  mode?: string;
  hasMode?: boolean;
  hasFeedExcluded?: boolean;
  feedExcluded?: boolean;
  valid?: boolean;
  isAdmin?: boolean;
  uid?: string | null;
}

/** The target row from the `folder` data_query step — null when `pre.valid` was false. */
interface FolderRow {
  nodeType?: string;
  ownerId?: string | null;
}

interface Steps {
  pre?: PreStep;
  folder?: FolderRow | null;
}

export default function handler({ steps }: HandlerContext) {
  const s = steps as Steps;
  const pre: PreStep = s.pre || {};
  const f: FolderRow | null = s.folder || null;

  const isFolder = !!f && f.nodeType === 'folder';
  const isOwner = !!pre.uid && !!f && f.ownerId === pre.uid;
  const bad = pre.valid !== true || !isFolder;
  const allowed = !bad && (pre.isAdmin === true || isOwner);

  return {
    allowed: allowed,
    badRequest: bad,
    denied: !allowed && !bad,
    saveMode: allowed && pre.hasMode === true,
    saveFeedExcluded: allowed && pre.hasFeedExcluded === true,
  };
}
