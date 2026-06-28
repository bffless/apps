---
name: bffless
description: Knowledge about BFFless platform, features, and setup
---

# BFFless Platform Guide

BFFless is a self-hosted static asset hosting platform designed for modern frontend deployments. It provides a Backend-for-Frontend (BFF) layer without requiring you to write backend code.

## What is BFFless?

BFFless is a platform that:

- **Hosts static assets** from your CI/CD pipeline (React, Vue, Angular, etc.)
- **Provides AI-powered pipelines** for backend automation without writing code
- **Manages deployments** with aliases like `production`, `staging`, `preview`
- **Handles custom domains** with automatic SSL via Let's Encrypt
- **Enables traffic splitting** for A/B testing and canary deployments
- **Offers proxy rules** to forward requests to backend APIs

### Key Concepts

| Concept        | Description                                                     |
| -------------- | --------------------------------------------------------------- |
| **Deployment** | A snapshot of your build artifacts at a specific commit SHA     |
| **Alias**      | A named pointer to a deployment (e.g., `production` → `abc123`) |
| **Proxy Rule** | Routes requests to external APIs or AI pipelines                |
| **Pipeline**   | Chain of handlers that process requests (AI, transform, proxy)  |
| **Skill**      | Markdown files that give AI agents specialized knowledge        |

## Setting Up Proxy Rules

Proxy rules let you route requests through BFFless to backend APIs or AI pipelines.

### Creating a Proxy Rule

1. Go to **Project Settings** → **Proxy Rules**
2. Click **Add Rule**
3. Configure the rule:

```
Path Pattern: /api/*
Target URL: https://your-backend.com
Strip Prefix: true (removes /api from forwarded requests)
```

### Rule Types

| Type                 | Use Case                                 |
| -------------------- | ---------------------------------------- |
| **External Proxy**   | Forward to external APIs (REST, GraphQL) |
| **Pipeline**         | Process with AI handlers                 |
| **Internal Rewrite** | Serve different static files             |

### Common Patterns

**API Gateway:**

```
/api/* → https://api.example.com/*
```

**AI Chat Endpoint:**

```
/api/chat → Pipeline with AI handler
```

**Microservices:**

```
/api/users/* → https://users-service.internal
/api/orders/* → https://orders-service.internal
```

## Traffic Splitting

Traffic splitting distributes requests across multiple deployment aliases for A/B testing or gradual rollouts.

### How It Works

1. Configure weights per alias (e.g., 90% production, 10% canary)
2. First-time visitors get randomly assigned based on weights
3. A cookie (`__bffless_variant`) maintains sticky sessions
4. Users see consistent experience on return visits

### Setting Up Traffic Splitting

1. Go to **Domains** → Select your domain
2. Click **Traffic Splitting**
3. Add aliases with weights:

| Alias      | Weight |
| ---------- | ------ |
| production | 90%    |
| canary     | 10%    |

4. Save changes

### Use Cases

- **A/B Testing**: Compare two versions of your app
- **Canary Deployments**: Gradually roll out new features
- **Blue/Green**: Instant switch between deployments
- **Feature Flags**: Route specific traffic to experimental builds

### Best Practices

- Start with small percentages for new deployments (5-10%)
- Monitor error rates before increasing traffic
- Use the `X-Variant` header to track which variant served the request
- Cookie duration is configurable (default: 24 hours)

## Pipelines and AI Handlers

Pipelines let you create backend logic without writing code.

### Pipeline Structure

A pipeline is a chain of steps:

```
Request → Step 1 → Step 2 → Step 3 → Response
```

### AI Handler

The AI handler uses LLMs to process requests:

- Configure system prompts
- Set model and temperature
- Enable skills for specialized knowledge
- Stream responses for chat interfaces

### Example: Chat API

1. Create a pipeline with an AI handler
2. Configure:
   - Model: `gpt-4` or `claude-3`
   - System Prompt: Your assistant instructions
   - Skills: Enable relevant skills
3. Create a proxy rule pointing to the pipeline
4. Your frontend calls `/api/chat` and gets AI responses

## GitHub Action Integration

Upload builds automatically from CI/CD:

```yaml
- uses: bffless/upload-artifact@v1
  with:
    path: dist
    api-url: ${{ vars.BFFLESS_URL }}
    api-key: ${{ secrets.BFFLESS_KEY }}
    alias: production
```

This uploads your build and updates the `production` alias to point to it.
