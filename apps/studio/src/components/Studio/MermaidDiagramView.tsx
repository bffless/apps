import { useEffect, useId, useState, type ComponentType } from 'react'

/**
 * The ```mermaid renderer with the library itself left out (issue #441): everything
 * about rendering a fence — load once, `initialize` once, `render` per diagram, show
 * the source until it lands and keep showing it (with a one-line note) when it
 * can't — lives here, and what `mermaid` IS comes from the `load` the consumer hands
 * `createMermaidDiagram`. Studio's `MermaidDiagram` loads it from the package
 * (`import('mermaid')`); workflow-studio's single-file blog island (a frozen copy in `bffless/workflow-implementations`) loads it at
 * runtime from a pinned CDN URL, because a package import — even a lazy one — would
 * be inlined wholesale into the island's HTML. The two differ ONLY in that loader.
 *
 * This module must stay mermaid-free (no `import('mermaid')`, not even a type import
 * that the bundler could follow): the island imports it.
 */

/** The slice of mermaid's default export the renderer uses. */
export type MermaidLike = {
  initialize(config: { startOnLoad: boolean; securityLevel: 'strict'; theme: 'neutral' }): void
  render(id: string, code: string): Promise<{ svg: string }>
}

export type MermaidLoader = () => Promise<MermaidLike>

/** Tells a failed `load` apart from a failed `render`, so the note can say which. */
class LoadError extends Error {
  readonly inner: unknown
  constructor(inner: unknown) {
    super(inner instanceof Error ? inner.message : String(inner))
    this.inner = inner
  }
}

type State = { code: string } & (
  | { kind: 'ok'; svg: string }
  | { kind: 'error'; stage: 'load' | 'render'; message: string }
)

/**
 * A `diagram` component for `MarkdownBody` over the given loader. `load` runs at most
 * once per successful load (a failed one is forgotten, so the next diagram tries
 * again — the island's CDN fetch can fail on a flaky network and succeed a moment
 * later), and `initialize` — `securityLevel: 'strict'`, so mermaid's own sanitizer
 * stays on the generated markup — runs once per library.
 */
export function createMermaidDiagram(load: MermaidLoader): ComponentType<{ code: string }> {
  let library: Promise<MermaidLike> | null = null
  const mermaid = (): Promise<MermaidLike> => {
    if (!library) {
      library = load()
        .then((m) => {
          m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' })
          return m
        })
        .catch((e: unknown) => {
          library = null
          throw new LoadError(e)
        })
    }
    return library
  }

  function MermaidDiagram({ code }: { code: string }) {
    // Keyed by the code it was rendered from: a stale result for a previous
    // diagram simply reads as "loading" until the new render lands.
    const [result, setResult] = useState<State | null>(null)
    const state = result && result.code === code ? result : null
    const rawId = useId()
    // mermaid uses the id as a DOM/CSS selector; strip the colons React puts in useId.
    const id = `mmd-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`

    useEffect(() => {
      let cancelled = false
      ;(async () => {
        try {
          const { svg } = await (await mermaid()).render(id, code)
          if (!cancelled) setResult({ code, kind: 'ok', svg })
        } catch (e) {
          if (cancelled) return
          const stage = e instanceof LoadError ? 'load' : 'render'
          const cause = e instanceof LoadError ? e.inner : e
          setResult({ code, kind: 'error', stage, message: cause instanceof Error ? cause.message : String(cause) })
        }
      })()
      return () => {
        cancelled = true
      }
    }, [code, id])

    if (state?.kind === 'ok') {
      return (
        <div
          role="img"
          aria-label="Diagram"
          className="mermaid-diagram overflow-x-auto rounded-md border border-line bg-white p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )
    }
    return (
      <div className="flex flex-col gap-1">
        <pre className="overflow-x-auto rounded-md border border-line bg-surface-dim/30 p-3 font-mono text-[12.5px] leading-snug">
          <code>{code}</code>
        </pre>
        {state?.kind === 'error' && (
          <p className="text-[12px] text-ink-soft italic">
            {state.stage === 'load'
              ? 'Diagram renderer could not be loaded — showing its source.'
              : 'Diagram could not be rendered — showing its source.'}{' '}
            ({state.message.split('\n')[0]})
          </p>
        )}
      </div>
    )
  }
  return MermaidDiagram
}
