/**
 * The front door (08): every alias that answered discovery, as a card.
 *
 * A deployment that published something unusable stays on the list carrying its
 * error — a broken publish nobody can see is worse than one they can (06) — but
 * it carries no links, because there is nothing behind them.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { DiscoveryError } from '../components/DiscoveryError'
import { EmptyState } from '../components/EmptyState'
import { LastRunPill } from '../components/LastRunPill'
import { workflowId } from '../lib/coerce'
import { fetchProjectRepository } from '../lib/discovery'
import { pluralize } from '../lib/plural'
import type { Implementation } from '../lib/coerce'
import { useDiscoverQuery } from '../store/workflowApi'

/** Where "how do I write one?" is answered, end to end. */
const WRITING_DOC =
  'https://github.com/bffless/apps/blob/main/apps/workflow/docs/writing-an-implementation.md'

/** The implementations monorepo, and its smallest member — the reference to copy. */
const IMPLEMENTATIONS_REPO = 'https://github.com/bffless/workflow-implementations'
const HELLO_REFERENCE = `${IMPLEMENTATIONS_REPO}/tree/main/workflows/hello`

function ImplementationCard({ impl }: { impl: Implementation }) {
  return (
    <article className="card">
      <header className="card-head">
        {impl.error ? (
          <span className="card-title">{impl.alias}</span>
        ) : (
          <Link className="card-title" to={`/${impl.alias}`}>
            {impl.alias}
          </Link>
        )}
        {impl.preview && <span className="badge">preview</span>}
      </header>

      {impl.error ? (
        <EmptyState title="This deployment did not publish a usable workflow index">
          <p className="empty-detail">{impl.error}</p>
        </EmptyState>
      ) : (
        <>
          <p className="card-name">{impl.name}</p>
          {impl.description && <p className="card-desc">{impl.description}</p>}
          <ul className="meta">
            {impl.version && <li>v{impl.version}</li>}
            <li>{pluralize(impl.workflows.length, 'workflow')}</li>
          </ul>
          <ul className="card-workflows">
            {impl.workflows.map((listing) => (
              <li key={listing.file}>
                <span className="card-workflow">{listing.name}</span>
                <LastRunPill impl={impl.alias} workflow={workflowId(listing.file)} />
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  )
}

/**
 * The project this harness serves, read once through `fetchProjectRepository()`
 * (apps#363/#545): the build-time override when baked in, else the runtime
 * answer from the serving rule set, else `undefined` (unscoped). `resolved`
 * separates "still asking" from "asked, and there is no project" so the
 * personalized publish line never flashes the generic fallback first.
 */
function useProjectRepository() {
  const [state, setState] = useState<{ repository: string | undefined; resolved: boolean }>({
    repository: undefined,
    resolved: false,
  })
  useEffect(() => {
    let cancelled = false
    void fetchProjectRepository().then((repository) => {
      if (!cancelled) setState({ repository, resolved: true })
    })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

/**
 * The smallest CI that publishes an implementation, with the member's own
 * project prefilled as `repository:` — copy, commit, done. `harness-alias`
 * names the alias this harness serves under so the published rules attach to
 * it (`workflow` is the default install).
 */
function publishSnippet(repository: string | undefined): string {
  return `name: Publish
on:
  push:
    branches: [main]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: bffless/publish-workflow@v1
        with:
          alias: hello
          repository: ${repository ?? '<owner>/<repo>'}
          harness-alias: workflow
          api-url: \${{ vars.BFFLESS_URL }}
          api-key: \${{ secrets.BFFLESS_WORKFLOW_API_KEY }}
`
}

/**
 * The publish workflow as a copyable block. The clipboard is a best effort
 * (`PathChip`'s posture): no permission, no secure context, no clipboard at
 * all — the snippet is still on the screen to select.
 */
function PublishSnippet({ repository }: { repository: string | undefined }) {
  const yaml = publishSnippet(repository)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(yaml).then(
        () => setCopied(true),
        () => undefined,
      )
    } catch {
      // No clipboard here — the snippet is still on the screen to select.
    }
  }
  return (
    <div className="snippet">
      <div className="snippet-head">
        <span className="snippet-file">.github/workflows/publish.yml</span>
        <button type="button" className="value-copy" aria-label="Copy workflow" onClick={copy}>
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre data-testid="publish-snippet">
        <code>{yaml}</code>
      </pre>
    </div>
  )
}

/**
 * The first screen a fresh install sees (08 treats empty states as
 * first-class): not "nothing here" but the whole path from zero to a first
 * implementation, personalized with the project this harness serves.
 */
function WelcomePage() {
  const { repository, resolved } = useProjectRepository()
  return (
    <section className="page" data-testid="implementations-empty">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Welcome to Workflow</h1>
          <p className="page-sub">
            An implementation is a repo whose CI publishes workflows into this project — each
            one appears here, ready to run.
          </p>
        </div>
      </div>
      <div className="welcome">
        {resolved && (
          <p className="welcome-lede" data-testid="publish-target">
            {repository === undefined ? (
              <>
                Nothing is published yet. Publish an implementation into this harness&rsquo;s
                project and it appears on this page.
              </>
            ) : (
              <>
                Nothing is published yet. Publish an implementation into{' '}
                <code>{repository}</code> and it appears on this page.
              </>
            )}
          </p>
        )}
        <ol className="publish-steps">
          <li>
            <p className="publish-step-title">Start from the reference</p>
            <p>
              <a href={HELLO_REFERENCE} target="_blank" rel="noreferrer">
                hello
              </a>{' '}
              is the smallest working implementation — one workflow, one pipeline rule. Copy
              its layout into a repo of your own.
            </p>
          </li>
          <li>
            <p className="publish-step-title">Give it a publish workflow</p>
            <p>
              <code>bffless/publish-workflow@v1</code> builds the bundle, deploys it and
              attaches its rules. It needs an instance URL and an API key as repo settings.
            </p>
            <PublishSnippet repository={resolved ? repository : undefined} />
          </li>
          <li>
            <p className="publish-step-title">Merge</p>
            <p>
              The publish run deploys straight into this project — discovery needs no restart.
              Reload this page and the implementation is here.
            </p>
          </li>
        </ol>
        <p className="welcome-links">
          <a href={WRITING_DOC} target="_blank" rel="noreferrer">
            Writing an implementation
          </a>
          <a href={IMPLEMENTATIONS_REPO} target="_blank" rel="noreferrer">
            bffless/workflow-implementations
          </a>
        </p>
        {repository !== undefined && (
          // Found live (M2 walk, apps#363): CE answers a scoped alias list with
          // nothing — not an error — for a member who has no role on that
          // project, which reads exactly like "nobody published anything".
          <p className="note" data-testid="scope-hint">
            This harness only looks at project <code>{repository}</code>. If something is
            published there and you still see nothing, you may have no role on that project
            yet — ask an admin to add you (viewer is enough).
          </p>
        )}
      </div>
    </section>
  )
}

export function ImplementationsPage() {
  const { data: implementations, isLoading, isError, error } = useDiscoverQuery()

  if (isLoading) return <p className="note">Looking for implementations…</p>

  // A project whose alias list could not be read has not "published nothing" —
  // saying so would send the user off to fix a publish that is already fine (08).
  if (isError) return <DiscoveryError error={error} />

  if (!implementations?.length) return <WelcomePage />

  return (
    <section className="page">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Implementations</h1>
          <p className="page-sub">
            Every deployment in this project that published a workflow bundle.
          </p>
        </div>
      </div>
      <div className="cards" data-testid="implementations">
        {implementations.map((impl) => (
          <ImplementationCard key={impl.alias} impl={impl} />
        ))}
      </div>
    </section>
  )
}
