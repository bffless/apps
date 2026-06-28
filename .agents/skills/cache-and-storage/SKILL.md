---
name: cache-and-storage
description: Cache rules for HTTP caching headers, storage backends, API keys for CI/CD, and user roles/permissions
---

# Cache Rules, Storage & API Keys

## Cache Rules

Docs: https://docs.bffless.app/configuration/cache-rules

Cache rules control HTTP caching headers per path pattern. Rules are evaluated by priority (higher number = evaluated first).

### MCP: Create cache rule

```
create_cache_rule(
  projectId: "uuid",
  pathPattern: "*.js",              // glob pattern
  name: "JavaScript assets",       // optional display name
  description: "Cache JS files",   // optional
  browserMaxAge: 3600,              // Cache-Control max-age (seconds)
  cdnMaxAge: 86400,                 // s-maxage for CDN (seconds)
  staleWhileRevalidate: 600,        // stale-while-revalidate window
  immutable: false,                 // mark as immutable (infinite cache)
  isEnabled: true,
  priority: 10                      // higher = evaluated first
)
```

### MCP: List cache rules

```
list_cache_rules(projectId: "uuid")
```

### MCP: Delete cache rule

```
delete_cache_rule(id: "uuid")
```

### Recommended patterns

| Pattern | browserMaxAge | cdnMaxAge | immutable | Use Case |
|---------|--------------|-----------|-----------|----------|
| `*.js` | 3600 | 86400 | false | Versioned JS bundles |
| `*.css` | 3600 | 86400 | false | Stylesheets |
| `*.png`, `*.jpg`, `*.webp` | 86400 | 604800 | false | Images |
| `index.html` | 300 | 300 | false | HTML entry point (changes often) |
| `assets/*` | 31536000 | 31536000 | true | Hashed/fingerprinted assets |

---

## Storage Backends

Docs: https://docs.bffless.app/configuration/storage

BFFLESS supports multiple storage backends for uploaded files:

| Backend | Use Case |
|---------|----------|
| **Local** | Development only |
| **MinIO** | Self-hosted S3-compatible |
| **AWS S3** | Amazon S3 |
| **Google Cloud Storage** | GCS (S3 compatibility mode) |
| **Azure Blob Storage** | Azure |

Storage key format: `{owner}/{repo}/{commitSha}/{path/to/file}`

Configured via `STORAGE_TYPE` environment variable. Credentials are encrypted at rest with AES-256.

---

## API Keys

Docs: https://docs.bffless.app/reference/security

API keys authenticate CI/CD pipelines and programmatic access.

### Types

- **Project-scoped** - Only works for a specific repository (`owner/repo`)
- **Global** - Works across all projects (admin only)

### MCP: Create API key

```
create_api_key(
  name: "GitHub Actions CI",
  repository: "owner/repo",        // omit for global key
  isGlobal: false,                  // true for global (admin only)
  expiresAt: "2027-01-01T00:00:00Z" // optional expiration
)
```

Returns the raw key **only once** at creation. Store it securely (e.g., GitHub Actions secret).

### MCP: List API keys

```
list_api_keys(page?: 1, limit?: 20)
```

Returns key metadata (name, repository, lastUsedAt, expiresAt) but NOT the raw key.

### MCP: Delete API key

```
delete_api_key(id: "uuid")
```

### Usage

API keys are passed via the `X-API-Key` header:
```
curl -H "X-API-Key: bff_xxxxxxxxxxxx" https://admin.yourdomain.com/api/...
```

---

## Users & Roles

### Global roles

| Role | Access |
|------|--------|
| `admin` | Full system access, manage users, global API keys |
| `user` | Create/manage own projects |
| `member` | Access only granted projects (default for new users) |

### Project roles

| Role | Access |
|------|--------|
| `owner` | Full control, delete/transfer project |
| `admin` | Manage permissions, full CRUD |
| `contributor` | Create deployments, upload assets |
| `viewer` | Read-only access |

### MCP: List users

```
list_users(search?: "email@", role?: "admin", sortBy?: "createdAt", sortOrder?: "desc", page?: 1, limit?: 20)
```

### MCP: Update user role

```
update_user_role(id: "user-uuid", role: "admin")   // "admin" | "user"
```