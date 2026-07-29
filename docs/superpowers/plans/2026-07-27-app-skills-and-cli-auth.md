# App Skills Collection + BFFless CLI Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `bffless login` credential store to the CE CLI, then publish a generalized `handoff-api` skill as a public collection inside `repos/apps` that uses it.

**Architecture:** Part A (Tasks 1–5) adds a paste-a-key credential store (`~/.config/bffless/credentials.json`) plus `login`/`logout`/`auth status`/`auth token` commands to `repos/ce/packages/cli`, and slots the store into the existing key-resolution chain (flag > env > store). Part B (Tasks 6–8) creates a Claude-plugin-marketplace + `skills`-CLI-compatible collection in `repos/apps` (`plugins/bffless-apps/`), moves the `handoff-api` skill there, and rewrites it to be deployment-generic with the new auth story.

**Tech Stack:** TypeScript ESM (Node >=18) + commander + zod + Vitest (CE CLI); plain-Node mjs scripts + GitHub Actions (apps repo).

**Spec:** `docs/superpowers/specs/2026-07-27-app-skills-and-cli-auth-design.md` (this repo).

## Global Constraints

- **Shared checkouts:** `repos/ce` and `repos/apps` main checkouts are shared — ALL work happens in worktrees under each repo's `.claude/worktrees/` (created in Tasks 1 and 6).
- **Git:** commit per task on the worktree branch with conventional messages (`feat:`/`chore:`). NEVER push and NEVER open a PR without asking the user first (Tasks 5 and 8 are explicit user gates). Never add a `Release-As:` footer (it leaks into the CLI release component).
- **CE CLI conventions:** ESM with `.js` extensions on relative TS imports; Node >=18 (no Node-22-only APIs); command logic lives in `src/commands/*.ts` returning result objects, `src/index.ts` prints; errors are messages, not stack traces.
- **Key hygiene invariant (from `src/api/client.ts` module doc):** API keys are NEVER read from `.bffless/config.json` or any repo-committed file. The credential store lives outside the repo (`~/.config`), which preserves this.
- **CLI validation endpoint:** `GET /api/projects` (creator-scoped list; cheap; requires only a valid key — already used by `resolve.ts`).
- **Apps skill dual-homing:** whatever is canonical must be mirrored byte-identical by `scripts/sync-skills.mjs`; `node scripts/sync-skills.mjs --check` must pass before every apps-repo commit.
- **Min CLI version in the skill:** drafted as `0.4.0` in Task 7; Task 8 MUST replace it with the actually released version before the apps PR merges.
- **curl in Bash steps:** single line, no backslash continuations.

---

## Part A — CE CLI (`repos/ce/packages/cli`)

### Task 1: Credentials store module

**Files:**
- Create: `packages/cli/src/api/credentials.ts`
- Test: `packages/cli/test/credentials.test.ts`

**Interfaces:**
- Consumes: nothing new (zod, node:fs/os/path).
- Produces (used by Tasks 2–4):
  - `credentialsPath(env?: Record<string, string | undefined>): string`
  - `normalizeApiUrl(raw: string): string` (throws on unparseable URL)
  - `readCredentialsFile(file: string): CredentialsFile | null` (null when absent; throws naming the path on corrupt JSON / schema mismatch)
  - `getStoredKey(apiUrl: string, file?: string): string | undefined`
  - `storeKey(apiUrl: string, apiKey: string, file?: string, now?: Date): void`
  - `removeKey(apiUrl: string, file?: string): boolean`

- [ ] **Step 1: Create the worktree and install deps**

```bash
cd /home/rico/bffless/repos/ce
git fetch origin
git worktree add .claude/worktrees/cli-login -b feat/cli-login origin/main
cd .claude/worktrees/cli-login
pnpm install
```

All subsequent Part A paths are relative to `repos/ce/.claude/worktrees/cli-login/`.

- [ ] **Step 2: Write the failing tests**

Create `packages/cli/test/credentials.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  credentialsPath,
  normalizeApiUrl,
  readCredentialsFile,
  getStoredKey,
  storeKey,
  removeKey,
} from '../src/api/credentials.js';

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'bffless-cred-')), 'credentials.json');
}

describe('credentialsPath', () => {
  it('defaults to ~/.config/bffless/credentials.json', () => {
    expect(credentialsPath({})).toBe(path.join(os.homedir(), '.config', 'bffless', 'credentials.json'));
  });

  it('respects XDG_CONFIG_HOME', () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: '/xdg' })).toBe(path.join('/xdg', 'bffless', 'credentials.json'));
  });
});

describe('normalizeApiUrl', () => {
  it('lowercases the host and strips trailing slashes, keeping any base path', () => {
    expect(normalizeApiUrl('https://Admin.Example.com/')).toBe('https://admin.example.com');
    expect(normalizeApiUrl('https://admin.example.com/base/')).toBe('https://admin.example.com/base');
    expect(normalizeApiUrl('https://admin.example.com')).toBe('https://admin.example.com');
  });

  it('throws on an unparseable URL', () => {
    expect(() => normalizeApiUrl('not a url')).toThrow(/invalid API URL/);
  });
});

describe('store round-trip', () => {
  it('storeKey then getStoredKey returns the key, keyed by normalized URL', () => {
    const file = tmpFile();
    storeKey('https://Admin.Example.com/', 'k-123', file);
    expect(getStoredKey('https://admin.example.com', file)).toBe('k-123');
  });

  it('writes valid JSON with version 1 and an ISO createdAt', () => {
    const file = tmpFile();
    storeKey('https://a.test', 'k', file, new Date('2026-07-27T00:00:00Z'));
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed).toEqual({
      version: 1,
      credentials: { 'https://a.test': { apiKey: 'k', createdAt: '2026-07-27T00:00:00.000Z' } },
    });
  });

  it('re-storing the same instance overwrites; other instances are kept', () => {
    const file = tmpFile();
    storeKey('https://a.test', 'k-old', file);
    storeKey('https://b.test', 'k-b', file);
    storeKey('https://a.test', 'k-new', file);
    expect(getStoredKey('https://a.test', file)).toBe('k-new');
    expect(getStoredKey('https://b.test', file)).toBe('k-b');
  });

  it('creates the file with mode 0600', () => {
    if (process.platform === 'win32') return;
    const file = tmpFile();
    storeKey('https://a.test', 'k', file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('missing / corrupt files', () => {
  it('getStoredKey returns undefined for a missing file and an unknown instance', () => {
    const file = tmpFile();
    expect(getStoredKey('https://a.test', file)).toBeUndefined();
    storeKey('https://a.test', 'k', file);
    expect(getStoredKey('https://other.test', file)).toBeUndefined();
  });

  it('readCredentialsFile returns null for a missing file', () => {
    expect(readCredentialsFile(tmpFile())).toBeNull();
  });

  it('throws (naming the path) on invalid JSON — never silently treats it as absent', () => {
    const file = tmpFile();
    storeKey('https://a.test', 'k', file);
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(file, '{ nope');
    expect(() => getStoredKey('https://a.test', file)).toThrow(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('throws (naming the path) on schema-invalid content', () => {
    const file = tmpFile();
    storeKey('https://a.test', 'k', file);
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(file, JSON.stringify({ version: 2, credentials: {} }));
    expect(() => getStoredKey('https://a.test', file)).toThrow(/credentials/);
  });
});

describe('removeKey', () => {
  it('removes an entry and reports true; false when nothing was stored', () => {
    const file = tmpFile();
    storeKey('https://a.test', 'k', file);
    expect(removeKey('https://a.test/', file)).toBe(true);
    expect(getStoredKey('https://a.test', file)).toBeUndefined();
    expect(removeKey('https://a.test', file)).toBe(false);
    expect(removeKey('https://a.test', tmpFile())).toBe(false);
  });
});
```

