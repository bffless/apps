/**
 * Start a run: the form generated from `on.manual.inputs` (08). Stub — the
 * generated controls and the Start action land with the kickoff task; the
 * testids are already the contract ones (07).
 */
export function KickoffPage() {
  return (
    <section className="page">
      <h1 className="page-title">Start a run</h1>
      <form className="form" data-testid="kickoff-form">
        <p className="note">The kickoff form is not built yet.</p>
        <button type="submit" data-testid="kickoff-start" disabled>
          Start
        </button>
      </form>
    </section>
  )
}
