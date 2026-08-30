# workflow: mock-backed test for files/register accepting a bare uploads-relative path (#461)

Refiled from #461. `POST /api/workflow/files/register` accepts a pipeline's uploads-relative path (#427 §3, normalised by `rules/api/workflow/files/register/post/normalize.fn.js`); hello never exercised the bare-path promise and the harness has no test for it.

- [ ] Teach `apps/workflow/src/mocks/handlers.ts` the `normalize.fn.js` rules (bare path and `api/uploads/`-prefixed both register to the same `storageKey`).
- [ ] Add the test.
- [ ] Fix the spec line that still says `{ path }` → `storageKey` in `docs/spec/02-*.md` if it disagrees with the shipped rule.

Verify: `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build`.

