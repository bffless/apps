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
visible only to its creator and project admins until a [[Grant]] is added. A folder is made public by
granting [[Anyone]] `View` — publicness is a grant, not a mode. See `docs/adr/`.

**Principal**:
An entity a [[Grant]] is given to: an individual BFFless user, a BFFless user group, [[Anyone]], or —
for no-account access to a private folder — a [[Share Link]].
_Avoid_: Subject, role, account

**Anyone**:
The anonymous-public [[Principal]] — every visitor, signed in or not. Granting `(Anyone, View)` on a
[[Folder]] is what "making it public" means; there is no separate visibility flag. Capped at `View`
(never `Edit`). It inherits and is cut off by `Restricted` exactly like any other [[Grant]]. Unlike a
[[Share Link]] it needs no token and never expires — the folder is browsable at its plain URL.
_Avoid_: Everyone, world, guest, public flag, visibility setting

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

## Comments

**Comment**:
A single user-authored entry attached to a [[File]] or [[Site]] node: either the root of a
[[Thread]] (carries an [[Anchor]]) or a reply to one (carries no anchor of its own). Anyone with at
least `View` access to the node — signed in, or via a valid [[Share Link]] cookie — can read it;
writing (create, reply, react, [[Resolve]]) additionally requires a BFFless session, and only the
author may edit or delete their own comment's body.
_Avoid_: annotation, note, feedback

**Thread**:
A root [[Comment]] and its replies, flat — replies point back to the root, never to each other. The
root carries the [[Anchor]]; a thread is [[Resolve]]d or reopened as a unit, on the root.
_Avoid_: conversation, discussion

**Anchor**:
The position in a document a [[Thread]]'s root [[Comment]] refers to: a text quote (with
surrounding prefix/suffix for disambiguation) for Markdown/[[Site]] content, or an `(x, y)` pin
fraction for an image [[File]]. Anchors are re-resolved client-side against the live content on
every load — fuzzy-matched if the exact quote moved — and are never rewritten in storage; a thread
whose anchor no longer resolves surfaces separately instead of disappearing. See `docs/adr/0010`.
_Avoid_: highlight, selection (the runtime rendering of an anchor, not the stored anchor itself)

**Resolve**:
Marking a [[Thread]] closed — hidden from the default view behind a "show resolved" toggle, but not
deleted. Any commenter with access to the thread can resolve or reopen it (unlike editing a
[[Comment]]'s body, this is not author-restricted); the action is audited (who, when).
_Avoid_: close, archive, delete

## Feeds

**Feed**:
A read-only, reverse-chronological RSS rendering of a [[Folder]] for feed readers. Every [[File]] and
[[Site]] anywhere in the folder's subtree becomes one linear item ordered by upload time — it is
deliberately *not* a tree. Sharing a new file into the folder makes it appear as a new item in
subscribers' readers. A feed is governed by the **same [[Grant]]s as its folder**: a public folder
([[Anyone]]) has an open feed at a plain URL; a private folder's feed is reached through a
[[Share Link]] token, so each share link is independently renderable as a feed and no reader ever
needs an account. Feeds carry no access logic of their own — they run the folder's ACL and nothing
more.
_Avoid_: RSS reader (that's the *consumer* — a separate app, Rivulet), stream, timeline, river

**Feed Item**:
One item in a [[Feed]]: a single leaf [[File]] or [[Site]] — one leaf node makes exactly one item,
never a [[Folder]], never a [[Site]]'s internal assets (those have no node records, so a Site is
always one item). Dated by the leaf's upload time (what makes a newly-shared file a *new* item) and
carrying its path within the folder. A [[File]] item attaches its raw content so readers preview it
inline; a [[Site]] item is a single link into Handoff's viewer.
_Avoid_: Post, article, node (a node is the tree record; the item is its feed projection)

**Feed-excluded**:
A per-[[Folder]] flag (default off) that keeps a folder's whole subtree out of *every* [[Feed]]: its
leaves produce no [[Feed Item]]s. Purely a surfacing control, **orthogonal to access** — an excluded
folder stays fully browsable and its files openable; it is neither private nor [[Restricted]]. Used
e.g. to keep a markdown post's `assets/` images from surfacing as their own items.
_Avoid_: Private, hidden, unlisted, restricted, muted (each implies an access or listing change)

**Title**:
An optional display-title override on a [[File]] or [[Site]]. Additive — the filename stays
the leaf's identity (path, listings, name-uniqueness); the title only replaces the viewer
heading and the [[Feed Item]] `<title>`, falling back to the filename when unset.
_Avoid_: Name, rename, label

**Description**:
An optional plain-text, multi-line note on a [[File]] or [[Site]], surfaced as the
[[Feed Item]] `<description>` body (above the inline image for an image [[File]]). Additive
metadata; escaped into the feed, never executed.
_Avoid_: Caption, summary, body (in access/structural contexts)
