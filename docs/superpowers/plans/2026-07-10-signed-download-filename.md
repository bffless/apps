# Signed Downloads With A Chosen Filename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Studio's "Download MP4" pull the final cut straight from the GCS bucket via a presigned URL that carries a `Content-Disposition` header naming the file after the video's title, instead of streaming hundreds of MB through the BFFless backend's `file_serve` handler.

**Architecture:** CE's `signed_url` pipeline handler gains an optional `filename` config, which flows through one sanitizer into a new `SignedUrlOptions` bag on `IStorageAdapter.getUrl()`. Each bucket adapter maps it onto its SDK's native "response content disposition" parameter. Studio's `/api/uploads/sign` proxy rule then forwards a slugified filename, and `FinalCutBar` points its download link at the resulting signed URL.

**Tech Stack:** NestJS + Jest (CE backend); React + Redux Toolkit Query + Vitest + MSW (Studio). Storage SDKs: `@google-cloud/storage`, `minio`, `@azure/storage-blob`.

**Spec:** `docs/superpowers/specs/2026-07-10-signed-download-filename-design.md`

## Global Constraints

- **Two repos, in order.** Tasks 1–5 land in `bffless/ce` on a new branch. Tasks 7–10 land in `bffless/apps` in the **existing worktree** `/home/rico/bffless/repos/apps-signed-download` on branch `feat/signed-download-filename`. Never switch the shared `repos/apps` checkout's branch.
- **Task 6 is a human gate.** CE must be merged, released, and deployed to `j5s.dev` before Task 11 can verify anything. Tasks 7–10 may be written before the deploy; they just can't be verified end-to-end.
- **Omitting `filename` must be behavior-identical to today.** `useSignedBytes` signs the same endpoint for every ffmpeg read. Every adapter change must be a no-op when `downloadFilename` is absent, and each adapter spec must assert that explicitly.
- **The sanitizer in `signed-url.handler.ts` is the only choke point.** Adapters interpolate `downloadFilename` into a header value and must never see control characters, quotes, backslashes, or path separators.
- **`S3StorageAdapter extends MinioStorageAdapter`** (`s3.adapter.ts:20`) and defines no `getUrl`. Changing `minio.adapter.ts` changes both. Do not add a `getUrl` to `s3.adapter.ts`.
- **`local.adapter.getUrl(key)`** takes no `expiresIn` and cannot presign (`supportsPresignedUrls(): false`). It gets a doc comment, not a signature change.
- **Filename slug uses hyphens**, lowercase, `[a-z0-9]+` runs collapsed to `-`, leading/trailing `-` trimmed. Both `thumbnailFileName` and `finalCutFileName` use it.
- **CE test command:** `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest <path>`
- **Studio test command:** `cd /home/rico/bffless/repos/apps-signed-download && pnpm --filter studio exec vitest run <path>`
- **Studio gates:** `pnpm --filter studio build`, `lint`, and `test:run` must all pass before the PR.

---

## File Structure

**CE (`/home/rico/bffless/repos/ce/apps/backend/src/`)**

| File | Responsibility |
| --- | --- |
| `storage/storage.interface.ts` | Declares `SignedUrlOptions` and widens `getUrl`. The contract. |
| `storage/dynamic-storage.adapter.ts` | Forwards the options bag to the wrapped adapter. |
| `storage/local.adapter.ts` | Doc comment only — documents that it ignores the option. |
| `storage/gcs.adapter.ts` | Maps `downloadFilename` → `promptSaveAs`. |
| `storage/minio.adapter.ts` | Maps `downloadFilename` → `response-content-disposition` respHeader. Also covers S3. |
| `storage/azure.adapter.ts` | Maps `downloadFilename` → SAS `contentDisposition`. |
| `pipelines/handlers/signed-url.handler.ts` | Exposes `filename` config; owns `sanitizeDownloadFilename`. |
| `pipelines/handlers/signed-url.handler.spec.ts` | **New.** No spec exists for this handler today. |

**Studio (`/home/rico/bffless/repos/apps-signed-download/apps/studio/`)**

| File | Responsibility |
| --- | --- |
| `src/lib/slug.ts` | **New.** One `slugify()` + the two filename helpers. |
| `src/lib/slug.test.ts` | **New.** Unit tests for all three. |
| `src/lib/thumbnail.ts` | Re-exports `thumbnailFileName` from `slug.ts`; drops its local copy. |
| `src/lib/thumbnail.test.ts` | Expectations move from underscores to hyphens. |
| `src/store/studioApi.ts` | Adds the `signAttachment` query. |
| `src/mocks/handlers.ts` | `/api/uploads/sign` mock accepts + echoes `filename`. |
| `src/components/Studio/FinalCutBar.tsx` | Takes `title`; download `<a>` points at the signed attachment URL. |
| `src/components/Studio/FinalCutBar.test.tsx` | **New.** No test exists for this component today. |
| `src/pages/Studio.tsx:580` | Passes `title={pipe.description?.title ?? ''}`. |
| `bffless/studio.proxy-rules.json` | Re-exported after the live rule change. |

---

# Part 1 — CE

Work in `/home/rico/bffless/repos/ce`. Start with:

```bash
cd /home/rico/bffless/repos/ce && git checkout -b feat/signed-url-filename main
```

---

### Task 1: The `SignedUrlOptions` contract

**Files:**
- Modify: `apps/backend/src/storage/storage.interface.ts:117-123`
- Modify: `apps/backend/src/storage/dynamic-storage.adapter.ts:123-125`
- Modify: `apps/backend/src/storage/local.adapter.ts:184`
- Test: `apps/backend/src/storage/dynamic-storage.adapter.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SignedUrlOptions { downloadFilename?: string }`, exported from `storage.interface.ts`. `getUrl(key: string, expiresIn?: number, options?: SignedUrlOptions): Promise<string>`. Every later CE task imports `SignedUrlOptions` from `../storage/storage.interface` (adapters use `./storage.interface`).

- [ ] **Step 1: Write the failing test**

