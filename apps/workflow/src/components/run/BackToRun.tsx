/**
 * The way out of a step pane, shared by every pane shape (08): a button in
 * the head that returns the page to the run level. Selection is the URL's
 * `?step=` (RunPage), so this is a history entry back, not a store write.
 */
export function BackToRun({ onBack }: { onBack?: () => void }) {
  if (!onBack) return null
  return (
    <button type="button" className="pane-back" data-testid="step-pane-back" onClick={onBack}>
      <span aria-hidden="true">←</span> Run
    </button>
  )
}
