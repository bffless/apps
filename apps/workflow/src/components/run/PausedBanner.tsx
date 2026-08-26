/**
 * The 05 pause banner (apps#375): a write-ahead write failed, or a resume
 * was refused, and the run is parked — every controller aborted, the
 * heartbeat stopped, nothing scheduled. `runSlice.paused` carries the
 * message; until this component nothing rendered it, so the only visible
 * signal was whatever annotation happened to be persisted.
 *
 * Retry is `lifecycleActions.retryRun`: re-read the record, adopt it again.
 * The pending/failed affordances follow `RunPage`'s `ResumeBanner` — one
 * attempt at a time, and a record that could not be read says so instead of
 * silently doing nothing.
 */
import { useState } from 'react'
import { useAppDispatch } from '../../store/hooks'
import { LeaseTransportError, retryRun } from '../../store/lifecycleActions'

export function PausedBanner({ message }: { message: string }) {
  const dispatch = useAppDispatch()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  async function attempt() {
    setPending(true)
    setFailed(false)
    try {
      await dispatch(retryRun())
    } catch (err) {
      if (!(err instanceof LeaseTransportError)) throw err
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="note banner" role="alert" data-testid="run-paused">
      <strong>Run paused.</strong> {message}{' '}
      <button type="button" data-testid="run-retry" disabled={pending} onClick={() => void attempt()}>
        Retry
      </button>
      {failed && (
        <span className="note" data-testid="run-retry-failed">
          {' '}
          Couldn&apos;t reach the server — try again.
        </span>
      )}
    </div>
  )
}
