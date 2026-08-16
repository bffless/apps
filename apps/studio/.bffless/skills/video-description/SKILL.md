---
name: video-description
description: House style for a finished video's YouTube title and description — the creator's voice, the correct spelling of every product name (BFFless, never "BFF-less" or "Bffless"), and YouTube formatting rules. Load this whenever writing, rewriting or polishing a video title, summary or description from a script or transcript, so the result reads like the creator wrote it and contains no brand-name typos.
---

# Video description — house style

You are writing the **title** and **description** that get pasted straight into YouTube for a finished video. The description will be read on its own by someone deciding whether to watch — it must be accurate, cleanly formatted, and sound like the creator, not like a report about them.

## Voice — write AS the creator

- Write in the **first person, as the person presenting the video**: "In this video I walk through…", "I show how…", "we'll build…" (use "we" for the presenter + viewer doing something together).
- **Never** refer to the presenter as "the user", "the speaker", "the narrator", "the presenter", "the creator", "the author" or "the video's host". If you catch yourself writing "the user does X", rewrite it as "I do X".
- Plain, direct, technical-friendly tone. Say what actually happens in the video. No hype, no clickbait, no exclamation marks, no emojis, no hashtags.
- Do not describe the video ("This video covers…", "This tutorial explains…") more than once, if at all — prefer just saying the thing: "I add cookie-based auth to a static site without a backend."

## Creator profile

Use this to get names, roles and framing right. Do not add facts that neither the script nor this section supports.

- The presenter is the **creator of BFFless** — an open-source, self-hostable static-hosting platform whose "backend for frontend, without the backend" idea gives a static site pipelines, proxy rules, data tables, auth and AI endpoints with no app server.
- The videos are typically walkthroughs, live builds and showcases of BFFless features and of the free apps built on it. Where the script builds or uses one of those apps, name it correctly (list below).
- Forking this skill for your own channel? Replace this section with who you are and what you make — the rest of the rules still apply.

## Proper nouns — spell these exactly

The model reading a transcript often mangles brand names it heard rather than read. Use these canonical spellings and casings, and never hyphenate, split or lowercase them:

| Write exactly | Never write |
| --- | --- |
| BFFless | BFF-less, Bffless, bffless (in prose), BFF less, BFF Less, Beefless |
| Studio (Studio app / BFFless Studio) | studio app, The Studio |
| Handoff | Hand-off, Hand off |
| Rivulet | Rivulette, Rivelet |
| Recall | ReCall |
| proxy rules, proxy rule set | proxy-rules (in prose), proxy rulesets |
| pipelines, pipeline handlers | pipe lines |
| data tables | datatables, data-tables |
| Claude, Claude Code | Claude code, ClaudeCode |
| MCP (the MCP server) | M.C.P., mcp |
| GitHub, GitHub Actions | Github, Git Hub, GitHub actions |
| YouTube | Youtube, You Tube |
| Cloudflare | CloudFlare |
| DigitalOcean | Digital Ocean |
| Umbrel | Umbrell |
| Postgres / PostgreSQL | postgres (in prose), Postgre |
| Traefik | Traefic, Traffic (when the proxy is meant) |
| Kubernetes | kubernetes (in prose), Kubernates |
| Terraform | terraform (in prose) |
| TypeScript, JavaScript | Typescript, Javascript |
| React, Vite, NestJS, Docker, Nginx | react, vite, Nest.js, docker, NGINX (in prose) |
| SuperTokens | Super Tokens, Supertokens |
| Replicate, Anthropic, OpenAI, Gemini | replicate (the service), OpenAi, Open AI |

Product and code identifiers keep their exact casing even at the start of a sentence (write "BFFless lets you…", not "Bffless lets you…"). Words that are only spoken in the script and don't appear in this table: spell them the way the product spells itself; when unsure, prefer the standard public spelling over what the transcript shows.

## Title

- Under **70 characters**, specific and descriptive: what the viewer will see or learn.
- Sentence case (capitalise the first word and proper nouns only) — not Title Case, not ALL CAPS.
- No trailing punctuation, no surrounding quotes, no emojis, no "| Channel name" suffix, no clickbait patterns ("You won't believe…", "…in 5 minutes!!!").
- Prefer the concrete thing over the abstract: "Add AI chat to a static site with BFFless pipelines" beats "AI chat made easy".

## Description (summary)

- **2 to 4 sentences of plain prose**, first person. Total roughly 40–110 words.
- Sentence one is the hook: what I do or show in the video, in one line — this is what shows above the fold on YouTube.
- Then what the viewer gets: the concrete steps, features or outcome that actually appear in the script. Mention the tools/products by their canonical names.
- Plain text only: no markdown, no bullet lists, no headings, no links, no hashtags, no timestamps (chapter markers are appended separately by the app — do not write them).
- Describe only what the final script says. Do not mention cuts, editing, or things that were removed; do not invent features, numbers, or results the script doesn't state.
- Do not end with a call to action ("Subscribe!", "Let me know in the comments").

## Self-check before you answer

1. Every product/brand name matches the table above — search your text for "BFF-", "Bffless", "the user", "the speaker" and fix any hit.
2. Nothing is claimed that the script does not support.
3. Title ≤ 70 chars, sentence case, no trailing punctuation. Description is 2–4 plain sentences in first person.
4. No emojis, hashtags, markdown, quotes around the whole thing, or leading/trailing whitespace.
5. Return **only** the strict JSON `{"title": "...", "summary": "..."}` — no fences, no commentary.
