# Studio Onboarding Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Studio's install instructions point at real places, mark the optional credential optional, and give the app a short human-facing README as its front door.

**Architecture:** Content only — one JSON manifest, one new markdown file, corrections to two existing markdown files. No code, no build change, no rule-set change. The new `README.md` becomes the operator's front door; `bffless/README.md` stays the technical rule-set reference (CI requires it) and is corrected only where it would now contradict.

**Tech Stack:** JSON manifest consumed by CE's app catalog; markdown rendered on GitHub.

**Spec:** `docs/superpowers/specs/2026-08-05-studio-onboarding-clarity-design.md` (pieces 2 and 3).

## Global Constraints

- **Depends on the CE PR shipping first.** Every section name written here quotes CE's renamed cards (`LLM Providers`, `Replicate`), the new preset (`Cross-Origin Isolation`), and the new manifest field (`externalLink`). Do not merge this before the CE change is deployed to the instance being onboarded.
- `pnpm apps:check` requires `apps/studio/bffless/README.md` to exist and to contain the headings **`Manual setup (admin panel)`** and **`First-success checkpoint`**. Do not delete that file, and do not rename either heading.
- Settings paths are quoted exactly as the CE screen renders them: `Settings → AI → LLM Providers → Add Provider`, `Settings → AI → Replicate`, `Settings → AI → Secrets`, `Settings → General → Visibility`, `Settings → Response Headers`.
- The access-control control names are CE's literal UI strings: the card **Visibility** with values **Public** / **Private**, and the card **Access Control** holding **Required Role**, whose admin option reads **`Admin or higher`**.
- Do not hand-edit `version` in `bffless-app.json` — release-please owns it.
- `HF_TOKEN` must read as optional in both the step title and the first words of the body. It is required only for speaker diarization, which is off by default.
- Manifest step bodies may only use the placeholder tokens `{projectPath}` and `{appHost}`.

---

### Task 1: Rewrite the manifest's manual steps

Three of six steps point somewhere wrong, one demands a credential most users do not need, and one is not needed at all.

**Files:**
- Modify: `apps/studio/bffless-app.json` (the `install.manualSteps` array, lines 36-79)
- Modify: `.claude/skills/publish-app/SKILL.md` (line 125, the entry shape; line 199, the placeholder-validation row)
- Modify: `.agents/skills/publish-app/SKILL.md` (the mirrored copy, if `pnpm skills:check` reports drift)

**Interfaces:**
- Consumes: `AppManualStep.externalLink?: { label: string; url: string }` from the CE PR.
- Produces: a five-entry `manualSteps` array. Task 2's README mirrors the same setup facts and must not contradict it.

**Document the new field so app authors can find it.** The CE branch's final review flagged
that `publish-app/SKILL.md` enumerates the manifest's manual-step fields and does not mention
`externalLink` — so no app author would discover it. `check-app-conventions.mjs` does not reject
unknown fields, so nothing breaks; it is purely a discoverability gap. Two edits:

- **Line 125**, the entry shape, currently reads
  `Each entry: {  id, title, body, deepLink?, appliesWhen? }`. Add `externalLink?` to it, and
  describe it as an optional `{ label, url }` pointing at an external `https://` page where a
  credential is obtained — rendered as a second link beside **Go**.
- **Line 199**, the placeholder-validation row, currently reads
  `install.manualSteps[].{title,body,deepLink} placeholders`. Note that `externalLink` is
  deliberately **excluded** from placeholder validation, because an external URL is literal and a
  brace in it is a plain character rather than a token. An author who expects `{projectPath}` to
  expand inside `externalLink.url` would otherwise be surprised.

The repo keeps two copies of its skills in sync — run `pnpm skills:check` after editing and
`pnpm skills:sync` if it reports drift.

- [ ] **Step 1: Branch**

```bash
cd /home/rico/bffless/repos/apps
git checkout main && git pull
git checkout -b docs/studio-onboarding
```

- [ ] **Step 2: Verify the conventions check passes before you start**

```bash
pnpm apps:check
```

Expected: exit 0. This is your baseline — if it already fails, stop and fix that separately.

- [ ] **Step 3: Replace the `manualSteps` array**

