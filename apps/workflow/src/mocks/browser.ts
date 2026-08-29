/** The dev worker; started from `main.tsx` when the master switch is on. */
import { setupWorker } from 'msw/browser'
import { MOCK_ADMIN, seedFinishedRun, seedObject, seedRenderedRun, seedScriptRun, setMockUser } from './db'
import { FINISHED_RUN } from './fixtures/finishedRun'
import { RENDERED_RUN_FILES } from './fixtures/renderedRun'
import { SCRIPT_RUN_FILES } from './fixtures/scriptRun'
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
  seedObject(poster.path, { bytes, contentType: 'image/png' })
}

/**
 * The `interactive` run's objects: the poster its script step returned, and the
 * JSON its offloaded `big` output points at. Text, not base64 — an SVG and a
 * JSON document are both source, and seeding them as bytes keeps the serve
 * route (`GET /api/uploads/*`) the only way either is read back.
 */
function seedScriptFiles(): void {
  const encoder = new TextEncoder()
  for (const file of SCRIPT_RUN_FILES) {
    seedObject(file.path, { bytes: encoder.encode(file.text), contentType: file.contentType })
  }
}

/** The `rendered` run's two `images` File refs — SVGs, so plain text bytes. */
function seedRenderedFiles(): void {
  const encoder = new TextEncoder()
  for (const file of RENDERED_RUN_FILES) {
    seedObject(file.path, { bytes: encoder.encode(file.text), contentType: file.contentType })
  }
}

/**
 * `?as=admin` runs the mock session as an admin instead of the default member.
 * Mock-only — a real session's role comes from CE, never from the URL — and it
 * exists so a browser (or Playwright) can walk the branches only an admin
 * reaches, above all deleting a run someone else started.
 */
if (new URLSearchParams(globalThis.location?.search ?? '').get('as') === 'admin') {
  setMockUser(MOCK_ADMIN)
}

/**
 * Mock dev starts with three completed runs already on the books, so Past
 * runs and the run page are browsable the moment the worker is up: the M1
 * `hello` run, the `interactive` one whose script step left a `{"$file"}`
 * payload behind (the only way to read one back — the db is page memory, so a
 * live run's own rows never survive a reload), and the `rendered` one that
 * exercises all five named renderers (Task 17). Tests seed per case instead
 * (`mocks/server.ts` stays empty), because a fixture that is always there is a
 * fixture no test can prove it needs.
 */
seedFinishedRun()
seedPoster()
seedScriptRun()
seedScriptFiles()
seedRenderedRun()
seedRenderedFiles()
