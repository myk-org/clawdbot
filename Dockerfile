FROM node:22-bookworm

# Install Bun (required for build scripts) - install to /usr/local for all users
ENV BUN_INSTALL="/usr/local"
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/usr/local/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
  fi

# Install Homebrew dependencies and GitHub CLI (gh)
RUN apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  build-essential \
  procps \
  file \
  git \
  sudo \
  curl \
  gpg && \
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Install Docker CLI (not the full engine, just the CLI for docker-in-docker scenarios)
RUN curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg && \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker-ce-cli && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Create linuxbrew user for Homebrew installation
RUN useradd -m -s /bin/bash linuxbrew && \
  echo 'linuxbrew ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Install Homebrew as linuxbrew user
USER linuxbrew
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
USER root

# Add Homebrew to PATH
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV HOMEBREW_NO_AUTO_UPDATE=1

# Give node user access to Homebrew for brew tap/install operations
RUN usermod -aG linuxbrew node && \
  chmod -R g+w /home/linuxbrew/.linuxbrew

# Install wacli (WhatsApp CLI) via Homebrew
USER linuxbrew
RUN brew tap steipete/tap && \
  brew install steipete/tap/wacli
USER root

# Install uv (Python package manager) - install to /usr/local/bin for all users
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

# Install clawdhub globally via npm
RUN npm i -g clawdhub && \
  cd /usr/local/lib/node_modules/clawdhub && npm install undici

# Install Go
RUN curl -LO https://go.dev/dl/go1.23.4.linux-amd64.tar.gz && \
  tar -C /usr/local -xzf go1.23.4.linux-amd64.tar.gz && \
  rm go1.23.4.linux-amd64.tar.gz
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH="/home/node/go"
ENV PATH="${GOPATH}/bin:${PATH}"

# Install gogcli (GOG.com CLI)
# RUN curl -sL "https://github.com/steipete/gogcli/releases/download/v0.9.0/gogcli_0.9.0_linux_amd64.tar.gz" | tar -xz -C /usr/local/bin gog

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Give node user ownership of global npm directories so they can install packages
# This enables npm i -g as the node user without requiring root privileges
RUN chown -R node:node /usr/local/lib/node_modules /usr/local/bin


# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/node/.local/bin:${PATH}"

# Copy entrypoint script (runs as root to handle docker socket GID, then drops to node user)
USER root
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN ln -s /app/openclaw.mjs /usr/local/bin/openclaw && \
  chmod +x /app/openclaw.mjs

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
