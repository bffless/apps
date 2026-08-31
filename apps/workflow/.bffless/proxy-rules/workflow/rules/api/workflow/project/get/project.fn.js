// The serving project, from deployment provenance (apps#363).
//
// CE hands every function_handler a `deployment` root describing the deployment
// the rule is serving: `{ owner, repo, commitSha, alias }`. The 2026-08-31 live
// probe (recorded in bffless/README.md) proved `owner`/`repo` name the **BFFless
// project** the alias serves (`bffless/workflow`), not the git repository the
// bundle was built from (`bffless/apps`) — which is exactly what a catalog-
// installed harness needs to scope discovery to its own project at runtime.
//
// The body is pre-serialized here and rendered with `{{{steps.project.repositoryJson}}}`
// rather than hand-assembled in a template: whoami's quote-safe shape (apps#381) —
// a template cannot JSON-escape a value for you. `null` (not a dropped key) is the
// contract for "provenance absent": the SPA falls back to an unscoped alias list.
function handler({ deployment }) {
  const owner = deployment && typeof deployment.owner === 'string' ? deployment.owner : ''
  const repo = deployment && typeof deployment.repo === 'string' ? deployment.repo : ''
  const repository = owner !== '' && repo !== '' ? owner + '/' + repo : null
  return { repositoryJson: JSON.stringify({ repository }) }
}
