# AI Settings Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CE's project AI settings name what they actually hold, turn the COOP/COEP header recipe into one click, and let an app's manual step link out to where a credential is obtained.

**Architecture:** Four independent changes to existing files. Three are frontend-only (card copy in `ProjectAISettingsTab.tsx`, a preset in `ProjectResponseHeaderRulesTab.tsx`, a link in `SetupNotes.tsx`); one adds an optional field to the app-manifest contract (backend type + validator, frontend type mirror). No schema change, no migration, no API surface change.

**Tech Stack:** React 18 + Vite + RTK Query + Radix/Tailwind (frontend, Vitest + @testing-library/react); NestJS + Drizzle (backend, Jest).

**Spec:** `docs/superpowers/specs/2026-08-05-studio-onboarding-clarity-design.md` (pieces 1, 4, 5).

**Where this executes:** every file path below is in the **`bffless/ce`** repo. This plan lives in
`bffless/apps` only so it sits beside the spec and its companion plan; the shared
`/home/rico/bffless/repos/ce` checkout is kept clean, and Task 1 Step 1 creates the worktree you
actually work in.

## Global Constraints

- Branch from `origin/main` in a fresh worktree. The shared `/home/rico/bffless/repos/ce` checkout is behind origin/main and must not be branched from. Create with `git worktree add .claude/worktrees/<name> -b <branch> origin/main`.
- `pnpm lint` already fails on `main` (~58 pre-existing problems). Capture a baseline count before changing anything and compare; do not treat the pre-existing count as a regression, and do not "fix" unrelated lint errors.
- The two card names are exact and are quoted verbatim by downstream docs and by `bffless/apps`'s Studio manifest: **`LLM Providers`** and **`Replicate`**. Do not paraphrase them.
- The `Add Provider` button label must NOT change — the Studio manifest points at it by name.
- Custom header values are exact: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`.
- The new preset's `pathPattern` is `**`. It is a generic control offered to every project and must not carry an app-specific prefix.
- `externalLink` is optional and additive. An older CE must still install a manifest that carries it, so no `ceMin` bump and no rejection of unknown fields.
- Backend tests: `cd apps/backend && pnpm test -- <pattern>`. Frontend tests: `cd apps/frontend && pnpm test:run`. Note `test:run --` does not filter — pass the file path as a positional arg to `vitest run`.

---

### Task 1: Rename the two AI cards

The AI tab stacks "AI Settings" (OpenAI/Anthropic/Google keys) and "AI Services" (Replicate only). Neither name says what it holds. This task renames both, fixes the two backend strings that name the old card, and makes a configured Replicate token replaceable.

**Files:**
- Modify: `apps/frontend/src/components/project/ProjectAISettingsTab.tsx` (lines 153-217, 234, 311, 640-642, 924-927, 964-967)
- Modify: `apps/backend/src/pipelines/handlers/replicate.handler.ts:~72`
- Modify: `apps/backend/src/pipelines/ai-plugins/plugins/rag-search.plugin.ts:106`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the literal strings `LLM Providers` and `Replicate` as card titles. Task 2's preset and the `bffless/apps` docs both assume these exist.

**No new automated test.** `ProjectAISettingsTab` is a large component driven by four RTK Query hooks with no existing test harness (`apps/frontend/src/components/project/` has no `__tests__/`), and every change here is a literal string swap plus one ternary. Standing up a store + MSW harness to assert copy would cost more than it protects. The gate is typecheck, the existing suite staying green, and a visual check. This is a deliberate decision, not an omission — do not skip the visual check.

- [ ] **Step 1: Create the worktree and capture the lint baseline**

```bash
cd /home/rico/bffless/repos/ce
git worktree add .claude/worktrees/ai-settings-clarity -b feat/ai-settings-clarity origin/main
cd .claude/worktrees/ai-settings-clarity
pnpm install
pnpm lint 2>&1 | tail -5 > /tmp/lint-baseline.txt
cat /tmp/lint-baseline.txt
```

Record the problem count. You will compare against it in Step 10.

- [ ] **Step 2: Rename the Replicate card header and make the button unconditional**

In `apps/frontend/src/components/project/ProjectAISettingsTab.tsx`, replace lines 151-165:

```tsx
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              AI Services
            </CardTitle>
            <CardDescription>
              Configure external ML services for pipeline steps.
            </CardDescription>
          </div>
          {!hasReplicate && (
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Service
            </Button>
          )}
