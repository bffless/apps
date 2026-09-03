# Workflow M5 Phase 3 — CE: auth + generic handler Implementation Plan (apps#554, stories 7–9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **The CE half of every story is built in the loop, interactively, in `repos/ce`** (memory: *CE in-loop, apps via Sandcastle*); the apps half follows on the epic branch once the CE release that carries it is on j5s.

**Goal:** Climb the rest of spec 10's auth ladder (D23) and land the GA shape of the MCP endpoint (D22) as three generic CE contributions — **app tokens** (scoped, user-bound bearers that the deployment visibility gate and `auth_required` honour like a session, with per-rule `requiredScopes`), a generic **`mcp_handler`** pipeline step (the stateless Streamable-HTTP + JSON-RPC plumbing, tools and `ui://` resources declared in the rule's config, tools executed against sibling rules in-process as the caller), and **OAuth 2.1** (DCR, PKCE, RFC 8414/9728/8707; the access token *is* an app token) — so that claude.ai's one-click connector flow completes DCR → consent → tokens against `workflow.j5s.dev`, a **private** deployment, and `workflow.status` runs as the member with `startedBy` the member's id, while a `workflow:read`-only consent cannot start a run.

**Architecture:** CE stays app-agnostic (D22): nothing in CE knows the word "workflow". Story 7 adds one credential type resolved in the three places CE already resolves a session or an API key (`OptionalAuthGuard`, `ApiKeyGuard`, `ProxyMiddleware.getOptionalUser`), a scope gate inside `AuthRequiredValidator` that only tokens are subject to (sessions pass every scope check — a person acting as themselves is not a delegation), and a per-rule `bypassVisibility` opt-out of the deployment gate. Story 8 adds a step handler that is a peer of `function_handler` — the rule's config *is* the server description; execution is a new `RuleInvokerService` that resolves and runs a sibling rule of the same alias in-process with the caller's identity and the sibling's own validators. Story 9 adds a built-in OAuth 2.1 authorization server on the admin host whose access tokens are story 7's app tokens, bound to the project the RFC 8707 `resource` resolves to. The workflow app's side of each story is rules-as-code on the epic: `requiredScopes` from the catalog's `TOOL_SCOPES`, the MCP rule fronted by `auth_required` (the `identity` probe and the `WORKFLOW_MCP_KEY` secret retired), the rule's guts swapped from 24 `function_handler`/`http_request` steps to one `mcp_handler` step plus one small sibling rule per tool, and the `/.well-known/oauth-protected-resource` document shipped as a rule served despite visibility.

**Tech Stack:** CE backend — NestJS 10, Drizzle (`pnpm db:generate` is interactive: **the person runs it**; no local Postgres on this VPS — memory `ce-no-local-db`), Jest with a mocked `db/client`, SuperTokens node ^17 / core 12.0.10 (sessions only; the OAuth2Provider recipe is *not* adopted — Decision 19), `@rekog/mcp-nest` for CE's own platform-admin MCP server (untouched, D22), `jsonwebtoken` (HS256 with `JWT_SECRET`, the relay's existing signer), `crypto.createHash('sha256')` for token hashes. CE frontend — React + Vite + RTK Query + Radix/Tailwind (`UserSettingsPage` tabs; `ProjectApiKeysTab.tsx` is the UI model). CE CLI — `packages/cli` zod manifests (`.strict()` — every new rule key is a CLI change) published as `bffless` (`@next` on every merge to `main`, stable on release). rules-as-code on the apps side — `bffless/deploy-proxy-rules@v1` (ncc-frozen with `bffless ^0.3.3` — a manifest key needs an action bump), `bffless/upload-artifact@v1`; esbuild bundles from `apps/workflow/src/mcp/*.ts` (`pnpm --filter workflow mcp:build`, `bundle.test.ts` freshness); `@modelcontextprotocol/sdk` 1.30 in `workflow-live`; Playwright; the j5s MCP (`mcp__j5s-dev__*`) for provisioning.

**Spec:** `apps/workflow/docs/spec/10-agent-embedding.md` (§Auth — the whole ladder, both CE obligations under "The deployment visibility gate"; §The MCP endpoint item 2 "GA — CE `mcp_handler`"; **D22–D23 govern this phase**, D19 holds: results stay catalog `CallToolResult`s in both adapters) · `apps/workflow/docs/adr/0005-one-tool-catalog-two-adapters.md` · `docs/superpowers/specs/2026-09-01-workflow-agent-embedding-design.md` (§3 Layer 2 "GA", §Auth ladder rungs 2–3, §4 stories 7–9 + the Phase-3 gate) · `docs/superpowers/plans/2026-09-02-workflow-m5-phase2-mcp-apps.md` — **the prototype endpoint is the functional spec for `mcp_handler`**: its "Phase 2 as shipped" block and Decisions 1–7 (bundles, polyfills, the step view, the four app-only tools, rows-in-pipeline, the service identity, the lease guard) · `apps/workflow/bffless/README.md` §"M5 Phase 2 — the MCP Apps scratch project" (ids, redeploy sequence, "What the first claude.ai session taught") · `apps/workflow/src/mcp/*.ts` + `rules/api/workflow/mcp/post/rule.yaml` (what the generic handler subsumes) · `packages/workflow-agent-tools/README.md` (the catalog; `TOOL_SCOPES`; `declaredList`/`snapshotText`/`describeText` are the prose rules) · apps#554 comments from "Story 5 — spike findings" on (the (a)/(b)/(c) answers, the Phase-2 gate report, the Cloudflare and text-only-host findings), PRs #578/#579/#581 · CE: `repos/ce/CLAUDE.md`, `.claude/ce-pr-review-checklist.md` (backwards-compat first: forward-safe migrations, additive API, the CLI is a pinned client, pipeline semantics are live customer data), `CONTEXT.md` (the auth vocabulary), ADR-0001 (an API key mints a relay session, not a SuperTokens one), open issues **ce#615** (`allowApiKey` never read — left as is, Decision 7), **ce#698** (`alias://` in-process forwarding — the invoker of Decision 14 is its sibling, not its fix), **ce#614** (run-as user — untouched). Not in scope: the run view / `workflow.http` / `start`·`resume` linking it (Phase 4); per-workflow generated tools; `bffless.dev`; any `/_bffless/*` surface or app-aware CE endpoint; coupling with CE's `@rekog/mcp-nest` server; a server-side run driver.

## Decisions this plan makes (spec-ambiguous points, resolved here)