In `apps/studio/bffless-app.json`, replace the whole `"manualSteps": [ ... ]` array (lines 36-79) with:

```json
    "manualSteps": [
      {
        "id": "connect-replicate",
        "title": "Connect Replicate",
        "body": "Add your Replicate API token under Settings → AI → Replicate. It powers transcription (WhisperX), scene direction and the per-scene refiner (Gemini), voice clone and speech (MiniMax — cloning ≈ $3 per call), and thumbnail rendering.",
        "deepLink": "/repo/{projectPath}/settings?tab=ai",
        "externalLink": {
          "label": "Get a Replicate token",
          "url": "https://replicate.com/account/api-tokens"
        },
        "appliesWhen": "always"
      },
      {
        "id": "connect-anthropic",
        "title": "Connect Anthropic",
        "body": "Add an Anthropic API key under Settings → AI → LLM Providers → Add Provider. It powers thumbnail prompt drafts (Claude Sonnet) and the companion blog writer (Claude Opus).",
        "deepLink": "/repo/{projectPath}/settings?tab=ai",
        "externalLink": {
          "label": "Get an Anthropic key",
          "url": "https://console.anthropic.com/settings/keys"
        },
        "appliesWhen": "always"
      },
      {
        "id": "coop-coep-headers",
        "title": "Turn on cross-origin isolation",
        "body": "Settings → Response Headers → Add Rule → click the Cross-Origin Isolation preset → Create. Studio's in-browser video export needs it; without it, export falls back to a slower single-threaded encoder.",
        "deepLink": "/repo/{projectPath}/settings?tab=response-headers",
        "appliesWhen": "always"
      },
      {
        "id": "restrict-access",
        "title": "Keep Studio private",
        "body": "Studio's API rules carry no per-rule auth, so access control is the only thing protecting the paid AI endpoints. Under Settings → General → Visibility, set it to Private. An Access Control section then appears — optionally set Required Role to Admin or higher.",
        "deepLink": "/repo/{projectPath}/settings?tab=general",
        "appliesWhen": "always"
      },
      {
        "id": "add-hf-token",
        "title": "Optional: HF_TOKEN for speaker diarization",
        "body": "Optional — transcription works fine without it. It is needed only to support speaker diarization, which labels who is talking in a recording with more than one voice. To enable it, create a secret named HF_TOKEN with a Hugging Face read token under Settings → AI → Secrets; diarization runs a gated Hugging Face model that requires the token.",
        "deepLink": "/repo/{projectPath}/settings?tab=ai",
        "externalLink": {
          "label": "Get a Hugging Face token",
          "url": "https://huggingface.co/settings/tokens"
        },
        "appliesWhen": "always"
      }
    ]
```

Five changes are encoded here — know why each one is made:

1. `connect-anthropic` said "under Settings → AI Services". Anthropic is not a valid `AIServiceType`; it is configured under the card CE now calls **LLM Providers**, via **Add Provider**.
2. `add-hf-token` said "Settings → AI Services → Secrets" (Secrets is a sibling card, not a child) and blamed "WhisperX alignment/diarization". `align_output: true` runs unconditionally and needs no token — only diarization does, and it is off by default. The step is now last and leads with "Optional".
3. `coop-coep-headers` no longer dictates two header names and two values; it points at the preset.
4. `restrict-access` pointed at `?tab=members`, which manages people and has no visibility control at all. Now `?tab=general`, naming the two real cards.
5. `point-skills-path` is **removed entirely**. Its Source instruction was redundant (skills fall back to the deployment serving the request, which is Studio itself) and its Path half is a project-wide setting, not a rule-level one. It moves to the README's Advanced section.

`appliesWhen` stays `"always"` on every entry — the allowed values are only `always | bucketStorage | localStorage | platformMode | selfHosted`, and there is no "optional feature" condition. HF_TOKEN's conditionality lives in the copy.

- [ ] **Step 4: Verify the JSON parses and carries five steps**

