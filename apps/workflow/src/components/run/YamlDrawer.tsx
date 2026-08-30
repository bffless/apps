/**
 * A step's (or job's) YAML, **in place** on the run page (08, apps#449): the
 * pane head's **YAML** control slides the workflow source over the page,
 * scrolled to the selected block with its lines marked in the gutter — so a
 * person reading a step never has to leave `/runs/<id>` to see what it was
 * declared to do, and on a live run never leaves the page that is driving it.
 *
 * The source is the run's **own snapshot** (`yaml` on the run row / the live
 * slice's `RunMeta`, D16), never the file the implementation publishes now: a
 * past run still shows the text that ran after the file has moved on, and the
 * head says so ("as run · <workflowVersion>"). The current file is one link
 * away, the same View workflow file screen the run header links to.
 *
 * Nothing here touches the selection or the page: the drawer is local state
 * on the pane, the URL's `?step=` is untouched, and closing — Esc, the scrim,
 * the Close button — leaves the pane exactly as it was and hands focus back
 * to the control that opened it. Esc is caught on the window in the capture
 * phase (the same way the island's fullscreen exit is), so the pane's own
 * "Esc goes up a level" never sees it while the drawer is open.
 *
 * Rendered through a portal onto `document.body`: the pane it belongs to is
 * `overflow: hidden`, and a fixed overlay should not depend on what any
 * ancestor does with its stacking context.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { describeRanges, locateYamlBlocks } from '../../lib/yamlRange'
import type { YamlBlockTarget } from '../../lib/yamlRange'
import { CodeView } from '../values/renderers/CodeView'

/** What the drawer shows: the run's snapshot and where the current file lives. */
export interface YamlSource {
  /** The run's own YAML snapshot (D16). */
  yaml: string
  /** The implementation version the run recorded, when it did. */
  workflowVersion?: string
  /** `/<impl>/<workflow>/file` — the file the implementation publishes now. */
  fileHref: string
}

const YAML_MAPPING = { language: 'yaml' } as const

export function YamlDrawer({
  source,
  subject,
  target,
  onClose,
}: {
  source: YamlSource
  /** The selection's name in the head: the step key, or the job id. */
  subject: string
  target: YamlBlockTarget
  onClose: () => void
}) {
  const ranges = useMemo(() => locateYamlBlocks(source.yaml, target), [source.yaml, target])
  const dialog = useRef<HTMLElement>(null)

  // Focus lands in the drawer, on the block it opened for. `scrollIntoView`
  // is guarded because jsdom has none.
  useEffect(() => {
    const el = dialog.current
    if (!el) return
    el.focus()
    const first = el.querySelector<HTMLElement>('.code-line[data-marked="true"]')
    if (first && typeof first.scrollIntoView === 'function') first.scrollIntoView({ block: 'center' })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const version = source.workflowVersion
  const marked = describeRanges(ranges)

  return createPortal(
    <div className="yaml-drawer-root">
      <div className="yaml-drawer-scrim" data-testid="yaml-drawer-scrim" onClick={onClose} />
      <aside
        className="yaml-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Workflow YAML"
        data-testid="yaml-drawer"
        tabIndex={-1}
        ref={dialog}
      >
        <header className="pane-head yaml-drawer-head">
          <span className="pane-title">
            <span className="yaml-drawer-eyebrow">Workflow YAML</span>
            <h3 className="graph-panel-title">{subject}</h3>
            <span className="pane-key" data-testid="yaml-drawer-snapshot">
              as run{version ? ` · ${version}` : ''}
              {marked ? ` · ${marked}` : ''}
            </span>
          </span>
          <nav className="yaml-drawer-actions">
            <Link className="button" to={source.fileHref}>
              Current workflow file
            </Link>
            <button type="button" className="button" data-testid="yaml-drawer-close" onClick={onClose}>
              Close <kbd>Esc</kbd>
            </button>
          </nav>
        </header>
        <div className="yaml-drawer-body">
          {ranges.length === 0 && (
            <p className="note" data-testid="yaml-drawer-unmarked">
              This snapshot has no block for <code>{subject}</code>, so it is shown unmarked.
            </p>
          )}
          <CodeView value={source.yaml} mapping={YAML_MAPPING} marks={ranges} />
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/**
 * The pane head's **YAML** button and the drawer it opens. Owns the open
 * state and the focus hand-back: whichever way the drawer closes, focus
 * returns to this button (08: "reachable from the pane header").
 */
export function YamlControl({ source, subject, target }: { source: YamlSource; subject: string; target: YamlBlockTarget }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  // A fresh `target` object on every render would re-run the drawer's locate
  // memo each time; key it on its parts instead.
  const stable = useMemo(
    () => ({ job: target.job, step: target.step, strategy: target.strategy }),
    [target.job, target.step, target.strategy],
  )
  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }

  return (
    <>
      <button
        type="button"
        className="yaml-trigger"
        data-testid="yaml-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        ref={trigger}
        onClick={() => setOpen(true)}
      >
        YAML
      </button>
      {open && <YamlDrawer source={source} subject={subject} target={stable} onClose={close} />}
    </>
  )
}
