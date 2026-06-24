#!/usr/bin/env bash
# Copilot Portal container entrypoint.
#
# Unlike start-portal.sh (which bootstraps a bare-metal machine: detect Node,
# npm install, interactive login), this only handles *runtime* concerns. All
# heavy setup (deps, patch.mjs, pwsh, build) is already baked into the image.
set -e

echo "  Copilot Portal — container mode"

# Apply a umask if requested (e.g. UMASK=002 makes files the container writes
# into /work group-writable, so an SMB read-write group can edit/delete them).
if [ -n "${UMASK:-}" ]; then
  umask "${UMASK}"
  echo "  umask set to ${UMASK}"
fi

# --- Writable-volume check (fail fast with a clear message) ---
# The container runs as a non-root user (default 568). A volume first created by
# an OLDER root container is owned by root, so this user can't write it and the
# CLI dies with a cryptic "I/O error: Permission denied (os error 13)". Detect
# that here and explain the one-time host-side fix instead of crash-looping.
UID_NOW="$(id -u)"; GID_NOW="$(id -g)"
for d in "${HOME}/.copilot" "/app/data" "${PORTAL_WORKSPACE_DIR:-/work}"; do
  if [ -d "$d" ] && [ ! -w "$d" ]; then
    echo
    echo "  ERROR: '$d' is not writable by this user (${UID_NOW}:${GID_NOW})."
    echo "  This usually means the volume was created by an older root container."
    echo "  Fix it once from the Docker host, then start again, e.g.:"
    echo "    docker compose down"
    echo "    docker run --rm -v <project>_copilot-config:/c -v <project>_portal-data:/d \\"
    echo "      alpine chown -R ${UID_NOW}:${GID_NOW} /c /d"
    echo "    docker compose up -d"
    echo
    exit 1
  fi
done

# --- GitHub auth check (warn only; do not block) ---
# Two supported paths:
#   1. A token in the environment (simplest for containers).
#   2. A pre-authenticated ~/.copilot directory mounted as a volume.
HAS_TOKEN=0
if [ -n "${GITHUB_TOKEN:-}" ] || [ -n "${GITHUB_COPILOT_GITHUB_TOKEN:-}" ] || [ -n "${COPILOT_GITHUB_TOKEN:-}" ]; then
  HAS_TOKEN=1
fi

HAS_CREDS=0
if [ -f "${HOME}/.copilot/config.json" ]; then
  HAS_CREDS=1
fi

if [ "$HAS_TOKEN" = "0" ] && [ "$HAS_CREDS" = "0" ]; then
  echo
  echo "  WARNING: no GitHub authentication detected."
  echo "  Provide one of:"
  echo "    - a token via the GITHUB_TOKEN environment variable, or"
  echo "    - a pre-authenticated ~/.copilot mounted at ${HOME}/.copilot"
  echo "      (run 'copilot login' once elsewhere, or:"
  echo "       docker exec -it copilot-portal copilot login)"
  echo
fi

# Hand off to the launcher (which starts the CLI server + portal). exec so the
# launcher becomes the container's main process and receives SIGTERM directly.
exec node dist/launcher.js "$@"