```

with:

```tsx
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Replicate
            </CardTitle>
            <CardDescription>
              Your Replicate API token. Powers ML model steps: transcription, image generation,
              and embeddings.
            </CardDescription>
          </div>
          <Button onClick={() => setShowAddDialog(true)}>
            {hasReplicate ? (
              'Replace token'
            ) : (
              <>
                <Plus className="h-4 w-4 mr-2" />
                Connect Replicate
              </>
            )}
          </Button>
```

The button was previously hidden once a token existed, so a rotated token could only be changed by removing and re-adding. `addOrUpdateService` already upserts on `service`, so reopening the same dialog is sufficient — no backend change.

- [ ] **Step 3: Drop the now-duplicated per-service description**

Delete line 184 entirely:

```tsx
                        <p className="text-xs text-muted-foreground mt-1">{meta.description}</p>
```

It repeated `SERVICE_CONFIG.replicate.description`, which is now the card's own subtitle. Leave the `SERVICE_CONFIG` map itself in place — `meta.name` is still used on line 180.

- [ ] **Step 4: Rewrite the Replicate empty state**

Replace lines 208-218:

```tsx
            <div className="flex items-center text-sm">
              <AlertTriangle className="h-4 w-4 text-yellow-500 mr-2" />
              <span className="text-muted-foreground">No AI services configured</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Add an AI service to enable Replicate ML model pipelines.
            </p>
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Service
            </Button>
```

with:

```tsx
            <div className="flex items-center text-sm">
              <AlertTriangle className="h-4 w-4 text-yellow-500 mr-2" />
              <span className="text-muted-foreground">Replicate not connected</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Connect Replicate to enable transcription, image generation, and vector-search steps.
            </p>
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Connect Replicate
            </Button>
```

- [ ] **Step 5: Make the Replicate dialog title reflect replace-vs-add**

Line 234, replace:

```tsx
            <DialogTitle>Add Replicate</DialogTitle>
```

with:

```tsx
            <DialogTitle>{hasReplicate ? 'Replace Replicate token' : 'Add Replicate'}</DialogTitle>
```

Line 311, replace:

```tsx
                'Add Replicate'
```

with:

```tsx
                hasReplicate ? 'Save token' : 'Add Replicate'
```

Leave the dialog description, the `r8_...` placeholder, and the `replicate.com/account/api-tokens` link untouched — they are already correct.

- [ ] **Step 6: Rename the LLM Providers card**

Replace lines 922-928:

```tsx
              <CardTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5" />
                AI Settings
              </CardTitle>
              <CardDescription>
                Configure AI providers for chat pipelines in this project.
              </CardDescription>
```

with:

```tsx
              <CardTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5" />
                LLM Providers
              </CardTitle>
              <CardDescription>
                API keys for OpenAI, Anthropic, and Google. Used by any AI step in your pipelines
                — chat and one-off text generation.
              </CardDescription>
```

The old subtitle said "chat pipelines", but these keys feed `ai_handler`, which runs in both `chat` and `completion` mode. Do not reintroduce "chat" as the only use.

Then replace lines 964 and 966-968:

```tsx
                <span className="text-muted-foreground">No AI providers configured</span>
```

with:

```tsx
                <span className="text-muted-foreground">No LLM providers connected</span>
```

and:

```tsx
              <p className="text-sm text-muted-foreground">
                Add an AI provider to enable chat pipelines and AI-powered features for this project.
              </p>
```

with:

```tsx
              <p className="text-sm text-muted-foreground">
                Add a provider — Anthropic, OpenAI, or Google — to enable AI steps in this
                project's pipelines.
              </p>
```

Leave both `Add Provider` buttons (lines 933, 971) exactly as they are.

- [ ] **Step 7: Update the Add Provider dialog copy**

Replace lines 640-643:

```tsx
          <DialogTitle>Add AI Provider</DialogTitle>
          <DialogDescription>
            Configure a new AI provider for this project's chat pipelines.
          </DialogDescription>
