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

# Non-root runtime user. Defaults to 568:568 — TrueNAS SCALE's "apps" user — so
# files written to bind-mounted datasets (e.g. /work shared over SMB) are owned
# correctly out of the box. Override at build time for other hosts:
#   docker build --build-arg PUID=1000 --build-arg PGID=1000 .
# or at run time with `user: "1000:1000"` in docker-compose.yml.
ARG PUID=568
ARG PGID=568

# PowerShell 7 — the Copilot CLI uses `pwsh` to execute shell-command tools.
# Without it, command-running tools degrade. Pinned; bump as needed.
# Runtime tools kept in the final image:
#  - curl: used to fetch PowerShell during build, and kept because Copilot's
#    command-running tools commonly reach for it at runtime (and the HEALTHCHECK).
#  - lsof: used by the "Restart Copilot" control to free port 3848 before
#    relaunching the CLI server — without it that restart can't reclaim the port.
#  - tzdata: lets TZ env set the container's local time (log + folder timestamps).
ARG PWSH_VERSION=7.4.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libicu72 lsof tzdata \
 && curl -fsSL "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-x64.tar.gz" -o /tmp/pwsh.tar.gz \
 && mkdir -p /opt/microsoft/powershell/7 \
 && tar zxf /tmp/pwsh.tar.gz -C /opt/microsoft/powershell/7 \
 && chmod +x /opt/microsoft/powershell/7/pwsh \
 && ln -s /opt/microsoft/powershell/7/pwsh /usr/bin/pwsh \
 && rm /tmp/pwsh.tar.gz \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create the non-root user/group and the directories that volumes mount onto,
# owned by it. Docker initializes a fresh named volume with the ownership of the
# image dir it covers, so the default volumes are writable without any chown dance.
RUN groupadd -g "${PGID}" copilot \
 && useradd -u "${PUID}" -g "${PGID}" -m -d /home/copilot -s /usr/sbin/nologin copilot \
 && mkdir -p /home/copilot/.copilot /app/data /work \
 && chown -R copilot:copilot /home/copilot /app /work

# Bring over the built app and the patched node_modules from the builder.
COPY --from=builder --chown=copilot:copilot /app/dist ./dist
COPY --from=builder --chown=copilot:copilot /app/node_modules ./node_modules
COPY --from=builder --chown=copilot:copilot /app/package.json ./package.json
COPY --from=builder --chown=copilot:copilot /app/BUILD ./BUILD
COPY --from=builder --chown=copilot:copilot /app/bin ./bin

# Entrypoint (strip any CRLs so it runs on Linux regardless of host checkout).
# Use an absolute chmod mode (0755) — `chmod +x` is masked by the build host's
# umask, which on some hosts leaves the file non-readable/-executable for the
# non-root runtime user (exit 126: Permission denied).
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod 0755 /usr/local/bin/docker-entrypoint.sh

# Container-mode behavior:
#  - COPILOT_CONTAINER=1 disables the portal's in-app self-updater (updates come
#    from rebuilding/pulling the image, not from mutating this running container).
#  - COPILOT_AUTO_UPDATE=0 stops the CLI layer from self-updating too.
#  - HOME points at the non-root user's home so ~/.copilot resolves there.
ENV COPILOT_CONTAINER=1 \
    COPILOT_AUTO_UPDATE=0 \
    NODE_ENV=production \
    HOME=/home/copilot \
    PATH="/app/node_modules/.bin:${PATH}"

EXPOSE 3847

# Mark the container healthy once the HTTP server answers the unauthenticated
# /healthz probe. Gives Docker/TrueNAS a real readiness signal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://localhost:3847/healthz" > /dev/null || exit 1

USER ${PUID}:${PGID}
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
