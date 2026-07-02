import { Fragment, type ReactNode } from 'react'
import type { BlogImageRef } from '../../lib/blog'
import { BlogFigure } from './BlogFigure'

/** The optional wiring that turns a figure into a re-framable one (issue #91):
 *  the post's frame sidecar (URL → captured second) plus the capture/reframe
 *  handlers. When absent — tests, the bundle, any read-only use — the preview
 *  stays exactly the plain read-only renderer it has always been. */
type Editing = {
  frames?: BlogImageRef[]
  onCaptureSiblings: (time: number) => Promise<{ time: number; thumb: string }[]>
  onReframe: (oldUrl: string, time: number) => Promise<boolean>
}

/**
 * A small READ-ONLY Markdown preview (issue #68). Studio carries no Markdown
 * dependency, and the blog post is generated text we only ever display — never
 * edit — so a focused block renderer is enough: YAML front-matter (shown as a
 * title/description header), ATX headings, unordered lists, blockquotes, and
 * paragraphs, with inline `**bold**`, `*italic*`, and `` `code` ``. Anything it
 * doesn't recognize falls through as plain text, so a post always renders
 * SOMETHING rather than breaking. Not a prose editor — there is no text-editing
 * affordance.
 *
 * Standalone Markdown image lines (`![caption](url)`) — the inline frames the blog
 * pipeline captures and uploads (issue #70) — render as a figure with the caption
 * shown visibly in italics beneath the image (alt text + a caption line). Same-
 * origin `/api/uploads/...` frames carry the auth cookie, so they load in-app.
 * When the optional editing wiring is supplied AND an image is in the frame
 * sidecar, that figure also gets a "Change frame" control to nudge it to a nearby
 * moment (issue #91); every other image stays a plain read-only figure.
 */
export function MarkdownPreview({
  markdown,
  frames,
  onCaptureSiblings,
  onReframe,
}: {
  markdown: string
  frames?: BlogImageRef[]
  onCaptureSiblings?: (time: number) => Promise<{ time: number; thumb: string }[]>
  onReframe?: (oldUrl: string, time: number) => Promise<boolean>
}) {
  const { front, body } = splitFrontMatter(markdown)
  const editing: Editing | null =
    onCaptureSiblings && onReframe ? { frames, onCaptureSiblings, onReframe } : null
  return (
    <div className="prose-paper flex flex-col gap-3 text-[14px] leading-relaxed text-ink">
      {front && (front.title || front.description) && (
        <header className="border-b border-paper-line pb-3">
          {front.title && <p className="font-serif text-[20px] leading-tight text-ink">{front.title}</p>}
          {front.description && <p className="mt-1 text-[13px] text-ink-soft">{front.description}</p>}
        </header>
      )}
      {renderBlocks(body, editing)}
    </div>
  )
}

/** Split a leading `--- ... ---` YAML front-matter block (parsed for `title` and
 *  `description`) from the Markdown body. No front-matter → `front` is null. */
function splitFrontMatter(md: string): {
  front: { title: string; description: string } | null
  body: string
} {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md)
  if (!m) return { front: null, body: md }
  const front = { title: '', description: '' }
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim())
    if (kv && (kv[1] === 'title' || kv[1] === 'description')) {
      front[kv[1] as 'title' | 'description'] = kv[2].replace(/^["']|["']$/g, '').trim()
    }
  }
  return { front, body: md.slice(m[0].length) }
}

/** A line that is exactly a Markdown image: `![alt](url)`. */
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)]+)\)$/

/** Render the body as a sequence of blocks split on blank lines. */
function renderBlocks(body: string, editing: Editing | null): ReactNode[] {
  const timeByUrl = new Map((editing?.frames ?? []).map((f) => [f.url, f.time]))
  const blocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  return blocks.map((block, i) => {
    const lines = block.split('\n')

    // A block of standalone image lines → one figure each, caption shown in italics.
    // An image the frame sidecar knows the timestamp of gets the re-frame control.
    if (lines.every((l) => IMAGE_LINE.test(l.trim()))) {
      return (
        <div key={i} className="flex flex-col gap-3">
          {lines.map((l, j) => {
            const m = IMAGE_LINE.exec(l.trim())
            const alt = m?.[1].trim() ?? ''
            const src = m?.[2] ?? ''
            const time = editing ? timeByUrl.get(src) : undefined
            if (editing && time !== undefined) {
              return (
                <BlogFigure
                  key={j}
                  src={src}
                  alt={alt}
                  time={time}
                  capture={editing.onCaptureSiblings}
                  reframe={editing.onReframe}
                />
              )
            }
            return (
              <figure key={j} className="flex flex-col gap-1">
                <img src={src} alt={alt} className="rounded-md border border-paper-line" />
                {alt && <figcaption className="text-[12.5px] text-ink-soft italic">{alt}</figcaption>}
              </figure>
            )
          })}
        </div>
      )
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0])
    if (heading && lines.length === 1) {
      const level = heading[1].length
      const cls = level <= 1 ? 'font-serif text-[18px]' : 'font-serif text-[15px]'
      return (
        <p key={i} className={`${cls} font-semibold text-ink`}>
          {renderInline(heading[2])}
        </p>
      )
    }

    if (lines.every((l) => /^[-*]\s+/.test(l))) {
      return (
        <ul key={i} className="list-disc pl-5">
          {lines.map((l, j) => (
            <li key={j}>{renderInline(l.replace(/^[-*]\s+/, ''))}</li>
          ))}
        </ul>
      )
    }

    if (lines.every((l) => /^>\s?/.test(l))) {
      return (
        <blockquote key={i} className="border-l-2 border-paper-line pl-3 text-ink-soft italic">
          {renderInline(lines.map((l) => l.replace(/^>\s?/, '')).join(' '))}
        </blockquote>
      )
    }

    return <p key={i}>{renderInline(lines.join(' '))}</p>
  })
}

/** Render inline `**bold**`, `*italic*` / `_italic_`, and `` `code` `` spans. */
function renderInline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g).filter((s) => s !== '')
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`'))
      return (
        <code key={i} className="rounded bg-paper-deep/30 px-1 font-mono text-[12.5px]">
          {part.slice(1, -1)}
        </code>
      )
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_')))
      return <em key={i}>{part.slice(1, -1)}</em>
    return <Fragment key={i}>{part}</Fragment>
  })
}
