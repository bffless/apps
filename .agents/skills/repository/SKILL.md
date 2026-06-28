---
name: repository
description: Browse deployments, manage aliases, view branches
---

# Repository

**Docs**: https://docs.bffless.app/features/repository-overview/

The Repository is your central hub for browsing deployments, managing aliases, and navigating your project's content.

## Content Browser

The browser has four panels:

1. **Files Panel**: Navigate directory structure, search files
2. **Preview Panel**: Live preview of selected file
3. **History Panel**: Deployment timeline, compare versions
4. **References Panel**: See which aliases point to this deployment

## Deployments

Each deployment is an immutable snapshot of your build output. Deployments are identified by:

- **Deployment ID**: Unique hash
- **Git info**: Branch, commit SHA, commit message (if available)
- **Timestamp**: When deployed
- **Size**: Total file size

## Aliases

Aliases are named pointers to deployments. Two types:

**Manual aliases**: You control which deployment they point to
- `production`, `staging`, `v1.2.0`
- Update manually or via API

**Auto-preview aliases**: Automatically created for branches/PRs
- `preview-feature-branch`, `pr-123`
- Updated on each push, deleted when branch is deleted

## Common Workflows

**Deploy new version:**
1. Upload via CLI/API/GitHub Action
2. New deployment appears in Repository
3. Update alias to point to new deployment

**Rollback:**
1. Find previous deployment in History
2. Update production alias to point to it
3. Instant rollback, no rebuild needed

**Preview PRs:**
1. Configure auto-preview in project settings
2. Each PR gets unique preview URL
3. Preview updates on each push

## Navigation Tips

- Use keyboard shortcuts: `j/k` to navigate files, `Enter` to preview
- Search supports glob patterns: `*.html`, `components/**`
- Click deployment hash to copy full URL
- Right-click alias for quick actions menu
