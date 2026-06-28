---
name: chat
description: Adding AI chat to a site with full page or popup widget layouts, skills, streaming, and message persistence
---

# Chat

**Docs**: https://docs.bffless.app/features/chat/

Add an AI-powered chat experience to any site — no backend code required. Choose between a full page chat interface or a popup widget, give your chatbot domain knowledge with skills, and let BFFless handle streaming, persistence, and deployment.

## Overview

BFFless Chat provides:

- **No backend code** — configure everything through the admin UI
- **Streaming responses** — real-time token-by-token output via Server-Sent Events
- **Skills** — domain-specific knowledge from markdown files deployed with your site
- **Message persistence** — conversations and messages saved automatically to DB Records
- **A/B testable** — combine with traffic splitting to test different skills or prompts
- **Two layouts** — full page chat or floating popup widget

## Quick Start

### 1. Generate a Chat Schema

1. Go to **Pipelines → DB Records**
2. Click **Generate Schema**
3. Select **Chat Schema**
4. Enter a name (e.g., `support`)
5. Choose a scope:
   - **User-scoped** — conversations tied to authenticated users
   - **Guest-scoped** — conversations accessible without authentication
6. Click **Generate**

This creates:
- A `{name}_conversations` DB Record for conversation metadata
- A `{name}_messages` DB Record for individual messages
- A pipeline with a `POST /api/chat` endpoint pre-configured with the AI handler

### 2. Configure an AI Provider

1. Navigate to **Settings → AI**
2. Select a provider (OpenAI, Anthropic, or Google AI)
3. Enter your API key
4. Choose a default model
5. Click **Test Connection** to verify
6. Save

### 3. Connect Your Frontend

Use the AI SDK's `useChat` hook:

```tsx
import { useChat } from '@ai-sdk/react';

function Chat() {
  const { messages, input, handleInputChange, handleSubmit, status } = useChat({
    api: '/api/chat',
  });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          <strong>{m.role}:</strong> {m.parts.map(p => p.text).join('')}
        </div>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} placeholder="Type a message..." />
        <button type="submit" disabled={status === 'streaming'}>Send</button>
      </form>
    </div>
  );
}
```

### 4. Deploy

Push your code to GitHub and deploy with the `bffless/upload-artifact` GitHub Action. Your chat endpoint is live as soon as the deployment completes.

## Chat Layouts

### Full Page Chat

A standalone chat page that takes over the full viewport. Includes suggested prompts, real-time streaming with markdown rendering, and a clean conversational UI.

Best for: dedicated support pages, knowledge base assistants, internal tools.

### Popup Widget

A floating chat bubble that opens a slide-up chat panel. Users can start a new conversation or close the widget without losing context. The widget stays accessible on any page.

Best for: landing pages, documentation sites, e-commerce — anywhere you want chat available without dedicating a full page.

## Skills

Skills are markdown files that give your chatbot domain-specific knowledge. Deploy them alongside your site and the AI loads relevant skills on-demand during conversations.

Skills are **versioned with each deployment** — when an alias points to a commit, the skills for that commit are used. This makes them git-managed, rollback-safe, and A/B testable with traffic splitting.

### Creating a Skill

Add a `SKILL.md` file to `.bffless/skills/<skill-name>/`:

```markdown
---
name: pricing-faq
description: Answer questions about pricing, plans, and billing
---

# Pricing FAQ

(Your knowledge content here in markdown)
```

### Deploying Skills

Upload skills alongside your build artifacts:

```yaml
- name: Deploy build
  uses: bffless/upload-artifact@v1
  with:
    source: dist

- name: Deploy skills
  uses: bffless/upload-artifact@v1
  with:
    source: .bffless
```

### Configuring Skills in Pipelines

Set the skills mode in the AI handler configuration:

| Mode | Description |
|------|-------------|
| **None** | Disable all skills (default) |
| **All** | Enable all uploaded skills |
| **Selected** | Enable only specific skills by name |

## Message Persistence

When enabled, conversations and messages are automatically saved to DB Records. The handler manages:

- **Conversations**: chat_id, message_count, total_tokens, model
- **Messages**: conversation_id, role, content, tokens_used

Message persistence is optional — for simple use cases, skip it entirely and chat works without any database configuration.

## Configuration

Key settings for the AI chat handler:

| Setting | Description | Options / Default |
|---------|-------------|-------------------|
| **Mode** | Chat or Completion | `chat`, `completion` |
| **Provider** | AI provider | `openai`, `anthropic`, `google` |
| **Model** | Specific model | Provider-dependent |
| **System Prompt** | Instructions for the AI | Free-text |
| **Response Format** | Stream or JSON | `stream`, `message` |
| **Skills Mode** | Which skills to enable | `none`, `all`, `selected` |
| **Temperature** | Response creativity | `0` – `2` (default: `0.7`) |
| **Max Tokens** | Maximum output length | `256` – `100000` (default: `4096`) |
| **Max History** | Messages in context | `0` – `200` (default: `50`) |

## Supported Providers

| Provider | Models | Default |
|----------|--------|---------|
| OpenAI | gpt-4o, gpt-4-turbo, gpt-4, gpt-4o-mini, gpt-3.5-turbo | gpt-4o |
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 | claude-sonnet-4-6 |
| Google AI | gemini-1.5-pro, gemini-1.5-flash, gemini-1.5-flash-8b | gemini-1.5-pro |

## Demo

- Full page chat: https://chat.docs.bffless.app/
- Popup widget: https://chat.docs.bffless.app/popup/
- Source code: https://github.com/bffless/demo-chat

## Troubleshooting

**Chat responses not streaming?**
- Verify response format is set to **Stream (SSE)**
- Ensure the AI handler is the **last step** in your pipeline
- Check frontend is using `useChat` from `@ai-sdk/react`

**Skills not loading?**
- Verify `.bffless/skills/` exists in your deployment
- Ensure skills mode is set to **All** or **Selected** (not None)
- Check each skill has valid `SKILL.md` with YAML frontmatter (name and description)

**Messages not persisting?**
- Ensure **Message Persistence** is enabled in the AI handler config
- Verify both Conversations Schema and Messages Schema are selected