```

with:

```tsx
          <DialogTitle>Add LLM Provider</DialogTitle>
          <DialogDescription>
            Choose a provider and paste its API key.
          </DialogDescription>
```

- [ ] **Step 8: Fix the two backend strings that point at the old card**

In `apps/backend/src/pipelines/handlers/replicate.handler.ts`, find the `REPLICATE_NOT_CONFIGURED` error and replace:

```ts
        message: 'Replicate API token is not configured. Add it in Settings > AI > AI Services.',
```

with:

```ts
        message: 'Replicate API token is not configured. Add it in Settings > AI > Replicate.',
```

In `apps/backend/src/pipelines/ai-plugins/plugins/rag-search.plugin.ts:106`, replace the trailing sentence:

```ts
Vector search requires Replicate in AI Services.
```

with:

```ts
Vector search requires a Replicate token (Settings → AI → Replicate).
```

Both previously named a card that no longer exists. No spec file asserts either string (verified with `git grep` over `*.spec.ts`), so no test updates are needed here.

- [ ] **Step 9: Typecheck both apps**

```bash
pnpm --filter frontend exec tsc --noEmit
pnpm --filter backend exec tsc --noEmit
```

Expected: both clean, no output.

- [ ] **Step 10: Run the suites and compare lint to baseline**

```bash
cd apps/frontend && pnpm test:run; cd ../..
cd apps/backend && pnpm test -- replicate.handler; cd ../..
pnpm lint 2>&1 | tail -5
```

Expected: frontend suite passes with the same count as before your change; the `replicate.handler` backend tests pass; the lint problem count matches `/tmp/lint-baseline.txt` exactly. If lint went **up**, you introduced a problem — fix it. If it went down, you touched something out of scope — revert that.

- [ ] **Step 11: Look at the tab**

Start the stack and open the AI tab of any project:

```bash
pnpm dev:full
# then, from /home/rico/bffless/localdev-tools:
node shot.mjs "http://localhost:5173/repo/<owner>/<repo>/settings?tab=ai" --out /tmp/ai-tab.png --full
```

Confirm by eye: the first card reads **LLM Providers**, the third reads **Replicate**, the Replicate card shows **Connect Replicate** when empty, and no card still says "AI Services" or "AI Settings". A cold headless session cannot reach gated `/api`, so if the page renders its "couldn't reach server" fallback, seed a session cookie or check in a real browser against your own instance instead — do not skip this step.

- [ ] **Step 12: Commit**

```bash
git add apps/frontend/src/components/project/ProjectAISettingsTab.tsx \
        apps/backend/src/pipelines/handlers/replicate.handler.ts \
        apps/backend/src/pipelines/ai-plugins/plugins/rag-search.plugin.ts
git commit -m "feat(ui): name the AI cards LLM Providers and Replicate

'AI Settings' and 'AI Services' sat adjacent with near-identical names and
unrelated contents, and neither said what it held. AI Services is Replicate
and only Replicate (AIServiceType is a single-member union); AI Settings is
where an Anthropic key goes but never says so, and its 'chat pipelines'
subtitle was narrower than the truth — those keys feed ai_handler in both
chat and completion mode.

Also makes a configured Replicate token replaceable: the header button used
to hide itself once a token existed, so rotating one meant remove-then-add.
addOrUpdateService already upserts, so reopening the dialog is enough.

Updates the two backend strings that named the old card."
```

---

### Task 2: Cross-Origin Isolation preset

The COOP/COEP step is the worst in Studio's install — it asks an operator to hand-type two header names and two values they cannot guess. The Response Headers dialog already has a preset row; it just cannot carry custom headers.

**Files:**
- Modify: `apps/frontend/src/components/project/ProjectResponseHeaderRulesTab.tsx` (lines 70-85, 152-163)
- Create: `apps/frontend/src/components/project/__tests__/responseHeaderPresets.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: an exported `presets` array whose entries are `{ name: string; pathPattern: string; framePolicy: 'allow' | 'deny' | 'sameorigin'; allowedOrigins: string[]; description: string; customHeaders?: { name: string; value: string }[] }`. The `bffless/apps` docs refer to the preset by its exact name, `Cross-Origin Isolation`.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/project/__tests__/responseHeaderPresets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { presets } from '../ProjectResponseHeaderRulesTab';