```bash
cd /home/rico/bffless/repos/apps
python3 -c "
import json
d = json.load(open('apps/studio/bffless-app.json'))
steps = d['install']['manualSteps']
print('count:', len(steps))
for s in steps:
    print(' -', s['id'], '|', s['title'])
    assert s['body'].strip(), s['id']
    assert 'AI Services' not in s['body'], 'stale card name in ' + s['id']
    assert 'tab=members' not in s.get('deepLink',''), 'stale deep link in ' + s['id']
assert len(steps) == 5
assert not any(s['id'] == 'point-skills-path' for s in steps)
assert steps[-1]['id'] == 'add-hf-token'
assert steps[-1]['title'].startswith('Optional')
assert steps[-1]['body'].startswith('Optional')
print('OK')
"
```

Expected: `count: 5`, the five ids, then `OK`.

- [ ] **Step 5: Verify only allowed placeholder tokens are used**

```bash
python3 -c "
import json, re
d = json.load(open('apps/studio/bffless-app.json'))
allowed = {'projectPath', 'appHost'}
for s in d['install']['manualSteps']:
    for field in ('title','body','deepLink'):
        for tok in re.findall(r'\{([^}]*)\}', s.get(field) or ''):
            assert tok in allowed, (s['id'], field, tok)
print('placeholders OK')
"
```

Expected: `placeholders OK`. Note `externalLink` is deliberately excluded — CE does not run placeholder validation on it, because an external URL is literal.

- [ ] **Step 6: Run the conventions check**

```bash
pnpm apps:check
```

Expected: exit 0, same as your Step 2 baseline.

- [ ] **Step 7: Commit**

```bash
git add apps/studio/bffless-app.json
git commit -m "fix(studio): point the install steps at real places

Three of six steps sent the operator somewhere wrong. Anthropic was filed
under AI Services, where it cannot be configured at all. HF_TOKEN was nested
under AI Services and presented as mandatory, when transcription works fine
without it — it is needed only for speaker diarization, which is a toggle
that defaults to off. Access control pointed at the Members tab, which
manages people and has no visibility control.

COOP/COEP now points at CE's Cross-Origin Isolation preset instead of naming
two headers and two values to hand-type, and the three credential steps link
out to where each token is obtained.

Drops point-skills-path: its Source instruction was redundant (skills fall
back to the serving deployment, which is Studio) and its Path half is a
project-wide setting rather than a rule-level one. It moves to the README's
Advanced section."
```

---

### Task 2: Write `apps/studio/README.md`

`apps/studio/` has no `README.md`, so its GitHub page renders bare. No app in the monorepo has one — this sets the pattern.

**Files:**
- Create: `apps/studio/README.md`

**Interfaces:**
- Consumes: the same setup facts encoded in Task 1's manifest. Where both describe a credential, the wording must agree.
- Produces: the front door that `bffless/README.md` links up to in Task 3.

**Keep it short.** The existing `bffless/README.md` is good reference material for an agent and too verbose for a human — that is the failure this file must not repeat. The table does the work; no expanding paragraph per row.

- [ ] **Step 1: Create the file**

Create `apps/studio/README.md`:

