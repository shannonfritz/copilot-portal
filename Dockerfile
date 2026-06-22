# syntax=docker/dockerfile:1
#
# Copilot Portal — container image (experimental).
#
# Runs the portal web UI together with the GitHub Copilot CLI (as a local
# subprocess) in a single container. Designed for headless hosts such as
# TrueNAS SCALE, Synology, or any Docker engine.
#
# Auth: provide a GitHub token via the GITHUB_TOKEN env var, and/or mount a
# pre-authenticated ~/.copilot directory as a volume (see docs/DOCKER.md).

# ---- Stage 1: build (esbuild for the server + Vite for the web UI) ----
FROM node:22-bookworm AS builder
WORKDIR /app

# Install root deps first for better layer caching.
# The `postinstall` hook runs patch.mjs, which fixes a broken ESM import in
# @github/copilot-sdk — so the patched node_modules is produced here.
COPY package.json package-lock.json patch.mjs ./
RUN npm ci --no-fund --no-audit

# Install web UI deps (separate package.json).
COPY webui/package.json webui/package-lock.json ./webui/
RUN cd webui && npm ci --no-fund --no-audit

# Copy the rest of the source and build (produces dist/, including dist/webui).
COPY . .
RUN npm run build

# ---- Stage 2: runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# PowerShell 7 — the Copilot CLI uses `pwsh` to execute shell-command tools.
# Without it, command-running tools degrade. Pinned; bump as needed.
ARG PWSH_VERSION=7.4.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libicu72 \
 && curl -fsSL "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-x64.tar.gz" -o /tmp/pwsh.tar.gz \
 && mkdir -p /opt/microsoft/powershell/7 \
 && tar zxf /tmp/pwsh.tar.gz -C /opt/microsoft/powershell/7 \
 && chmod +x /opt/microsoft/powershell/7/pwsh \
 && ln -s /opt/microsoft/powershell/7/pwsh /usr/bin/pwsh \
 && rm /tmp/pwsh.tar.gz \
 && apt-get purge -y --auto-remove curl \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Bring over the built app and the patched node_modules from the builder.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/BUILD ./BUILD
COPY --from=builder /app/bin ./bin

# Entrypoint (strip any CRLS so it runs on Linux regardless of host checkout).
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

# Container-mode behavior:
#  - COPILOT_CONTAINER=1 disables the portal's in-app self-updater (updates come
#    from rebuilding/pulling the image, not from mutating this running container).
#  - COPILOT_AUTO_UPDATE=0 stops the CLI layer from self-updating too.
ENV COPILOT_CONTAINER=1 \
    COPILOT_AUTO_UPDATE=0 \
    NODE_ENV=production \
    PATH="/app/node_modules/.bin:${PATH}"

EXPOSE 3847
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