describe('response header presets', () => {
  it('offers a Cross-Origin Isolation preset', () => {
    const names = presets.map((p) => p.name);
    expect(names).toContain('Cross-Origin Isolation');
  });

  it('sets both cross-origin isolation headers to the values SharedArrayBuffer requires', () => {
    const preset = presets.find((p) => p.name === 'Cross-Origin Isolation');

    expect(preset?.customHeaders).toEqual([
      { name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { name: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
    ]);
  });

  it('applies project-wide, carrying no app-specific path', () => {
    const preset = presets.find((p) => p.name === 'Cross-Origin Isolation');

    // A generic control offered to every project cannot assume an app's
    // basePath, so the pattern is '**' and the field stays editable.
    expect(preset?.pathPattern).toBe('**');
  });

  it('leaves framing behaviour alone', () => {
    const preset = presets.find((p) => p.name === 'Cross-Origin Isolation');

    // 'sameorigin' is the existing default (nginx already emits
    // X-Frame-Options: SAMEORIGIN), so enabling isolation must not
    // silently change who may frame the content.
    expect(preset?.framePolicy).toBe('sameorigin');
  });

  it('leaves the existing presets carrying no custom headers', () => {
    const blockFraming = presets.find((p) => p.name === 'Block Framing');

    expect(blockFraming?.customHeaders).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd apps/frontend && pnpm exec vitest run src/components/project/__tests__/responseHeaderPresets.test.ts
```

Expected: FAIL — `presets` is not exported from `ProjectResponseHeaderRulesTab` (TypeScript/import error), and the Cross-Origin Isolation entry does not exist.

- [ ] **Step 3: Export the presets and add the new one**

In `apps/frontend/src/components/project/ProjectResponseHeaderRulesTab.tsx`, replace lines 70-85:

```tsx
const presets = [
  {
    name: 'Embed Widget',
    pathPattern: 'embed/**',
    framePolicy: 'allow' as const,
    allowedOrigins: [],
    description: 'Allow iframe embedding of widget pages (add allowed origins below)',
  },
  {
    name: 'Block Framing',
    pathPattern: '**',
    framePolicy: 'deny' as const,
    allowedOrigins: [],
    description: 'Prevent all iframe embedding',
  },
];
```

with:

```tsx
export interface HeaderRulePreset {
  name: string;
  pathPattern: string;
  framePolicy: 'allow' | 'deny' | 'sameorigin';
  allowedOrigins: string[];
  description: string;
  customHeaders?: { name: string; value: string }[];
}

export const presets: HeaderRulePreset[] = [
  {
    name: 'Embed Widget',
    pathPattern: 'embed/**',
    framePolicy: 'allow',
    allowedOrigins: [],
    description: 'Allow iframe embedding of widget pages (add allowed origins below)',
  },
  {
    name: 'Block Framing',
    pathPattern: '**',
    framePolicy: 'deny',
    allowedOrigins: [],
    description: 'Prevent all iframe embedding',
  },
  {
    name: 'Cross-Origin Isolation',
    pathPattern: '**',
    framePolicy: 'sameorigin',
    allowedOrigins: [],
    description:
      'Enable SharedArrayBuffer for multithreaded WebAssembly (in-browser video export)',
    customHeaders: [
      { name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { name: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
    ],
  },
];
```

The explicit `HeaderRulePreset` type replaces the `as const` assertions, which existed only to narrow `framePolicy` for the inferred tuple type.

- [ ] **Step 4: Let a preset populate the custom header rows**

Replace lines 152-163:

```tsx
  const applyPreset = (preset: (typeof presets)[0]) => {
    setRuleForm({
      ...defaultRuleForm,
      pathPattern: preset.pathPattern,
      framePolicy: preset.framePolicy,
      allowedOrigins: preset.allowedOrigins,
      name: preset.name,
      description: preset.description,
    });
    setOriginsText(preset.allowedOrigins.join('\n'));
    setCustomHeaderRows([]);
  };
```

with:

```tsx
  const applyPreset = (preset: HeaderRulePreset) => {
    setRuleForm({
      ...defaultRuleForm,
      pathPattern: preset.pathPattern,
      framePolicy: preset.framePolicy,
      allowedOrigins: preset.allowedOrigins,
      name: preset.name,
      description: preset.description,
    });
    setOriginsText(preset.allowedOrigins.join('\n'));
    setCustomHeaderRows(preset.customHeaders ? [...preset.customHeaders] : []);
  };
```

Copy the array rather than passing the preset's own reference — the rows are edited in place by the dialog, and a shared reference would mutate the module-level preset for the rest of the session.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/frontend && pnpm exec vitest run src/components/project/__tests__/responseHeaderPresets.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Typecheck and run the full frontend suite**

```bash
pnpm --filter frontend exec tsc --noEmit
cd apps/frontend && pnpm test:run
```

Expected: clean typecheck; suite green.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/components/project/ProjectResponseHeaderRulesTab.tsx \
        apps/frontend/src/components/project/__tests__/responseHeaderPresets.test.ts
git commit -m "feat(ui): add a Cross-Origin Isolation header preset

Enabling SharedArrayBuffer meant hand-typing two header names and two values
an operator has no way to guess. The dialog already had a preset row; it just
could not carry custom headers, because applyPreset hardcoded an empty row
list.

The pattern is '**' deliberately: this is a generic control offered to every
project, so it cannot assume any app's basePath. The path field stays
editable for anyone running several apps in one project."
```

---

### Task 3: `externalLink` on manual steps — backend

A manual step can link *into* the admin panel via `deepLink`, but cannot link *out* to where a credential is obtained. `huggingface.co/settings/tokens` appears nowhere in CE. Bodies render as plain text, so a URL written into `body` is not clickable.

**Files:**
- Modify: `apps/backend/src/app-catalog/app-manifest.types.ts` (the `AppManualStep` interface)
- Modify: `apps/backend/src/app-catalog/app-manifest.util.ts` (`validateManualSteps`)
- Modify: `apps/backend/src/app-catalog/app-manifest.util.spec.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `AppManualStep.externalLink?: { label: string; url: string }`. Task 4 mirrors this exact shape in the frontend type, and `bffless/apps` writes it into Studio's manifest.

- [ ] **Step 1: Write the failing tests**

In `apps/backend/src/app-catalog/app-manifest.util.spec.ts`, find the existing `validateManualSteps` describe block (search for `manualSteps`) and add these cases inside it. Match the surrounding file's helper for building a manifest — if it uses a `makeManifest()`/`baseManifest` helper, use that; the assertions below assume a `validateManifest(manifest)` returning `{ errors: string[] }` or throwing, so mirror whatever the neighbouring cases do.

```ts
  it('accepts a manual step with an external link', () => {
    const manifest = makeManifest({
      install: {
        ...baseInstall,
        manualSteps: [
          {
            id: 'add-hf-token',
            title: 'Optional: HF_TOKEN for speaker diarization',
            body: 'Create a secret named HF_TOKEN.',
            externalLink: {
              label: 'Get a Hugging Face token',
              url: 'https://huggingface.co/settings/tokens',
            },
          },
        ],
      },
    });

    expect(validateManifest(manifest).errors).toEqual([]);
  });

  it('rejects an external link missing a label', () => {
    const manifest = makeManifest({
      install: {
        ...baseInstall,
        manualSteps: [
          {
            id: 'a',
            title: 'T',
            body: 'B',
            externalLink: { url: 'https://example.com' },
          },
        ],
      },
    });

    expect(validateManifest(manifest).errors).toContain(
      'install.manualSteps[0].externalLink.label: required string',
    );
  });

  it('rejects a non-https external link', () => {
    const manifest = makeManifest({
      install: {
        ...baseInstall,
        manualSteps: [
          {
            id: 'a',
            title: 'T',
            body: 'B',
            externalLink: { label: 'Docs', url: 'http://example.com' },
          },
        ],
      },
    });

    expect(validateManifest(manifest).errors).toContain(
      'install.manualSteps[0].externalLink.url: must be an https:// URL',
    );
  });

  it('rejects an external link that is not an object', () => {
    const manifest = makeManifest({
      install: {
        ...baseInstall,
        manualSteps: [
          { id: 'a', title: 'T', body: 'B', externalLink: 'https://example.com' },
        ],
      },
    });

    expect(validateManifest(manifest).errors).toContain(
      'install.manualSteps[0].externalLink: must be an object',
    );
  });

  it('does not apply placeholder validation to an external link url', () => {
    // externalLink is a literal external URL, not a templated admin path, so
    // a brace in it is a plain character and must not be read as a token.
    const manifest = makeManifest({
      install: {
        ...baseInstall,
        manualSteps: [
          {
            id: 'a',
            title: 'T',
            body: 'B',
            externalLink: { label: 'Docs', url: 'https://example.com/a{b}c' },
          },
        ],
      },
    });

    expect(validateManifest(manifest).errors).toEqual([]);
  });
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
cd apps/backend && pnpm test -- app-manifest.util
```

Expected: the first and last cases FAIL (currently `externalLink` is silently ignored, so `errors` is `[]` — the last one may accidentally pass; that is fine, it is a regression guard). The three rejection cases FAIL because no validation exists yet.

- [ ] **Step 3: Add the field to the type**

In `apps/backend/src/app-catalog/app-manifest.types.ts`, replace the `AppManualStep` interface:

```ts
export interface AppManualStep {
  id: string;
  title: string;
  body: string;
  deepLink?: string;
  appliesWhen?: AppliesWhen;
}
```

with:

```ts
/** An off-CE destination where a credential is obtained (e.g. a provider's
 *  token page). Rendered beside `deepLink`, which goes into the admin panel. */
export interface AppManualStepExternalLink {
  label: string;
  url: string;
}

export interface AppManualStep {
  id: string;
  title: string;
  body: string;
  deepLink?: string;
  externalLink?: AppManualStepExternalLink;
  appliesWhen?: AppliesWhen;
}
```

- [ ] **Step 4: Validate it**

In `apps/backend/src/app-catalog/app-manifest.util.ts`, inside `validateManualSteps`, add this block immediately after the existing `deepLink` check and before the `validateStepPlaceholders` calls:

```ts
    if (entry.externalLink !== undefined) {
      if (!isPlainObject(entry.externalLink)) {
        errors.push(`${entryPath}.externalLink: must be an object`);
      } else {
        if (!isNonEmptyString(entry.externalLink.label)) {
          errors.push(`${entryPath}.externalLink.label: required string`);
        }
        if (!isNonEmptyString(entry.externalLink.url)) {
          errors.push(`${entryPath}.externalLink.url: required string`);
        } else if (!entry.externalLink.url.startsWith('https://')) {
          errors.push(`${entryPath}.externalLink.url: must be an https:// URL`);
        }
      }
    }
```

Do **not** add `validateStepPlaceholders` calls for these fields — an external URL is literal, and a brace in it is a plain character rather than a token.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/backend && pnpm test -- app-manifest.util
```

Expected: PASS, including the five new cases.

- [ ] **Step 6: Confirm backward compatibility is unaffected**

```bash
cd apps/backend && pnpm test -- app-catalog
pnpm --filter backend exec tsc --noEmit
```

Expected: the whole app-catalog suite passes. `validateManualSteps` checks known fields and never rejects unknown ones, so a manifest carrying `externalLink` still installs on an older CE — confirm no test asserts an exact key set on manual steps.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/app-catalog/app-manifest.types.ts \
        apps/backend/src/app-catalog/app-manifest.util.ts \
        apps/backend/src/app-catalog/app-manifest.util.spec.ts
git commit -m "feat(app-catalog): let a manual step link out to a credential source

A manual step could link into the admin panel via deepLink but had no way to
send an operator to the page where a credential is actually obtained, and
bodies render as plain text so a URL written into one is not clickable.

Optional and additive: validation checks known fields and never rejects
unknown ones, so a manifest carrying externalLink still installs on an older
CE, which simply does not render it. No ceMin bump."
```

---

### Task 4: `externalLink` on manual steps — frontend

**Files:**
- Modify: `apps/frontend/src/services/appCatalogApi.ts` (the `AppManualStep` interface, ~lines 44-50)
- Modify: `apps/frontend/src/components/app-catalog/SetupNotes.tsx` (the expanded-body block)
- Modify: `apps/frontend/src/components/app-catalog/__tests__/SetupNotes.test.tsx`

**Interfaces:**
- Consumes: `AppManualStep.externalLink?: { label: string; url: string }` from Task 3 — the frontend type must mirror it exactly.
- Produces: an `<a target="_blank">` rendered beside the existing `Go` link when a step carries `externalLink`.

- [ ] **Step 1: Write the failing tests**

In `apps/frontend/src/components/app-catalog/__tests__/SetupNotes.test.tsx`, add a step carrying an external link to the fixture and add three cases. Append to the `STEPS` array:

```tsx
  {
    id: 'add-hf-token',
    title: 'Optional: HF_TOKEN for speaker diarization',
    body: 'Create a secret named HF_TOKEN.',
    deepLink: '/repo/acme/site/settings?tab=ai',
    externalLink: {
      label: 'Get a Hugging Face token',
      url: 'https://huggingface.co/settings/tokens',
    },
  },
```

Then add inside the `describe`:

```tsx
  it('renders the external link once expanded', async () => {
    render(<SetupNotes steps={STEPS} />);

    await userEvent.click(
      screen.getByRole('button', { name: /HF_TOKEN for speaker diarization/i }),
    );

    expect(screen.getByRole('link', { name: 'Get a Hugging Face token' })).toHaveAttribute(
      'href',
      'https://huggingface.co/settings/tokens',
    );
  });

  it('opens the external link in a new tab safely', async () => {
    render(<SetupNotes steps={STEPS} />);

    await userEvent.click(
      screen.getByRole('button', { name: /HF_TOKEN for speaker diarization/i }),
    );
    const link = screen.getByRole('link', { name: 'Get a Hugging Face token' });

    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders both the deep link and the external link side by side', async () => {
    render(<SetupNotes steps={STEPS} />);

    await userEvent.click(
      screen.getByRole('button', { name: /HF_TOKEN for speaker diarization/i }),
    );

    expect(screen.getByRole('link', { name: 'Go' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get a Hugging Face token' })).toBeInTheDocument();
  });

  it('renders no external link for a step without one', async () => {
    render(<SetupNotes steps={STEPS} />);

    await userEvent.click(screen.getByRole('button', { name: /give other people access/i }));

    expect(screen.queryByRole('link', { name: /hugging face/i })).not.toBeInTheDocument();
  });
```

Note the existing `renders the deep link once expanded` case uses `getByRole('link', { name: /manage members|go/i })`. Adding a third step does not affect it, because only the clicked step is expanded.

- [ ] **Step 2: Run them to make sure they fail**

```bash
cd apps/frontend && pnpm exec vitest run src/components/app-catalog/__tests__/SetupNotes.test.tsx
```

Expected: the three external-link cases FAIL (no such link is rendered); the `queryByRole` negative case passes already.

- [ ] **Step 3: Mirror the type**

In `apps/frontend/src/services/appCatalogApi.ts`, replace the `AppManualStep` interface:

```ts
export interface AppManualStep {
  id: string;
  title: string;
  body: string;
  deepLink?: string;
  appliesWhen?: AppliesWhen;
}
```

with:

```ts
export interface AppManualStepExternalLink {
  label: string;
  url: string;
}

export interface AppManualStep {
  id: string;
  title: string;
  body: string;
  deepLink?: string;
  externalLink?: AppManualStepExternalLink;
  appliesWhen?: AppliesWhen;
}
```

There are two `deepLink?: string` occurrences in this file (~line 32 and ~line 48). Change only the one inside `AppManualStep` — the other belongs to the preflight-gate type.

- [ ] **Step 4: Render it**

In `apps/frontend/src/components/app-catalog/SetupNotes.tsx`, replace the expanded-body block:

```tsx
                <div className="ml-5 mt-1 space-y-1">
                  {step.body && <p className="text-sm text-muted-foreground">{step.body}</p>}
                  {step.deepLink && (
                    <a href={step.deepLink} className="text-sm text-primary underline">
                      Go
                    </a>
                  )}
                </div>
```

with:

```tsx
                <div className="ml-5 mt-1 space-y-1">
                  {step.body && <p className="text-sm text-muted-foreground">{step.body}</p>}
                  {(step.deepLink || step.externalLink) && (
                    <div className="flex items-center gap-3">
                      {step.deepLink && (
                        <a href={step.deepLink} className="text-sm text-primary underline">
                          Go
                        </a>
                      )}
                      {step.externalLink && (
                        <a
                          href={step.externalLink.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-primary underline"
                        >
                          {step.externalLink.label}
                        </a>
                      )}
                    </div>
                  )}
                </div>
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/frontend && pnpm exec vitest run src/components/app-catalog/__tests__/SetupNotes.test.tsx
```

Expected: PASS, all cases including the four new ones.

- [ ] **Step 6: Typecheck and run the full frontend suite**

```bash
pnpm --filter frontend exec tsc --noEmit
cd apps/frontend && pnpm test:run
```

Expected: clean typecheck; suite green. `InstallDialog.test.tsx` and `AppCard.test.tsx` both render `SetupNotes` — confirm neither broke on the added wrapper `<div>`.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/services/appCatalogApi.ts \
        apps/frontend/src/components/app-catalog/SetupNotes.tsx \
        apps/frontend/src/components/app-catalog/__tests__/SetupNotes.test.tsx
git commit -m "feat(app-catalog): render a manual step's external link

Pairs with the manifest field: a step can now offer 'Get a Hugging Face
token' beside its Go button, instead of naming a URL in prose that renders
as unclickable plain text."
```

- [ ] **Step 8: Open the PR**

```bash
pnpm lint 2>&1 | tail -5   # confirm still at baseline
git push -u origin feat/ai-settings-clarity
gh pr create --title "AI settings clarity: name the cards, preset the COOP/COEP recipe, link out from manual steps" --body-file - <<'EOF'
Three onboarding fixes found while installing Studio on a fresh instance.

**Name the AI cards.** "AI Settings" and "AI Services" sat adjacent with
near-identical names and unrelated contents. AI Services is Replicate and
only Replicate; AI Settings holds the Anthropic key but never says so, and
its "chat pipelines" subtitle was narrower than the truth — those keys feed
`ai_handler` in both chat and completion mode. Now **LLM Providers** and
**Replicate**. Also makes a configured Replicate token replaceable (the
button used to vanish once set) and updates the two backend strings that
named the old card.

**Cross-Origin Isolation preset.** Enabling SharedArrayBuffer meant typing
two header names and two values an operator cannot guess. The preset row
existed but could not carry custom headers. Pattern is `**` deliberately —
a generic control cannot assume an app's basePath.

**`externalLink` on manual steps.** A step could link into the admin panel
but not out to where a credential is obtained, and bodies render as plain
text. Optional and additive; an older CE ignores it rather than rejecting
the manifest, so no `ceMin` bump.

Unblocks the Studio manifest and README work in `bffless/apps`, which quote
the new card names and the preset by name.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

---

## Self-Review

**Spec coverage.** Piece 1 → Task 1 (card renames, Replace token, both dangling backend strings). Piece 4 → Task 2 (preset + `applyPreset` carrying custom headers, `**` documented as deliberate). Piece 5 → Tasks 3 and 4 (backend type + validation, frontend type + render). Pieces 2 and 3 are the `bffless/apps` plan and are out of scope here.

**Placeholders.** None — every step carries the literal before/after code or an exact command with an expected result. Task 1's "no automated test" is an explicit, reasoned decision with a compensating visual check, not a deferral.

**Type consistency.** `AppManualStepExternalLink { label, url }` is declared identically in Task 3 (backend) and Task 4 (frontend). `HeaderRulePreset.customHeaders` is `{ name, value }[]` in Task 2's type, its test, and `applyPreset` — matching the existing `customHeaderRows` state shape in the component. The preset name string `Cross-Origin Isolation` is identical in the type test and the implementation.

**Known soft spot.** Task 3 Step 1 assumes the spec file's existing manifest-building helper is named `makeManifest`/`baseInstall`. Read the neighbouring cases first and use whatever they use; the assertions are what matter, not the fixture helper's name.
