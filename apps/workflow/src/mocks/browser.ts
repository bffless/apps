/** The dev worker; started from `main.tsx` when the master switch is on. */
import { setupWorker } from 'msw/browser'
import { db, seedFinishedRun } from './db'
import { FINISHED_RUN } from './fixtures/finishedRun'
import { handlers } from './handlers'

export const worker = setupWorker(...handlers)

/**
 * Bytes for the poster the fixture registers. The fixture is a record of *rows*
 * (a real run's bytes live in a bucket, not in a Data Table), so without these
 * the file card renders a broken image in mock dev. A flat 320×180 PNG — this
 * exists to prove the serve route and the file viewer, not to be a poster.
 */
const POSTER_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAABk0lEQVR42u3TAQkAAAzDsMm5uQu+m+sYBKKg0OwcUCoSgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGA6sABgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAgIHBwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMBlYBDAwYGDAwGBgwMGBgwMBgYMDAgIHBwICBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQNDtwdLQ8DQDrwsPQAAAABJRU5ErkJggg=='

function seedPoster(): void {
  const poster = FINISHED_RUN.run.outputs?.poster as { path?: string } | undefined
  if (!poster?.path) return
  const binary = atob(POSTER_PNG)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  db.files.set(poster.path, { bytes, contentType: 'image/png' })
}

/**
 * Mock dev starts with one completed `hello` run already on the books, so Past
 * runs and the run page are browsable the moment the worker is up. Tests seed
 * per case instead (`mocks/server.ts` stays empty), because a fixture that is
 * always there is a fixture no test can prove it needs.
 */
seedFinishedRun()
seedPoster()