Note: the `require('node:fs')` lines work because Vitest provides `require` in ESM test files via its CJS interop; if the suite errors on it, use `await import('node:fs')` and mark those two tests `async`.

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd packages/cli && npx vitest run test/credentials.test.ts
```

Expected: FAIL — cannot resolve `../src/api/credentials.js`.

- [ ] **Step 4: Write the implementation**

Create `packages/cli/src/api/credentials.ts`:

```typescript
/**
 * Credential store for `bffless login` — `$XDG_CONFIG_HOME/bffless/credentials.json`
 * (default `~/.config/bffless/credentials.json`), mode 0600, written atomically.
 *
 * Keys are stored OUTSIDE any repo, keyed by normalized API URL, so the client.ts
 * invariant holds: API keys are never read from a repo-committed file. Resolution
 * precedence stays flag > env > (this store) — see createClient.
 *
 * A present-but-broken file is a hard error naming the path (same stance as
 * config.ts): silently treating it as "no credentials" would send the user down a
 * confusing "why am I logged out" path instead of "your file is corrupt".
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const CredentialsFileSchema = z
  .object({
    version: z.literal(1),
    credentials: z.record(
      z.object({ apiKey: z.string().min(1), createdAt: z.string() }).strict(),
    ),
  })
  .strict();
export type CredentialsFile = z.infer<typeof CredentialsFileSchema>;

/** Default store location, honouring `$XDG_CONFIG_HOME`. */
export function credentialsPath(env: Record<string, string | undefined> = process.env): string {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : path.join(os.homedir(), '.config');
  return path.join(base, 'bffless', 'credentials.json');
}

/** Canonical store key for an instance URL: URL-parsed (lowercased host), trailing slashes stripped. */
export function normalizeApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid API URL: "${raw}" — expected e.g. https://admin.example.com`);
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${pathname}`;
}

/** Parse the store. `null` when the file does not exist; throws (naming the path) when broken. */
export function readCredentialsFile(file: string): CredentialsFile | null {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file}: invalid JSON — ${(err as Error).message}`);
  }
  const result = CredentialsFileSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `${file}: does not match the credentials schema — fix or delete the file and run \`bffless login\` again`,
    );
  }
  return result.data;
}

export function getStoredKey(apiUrl: string, file: string = credentialsPath()): string | undefined {
  return readCredentialsFile(file)?.credentials[normalizeApiUrl(apiUrl)]?.apiKey;
}

export function storeKey(
  apiUrl: string,
  apiKey: string,
  file: string = credentialsPath(),
  now: Date = new Date(),
): void {
  const store = readCredentialsFile(file) ?? { version: 1 as const, credentials: {} };
  store.credentials[normalizeApiUrl(apiUrl)] = { apiKey, createdAt: now.toISOString() };
  writeCredentialsFile(file, store);
}

/** Remove an instance's entry. Returns whether anything was removed. */
export function removeKey(apiUrl: string, file: string = credentialsPath()): boolean {
  const store = readCredentialsFile(file);
  const key = normalizeApiUrl(apiUrl);
  if (!store || !(key in store.credentials)) return false;
  delete store.credentials[key];
  writeCredentialsFile(file, store);
  return true;
}

/** Atomic write (temp + rename), file 0600, parent dir 0700. */
function writeCredentialsFile(file: string, data: CredentialsFile): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/cli && npx vitest run test/credentials.test.ts
```

Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/api/credentials.ts packages/cli/test/credentials.test.ts
git commit -m "feat(cli): credential store for bffless login"
```

---

### Task 2: Store fallback in `createClient` + remediation wording

**Files:**
- Modify: `packages/cli/src/api/client.ts` (module doc lines 7–10; `ClientDeps`; `createClient` line ~182)
- Modify: `packages/cli/src/api/remediation.ts` (`CLI_REMEDIATION.apiKey`, `.auth`)
- Test: `packages/cli/test/client.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `getStoredKey(apiUrl, file?)` from Task 1.
- Produces: `ClientDeps.credentialsFile?: string` (test seam); key precedence `flags.apiKey > env.BFFLESS_API_KEY > store[normalized apiUrl]`. Tasks 3–4 rely on remediation text mentioning `bffless login`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/client.test.ts` (reuse the existing `stubFetch` helper in that file):

```typescript
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storeKey } from '../src/api/credentials.js';

describe('createClient credential-store fallback', () => {
  function seededStore(apiUrl: string, key: string): string {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'bffless-cred-')), 'credentials.json');
    storeKey(apiUrl, key, file);
    return file;
  }

  it('uses the stored key when flag and env are absent', async () => {
    const file = seededStore('https://api.test', 'k-stored');
    const { fetchImpl, calls } = stubFetch({ 'GET https://api.test/api/projects': { body: [] } });
    const client = createClient({}, '/tmp', {
      env: {},
      config: { apiUrl: 'https://api.test' },
      credentialsFile: file,
      fetchImpl,
    });
    await client.get('/api/projects');
    expect((calls[0].init?.headers as Record<string, string>)['X-API-Key']).toBe('k-stored');
  });

  it('flag and env both beat the store', async () => {
    const file = seededStore('https://api.test', 'k-stored');
    const base = { config: { apiUrl: 'https://api.test' }, credentialsFile: file } as const;
    const a = stubFetch({ 'GET https://api.test/api/projects': { body: [] } });
    await createClient({ apiKey: 'k-flag' }, '/tmp', { ...base, env: {}, fetchImpl: a.fetchImpl }).get('/api/projects');
    expect((a.calls[0].init?.headers as Record<string, string>)['X-API-Key']).toBe('k-flag');

    const b = stubFetch({ 'GET https://api.test/api/projects': { body: [] } });
    await createClient({}, '/tmp', { ...base, env: { BFFLESS_API_KEY: 'k-env' }, fetchImpl: b.fetchImpl }).get('/api/projects');
    expect((b.calls[0].init?.headers as Record<string, string>)['X-API-Key']).toBe('k-env');
  });

  it('store lookup matches by normalized URL (config URL with trailing slash)', async () => {
    const file = seededStore('https://api.test', 'k-stored');
    const { fetchImpl, calls } = stubFetch({ 'GET https://api.test/api/projects': { body: [] } });
    const client = createClient({}, '/tmp', {
      env: {},
      config: { apiUrl: 'https://api.test/' },
      credentialsFile: file,
      fetchImpl,
    });
    await client.get('/api/projects');
    expect((calls[0].init?.headers as Record<string, string>)['X-API-Key']).toBe('k-stored');
  });

  it('no flag, env, or store entry → error mentions bffless login', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'bffless-cred-')), 'credentials.json');
    expect(() =>
      createClient({}, '/tmp', { env: {}, config: { apiUrl: 'https://api.test' }, credentialsFile: file }),
    ).toThrow(/bffless login/);
  });
});
```

