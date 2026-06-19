import { useState } from 'react'

type Props = {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  busy?: boolean
  sheetCount: number
  wordCount: number
  /** Re-run mode (story 03m): the director already ran — submitting replaces
   *  every scene and its build work, so it's confirm-gated. */
  rerun?: boolean
  sceneCount?: number
}

/**
 * The headline prep step: hand the cut to the AI master director. Shown in the
 * right column when the director step is current — and again, in `rerun` mode,
 * once it's done (story 03m), so the producer can tweak the direction and try
 * again. The free-text direction is optional — an aside to the AI ("keep the
 * demo at 12:30", "punchier intro") — so the button works empty too.
 */
export function DirectorPanel({
  value,
  onChange,
  onSubmit,
  busy,
  sheetCount,
  wordCount,
  rerun,
  sceneCount = 0,
}: Props) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="mb-6 border-l-2 border-terracotta bg-terracotta/5 p-5">
      <p className="meta-label">
        {rerun ? 'Done · the master director' : 'Final prep step · the master director'}
      </p>
      <h3 className="mt-1 font-serif text-[22px] leading-tight text-ink">
        {rerun ? 'Re-run the AI director' : 'Send it to the AI director'}
      </h3>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-soft">
        {rerun
          ? 'Tweak your direction and send it again — the director re-cuts the whole video into fresh scenes.'
          : `Gemini reads your ${wordCount.toLocaleString()}-word transcript and ${sheetCount} contact sheet${sheetCount === 1 ? '' : 's'} together, then returns a one-line synopsis and your scenes — each with its original-video span, the footage to cut, and a starting prompt to steer the per-scene refine.`}
      </p>

      <label className="mt-4 flex flex-col gap-1.5">
        <span className="meta-label">Your direction · optional</span>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={busy}
          rows={3}
          placeholder="e.g. Keep the live demo around 12:30. Make the intro punchy and drop the throat-clearing."
          className="w-full resize-y rounded-md border border-paper-line bg-paper p-3 text-[14px] leading-relaxed text-ink disabled:opacity-60"
        />
      </label>

      {rerun && confirming ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-[13px] text-terracotta-ink">
            This replaces your {sceneCount} scene{sceneCount === 1 ? '' : 's'} and any build
            work on them.
          </p>
          <button
            type="button"
            className="pill-cta"
            disabled={busy}
            onClick={() => {
              setConfirming(false)
              onSubmit()
            }}
          >
            Replace &amp; re-run
          </button>
          <button
            type="button"
            className="pill-ghost"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="pill-cta mt-4"
          disabled={busy}
          onClick={() => (rerun ? setConfirming(true) : onSubmit())}
        >
          {busy ? 'Directing…' : rerun ? 'Re-run the AI director →' : 'Send to the AI director →'}
        </button>
      )}
    </div>
  )
}
