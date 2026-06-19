import { useState } from 'react'
import { useLazyGetStudioJobQuery } from '../../store/studioApi'

type Props = {
  label: string
  /** Fired once, on the first expand — the connected wrapper fetches here. */
  onOpen: () => void
  loading?: boolean
  /** True once a fetch has resolved — distinguishes "no prompt stored" (old
   *  runs, show the fallback) from "not fetched yet". */
  loaded?: boolean
  error?: boolean
  prompt?: string | null
  system?: string | null
}

/**
 * The low-key "what did we actually tell the AI" disclosure (story 03m).
 * Collapsed by default — it's for the curious, not in your face. The prompt is
 * fetched on first expand (never persisted client-side; the job row owns it).
 */
export function PromptDisclosure({ label, onOpen, loading, loaded, error, prompt, system }: Props) {
  const [opened, setOpened] = useState(false)
  return (
    <details
      className="border rule bg-paper-deep/30 px-4 py-2.5"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open && !opened) {
          setOpened(true)
          onOpen()
        }
      }}
    >
      <summary className="cursor-pointer text-[12.5px] text-ink-mute">{label}</summary>
      <div className="mt-2 flex flex-col gap-2">
        {loading && <p className="text-[12.5px] text-ink-mute">Loading…</p>}
        {error && (
          <p className="text-[12.5px] text-ink-mute">Couldn't load the prompt for this run.</p>
        )}
        {!loading && !error && loaded && !prompt && !system && (
          <p className="text-[12.5px] text-ink-mute">Not available for this run.</p>
        )}
        {prompt && (
          <details>
            <summary className="cursor-pointer text-[12.5px] text-ink-soft">Prompt</summary>
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-ink-soft">
              {prompt}
            </pre>
          </details>
        )}
        {system && (
          <details>
            <summary className="cursor-pointer text-[12.5px] text-ink-soft">System instruction</summary>
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-ink-soft">
              {system}
            </pre>
          </details>
        )}
      </div>
    </details>
  )
}

/** Connected wrapper: fetches the job row on first expand. Renders nothing at
 *  all without a job id (old persisted sessions degrade gracefully). */
export function JobPromptDisclosure({ jobId, label }: { jobId?: string | null; label: string }) {
  const [fetchJob, { data, isFetching, isError, isSuccess }] = useLazyGetStudioJobQuery()
  if (!jobId) return null
  return (
    <PromptDisclosure
      label={label}
      onOpen={() => void fetchJob(jobId)}
      loading={isFetching}
      loaded={isSuccess}
      error={isError}
      prompt={data?.prompt}
      system={data?.system}
    />
  )
}