- [ ] **Step 2: Run tests to verify the new block fails**

```bash
cd packages/cli && npx vitest run test/client.test.ts
```

Expected: new tests FAIL (`credentialsFile` unknown / stored key not used / message lacks `bffless login`); pre-existing tests still pass.

- [ ] **Step 3: Implement**

In `packages/cli/src/api/client.ts`:

1. Add to imports: `import { getStoredKey } from './credentials.js';`
2. Add to `ClientDeps`:

```typescript
  /** Override the credential-store file path (tests). Default: `credentialsPath()`. */
  credentialsFile?: string;
```

3. Replace the key resolution in `createClient` (currently lines 181–185):

```typescript
  // Key precedence is flag > env > credential store — never config.json (a committed
  // file; see module doc). The store (written by `bffless login`) lives in ~/.config,
  // outside any repo, and is keyed by normalized apiUrl.
  const apiKey = flags.apiKey ?? env.BFFLESS_API_KEY ?? getStoredKey(apiUrl, deps?.credentialsFile);
```

4. Update the module doc comment (lines 7–10) to describe the new chain:

```typescript
 * API-key resolution: `--api-key` flag > `BFFLESS_API_KEY` env > the `bffless login`
 * credential store (~/.config/bffless/credentials.json, keyed by normalized apiUrl) —
 * and NOTHING else. The key is deliberately never read from `.bffless/config.json`:
 * that file is meant to be committed to the repo (it carries `apiUrl`/`project`/
 * `ruleSets` for the whole team), so supporting a key there would invite committing
 * credentials. Keys stay in flags/env/the out-of-repo store only.
```

In `packages/cli/src/api/remediation.ts`, update two `CLI_REMEDIATION` fields:

```typescript
  apiKey:
    'pass --api-key, set BFFLESS_API_KEY, or run `bffless login` (API keys are never read ' +
    'from .bffless/config.json, which is committed to the repo)',
```

```typescript
  auth:
    'The API key is sent as the X-API-Key header — pass --api-key, set BFFLESS_API_KEY, or ' +
    'run `bffless login` with a key that has access to this project.',
```

- [ ] **Step 4: Run the full CLI suite**

```bash
cd packages/cli && pnpm test
```

Expected: PASS. If any pre-existing test asserted the exact old remediation strings (e.g. matching `pass --api-key or set BFFLESS_API_KEY`), update that assertion to the new wording — the regexes shown in `client.test.ts` (`/X-API-Key/`, `/BFFLESS_API_KEY/`) already survive.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/api/client.ts packages/cli/src/api/remediation.ts packages/cli/test/client.test.ts
git commit -m "feat(cli): resolve API key from the login credential store (flag > env > store)"
```

---

### Task 3: `auth` command logic (login / logout / status / token)

**Files:**
- Create: `packages/cli/src/commands/auth.ts`
- Test: `packages/cli/test/auth.test.ts`

**Interfaces:**
- Consumes: Task 1's store functions; `ApiClient`, `FetchLike` from `../api/client.js`; `findConfig` from `../config.js`.
- Produces (wired by Task 4):
  - `interface AuthDeps { env?; fetchImpl?; credentialsFile?; promptSecret?; log? }`
  - `runLogin(opts: { apiUrl?: string }, cwd: string, deps?: AuthDeps): Promise<{ ok: true; apiUrl: string } | { ok: false; error: string }>`
  - `runLogout(opts: { apiUrl?: string }, cwd: string, deps?: AuthDeps): { ok: true; apiUrl: string; removed: boolean } | { ok: false; error: string }`
  - `runAuthStatus(deps?: AuthDeps): Promise<AuthStatusRow[]>` with `AuthStatusRow = { apiUrl: string; keyPrefix: string; valid: boolean }`
  - `runAuthToken(opts: { apiUrl?: string }, cwd: string, deps?: AuthDeps): { ok: true; token: string } | { ok: false; error: string }`
  - `promptSecret(question: string): Promise<string>` (interactive; masked when TTY, reads piped stdin otherwise)

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLogin, runLogout, runAuthStatus, runAuthToken } from '../src/commands/auth.js';
import { getStoredKey, storeKey } from '../src/api/credentials.js';
import type { FetchLike } from '../src/api/client.js';

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'bffless-auth-')), 'credentials.json');
}

/** fetch stub keyed by `METHOD url`, answering by the request's X-API-Key. */
function fetchByKey(url: string, keyStatus: Record<string, number>): FetchLike {
  return async (reqUrl, init) => {
    if (reqUrl !== `${url}/api/projects`) throw new Error(`unexpected url ${reqUrl}`);
    const key = (init?.headers as Record<string, string>)['X-API-Key'];
    const status = keyStatus[key] ?? 401;
    return new Response(status === 200 ? '[]' : '{"message":"Invalid API key"}', {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('runLogin', () => {
  it('validates the pasted key then stores it under the normalized URL', async () => {
    const file = tmpFile();
    const logs: string[] = [];
    const result = await runLogin({ apiUrl: 'https://Api.Test/' }, '/tmp', {
      env: {},
      credentialsFile: file,
      fetchImpl: fetchByKey('https://api.test', { 'k-good': 200 }),
      promptSecret: async () => 'k-good',
      log: (m) => logs.push(m),
    });
    expect(result).toEqual({ ok: true, apiUrl: 'https://api.test' });
    expect(getStoredKey('https://api.test', file)).toBe('k-good');
    expect(logs.join('\n')).toMatch(/API key/i);
  });

  it('stores NOTHING when validation fails', async () => {
    const file = tmpFile();
    const result = await runLogin({ apiUrl: 'https://api.test' }, '/tmp', {
      env: {},
      credentialsFile: file,
      fetchImpl: fetchByKey('https://api.test', {}),
      promptSecret: async () => 'k-bad',
      log: () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/nothing (was )?stored/i);
    expect(existsSync(file)).toBe(false);
  });

  it('rejects an empty key without a network call', async () => {
    const result = await runLogin({ apiUrl: 'https://api.test' }, '/tmp', {
      env: {},
      credentialsFile: tmpFile(),
      fetchImpl: async () => { throw new Error('must not be called'); },
      promptSecret: async () => '  ',
      log: () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty/i);
  });

  it('errors when no apiUrl is resolvable', async () => {
    const result = await runLogin({}, os.tmpdir(), {
      env: {},
      credentialsFile: tmpFile(),
      promptSecret: async () => 'k',
      log: () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--api-url/);
  });

  it('falls back to BFFLESS_API_URL from env', async () => {
    const file = tmpFile();
    const result = await runLogin({}, os.tmpdir(), {
      env: { BFFLESS_API_URL: 'https://env.test' },
      credentialsFile: file,
      fetchImpl: fetchByKey('https://env.test', { 'k-good': 200 }),
      promptSecret: async () => 'k-good',
      log: () => {},
    });
    expect(result).toEqual({ ok: true, apiUrl: 'https://env.test' });
  });
});

describe('runLogout', () => {
  it('removes the entry and reports removed: true, then false on repeat', () => {
    const file = tmpFile();
    storeKey('https://api.test', 'k', file);
    const deps = { env: {}, credentialsFile: file };
    expect(runLogout({ apiUrl: 'https://api.test' }, '/tmp', deps)).toEqual({
      ok: true,
      apiUrl: 'https://api.test',
      removed: true,
    });
    expect(runLogout({ apiUrl: 'https://api.test' }, '/tmp', deps)).toEqual({
      ok: true,
      apiUrl: 'https://api.test',
      removed: false,
    });
  });
});

describe('runAuthStatus', () => {
  it('lists each stored instance with a key prefix and live validity', async () => {
    const file = tmpFile();
    storeKey('https://a.test', 'k-valid-12345', file);
    storeKey('https://b.test', 'k-revoked-999', file);
    const fetchImpl: FetchLike = async (reqUrl) =>
      new Response(reqUrl.startsWith('https://a.test') ? '[]' : '{"message":"Invalid API key"}', {
        status: reqUrl.startsWith('https://a.test') ? 200 : 401,
        headers: { 'Content-Type': 'application/json' },
      });
    const rows = await runAuthStatus({ credentialsFile: file, fetchImpl });
    expect(rows).toEqual([
      { apiUrl: 'https://a.test', keyPrefix: 'k-valid-…', valid: true },
      { apiUrl: 'https://b.test', keyPrefix: 'k-revoke…', valid: false },
    ]);
  });

  it('returns [] when nothing is stored', async () => {
    expect(await runAuthStatus({ credentialsFile: tmpFile() })).toEqual([]);
  });
});

describe('runAuthToken', () => {
  it('returns the stored key for the resolved instance', () => {
    const file = tmpFile();
    storeKey('https://api.test', 'k-tok', file);
    expect(runAuthToken({ apiUrl: 'https://api.test' }, '/tmp', { env: {}, credentialsFile: file })).toEqual({
      ok: true,
      token: 'k-tok',
    });
  });

  it('errors with login remediation when nothing is stored for the instance', () => {
    const result = runAuthToken({ apiUrl: 'https://api.test' }, '/tmp', { env: {}, credentialsFile: tmpFile() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/bffless login/);
      expect(result.error).toMatch(/BFFLESS_API_KEY/);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/cli && npx vitest run test/auth.test.ts
```

