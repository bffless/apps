# Handoff

An internal content-sharing app built on BFFless. A user uploads docs, prototypes, and HTML,
organizes them into folders, controls who can see each folder, and hands them off to their team —
served back so HTML renders live, not just downloads. Not version-controlled; a simple way to share
content with teams without git/GitHub.

## Language

**Handoff**:
The app itself, and the act of sharing content with a team or recipient.
_Avoid_: Dropbox, locker, file store

**Folder**:
An organizational container in an arbitrary-depth tree, and the only browsable *branch*. Holds
sub-folders, Files, and Sites. The unit that permissions are attached to.
_Avoid_: Directory, space, bucket

**File**:
A single uploaded file (PDF, image, document, video) that is viewed or downloaded directly — a
self-contained *leaf*.
_Avoid_: Asset, object, attachment

**Site**:
A multi-file HTML bundle, stored as one opaque *leaf* — viewers open it and see the rendered
[[Entry]] in an iframe; they do not browse its internal files. Relative paths are preserved so it
renders live.
_Avoid_: Deployment, app, page, bundle (in user-facing copy)

**Entry**:
The file inside a [[Site]] that the iframe loads — `index.html` by default, or one the uploader picks
when it's missing/ambiguous.
_Avoid_: Index, main, root file

## Access

Folder-level permissions are an app-level concept Handoff owns. BFFless's built-in roles are
project-wide only (no per-folder permission), so Handoff maintains its own access list per [[Folder]]
keyed off the BFFless-authenticated identity. Content is **private by default**: a new folder is
visible only to its creator and project admins until a [[Grant]] is added. See `docs/adr/`.

**Principal**:
An entity a [[Grant]] is given to: an individual BFFless user, a BFFless user group, or — for
no-account access — a [[Share Link]].
_Avoid_: Subject, role, account

**Grant**:
A single access entry on a folder: a [[Principal]] paired with an access level (`View` or `Edit`).
_Avoid_: Permission, ACL entry, rule

**View / Edit / Owner**:
The access levels. `View` = browse the folder and open/download Files / render Sites. `Edit` = also
upload, create sub-folders, rename, delete within the folder. `Owner` (the folder's creator plus
project admins — never granted) = also change the folder's permissions and delete it.
_Avoid_: Read/write, Viewer/Contributor (those are BFFless's project roles, a different thing)

**Share Link**:
An app-managed, **folder-scoped** token that grants `View` access to one folder (and its contents)
without a BFFless account, with optional expiry and revocation. Distinct from BFFless's native
share-links, which are project/domain-wide and therefore too coarse here.
_Avoid_: Public link, URL, invite

**Inheriting / Restricted**:
A folder's inheritance mode. `Inheriting` (default) takes all parent [[Grant]]s and may add more.
`Restricted` ignores inherited grants and uses only its own (Owner/admins always retain access). One
bit per folder; there are no negative/deny grants.
_Avoid_: Private/public, break-inheritance