```markdown
# Studio

Turn one long, rambly screen recording into a short, watchable video — in your own recorded
voice. Nothing is re-voiced and the AI never rewrites what you said. Import a recording, let the
AI director split it into scenes and propose cuts, tune those cuts on the transcript grid, and
export in your browser with ffmpeg.wasm.

Studio is a static app with no server. Every backend step is a BFFless pipeline running on your
own instance, so you bring the credentials.

## Setup

Install Studio from Admin → Apps, then configure these in the project you installed it into.

| What | Where | Required? | What it powers |
| --- | --- | --- | --- |
| Replicate token | Settings → AI → **Replicate** ([get one](https://replicate.com/account/api-tokens)) | Yes | Transcription (WhisperX), scene direction and the per-scene refiner (Gemini), voice clone and speech (MiniMax), thumbnail rendering |
| Anthropic key | Settings → AI → **LLM Providers** → Add Provider ([get one](https://console.anthropic.com/settings/keys)) | For thumbnails and the blog writer | Thumbnail prompt drafts (Claude Sonnet), companion blog writer (Claude Opus) |
| Storage bucket | Settings → Storage | Yes | Presigned direct-to-bucket uploads; Studio writes under `<owner>/<repo>/uploads/…` |
| Cross-origin isolation | Settings → Response Headers → Add Rule → **Cross-Origin Isolation** preset | Yes for fast export | `SharedArrayBuffer`, which multithreaded `ffmpeg.wasm` needs. Without it export still works, on a slower single-threaded encoder |
| Access control | Settings → General → **Visibility** → **Private** | Yes | Studio's API rules carry no per-rule auth, so this is the only thing protecting the paid AI endpoints. Once Private, an **Access Control** card appears where you can set **Required Role** to **Admin or higher** |
| `HF_TOKEN` secret | Settings → AI → **Secrets** ([get one](https://huggingface.co/settings/tokens)) | **Optional** | **Speaker diarization** only — labelling who is talking. Transcription works without it |

Voice cloning costs roughly **$3 per call**; everything else is metered Replicate usage.

## Check it works

Upload a short screen recording and wait for the transcript. That one round-trip exercises the
presigned upload, your bucket, and the WhisperX transcribe pipeline.

A 404 on `/api/*` means the proxy rule sets are not attached to the app's alias. A transcribe
failure usually means a missing Replicate token.

## Advanced (optional)

Neither of these is needed to get Studio running.

**Better thumbnail prompts.** Set Settings → AI → Skills Path to `apps/studio/dist/bffless/skills`
to load the `image-prompts` skill, which defines the house styles, style routing, and negatives.
Leave **Source** blank — it already defaults to the deployment serving the request, which is
Studio. Without this the thumbnail drafter still returns a prompt, just a generic one; the skill
is skipped silently. Note this is a per-project setting.

**Sharing a project with other apps.** Scope access control to the `studio` alias (Aliases →
`studio` → Private) instead of making the whole project private, which cascades to every alias
and domain in it. Be aware that the Skills Path and the cross-origin header rule are project-wide
and cannot be scoped per app.

## Going deeper

- [`bffless/README.md`](./bffless/README.md) — the proxy rule sets: authoring, building, importing, attaching
- [`CLAUDE.md`](./CLAUDE.md) — local development commands and the locked pipeline
- [`CONTEXT.md`](./CONTEXT.md) and [`DESIGN.md`](./DESIGN.md) — domain model and design decisions
- [`stories/`](./stories/) — the design, story by story. Read `00-architecture-and-state.md` first
```

- [ ] **Step 2: Check every relative link resolves**

```bash
cd /home/rico/bffless/repos/apps/apps/studio
for p in bffless/README.md CLAUDE.md CONTEXT.md DESIGN.md stories; do
  test -e "$p" && echo "OK   $p" || echo "MISS $p"
done
```

Expected: all six lines read `OK`. Fix any `MISS` before continuing.

- [ ] **Step 3: Check the README does not contradict the manifest**

```bash
cd /home/rico/bffless/repos/apps
grep -n "AI Services\|tab=members\|alignment/diarization" apps/studio/README.md || echo "no stale references"
```

Expected: `no stale references`. Those three strings are the errors this whole change exists to remove; none may appear in the new file.

- [ ] **Step 4: Commit**

```bash
git add apps/studio/README.md
git commit -m "docs(studio): add a README as the app's front door

apps/studio/ had no README, so its GitHub page rendered bare and the only
setup material lived a directory down in bffless/README.md under a title
that reads as backend internals.

Short and table-driven on purpose: what each credential is for, whether it
is actually required, and what breaks without it. The two settings that are
not needed to get running — Skills Path and per-alias scoping — are pushed
to an Advanced section so the required path stays scannable."
```

---

### Task 3: Correct the technical README and the catalog blurb

`bffless/README.md` stays the technical reference (CI requires it), but five of its statements would now contradict the new README.

**Files:**
- Modify: `apps/studio/bffless/README.md` (lines 63-65, 76-79, 85, 90, 93-94, 130-131)
- Modify: `apps/studio/catalog/description.md` (lines 25-27)

**Interfaces:**
- Consumes: the wording settled in Tasks 1 and 2.
- Produces: nothing downstream.

- [ ] **Step 1: Fix the Manual setup bullets**

In `apps/studio/bffless/README.md`, in the `## Manual setup (admin panel)` section, replace the `HF_TOKEN` bullet (lines 63-65):

```markdown
- **Secrets — `HF_TOKEN` from Hugging Face.** Add `HF_TOKEN` under **Settings → AI Services → Secrets**
  set to a [Hugging Face](https://huggingface.co/settings/tokens) **read** token; `/api/transcribe`
  references it as `secrets.HF_TOKEN` for WhisperX alignment/diarization. See Prerequisites §2.
```

with:

```markdown
- **Secrets — `HF_TOKEN` from Hugging Face (optional).** Only needed for **speaker diarization**;
  transcription works without it. Add `HF_TOKEN` under **Settings → AI → Secrets** set to a
  [Hugging Face](https://huggingface.co/settings/tokens) **read** token; `/api/transcribe`
  passes it as `huggingface_access_token` when the diarize flag is on. See Prerequisites §2.
```

Then replace the AI-skills bullet (lines 76-79):

```markdown
- **AI skills path — the `thumbnail-draft` rule's `ai` step Skills section.** Set Skills Source to
  `studio` and Path to `apps/studio/dist/bffless/skills` so `/api/thumbnail/draft` can load the
  `image-prompts` skill; without this pairing thumbnail drafting silently skips the skill (the
  installer can't wire it).
```

with:

```markdown
- **AI skills path (optional).** Set **Settings → AI → Skills Path** to
  `apps/studio/dist/bffless/skills` so `/api/thumbnail/draft` can load the `image-prompts` skill.
  Leave **Source** blank — skills already resolve against the deployment serving the request.
  Without the path, thumbnail drafting silently skips the skill and returns a generic prompt.
  Note this is a **per-project** setting, not per-rule.
```

- [ ] **Step 2: Fix the Prerequisites numbered list**

Replace line 85's location:

```markdown
1. **Replicate token** — under **AI Services → Replicate**, create an API token at
```

with:

```markdown
1. **Replicate token** — under **Settings → AI → Replicate**, create an API token at
```

Replace lines 90-92:

```markdown
2. **`HF_TOKEN` secret** — under **Secrets** (just below AI Services), add `HF_TOKEN` set to a
   [Hugging Face](https://huggingface.co/settings/tokens) **read** token. Used by `/api/transcribe`
   for WhisperX alignment/diarization (when diarization is enabled). Referenced as `secrets.HF_TOKEN`.
```

with:

```markdown
2. **`HF_TOKEN` secret (optional)** — under **Settings → AI → Secrets**, add `HF_TOKEN` set to a
   [Hugging Face](https://huggingface.co/settings/tokens) **read** token. Used by `/api/transcribe`
   only when speaker diarization is enabled; `align_output` needs no token. Referenced as
   `secrets.HF_TOKEN`.
```

Replace lines 93-94:

```markdown
3. **Anthropic key** — under AI Services, for the `/api/thumbnail/draft` `ai_handler`
   (`claude-sonnet-4-6`).
```

with:

```markdown
3. **Anthropic key** — under **Settings → AI → LLM Providers → Add Provider**, for
   `/api/thumbnail/draft` (`claude-sonnet-4-6`) and the companion blog writer
   (`claude-opus-4-6`).
```

- [ ] **Step 3: Fix the first-success troubleshooting line**

Replace lines 130-131:

```markdown
rule set isn't attached to the `studio` alias; a transcribe failure usually means a missing Replicate
token or `HF_TOKEN`.
```

with:

```markdown
rule set isn't attached to the `studio` alias; a transcribe failure usually means a missing Replicate
token.
```

A missing `HF_TOKEN` cannot cause a default-path transcribe failure — the expression resolves to
null and WhisperX ignores it when diarization is off.

- [ ] **Step 4: Add a pointer up to the new README**

Immediately under the `# Studio backend — BFFless proxy rule set` heading (line 1), insert:

```markdown
> Setting Studio up for the first time? Start with [`../README.md`](../README.md) — it lists every
> credential and setting in one table. This file is the technical reference for the proxy rule
> sets themselves.
```

- [ ] **Step 5: Mark HF_TOKEN optional in the catalog blurb**

In `apps/studio/catalog/description.md`, replace lines 25-27:

```markdown
`HF_TOKEN` secret, a storage bucket with presigned uploads, and one COOP/COEP
response-header rule for the in-browser exporter. The install steps walk
through each.
```

with:

```markdown
a storage bucket with presigned uploads, and one cross-origin isolation
response-header rule for the in-browser exporter. A Hugging Face `HF_TOKEN`
is optional, for speaker diarization. The install steps walk through each.
```

Check the preceding line still reads grammatically — line 24 ends `...an Anthropic key (thumbnail drafts, blog writer),` and must now flow into "a storage bucket".

- [ ] **Step 6: Verify the required headings survived and no stale strings remain**

```bash
cd /home/rico/bffless/repos/apps
grep -c "Manual setup (admin panel)" apps/studio/bffless/README.md
grep -c "First-success checkpoint" apps/studio/bffless/README.md
grep -n "AI Services" apps/studio/bffless/README.md apps/studio/catalog/description.md || echo "no stale card names"
pnpm apps:check
```

Expected: both `grep -c` print `1`; `no stale card names`; `apps:check` exits 0. If either heading count is `0` you removed a heading CI depends on — restore it.

- [ ] **Step 7: Commit and open the PR**

```bash
git add apps/studio/bffless/README.md apps/studio/catalog/description.md
git commit -m "docs(studio): correct the technical README and catalog blurb

Five statements would now contradict the new front-door README: Anthropic
filed under AI Services, HF_TOKEN nested under it and presented as required,
the alignment claim (align_output needs no token), the redundant Skills
Source instruction, and HF_TOKEN listed as a likely cause of transcribe
failure, which it cannot be on the default path.

Kept in place as the rule-set reference — pnpm apps:check requires this file
and its two headings — with a pointer up to the new README."

git push -u origin docs/studio-onboarding
gh pr create --title "Studio onboarding: fix the install steps, add a README" --body-file - <<'EOF'
Found while installing Studio on a fresh CE instance.

**The install steps pointed somewhere wrong.** Anthropic was filed under AI
Services, where it cannot be configured at all. HF_TOKEN was nested under AI
Services and presented as mandatory — transcription works fine without it;
it is needed only for speaker diarization, a toggle that defaults to off.
Access control pointed at the Members tab, which manages people and has no
visibility control.

**COOP/COEP** now points at CE's new Cross-Origin Isolation preset instead
of naming two headers and two values to hand-type, and the credential steps
link out to where each token is obtained.

**`point-skills-path` is dropped** — its Source instruction was redundant
(skills fall back to the serving deployment, which is Studio) and its Path
half is a project-wide setting, not a rule-level one. It moves to the
README's Advanced section. Six steps become five, two of them optional.

**New `apps/studio/README.md`** — the app's GitHub page rendered bare, and
the only setup material lived a directory down under a title that reads as
backend internals. Short and table-driven. `bffless/README.md` stays the
technical reference (CI requires it) and is corrected where it would now
contradict.

Requires the CE change to be deployed first — this quotes the renamed cards
(LLM Providers / Replicate), the new preset, and the new `externalLink`
manifest field.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

---

## Self-Review

**Spec coverage.** Piece 2 → Task 1 (all five manifest changes, including the `point-skills-path` removal and the `restrict-access` deep-link fix). Piece 3 → Task 2 (the new README, including the Advanced section) and Task 3 (the five `bffless/README.md` corrections plus the catalog blurb). Pieces 1, 4, 5 are the CE plan and are out of scope here.

**Placeholders.** None — every step carries literal before/after content or an exact command with an expected result. The verification steps are executable checks rather than "make sure it looks right".

**Consistency with the CE plan.** Card names (`LLM Providers`, `Replicate`), the preset name (`Cross-Origin Isolation`), and the `externalLink` shape (`{ label, url }`) are identical across both plans. The HF_TOKEN body text is byte-identical between Task 1's manifest and the CE plan's `SetupNotes` test fixture, which is deliberate — the test fixture is a realistic sample, not a copy that must be kept in sync.

**Known risk.** Task 1's corrected copy reaches an installed instance only on the next Studio release, since manifests are fetched from the registry at install time and are not vendored into CE. It does not repair an already-installed instance — the README is what helps the current onboarding run.