Expected: FAIL — cannot resolve `../src/commands/auth.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/cli/src/commands/auth.ts`:

```typescript
/**
 * `bffless login` / `logout` / `auth status` / `auth token` — the paste-a-key
 * credential flow over api/credentials.ts.
 *
 * The API URL identifies WHICH instance to act on and resolves exactly like the
 * client's base URL: `--api-url` flag > `BFFLESS_API_URL` env > nearest
 * `.bffless/config.json`. So inside an app repo clone, `bffless login` /
 * `auth token` need no arguments at all.
 *
 * `login` validates the pasted key with a real call (`GET /api/projects` — cheap,
 * key-only) BEFORE storing: a typo'd key should fail at login time, not on the
 * first `rules push` a week later.
 */
import { findConfig } from '../config.js';
import { ApiClient, type FetchLike } from '../api/client.js';
import {
  credentialsPath,
  getStoredKey,
  normalizeApiUrl,
  readCredentialsFile,
  removeKey,
  storeKey,
} from '../api/credentials.js';

export interface AuthDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  /** Override the credential-store file path (tests). */
  credentialsFile?: string;
  /** Override the interactive secret prompt (tests). */
  promptSecret?: (question: string) => Promise<string>;
  /** Override instruction output (tests). Default: console.log. */
  log?: (message: string) => void;
}

export interface AuthStatusRow {
  apiUrl: string;
  keyPrefix: string;
  valid: boolean;
}

const API_URL_REMEDIATION =
  'pass --api-url, set BFFLESS_API_URL, or run from a repo with "apiUrl" in .bffless/config.json';

/** Same base-URL precedence as createClient: flag > env > config walk-up. */
function resolveApiUrl(
  opts: { apiUrl?: string },
  cwd: string,
  env: Record<string, string | undefined>,
): string | undefined {
  return opts.apiUrl ?? env.BFFLESS_API_URL ?? findConfig(cwd)?.config.apiUrl ?? undefined;
}

/** Read a secret from the terminal (masked) or from piped stdin (first line). */
export function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (c: Buffer) => chunks.push(c));
      process.stdin.on('end', () =>
        resolve(Buffer.concat(chunks).toString('utf8').split('\n')[0].trim()),
      );
      process.stdin.on('error', reject);
    });
  }
  process.stdout.write(question);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          // Ctrl-C
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function runLogin(
  opts: { apiUrl?: string },
  cwd: string,
  deps?: AuthDeps,
): Promise<{ ok: true; apiUrl: string } | { ok: false; error: string }> {
  const env = deps?.env ?? process.env;
  const log = deps?.log ?? console.log;
  const rawUrl = resolveApiUrl(opts, cwd, env);
  if (!rawUrl) return { ok: false, error: `no API URL configured — ${API_URL_REMEDIATION}` };

  let apiUrl: string;
  try {
    apiUrl = normalizeApiUrl(rawUrl);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  log(`Logging in to ${apiUrl}`);
  log(`Create an API key in the BFFless admin UI (${apiUrl} → Settings → API Keys), then paste it below.`);
  const key = await (deps?.promptSecret ?? promptSecret)('API key: ');
  if (key.length === 0) return { ok: false, error: 'empty API key — nothing stored' };

  const client = new ApiClient({ apiUrl, apiKey: key, fetchImpl: deps?.fetchImpl });
  try {
    await client.get('/api/projects', 'project list');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `key validation failed — nothing stored.\n${msg}` };
  }

  storeKey(apiUrl, key, deps?.credentialsFile);
  return { ok: true, apiUrl };
}

export function runLogout(
  opts: { apiUrl?: string },
  cwd: string,
  deps?: AuthDeps,
): { ok: true; apiUrl: string; removed: boolean } | { ok: false; error: string } {
  const env = deps?.env ?? process.env;
  const rawUrl = resolveApiUrl(opts, cwd, env);
  if (!rawUrl) return { ok: false, error: `no API URL configured — ${API_URL_REMEDIATION}` };
  const apiUrl = normalizeApiUrl(rawUrl);
  return { ok: true, apiUrl, removed: removeKey(apiUrl, deps?.credentialsFile) };
}

export async function runAuthStatus(deps?: AuthDeps): Promise<AuthStatusRow[]> {
  const file = deps?.credentialsFile ?? credentialsPath(deps?.env ?? process.env);
  const store = readCredentialsFile(file);
  if (!store) return [];
  const rows: AuthStatusRow[] = [];
  for (const [apiUrl, entry] of Object.entries(store.credentials).sort(([a], [b]) => a.localeCompare(b))) {
    const client = new ApiClient({ apiUrl, apiKey: entry.apiKey, fetchImpl: deps?.fetchImpl });
    let valid = true;
    try {
      await client.get('/api/projects', 'project list');
    } catch {
      valid = false;
    }
    rows.push({ apiUrl, keyPrefix: `${entry.apiKey.slice(0, 8)}…`, valid });
  }
  return rows;
}

export function runAuthToken(
  opts: { apiUrl?: string },
  cwd: string,
  deps?: AuthDeps,
): { ok: true; token: string } | { ok: false; error: string } {
  const env = deps?.env ?? process.env;
  const rawUrl = resolveApiUrl(opts, cwd, env);
  if (!rawUrl) return { ok: false, error: `no API URL configured — ${API_URL_REMEDIATION}` };
  const apiUrl = normalizeApiUrl(rawUrl);
  const token = getStoredKey(apiUrl, deps?.credentialsFile);
  if (!token) {
    return {
      ok: false,
      error:
        `no stored credentials for ${apiUrl} — run \`bffless login\` once on this machine, ` +
        'or set BFFLESS_API_KEY',
    };
  }
  return { ok: true, token };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/cli && npx vitest run test/auth.test.ts