1. **App tokens are a new table, looked up by hash, never by scan.** `app_tokens` (`id`, `name`, `token_hash` sha256 hex unique, `token_prefix` the first 12 chars for display, `user_id` → users, `project_id` → projects **not null** (spec: `{ user, project, scopes, expiry }`), `scopes` jsonb `string[]`, `kind` `'personal' | 'oauth'`, `client_id` nullable text (story 9), `expires_at` nullable, `revoked_at` nullable, `last_used_at`, `created_at`). The raw token is `bfat_` + 64 hex (32 random bytes) — a distinct prefix from API keys' `wsa_`, so a log line or a paste says which credential it is. CE's API keys are matched by a bcrypt scan over every row per request (`api-key.guard.ts`); a 256-bit random token needs no slow hash, and an MCP host makes several calls per island click, so tokens are sha256'd and indexed — O(1) and the prototype's per-call cost goes down, not up.
2. **One resolver, three call sites, nothing else changes.** `apps/backend/src/auth/app-token.util.ts` exports `resolveAppToken(header)` (parses `Authorization: Bearer bfat_…`; a Bearer that is not `bfat_`-prefixed is ignored — CE has never read `Authorization`, and a SuperTokens JWT someone sends must keep falling through exactly as today). It is wired into `OptionalAuthGuard` (the public controller's gate), `ProxyMiddleware.getOptionalUser` (the proxy gate + the pipeline user) and `ApiKeyGuard` (CE's admin API — needed because the harness's `/api/workflow/aliases` relay forwards the caller's credential to `GET /api/aliases`). Precedence at each site: `X-API-Key` → Bearer app token → session → custom-domain cookie. `SessionAuthGuard` is untouched: the admin SPA's own endpoints stay session-only.
3. **A token is the member in pipelines, and a project-fenced pseudo-key on the admin API.** In the proxy gate and in pipelines, `request.user` / `context.user` is `{ id, email, role: <the member's global role>, credential: { kind: 'app_token', appTokenId, projectId, scopes } }` — identity says *who*; nothing is pinned, because the scope gate (Decision 5) and the member's own project role already narrow. On CE's admin API (`ApiKeyGuard`) the token behaves exactly like a project-scoped API key: `apiKeyProjectId = token.projectId` (so `enforceApiKeyProjectScope` / `requireProjectAccess` confine it) and `role: user.role === 'admin' ? 'user' : user.role` (the same pin API keys get; a `member` stays a `member` — a token never elevates). A stolen token therefore cannot reach `@Roles('admin')` endpoints or another project.
4. **A token is bound to one project and refused elsewhere.** The gate compares `credential.projectId` with the serving project (`checkVisibilityAndAuth` after `getOptionalUser`): a mismatch answers 403 `{ code: 'TOKEN_PROJECT_MISMATCH' }` (an API request) — not 401, because the credential is valid, just not for here. `auth_required` performs the same check for public deployments (no gate ran) and throws `AuthorizationError`. Sessions and API keys are untouched.
5. **Scopes are a second gate inside `auth_required`, and only tokens are subject to it.** `AuthRequiredConfig` gains `requiredScopes?: string[]` (validated: array of strings matching `/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/`). `validate()`: no user → 401 as today; `credential.kind === 'app_token'` → every listed scope must be in `credential.scopes`, else `AuthorizationError('insufficient_scope: missing <scope>[, <scope>]')` (403); any other credential kind (session, custom-domain cookie, **and X-API-Key**) passes every scope check — a person acting as themselves is not a delegation, and a project API key is pre-existing traffic whose behaviour must not change (checklist: pipeline semantics are live customer data). An absent or empty `requiredScopes` means the rule needs no scope, so any token passes. The 403 carries `WWW-Authenticate: Bearer error="insufficient_scope", scope="<missing>"` (RFC 6750 §3.1) via the pipeline error mapping in `handlePipelineExecution` (`AUTHORIZATION_ERROR` with `details.missingScopes`). The scope *vocabulary* is the app's; CE compares strings (D23).
6. **`user.scopes` and `user.credential` are readable by expressions and functions.** `PipelineUser` gains `credential?: 'session' | 'api_key' | 'app_token' | 'custom_domain'` and `scopes?: string[]` (present only for tokens); `function.handler.ts` copies both onto `data.user`. Additive (existing `data.user` keys unchanged), and it is what lets story 7's *apps* follow-up refuse a scope-less tool inside the still-monolithic Phase-2 rule (Decision 26) before story 8 makes every tool its own validator-gated rule.
7. **`allowApiKey` stays exactly as inert as it is** (ce#615 is a maintainer's product call, not this plan's). The apps fence test keeps demanding it on every rule for the reason it always did (CI and the driver call with a key); nothing here reads it.
8. **The served-despite-visibility mechanism is a per-rule field, `bypassVisibility`.** A new `proxy_rules.bypass_visibility boolean not null default false` column (forward-safe: additive with a default), surfaced as `bypassVisibility` in `CreateProxyRuleDto`/`UpdateProxyRuleDto`, the sync DTO, `ExportedRule` + `RULE_KEY_ORDER` (after `debugEnabled`, so exports stay byte-stable for rules that leave it unset — the export builder omits `false`), and the CLI's `RuleManifestSchema` / `types.ts` / decompile. `ProxyMiddleware.checkVisibilityAndAuth` returns `'allowed'` first when `matchedRule.bypassVisibility` is true — the existing `isAuthProxyRule` exemption is the model, and both stay confined to the non-`internal_rewrite` proxy types (an internal rewrite continues into `PublicController`, whose own gate is unchanged). *Rejected:* a hard-coded exemption for RFC 9728's path — it would serve this phase but leaves every other pre-credential endpoint a private app could ship (a webhook receiver, a health probe) gated; the general field is the "real CE design point" the spec names. *Cost, named honestly:* the field has to reach the frozen CLI inside `bffless/deploy-proxy-rules@v1` — see "Cross-repo sequencing".
9. **Minting is session-only and open to any member of the project.** `POST /api/app-tokens` `{ name, project: 'owner/repo', scopes: string[], expiresAt? }` under `SessionAuthGuard` — a credential cannot beget credentials (no API key, no token may mint), and a member of any role ≥ `viewer` on the project may mint a token bound to it because a token never elevates (the same framing as ADR-0001). Scopes: 1–20 strings in the `namespace:verb` shape; expiry ≤ 365 days, default 90; the raw token is returned once. `GET /api/app-tokens` lists the caller's own (no hash, no raw); `DELETE /api/app-tokens/:id` revokes (soft: `revoked_at`; a revoked token answers 401 like an expired one). No admin cross-user listing in this phase. The admin UI is an **App tokens** tab on `UserSettingsPage` beside API keys (`AppTokensTab.tsx` + `appTokensApi.ts`), shaped like `ProjectApiKeysTab.tsx`: a table (name, project, scopes as badges, kind/client, expiry, last used), a mint dialog (name; project picker fed by `GET /api/me/projects`; scopes as free-text chips with the hint "the app's own vocabulary, e.g. `workflow:read`"; expiry), a show-once panel, revoke with confirm.
10. **`last_used_at` is written at most once a minute per token.** The resolver keeps an in-memory `Map<tokenId, lastWriteMs>`; an MCP host's burst of calls must not become a write per call (the bcrypt-scan lesson, again).
11. **The 401s that OAuth needs come in story 9, not story 7.** RFC 9728 §5.1's `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"` on the gate's API-shaped 401 and on the pipeline `AUTH_REQUIRED` 401 is added when CE learns OAuth (Task 15) — story 7 stays additive and behaviour-preserving for every current 401. `isApiRequest` learns one thing in story 7: a request carrying `Authorization` is an API request (401 JSON, never a 302).
12. **The prototype's wire behaviour is the acceptance spec for `mcp_handler`, check for check.** The `mcp` walk's 24 checks must pass unchanged against the story-8 endpoint: `D22.getIs405`, `initialize` (`serverInfo`, version negotiation, `instructions`), `tools/list` parity (the 11 catalog descriptors byte-identical, then the four app-only tools with `_meta.ui.visibility: ['app']`, `workflow.submitStep` linking the step view), `notifications/initialized` → 202 empty, unknown method → `-32601`, batch → `-32600`, `resources/list`/`read` with the derived CSP, `-32002` for an unknown resource, every `tools/call` answer a catalog `CallToolResult` including the lease guard's `errors.lease`, `submitStep { values: {} }` opening the island, and the refusal wording (`refusals.ts`, `NEED_RUN_ID`, `NOT_CONFINED`). What moves into CE is the *envelope*; what stays in the app is every sentence a tool says.
13. **The `tools` block of the MCP rule is generated from the catalog, not hand-written.** `scripts/build-mcp.mjs` gains an entry that renders `rules/api/workflow/mcp/rule.yaml`'s `config.tools` (and `config.resources.static`/`templates`) from `CATALOG` + `HOST_TOOLS`, committed beside the bundles; `bundle.test.ts` compares the committed YAML to a fresh render exactly as it compares the `*.fn.js`. D19 holds by construction: a descriptor edit in the package is a stale-YAML test failure in the app.
14. **Sibling execution is a service, and its resolution is shared with the middleware.** `proxy-rules/rule-resolution.ts` (pure functions over `db`: `resolveRuleSetIdsForAlias`, `resolveProjectDefaultRuleSetIds`, `findMatchingRule`, `matchesPattern` — lifted verbatim out of `proxy.middleware.ts`, which now imports them) and `proxy-rules/rule-invoker.service.ts` (`RuleInvokerService.invoke(...)`, exported by `ProxyRulesModule`, which `PipelinesModule` already imports). The invoker resolves the effective rule sets of the *current* alias (`context.projectId` + `context.deployment.alias`), matches `(path, method)` exactly as the edge would, and: for a `pipeline` rule builds a synthetic request (`path`, `method`, `headers` = the parent's minus `content-length`, `query`, `body`, `cookies`, `ip`, `get()`, **no `res`** — so a streaming `ai_handler` falls back to its non-streaming branch and `file_serve_handler` refuses) and calls `executePipelineWithDebug` with the **parent's `PipelineUser`** and `captureDebug: false`; for an `external_proxy` rule performs the in-process fetch the forwarder would (target URL from `buildTargetUrl`, the parent's `cookie` + `authorization` forwarded); for `internal_rewrite` / `email_form_handler` answers "unsupported". The visibility gate is **not** re-run — the caller already passed it for this alias; the sibling's own validators (`auth_required` + `requiredScopes`, `rate_limit`) **are**. Recursion is capped at depth 1: a sibling whose pipeline contains an `mcp_handler` step is refused (`MCP_RECURSION`). ce#698's `alias://` is the declarative cousin of this hop; it stays open.
15. **Answer mapping is fixed and generic.** A sibling 2xx whose JSON body already has a `content` array is returned verbatim as the `CallToolResult` (so the app keeps its prose and `structuredContent`); any other 2xx body becomes `{ content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: <object | { text } | { value }> }` (the prototype's `pipelineResult`); a non-2xx becomes `isError` with `errors.pipeline: '<code>: <message>'` and `_meta.bffless.status` (the prototype's `pipelineError`), except **401 → `errors.auth`** and **403 with `insufficient_scope` → `errors.scope: 'missing <scope>'`** naming the scope, so the model reads why (text-only host) and D23's "refused before the tool runs" is literally the sibling's validator refusing before its steps run. A tool name absent from `config.tools` → `errorResult('No such tool: <name>', { errors: { tool } })` (the prototype's wording).
16. **Resources: static, templated, and listed by a sibling.** `config.resources.static[]` (`uri`, `name`, `description?`, `mimeType?`, `rule: { path, method? }`), `config.resources.templates[]` (`uriTemplate` with RFC 6570 level-1 `{var}`s only, e.g. `ui://bffless/{impl}/{path+}` where `{path+}` swallows slashes, mapped to `rule.path` with the same variables, e.g. `/w/{impl}/{path+}`), and `config.resources.list?: { rule }` — a sibling whose JSON answer is the `resources` array the app enumerates (islands per published implementation are the app's knowledge, not CE's). Every resource's `_meta.ui` is generated from `config.resources.csp`: `connectDomains`/`resourceDomains` entries may be the tokens `$app` (the request's public origin: `https://` + `x-forwarded-host ?? host`) and `$storage` (the origin of a presigned GET the storage adapter mints for a probe key — the Phase-2 trick, now CE's, cached 5 min per process); `prefersBorder: true`; `mimeType` defaults to `text/html;profile=mcp-app`. `resources/read` of a templated URI runs the mapped sibling (`GET`) and answers its text body; a sibling 404 → JSON-RPC `-32002 Resource not found: <uri>`.
17. **One rule, three methods, one step.** The MCP rule becomes `methods: [GET, POST, DELETE]` with a single `mcp_handler` step; the handler answers `GET`/`DELETE` with 405 + `Allow: POST` (stateless profile), a notification with 202 and an empty body, everything else with one JSON body, `Cache-Control: no-store`, `terminates: true`. `rules/api/workflow/mcp/get/rule.yaml` is retired; the walk's `D22.getIs405` is unchanged.
18. **Compiled function scripts are cached.** `FunctionRunnerService` keeps an LRU (64 entries) of `vm.Script` keyed by sha256 of the code, and caches `validateCode` results the same way; `run()` compiles once per distinct code, not per request. Additive and invisible to rules; it is the second half of the per-request cost the Phase-2 gate report named (the first half, the 24-step chain, is Decision 17).
19. **The OAuth spike is a documented, time-boxed research task whose expected outcome is "built-in", recorded as an ADR.** Criteria the SuperTokens OAuth2Provider recipe must meet to be chosen: (a) RFC 7591 dynamic client registration for public clients with no admin step (claude.ai registers itself); (b) works with `supertokens-node` ^17 / core 12.0.10 (the recipe ships from node 21 — a major upgrade on top of the core-12 pain of ce#695); (c) RFC 8707 `resource` honoured and reflected into the token; (d) the access token can *be* an app token (Decision 1) rather than a SuperTokens-issued JWT that CE would then have to exchange. Failing any of (a)–(d) → built-in. The answer is written to `repos/ce/docs/adr/0005-built-in-oauth-authorization-server.md` (status accepted, the four criteria and the finding for each) and the story proceeds on it.
20. **The authorization server lives on the admin host, under `/api/oauth/*`.** Issuer = `https://admin.<primary>` (the origin `FRONTEND_URL` names); metadata at `/.well-known/oauth-authorization-server` (RFC 8414) — which needs one nginx `location` on the admin vhost (`docker/nginx/sites-available/main.conf.template`, `docker/nginx-ssl.conf`, and the `render-main-conf.test.sh` assertion), because the admin `location /` serves the SPA's `index.html` (verified 2026-09-02: `GET https://admin.j5s.dev/.well-known/oauth-authorization-server` → 200 HTML). Endpoints: `POST /api/oauth/register` (DCR), `GET /api/oauth/authorize`, `GET|POST /api/oauth/consent` (the SPA's consent page talks to these), `POST /api/oauth/token`, `POST /api/oauth/revoke` (RFC 7009). The pending authorization request is a **signed JWT** (`JWT_SECRET`, 10 min) carried through the consent page as `?request=` — no table for it. Persistent state: `oauth_clients` (`client_id`, `client_name`, `redirect_uris` jsonb, `created_at`, `last_used_at`), `oauth_authorization_codes` (`code_hash`, `client_id`, `user_id`, `project_id`, `scopes`, `code_challenge`, `redirect_uri`, `resource`, `expires_at` 10 min, `used_at`), `oauth_refresh_tokens` (`token_hash`, `client_id`, `user_id`, `project_id`, `scopes`, `app_token_id` the access token it last issued, `expires_at` 30 d, `rotated_at`; rotation on use, reuse of a rotated token revokes the family — OAuth 2.1 §4.3.1). The access token is an `app_tokens` row (`kind: 'oauth'`, `client_id`, 1 h).
21. **`resource` (RFC 8707) is how a token finds its project, and the consent screen is where a scope is narrowed.** `authorize` requires `resource`; its host resolves through `domain_mappings` (the same `resolveAccessControlByDomain` lookup the gate uses) to a project; missing or unresolvable → `invalid_target`. Requested `scope`s must be ⊆ the resource's own protected-resource document's `scopes_supported` (CE fetches `https://<resource-host>/.well-known/oauth-protected-resource` **in-process**, the way the `/w/` forwarders reach an alias) — unknown scope → `invalid_scope`. The consent page (`/oauth/consent` in the admin SPA) shows client name, project, and one checkbox per requested scope, all ticked; the member may untick (that is the gate's "read-only consent cannot start a run" test) and the code carries the granted subset. The token endpoint verifies PKCE `S256` (2.1: `plain` refused), the exact `redirect_uri`, single use, and answers `{ access_token, token_type: 'Bearer', expires_in: 3600, refresh_token, scope }`.
22. **DCR is open, public-client-only, and rate-limited by what exists.** `register` accepts `redirect_uris` (https, or `http://localhost` / `http://127.0.0.1` with any port), `client_name`, `token_endpoint_auth_method: 'none'` (anything else → `invalid_client_metadata`), `grant_types` ⊆ `['authorization_code', 'refresh_token']`; answers `client_id` (uuid) and echoes the metadata (RFC 7591 §3.2.1); no `client_secret`. The global `ThrottlerModule` (100/min/IP) is the only rate limit; GC of never-used clients is deferred.
23. **The app ships its protected-resource document as a rule, and derives every URL.** `rules/_custom/well-known/get.rule.yaml` becomes `pathPattern: /.well-known/oauth-protected-resource*` (RFC 9728 §3: the path-suffixed form `/.well-known/oauth-protected-resource/api/workflow/mcp` is what a client tries first), `bypassVisibility: true`, no validators, one `function_handler` (`wellknown.fn.js` from `src/mcp/wellKnown.ts`, bundling the catalog's `SCOPES`) answering `{ resource: 'https://<x-forwarded-host>/api/workflow/mcp', authorization_servers: ['https://admin.<host minus its first label>'], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'BFFless Workflow' }` + a `response_handler`. The `admin.` derivation is the harness's own `lib/adminOrigin.ts` rule (memory: derive instance hosts, never hardcode); it assumes a primary-domain subdomain install — a custom-domain install would need CE to advertise its issuer, filed as a follow-up in the closeout, not solved here. The Phase-2 `/.well-known/*` 404 rule is retired by this one (an unmatched `/.well-known/x` falls back to the SPA again, which no longer matters: discovery targets the one path).
24. **The walks mint their own token.** The `mcp` walk opens the browser session first (relay login, as `page-tools` does), mints a token through the logged-in Playwright context (`context.request.post('https://admin.<domain>/api/app-tokens', …)` — the SuperTokens cookie is on `.<domain>`; no CORS because it is not an in-page fetch), scopes all three, expiry 1 day, name `workflow-live mcp <stamp>`, and passes `Authorization: Bearer` to the SDK transport (`requestInit.headers`) and to `rawPost`/`rawGet`; it revokes the token at the end. `WORKFLOW_APP_TOKEN` in the env skips the mint (a person's token). Two **new** checks join the walk after story 7 (`D23.bearerIsMember`: `workflow.status` over the endpoint answers, and anonymous `initialize` is 401; `D23.readOnlyCannotSubmit`: a read-only token's `workflow.submit` → `errors.scope` naming `workflow:run`) — the 24 stay as they are. A new `oauth` walk (story 9) drives the code flow headlessly: DCR → `authorize` in the logged-in page → click Approve → capture the redirect on a local listener → PKCE exchange → `workflow.status` with the access token → refresh → a narrowed consent's `workflow.start` refused.
25. **The headless driver's app-token option is the driver's own calls, not the page's session.** `WORKFLOW_APP_TOKEN` → `Authorization: Bearer` on every `/api/workflow/*` call the driver makes itself (reads *and* writes — a token is the member, so the identity-mismatch that kept `WORKFLOW_TOKEN` to GETs is gone; `WORKFLOW_TOKEN`/`X-API-Key` keeps working as the legacy path). The browser login stays the relay: a token cannot mint a SuperTokens session (the landmine), and a private deployment's *document* load carries no `Authorization` header, so the SPA could never boot on a token alone. Minting a relay (`bffless_access`) session from a token — the ADR-0001 shape, with scopes carried in the JWT — is the real "driver without a login" and is deferred to a filed follow-up.
26. **Story 7's apps follow-up keeps the prototype honest until story 8 replaces it.** With `auth_required` in front of the monolithic Phase-2 rule, per-tool scopes cannot yet be validator-enforced (one rule, fifteen tools, `data_update` writes rows directly). `route.ts` reads `data.user.scopes` (Decision 6) and, for a token, refuses a tool whose `scopeOf(name)` (host tools: `submit`/`annotate`/`pipeline` → `workflow:run`, `stepView` → `workflow:read`) is missing with the same `errors.scope: 'missing <scope>'` result Decision 15 standardises — so the gate's "read-only consent cannot submit" holds from story 7 on, and the check is deleted in story 8 when every tool is its own rule. Every sibling `http_request` step switches from `x-api-key: secrets.WORKFLOW_MCP_KEY` to `forwardAuth: true` (the caller's `authorization` + `cookie`), the `identity` step and the `-32000 not enabled` answer go, and `WORKFLOW_MCP_KEY` is deleted from the scratch project when the story lands there.
27. **The `/api/workflow/*` rules get one scope each, from one table.** `packages/workflow-agent-tools/src/scopes.ts` gains `RULE_SCOPES` (path → scope): `workflow:read` — `runs/get`, `run/get`, `whoami/get`, `project/get`, `aliases/get` (a forwarder: scope recorded, not enforced — it has no validators); `workflow:run` — `runs/post`, `run/update`, `run-step`, `run/lease`, `run/delete`, `run/fork`; `workflow:files` — `files/prepare`, `files/register`, `files/sign`, `uploads/workflows/[...path]`. The fence test asserts every pipeline rule's `auth_required.config.requiredScopes` equals `[RULE_SCOPES[path]]`, importing the catalog so the two cannot drift. (`run/delete` is `workflow:run`, not a fourth scope: the ownership gate inside the rule still applies, and `delete` is not a catalog tool — a Phase-4 `workflow.http` caller reaching it is a run-scoped agent by definition.)
28. **CE issues are filed as the plan merges, one per story, without a readiness label.** Titles are the PR titles below; bodies link this plan and spec 10; labels `enhancement`. No `ready-for-agent` (they are built in the loop by this session, not by `ce-implement`) and no `ready-for-human` (nothing is blocked on a maintainer decision — the spec ratified every fork). Each CE PR says `Closes #<n>`.

## Deferred out of this plan, explicitly

- **Session-from-token** (`POST /_bffless/auth/session-from-key` accepting a Bearer app token and carrying its scopes in the relay JWT) — the driver-without-a-login; filed at closeout with Decision 25's reasoning.
- **CE advertising its own issuer to apps** (a deployment-provenance field an app's `.well-known` rule could read instead of deriving `admin.<domain>`) — needed for custom-domain installs; filed at closeout.
- **Honouring `allowApiKey`** (ce#615) and **run-as users for schedules** (ce#614) — untouched.
- **`alias://` targets** (ce#698) — the invoker is its runtime cousin; the spelling stays a nice-to-have.
- **Admin cross-user token listing / revocation**, DCR client GC, OIDC discovery (`/.well-known/openid-configuration`), token introspection (RFC 7662) — none needed by claude.ai's flow.
- **The k8s workspace nginx ConfigMap** (`repos/platform/adapters/kubernetes/charts/workspace/templates/configmap-nginx.yaml`) gaining the same `/.well-known/oauth-authorization-server` location — a platform PR after CE's, noted at closeout, not done here (j5s is docker-compose).
- **Per-tool `_meta` in the catalog package** (so `_meta.ui.resourceUri` need not be patched on in `listedTools`) — the generated YAML makes it moot for now.
- Everything Phase 4: the run view, `workflow.http`, `start`/`resume` linking it, lease/take-over from an agent host.

## Global Constraints

- **Worktrees only, in both repos, under `.claude/worktrees/`** (both are git-ignored — verified): apps stories branch off `origin/epic/agent-embedding` (`git worktree add .claude/worktrees/<name> -b <branch> origin/epic/agent-embedding`); CE stories branch off `origin/main` (`git worktree add .claude/worktrees/<name> -b feat/<n>-<slug> origin/main`, then `pnpm install --frozen-lockfile`). The shared checkouts are never switched. CE's `.claude/scripts/worktree-gc.sh` is run (dry, then `--apply`) at the start of each CE story.
- **Branching and merging:** apps PRs target `epic/agent-embedding`, never `main`; the epic PR (#571) is a human's merge and **must not land before story 7's apps follow-up fronts the MCP rule** (note on #571). CE PRs target CE `main`; CE squash-merges. Story PRs merge on green; each merge checks its story off on #554.
- **PR titles are release commits in both repos** (apps checklist §3, CE checklist Part 2; `pr-title.yml` gates CE): CE — `feat(auth): app tokens — scoped user-bound bearers honoured by the visibility gate and auth_required (requiredScopes); per-rule bypassVisibility` · `feat(pipelines): mcp_handler — a generic stateless MCP server step executing tools against sibling rules in-process` · `feat(auth): OAuth 2.1 authorization server — DCR, PKCE, RFC 8414/9728/8707; access tokens are app tokens`; apps — `docs(workflow): the M5 Phase 3 plan — CE app tokens, mcp_handler, OAuth 2.1 (#554)` · `feat(workflow): app tokens front the MCP endpoint — requiredScopes on every rule, the identity probe retired, Bearer in the walks and the driver` · `feat(workflow): the MCP endpoint on CE's mcp_handler — one step, one sibling rule per tool, src/mcp shrinks to the app's own words` · `feat(workflow): OAuth discovery as a rule — /.well-known/oauth-protected-resource served despite visibility; the oauth walk`. **Never edit a `CHANGELOG.md`** in either repo.
- **CE stays app-agnostic** (D22): no string "workflow" in CE outside tests' fixtures; no app-aware endpoint; no `/_bffless/*` addition; `McpModule.forRoot` (`@rekog/mcp-nest`, CE's platform-admin server) is not touched, imported, or shared with `mcp_handler`.
- **CE auth changes are high-stakes and additive** (the visibility gate and `auth_required` are live for every j5s app): every current credential path keeps its exact behaviour — `X-API-Key`, sessions and custom-domain cookies pass every scope check; a `bypassVisibility` default of `false` changes nothing for stored rules; new columns have defaults; new DTO fields are optional; the CLI keeps accepting every manifest it accepts today. Ask the person before anything irreversible or that touches live members: deleting the scratch project, rotating/deleting keys or secrets on `bffless/workflow`, granting roles.
- **Migrations are the person's step** (memory `ce-no-local-db`): the plan says *what* the schema change is and the migration name to use; the person runs `cd apps/backend && pnpm db:generate` in the story worktree and pastes the file name; the session reviews the SQL. Never hand-write a migration; never suggest `db:migrate` here.
- **CE verification chain per PR** (`pr-tests.yml`): `pnpm --filter backend exec tsc --noEmit && pnpm --filter frontend exec tsc --noEmit`, `pnpm --filter backend test -- <touched specs>` then the full `pnpm test`, `pnpm --filter backend format:check && pnpm --filter frontend format:check` (prettier gates CI), `pnpm --filter cli build && pnpm --filter cli test` when `packages/cli` changes, `bash docker/nginx/render-main-conf.test.sh` when a template changes. Lint is not in CI and already red on `main`; only lint what the PR touches.
- **Apps verification chain per PR** (checklist §4–§7): `pnpm --filter @bffless/workflow-agent-tools lint && build && test:run` when the package changes; `pnpm --filter workflow mcp:build` then `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build`; `pnpm --filter @bffless/workflow-headless lint && build && test:run` and `pnpm --filter @bffless/workflow-live lint && build && test:run` when they change (build `workflow-lint`, `workflow-agent-tools` and `workflow-headless` first in a fresh worktree — #581's note); `pnpm apps:check`; the `mcp` (and later `oauth`) walk against the scratch harness with real counts pasted in the PR body.
- **The catalog owns the tool→scope map** (`TOOL_SCOPES`, and from story 7 `RULE_SCOPES`); the app's rules and the generated MCP config read it; nothing re-declares a scope string.
- **Results stay catalog `CallToolResult`s in both adapters** (D19): the MCP rule's tool siblings build theirs with `textResult`/`errorResult`; `mcp_handler` passes a `content[]`-bearing body through verbatim.
- **Dev instance only; no bffless.dev.** Live targets are the scratch public project `bffless/workflow-mcp` (`workflow-mcp.j5s.dev`, kept for this phase — apps#554 maintainer decision 2026-09-02) for every walk, and the members-only `bffless/workflow` harness (`workflow.j5s.dev`) for the gate. Both need the j5s CE image to carry the story's release. The `j5s.dev` Cloudflare zone's AI-bot blocking stays **off** (it 403s Anthropic's user agents; a person's setting).
- **Provisioning goes through the j5s MCP** (`mcp__j5s-dev__*`): secrets (`delete_secret WORKFLOW_MCP_KEY` when retired), rule-set attachments, response-header rules; a project-scoped key for `bffless/workflow` is minted with `create_api_key` only if none is on disk, used for hand pushes, and named in the README.

## Cross-repo sequencing — how a CE change reaches j5s.dev, and what each apps PR waits on

**The CE path (verified from `repos/ce`):** a CE PR squash-merges to `main` → `preview.yml` publishes a pre-release `preview-YYYY-MM-DD-<sha>` with `ghcr.io/bffless/ce-{backend,frontend}:preview` images (and `bffless@next` on npm when `packages/cli` changed) → `release-please.yml` keeps a `chore(main): release X.Y.Z` PR open; **merging it is a person's step** and cuts `vX.Y.Z` + `:latest` images (~7 min, built inside the Release Please run). **j5s.dev is a docker-compose install that pins its image tags in its `.env`** (`BACKEND_TAG`/`FRONTEND_TAG`; memory `ce-deploy-pinned-tag`): after a release **the person bumps the pinned tag on the j5s box and restarts** (`scripts/update.sh`; migrations run in `backend-entrypoint.sh` on container start). Nothing in this workspace can do that step. The probe that says which image runs: a new-in-release route answering 404 means the old image (e.g. `GET https://admin.j5s.dev/api/app-tokens` → 404 = story 7 not deployed; the j5s `/api/health` `version` is a static `1.0.0`, not a release number). Latest release at planning time: **v0.4.42** (2026-08-30); confirm with the person which tag j5s pins before the first gate.

**The rules-as-code path for a new manifest key (`bypassVisibility`, Decision 8):** CE PR (backend + `packages/cli`) → merge → `bffless@next` (usable immediately by hand: `npx bffless@next rules push …`) → CE release (also releases `bffless@0.3.x` stable) → **`bffless/deploy-proxy-rules` bumps its `bffless` dependency and releases (v1.4.0 → the moving `@v1` tag)** — that repo is outside this workspace; the session opens the PR from a scratch clone (`gh repo clone bffless/deploy-proxy-rules`, `pnpm up bffless@<ver>`, `pnpm build`, commit `dist/`), the person merges and releases. Until it lands, `deploy-workflow.yml`'s "Sync proxy rules" step rejects the `.well-known` rule's unknown key (the CLI's strict manifest), so story 9's apps PR **must not merge into the epic before that bump** — and the interim on both hosts is a hand push with `npx bffless@next`. Stories 7 and 8 need no manifest change (`requiredScopes` rides inside `auth_required.config`, which the CLI, the DTO and the sync path all pass through untouched — verified: `z.record(z.unknown())`, `@IsObject() config`).

**What each apps PR waits on (the stop-and-check before opening it):**

| apps PR | needs on j5s | how the session knows |
|---|---|---|
| Story 7 apps (`feat(workflow): app tokens front the MCP endpoint …`) | CE release carrying story 7 (`app_tokens`, `requiredScopes`, Bearer in the gate) pinned on j5s | `GET https://admin.j5s.dev/api/app-tokens` answers 401 (not 404); a hand-pushed scratch rule set with `requiredScopes` refuses a read-only token's write |
| Story 8 apps (`… on CE's mcp_handler …`) | CE release carrying story 8 (`mcp_handler` registered) | `rules push` of a rule with `handler: mcp_handler` is accepted (an unknown handler is refused at sync with "Invalid handler type") |
| Story 9 apps (`OAuth discovery as a rule …`) | CE release carrying story 9 **and** `deploy-proxy-rules@v1` bumped to a `bffless` that knows `bypassVisibility` | `GET https://admin.j5s.dev/.well-known/oauth-authorization-server` answers JSON; the action's release notes name the CLI version |

The person may batch: CE stories 7 and 8 can ship in one release, in which case the story-7 and story-8 apps PRs are verified together against it. Each apps PR body states the minimum CE version it needs (`bffless/ce ≥ vX.Y.Z`) and what happens on an older image (the rule set still pushes — CE ignores unknown validator config keys — but scopes are not enforced, and an `mcp_handler` rule is refused at sync).

**Redeploying the two live surfaces from the epic:** the scratch project follows the README's redeploy sequence (rules by hand with `npx bffless@next`, the harness zip by `curl`); the `bffless/workflow` harness is redeployed by dispatching `deploy-workflow.yml` on `epic/agent-embedding` (`gh workflow run deploy-workflow.yml --ref epic/agent-embedding`) — which pushes the epic's rule set to `bffless/workflow` with `--prune` and uploads the epic build to alias `workflow`; that is what puts the Phase-3 rules on the gate host. A `main` merge overwrites it later (memory `j5s-harness-serves-epic-agent-embedding`).

## File structure

```
bffless/ce  (three PRs into main; each its own worktree)
  apps/backend/src/
    db/schema/app-tokens.schema.ts            app_tokens table (+ index.ts export)                         (Task 1)
    db/schema/proxy-rules.schema.ts           + bypassVisibility column; ProxyRule type                    (Task 5)
    db/schema/oauth-clients.schema.ts, oauth-authorization-codes.schema.ts, oauth-refresh-tokens.schema.ts (Task 16)
    drizzle/<generated>.sql                   two migrations, generated by the person                       (Tasks 1, 16)
    auth/app-token.util.ts (+ .spec.ts)       resolveAppToken(header) → ResolvedAppToken | null; hashToken (Task 2)
    auth/optional-auth.guard.ts (+ spec)      Bearer app token between X-API-Key and session               (Task 3)
    auth/api-key.guard.ts (+ spec)            Bearer app token as a project-fenced pseudo-key              (Task 3)
    auth/decorators/current-user.decorator.ts CurrentUserData.credential, appTokenId, scopes               (Task 3)
    proxy-rules/proxy.middleware.ts (+ spec)  getOptionalUser + Bearer; isApiRequest + Authorization;
                                              TOKEN_PROJECT_MISMATCH; bypassVisibility short-circuit;
                                              401/403 headers (Task 15); resolution helpers extracted (Task 9)
    proxy-rules/rule-resolution.ts (+ spec)   resolveRuleSetIdsForAlias, resolveProjectDefaultRuleSetIds, findMatchingRule, matchesPattern (Task 9)
    proxy-rules/rule-invoker.service.ts (+ spec)  RuleInvokerService.invoke(...)                           (Task 10)
    proxy-rules/proxy-rules.module.ts         exports RuleInvokerService                                    (Task 10)
    proxy-rules/dto/create-proxy-rule.dto.ts, update-proxy-rule.dto.ts, sync-proxy-rule-set.dto.ts  bypassVisibility (Task 5)
    proxy-rules/export-format.util.ts (+ spec)  bypassVisibility in ExportedRule / key order               (Task 5)
    proxy-rules/proxy-rules.service.ts        create/update persist bypassVisibility                       (Task 5)
    pipelines/types.ts                        AuthRequiredConfig.requiredScopes; HandlerType 'mcp_handler' (Tasks 4, 11)
    pipelines/execution/pipeline-context.interface.ts  PipelineUser.credential, scopes                     (Task 4)
    pipelines/execution/validators/auth-required.validator.ts (+ .spec.ts)  requiredScopes; project binding (Task 4)
    pipelines/execution/step-handler.interface.ts  McpHandlerConfig                                        (Task 11)
    pipelines/handlers/function.handler.ts    data.user.credential / scopes                                (Task 4)
    pipelines/handlers/mcp.handler.ts (+ .spec.ts)  the generic step; pipelines/handlers/index.ts; pipelines.module.ts (Tasks 11–13)
    pipelines/mcp/jsonrpc.ts, mcp/protocol.ts, mcp/results.ts, mcp/resources.ts (+ specs)  envelope, method switch, answer mapping, CSP/templates (Tasks 11–12)
    pipelines/function-runner.service.ts (+ spec)  compiled-script LRU                                     (Task 14)
    app-tokens/app-tokens.module.ts, .controller.ts, .service.ts, .dto.ts (+ specs)  mint / list / revoke   (Task 6)
    oauth/oauth.module.ts, oauth.controller.ts, oauth.service.ts, oauth.dto.ts, pkce.util.ts, oauth-metadata.controller.ts (+ specs) (Tasks 17–20)
    app.module.ts                             AppTokensModule, OAuthModule                                  (Tasks 6, 17)
  apps/frontend/src/
    services/appTokensApi.ts, components/settings/AppTokensTab.tsx (+ test), pages/UserSettingsPage.tsx    (Task 7)
    services/oauthApi.ts, pages/OAuthConsentPage.tsx (+ test), App.tsx route /oauth/consent               (Task 21)
  packages/cli/src/format/{types,manifest}.ts, compile/{build,decompile}.ts (+ tests)  bypassVisibility   (Task 5)
  docker/nginx/sites-available/main.conf.template, docker/nginx-ssl.conf, docker/nginx/render-main-conf.test.sh  the AS metadata location (Task 18)
  docs/adr/0005-built-in-oauth-authorization-server.md                                                     (Task 16)
  CONTEXT.md                                  glossary: App token, Scope, Bypass visibility, Authorization server (Tasks 8, 22)

bffless/apps  (four PRs into epic/agent-embedding; each its own worktree)
  docs/superpowers/plans/2026-09-03-workflow-m5-phase3-ce-auth.md   this plan                            (Task 0)
  packages/workflow-agent-tools/src/scopes.ts (+ test), README.md   RULE_SCOPES                          (Task A1)
  packages/workflow-headless/src/api.ts (+ test), README.md          WORKFLOW_APP_TOKEN → Bearer          (Task A3)
  packages/workflow-live/src/mcp-client.ts, env.ts, args.ts, token.ts (+ test), walks/mcp.ts, walks/oauth.ts, walks/index.ts, README.md (Tasks A3, B3, C3)
  apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/**/rule.yaml   requiredScopes           (Task A1)
  apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/mcp/post/rule.yaml   auth_required + forwardAuth (A2) → one mcp_handler rule `mcp/rule.yaml` (B2)
  apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/mcp-tools/<tool>/post/{rule.yaml,*.fn.js}  15 sibling rules (B1–B2)
  apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/mcp-resources/get/{rule.yaml,list.fn.js}   the resources list (B2)
  apps/workflow/.bffless/proxy-rules/workflow/rules/_custom/well-known/get.rule.yaml + wellknown.fn.js      the PRM document (C1)
  apps/workflow/src/mcp/   route.ts scope check (A2, deleted in B1); tools/<tool>.ts per sibling + shared reply helpers (B1); wellKnown.ts (C1); bundle.test.ts (all)
  apps/workflow/src/rules.fence.test.ts        requiredScopes = RULE_SCOPES; mcp rule = mcp_handler; well-known = bypassVisibility (A1, B2, C1)
  apps/workflow/scripts/build-mcp.mjs          entries per tool; renders mcp/rule.yaml's tools/resources (B1)
  apps/workflow/bffless/README.md, CONTEXT.md  scratch redeploy with a token; glossary                    (A2, B2, C1)
  .claude/agents/apps-live-walk.md             walks: mcp (token), oauth                                   (A3, C3)
```

## Traceability — spec 10 / design §4 / #554 → tasks

| Spec 10 / story item | Tasks |
|---|---|
| App tokens: first-class scoped, user-bound bearers `{ user, project, scopes, expiry }`, minted/revoked by the member (API + admin UI) | 1, 2, 6, 7 |
| `auth_required` accepts `Authorization: Bearer <app-token>` wherever it accepts a session, resolves it to the member; `user.id` flows into pipelines (`startedBy`, the delete gate) | 2, 3, 4, A2 (walk: `record.startedBy`) |
| Per-rule `requiredScopes` in rules-as-code, enforced in `auth_required`: sessions pass, a token must carry the scope, effective = member ∩ scopes, never elevates | 4, A1, A2 |
| The deployment visibility gate honours Bearer app tokens like sessions | 3 (guard), 5 (middleware) |
| A served-despite-visibility mechanism for the `.well-known` rule | 5 (CE), C1 (the rule) |
| Apps: `requiredScopes` on the workflow rules from the catalog's `TOOL_SCOPES`; the MCP rule fronted by `auth_required` with Bearer; identity probe retired; driver may use an app token | A1, A2, A3 |
| Generic `mcp_handler`: a peer of `function_handler`, knows nothing about workflow; stateless Streamable HTTP + JSON-RPC; tools (name → rule path, method, schema, visibility, `_meta.ui`) and `ui://` resources (path → served file + generated CSP) in the rule's config; executes tools against sibling rules in-process as the caller | 9, 10, 11, 12, 13 |
| The workflow rule swaps its guts without the endpoint moving; `src/mcp/*` shrinks to what stays app-specific; the 24-check `mcp` walk stays green unchanged | B1, B2, B3 |
| Per-request cost (24-step chain, per-request vm compiles) | 14, 17 (Decision 17/18) |
| OAuth 2.1: DCR, PKCE, RFC 9728 protected-resource metadata, RFC 8707 resource indicators; the access token IS an app token | 16–20 |
| SuperTokens-OAuth2-provider vs built-in: in-story spike with a recorded decision | 16 (ADR-0005) |
| The app ships `/.well-known/oauth-protected-resource` as a rule pointing at CE's authorization endpoints, served despite visibility; scopes v1 `workflow:read`/`run`/`files` | C1, C2 |
| Phase gate: claude.ai DCR → consent → tokens against `workflow.j5s.dev` (private); `workflow.status` as the member with `startedBy` the member's id; read-only consent cannot start a run; `mcp` walk 24/24 on scratch; screenshots on the story-9 PR | C3, C4, G1 |
| Stories 7–9 checked off on #554; "Phase 3 as shipped" on this plan; CE issues filed at plan merge | 0, 8, 22, G2 |

---

# Phase A — Story 7: app tokens (CE Tasks 0–8, then apps Tasks A1–A3)

*Deliverable (CE): a CE release in which `Authorization: Bearer bfat_…` is a member wherever a session is — the public controller, the proxy gate, pipelines — with `requiredScopes` enforced in `auth_required`, `bypassVisibility` on rules, and a member-facing mint/list/revoke API + admin tab. Branch `feat/<n>-app-tokens`, worktree `repos/ce/.claude/worktrees/app-tokens`. Deliverable (apps): every `/api/workflow/*` rule declares its scope, the MCP rule is fronted by `auth_required` and runs as the caller, the walks and the driver carry a token. Branch `feat/m5-app-tokens`, worktree `repos/apps/.claude/worktrees/m5-app-tokens`.*

### Task 0: the plan PR, the CE issues

- [ ] Worktree `m5-phase3-plan` (branch `docs/m5-phase3-plan` off `origin/epic/agent-embedding`); commit this file as `docs(workflow): the M5 Phase 3 plan — CE app tokens, mcp_handler, OAuth 2.1 (#554)`; PR into `epic/agent-embedding`; merge on green (docs only — no path-filtered gate triggers). Comment on #554: "Phase 3 kicked off; plan merged (#<n>); CE issues ce#<a> ce#<b> ce#<c>."
- [ ] File three `bffless/ce` issues (`gh issue create -R bffless/ce --label enhancement`), titles = the three CE PR titles in Global Constraints, bodies: one paragraph of what and why (from Decisions 1–11 / 12–18 / 19–23), a link to this plan on the epic branch and to spec 10 §Auth / §The MCP endpoint, the acceptance line from the traceability table, and "built in the loop from the apps plan; not `ready-for-agent`". Record the numbers here (edit this section in the story-7 apps PR) and in the CE PR bodies as `Closes #<n>`.

### Task 1: the `app_tokens` schema and its migration

**Files:** Create `apps/backend/src/db/schema/app-tokens.schema.ts`; modify `apps/backend/src/db/schema/index.ts` (export); the person generates `apps/backend/drizzle/<nnnn>_app-tokens.sql`.

**Interfaces:**

```ts
// apps/backend/src/db/schema/app-tokens.schema.ts
import { pgTable, uuid, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.schema';
import { projects } from './projects.schema';

/** Member-bound, project-bound, scoped bearer credentials (spec: app tokens). Hash-indexed; never bcrypt. */
export const appTokens = pgTable(
  'app_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(), // sha256 hex of the raw token
    tokenPrefix: varchar('token_prefix', { length: 16 }).notNull(),      // `bfat_` + 7 chars, for display
    userId: uuid('user_id').references(() => users.id).notNull(),
    projectId: uuid('project_id').references(() => projects.id).notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    kind: varchar('kind', { length: 32 }).notNull().default('personal'), // 'personal' | 'oauth'
    clientId: varchar('client_id', { length: 255 }),                       // story 9: the OAuth client that obtained it
    expiresAt: timestamp('expires_at'),
    revokedAt: timestamp('revoked_at'),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('app_tokens_user_id_idx').on(t.userId), index('app_tokens_project_id_idx').on(t.projectId)],
);
export type AppToken = typeof appTokens.$inferSelect;
export type NewAppToken = typeof appTokens.$inferInsert;
```

- [ ] **Step 1:** write the schema file and the barrel export; `pnpm --filter backend exec tsc --noEmit` green.
- [ ] **Step 2 (the person):** `cd apps/backend && pnpm db:generate` in the worktree — Drizzle shows one new table; name the migration `app-tokens`. Paste the file name; review the SQL: `CREATE TABLE "app_tokens"` with the two indexes and the unique on `token_hash`, no `ALTER` of existing tables. Forward-safe (checklist Part 1).
- [ ] **Step 3: commit** `feat(auth): app_tokens schema`.

### Task 2: `resolveAppToken` — one resolver for every call site

**Files:** Create `apps/backend/src/auth/app-token.util.ts`, `apps/backend/src/auth/app-token.util.spec.ts`.

**Interfaces:**

```ts
// apps/backend/src/auth/app-token.util.ts
export const APP_TOKEN_PREFIX = 'bfat_';
export const APP_TOKEN_BYTES = 32;

export interface ResolvedAppToken {
  user: { id: string; email: string; role: string };
  token: { id: string; projectId: string; scopes: string[]; kind: string; clientId: string | null };
}

/** `Bearer bfat_…` → the raw token, or null for anything else (a missing header, a JWT, a different scheme). */
export function bearerAppToken(authorization: string | string[] | undefined): string | null;
/** sha256 hex — deterministic on purpose: the token has 256 bits of entropy, bcrypt is for passwords. */
export function hashToken(raw: string): string;
/** `{ raw, hash, prefix }` for a fresh token. */
export function mintToken(): { raw: string; hash: string; prefix: string };
/**
 * The member a bearer app token stands for, or null when the header carries no app token,
 * the token is unknown, expired, revoked, or its user is missing/disabled.
 * Touches `last_used_at` at most once per LAST_USED_WRITE_INTERVAL_MS per token (Decision 10).
 */
export async function resolveAppToken(authorization: string | string[] | undefined): Promise<ResolvedAppToken | null>;
/** The shape every call site attaches to `request.user` for a token (Decision 3). */
export function requestUserFromAppToken(resolved: ResolvedAppToken, options: { pinRoleLikeApiKey: boolean }): {
  id: string; email: string; role: string;
  credential: { kind: 'app_token'; appTokenId: string; projectId: string; scopes: string[] };
  apiKeyProjectId?: string;  // only when pinRoleLikeApiKey (the admin API)
  appTokenId: string;
};
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;
```

`resolveAppToken` reads `db.select().from(appTokens).where(eq(appTokens.tokenHash, hash)).limit(1)`, then the user (`users` by id; `disabled` → null); `expiresAt < now` → null; `revokedAt` set → null.

- [ ] **Step 1: failing tests** (`jest.mock('../db/client')` the way `api-key.guard.spec.ts` does): `bearerAppToken('Bearer bfat_abc') === 'bfat_abc'`, `bearerAppToken('Bearer eyJ…') === null`, `bearerAppToken(undefined) === null`, `bearerAppToken(['Bearer bfat_x'])` uses the first; `mintToken().raw` matches `/^bfat_[0-9a-f]{64}$/`, `hash === hashToken(raw)`, `prefix === raw.slice(0, 12)`; `resolveAppToken` → null for unknown hash, expired, revoked, disabled user; the happy path returns user + token and issues one `update` for `lastUsedAt`; a second call within 60 s issues none; `requestUserFromAppToken(r, { pinRoleLikeApiKey: true })` on an admin gives `role: 'user'` and `apiKeyProjectId`; on a `member` gives `role: 'member'`; with `false` gives the real role and no `apiKeyProjectId`.
- [ ] **Step 2:** implement; `pnpm --filter backend test -- app-token.util` green; `format`.
- [ ] **Step 3: commit** `feat(auth): resolveAppToken — bearer app tokens by hash, last-used throttled`.

### Task 3: the guards accept Bearer app tokens

**Files:** Modify `apps/backend/src/auth/optional-auth.guard.ts` (+ `.spec.ts` — create if absent), `apps/backend/src/auth/api-key.guard.ts` (+ `.spec.ts`), `apps/backend/src/auth/decorators/current-user.decorator.ts`.

**Behaviour:** `OptionalAuthGuard.canActivate`: after the `x-api-key` attempt and before `trySessionAuth`, `const resolved = await resolveAppToken(request.headers.authorization)`; when non-null, `request.user = requestUserFromAppToken(resolved, { pinRoleLikeApiKey: false })` and return. `ApiKeyGuard.canActivate`: when there is no `x-api-key`, try the Bearer app token **before** `validateSession`; on success `request.user = requestUserFromAppToken(resolved, { pinRoleLikeApiKey: true })`; a `Bearer` that is not an app token falls through to the session path exactly as today. `CurrentUserData` gains `credential?`, `appTokenId?` (typed as the util's shape).

- [ ] **Step 1: failing tests** — `api-key.guard.spec.ts`: a request with only `Authorization: Bearer bfat_…` (mock `resolveAppToken`) activates with `request.user.apiKeyProjectId === token.projectId`, `role` pinned; an unknown `bfat_` token falls to the session path and, with no session, throws `UnauthorizedException` (unchanged wording `Authentication required`); `Authorization: Bearer <jwt>` never calls the resolver's DB path (the prefix check short-circuits). `optional-auth.guard.spec.ts`: Bearer app token → `request.user.credential.kind === 'app_token'` with the real role; no header → `request.user` undefined; precedence: a request with both `x-api-key` (valid) and Bearer → the API key wins.
- [ ] **Step 2:** implement; tests + `tsc` + `format`.
- [ ] **Step 3: commit** `feat(auth): OptionalAuthGuard and ApiKeyGuard accept Bearer app tokens`.

### Task 4: `auth_required` — `requiredScopes`, the project binding, `user.scopes`

**Files:** Modify `apps/backend/src/pipelines/types.ts`, `apps/backend/src/pipelines/execution/pipeline-context.interface.ts`, `apps/backend/src/pipelines/execution/validators/auth-required.validator.ts`, create `…/validators/auth-required.validator.spec.ts`; modify `apps/backend/src/pipelines/handlers/function.handler.ts` (+ `function.handler.spec.ts`), `apps/backend/src/pipelines/errors/validation.error.ts` (details on `AuthorizationError`).

**Interfaces:**

```ts
// pipelines/types.ts
export interface AuthRequiredConfig {
  roles?: string[];
  allowApiKey?: boolean;           // unchanged, still unread (ce#615)
  /** Scopes an app token must carry (D23). Sessions, API keys and custom-domain cookies are never scope-checked. */
  requiredScopes?: string[];
}
// pipelines/execution/pipeline-context.interface.ts
export interface PipelineUser {
  id: string; email?: string; role?: string; groups?: string[];
  /** How the caller authenticated; absent on pre-tokens callers (treated as a session). */
  credential?: 'session' | 'api_key' | 'app_token' | 'custom_domain';
  /** Present only for app tokens: what the credential was delegated. */
  scopes?: string[];
  /** Present only for app tokens: the project the token is bound to. */
  tokenProjectId?: string;
}
// errors/validation.error.ts
export class AuthorizationError extends PipelineError {
  constructor(message: string, details?: { missingScopes?: string[]; code?: 'insufficient_scope' | 'token_project_mismatch' })
}
export const SCOPE_PATTERN = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;
```

`validateConfig`: `requiredScopes` must be an array of strings each matching `SCOPE_PATTERN`. `validate`: (1) no user → `AuthenticationRequiredError` (unchanged); (2) roles (unchanged); (3) `user.credential === 'app_token' && user.tokenProjectId && user.tokenProjectId !== context.projectId` → `AuthorizationError('This token is bound to another project', { code: 'token_project_mismatch' })`; (4) `requiredScopes?.length && user.credential === 'app_token'` → `missing = requiredScopes.filter(s => !user.scopes?.includes(s))`; non-empty → `AuthorizationError(\`insufficient_scope: missing ${missing.join(', ')}\`, { missingScopes: missing, code: 'insufficient_scope' })`. `function.handler.ts`: `data.user` gains `credential` and `scopes` (copied when present).

- [ ] **Step 1: failing tests** — validator: `validateConfig` rejects `requiredScopes: 'x'` and `['Bad Scope']`; session user + `requiredScopes: ['workflow:run']` passes; `credential: 'api_key'` passes; token with `['workflow:read']` against `['workflow:run']` throws `AuthorizationError` whose message names `workflow:run` and `details.missingScopes` equals `['workflow:run']`; token with both passes; token with `tokenProjectId` ≠ `context.projectId` throws with `code: 'token_project_mismatch'`; empty `requiredScopes` passes any token; no user still throws `AuthenticationRequiredError`. Function handler: `data.user.scopes` present for a token user, absent for a session user.
- [ ] **Step 2:** implement; `pnpm --filter backend test -- auth-required function.handler`; `tsc`; `format`.
- [ ] **Step 3: commit** `feat(pipelines): auth_required requiredScopes — tokens must carry the scope, sessions never scoped; user.scopes for functions`.

### Task 5: the proxy gate — Bearer, project binding, `bypassVisibility`, the 401/403 mapping

**Files:** Modify `apps/backend/src/proxy-rules/proxy.middleware.ts` (+ `proxy.middleware.spec.ts`), `apps/backend/src/db/schema/proxy-rules.schema.ts`, `apps/backend/src/proxy-rules/dto/create-proxy-rule.dto.ts`, `update-proxy-rule.dto.ts`, `sync-proxy-rule-set.dto.ts`, `apps/backend/src/proxy-rules/proxy-rules.service.ts` (create/update copy the field), `apps/backend/src/proxy-rules/export-format.util.ts` (+ `.spec.ts`, `export-cli-equivalence.spec.ts`), `packages/cli/src/format/types.ts`, `packages/cli/src/format/manifest.ts`, `packages/cli/src/compile/build.ts`, `packages/cli/src/compile/decompile.ts` (+ their tests); the person generates `drizzle/<nnnn>_proxy-rules-bypass-visibility.sql`.

**Behaviour, middleware:**
- `getOptionalUser`: after the session attempt and before `tryCustomDomainAuth`, `resolveAppToken(req.headers.authorization)` → `{ id, email, role, credential: 'app_token', scopes, tokenProjectId }` (the `PipelineUser` shape — this object *is* what `handlePipelineExecution` passes on). Session/custom-domain/api-key branches additionally set `credential: 'session' | 'custom_domain' | 'api_key'` (additive; nothing reads it but the validator).
- `isApiRequest`: `req.headers.authorization` present → `true` (no 302 for a bearer caller).
- `checkVisibilityAndAuth`: (a) new first check — `if (matchedRule?.bypassVisibility) return 'allowed'` (before the auth-proxy exemption); (b) after `getOptionalUser`, `if (user.tokenProjectId && user.tokenProjectId !== project.id)` → `res.status(403).json({ message: 'Token is bound to another project', code: 'TOKEN_PROJECT_MISMATCH' })`, `'blocked'`.
- `handlePipelineExecution` error mapping: `AUTHORIZATION_ERROR` with `details.code === 'insufficient_scope'` → 403 + `WWW-Authenticate: Bearer error="insufficient_scope", scope="<missingScopes joined by space>"`; the existing 401/403 codes unchanged.
- Schema: `bypassVisibility: boolean('bypass_visibility').notNull().default(false)` on `proxyRules`; DTOs `@IsOptional() @IsBoolean() bypassVisibility?: boolean`; service persists it on create/update (and the sync three-way merge treats it as an ordinary scalar field — check `three-way-merge.util.ts`'s field list).
- Export: `ExportedRule.bypassVisibility?: boolean`, `RULE_KEY_ORDER` gains `'bypassVisibility'` after `'debugEnabled'`, emitted only when `true` (so every existing export is byte-identical — `export-cli-equivalence.spec.ts` proves the CLI and server agree). CLI: `types.ts` and `manifest.ts` (`bypassVisibility: z.boolean().optional()`), `build.ts` passes it through, `decompile.ts` writes it when `true`.

- [ ] **Step 1: failing tests** — middleware spec (extend the existing harness): a private alias + `Authorization: Bearer` of a valid token for that project → the pipeline runs with `user.credential === 'app_token'`; same token on another project's alias → 403 `TOKEN_PROJECT_MISMATCH`; a rule with `bypassVisibility: true` on a private alias → runs anonymously; `isApiRequest` true with an `authorization` header; a pipeline that throws `AuthorizationError(…, { code: 'insufficient_scope', missingScopes: ['workflow:run'] })` answers 403 with the `WWW-Authenticate` header. Export spec: a rule with `bypassVisibility: true` exports the key after `debugEnabled`; `false`/absent exports nothing new; the CLI-equivalence spec still passes. CLI tests: `manifest.ts` accepts `bypassVisibility: true`, rejects `bypassVisibility: 'yes'`; decompile round-trips.
- [ ] **Step 2 (the person):** `pnpm db:generate` → name `proxy-rules-bypass-visibility`; review: one `ALTER TABLE "proxy_rules" ADD COLUMN "bypass_visibility" boolean DEFAULT false NOT NULL` — forward-safe.
- [ ] **Step 3:** implement; `pnpm --filter backend test -- proxy.middleware export-format export-cli-equivalence three-way-merge`; `pnpm --filter cli build && pnpm --filter cli test`; `tsc` both; `format`.
- [ ] **Step 4: commit** `feat(proxy-rules): the visibility gate honours Bearer app tokens; per-rule bypassVisibility (schema, API, export, CLI)`.

### Task 6: mint / list / revoke — `AppTokensModule`

**Files:** Create `apps/backend/src/app-tokens/app-tokens.module.ts`, `app-tokens.controller.ts`, `app-tokens.service.ts`, `app-tokens.dto.ts`, `app-tokens.service.spec.ts`, `app-tokens.controller.spec.ts`; modify `apps/backend/src/app.module.ts`.

**Interfaces:**

```ts
// app-tokens.dto.ts
export class CreateAppTokenDto {
  @IsString() @MinLength(1) @MaxLength(255) name: string;
  @Matches(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/) project: string;          // owner/repo
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @Matches(SCOPE_PATTERN, { each: true }) scopes: string[];
  @IsOptional() @IsDateString() expiresAt?: string;                        // ≤ 365 d ahead; default now + 90 d
}
export interface AppTokenView { id: string; name: string; tokenPrefix: string; project: { id: string; owner: string; name: string }; scopes: string[]; kind: string; clientId: string | null; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null; createdAt: string }
export interface CreateAppTokenResponse { data: AppTokenView; token: string }   // raw token, once
// app-tokens.service.ts
export class AppTokensService {
  /** Any member (role ≥ viewer, or global admin) may mint for a project they belong to; the caller must be a session (Decision 9). */
  create(userId: string, userRole: string | undefined, dto: CreateAppTokenDto, opts?: { kind?: 'personal' | 'oauth'; clientId?: string; expiresAt?: Date }): Promise<{ view: AppTokenView; raw: string }>;
  listMine(userId: string): Promise<AppTokenView[]>;
  revoke(id: string, userId: string): Promise<void>;   // 404 when not the caller's; idempotent on already-revoked
}
```

Controller: `@Controller('api/app-tokens') @UseGuards(SessionAuthGuard) @PublicProjectAccess()` (the same bypass `MeController` uses — the list spans projects); `POST` → 201 `CreateAppTokenResponse`; `GET` → `{ data: AppTokenView[] }`; `DELETE :id` → 204. The service resolves `owner/repo` → project (404 `Project not found`), checks `permissions.getUserProjectRole(userId, project.id)` (or global admin) → 403 otherwise; clamps expiry (400 beyond 365 d).

- [ ] **Step 1: failing tests** — service: mint stores the hash not the raw, returns the raw once, default expiry ≈ 90 d, scopes stored verbatim; a non-member → `ForbiddenException`; `listMine` excludes other users' rows and never includes `tokenHash`; `revoke` sets `revokedAt` and 404s on another user's id. Controller: guarded by `SessionAuthGuard` (an `x-api-key`-only request is refused — assert the guard class on the controller metadata, as `api-keys.controller.spec.ts` does).
- [ ] **Step 2:** implement; register the module; tests; `tsc`; `format`.
- [ ] **Step 3: commit** `feat(auth): app token mint/list/revoke API (/api/app-tokens)`.

### Task 7: the admin tab

**Files:** Create `apps/frontend/src/services/appTokensApi.ts`, `apps/frontend/src/components/settings/AppTokensTab.tsx`, `apps/frontend/src/components/settings/__tests__/AppTokensTab.test.tsx`; modify `apps/frontend/src/pages/UserSettingsPage.tsx` (`TabValue` gains `'app-tokens'`, a tab "App tokens" beside "API keys", same `canAccessApiKeys`-style gating **but for every signed-in user** — members mint tokens too), `apps/frontend/src/services/api.ts` (tag `AppToken`).

**Behaviour:** `appTokensApi` = `listAppTokens` (GET), `createAppToken` (POST), `revokeAppToken` (DELETE) with `AppToken` tag invalidation; the tab mirrors `ProjectApiKeysTab.tsx`: a `Card` with a table (Name · Project (`owner/name`) · Scopes (`Badge` each) · Kind/client · Expires · Last used · actions), a "Mint token" `Dialog` (name `Input`; project `Select` fed by `useListMyProjectsQuery` from the `me` API — add the endpoint if `services/` lacks it; scopes as a comma/space-separated `Input` turned into chips with the helper text "the app's own vocabulary — e.g. workflow:read workflow:run workflow:files"; expiry `Input type=date`), a show-once `Alert` with copy button after minting, `AlertDialog` confirm on revoke; revoked rows shown struck-through with the date.

- [ ] **Step 1: failing tests** (Vitest + Testing Library, MSW-free: mock the RTK hooks the way `__tests__/AppCard.test.tsx` mocks its api): renders the rows; minting shows the raw token exactly once and never again after closing; revoke calls the mutation with the id.
- [ ] **Step 2:** implement; `pnpm --filter frontend exec tsc --noEmit`, `pnpm --filter frontend test -- AppTokensTab`, `format`.
- [ ] **Step 3: commit** `feat(frontend): App tokens tab — mint, list, revoke`.

### Task 8: story-7 CE closeout — docs, PR, release, j5s

- [ ] **`CONTEXT.md`** glossary entries under *Authentication*: **App token** ("A member-bound, project-bound, scoped bearer (`bfat_…`) the member mints or an OAuth client obtains; wherever a session is accepted for content or pipelines the token is the member, narrowed by its scopes. Not an API key: an API key is pinned to role `user` and bound to no person." _Avoid_: "personal access token", "PAT"); **Scope** ("A string an app declares on its own rules (`requiredScopes`) and a token carries; CE only compares. Sessions are never scoped."); **Bypass visibility** ("A per-rule opt-out of the deployment visibility gate for pre-credential endpoints — OAuth discovery, webhooks.").
- [ ] Full chain: `tsc` ×2, `pnpm test` (backend + frontend), `format:check` ×2, `pnpm --filter cli test`. Paste real counts.
- [ ] **PR** into CE `main`, title as in Global Constraints, `Closes #<story-7 issue>`. Body (checklist-shaped): *Backwards compatibility* — two additive migrations, no changed semantics for any existing credential (the scope gate applies to tokens only; `bypassVisibility` defaults false), CLI additive (`bypassVisibility` optional; `bffless` ≥ new version needed only to *author* it), API-key guard precedence unchanged; *What changed*; *Verification* with counts; *Live rollout note* — "reaches j5s when the release is cut and the pinned tag is bumped; nothing to configure". Merge on green after the `ce-pr-review` run.
- [ ] Ask the person to (1) merge the release-please PR when convenient, (2) bump the j5s pinned tag, (3) tell this session the version. Record the version here in the "as shipped" block.
- [ ] Update `.claude/ce-pr-review-checklist.md` **only** if the PR taught a check worth keeping (candidate: "Bearer is now read: a change to `Authorization` handling touches three guards — keep them in step").

### Task A1 (apps): `RULE_SCOPES`, `requiredScopes` on every workflow rule, the fence

**Files:** Modify `packages/workflow-agent-tools/src/scopes.ts` (+ `test/scopes.test.ts`, `README.md`, `src/index.ts`), every `apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/**/rule.yaml` that has `auth_required`, `apps/workflow/src/rules.fence.test.ts`.

**Interfaces:**

```ts
// packages/workflow-agent-tools/src/scopes.ts (additive)
/** Path (relative to /api/workflow/, method-free) → the one scope its rule requires (Decision 27). */
export const RULE_SCOPES: Readonly<Record<string, Scope>> = {
  'runs/get': 'workflow:read', 'run/get': 'workflow:read', 'whoami/get': 'workflow:read', 'project/get': 'workflow:read', 'aliases/get': 'workflow:read',
  'runs/post': 'workflow:run', 'run/update/post': 'workflow:run', 'run-step/post': 'workflow:run', 'run/lease/post': 'workflow:run', 'run/delete/post': 'workflow:run', 'run/fork/post': 'workflow:run',
  'files/prepare/post': 'workflow:files', 'files/register/post': 'workflow:files', 'files/sign/post': 'workflow:files', 'uploads/workflows/[...path]/get': 'workflow:files',
}
export function ruleScopeOf(ruleDir: string): Scope | undefined   // the `rules/api/workflow/<...>` suffix as the key
```

Each rule: `validators: [{ type: auth_required, config: { allowApiKey: true, requiredScopes: [<scope>] } }]`. The fence test (`rules.fence.test.ts`, the `gates auth` case): for every pipeline rule under `rules/api/workflow/` that is not the `mcp/` rule, `auth.config.requiredScopes` deep-equals `[ruleScopeOf(<its dir>)]` and that value is defined; the well-known and mcp branches keep their own assertions (updated in A2/B2/C1).

- [ ] **Step 1: failing tests** — package: `RULE_SCOPES` keys are exactly the 15 above, every value ∈ `SCOPES`; app fence fails on every rule (no `requiredScopes` yet).
- [ ] **Step 2:** edit the 15 rule files; `pnpm --filter @bffless/workflow-agent-tools lint && build && test:run`; `pnpm workflow:test -- rules.fence`; `pnpm apps:check`.
- [ ] **Step 3: commit** `feat(workflow): requiredScopes on every /api/workflow rule, from the catalog's RULE_SCOPES`.

### Task A2 (apps): the MCP rule runs as the caller — `auth_required`, `forwardAuth`, the identity probe retired, the interim scope check

**Files:** Modify `apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/mcp/post/rule.yaml`, `apps/workflow/src/mcp/route.ts` (+ `route.test.ts`), `apps/workflow/src/mcp/reply.ts` (+ test; the `-32000` branch goes), `apps/workflow/src/mcp/refusals.ts` (`MISSING_SCOPE = (s: string[]) => \`insufficient_scope: missing ${s.join(', ')}\``), `apps/workflow/src/rules.fence.test.ts` (mcp branch: `auth_required` present with `allowApiKey: true` and **no** `requiredScopes` — the endpoint admits any token; the per-tool scope lives on the tool), `apps/workflow/bffless/README.md` (scratch: retire `WORKFLOW_MCP_KEY`; the walks carry a token), `apps/workflow/CONTEXT.md` (Service identity → retired; App token).

**Behaviour:** `rule.yaml`: `validators: [{ type: auth_required, config: { allowApiKey: true } }]`; the `identity` step deleted; every `http_request` step's `headers` loses `x-api-key: secrets.WORKFLOW_MCP_KEY` and gains `forwardAuth: true` (CE forwards the caller's `cookie` + `authorization`; the `x-original-uri`/`x-forwarded-host` headers stay). `route.ts`: `handler(data)` reads `data.user` (`FnUser { id?: string; credential?: string; scopes?: string[] }`); for `kind === 'toolsCall'` with `user.credential === 'app_token'`, `need = scopeOf(tool) ?? HOST_TOOL_SCOPES[tool]` (`workflow.submit`/`annotate`/`pipeline` → `workflow:run`, `workflow.stepView` → `workflow:read`); when `need` is defined and not in `user.scopes`, set `route.scopeMissing = need` and clear every I/O flag (`needsRun`, `isRuns`, `isList`, `isDescribe`, `isSign`, `isAliases`, …) so no step runs; `reply.ts` answers `errorResult(MISSING_SCOPE([need]), { errors: { scope: \`missing ${need}\` } })` for `route.scopeMissing`. `reply.ts` drops the `identity` gate and `ERR.NOT_ENABLED`.

- [ ] **Step 1: failing tests** — route: a token user without `workflow:run` calling `workflow.submitStep` → `scopeMissing === 'workflow:run'` and every flag false; with it → unchanged flags; a session user (`credential: 'session'`) → never `scopeMissing`; `workflow.list` needs `workflow:read`. reply: `scopeMissing` → the error result with `errors.scope`; `tools/list` no longer depends on `steps.identity`. fence: the mcp branch's new assertions; the `identity` assertion removed.
- [ ] **Step 2:** implement; `pnpm --filter workflow mcp:build`; `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build`.
- [ ] **Step 3: live (scratch, needs CE ≥ story 7 on j5s):** push the rule set by hand (README sequence, `npx bffless@next`), `mcp__j5s-dev__delete_secret WORKFLOW_MCP_KEY` on `bffless/workflow-mcp` (**ask first** — it is the scratch project, but a secret delete is irreversible); mint a token as the CI member (Task A3's helper, or by hand through the tab) and `curl -H "Authorization: Bearer $T" -X POST …/api/workflow/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` → 200; anonymous → 401 JSON `{ success:false, error:{ code:'AUTH_REQUIRED' } }` (public host: the rule's own validator); a read-only token's `workflow.submit` → `errors.scope`.
- [ ] **Step 4: commit** `feat(workflow): the MCP endpoint runs as the caller — auth_required in front, forwardAuth on every sibling call, identity probe retired, interim per-tool scope check`.

### Task A3 (apps): Bearer in the walks and the driver

**Files:** Create `packages/workflow-live/src/token.ts` (+ `token.test.ts`); modify `packages/workflow-live/src/mcp-client.ts` (`openMcp(base, { token? })` → `new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: \`Bearer ${token}\` } } })`; `rawPost`/`rawGet` take an optional token), `src/env.ts` (`appToken(env)` → `WORKFLOW_APP_TOKEN`), `src/args.ts` (USAGE), `src/walks/mcp.ts` (session first → mint → checks; two new checks; revoke in `finally`), `README.md`, `.claude/agents/apps-live-walk.md`; `packages/workflow-headless/src/api.ts` (+ `api.test.ts`, `README.md`): `ApiOptions.appToken?` → `Authorization: Bearer` on every `/api/workflow/*` call (GET and POST), `token` (X-API-Key, GET-only) unchanged; `packages/workflow-headless/src/cli.ts` reads `WORKFLOW_APP_TOKEN`.

**Interfaces:**

```ts
// packages/workflow-live/src/token.ts
export interface MintedToken { id: string; token: string; revoke(): Promise<void> }
/** Mint a 1-day app token for `project` through the logged-in Playwright context against admin.<domain> (Decision 24). */
export async function mintAppToken(context: BrowserContextLike, harness: string, project: string, scopes: string[], name: string): Promise<MintedToken>
export function adminOriginOf(harness: string): string   // the harness's lib/adminOrigin rule, restated (parity test against loginUrl's host)
```

New walk checks (appended after the 24): `D23.bearerIsMember` — `rawPost(url, initialize)` without a token → 401 (public scratch: the validator; on the private harness: the gate) **and** `workflow.status { runId }` with the token → the snapshot; `D23.readOnlyCannotSubmit` — a second token minted with `['workflow:read']` → `workflow.submit { runId, step, outputs: {} }` → `isError` with `errors.scope` containing `workflow:run` (and `workflow.status` still answers). `record.startedBy`: the parked run's row `startedBy` equals the CI member's id from `workflow.whoami` (the walk's page session), which the token-bearing MCP client must match in `workflow.runs`' `startedBy` — the "user.id flows into pipelines" proof.

- [ ] **Step 1: failing tests** — `token.test.ts`: `adminOriginOf('https://workflow-mcp.j5s.dev') === 'https://admin.j5s.dev'`, `('http://localhost:5173') === 'http://localhost:5173'`; `mintAppToken` posts to `<admin>/api/app-tokens` with `{ name, project, scopes }` and returns the raw token (fake context). `api.test.ts`: with `appToken` every call carries `authorization: Bearer …` and no `x-api-key`; with `token` only GETs carry `x-api-key` (unchanged).
- [ ] **Step 2:** implement; `pnpm --filter @bffless/workflow-headless lint && build && test:run`; `pnpm --filter @bffless/workflow-live lint && build && test:run`.
- [ ] **Step 3: live** — `pnpm workflow-live:walk mcp --harness https://workflow-mcp.j5s.dev --out /tmp/walk-mcp-7` → **26/26** (the 24 unchanged + 2). Paste the report.
- [ ] **Step 4: PR** `feat(workflow): app tokens front the MCP endpoint — requiredScopes on every rule, the identity probe retired, Bearer in the walks and the driver` into the epic; body: §1 (no deploy; the rules reach `bffless/workflow` on the epic's next dispatch — and **require CE ≥ v<story-7 release>** there: on an older image the set pushes but no scope is enforced and the MCP rule 401s every caller until the gate learns Bearer), §6 (`workflow-agent-tools` + `RULE_SCOPES`; `workflow-headless` + `appToken`), counts, the walk. Merge on green; tick story 7 on #554; comment "#571: the MCP rule is now fronted by auth_required + scopes — the Phase-2 blocker on landing the epic is cleared, Phase 3 continues."

---

# Phase B — Story 8: the generic `mcp_handler` (CE Tasks 9–14, then apps Tasks B1–B3)

*Deliverable (CE): a `mcp_handler` step type that turns one rule into a stateless Streamable-HTTP MCP server described entirely by its config, executing tools and reading resources through sibling rules in-process as the caller; plus the compiled-script cache. Branch `feat/<n>-mcp-handler`, worktree `repos/ce/.claude/worktrees/mcp-handler`. Deliverable (apps): the workflow endpoint is one `mcp_handler` rule plus fifteen small sibling rules; `src/mcp/` keeps only the app's own words; the `mcp` walk is 26/26 unchanged. Branch `feat/m5-mcp-handler`, worktree `repos/apps/.claude/worktrees/m5-mcp-handler`.*

### Task 9: extract rule resolution out of the middleware

**Files:** Create `apps/backend/src/proxy-rules/rule-resolution.ts`, `rule-resolution.spec.ts`; modify `apps/backend/src/proxy-rules/proxy.middleware.ts` (delete the private copies; import).

**Interfaces:**

```ts
// apps/backend/src/proxy-rules/rule-resolution.ts — pure functions over the db client; no Nest
export async function resolveRuleSetIdsForAlias(aliasId: string, legacyProxyRuleSetId: string | null): Promise<string[]>;
export async function resolveProjectDefaultRuleSetIds(projectId: string, legacyDefaultProxyRuleSetId: string | null): Promise<string[]>;
/** The effective rule-set ids for (project, alias) — join table → legacy column → project defaults, exactly the middleware's order. */
export async function resolveEffectiveRuleSetIds(project: { id: string; defaultProxyRuleSetId: string | null }, alias: { id: string; proxyRuleSetId: string | null } | null): Promise<string[]>;
export function matchesPattern(pattern: string, subpath: string): boolean;     // lifted verbatim
export function findMatchingRule(rules: ProxyRule[], subpath: string, method?: string): ProxyRule | null;  // lifted verbatim (isEnabled, pattern, matchesMethod)
```

- [ ] **Step 1: failing tests** — `rule-resolution.spec.ts` ports the middleware spec's pattern cases (exact, prefix `/api/*`, `**`, method arrays) against the exported functions; `resolveEffectiveRuleSetIds` returns join rows in `order`, then the legacy column, then project defaults (mocked db).
- [ ] **Step 2:** move the code; the middleware's own spec stays green untouched (behaviour identical by construction).
- [ ] **Step 3: commit** `refactor(proxy-rules): rule resolution as shared pure functions`.

### Task 10: `RuleInvokerService` — run a sibling rule in-process as the caller

**Files:** Create `apps/backend/src/proxy-rules/rule-invoker.service.ts`, `rule-invoker.service.spec.ts`; modify `apps/backend/src/proxy-rules/proxy-rules.module.ts` (provide + export), `apps/backend/src/proxy-rules/proxy.service.ts` (export `buildTargetUrl` if private).

**Interfaces:**

```ts
// apps/backend/src/proxy-rules/rule-invoker.service.ts
export interface InvokeRequest {
  projectId: string;
  /** The alias whose rule sets are searched — the calling rule's own (`context.deployment.alias`). */
  alias: string | undefined;
  deployment: PipelineContext['deployment'];
  path: string;                  // public-relative, e.g. `/api/workflow/mcp-tools/status`
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, unknown>;
  body?: unknown;
  /** The caller — passed through unchanged; the sibling's validators judge it. */
  user: PipelineUser | undefined;
  /** The parent request: headers (minus content-length/host), cookies, ip, user-agent are copied onto the synthetic one. */
  parent: Request;
  depth: number;                 // the parent's depth + 1; > MAX_INVOKE_DEPTH is refused
}
export interface InvokeAnswer { status: number; body: unknown; headers: Record<string, string>; contentType: string }
export const MAX_INVOKE_DEPTH = 1;
export type InvokeFailure =
  | { kind: 'no_rule' }                       // nothing matched (path, method) in the alias's effective sets
  | { kind: 'unsupported'; proxyType: string } // internal_rewrite | email_form_handler
  | { kind: 'recursion' }                     // the sibling contains an mcp_handler step, or depth exceeded
  | { kind: 'error'; message: string };

@Injectable()
export class RuleInvokerService {
  constructor(private readonly proxyRulesService: ProxyRulesService, private readonly pipelineExecutionService: PipelineExecutionService, private readonly proxyService: ProxyService, private readonly userGroupsService: UserGroupsService) {}
  async invoke(req: InvokeRequest): Promise<{ ok: true; answer: InvokeAnswer } | { ok: false; failure: InvokeFailure }>;
}
```

Behaviour: resolve project (by id) and alias (`deployment_aliases` by project + name) → `resolveEffectiveRuleSetIds` → `proxyRulesService.getEffectiveRulesForMultipleRuleSets` (the cached read the middleware uses) → `findMatchingRule(rules, path, method)`. `pipeline`: refuse when any step's `handlerType === 'mcp_handler'` (`recursion`); build the synthetic request `{ path, method, url: path + querystring, originalUrl, headers, query, body, cookies: parent.cookies, ip: parent.ip, socket: parent.socket, get: (h) => headers[h.toLowerCase()], header: same, protocol: parent.protocol, secure: parent.secure, __invokeDepth: depth }` (typed `as unknown as Request`; **no `res`** — Decision 14); run `executePipelineWithDebug(pipeline, syntheticReq, user, { deployment, captureDebug: false })` with the same `Pipeline` construction `handlePipelineExecution` performs (lift that construction into `proxy-rules/pipeline-from-rule.ts` and use it from both places — one more shared function, so the two cannot drift); map the result exactly as `handlePipelineExecution` maps it to `status`/`body`/`headers` (success → `response`; failure → the same code→status table: `VALIDATION_ERROR` 400, `AUTH_REQUIRED` 401, `AUTHORIZATION_ERROR` 403 (+ the `insufficient_scope` `WWW-Authenticate`), `RATE_LIMIT_EXCEEDED` 429, else 500; body `{ success: false, error }`). `external_proxy`: `fetch(buildTargetUrl(rule, path) + querystring, { method, headers: { cookie, authorization, content-type, x-forwarded-host, x-original-uri: path }, body })` with the rule's `timeout`; answer `status`/`body` (JSON when the content type says so, else text). Execution logs: not persisted for invoked siblings in this phase (the parent's `debugEnabled` log records the invoke as a step output).

- [ ] **Step 1: failing tests** — a pipeline sibling runs with the caller's `user` and answers `{ status: 200, body }` from its `response_handler`; the sibling's `auth_required requiredScopes` refuses a read-only token with 403 + `WWW-Authenticate`; no match → `no_rule`; an `internal_rewrite` match → `unsupported`; a sibling with an `mcp_handler` step → `recursion`; `depth > MAX_INVOKE_DEPTH` → `recursion`; the synthetic request carries the parent's cookie and authorization headers and **no** `res`; an `external_proxy` sibling fetches its target with the caller's `cookie` + `authorization` (mock `fetch`).
- [ ] **Step 2:** implement; `pnpm --filter backend test -- rule-invoker proxy.middleware`; `tsc`; `format`.
- [ ] **Step 3: commit** `feat(proxy-rules): RuleInvokerService — execute a sibling rule in-process as the caller`.

### Task 11: the protocol layer — `pipelines/mcp/{jsonrpc,protocol,results,resources}.ts` and `McpHandlerConfig`

**Files:** Create `apps/backend/src/pipelines/mcp/jsonrpc.ts` (+ spec), `mcp/results.ts` (+ spec), `mcp/resources.ts` (+ spec), `mcp/protocol.ts` (+ spec); modify `apps/backend/src/pipelines/execution/step-handler.interface.ts` (`McpHandlerConfig`), `apps/backend/src/pipelines/types.ts` (`HandlerType` + `'mcp_handler'`; `VALID_HANDLER_TYPES` wherever the DTO enumerates them — grep `'remote_request'`).

**Interfaces:**

```ts
// step-handler.interface.ts
export interface McpToolDecl {
  name: string; description: string; inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** MCP Apps: ['model'] (default) or ['app'] — app-only tools are callable but listed with _meta.ui.visibility. */
  visibility?: Array<'model' | 'app'>;
  _meta?: Record<string, unknown>;
  rule: { path: string; method?: 'GET' | 'POST' };   // the sibling; arguments → body (POST) or query (GET)
}
export interface McpResourceDecl { uri: string; name: string; description?: string; mimeType?: string; rule: { path: string; method?: 'GET' } }
export interface McpResourceTemplateDecl { uriTemplate: string; name: string; description?: string; mimeType?: string; rule: { path: string } }
export interface McpHandlerConfig extends BaseHandlerConfig {
  serverInfo: { name: string; version: string };
  instructions?: string;
  protocolVersions?: string[];                       // default ['2025-06-18','2025-03-26','2024-11-05']
  tools: McpToolDecl[];
  resources?: {
    static?: McpResourceDecl[];
    templates?: McpResourceTemplateDecl[];
    list?: { rule: { path: string; method?: 'GET' } }; // a sibling answering the resources array (or { resources })
    csp?: { connectDomains?: string[]; resourceDomains?: string[] }; // tokens $app / $storage allowed
  };
}
// pipelines/mcp/jsonrpc.ts — the prototype's src/mcp/jsonrpc.ts, restated in CE (parseMessage, okResponse, errorResponse, negotiateVersion, ERR incl. -32002)
// pipelines/mcp/results.ts
export function toolResultFromAnswer(answer: { status: number; body: unknown }, toolName: string): CallToolResultLike;   // Decision 15
export function noSuchTool(name: string): CallToolResultLike;
export function invokeFailureResult(f: InvokeFailure, name: string): CallToolResultLike;   // no_rule → errors.tool "…is declared but no rule answers <path>"; recursion → errors.tool 'MCP_RECURSION'
// pipelines/mcp/resources.ts
export function matchTemplate(template: string, uri: string): Record<string, string> | null;   // level-1 {var} + {var+}
export function expandPath(pathTemplate: string, vars: Record<string, string>): string;         // encodeURIComponent per segment; {var+} keeps slashes but refuses `..` segments
export function uiMeta(csp: McpHandlerConfig['resources']['csp'] | undefined, origins: { app: string; storage: string }): { ui: { csp: { connectDomains: string[]; resourceDomains: string[] }; prefersBorder: true } };
export function listedTools(tools: McpToolDecl[]): Array<Record<string, unknown>>;   // { name, description, inputSchema, annotations?, _meta } — visibility ['app'] → _meta.ui.visibility; never `rule`
// pipelines/mcp/protocol.ts
export interface ProtocolDeps { invoke(path: string, method: 'GET' | 'POST', args: Record<string, unknown>): Promise<InvokeAnswer | InvokeFailure>; origins(): Promise<{ app: string; storage: string }> }
export async function answer(config: McpHandlerConfig, request: { method: string; body: unknown }, deps: ProtocolDeps): Promise<{ status: number; body: string; headers: Record<string, string> }>;
```

`answer`: `GET`/`DELETE` → 405 `{ jsonrpc, id: null, error: { code: -32600, message: 'Method Not Allowed: this MCP endpoint is stateless — POST one JSON-RPC message' } }` + `Allow: POST`; a batch/invalid body → `-32600`; notification → 202 `''`; `initialize` → `{ protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo, instructions? }`; `ping` → `{}`; `tools/list` → `{ tools: listedTools(config.tools) }`; `tools/call` → the declared tool's sibling (`arguments` as body for POST, as query for GET) → `toolResultFromAnswer`; unknown name → `noSuchTool`; `resources/list` → `[...static]` + (`list.rule` sibling's array, each entry given `mimeType` default and `_meta`) with `_meta: uiMeta(...)`; `resources/read` → static match → sibling; else first template match → `expandPath` → sibling `GET`; 2xx → `{ contents: [{ uri, mimeType, text, _meta }] }`; anything else → `-32002 Resource not found: <uri>`; unknown method → `-32601`. Every response `Cache-Control: no-store`, `content-type: application/json`.

- [ ] **Step 1: failing tests** — port the prototype's `jsonrpc.test.ts` cases; `results`: a `content[]` body passes verbatim, a plain object wraps, a string wraps as `{ text }`, 401 → `errors.auth`, 403 with `insufficient_scope` → `errors.scope` naming the scope from the header, 500 → `errors.pipeline: 'HTTP_500: …'` + `_meta.bffless.status`; `resources`: `matchTemplate('ui://bffless/{impl}/{path+}', 'ui://bffless/hello/islands/pick-line.html')` → `{ impl: 'hello', path: 'islands/pick-line.html' }`, a `..` segment refused, `uiMeta` resolves `$app`/`$storage` and drops empty origins, `listedTools` never leaks `rule` and maps `visibility: ['app']` to `_meta.ui.visibility`; `protocol`: the whole table above with a fake `invoke`, including `initialize` echoing `2025-03-26` and defaulting an unknown version, `tools/call` of a GET-declared tool passing `arguments` as query.
- [ ] **Step 2:** implement; tests; `tsc`; `format`.
- [ ] **Step 3: commit** `feat(pipelines): the MCP protocol layer for mcp_handler — JSON-RPC envelope, tools/resources from config, answer mapping`.

### Task 12: `McpHandler` — the step

**Files:** Create `apps/backend/src/pipelines/handlers/mcp.handler.ts`, `mcp.handler.spec.ts`; modify `handlers/index.ts`, `pipelines/pipelines.module.ts` (provider; `RuleInvokerService` comes from `ProxyRulesModule`, already imported — use `@Inject(forwardRef(() => RuleInvokerService))` if Nest complains about the cycle), the storage origin helper (`StorageService` / the `signed_url` handler's minting path — expose `getSignedUrl(key, { expiresIn })` if only the handler has it).

**Behaviour:** `validateConfig`: `serverInfo.name`/`version` strings; `tools` array, each `name` unique, `description` string, `inputSchema` object, `rule.path` starting `/`, `method` ∈ GET/POST, `visibility` ⊆ model/app; `resources.templates[].uriTemplate` parses; `csp` arrays of strings. `execute`: origins = `{ app: 'https://' + (x-forwarded-host ?? host), storage: originOf(await signedUrl('<projectId>/.mcp-csp-probe', 60)) }` (cached 5 min per project in a module-level `Map`); `deps.invoke = (path, method, args) => invoker.invoke({ projectId: context.projectId, alias: context.deployment?.alias, deployment: context.deployment, path, method, query: method === 'GET' ? args : undefined, body: method === 'POST' ? args : undefined, user: context.user, parent: context.request, depth: (context.request.__invokeDepth ?? 0) + 1 })`; `answer(...)` → `StepResult { success: true, terminates: true, output: { status, body, headers: { ...headers, 'Content-Type': 'application/json' } } }` (the shape `buildResponse` reads, and the shape `respond` steps produce today — `handlePipelineExecution` sends it verbatim with `res.send`).

- [ ] **Step 1: failing tests** — `validateConfig` rejects a duplicate tool name, a missing `rule.path`, a bad `visibility`; `execute` on `tools/list` returns the listed tools with `terminates: true`; `tools/call` routes to the invoker with the caller's user and the parent request; a `GET` request answers 405; the storage origin is probed once per 5 min.
- [ ] **Step 2:** implement; register; `pnpm --filter backend test -- mcp.handler step-handler.registry pipeline-execution`; `tsc`; `format`.
- [ ] **Step 3: commit** `feat(pipelines): mcp_handler — one step, a whole stateless MCP server from its config`.

### Task 13: the sync path and the admin UI know the handler

**Files:** Modify `apps/backend/src/proxy-rules/dto/create-proxy-rule.dto.ts` (the handler-type enum used by `PipelineStepDto`), `apps/frontend/src/components/proxy-rules/ProxyRuleForm.tsx` (the handler picker lists `mcp_handler` with a one-line description; **no config editor** — the config is authored as code; the form shows the JSON config read-only, as it does for handlers without a bespoke editor, if such a fallback exists — check `ProxyRuleForm.tsx`'s default branch), `apps/backend/src/mcp/tools/proxy-rules.tools.ts` (CE's platform-admin MCP: its `create_proxy_rule` handler-type enum, so `mcp__j5s-dev__create_proxy_rule` can write one — **an enum entry, not a feature**; D22 is not touched), `packages/cli` — nothing (the CLI passes `handler:` strings through).

- [ ] **Step 1:** grep every `'remote_request'` literal in backend + frontend + `mcp/tools`; add `'mcp_handler'` beside each with the same shape; the existing enum specs (`proxy-rules.tools.spec.ts`, `proxy-rules.controller.spec.ts`) gain the value.
- [ ] **Step 2:** `tsc` ×2; targeted specs; `format`; commit `feat(proxy-rules): mcp_handler is a known step type (sync DTO, rule form, admin MCP enum)`.

### Task 14: cache compiled function scripts

**Files:** Modify `apps/backend/src/pipelines/function-runner.service.ts` (+ create `function-runner.service.spec.ts` if absent — there is none today).

**Behaviour:** `private scripts = new LruMap<string, vm.Script>(64)` keyed by `sha256(code)`; `validateCode` memoised by the same key (`Map<string, ValidationResult>`, same cap); `run()` compiles `wrappedCode` once per key and reuses the `vm.Script` across contexts (`script.runInContext(sandbox, …)` is per-call; a `Script` is context-free). The wrapper string is a pure function of `code`, so the key is the code.

- [ ] **Step 1: failing tests** — spy on `vm.Script`: two `run()`s of the same code construct one `Script`; different code constructs two; the 65th distinct code evicts the first; a validation failure is memoised (the prohibited-pattern scan runs once).
- [ ] **Step 2:** implement (a 20-line LRU over `Map` insertion order); `pnpm --filter backend test -- function-runner function.handler`; `format`.
- [ ] **Step 3: commit** `perf(pipelines): compile each function_handler script once, not per request`.

### Task 14b: story-8 CE closeout

- [ ] `CONTEXT.md` glossary (a new *Pipelines* subsection if none): **MCP handler** ("A step that answers as a stateless MCP server from its own config — tools and `ui://` resources mapped to sibling rules of the same alias, executed in-process as the caller. App-agnostic; the app's rule set is the server." _Avoid_: "the MCP server" (CE's platform-admin server is a different thing)); **Sibling rule** ("Another rule of the same alias's effective rule sets, invoked in-process by `RuleInvokerService` with the caller's identity and the sibling's own validators — never the visibility gate twice").
- [ ] Full CE chain; PR `feat(pipelines): mcp_handler — a generic stateless MCP server step executing tools against sibling rules in-process`, `Closes #<story-8 issue>`; body: *Backwards compatibility* — a new handler type (additive), a refactor of rule resolution with the middleware's spec untouched, a script cache invisible to rules; *What changed*; counts. Merge on green.
- [ ] Ask the person for the release + j5s bump; record the version.

### Task B1 (apps): one bundle per tool — `src/mcp/tools/*`, the generated `tools` block, the sibling rules

**Files:** Create `apps/workflow/src/mcp/tools/{list,describe,status,outputs,runs,sign,submitStep,submit,annotate,pipeline,stepView,resources}.ts` (+ `.test.ts` each — the prototype's `reply.test.ts`/`merge.test.ts`/`plan.test.ts` cases redistributed), `apps/workflow/src/mcp/shared.ts` (what `route`/`plan`/`reply` shared: `FnRequest`, `FnDeployment`, `siblingBaseOf`, `confinedSignPath`, `parseIslandUri`, `snapshotOf`, `agentHostHint`, `implementationOf`/`listText`, `describe` prose, `declaredStep`), `apps/workflow/src/mcp/mcpConfig.ts` (+ test: renders the `mcp_handler` config from `CATALOG` + `HOST_TOOLS` + the resource declarations); modify `apps/workflow/scripts/build-mcp.mjs` (entries: one per tool → `rules/api/workflow/mcp-tools/<tool>/post/{plan,reply}.fn.js` as needed, `mcp-resources/get/list.fn.js`, and `rules/api/workflow/mcp/rule.yaml` rendered from `mcpConfig.ts` + a YAML template), `apps/workflow/src/mcp/bundle.test.ts` (freshness for every entry **and** the rendered rule.yaml), `apps/workflow/eslint.config.js` (the fence's `files` glob covers `src/mcp/**`; unchanged rules); delete `src/mcp/route.ts`, `plan.ts`, `reply.ts`, `merge.ts`, `jsonrpc.ts`, `hostTools.ts`'s `listedTools` (keep `HOST_TOOLS`, `STEP_VIEW_URI`, `RESOURCE_MIME`, `SERVER_VERSION`), `csp.ts` (CE derives the CSP) and their tests.

**Shape of a tool rule** (they all follow it; `status` shown):

```yaml
# rules/api/workflow/mcp-tools/status/post/rule.yaml
targetUrl: pipeline
order: 40
pipeline:
  name: MCP tool workflow.status
  description: "One catalog tool as one rule (spec 10, GA shape): the mcp_handler rule invokes it in-process as the caller; the body is the tool's `arguments`, the answer is a catalog CallToolResult. Validators are where the tool's scope is enforced (D23)."
  steps:
    - id: plan
      name: plan
      handler: function_handler
      code: ./plan.fn.js          # flags + derived values from request.body (the old `route` for this one tool)
    - id: run
      name: run
      handler: data_query
      config: { condition: steps.plan.needsRun, schemaId: $schema:workflow_runs, limit: 1, filters: { runId: { op: eq, value: steps.plan.runId } } }
    - id: steps
      name: steps
      handler: data_query
      config: { condition: steps.plan.needsRun, schemaId: $schema:workflow_run_steps, limit: 1000, filters: { runId: { op: eq, value: steps.plan.runId } } }
    - id: reply
      name: reply
      handler: function_handler
      code: ./reply.fn.js         # textResult(snapshotText + agentHostHint, snapshot) — verbatim the prototype's `status()`
    - id: respond
      name: respond
      handler: response_handler
      config: { body: "{{{steps.reply.json}}}", status: 200, headers: { Cache-Control: no-store }, contentType: application/json }
  validators:
    - type: auth_required
      config: { allowApiKey: true, requiredScopes: [workflow:read] }
```

Per tool: `list` (aliases via `http_request` to CE's `/api/aliases` in-process **with `forwardAuth: true`**, then `plan` → `index1..3` fetches through the harness forwarders with `forwardAuth` — the fan-out cap stays 3 in this rule's static step list; the cap is now a *tool-rule* limit, removable later by a `list` rule that loops, not the handler's concern), `describe` (index + yaml), `status`/`outputs` (rows), `runs` (rows + waiting), `sign` (`signed_url`), `submitStep`/`submit`/`annotate` (rows + `merge` + `data_update`; the lease guard and the `values: {}` branch verbatim), `pipeline` (rows + `plan` → `pipelinePost`/`pipelineGet` with `forwardAuth`), `stepView` (rows + island fetch), `start`/`await`/`cancel`/`resume` → **no rule**: the handler's `no_rule` failure would say "declared but no rule answers"; to keep the prototype's honest wording they get one shared rule `mcp-tools/not-served/post` whose `reply` answers `notServed(request.body.__tool)`… no — simpler and D19-honest: four two-step rules (`reply.fn.js` = `notServed(name)` + respond), each `requiredScopes: [workflow:run]` (`await`: `[workflow:read]`). `resources` → `mcp-resources/get`: the `list` sibling — aliases + index fan-out → `[{ uri: 'ui://bffless/<impl>/<island>', name, description, mimeType }]` plus the static step view (declared in config, not here).

The generated `mcp/rule.yaml`:

```yaml
# rules/api/workflow/mcp/rule.yaml — GENERATED by scripts/build-mcp.mjs from src/mcp/mcpConfig.ts; do not edit
methods: [GET, POST, DELETE]
targetUrl: pipeline
order: 30
pipeline:
  name: MCP endpoint
  description: "POST /api/workflow/mcp — the harness's MCP server as ONE rule on CE's generic mcp_handler (spec 10, D22 GA). tools/list IS the catalog: this block is rendered from @bffless/workflow-agent-tools at build time and held fresh by bundle.test.ts (D19). Every tool is a sibling rule under mcp-tools/, executed in-process as the caller with its own requiredScopes (D23)."
  steps:
    - id: mcp
      name: mcp
      handler: mcp_handler
      config:
        serverInfo: { name: bffless-workflow, version: "1.0.0" }
        instructions: "The BFFless Workflow harness: 11 workflow.* tools …"   # verbatim the prototype's
        tools:
          - name: workflow.list
            description: …                     # from CATALOG
            inputSchema: { … }
            annotations: { readOnlyHint: true }
            rule: { path: /api/workflow/mcp-tools/list, method: POST }
          # … all 11, workflow.submitStep with _meta: { ui: { resourceUri: ui://bffless/workflow/step.html } }
          - name: workflow.submit
            visibility: [app]
            rule: { path: /api/workflow/mcp-tools/submit, method: POST }
          # … the four app-only tools
        resources:
          static:
            - { uri: ui://bffless/workflow/step.html, name: Workflow step view, description: "Mounts a waiting island step of a run (spec 10).", rule: { path: /step.html } }
          templates:
            - { uriTemplate: "ui://bffless/{impl}/{path+}", name: "island", rule: { path: "/w/{impl}/{path+}" } }
          list: { rule: { path: /api/workflow/mcp-resources, method: GET } }
          csp: { connectDomains: ["$app", "$storage"], resourceDomains: ["$storage"] }
  validators:
    - type: auth_required
      config: { allowApiKey: true }
description: "The MCP endpoint (spec 10, D22): stateless Streamable HTTP over one mcp_handler step. GET/DELETE → 405 (no SSE). Bearer app tokens are the credential (D23); a tool's scope is enforced by its sibling rule."
```

Note the island template keeps `resolveSrc`'s fence: the handler expands `{path+}` refusing `..` segments, and the `/w/<impl>/*` forwarder serves only that implementation's bundle — the same two fences the prototype's `plan` applied via `resolveSrc`, now split between CE (traversal) and the rule set (implementation). `resolveSrc` still guards `workflow.stepView`'s island fetch inside its own rule.

- [ ] **Step 1: failing tests** — `mcpConfig.test.ts`: the rendered `tools` are `CATALOG.length + HOST_TOOLS.length`, the first 11 `{ name, description, inputSchema, annotations }` deep-equal the catalog's, `workflow.submitStep` carries the resource URI, host tools carry `visibility: ['app']`, every `rule.path` is under `/api/workflow/mcp-tools/`; per-tool tests = the prototype's cases moved; `bundle.test.ts` fails on the missing bundles and the missing rendered YAML.
- [ ] **Step 2:** implement the tools, the config renderer, the build script; `pnpm --filter workflow mcp:build` writes every bundle + `mcp/rule.yaml`; delete the retired modules and `mcp/get/rule.yaml` and `mcp/post/`; `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build`.
- [ ] **Step 3: commit** `feat(workflow): one sibling rule per MCP tool; the endpoint's tools/resources config rendered from the catalog`.

### Task B2 (apps): the fence, the docs, the scratch redeploy

**Files:** Modify `apps/workflow/src/rules.fence.test.ts` (`KNOWN` gains `mcp_handler`; the `/api/workflow/mcp/` branch asserts one step of `handler: mcp_handler`, `methods` = `[GET, POST, DELETE]`, `auth_required` present without `requiredScopes`; every `mcp-tools/*` rule asserts `requiredScopes` equals `[TOOL_SCOPES[tool] | HOST_TOOL_SCOPES[tool]]` by directory name), `apps/workflow/bffless/README.md` (Phase 3 section: the endpoint is one `mcp_handler` rule + 16 siblings; redeploy unchanged; token minting for walks), `apps/workflow/CONTEXT.md` (MCP endpoint: "one `mcp_handler` rule; tools are sibling rules"), `apps/workflow/docs/spec/10-agent-embedding.md` (§The MCP endpoint item 2: "shipped 2026-09-xx — see the Phase 3 plan" — a one-line status note, not a rewrite).

- [ ] **Step 1:** fence tests red → green; `pnpm apps:check`.
- [ ] **Step 2: live (scratch; needs CE ≥ story 8 on j5s):** README redeploy (rules by hand `npx bffless@next rules push … --prune` — the set now has 16 new rules and 2 fewer; harness zip unchanged unless `step.html` moved); `curl` `initialize`, `tools/list` (15), `resources/list` with the derived CSP, a `tools/call workflow.status` with a token; `GET` → 405.
- [ ] **Step 3: commit** `docs(workflow): the MCP endpoint on mcp_handler — fence, README, glossary`.

### Task B3 (apps): the walk, unchanged, on the new guts

- [ ] `pnpm workflow-live:walk mcp --harness https://workflow-mcp.j5s.dev --out /tmp/walk-mcp-8` → **26/26** with **no edit to `walks/mcp.ts`** (the acceptance criterion: the wire is the same). If a check reads differently, the difference is a story-8 bug, not a walk update — fix the tool rule or the handler. Paste the report; note the per-call timings the walk logs against the Phase-2 numbers (0.3–0.6 s per sibling call; the gate report's 2–3 s per island click) — the honest before/after for Decisions 17–18.
- [ ] **PR** `feat(workflow): the MCP endpoint on CE's mcp_handler — one step, one sibling rule per tool, src/mcp shrinks to the app's own words` into the epic; body: §1 (rules reach `bffless/workflow` on the next epic dispatch; **requires CE ≥ v<story-8 release>** — an older image refuses the set at sync with an unknown handler type, so the dispatch must wait), §6 (none), counts, the walk report with timings. Merge on green; tick story 8 on #554.

---

# Phase C — Story 9: OAuth 2.1 (CE Tasks 15–22, then apps Tasks C1–C4)

*Deliverable (CE): a built-in OAuth 2.1 authorization server on the admin host — RFC 8414 metadata, RFC 7591 dynamic client registration, PKCE-only authorization code flow with a consent page, RFC 8707 resource → project binding, refresh-token rotation, RFC 7009 revocation — whose access tokens are story 7's app tokens; plus the RFC 9728 `WWW-Authenticate` hints on every API-shaped 401. Branch `feat/<n>-oauth`, worktree `repos/ce/.claude/worktrees/oauth`. Deliverable (apps): the harness ships `/.well-known/oauth-protected-resource` as a rule served despite visibility; the `oauth` walk drives the code flow headlessly; claude.ai's connector completes the gate against `workflow.j5s.dev`. Branch `feat/m5-oauth-discovery`, worktree `repos/apps/.claude/worktrees/m5-oauth-discovery`.*

### Task 15: the 401 that starts the dance — `WWW-Authenticate: Bearer resource_metadata`

**Files:** Modify `apps/backend/src/proxy-rules/proxy.middleware.ts` (+ spec): the gate's API-request 401 branch and `handlePipelineExecution`'s `AUTH_REQUIRED` → 401 mapping both set `WWW-Authenticate: Bearer resource_metadata="https://<x-forwarded-host ?? host>/.well-known/oauth-protected-resource"` (RFC 9728 §5.1) **when the request reached CE through a domain host** (`x-forwarded-host` present — the admin API's own 401s are untouched); the 403 `insufficient_scope` header from Task 5 is unchanged.

- [ ] **Step 1: failing tests** — anonymous API-shaped request on a private alias → 401 with the header naming the host; `auth_required` 401 on a public alias → the same header; a request without `x-forwarded-host` → no header.
- [ ] **Step 2:** implement; test; commit `feat(proxy-rules): RFC 9728 resource_metadata hint on API 401s`.

### Task 16: the spike, the ADR, the schemas

**Files:** Create `docs/adr/0005-built-in-oauth-authorization-server.md`; create `apps/backend/src/db/schema/oauth-clients.schema.ts`, `oauth-authorization-codes.schema.ts`, `oauth-refresh-tokens.schema.ts` (+ `index.ts` exports); the person generates the migration.

**The spike (time-boxed to the four criteria of Decision 19; sources: SuperTokens' OAuth2Provider docs and changelog for the minimum `supertokens-node`/core versions and for what "dynamic client registration" means there; CE's `package.json` ^17 and ce#695):** answer (a)–(d) with a sentence and a link each. Expected: (a) no public RFC 7591 endpoint — clients are created by an authenticated API/dashboard; (b) node 21+ required against CE's ^17; (c) resource indicators unsupported/partial; (d) tokens are SuperTokens JWTs. Any failing criterion → built-in. Write the ADR (status accepted; Context: the ladder and claude.ai's DCR; Decision: built-in, minimal, `/api/oauth/*` on the admin host, access tokens are app tokens; Considered: SuperTokens OAuth2Provider with the four findings; Consequences: CE owns a small AS and its two tables + refresh rotation; OIDC/introspection deferred).

**Schemas:**

```ts
// oauth-clients.schema.ts
export const oauthClients = pgTable('oauth_clients', {
  clientId: uuid('client_id').primaryKey().defaultRandom(),
  clientName: varchar('client_name', { length: 255 }).notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  grantTypes: jsonb('grant_types').$type<string[]>().notNull().default(['authorization_code', 'refresh_token']),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at'),
});
// oauth-authorization-codes.schema.ts
export const oauthAuthorizationCodes = pgTable('oauth_authorization_codes', {
  codeHash: varchar('code_hash', { length: 64 }).primaryKey(),
  clientId: uuid('client_id').references(() => oauthClients.clientId).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  codeChallenge: varchar('code_challenge', { length: 128 }).notNull(),   // S256 only
  redirectUri: text('redirect_uri').notNull(),
  resource: text('resource').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
});
// oauth-refresh-tokens.schema.ts
export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
  familyId: uuid('family_id').notNull(),                                  // rotation family; reuse revokes the family
  clientId: uuid('client_id').references(() => oauthClients.clientId).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  appTokenId: uuid('app_token_id').references(() => appTokens.id),      // the access token last issued
  expiresAt: timestamp('expires_at').notNull(),
  rotatedAt: timestamp('rotated_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [index('oauth_refresh_tokens_family_idx').on(t.familyId)]);
```

- [ ] **Step 1:** the spike → ADR; commit `docs(adr): 0005 — built-in OAuth 2.1 authorization server`.
- [ ] **Step 2:** schemas; `tsc`; **(the person)** `pnpm db:generate` → name `oauth-clients-codes-refresh-tokens`; review: three `CREATE TABLE`s, no `ALTER`.
- [ ] **Step 3: commit** `feat(auth): OAuth schemas — clients, authorization codes, refresh tokens`.

### Task 17: `OAuthService` — the grammar of the flow

**Files:** Create `apps/backend/src/oauth/oauth.module.ts`, `oauth.service.ts`, `oauth.service.spec.ts`, `pkce.util.ts` (+ spec), `oauth.dto.ts`, `oauth.errors.ts`; modify `app.module.ts`.

**Interfaces:**

```ts
// pkce.util.ts
export function verifyS256(codeVerifier: string, codeChallenge: string): boolean;   // base64url(sha256(verifier)) === challenge, timing-safe
export function isValidVerifier(v: string): boolean;                                 // RFC 7636 §4.1: 43–128 unreserved chars
// oauth.errors.ts — RFC 6749 §5.2 / §4.1.2.1 error bodies as HttpExceptions: invalid_request, invalid_client, invalid_grant, unauthorized_client, unsupported_grant_type, invalid_scope, invalid_target (RFC 8707), invalid_client_metadata (RFC 7591)
// oauth.service.ts
export interface AuthorizeParams { response_type: 'code'; client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: 'S256'; state?: string; scope?: string; resource: string }
export interface PendingRequest { clientId: string; clientName: string; redirectUri: string; codeChallenge: string; state?: string; scopes: string[]; resource: string; projectId: string; projectName: string; iat: number; exp: number }
@Injectable()
export class OAuthService {
  issuer(req: Request): string;                                    // `${FRONTEND_URL}`; no trailing slash
  metadata(req: Request): AuthorizationServerMetadata;            // RFC 8414 §2 — see Task 19
  registerClient(dto: RegisterClientDto): Promise<ClientMetadataResponse>;
  /** Validates the authorize params; resolves `resource` → project and scopes ⊆ the resource's PRM `scopes_supported` (Decision 21). Errors before redirect_uri is trusted answer 400; after, they are redirected with `error=`. */
  beginAuthorization(params: Record<string, unknown>): Promise<{ request: string /* JWT */; pending: PendingRequest }>;
  readPending(request: string): PendingRequest;                   // verify + expiry
  /** The member approved (with a possibly narrowed scope set) or denied. */
  consent(userId: string, request: string, decision: { approve: boolean; scopes?: string[] }): Promise<{ redirectTo: string }>;
  token(body: Record<string, unknown>): Promise<TokenResponse>;   // authorization_code (PKCE, single use, exact redirect_uri) | refresh_token (rotation, family revoke on reuse)
  revoke(body: { token: string; token_type_hint?: string }): Promise<void>;   // RFC 7009: refresh → the family; access → the app token
}
export interface TokenResponse { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }
```

Resolution of `resource` (Decision 21): parse the URL; host → `visibilityService.resolveAccessControlByDomain`-style lookup of `domain_mappings` (add a small `DomainsService.findMappingByHost(host)` if none is public) → `projectId`; then fetch the PRM document **in-process**: `GET http://localhost:3000/public/<owner>/<repo>/alias/<alias>/<dir>/.well-known/oauth-protected-resource` with `x-forwarded-host: <host>` and `x-original-uri: /.well-known/oauth-protected-resource` (the same hop the `/w/` forwarders and the prototype's sibling calls use — the mapping supplies owner/repo/alias/path) → `scopes_supported`; requested scopes default to all of them when `scope` is absent; unknown → `invalid_scope`; no document or no `resource` → `invalid_target`. The access token is minted through `AppTokensService.create(userId, role, { name: \`OAuth: ${clientName}\`, project, scopes }, { kind: 'oauth', clientId, expiresAt: now + 3600 s })` — the service is reused, not duplicated. Refresh tokens: `bfrt_` + 64 hex, hash stored, 30 days, rotated on every use; a rotated token presented again → revoke the family (every row with that `familyId`) and 400 `invalid_grant`.

- [ ] **Step 1: failing tests** — `pkce`: a known verifier/challenge pair verifies, `plain` never does, a 42-char verifier is invalid; `registerClient`: https and localhost redirect URIs accepted, `http://evil.example` refused, `token_endpoint_auth_method: 'client_secret_basic'` refused, the response echoes metadata with `client_id` and no secret; `beginAuthorization`: missing `resource` → `invalid_target`, a host with no mapping → `invalid_target`, unknown scope → `invalid_scope`, an unregistered `redirect_uri` → 400 (never redirected), a good request → a JWT whose `readPending` round-trips and expires after 10 min; `consent` deny → `redirectTo` carries `error=access_denied&state=`; approve with a subset → the code row stores the subset; `token` authorization_code: wrong verifier → `invalid_grant`, second use → `invalid_grant` **and** revokes the app token it issued, exact `redirect_uri` mismatch → `invalid_grant`, success → `access_token` `bfat_…` with the code's scopes and `expires_in: 3600`, a refresh token; `token` refresh_token: rotates (old hash unusable), reuse after rotation revokes the family; `revoke` both hints.
- [ ] **Step 2:** implement; `pnpm --filter backend test -- oauth pkce`; `tsc`; `format`.
- [ ] **Step 3: commit** `feat(auth): OAuthService — DCR, PKCE authorization codes, resource→project, refresh rotation, revocation`.

### Task 18: the nginx location for RFC 8414 metadata

**Files:** Modify `docker/nginx/sites-available/main.conf.template` (the admin `server` block: `location = /.well-known/oauth-authorization-server { proxy_pass http://backend:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }` declared **before** `location /`), `docker/nginx-ssl.conf` (the same block in its admin server), `docker/nginx/render-main-conf.test.sh` (an `assert_contains` for the new location in both render modes), `docker/nginx/render-main-conf.sh` if the admin block is assembled there.

- [ ] **Step 1:** `bash docker/nginx/render-main-conf.test.sh` → the new assertion fails; add the location; passes. (The `subdomain.conf.hbs`/`custom-domain.conf.hbs` templates need nothing: app hosts route every path to `/public/…` with `X-Original-URI`, which is how the app's own `.well-known` rule matches — verified live 2026-09-02.)
- [ ] **Step 2: commit** `feat(nginx): route /.well-known/oauth-authorization-server on the admin host to the backend`.

### Task 19: the controllers — metadata, register, authorize, consent, token, revoke

**Files:** Create `apps/backend/src/oauth/oauth-metadata.controller.ts` (+ spec), `oauth.controller.ts` (+ spec); modify `oauth.module.ts`.

**Routes:**

| route | guard | answers |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` | none | RFC 8414: `{ issuer, authorization_endpoint: <issuer>/api/oauth/authorize, token_endpoint: <issuer>/api/oauth/token, registration_endpoint: <issuer>/api/oauth/register, revocation_endpoint: <issuer>/api/oauth/revoke, response_types_supported: ['code'], grant_types_supported: ['authorization_code','refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: [] (the resource's document is authoritative), resource_indicators_supported: true }`; `Cache-Control: public, max-age=3600` |
| `POST /api/oauth/register` | none (throttled) | 201 + client metadata |
| `GET /api/oauth/authorize` | none | validates via `beginAuthorization`; **no session** → 302 to `/login?redirect=<this URL, encoded>&tryRefresh=true` (the SPA's existing login round-trips back); **session** → 302 to `/oauth/consent?request=<jwt>`; a `bffless_access`-only caller is treated as no session (the consent page is the admin SPA, SuperTokens-only) |
| `GET /api/oauth/consent?request=` | `SessionAuthGuard` | the `PendingRequest` minus secrets (client name, scopes, project display name, redirect host) — what the page renders |
| `POST /api/oauth/consent` | `SessionAuthGuard` | `{ request, approve, scopes? }` → `{ redirectTo }` |
| `POST /api/oauth/token` | none | `application/x-www-form-urlencoded` **and** JSON bodies; RFC 6749 error bodies; `Cache-Control: no-store`, `Pragma: no-cache` |
| `POST /api/oauth/revoke` | none | 200 always (RFC 7009 §2.2) |

- [ ] **Step 1: failing tests** — controller specs with a mocked service: metadata shape and cache header; authorize without a session redirects to `/login?redirect=…` preserving the full query; with a session redirects to the consent page; token endpoint parses both body encodings and maps service errors to RFC bodies (`{ error, error_description }`, 400; `invalid_client` 401); revoke answers 200 on an unknown token.
- [ ] **Step 2:** implement; `pnpm --filter backend test -- oauth`; `tsc`; `format`.
- [ ] **Step 3: commit** `feat(auth): OAuth 2.1 endpoints — metadata, register, authorize, consent, token, revoke`.

### Task 20: the consent page

**Files:** Create `apps/frontend/src/services/oauthApi.ts`, `apps/frontend/src/pages/OAuthConsentPage.tsx`, `apps/frontend/src/pages/__tests__/OAuthConsentPage.test.tsx`; modify `apps/frontend/src/App.tsx` (`<Route path="/oauth/consent" element={<OAuthConsentPage />} />` inside the authenticated layout — a signed-out visit goes through the existing login redirect).

**Behaviour:** reads `?request=`, `useGetPendingConsentQuery(request)` → a `Card`: "**<client name>** wants to access **<project owner/name>** as you", one `Checkbox` per requested scope (all checked; label = the scope string, helper "the app defines what each scope allows"), the redirect host shown in muted text ("You will be sent back to `<host>`"), buttons **Deny** / **Allow** → `POST /api/oauth/consent` → `window.location.assign(redirectTo)`; an expired/invalid request shows the error and no buttons.

- [ ] **Step 1: failing tests** — renders client, project, and three checkboxes; unticking one and clicking Allow posts `scopes` with two; Deny posts `approve: false`; an error response renders the message.
- [ ] **Step 2:** implement; `tsc`; `pnpm --filter frontend test -- OAuthConsentPage`; `format`.
- [ ] **Step 3: commit** `feat(frontend): OAuth consent page`.

### Task 21: `bffless/deploy-proxy-rules` catches up (the `bypassVisibility` chain)

- [ ] After the story-7 CE release (which published `bffless@<ver>` with the manifest key): `gh repo clone bffless/deploy-proxy-rules /tmp/dpr && cd /tmp/dpr && pnpm install && pnpm up bffless@^<ver> && pnpm build && pnpm test`; commit `feat: bffless@<ver> — rule manifests may declare bypassVisibility` (its own conventional-commit gate), PR, and ask the person to merge + release (v1.4.0 moves `@v1`). Until then every rules push of the story-9 set is by hand with `npx bffless@<ver>`.

### Task 22: story-9 CE closeout

- [ ] `CONTEXT.md`: **Authorization server** ("CE's built-in OAuth 2.1 server on the admin host (`/api/oauth/*`, metadata at `/.well-known/oauth-authorization-server`). Clients register themselves (DCR); a member consents per project and per scope; the access token *is* an app token bound to the project the `resource` named." _Avoid_: "SuperTokens OAuth" (not used — ADR-0005)); **Protected resource document** ("An app-shipped `/.well-known/oauth-protected-resource` rule, served despite visibility, naming the authorization server and the app's scopes — how a client finds the server from the app").
- [ ] Full CE chain incl. `bash docker/nginx/render-main-conf.test.sh`; PR `feat(auth): OAuth 2.1 authorization server — DCR, PKCE, RFC 8414/9728/8707; access tokens are app tokens`, `Closes #<story-9 issue>`; body: compatibility (three additive tables, one nginx location on the admin vhost — ships in the frontend image; the `WWW-Authenticate` header on 401s that already were 401s), the ADR, counts. Merge on green; the person releases and bumps j5s.

### Task C1 (apps): the protected-resource document as a rule

**Files:** Create `apps/workflow/src/mcp/wellKnown.ts` (+ `wellKnown.test.ts`); modify `apps/workflow/.bffless/proxy-rules/workflow/rules/_custom/well-known/get.rule.yaml` (rewritten), `apps/workflow/scripts/build-mcp.mjs` (entry `wellknown` → `rules/_custom/well-known/wellknown.fn.js`), `apps/workflow/src/rules.fence.test.ts` (the well-known branch: `pathPattern` = `/.well-known/oauth-protected-resource*`, `bypassVisibility: true`, no validators, the function step present), `apps/workflow/src/lib/adminOrigin.ts` — **not imported** (the fence); `wellKnown.ts` restates the rule with a parity test against `adminOriginOf` from `lib/adminOrigin.ts`.

```yaml
# rules/_custom/well-known/get.rule.yaml
pathPattern: /.well-known/oauth-protected-resource*
targetUrl: pipeline
order: 32
bypassVisibility: true
pipeline:
  name: OAuth protected-resource metadata
  description: "RFC 9728: the document an MCP client reads before it has any credential — so it is served despite deployment visibility (bypassVisibility, CE ≥ <story-7 release>; spec 10, D23). Names this endpoint as the resource, CE's authorization server on admin.<domain>, and the catalog's scopes. Every URL is derived from the request's host (no instance baked in). Replaces the Phase-2 404 rule."
  steps:
    - id: doc
      name: doc
      handler: function_handler
      code: ./wellknown.fn.js
    - id: respond
      name: respond
      handler: response_handler
      config: { body: "{{{steps.doc.json}}}", status: 200, headers: { Cache-Control: "public, max-age=300" }, contentType: application/json }
description: "OAuth discovery for the MCP endpoint (RFC 9728), pre-credential by definition."
```

```ts
// src/mcp/wellKnown.ts
import { SCOPES } from '@bffless/workflow-agent-tools'
export const MCP_PATH = '/api/workflow/mcp'
/** `workflow.j5s.dev` → `https://admin.j5s.dev`; a single-label host keeps itself (lib/adminOrigin's rule, restated — parity-tested). */
export function authorizationServerOf(host: string): string
export function handler(data: { request: { headers: Record<string, string | string[] | undefined> } }): { json: string }
// → JSON.stringify({ resource: `https://${host}${MCP_PATH}`, authorization_servers: [authorizationServerOf(host)], scopes_supported: [...SCOPES], bearer_methods_supported: ['header'], resource_name: 'BFFless Workflow', resource_documentation: 'https://github.com/bffless/apps/blob/main/apps/workflow/docs/spec/10-agent-embedding.md' })
```

- [ ] **Step 1: failing tests** — `wellKnown.test.ts`: the document for `x-forwarded-host: workflow.j5s.dev` has `resource === 'https://workflow.j5s.dev/api/workflow/mcp'`, `authorization_servers[0] === 'https://admin.j5s.dev'`, `scopes_supported` deep-equals `SCOPES`; parity: `authorizationServerOf(h) === new URL(adminOriginOf(\`https://${h}\`)).origin` for three hosts; the fence's new branch.
- [ ] **Step 2:** implement; `mcp:build`; `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build`; `pnpm apps:check`.
- [ ] **Step 3: live (scratch; needs CE ≥ story 9):** `npx bffless@<ver> rules push …`; `curl -s https://workflow-mcp.j5s.dev/.well-known/oauth-protected-resource | jq` → the document; `curl -s https://workflow-mcp.j5s.dev/.well-known/oauth-protected-resource/api/workflow/mcp` → the same; `curl -s https://admin.j5s.dev/.well-known/oauth-authorization-server | jq .issuer`.
- [ ] **Step 4: commit** `feat(workflow): /.well-known/oauth-protected-resource as a rule, served despite visibility`.

### Task C2 (apps): the docs — README, CONTEXT, spec status, the connector recipe

- [ ] `apps/workflow/bffless/README.md`: a "Connecting an MCP host (OAuth)" subsection — the connector URL (`https://workflow.<domain>/api/workflow/mcp`), what happens (discovery → admin login → consent → tokens), the scopes and what each allows in prose, revocation (the App tokens tab: OAuth tokens are listed with the client's name), the two person-owned preconditions (Cloudflare AI-bot block off; the member must have a project role); the scratch section's `WORKFLOW_MCP_KEY` line replaced by "retired in Phase 3". `CONTEXT.md` glossary: *Protected-resource document*, *Consent*. Spec 10 §Auth: a one-line "rungs 2–3 shipped — Phase 3 plan" status note.
- [ ] Commit `docs(workflow): OAuth connector recipe; Phase 3 glossary`.

### Task C3 (apps): the `oauth` walk

**Files:** Create `packages/workflow-live/src/walks/oauth.ts`, `src/oauth-client.ts` (+ test: PKCE pair generation, the local redirect listener), modify `src/walks/index.ts`, `src/args.ts` (USAGE), `README.md`, `.claude/agents/apps-live-walk.md`.

**Checks** (names cite what they prove):
```
D23.prmServed        GET <harness>/.well-known/oauth-protected-resource → 200 JSON; resource ends /api/workflow/mcp; authorization_servers[0] answers RFC 8414 metadata with code_challenge_methods_supported ['S256'] and a registration_endpoint
D23.anon401Hints     POST <mcp> initialize without a token → 401 with WWW-Authenticate containing resource_metadata="<harness>/.well-known/oauth-protected-resource"   (on the private harness the gate; on scratch the validator)
D23.dcr              POST registration_endpoint { client_name: 'workflow-live', redirect_uris: ['http://127.0.0.1:<port>/cb'], token_endpoint_auth_method: 'none' } → 201 client_id
D23.consentGrants    the logged-in Playwright page navigates to authorization_endpoint?…&resource=<mcp>&scope=<all three>&code_challenge=…; the consent page renders three checkboxes; click Allow; the local listener receives ?code=&state= (state equal)
D23.tokenIsAppToken  POST token_endpoint (authorization_code + code_verifier) → access_token matching /^bfat_/, expires_in 3600, refresh_token, scope = the three
D23.statusAsMember   MCP client with the access token → workflow.status { runId } answers; workflow.runs shows startedBy === the member's id (from workflow.whoami over the page session)
D23.refreshRotates   grant_type=refresh_token → a new pair; the old refresh_token → 400 invalid_grant
D23.narrowedConsent  a second authorize with the same client; untick workflow:run on the consent page; the resulting token's workflow.start → isError with errors.scope naming workflow:run; workflow.status still answers
D23.revoke           POST revocation_endpoint { token: <access> } → 200; the next tools/call with it → 401
```
The parked run comes from the `mcp` walk's park step (`--run` or park). The walk runs against **both** hosts: `--harness https://workflow-mcp.j5s.dev` (public) and `--harness https://workflow.j5s.dev` (private — the gate's own proof).

- [ ] **Step 1: failing tests** — `oauth-client.test.ts`: `pkcePair()` verifier length 64, challenge = base64url(sha256); `waitForCallback(port)` resolves with `code`/`state` from one GET and answers the browser a small "you can close this" page.
- [ ] **Step 2:** implement; `pnpm --filter @bffless/workflow-live lint && build && test:run`.
- [ ] **Step 3: live** — `pnpm workflow-live:walk oauth --harness https://workflow-mcp.j5s.dev --out /tmp/walk-oauth-scratch` → 9/9; after `gh workflow run deploy-workflow.yml --ref epic/agent-embedding` (the epic's rules + build onto `bffless/workflow`; needs the action bump of Task 21, else hand-push the set with `npx bffless@<ver>` using a project key for `bffless/workflow` — mint one with `mcp__j5s-dev__create_api_key { repository: 'bffless/workflow' }` if none is on disk, store it in `~/.config/bffless/workflow-deploy.env`, name it in the README) → `pnpm workflow-live:walk oauth --harness https://workflow.j5s.dev --out /tmp/walk-oauth-j5s` → 9/9; `pnpm workflow-live:walk mcp --harness https://workflow-mcp.j5s.dev` → 26/26 still.
- [ ] **Step 4: commit** `feat(workflow-live): the oauth walk — DCR, PKCE, consent, tokens, rotation, narrowed scope, revocation`.

### Task C4 (apps): the claude.ai gate — the person's checklist, screenshots on the PR

Post on the story-9 PR and on #554 (the session cannot open claude.ai):

1. Precondition: the `oauth` walk is green on `https://workflow.j5s.dev` (posted above); Cloudflare's AI-bot block is off; you are a member of `bffless/workflow`. Park a run: `pnpm workflow-live:walk mcp --harness https://workflow.j5s.dev --park-only` → note the run id.
2. claude.ai → Settings → Connectors → **Add custom connector** → name `Workflow (j5s)`, URL `https://workflow.j5s.dev/api/workflow/mcp`, leave auth to be detected. **Screenshot 1:** the dialog showing OAuth detected (not "None").
3. Click Connect → you land on `https://admin.j5s.dev/login` (if not signed in) → then the consent page listing `workflow:read`, `workflow:run`, `workflow:files` and the project `bffless/workflow`. **Screenshot 2:** the consent page. Allow.
4. Back in claude.ai the connector shows connected with 11 tools. **Screenshot 3.**
5. New chat: *"What is run `<runId>` waiting on?"* → `workflow.status` answers as you. **Screenshot 4.** Then *"List the runs of hello/interactive."* → `workflow.runs` shows `startedBy` — your id (the walk's `whoami` output names it). **Screenshot 5.**
6. Complete the island as in Phase 2 (`submitStep {}` → the island → Submit) — **Screenshot 6** — proving the app-only tools ride the same token.
7. Disconnect, add the connector **again**, and on the consent page **untick `workflow:run`**. **Screenshot 7.** New chat: *"Start a hello/interactive run with greeting Hello and names world."* → Claude calls `workflow.start` (over the endpoint it answers the honest Phase-4 refusal today — so also ask *"Complete step `<key>` of run `<runId>`"* on a freshly parked run) → the refusal names `workflow:run`. **Screenshot 8.** *"What is the run waiting on?"* still answers. **Screenshot 9.**
8. Settings → App tokens (admin) shows the two OAuth tokens with the client name; revoke one. **Screenshot 10.**

- [ ] Post the checklist; when the screenshots arrive, attach them to the PR; the gate is the screenshots, not CI.
- [ ] **PR** `feat(workflow): OAuth discovery as a rule — /.well-known/oauth-protected-resource served despite visibility; the oauth walk` into the epic; body: §1 (**requires CE ≥ v<story-9 release> and `deploy-proxy-rules` ≥ v1.4.0** before the epic's deploy dispatch; the rule set otherwise fails to sync on the unknown key), counts, both walk reports, the screenshots. Merge on green **after** the screenshots; tick story 9 on #554.

---

# Phase-3 gate and closeout (Tasks G1–G2)

### Task G1: the gate, stated and checked

The gate passes when all of these are true on the same day, against the released CE on j5s:
- claude.ai's one-click connector completed DCR → consent → tokens against `https://workflow.j5s.dev/api/workflow/mcp` — a **private** deployment (screenshots 1–4 on the story-9 PR);
- `workflow.status` ran as the member with `startedBy` the member's id (screenshot 5 + the `oauth` walk's `D23.statusAsMember` on `workflow.j5s.dev`);
- a `workflow:read`-only consent cannot start or submit a run (screenshot 8 + `D23.narrowedConsent`);
- the `mcp` walk is **26/26** on the scratch project (24 unchanged + the two story-7 checks) and the `oauth` walk 9/9 on both hosts.

- [ ] Comment **"Phase 3 gate — PASS"** on #554 with the four lines above, links to the reports and screenshots, the CE versions (`bffless/ce vX`, `bffless@x`, `deploy-proxy-rules vX`), and the per-call timings before/after story 8.

### Task G2: closeout

- [ ] **#554:** stories 7–9 checked off (each at its merge); the Phase-3 gate comment; the Phase-4 hand-off line: "the run view's `workflow.http` is a sibling rule like any tool's — `mcp_handler` + `requiredScopes` are in place".
- [ ] **This plan:** a "Phase 3 as shipped" block under the traceability table (PR numbers in both repos, CE release versions, departures with their reasons, the walk counts, the timings), PR `docs(workflow): M5 Phase 3 as shipped — plan notes` into the epic.
- [ ] **Follow-ups filed** (with the `file-issue` skill on apps; `gh issue create` on CE): apps — *session-from-token for the headless driver* (Decision 25); *CE should advertise its issuer to apps* (Decision 23's assumption); CE — *`bypassVisibility` for `internal_rewrite` rules* if a use appears; platform — *k8s workspace nginx: the `/.well-known/oauth-authorization-server` location* (`repos/platform`, a note on its tracker).
- [ ] **Scratch project:** ask the person whether `bffless/workflow-mcp` stays for Phase 4 (the run view's first host) or is deleted (`delete_project` — irreversible, never done unasked).
- [ ] **Memory** (`repos/apps` memory dir): a project note that app tokens (`bfat_`), `requiredScopes`, `bypassVisibility`, `mcp_handler` and `/api/oauth/*` exist from CE vX/vY/vZ; that the workflow MCP endpoint is one `mcp_handler` rule + sibling tool rules; that the walks mint their own tokens; and that a new rule-manifest key rides CE → `bffless` CLI → `deploy-proxy-rules` bump.
- [ ] **CE checklist** (`.claude/ce-pr-review-checklist.md`): one entry if earned — "A new rule-manifest key is a three-repo change: CE server + `packages/cli` + `bffless/deploy-proxy-rules` (ncc-frozen CLI) — say which release each needs".

## Self-review (writing-plans checklist, applied)

1. **Spec coverage** — every §Auth sentence of spec 10 maps to a task (the ladder rungs 2–3: Tasks 1–7, 15–20; both CE obligations under the gate: Tasks 5 and 15 + C1; `requiredScopes` semantics incl. sessions-unscoped and never-elevates: Task 4 + Decision 3; the catalog owns the map: A1; `workflow.http` inheriting a rule's scopes is Phase 4 but is why `RULE_SCOPES` covers every rule now). §The MCP endpoint item 2 maps to Tasks 9–14 and B1–B3; the "24 checks stay green unchanged" criterion is B3's no-edit rule. D22's negatives are Global Constraints. The design doc's Phase-3 gate is G1 verbatim.
2. **Placeholder scan** — every task names files, interfaces, the failing tests and the commit; the two things a person must do (migrations, releases/tag bumps) are named as such, not left as "deploy".
3. **Type consistency** — `resolveAppToken` / `requestUserFromAppToken` (Task 2) are what Tasks 3 and 5 call; `PipelineUser.credential | scopes | tokenProjectId` (Task 4) is what Task 5's `getOptionalUser` produces and Task 10's invoker forwards; `McpHandlerConfig` (Task 11) is what B1 renders; `InvokeFailure` kinds (Task 10) are what `invokeFailureResult` (Task 11) maps; `AppTokensService.create`'s `opts` (Task 6) is what `OAuthService.token` (Task 17) calls with `kind: 'oauth'`; `RULE_SCOPES`/`ruleScopeOf` (A1) is what the fence test (A1, B2) imports; `HOST_TOOL_SCOPES` (A2) is reused by B2's fence.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-03-workflow-m5-phase3-ce-auth.md`. CE stories are built **in the loop, inline** in this session (memory: *CE in-loop*), each in its own `repos/ce/.claude/worktrees/<name>` worktree, reviewed by the `ce-pr-review` CI run; the apps follow-ups are built inline on the epic in `repos/apps/.claude/worktrees/<name>` (they depend on live CE state a fresh subagent cannot see). The three stops that need the person are: `pnpm db:generate` (Tasks 1, 5, 16), the CE release-please merge + j5s tag bump after each CE story (Tasks 8, 14b, 22), and the `deploy-proxy-rules` release (Task 21); plus the claude.ai screenshots (C4) and the scratch-project decision (G2).