Add to `apps/backend/src/storage/dynamic-storage.adapter.spec.ts`, inside the existing top-level `describe`:

```typescript
describe('getUrl', () => {
  it('forwards signed URL options to the wrapped adapter', async () => {
    const inner = { getUrl: jest.fn().mockResolvedValue('https://signed') };
    (adapter as any).adapter = inner;

    await adapter.getUrl('a/b.mp4', 600, { downloadFilename: 'my-video.mp4' });

    expect(inner.getUrl).toHaveBeenCalledWith('a/b.mp4', 600, {
      downloadFilename: 'my-video.mp4',
    });
  });

  it('forwards undefined options unchanged', async () => {
    const inner = { getUrl: jest.fn().mockResolvedValue('https://signed') };
    (adapter as any).adapter = inner;

    await adapter.getUrl('a/b.mp4', 600);

    expect(inner.getUrl).toHaveBeenCalledWith('a/b.mp4', 600, undefined);
  });
});
```

If `adapter` is not the variable name used by the existing spec's `beforeEach`, match whatever that file already uses.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest src/storage/dynamic-storage.adapter.spec.ts -t "forwards signed URL options"`
Expected: FAIL — `Expected: "a/b.mp4", 600, {"downloadFilename": "my-video.mp4"}` / `Received: "a/b.mp4", 600` (the third argument is dropped).

- [ ] **Step 3: Widen the interface**

In `storage.interface.ts`, add above the `IStorageAdapter` interface:

```typescript
/**
 * Options for a signed/presigned read URL.
 */
export interface SignedUrlOptions {
  /**
   * Force the browser to save rather than render, under this exact name, by
   * signing `Content-Disposition: attachment; filename="..."` into the URL.
   *
   * Required because `<a download>` is ignored on cross-origin URLs, so the
   * name can only arrive as a response header — and the header can only be
   * signed in, never appended afterward (the signature covers the query string).
   *
   * Ignored by the local adapter, which cannot presign at all.
   *
   * Callers MUST pass a value already sanitized by `sanitizeDownloadFilename`
   * (see `signed-url.handler.ts`): adapters interpolate this straight into a
   * header value.
   */
  downloadFilename?: string;
}
```

Then replace the `getUrl` declaration:

```typescript
  /**
   * Get a URL for accessing the file
   * @param key - Storage key/path
   * @param expiresIn - Optional expiration time in seconds (for presigned URLs)
   * @param options - Optional signed-URL options (e.g. force download w/ filename)
   * @returns URL to access the file
   */
  getUrl(key: string, expiresIn?: number, options?: SignedUrlOptions): Promise<string>;
```

- [ ] **Step 4: Forward from the dynamic adapter**

In `dynamic-storage.adapter.ts`, import `SignedUrlOptions` alongside the existing imports from `./storage.interface`, then replace `getUrl`:

```typescript
  async getUrl(
    key: string,
    expiresIn?: number,
    options?: SignedUrlOptions,
  ): Promise<string> {
    return this.adapter.getUrl(key, expiresIn, options);
  }
```

- [ ] **Step 5: Document the local adapter's no-op**

In `local.adapter.ts`, replace the comment block above `getUrl` (line ~180-184) with:

```typescript
  /**
   * Local storage serves files through the backend API rather than presigning,
   * so there is no signature to embed a `Content-Disposition` into. A
   * `SignedUrlOptions.downloadFilename` passed here is deliberately IGNORED —
   * the browser will render the object inline. Presigned-only apps (e.g. Studio,
   * whose uploads bypass the 1 MB body cap) cannot run on local storage anyway.
   */
  async getUrl(key: string): Promise<string> {
```

Leave the body unchanged. The narrower signature is assignable to the interface.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest src/storage/dynamic-storage.adapter.spec.ts src/storage/local.adapter.spec.ts`
Expected: PASS, all tests.

- [ ] **Step 7: Typecheck**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors. (Adapters that don't yet accept the third parameter still satisfy the interface — TypeScript allows an implementation to declare fewer parameters.)

- [ ] **Step 8: Commit**

```bash
cd /home/rico/bffless/repos/ce
git add apps/backend/src/storage/storage.interface.ts apps/backend/src/storage/dynamic-storage.adapter.ts apps/backend/src/storage/local.adapter.ts apps/backend/src/storage/dynamic-storage.adapter.spec.ts
git commit -m "feat(storage): add SignedUrlOptions to IStorageAdapter.getUrl"
```

---

### Task 2: GCS — `promptSaveAs`

**Files:**
- Modify: `apps/backend/src/storage/gcs.adapter.ts:188-203`
- Test: `apps/backend/src/storage/gcs.adapter.spec.ts:320`

**Interfaces:**
- Consumes: `SignedUrlOptions` from Task 1.
- Produces: nothing new.

The GCS SDK's `GetSignedUrlConfig.promptSaveAs` (`@google-cloud/storage` `file.d.ts:78`) builds `attachment; filename="..."` for us — we don't hand-assemble the header.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('getUrl', ...)` block in `gcs.adapter.spec.ts`:

```typescript
    it('sets promptSaveAs when a downloadFilename is given', async () => {
      await adapter.getUrl('test/file.mp4', 600, {
        downloadFilename: 'my-video.mp4',
      });

      expect(mockFile.getSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({ promptSaveAs: 'my-video.mp4' }),
      );
    });

    it('omits promptSaveAs when no downloadFilename is given', async () => {
      await adapter.getUrl('test/file.mp4', 600);

      expect(mockFile.getSignedUrl).toHaveBeenCalledWith(
        expect.not.objectContaining({ promptSaveAs: expect.anything() }),
      );
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest src/storage/gcs.adapter.spec.ts -t promptSaveAs`
Expected: the first test FAILS (`promptSaveAs` absent from the config object); the second PASSES already.

- [ ] **Step 3: Implement**

In `gcs.adapter.ts`, rename the local `options` variable to `signedUrlConfig` to free the name, and add the third parameter:

```typescript
  async getUrl(
    key: string,
    expiresIn?: number,
    options?: SignedUrlOptions,
  ): Promise<string> {
    const sanitizedKey = this.sanitizeKey(key);
    const storageKey = this.prefixKey(sanitizedKey);
    const blob = this.bucket.file(storageKey);
    const expiration = expiresIn ?? this.config.signedUrlExpiration ?? 3600;

    const signedUrlConfig: GetSignedUrlConfig = {
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiration * 1000,
    };

    // Signs `response-content-disposition: attachment; filename="..."` into the
    // URL. It cannot be appended afterward — V4 signing covers the whole query
    // string, so a bolted-on param yields 403 SignatureDoesNotMatch.
    if (options?.downloadFilename) {
      signedUrlConfig.promptSaveAs = options.downloadFilename;
    }

    try {
      const [url] = await blob.getSignedUrl(signedUrlConfig);
```

Import `SignedUrlOptions` from `./storage.interface`. Leave the `catch` block untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest src/storage/gcs.adapter.spec.ts`
Expected: PASS, all tests (including the pre-existing `getUrl` tests, which assert the config shape).

- [ ] **Step 5: Commit**

```bash
cd /home/rico/bffless/repos/ce
git add apps/backend/src/storage/gcs.adapter.ts apps/backend/src/storage/gcs.adapter.spec.ts
git commit -m "feat(storage): honor downloadFilename in the GCS adapter"
```

---

### Task 3: MinIO + S3 — `response-content-disposition`

**Files:**
- Modify: `apps/backend/src/storage/minio.adapter.ts:213-225`
- Test: `apps/backend/src/storage/minio.adapter.spec.ts`

**Interfaces:**
- Consumes: `SignedUrlOptions` from Task 1.
- Produces: nothing new.

`S3StorageAdapter extends MinioStorageAdapter` and defines no `getUrl` of its own, so this single change covers both backends. The `minio` SDK's fourth argument is `respHeaders` (`minio.d.ts:230-236`).

- [ ] **Step 1: Write the failing test**

Add to `minio.adapter.spec.ts`, inside the existing `describe('getUrl', ...)` block (create the block if absent, matching the file's existing mock setup where `mockClient.presignedGetObject` is a `jest.fn()`):

```typescript
    it('sets response-content-disposition when a downloadFilename is given', async () => {
      await adapter.getUrl('test/file.mp4', 600, {
        downloadFilename: 'my-video.mp4',
      });

      expect(mockClient.presignedGetObject).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        600,
        { 'response-content-disposition': 'attachment; filename="my-video.mp4"' },
      );
    });

    it('passes no response headers when no downloadFilename is given', async () => {
      await adapter.getUrl('test/file.mp4', 600);

      expect(mockClient.presignedGetObject).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        600,
        {},
      );
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest src/storage/minio.adapter.spec.ts -t "response-content-disposition"`
Expected: FAIL — `presignedGetObject` is called with 3 arguments, not 4.

- [ ] **Step 3: Implement**

In `minio.adapter.ts`, import `SignedUrlOptions` from `./storage.interface` and replace `getUrl`:

```typescript
  async getUrl(
    key: string,
    expiresIn: number = 3600,
    options?: SignedUrlOptions,
  ): Promise<string> {
    const sanitizedKey = this.sanitizeKey(key);
    const storageKey = this.prefixKey(sanitizedKey);

    // Signed into the URL, not appended to it: S3/MinIO V4 signatures cover the
    // query string. An empty object is equivalent to passing nothing.
    const respHeaders: Record<string, string> = options?.downloadFilename
      ? {
          'response-content-disposition': `attachment; filename="${options.downloadFilename}"`,
        }
      : {};

    try {
      // Generate presigned URL (default 1 hour expiration)
      const url = await this.client.presignedGetObject(
        this.bucket,
        storageKey,
        expiresIn,
        respHeaders,
      );
      return url;
    } catch (error) {
      this.logger.error(`Failed to generate presigned URL: ${storageKey}`, error);
      throw new Error(`Failed to generate presigned URL: ${error.message}`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest src/storage/minio.adapter.spec.ts src/storage/s3.adapter.spec.ts`
Expected: PASS. If a pre-existing test asserts `presignedGetObject` was called with exactly 3 arguments, update it to expect the trailing `{}` — the generated URL is unchanged.

- [ ] **Step 5: Commit**

```bash
cd /home/rico/bffless/repos/ce
git add apps/backend/src/storage/minio.adapter.ts apps/backend/src/storage/minio.adapter.spec.ts apps/backend/src/storage/s3.adapter.spec.ts
git commit -m "feat(storage): honor downloadFilename in the MinIO/S3 adapter"
```

---

### Task 4: Azure — SAS `contentDisposition`

**Files:**
- Modify: `apps/backend/src/storage/azure.adapter.ts:228-252`
- Test: `apps/backend/src/storage/azure.adapter.spec.ts`

**Interfaces:**
- Consumes: `SignedUrlOptions` from Task 1.
- Produces: nothing new.

`BlobSASSignatureValues.contentDisposition` (`@azure/storage-blob` `BlobSASSignatureValues.d.ts:74`) overrides the response header for the SAS.

- [ ] **Step 1: Write the failing test**

Add to `azure.adapter.spec.ts`, inside its `describe('getUrl', ...)` block, mocking `generateBlobSASQueryParameters` the way the file already does:

```typescript
    it('sets contentDisposition when a downloadFilename is given', async () => {
      await adapter.getUrl('test/file.mp4', 600, {
        downloadFilename: 'my-video.mp4',
      });

      expect(generateBlobSASQueryParameters).toHaveBeenCalledWith(
        expect.objectContaining({
          contentDisposition: 'attachment; filename="my-video.mp4"',
        }),
        expect.anything(),
      );
    });

    it('omits contentDisposition when no downloadFilename is given', async () => {
      await adapter.getUrl('test/file.mp4', 600);

      expect(generateBlobSASQueryParameters).toHaveBeenCalledWith(
        expect.not.objectContaining({ contentDisposition: expect.anything() }),
        expect.anything(),
      );
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest src/storage/azure.adapter.spec.ts -t contentDisposition`
Expected: the first test FAILS; the second PASSES already.

- [ ] **Step 3: Implement**

In `azure.adapter.ts`, import `SignedUrlOptions` from `./storage.interface` and change the signature plus the `sasOptions` construction:

```typescript
  async getUrl(
    key: string,
    expiresIn?: number,
    options?: SignedUrlOptions,
  ): Promise<string> {
    const sanitizedKey = this.sanitizeKey(key);
    const storageKey = this.prefixKey(sanitizedKey);
    const blockBlobClient = this.containerClient.getBlockBlobClient(storageKey);
    const expiration = expiresIn ?? this.config.sasUrlExpiration ?? 3600;

    try {
      // If we have shared key credential, generate SAS URL
      if (this.sharedKeyCredential) {
        const sasOptions: BlobSASSignatureValues = {
          containerName: this.config.containerName,
          blobName: storageKey,
          permissions: BlobSASPermissions.parse('r'), // Read only
          startsOn: new Date(),
          expiresOn: new Date(Date.now() + expiration * 1000),
          protocol: SASProtocol.HttpsAndHttp,
        };

        // Signed into the SAS token, so it cannot be tampered with or appended.
        if (options?.downloadFilename) {
          sasOptions.contentDisposition = `attachment; filename="${options.downloadFilename}"`;
        }

        const sasToken = generateBlobSASQueryParameters(
          sasOptions,
          this.sharedKeyCredential,
        ).toString();

        return `${blockBlobClient.url}?${sasToken}`;
      }
```

Add `BlobSASSignatureValues` to the existing `@azure/storage-blob` import. Leave the managed-identity fallback below untouched — it returns a bare blob URL and cannot carry a disposition.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest src/storage/azure.adapter.spec.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
cd /home/rico/bffless/repos/ce
git add apps/backend/src/storage/azure.adapter.ts apps/backend/src/storage/azure.adapter.spec.ts
git commit -m "feat(storage): honor downloadFilename in the Azure adapter"
```

---

### Task 5: `signed_url` handler — the `filename` config and its sanitizer

**Files:**
- Modify: `apps/backend/src/pipelines/handlers/signed-url.handler.ts`
- Create: `apps/backend/src/pipelines/handlers/signed-url.handler.spec.ts`

**Interfaces:**
- Consumes: `SignedUrlOptions` (Task 1) and the four adapters (Tasks 2–4).
- Produces: `sanitizeDownloadFilename(raw: unknown): string | undefined`, exported from `signed-url.handler.ts`. `SignedUrlHandlerConfig` gains `filename?: string`.

This is the single choke point. `path` is already run through `evaluateExpression`, which returns strings that don't start with a known root (`user`, `steps`, `metadata`, `request`, `deployment`, `secrets`) unchanged (`expression-evaluator.ts:66-69`) — so `filename` accepts an expression *or* a literal with no ambiguity.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/pipelines/handlers/signed-url.handler.spec.ts`:

```typescript
import { sanitizeDownloadFilename } from './signed-url.handler';

describe('sanitizeDownloadFilename', () => {
  it('passes a clean filename through', () => {
    expect(sanitizeDownloadFilename('my-video.mp4')).toBe('my-video.mp4');
  });

  it('reduces a path to its basename', () => {
    expect(sanitizeDownloadFilename('a/b/c/my-video.mp4')).toBe('my-video.mp4');
    expect(sanitizeDownloadFilename('a\\b\\my-video.mp4')).toBe('my-video.mp4');
  });

  it('strips quotes, backslashes and control characters', () => {
    expect(sanitizeDownloadFilename('ev"il\r\nX-Evil: 1.mp4')).toBe('evilX-Evil: 1.mp4');
  });

  it('returns undefined for empty, whitespace-only, or non-string input', () => {
    expect(sanitizeDownloadFilename('')).toBeUndefined();
    expect(sanitizeDownloadFilename('   ')).toBeUndefined();
    expect(sanitizeDownloadFilename('"')).toBeUndefined();
    expect(sanitizeDownloadFilename(undefined)).toBeUndefined();
    expect(sanitizeDownloadFilename(42)).toBeUndefined();
  });

  it('caps the length at 200 characters', () => {
    expect(sanitizeDownloadFilename('a'.repeat(500))).toHaveLength(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest src/pipelines/handlers/signed-url.handler.spec.ts`
Expected: FAIL — `sanitizeDownloadFilename is not a function` / has no exported member.

- [ ] **Step 3: Implement the sanitizer**

In `signed-url.handler.ts`, add above the `@Injectable()` class:

```typescript
/**
 * Reduce an arbitrary value to a filename safe to interpolate into a
 * `Content-Disposition` header value. THE choke point: every adapter trusts
 * that `SignedUrlOptions.downloadFilename` came through here.
 *
 * Strips path separators (basename only), then control characters, double
 * quotes and backslashes — the characters that could break out of the quoted
 * header value or inject a second header. Returns `undefined` when nothing
 * usable survives, which makes the handler omit the disposition entirely.
 */
export function sanitizeDownloadFilename(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;

  const basename = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = basename
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\]/g, '')
    .trim()
    .slice(0, 200);

  return cleaned || undefined;
}
```

- [ ] **Step 4: Run the sanitizer tests**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest src/pipelines/handlers/signed-url.handler.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing handler test**

Append to `signed-url.handler.spec.ts`:

```typescript
import { SignedUrlHandler } from './signed-url.handler';

describe('SignedUrlHandler', () => {
  let handler: SignedUrlHandler;
  let storageAdapter: { getUrl: jest.Mock };
  const registry = { register: jest.fn() } as any;
  const evaluator = {
    evaluateExpression: jest.fn((expr: string) =>
      expr === 'steps.resolvePath.storagePath'
        ? 'owner/repo/uploads/final.mp4'
        : expr === 'steps.resolvePath.filename'
          ? 'my-video.mp4'
          : expr === 'steps.resolvePath.empty'
            ? ''
            : expr,
    ),
  } as any;

  const step = (config: Record<string, unknown>) =>
    ({ id: 'sign', name: 'sign', config }) as any;

  beforeEach(() => {
    storageAdapter = { getUrl: jest.fn().mockResolvedValue('https://signed') };
    handler = new SignedUrlHandler(registry, evaluator, storageAdapter as any);
  });

  it('passes a sanitized downloadFilename to the adapter', async () => {
    const result = await handler.execute({} as any, step({
      path: 'steps.resolvePath.storagePath',
      filename: 'steps.resolvePath.filename',
    }));

    expect(result.success).toBe(true);
    expect(storageAdapter.getUrl).toHaveBeenCalledWith(
      'owner/repo/uploads/final.mp4',
      3600,
      { downloadFilename: 'my-video.mp4' },
    );
  });

  it('passes undefined options when filename is absent', async () => {
    await handler.execute({} as any, step({ path: 'steps.resolvePath.storagePath' }));

    expect(storageAdapter.getUrl).toHaveBeenCalledWith(
      'owner/repo/uploads/final.mp4',
      3600,
      undefined,
    );
  });

  it('passes undefined options when filename resolves to empty', async () => {
    await handler.execute({} as any, step({
      path: 'steps.resolvePath.storagePath',
      filename: 'steps.resolvePath.empty',
    }));

    expect(storageAdapter.getUrl).toHaveBeenCalledWith(
      'owner/repo/uploads/final.mp4',
      3600,
      undefined,
    );
  });

  it('accepts a literal filename', async () => {
    await handler.execute({} as any, step({
      path: 'steps.resolvePath.storagePath',
      filename: 'literal.mp4',
    }));

    expect(storageAdapter.getUrl).toHaveBeenCalledWith(
      'owner/repo/uploads/final.mp4',
      3600,
      { downloadFilename: 'literal.mp4' },
    );
  });
});
```

The constructor argument order must match `signed-url.handler.ts:35-39` — `(registry, expressionEvaluator, storageAdapter)`.

- [ ] **Step 6: Run test to verify it fails**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest src/pipelines/handlers/signed-url.handler.spec.ts -t SignedUrlHandler`
Expected: FAIL — `getUrl` called with 2 arguments; the first test expects a third.

- [ ] **Step 7: Wire the config through**

In `signed-url.handler.ts`, add to `SignedUrlHandlerConfig` after `expiresIn`:

```typescript
  /**
   * Optional filename to force a download under (supports expressions, e.g.
   * "steps.resolvePath.filename", or a literal like "video.mp4"). When present
   * and non-empty after sanitizing, the signed URL carries
   * `Content-Disposition: attachment; filename="..."`.
   *
   * Ignored on local storage, which cannot presign.
   */
  filename?: string;
```

Then in `execute()`, between the `resolvedPath` guard and the `try` block:

```typescript
    // Resolve + sanitize the optional download filename. An absent or
    // unusable filename means no disposition at all, which keeps every existing
    // caller (e.g. Studio's `useSignedBytes`) byte-identical.
    const resolvedFilename = config.filename
      ? this.expressionEvaluator.evaluateExpression(config.filename, context, stepName)
      : undefined;
    const downloadFilename = sanitizeDownloadFilename(resolvedFilename);
```

And change the `getUrl` call:

```typescript
      const url = await this.storageAdapter.getUrl(
        resolvedPath,
        expiresIn,
        downloadFilename ? { downloadFilename } : undefined,
      );
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec jest src/pipelines/handlers/signed-url.handler.spec.ts src/storage/`
Expected: PASS, all tests.

- [ ] **Step 9: Full backend gate**

Run: `cd /home/rico/bffless/repos/ce/apps/backend && pnpm exec tsc --noEmit -p tsconfig.json && pnpm exec jest src/storage src/pipelines`
Expected: no type errors; all storage + pipeline tests pass.

- [ ] **Step 10: Commit**

```bash
cd /home/rico/bffless/repos/ce
git add apps/backend/src/pipelines/handlers/signed-url.handler.ts apps/backend/src/pipelines/handlers/signed-url.handler.spec.ts
git commit -m "feat(pipelines): add optional filename to the signed_url handler"
```

---

### Task 6: HUMAN GATE — merge, release, deploy CE

**This task is not executable by an agent.** Stop here and hand back.

- [ ] **Step 1: Open the CE PR**

```bash
cd /home/rico/bffless/repos/ce
git push -u origin feat/signed-url-filename
gh pr create --title "feat(storage): sign Content-Disposition into presigned download URLs" --body "See bffless/apps docs/superpowers/specs/2026-07-10-signed-download-filename-design.md"
```

- [ ] **Step 2: Ask the user to review, merge, and deploy to `j5s.dev`**

Deploying to production is an irreversible, live-tenant action. **Do not do this unprompted.**

- [ ] **Step 3: Confirm the deploy landed before Task 11**

Tasks 7–10 may proceed in parallel — the Studio changes are inert until CE ships.

---

# Part 2 — Studio

Work in the **existing worktree**: `/home/rico/bffless/repos/apps-signed-download`, already on branch `feat/signed-download-filename`.

---

### Task 7: `slug.ts` — one slugify, two filenames

**Files:**
- Create: `apps/studio/src/lib/slug.ts`
- Create: `apps/studio/src/lib/slug.test.ts`
- Modify: `apps/studio/src/lib/thumbnail.ts:59-70`
- Modify: `apps/studio/src/lib/thumbnail.test.ts:63-73`

**Interfaces:**
- Consumes: nothing.
- Produces: `slugify(text: string): string`, `thumbnailFileName(title: string): string`, `finalCutFileName(title: string): string` — all exported from `src/lib/slug.ts`. `thumbnail.ts` re-exports `thumbnailFileName` so existing importers (`ThumbnailStudio.tsx:2`) keep working.

Note the behavior change: `thumbnailFileName` moves from `_` to `-`.

- [ ] **Step 1: Write the failing test**

Create `apps/studio/src/lib/slug.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { finalCutFileName, slugify, thumbnailFileName } from './slug'

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Overview of Onboarding Rules')).toBe('overview-of-onboarding-rules')
  })

  it('collapses runs of non-alphanumerics and trims the ends', () => {
    expect(slugify('  My Great Video!! (2026) ')).toBe('my-great-video-2026')
  })

  it('returns an empty string when nothing survives', () => {
    expect(slugify('')).toBe('')
    expect(slugify('—!!—')).toBe('')
  })
})

describe('thumbnailFileName', () => {
  it('slugs the title with a .jpg extension', () => {
    expect(thumbnailFileName('Overview of Onboarding Rules')).toBe(
      'overview-of-onboarding-rules.jpg',
    )
  })

  it('falls back to thumbnail.jpg', () => {
    expect(thumbnailFileName('')).toBe('thumbnail.jpg')
    expect(thumbnailFileName('—!!—')).toBe('thumbnail.jpg')
  })
})

describe('finalCutFileName', () => {
  it('slugs the title with a .mp4 extension', () => {
    expect(finalCutFileName('Custom AI Content Pipeline')).toBe(
      'custom-ai-content-pipeline.mp4',
    )
  })

  it('falls back to studio-final-cut.mp4', () => {
    expect(finalCutFileName('')).toBe('studio-final-cut.mp4')
    expect(finalCutFileName('—!!—')).toBe('studio-final-cut.mp4')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/rico/bffless/repos/apps-signed-download && pnpm --filter studio exec vitest run src/lib/slug.test.ts`
Expected: FAIL — cannot resolve `./slug`.

- [ ] **Step 3: Implement**

Create `apps/studio/src/lib/slug.ts`:

```typescript
/**
 * Download filenames derived from the video's title.
 *
 * These names reach the browser two different ways and must agree: the
 * freshly-stitched blob uses the `<a download>` attribute, while the saved cut
 * relies on `Content-Disposition` signed into the bucket URL (`<a download>` is
 * ignored cross-origin). One slug rule, so both produce the same file.
 */

/**
 * "Overview of Onboarding Rules" → "overview-of-onboarding-rules".
 * Collapses any run of non-alphanumerics to a single hyphen and trims the ends.
 * Returns "" when the title is empty or punctuation-only — callers supply the
 * fallback, because it differs per file type.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** e.g. "overview-of-onboarding-rules.jpg"; "thumbnail.jpg" when untitled. */
export function thumbnailFileName(title: string): string {
  return `${slugify(title) || 'thumbnail'}.jpg`
}

/** e.g. "custom-ai-content-pipeline.mp4"; "studio-final-cut.mp4" when untitled. */
export function finalCutFileName(title: string): string {
  return `${slugify(title) || 'studio-final-cut'}.mp4`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/rico/bffless/repos/apps-signed-download && pnpm --filter studio exec vitest run src/lib/slug.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Re-export from `thumbnail.ts` and delete its copy**

In `apps/studio/src/lib/thumbnail.ts`, delete the entire `thumbnailFileName` function and its doc comment (lines ~58-70), and add near the top imports:

```typescript
// Lives in `slug.ts` now, alongside `finalCutFileName` — one slug rule for every
// download name. Re-exported so existing importers keep their import path.
export { thumbnailFileName } from './slug'
```

- [ ] **Step 6: Update the thumbnail tests to hyphens**

In `apps/studio/src/lib/thumbnail.test.ts`, replace the `describe('thumbnailFileName', ...)` expectations:

```typescript
    expect(thumbnailFileName('Overview of Onboarding Rules')).toBe('overview-of-onboarding-rules.jpg')
```
```typescript
    expect(thumbnailFileName('  My Great Video!! (2026) ')).toBe('my-great-video-2026.jpg')
```

Leave the two `thumbnail.jpg` fallback assertions unchanged — they still hold.

- [ ] **Step 7: Run both test files**

Run: `cd /home/rico/bffless/repos/apps-signed-download && pnpm --filter studio exec vitest run src/lib/slug.test.ts src/lib/thumbnail.test.ts`
Expected: PASS, all tests.

- [ ] **Step 8: Commit**

```bash
cd /home/rico/bffless/repos/apps-signed-download
git add apps/studio/src/lib/slug.ts apps/studio/src/lib/slug.test.ts apps/studio/src/lib/thumbnail.ts apps/studio/src/lib/thumbnail.test.ts
git commit -m "refactor(studio): extract slugify; add finalCutFileName"
```

---

### Task 8: The `signAttachment` query + its mock

**Files:**
- Modify: `apps/studio/src/store/studioApi.ts:177-185`
- Modify: `apps/studio/src/mocks/handlers.ts:129-140`

**Interfaces:**
- Consumes: nothing.
- Produces: `useSignAttachmentQuery({ url: string; filename: string })` returning `{ url: string }`, exported from `studioApi.ts`. Kept separate from the existing `signDownload` query.

Why separate: `signDownload`'s URL feeds `<video src>` and ffmpeg reads. Pointing a `<video>` at an `attachment` URL would work — media elements ignore `Content-Disposition` — but inline playback shouldn't depend on that. Two signatures, both cached an hour, one extra bytes-free pipeline call per Export render.

- [ ] **Step 1: Add the query**

In `studioApi.ts`, immediately after the `signDownload` builder, add:

```typescript
    // Sign a persisted serve path into a direct bucket URL that FORCES a download
    // under `filename`. Separate from `signDownload` because that URL feeds
    // <video> playback and ffmpeg reads, which must not be `attachment`.
    // Needed because `<a download>` is ignored on cross-origin URLs, so the name
    // can only arrive as a Content-Disposition header signed into the URL.
    signAttachment: builder.query<{ url: string }, { url: string; filename: string }>({
      query: (body) => ({
        url: 'api/uploads/sign',
        method: 'POST',
        body,
      }),
      transformResponse: (raw: unknown) => ({ url: toSignedUrl(raw) }),
      keepUnusedDataFor: 45 * 60,
    }),
```

Then add `useSignAttachmentQuery` to the hook export list at the bottom of the file, alongside `useSignDownloadQuery`.

- [ ] **Step 2: Teach the MSW mock about `filename`**

In `apps/studio/src/mocks/handlers.ts`, update the `/api/uploads/sign` handler so it reads `filename` from the body and reflects it in the returned URL (so a test can assert it was sent):

```typescript
  http.post('/api/uploads/sign', async ({ request }) => {
    const body = (await request.json()) as { url?: string; filename?: string }
    const signed = new URL(`https://bucket.example.com${body.url ?? '/api/uploads/x'}`)
    signed.searchParams.set('X-Goog-Signature', 'mock')
    if (body.filename) {
      signed.searchParams.set(
        'response-content-disposition',
        `attachment; filename="${body.filename}"`,
      )
    }
    return HttpResponse.json({ url: signed.toString(), expiresIn: 3600 })
  }),
```

Match the file's existing response shape — if the current handler returns something other than `{ url, expiresIn }`, keep its shape and only add the `filename` branch. Mock and real must coerce through the same `toSignedUrl`.

- [ ] **Step 3: Verify nothing regressed**

Run: `cd /home/rico/bffless/repos/apps-signed-download && pnpm --filter studio exec vitest run src/lib/upload.test.ts && pnpm --filter studio build`
Expected: PASS, and a clean type-check + build.

- [ ] **Step 4: Commit**

```bash
cd /home/rico/bffless/repos/apps-signed-download
git add apps/studio/src/store/studioApi.ts apps/studio/src/mocks/handlers.ts
git commit -m "feat(studio): add signAttachment query for forced-download URLs"
```

---

### Task 9: `FinalCutBar` downloads from the bucket

**Files:**
- Modify: `apps/studio/src/components/Studio/FinalCutBar.tsx:8-16,50-57,132-136`
- Modify: `apps/studio/src/pages/Studio.tsx:580-585`
- Create: `apps/studio/src/components/Studio/FinalCutBar.test.tsx`

**Interfaces:**
- Consumes: `finalCutFileName` (Task 7), `useSignAttachmentQuery` (Task 8).
- Produces: `FinalCutBar` `Props` gains `title: string`.

- [ ] **Step 1: Write the failing test**

Create `apps/studio/src/components/Studio/FinalCutBar.test.tsx`. Follow the render/store-wrapper pattern already used by `SceneRefinePanel.test.tsx` in the same directory:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { FinalCutBar } from './FinalCutBar'
// ...plus whatever Provider/store wrapper SceneRefinePanel.test.tsx uses.

const scenes = [
  { id: 's1', index: 0, title: 'One', assembledUrl: '/api/uploads/a.mp4' },
] as never

describe('FinalCutBar', () => {
  it('points the download at the signed bucket URL, not the serve path', async () => {
    render(
      <FinalCutBar
        scenes={scenes}
        title="Custom AI Content Pipeline"
        finalCutUrl="/api/uploads/projects/p1/export/final.mp4"
        saving={false}
        onSave={async () => ''}
      />,
      // ...wrapper
    )

    const link = await screen.findByRole('link', { name: /download mp4/i })

    await waitFor(() => {
      expect(link).toHaveAttribute('href', expect.stringContaining('bucket.example.com'))
    })
    expect(link.getAttribute('href')).not.toMatch(/^\/api\/uploads\//)
  })

  it('names the download after the video title', async () => {
    render(
      <FinalCutBar
        scenes={scenes}
        title="Custom AI Content Pipeline"
        finalCutUrl="/api/uploads/projects/p1/export/final.mp4"
        saving={false}
        onSave={async () => ''}
      />,
      // ...wrapper
    )

    const link = await screen.findByRole('link', { name: /download mp4/i })
    expect(link).toHaveAttribute('download', 'custom-ai-content-pipeline.mp4')

    // The mock reflects the POSTed `filename` back into the signed URL's
    // response-content-disposition param. Assert on the decoded name rather than
    // an exact encoding: URLSearchParams renders a space as `+`, not `%20`.
    await waitFor(() => {
      const href = link.getAttribute('href') ?? ''
      const disposition =
        new URL(href).searchParams.get('response-content-disposition') ?? ''
      expect(disposition).toBe('attachment; filename="custom-ai-content-pipeline.mp4"')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/rico/bffless/repos/apps-signed-download && pnpm --filter studio exec vitest run src/components/Studio/FinalCutBar.test.tsx`
Expected: FAIL — `title` is not a prop; `href` is still `/api/uploads/...`.

- [ ] **Step 3: Implement**

In `FinalCutBar.tsx`, add to `Props`:

```typescript
  /** The video's recommended title — the download's filename comes from this. */
  title: string
```

Add the import:

```typescript
import { finalCutFileName } from '../../lib/slug'
```

and add `useSignAttachmentQuery` to the existing `useSignDownloadQuery` import from `'../../store/studioApi'`.

Then replace the comment + two lines at 51-57:

```typescript
  // Both playback and download read the SAVED cut straight from the bucket — the
  // whole video is the biggest MP4 we serve and must never stream through
  // file_serve (bffless/ce#317). They need DIFFERENT signatures: playback must
  // render inline, the download must be `attachment` so the browser saves it
  // under `downloadName` (an `<a download>` is ignored cross-origin).
  const downloadName = finalCutFileName(title)
  const { data: signedFinal } = useSignDownloadQuery(finalCutUrl ?? skipToken)
  const { data: signedAttachment } = useSignAttachmentQuery(
    finalCutUrl ? { url: finalCutUrl, filename: downloadName } : skipToken,
  )
  const playbackSrc = resultUrl ?? (finalCutUrl ? (signedFinal?.url ?? null) : null)
  // `resultUrl` is a same-origin blob: URL, where the `download` attr DOES apply.
  const downloadHref = resultUrl ?? (finalCutUrl ? (signedAttachment?.url ?? null) : null)
```

And at line ~133, swap the hard-coded name:

```tsx
          <a className="pill-ghost" href={downloadHref} download={downloadName}>
```

- [ ] **Step 4: Pass the title from `Studio.tsx`**

At `Studio.tsx:580`, add the prop — the value is already in scope, two lines below at `ThumbnailStudio`:

```tsx
                <FinalCutBar
                  scenes={pipe.scenes}
                  title={pipe.description?.title ?? ''}
                  finalCutUrl={pipe.finalCutUrl}
                  saving={pipe.savingFinalCut}
                  onSave={pipe.saveFinalCut}
                />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/rico/bffless/repos/apps-signed-download && pnpm --filter studio exec vitest run src/components/Studio/FinalCutBar.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 6: Full Studio gate**

Run: `cd /home/rico/bffless/repos/apps-signed-download && pnpm --filter studio build && pnpm --filter studio lint && pnpm --filter studio test:run`
Expected: all three pass.

- [ ] **Step 7: Commit**

```bash
cd /home/rico/bffless/repos/apps-signed-download
git add apps/studio/src/components/Studio/FinalCutBar.tsx apps/studio/src/components/Studio/FinalCutBar.test.tsx apps/studio/src/pages/Studio.tsx
git commit -m "feat(studio): download the final cut straight from the bucket"
```

---

### Task 10: The live proxy rule

**Files:**
- Modify (live, via MCP): the `studio` proxy rule set's `/api/uploads/sign` rule on `j5s.dev`
- Modify: `apps/studio/bffless/studio.proxy-rules.json` (re-export)

**Interfaces:**
- Consumes: the `filename` config from Task 5.
- Produces: `/api/uploads/sign` accepts an optional `filename` in its POST body.

**This task writes to a live tenant.** Sandcastle does not deploy live proxy rules, so it must be done by hand — and per the workspace rules, **ask the user before writing.** It is a no-op against today's deployed CE (`validateConfig` only requires `path`, so an unknown `filename` key is ignored), so it is safe to land before or after the CE deploy.

- [ ] **Step 1: Update `resolvePath` to emit a sanitized filename**

Add to the `resolvePath` `function_handler` body, before the `return`:

```javascript
  // Optional download filename. Basename only, conservative charset — the
  // backend sanitizes again, this is defense in depth. Empty means "no
  // Content-Disposition", which is what every non-download caller sends.
  var name = typeof body.filename === 'string' ? body.filename : ''
  name = name.split('/').pop().split('\\').pop()
  name = name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120)
```

and extend the returned object:

```javascript
  return {
    url: url,
    storagePath: storagePath,
    filename: name,
  }
```

- [ ] **Step 2: Point the `sign` step at it**

The `sign` step's config becomes:

```json
{
  "path": "steps.resolvePath.storagePath",
  "filename": "steps.resolvePath.filename",
  "expiresIn": 3600
}
```

- [ ] **Step 3: Apply to the live `studio` rule set**

Use the BFFless MCP `update_proxy_rule` tool against the `studio` set's `/api/uploads/sign` rule. **Confirm with the user first.**

- [ ] **Step 4: Verify the no-filename path still works**

Reload Studio's Export page for a project with a saved final cut and confirm playback still works (that's `signDownload`, which sends no `filename`), and that the ffmpeg-backed "Re-stitch final cut" still loads its scene bytes.

- [ ] **Step 5: Re-export and commit the rule JSON**

Export the `studio` rule set from the dashboard, overwrite `apps/studio/bffless/studio.proxy-rules.json`, and confirm the diff touches **only** the `/api/uploads/sign` rule.

```bash
cd /home/rico/bffless/repos/apps-signed-download
git diff --stat apps/studio/bffless/studio.proxy-rules.json
git add apps/studio/bffless/studio.proxy-rules.json
git commit -m "chore(studio): re-export proxy rules with sign filename support"
```

---

### Task 11: End-to-end verification

**Requires Task 6 (CE deployed) and Task 10 (live rule updated).**

- [ ] **Step 1: Prove the header appears**

Mint a signed URL *with* a filename and probe it, exactly as the spec's Problem section probed one without:

```bash
curl -sI "<signed-url-with-filename>" | grep -iE "^HTTP|content-type|content-disposition"
```

Expected:

```
HTTP/2 200
content-type: video/mp4
content-disposition: attachment; filename="custom-ai-content-pipeline.mp4"
```

Before the change, the `content-disposition` line was absent. That one line is the whole feature.

- [ ] **Step 2: Prove the backend is no longer in the path**

Open Studio's Export page on a project with a saved final cut, open DevTools → Network, click **Download MP4**, and confirm:
- the request goes to `storage.googleapis.com`, not `studio.j5s.dev/api/uploads/...`
- the browser saves a file (no video player tab opens)
- the saved file is named after the video title

- [ ] **Step 3: Prove the untouched paths are untouched**

- Playback of the saved final cut still plays inline.
- "Re-stitch final cut" still assembles (this exercises `useSignedBytes`, which sends no `filename`).
- Downloading a *freshly stitched* cut (before saving) still works — that's the same-origin `blob:` path where `<a download>` still applies.

- [ ] **Step 4: Open the Studio PR**

```bash
cd /home/rico/bffless/repos/apps-signed-download
git push -u origin feat/signed-download-filename
gh pr create --title "feat(studio): download the final cut straight from the bucket" --body "Closes the 19-minute download. See docs/superpowers/specs/2026-07-10-signed-download-filename-design.md"
```

---

## Out of scope

Named here so a future reader doesn't think they were forgotten:

- Per-scene downloads (`SceneAssembleBar.tsx:179`) — identical serve-path pattern, tens of MB rather than hundreds.
- `ThumbnailStudio.tsx:65-79`'s fetch-into-a-Blob download. Once CE ships this, it becomes dead weight and could point at a signed attachment URL instead. It works today because a 137 KB JPEG fits in memory.
- Local-storage support for `downloadFilename`. Studio's presigned upload flow means it cannot run on local storage at all.