```

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/auth.ts packages/cli/test/auth.test.ts
git commit -m "feat(cli): login/logout/auth status/auth token command logic"
```

---

### Task 4: Commander wiring + CLI README

**Files:**
- Modify: `packages/cli/src/index.ts` (add commands after the `rules` group, before `program.parseAsync()` at line ~366)
- Modify: `packages/cli/README.md` (add an "Authentication" section)

**Interfaces:**
- Consumes: Task 3's `runLogin`, `runLogout`, `runAuthStatus`, `runAuthToken`, `promptSecret`.
- Produces: user-facing commands `bffless login`, `bffless logout`, `bffless auth status`, `bffless auth token` (all accepting `--api-url <url>`).

- [ ] **Step 1: Wire the commands**

In `packages/cli/src/index.ts`, add to the imports:

```typescript
import { runLogin, runLogout, runAuthStatus, runAuthToken } from './commands/auth.js';
```

Insert before `program.parseAsync()`:

```typescript
program
  .command('login')
  .description(
    'Store an API key for a BFFless instance in ~/.config/bffless/credentials.json ' +
      '(paste-a-key; validated against the instance before saving). All commands then ' +
      'use it automatically when --api-key/BFFLESS_API_KEY are absent.',
  )
  .option('--api-url <url>', 'API base URL (overrides BFFLESS_API_URL and config apiUrl)')
  .action(async (opts: { apiUrl?: string }) => {
    const result = await runLogin(opts, process.cwd());
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.log(`stored credentials for ${result.apiUrl}`);
  });

program
  .command('logout')
  .description('Remove the stored API key for a BFFless instance')
  .option('--api-url <url>', 'API base URL (overrides BFFLESS_API_URL and config apiUrl)')
  .action((opts: { apiUrl?: string }) => {
    const result = runLogout(opts, process.cwd());
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.log(
      result.removed
        ? `removed credentials for ${result.apiUrl}`
        : `no stored credentials for ${result.apiUrl} — nothing to remove`,
    );
  });

const auth = program
  .command('auth')
  .description('Inspect the credential store written by `bffless login` (status, token)');

auth
  .command('status')
  .description('List stored instances (key prefix only) and whether each key still validates')
  .action(async () => {
    const rows = await runAuthStatus();
    if (rows.length === 0) {
      console.log('no stored credentials — run `bffless login`');
      return;
    }
    for (const row of rows) {
      console.log(`${row.apiUrl}  ${row.keyPrefix}  ${row.valid ? 'valid' : 'INVALID'}`);
    }
    if (rows.some((r) => !r.valid)) process.exitCode = 1;
  });

auth
  .command('token')
  .description(
    'Print the stored API key for the resolved instance to stdout (pipe-safe), e.g. ' +
      'curl -H "X-API-Key: $(bffless auth token)" …',
  )
  .option('--api-url <url>', 'API base URL (overrides BFFLESS_API_URL and config apiUrl)')
  .action((opts: { apiUrl?: string }) => {
    const result = runAuthToken(opts, process.cwd());
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.log(result.token);
  });
```

- [ ] **Step 2: Add the README section**

