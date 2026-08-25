/**
 * `render: island` (02/04): a value shown by the workflow's own island file,
 * read-only.
 *
 * The same HTML, the same sandbox and the same bridge a step's island gets —
 * the only differences are that the value arrives as the tool input `{ value }`
 * and that the two host tools are refused: a viewer sits in a *record*, which
 * may be a finished run, someone else's run, or a run this tab does not drive,
 * so nothing it does may become a run event. `workflow.submit` and
 * `workflow.annotate` answer with an error the island can show, which is a
 * truer answer than silently accepting and dropping the call.
 *
 * Each viewer owns its own host, built **once** per component instance:
 * `IslandFrame` re-mounts whenever `host` changes identity, so a host rebuilt
 * on a re-render would restart the island under the reader. `useState`'s lazy
 * initialiser is the stable-forever slot for it (a `useMemo` is allowed to be
 * discarded and recomputed).
 *
 * ...which is exactly why `IslandView` is two components. Tool input is sent
 * **once**, at mount — a step's island must never be restarted under the user's
 * hands — but a *viewer's* value routinely arrives after its first render: a
 * live run renders its declared outputs before it has recorded any of them, so
 * the first value a run-output viewer ever sees is `null`. A changed value is
 * therefore a **new mount**: the outer component keys the inner one on the
 * value, and the inner one is the single-mount viewer described above.
 *
 * The key is a **content signature**, not object identity, and that is not a
 * nicety. `RunPage` rebuilds its `RunState` through `replayRun` in a `useMemo`
 * over `[run, steps, def]`, so while a run is `running` every poll produces
 * structurally identical but freshly allocated output objects. Keyed on
 * identity, a `render: island` over a step output would re-fetch the island and
 * rebuild the bridge every poll interval; keyed on content it never moves until
 * the value really changes. Values are bounded (Phase 2 offloads outputs above
 * 256 KB), so stringifying one per render is cheap next to what it prevents.
 */
import { useEffect, useState } from 'react'
import { IslandFrame } from '../../../islands/IslandFrame'
import { createIslandHost } from '../../../islands/IslandHost'
import { fetchText, openLink } from '../../../islands/hostDeps'
import { httpJsonWithReauth } from '../../../lib/http'
import type { ValueDecl } from '../../../lib/valueDecl'

const READ_ONLY = 'This island is a read-only viewer.'

const now = () => Date.now()

export interface IslandViewProps {
  decl: ValueDecl & { src: string }
  value: unknown
  impl: string
}

/**
 * What the viewer is showing, as a string. `undefined` and a value JSON cannot
 * describe both collapse to a constant — the honest answer for "nothing here
 * changed in a way an island could be told about", since tool input travels as
 * JSON anyway and an unserialisable value could not be delivered.
 */
function signature(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return 'unserialisable'
  }
}

export function IslandView(props: IslandViewProps) {
  return <IslandViewer key={signature(props.value)} {...props} />
}

function IslandViewer({ decl, value, impl }: IslandViewProps) {
  const [host] = useState(() =>
    createIslandHost({
      http: httpJsonWithReauth,
      fetchText,
      onSubmit: () => ({ ok: false, errors: { outputs: READ_ONLY } }),
      onAnnotate: () => ({ ok: false, error: READ_ONLY }),
      // A viewer is one of many things on a page; it does not get to take the
      // page over. `ui/request-display-mode` is answered with the mode in force.
      onDisplayMode: () => {},
      onLog: () => {},
      openLink,
      now,
    }),
  )

  // The frame's own cleanup tears the bridge down; this is the backstop for a
  // host that was built but never handed a frame.
  useEffect(() => {
    return () => {
      void host.teardown('unmounted')
    }
  }, [host])

  return (
    <div className="renderer-island" data-testid="renderer" data-render="island">
      <IslandFrame
        impl={impl}
        src={decl.src}
        arguments={{ value }}
        viewer
        headless={false}
        display="inline"
        host={host}
        // A viewer that cannot load has no step to fail: the frame stays, empty,
        // and the reader still has the rest of the record.
        onLoadError={() => {}}
      />
    </div>
  )
}
