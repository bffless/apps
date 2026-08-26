/**
 * The way up a level from a pane (08: run › job › step): a button in the
 * head that returns to the level above — the job from a step, the run from a
 * job. Selection is the URL's `?step=` (RunPage), so this is a history entry
 * back, not a store write.
 */
export function BackToRun({ onBack, label = 'Run' }: { onBack?: () => void; label?: string }) {
  if (!onBack) return null
  return (
    <button
      type="button"
      className="pane-back"
      data-testid="step-pane-back"
      title={`Back to ${label}`}
      onClick={onBack}
    >
      <span aria-hidden="true">←</span> {label}
    </button>
  )
}
