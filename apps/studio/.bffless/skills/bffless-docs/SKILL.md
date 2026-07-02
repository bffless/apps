---
name: bffless-docs
description: A reference map of the public BFFless documentation (docs.bffless.app) — which page covers which topic, with canonical URLs. Load this when writing a blog post that mentions a BFFless feature, setup step, or concept (e.g. proxy rules, pipelines, AI/chat, auth, traffic splitting, share links, storage/S3/MinIO/GCS, SSL/Cloudflare, GitHub Actions deploys, the MCP server, the API) so you can add an inline Markdown link to the matching doc page. Use it only to LINK to existing pages, never to invent facts.
---

# BFFless docs — link reference

This skill is a lookup table of the public BFFless docs so a blog post can point readers to the right page. It does **not** teach the features — it only tells you **where each topic lives** so you can link to it.

## How to link

- When the post genuinely discusses a BFFless feature/concept/setup step that appears in the map below, turn its **first meaningful mention** into an inline Markdown link: `[proxy rules](https://docs.bffless.app/features/proxy-rules/)`.
- **Only link to URLs in the map below.** Never guess or construct a doc URL, and never link a topic the map doesn't list.
- Keep URLs **exactly** as written — they end in a **trailing slash** (the docs site is static HTML; a missing slash 200s but isn't canonical).
- Use natural anchor text (the feature's name in the sentence), not "click here" or the raw URL.
- Link **sparingly** — a handful across the whole post, one per topic. This is a blog post, not a link farm. If a section doesn't clearly map to a page, add no link.
- Only link when the post's content actually matches what the page is about. When unsure, don't link.
- These links are additive: the post must read perfectly with every link removed.

## Where things live

### Overview
- [What BFFless is](https://docs.bffless.app/) — the platform overview / home page

### Features
- [Proxy Rules](https://docs.bffless.app/features/proxy-rules/) — forward `/api/*` to a backend without CORS
- [Pipelines](https://docs.bffless.app/features/pipelines/) — no-code backend automation by chaining handlers
- [AI Pipelines](https://docs.bffless.app/features/ai-pipelines/) — AI chat & content generation via pipeline handlers (OpenAI/Anthropic/Google)
- [Chat](https://docs.bffless.app/features/chat/) — add AI chat (full-page or popup widget) to a site
- [Authorization](https://docs.bffless.app/features/authorization/) — user roles, permissions, access control
- [Traffic Splitting](https://docs.bffless.app/features/traffic-splitting/) — A/B tests and canary deployments across aliases
- [Share Links](https://docs.bffless.app/features/share-links/) — share private deployments without auth
- [Repository Overview](https://docs.bffless.app/features/repository-overview/) — deployments, aliases, branches
- [MCP Server](https://docs.bffless.app/features/mcp-server/) — manage BFFless from AI assistants via MCP
- [Skills / Claude Code plugin](https://docs.bffless.app/features/claude-code-plugin/) — the BFFless agent skills & Claude Code plugin

### Getting started
- [Quick Start](https://docs.bffless.app/getting-started/quickstart/) — deploy BFFless with the automated installer
- [Setup Wizard](https://docs.bffless.app/getting-started/setup-wizard/) — first-run configuration
- [First Deployment](https://docs.bffless.app/getting-started/first-deployment/) — first repo, API key, first site
- [Viewing Deployments](https://docs.bffless.app/getting-started/viewing-deployments/) — browse deployments, aliases, domains
- [Cloudflare Setup](https://docs.bffless.app/getting-started/cloudflare-setup/) — Cloudflare for SSL/CDN/DDoS
- [Let's Encrypt Setup](https://docs.bffless.app/getting-started/letsencrypt-setup/) — free SSL via Let's Encrypt

### Configuration
- [Environment Variables](https://docs.bffless.app/configuration/environment-variables/) — full config reference
- [Authentication](https://docs.bffless.app/configuration/authentication/) — auth via SuperTokens
- [SSO / OIDC Providers](https://docs.bffless.app/configuration/oidc-providers/) — Google/Okta/Azure AD/OIDC single sign-on
- [Storage Backends](https://docs.bffless.app/configuration/storage-backends/) — configure object storage

### Storage
- [Storage Overview](https://docs.bffless.app/storage/overview/) — compare storage providers
- [AWS S3](https://docs.bffless.app/storage/aws-s3/) · [Google Cloud Storage](https://docs.bffless.app/storage/google-cloud-storage/) · [Azure Blob](https://docs.bffless.app/storage/azure-blob-storage/) · [MinIO](https://docs.bffless.app/storage/minio/) — provider setup
- [Caching](https://docs.bffless.app/storage/caching/) — caching for performance
- [Migration Guide](https://docs.bffless.app/storage/migration-guide/) — move data between providers

### Deployment
- [Deployment Overview](https://docs.bffless.app/deployment/overview/) — choose a deployment method
- [DigitalOcean](https://docs.bffless.app/deployment/digitalocean/) · [Umbrel](https://docs.bffless.app/deployment/umbrel/) — host-specific guides
- [SSL Certificates](https://docs.bffless.app/deployment/ssl-certificates/) — SSL options
- [GitHub Actions](https://docs.bffless.app/deployment/github-actions/) — automate deploys; sub-pages: [Upload Artifact](https://docs.bffless.app/deployment/github-actions/upload-artifact/), [Download Artifact](https://docs.bffless.app/deployment/github-actions/download-artifact/), [Compare Screenshots](https://docs.bffless.app/deployment/github-actions/compare-screenshots/), [Compare Coverage](https://docs.bffless.app/deployment/github-actions/compare-coverage/)

### Recipes
- [Recipes index](https://docs.bffless.app/recipes/) — practical patterns
- [Server-Side State](https://docs.bffless.app/recipes/state-management/) — Data Tables + Pipelines for app state
- [Email Form Handler](https://docs.bffless.app/recipes/email-form-handler/) — form submissions by email, no backend
- [A/B Testing](https://docs.bffless.app/recipes/ab-testing/) — A/B test a static site with traffic splitting
- [Visual Regression Testing](https://docs.bffless.app/recipes/compare-screenshots/) · [Coverage Comparison](https://docs.bffless.app/recipes/coverage-comparison/) — PR-vs-prod checks in CI

### Reference
- [API Reference](https://docs.bffless.app/reference/api/) — REST API
- [Architecture](https://docs.bffless.app/reference/architecture/) — system architecture
- [Security](https://docs.bffless.app/reference/security/) — security model & best practices
- [Database Schema](https://docs.bffless.app/reference/database-schema/) — tables & relationships
- [Troubleshooting](https://docs.bffless.app/troubleshooting/) — common issues & fixes
