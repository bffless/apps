FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack (this is a pnpm workspace — `bffless-apps`).
# `corepack enable` runs as root so the shims land in /usr/local/bin. The actual
# pnpm download (`corepack prepare`) happens later AS THE agent USER, so it's
# cached in /home/agent — otherwise the runtime user can't see a root-owned cache
# and would try to re-download on first `pnpm` call (which fails non-interactively).
RUN corepack enable
# Never block on corepack's "about to download" prompt in non-interactive runs.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Bake pnpm 10.33.0 into the agent user's corepack cache (matches the repo's
# packageManager field). Runs as `agent` so the cache lives in /home/agent and is
# used at runtime with no download — fixes the onSandboxReady `pnpm install` step.
RUN corepack prepare pnpm@10.33.0 --activate

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
