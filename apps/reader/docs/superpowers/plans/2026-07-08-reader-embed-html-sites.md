# Reader inline embed — HTML sites + content gate — plan

**Design:** `../specs/2026-07-08-reader-embed-html-sites-design.md`
**Branch:** `reader-embed-html-sites` (worktree `repos/apps-reader-html-embed`, off `origin/main`)

Ship on one branch. Tasks are ordered so each is independently green (`tsc -b && vite build`, lint,
tests) before the next.

## Task 1 — apps/handoff: `text/html` enclosure for site items

Emit an `<enclosure type="text/html" length="0">` for `it.type === 'site'`, mirroring the file branch.
`<description>` stays so non-embedding readers still show a body.

- **`apps/handoff/src/lib/feed.ts`** — `renderFeedXml` item loop (~L199–222). In the two site branches
  (`else if (note)` and the final `else`), push
  `<enclosure url="${xmlEscape(ctx.origin + blobUrl(it.path) + tokenQs)}" type="text/html" length="0"/>`
  before the `<description>`.
- **`apps/handoff/bffless/handoff.proxy-rules.json`** — byte-port the same change into **both** "Public
  folder RSS feed" handlers (~L2247 root, ~L2343 path). Keep the two JS copies identical.
- **Tests** — `feed.test.ts`: a site leaf (with and without description) now emits the html enclosure;
  a file leaf is unchanged. If a rules-parity test exists, ensure it still passes for both handlers.
- **Verify** — `pnpm --filter handoff test`, lint, `tsc -b && vite build`.

## Task 2 — apps/reader: let `text/html` through the gate

- **`apps/reader/src/lib/embed.ts`** — change `isEmbeddable`'s mime check from
  `item.enclosureType !== 'text/markdown'` to a membership test against
  `EMBEDDABLE_MIMES = new Set(['text/markdown', 'text/html'])`. Trust gate (origin allowlist)
  untouched. `embedUrl` untouched.
- **Tests** — `embed.test.ts`: `text/html` on a trusted origin → true; on an untrusted origin → false;
  markdown still true; unrelated mime → false.
- **Verify** — reader unit tests, lint, build. (No reader-backend rule change: `enrich` already selects
  the first `text/*` enclosure, so `enclosureType='text/html'` already flows to `/api/items`.)

## Task 3 — apps/reader: consent store + hook

- **`apps/reader/src/lib/embedConsent.ts`** (new):
  - `const STORAGE_KEY = 'rivulet.embed.allowedHosts'`
  - `loadAllowedHosts(storage = localStorage): string[]` — JSON-parse tolerant → `[]` on any failure.
  - `persistAllowedHost(host, storage = localStorage): string[]` — add + dedupe + write, return list.
  - `isHostAllowed(host, allowed): boolean`.
  - Module-level `Set<string>` for session show-once: `allowOnce(id)`, `isAllowedOnce(id)`,
    `resetSessionConsent()` (test helper).
- **`useEmbedConsent()`** (in `embedConsent.ts` or `lib/useEmbedConsent.ts`) — `useState` seeded from
  `loadAllowedHosts`; returns `{ isAllowed(host), allowAlways(host), allowOnce(id), isAllowedOnce(id) }`.
  `allowAlways` persists then updates state to re-render.
- **Tests** — `embedConsent.test.ts`: round-trip, dedupe, parse-failure tolerance, `isHostAllowed`,
  session show-once (with `resetSessionConsent`).
- **Verify** — unit tests, lint, build.

## Task 4 — apps/reader: `EmbedConsentGate` + wire into `ReadingPane`

- **`apps/reader/src/components/EmbedConsentGate.tsx`** (new) — placeholder card matching the iframe
  region: icon + "Embedded content from **`<host>`** isn't shown by default." + buttons **Show content**
  (`onShowOnce`), **Always allow `<host>`** (`onAllowAlways`), and an **Open original ↗** link. Themed
  (light/dark) like the surrounding pane.
- **`apps/reader/src/components/ReadingPane.tsx`**:
  - Call `useEmbedConsent()` at the **top** of the component (before the `if (!item)` early return —
    hook-order stability).
  - In the `if (src)` branch: `host = embedHost(item.link)`;
    `open = !!host && (isAllowed(host) || isAllowedOnce(item.id))`.
    **Keyed on origin, never the mime; every embed is gated identically** (markdown included) —
    the mime is feed-supplied and forgeable, so it must not influence the decision (decided).
  - `open` → render today's `<iframe>` (unchanged). Else → render `<EmbedConsentGate>` in the same
    slot, wiring `onShowOnce={() => allowOnce(item.id)}` (local state bump to re-render) and
    `onAllowAlways={() => allowAlways(host)}`.
  - Header + "embedded from `<host>`" bar unchanged.
- **Tests** — `ReadingPane.test.tsx`: any embeddable item + no consent → gate, no iframe **including a
  `text/markdown` item** (mime-bypass regression guard); a **forged** item (`text/markdown` + trusted
  link to a site) is gated identically; after **Show content** → iframe for that item only; a second
  item from the same host still gated until **Always allow**, then auto-loads; untrusted-origin item →
  sanitized-body fallback (existing security assertion holds).

  ⚠️ **This changes #205 behavior:** markdown embeds no longer auto-load — they now require consent
  like every embed. Existing `ReadingPane` tests that assert an immediate markdown iframe must be
  updated to consent first. Flag prominently in the PR.
- **Verify** — reader tests, lint, `tsc -b && vite build`. Optional: `localdev-tools/shot.mjs` against
  `handoff:dev`/`reader` to eyeball the gate.

## Task 5 — round-up

- Full suites: `pnpm --filter reader test`, `pnpm --filter handoff test`, lint + build both.
- If `.claude/skills/**` were touched: `pnpm skills:sync` + commit the `.agents` mirror.
- PR body: describe the feed signal, the `isEmbeddable` extension, and the HTML-only consent gate;
  note that **markdown is unchanged** (still auto-loads) and call out the **post-merge live-rules
  sync** (below).

## Post-merge (human-gated, NOT in the PR)

- **Live `handoff` rule set sync via MCP** — fold the site-enclosure feed change into the shared base
  set and diff-verify. Sandcastle does not deploy live rules. The reader backend needs **no** live
  change (no rule edit in this branch).

## Decisions (locked)

- **Gate scope: all embeds, keyed on the parsed link origin — never the mime.** The `enclosureType`
  mime is feed-supplied and therefore forgeable (a feed can label a JS site `text/markdown` and, under
  a mime-keyed gate, skip consent — the reader iframes the link and Handoff serves the site's JS). So
  the consent decision keys only on `embedHost(item.link)`, which the reader parses itself and cannot
  be spoofed. Markdown is gated too; this **reverts #205's auto-load** for markdown. Implemented as
  `open = isAllowedHost(host) || isAllowedOnce(item.id)` in Task 4. Mime stays as detection-only in
  `isEmbeddable`, never a security signal.
