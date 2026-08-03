import { useState } from 'react'
import { formatTime } from '../../lib/edl'
import type { Scene } from '../../lib/scenes'

type Props = {
  scenes: Scene[]
  selectedId: string | null
  onSelect: (id: string) => void
}

/**
 * The scene queue — also the YouTube chapter list. Each scene is a unit you
 * build one at a time; built ones are checked off. A scene with a director
 * cutting `brief` (story 13f; legacy projects: the old seeded `refinePrompt`)
 * gets a chevron that reveals it read-only — a quick peek without selecting the
 * scene. Old scenes with neither show no chevron.
 */
export function SceneList({ scenes, selectedId, onSelect }: Props) {
  const built = scenes.filter((s) => s.status === 'built').length
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <p className="meta-label">Scenes · chapters</p>
        <p className="font-mono text-[12px] text-ink-mute">
          {built}/{scenes.length} built
        </p>
      </div>
      <ol className="flex flex-col gap-2">
        {scenes.map((scene) => {
          const active = scene.id === selectedId
          const done = scene.status === 'built'
          const prompt = (scene.brief ?? scene.refinePrompt)?.trim()
          const isOpen = expanded.has(scene.id)
          const panelId = `scene-prompt-${scene.id}`
          return (
            <li key={scene.id}>
              <div
                className={[
                  'flex flex-col border-l-2 bg-surface transition-colors',
                  active
                    ? 'border-accent bg-accent/5'
                    : done
                      ? 'border-line opacity-70 hover:opacity-100'
                      : 'border-line hover:bg-surface-dim/40',
                ].join(' ')}
              >
                <div className="flex items-stretch">
                  <button
                    type="button"
                    onClick={() => onSelect(scene.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left"
                  >
                    <span
                      className={[
                        'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                        done
                          ? 'bg-accent text-surface'
                          : 'border border-line text-ink-faint',
                      ].join(' ')}
                    >
                      {done ? '✓' : scene.index + 1}
                    </span>
                    {scene.thumb ? (
                      <img
                        src={scene.thumb}
                        alt=""
                        className="h-8 w-14 flex-shrink-0 rounded object-cover"
                        draggable={false}
                      />
                    ) : (
                      <span className="h-8 w-14 flex-shrink-0 rounded bg-ink/10" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-ink">{scene.title}</span>
                      <span className="block font-mono text-[11px] text-ink-mute">
                        {formatTime(scene.start)}–{formatTime(scene.end)}
                      </span>
                    </span>
                  </button>
                  {prompt && (
                    <button
                      type="button"
                      onClick={() => toggle(scene.id)}
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      aria-label={`${isOpen ? 'Hide' : 'Show'} the director's cutting brief for this scene`}
                      title="The director's cutting brief for this scene"
                      className="flex w-9 flex-shrink-0 items-center justify-center text-ink-faint hover:text-ink-soft"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        className={['h-3.5 w-3.5 transition-transform', isOpen ? 'rotate-90' : ''].join(' ')}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                </div>
                {prompt && isOpen && (
                  <div id={panelId} className="border-t border-line/60 px-3 py-2.5">
                    <p className="meta-label">Cutting brief</p>
                    <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-soft">
                      {prompt}
                    </p>
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