In `packages/cli/README.md`, add after the existing setup/usage intro (match the README's heading level):

```markdown
## Authentication

Every server command needs an API key, resolved as: `--api-key` flag >
`BFFLESS_API_KEY` env > the login credential store. Keys are never read from
`.bffless/config.json` (it is committed to the repo).

One-time per machine + instance, store a key interactively:

    bffless login                       # instance from .bffless/config.json
    bffless login --api-url https://admin.example.com

`login` tells you where to create the key (admin UI → Settings → API Keys),
validates the pasted key against the instance, and saves it to
`~/.config/bffless/credentials.json` (mode 0600, keyed by instance URL — one
entry per instance).

    bffless auth status                 # list stored instances + validity
    bffless auth token                  # print the key (for scripts/agents)
    bffless logout                      # remove an instance's entry

Scripts and other tools can reuse the stored key without parsing anything:

    curl -H "X-API-Key: $(bffless auth token)" https://admin.example.com/api/projects

CI should keep using `BFFLESS_API_KEY` — env always beats the store.
```

- [ ] **Step 3: Build + full test suite + manual smoke**

```bash
cd packages/cli && pnpm test
node dist/index.js login --help
node dist/index.js auth token --api-url https://nowhere.invalid; echo "exit: $?"
```

Expected: suite PASS; `login --help` shows the option; `auth token` prints the `no stored credentials … bffless login` remediation and `exit: 1`.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/README.md
git commit -m "feat(cli): wire login/logout/auth commands and document authentication"
```

---

### Task 5: CE PR + release (USER GATE)

**Files:** none (process task).

- [ ] **Step 1: Ask the user** to review the branch and approve opening the PR. Show `git log --oneline origin/main..HEAD` and a diffstat. Do NOT push without approval.

- [ ] **Step 2 (after approval): Push and open the PR**

```bash
cd /home/rico/bffless/repos/ce/.claude/worktrees/cli-login
git push -u origin feat/cli-login
gh pr create --title "feat(cli): bffless login credential store + auth commands" --body-file - <<'EOF'
Adds a paste-a-key credential store to the CLI so agents and scripts no longer
scrape API keys out of runtime configs.

- `bffless login` / `logout` — store/remove a validated key per instance in
  `~/.config/bffless/credentials.json` (0600, atomic writes)
- `bffless auth status` / `auth token` — inspect / retrieve stored keys
- Key resolution is now flag > env > store (env still wins for CI); keys remain
  never-read from committed files
- Spec: bffless/apps `docs/superpowers/specs/2026-07-27-app-skills-and-cli-auth-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 3: After merge, confirm the released CLI version** (release-please → npm). Record the exact version that first contains `auth token`:

```bash
npm view bffless version
npm view bffless@latest dist-tags --json
```

Write the version down — Task 8 substitutes it into the skill. Do not proceed to Task 8's final steps until the npm release is live.

---

## Part B — Public collection in `repos/apps`

*(Tasks 6–7 can start before Task 5 completes; only Task 8's final steps wait on the release.)*

### Task 6: Plugin scaffolding + sync-script extension (skill moved unchanged)

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/bffless-apps/.claude-plugin/plugin.json`
- Move: `.claude/skills/handoff-api/` → `plugins/bffless-apps/skills/handoff-api/` (content unchanged in this task)
- Modify: `scripts/sync-skills.mjs` (full rewrite below)
- Modify: `.github/workflows/skills-parity.yml` (add `plugins/**` to paths)

**Interfaces:**
- Consumes: existing `skills-lock.json` vendored-name convention.
- Produces: skill categories used by Task 7 — *published* skills are canonical under `plugins/bffless-apps/skills/<name>/` and mirrored into BOTH `.claude/skills/<name>/` and `.agents/skills/<name>/`; *authored* skills stay canonical in `.claude/skills/` and mirror to `.agents/skills/` as before.

- [ ] **Step 1: Create the worktree**

```bash
cd /home/rico/bffless/repos/apps
git fetch origin
git worktree add .claude/worktrees/app-skills-plugin -b feat/app-skills-plugin origin/main
cd .claude/worktrees/app-skills-plugin
```

All subsequent Part B paths are relative to `repos/apps/.claude/worktrees/app-skills-plugin/`.

- [ ] **Step 2: Scaffold the plugin manifests**

Create `.claude-plugin/marketplace.json`:

```json
{
  "name": "bffless-apps-plugins",
  "owner": {
    "name": "BFFless"
  },
  "metadata": {
    "description": "Agent skills for the BFFless give-away apps (Handoff, Reader, Studio)",
    "version": "0.1.0"
  },
  "plugins": [
    {
      "name": "bffless-apps",
      "source": "./plugins/bffless-apps",
      "description": "Skills for apps built on BFFless — currently: drive a Handoff deployment's API as an agent",
      "category": "apps"
    }
  ]
}
```

Create `plugins/bffless-apps/.claude-plugin/plugin.json`:

```json
{
  "name": "bffless-apps",
  "version": "0.1.0",
  "description": "Agent skills for the BFFless give-away apps — currently: drive a Handoff deployment's API as an agent",
  "author": {
    "name": "BFFless"
  },
  "homepage": "https://github.com/bffless/apps",
  "repository": "https://github.com/bffless/apps",
  "keywords": [
    "bffless",
    "handoff",
    "skills"
  ],
  "skills": [
    "./skills/"
  ]
}
```

(No `license` field: the monorepo's `package.json` declares none — do not invent one. If the repo has a `LICENSE` file at implementation time, copy its SPDX identifier into both manifests instead.)

- [ ] **Step 3: Move the skill (content unchanged)**

```bash
mkdir -p plugins/bffless-apps/skills
git mv .claude/skills/handoff-api plugins/bffless-apps/skills/handoff-api
```

- [ ] **Step 4: Rewrite `scripts/sync-skills.mjs`**

Replace the whole file with:

```javascript
#!/usr/bin/env node
// Dual-home repo-local skills into both harness directories.
//
// Three categories:
//  - vendored  (keys of skills-lock.json): fanned out by the `skills` CLI — in
//    `.claude/skills/` they are symlinks into `.agents/skills/`. Not our job here.
//  - published (canonical under plugins/bffless-apps/skills/): the public
//    collection third parties install (skills CLI / Claude plugin marketplace).
//    Mirrored into BOTH `.claude/skills/<name>/` and `.agents/skills/<name>/` as
//    real, byte-identical files so in-repo agents see them without the plugin.
//  - authored  (real dirs under `.claude/skills/`, not vendored, not published):
//    repo-private skills (e.g. install-app). Canonical in `.claude/skills/`,
//    mirrored into `.agents/skills/<name>/`.
//
//   node scripts/sync-skills.mjs          # write the mirror copies
//   node scripts/sync-skills.mjs --check  # verify parity, exit 1 on drift
//
// The sets are derived, not hard-coded: drop a skill directory into
// `plugins/bffless-apps/skills/` (published) or `.claude/skills/` (authored)
// and it is picked up here.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLAUDE_DIR = path.join(repoRoot, '.claude', 'skills')
const AGENTS_DIR = path.join(repoRoot, '.agents', 'skills')
const PLUGIN_DIR = path.join(repoRoot, 'plugins', 'bffless-apps', 'skills')
const LOCK_FILE = path.join(repoRoot, 'skills-lock.json')

const check = process.argv.includes('--check')

async function vendoredSkillNames() {
  try {
    const lock = JSON.parse(await fs.readFile(LOCK_FILE, 'utf8'))
    return new Set(Object.keys(lock.skills ?? {}))
  } catch {
    return new Set()
  }
}

// Published skills = directories under plugins/bffless-apps/skills/.
async function publishedSkills() {
  try {
    const entries = await fs.readdir(PLUGIN_DIR, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

// Authored skills = real dirs under .claude/skills not vendored and not published
// (published mirrors land in .claude/skills too — the plugin copy is canonical).
async function authoredSkills(published) {
  const vendored = await vendoredSkillNames()
  const publishedSet = new Set(published)
  const entries = await fs.readdir(CLAUDE_DIR, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !vendored.has(e.name) && !publishedSet.has(e.name))
    .map((e) => e.name)
    .sort()
}

// Recursively list files (repo-relative to `dir`) so we can compare/copy trees.
async function listFiles(dir) {
  const out = []
  async function walk(rel) {
    const abs = path.join(dir, rel)
    const entries = await fs.readdir(abs, { withFileTypes: true })
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = path.join(rel, e.name)
      if (e.isDirectory()) await walk(childRel)
      else out.push(childRel)
    }
  }
  await walk('')
  return out.sort()
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

const drift = []

// Mirror one skill from its canonical `src` dir into each of `dstDirs`
// (byte-identical real files; in write mode removals propagate).
async function mirrorSkill(name, src, dstDirs) {
  const srcFiles = await listFiles(src)
  const srcLabel = path.relative(repoRoot, src)

  for (const dst of dstDirs) {
    const dstLabel = path.relative(repoRoot, dst)

    if (check) {
      if (!(await exists(dst))) {
        drift.push(`missing: ${dstLabel} (canonical exists in ${srcLabel})`)
        continue
      }
      const dstFiles = await listFiles(dst)
      const srcSet = new Set(srcFiles)
      const dstSet = new Set(dstFiles)
      for (const f of dstFiles) {
        if (!srcSet.has(f)) drift.push(`extra:   ${dstLabel}/${f} (not in canonical ${srcLabel})`)
      }
      for (const f of srcFiles) {
        if (!dstSet.has(f)) {
          drift.push(`missing: ${dstLabel}/${f}`)
          continue
        }
        const a = await fs.readFile(path.join(src, f))
        const b = await fs.readFile(path.join(dst, f))
        if (!a.equals(b)) drift.push(`differs: ${dstLabel}/${f} (canonical: ${srcLabel})`)
      }
      continue
    }

    // Write mode: mirror canonical → dst (fresh, so removals propagate).
    await fs.rm(dst, { recursive: true, force: true })
    for (const f of srcFiles) {
      const to = path.join(dst, f)
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.copyFile(path.join(src, f), to)
    }
    console.log(`synced ${name}: ${srcFiles.length} file(s) → ${dstLabel}/`)
  }
}

const published = await publishedSkills()
const authored = await authoredSkills(published)
if (published.length + authored.length === 0) {
  console.error('no published or authored skills found')
  process.exit(1)
}

for (const name of published) {
  await mirrorSkill(name, path.join(PLUGIN_DIR, name), [path.join(CLAUDE_DIR, name), path.join(AGENTS_DIR, name)])
}
for (const name of authored) {
  await mirrorSkill(name, path.join(CLAUDE_DIR, name), [path.join(AGENTS_DIR, name)])
}

if (check) {
  if (drift.length > 0) {
    console.error('skills parity check FAILED — mirror copies drifted from canonical:')
    for (const d of drift) console.error('  ' + d)
    console.error('\nRun `pnpm skills:sync` and commit the result.')
    process.exit(1)
  }
  console.log(`skills parity OK (published: ${published.join(', ') || 'none'}; authored: ${authored.join(', ') || 'none'})`)
}
```

- [ ] **Step 5: Update the parity workflow paths**

In `.github/workflows/skills-parity.yml`, add one line to the `paths:` list (keep the rest unchanged):

```yaml
      - 'plugins/**'
```

- [ ] **Step 6: Run the sync and verify parity**

```bash
node scripts/sync-skills.mjs
node scripts/sync-skills.mjs --check
git status --short
```

Expected: sync reports `handoff-api` → both `.claude/skills/handoff-api/` and `.agents/skills/handoff-api/`; check prints `skills parity OK (published: handoff-api; authored: install-app, …)`; `git status` shows the re-created `.claude/skills/handoff-api/` copy (byte-identical to the moved canonical, so `.agents/` shows no diff).

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin plugins .claude/skills/handoff-api .agents/skills/handoff-api scripts/sync-skills.mjs .github/workflows/skills-parity.yml
git commit -m "feat: public bffless-apps skill collection (plugin marketplace + published-skill sync)"
```

---

### Task 7: Rewrite `handoff-api` as a deployment-generic skill + README install section

**Files:**
- Modify: `plugins/bffless-apps/skills/handoff-api/SKILL.md` (full replacement below)
- Modify: `README.md` (add "Agent skills" install section)
- Regenerate: `.claude/skills/handoff-api/`, `.agents/skills/handoff-api/` (via sync)

**Interfaces:**
- Consumes: Task 6's published-skill mirroring; Part A's `bffless auth token` (referenced by content only).
- Produces: the public skill text; Task 8 substitutes the released CLI version into it.

- [ ] **Step 1: Replace `plugins/bffless-apps/skills/handoff-api/SKILL.md`** with:

```markdown
---
name: handoff-api
description: Upload, organize, and share content in a Handoff deployment by calling its BFFless pipeline API directly, authenticating with a BFFless API key (X-API-Key)
---

# Handoff API

Handoff is a give-away file-sharing app that runs on BFFless: it has no app
server — its `/api/*` endpoints are a BFFless proxy rule set attached to the
deployment's alias. This skill drives them directly as an agent, against any
Handoff deployment.

## Base URL

Resolve the deployment's base URL, in order:

1. `HANDOFF_BASE_URL` env var, if set.
2. Ask the user, or take it from context (e.g. "my handoff is at
   handoff.example.com").

Examples below use `$HANDOFF_BASE_URL` (e.g. `https://handoff.example.com`).

## Auth (send a BFFless API key as X-API-Key)

Every `/api/*` call needs an API key for the BFFless project serving the
deployment, sent as the `X-API-Key` header. Source it in order:

1. **`BFFLESS_API_KEY` env var** (CI, sandboxes, any runtime):

       curl -H "X-API-Key: $BFFLESS_API_KEY" "$HANDOFF_BASE_URL/api/nodes"

2. **The `bffless` CLI credential store** (requires `bffless` >= 0.4.0; filled
   by a one-time human `bffless login` per machine + instance):

       curl -H "X-API-Key: $(npx bffless auth token)" "$HANDOFF_BASE_URL/api/nodes"

   Inside a cloned Handoff repo, `auth token` resolves the instance from
   `.bffless/config.json` automatically; elsewhere pass
   `--api-url https://admin.example.com` (the BFFless admin URL, not the
   Handoff URL).

If neither yields a key, stop and tell the user to run `npx bffless login`
(or export `BFFLESS_API_KEY`). Do not hunt for keys in agent-runtime config
files.

The key authenticates as its owner, so content you create is owned by that
user (the same as uploading in the browser). The PUT-to-bucket step (below) is
the one exception — it is presigned and takes no key.

## Discovery

In a Handoff repo clone, the endpoint source of truth is the authored rules
under `.bffless/proxy-rules/` — `handoff/` (the `/api/*` app backend) and
`handoff-rss-feed/` (the public `/feed/*` feeds). Each route is a
`rules/**/rule.yaml` whose path mirrors the URL. Outside a clone (or for live
state), `get_proxy_rule_set` via a BFFless MCP connection to the instance
works too, but is optional.

## Upload a file (prepare → PUT → register)

1. `POST /api/uploads/prepare` `{filename, contentType, path, parentId}` → `{uploadUrl, storageKey, originalName, …}`
2. `PUT <uploadUrl>` with `Content-Type: <type>` and the raw file bytes (direct to bucket, no key)
3. `POST /api/nodes` `{storageKey, originalName, parentId:"root"|<folderId>, displayName, createdMs}` → `{node}`

- **`path` is required** — Handoff uses a *verbatim* key strategy (structural
  storage), so prepare needs the file's **verbatim content sub-path**: the
  owning folder's path + the filename. At root that is just the filename
  (`report.md`); in a folder it is `<folder path>/<filename>`
  (`Design Docs/Q3/report.md`). In a repo clone this is what
  `contentSubPath(folderPath, filename)` computes in
  `apps/handoff/src/lib/contentPath.ts`. Omitting `path` fails with
  `400 MISSING_KEY` ("expected a path string for verbatim keyStrategy").
- **`parentId`** (`"root"` or a folder id) should match `path`'s folder.
  Sending it to *prepare* lets an in-folder name collision be rejected
  **before** any bytes are minted/PUT, so an existing file is never
  overwritten.
- Pass the `storageKey` prepare returns to register **unchanged** (it is the
  full bucket key).
- `createdMs` is client-supplied epoch ms, e.g. `date +%s%3N`.

Verified root upload (`report.md`): prepare
`{filename:"report.md", contentType:"text/markdown", path:"report.md", parentId:"root"}`
→ PUT bytes to `uploadUrl` → register with the returned `storageKey`.

## Other operations

- List a folder: `GET /api/nodes?parentId=<id>` → `{nodes:[…]}` (omit param for root)
- Create folder: `POST /api/folders` `{parentId, name, createdMs}` → `{node}`
- Read a file back: `POST /api/sign` `{path:<storageKey>}` → `{signed:{url,…}}`
- Share a folder: `POST /api/share-links` `{folderId, expiresMs?}` → share link
- Delete: `DELETE /api/node?id=<uuid>` → `{id}` (refuses a non-empty folder with 409)

## Gotchas

- An empty root listing is normal: content is private-by-default; you only see
  what you own or were granted.
- The PUT step is unauthenticated and goes straight to the bucket — do not add
  the key.
- Delete is write-gated and single-node; delete children before parents.
```

- [ ] **Step 2: Add the install section to `README.md`**

Add a top-level section (after the repo intro, before per-app sections):

```markdown
## Agent skills

This repo publishes agent skills for the apps as the `bffless-apps` collection
(currently: `handoff-api` — drive a Handoff deployment's API as an agent).
Install into your own project either way:

    npx skills add bffless/apps            # skills CLI (any harness)

or add this repo as a Claude Code plugin marketplace and install the
`bffless-apps` plugin. Canonical skill sources live under
`plugins/bffless-apps/skills/`; the copies in `.claude/skills/` and
`.agents/skills/` are generated mirrors (`pnpm skills:sync`).
```

- [ ] **Step 3: Sync mirrors and verify**

```bash
node scripts/sync-skills.mjs
node scripts/sync-skills.mjs --check
grep -c 'handoff.j5s.dev' plugins/bffless-apps/skills/handoff-api/SKILL.md .claude/skills/handoff-api/SKILL.md .agents/skills/handoff-api/SKILL.md || true
```

Expected: parity OK; every `grep -c` reports `0` (no hardcoded instance URLs remain).

- [ ] **Step 4: Commit**

```bash
git add plugins/bffless-apps/skills/handoff-api .claude/skills/handoff-api .agents/skills/handoff-api README.md
git commit -m "feat: generalize handoff-api skill (any deployment; bffless login auth, no MCP-config scraping)"
```

---

### Task 8: Version fill-in, live smoke test, apps PR (USER GATE)

**Files:**
- Modify: `plugins/bffless-apps/skills/handoff-api/SKILL.md` (version substitution) + regenerated mirrors

**Interfaces:**
- Consumes: the released CLI version recorded in Task 5 Step 3; the rewritten skill from Task 7.
- Produces: the final public collection, PR'd.

- [ ] **Step 1: Substitute the real released version** (blocked on Task 5 Step 3). If the released version is not `0.4.0`, replace the string `>= 0.4.0` in `plugins/bffless-apps/skills/handoff-api/SKILL.md` with the actual version, then:

```bash
node scripts/sync-skills.mjs && node scripts/sync-skills.mjs --check
```

- [ ] **Step 2: Live smoke test against j5s.dev** — exercise the skill's instructions verbatim from a shell where `BFFLESS_API_KEY` is NOT exported:

```bash
cd /home/rico/bffless/repos/apps/.claude/worktrees/app-skills-plugin
echo "$KEY" | npx bffless@latest login --api-url https://admin.j5s.dev   # or run interactively; ask the user for a key if none is at hand
npx bffless@latest auth status
export HANDOFF_BASE_URL=https://handoff.j5s.dev
curl -sS -H "X-API-Key: $(npx bffless@latest auth token --api-url https://admin.j5s.dev)" "$HANDOFF_BASE_URL/api/nodes"
```

Then one upload round-trip per the skill (prepare → PUT → register) and a `POST /api/sign` read-back of the uploaded file. Expected: login validates + stores; `auth status` shows `https://admin.j5s.dev … valid`; nodes list returns JSON; upload registers and signs back. If no key is available in the session, ask the user to run the login line via `!` and continue from `auth status`.

- [ ] **Step 3: Commit the version fill-in (if any)**

```bash
git add plugins/bffless-apps/skills/handoff-api .claude/skills/handoff-api .agents/skills/handoff-api
git commit -m "chore: pin handoff-api skill to released bffless CLI version"
```

- [ ] **Step 4: Ask the user** to approve pushing + opening the apps PR (show `git log --oneline origin/main..HEAD`). Also ask whether to commit the spec + this plan (currently sitting on the main checkout at `docs/superpowers/specs/…` and `docs/superpowers/plans/…`) into the same PR — if yes, copy them into the worktree and commit with `docs:` before pushing.

- [ ] **Step 5 (after approval): Push and open the PR**

```bash
git push -u origin feat/app-skills-plugin
gh pr create --title "feat: public bffless-apps skill collection + generalized handoff-api" --body-file - <<'EOF'
Publishes the handoff-api skill as a public collection inside this repo.

- New `plugins/bffless-apps/` Claude plugin + `.claude-plugin/marketplace.json`
  (installable via `npx skills add bffless/apps` or as a Claude plugin marketplace)
- `handoff-api` canonical home moves to the plugin; `.claude/skills/` +
  `.agents/skills/` become generated mirrors (`scripts/sync-skills.mjs`, parity CI)
- Skill generalized to any Handoff deployment (`HANDOFF_BASE_URL`) and re-authed
  on `bffless login` / `auth token` — the MCP-config key scrape is gone
- Depends on bffless CLI >= <released version> (bffless/ce PR <link>)
- Spec: `docs/superpowers/specs/2026-07-27-app-skills-and-cli-auth-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

---

## Plan self-review notes

- **Spec coverage:** login/logout/status/token + store + resolution chain (Tasks 1–4); error handling incl. corrupt-store hard error and store-nothing-on-failed-validation (Tasks 1, 3); marketplace/plugin layout + dual-homing + parity CI (Task 6); skill generalization incl. base-URL resolution, auth rewrite, discovery rewording, frontmatter (Task 7); min-version + E2E smoke + rollout gates (Tasks 5, 8). Out-of-scope items from the spec (device flow, scoping, keychain, multi-key) appear in no task — correct.
- **Deviation from spec (deliberate):** `login`'s apiUrl resolution includes `BFFLESS_API_URL` env between flag and config, matching `createClient`'s existing base-URL precedence exactly rather than the spec's two-source shorthand.
- **Type consistency:** `credentialsFile` is the seam name in both `ClientDeps` and `AuthDeps`; store functions take `(apiUrl, [apiKey,] file?)` throughout; `runAuth*` return-shape unions match the wiring in Task 4.
