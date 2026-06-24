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

# --- Enable plaintext token storage (no system keychain in a container) ---
# The Copilot CLI tries the OS keychain first; when absent it asks an interactive
# y/N question to fall back to a plaintext config file. That prompt needs a TTY,
# which a headless container/web sign-in doesn't have, so `copilot login` would
# otherwise authenticate but fail to PERSIST the token ("token was not saved").
# Setting storeTokenPlaintext:true in settings.json makes the CLI store (and read)
# the token from ~/.copilot directly — no keychain, no prompt. The token still
# lives only in the mounted ~/.copilot volume.
node -e '
  const fs = require("fs"), path = require("path");
  const p = path.join(process.env.HOME, ".copilot", "settings.json");
  let s = {};
  try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  if (s.storeTokenPlaintext !== true) {
    s.storeTokenPlaintext = true;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
    console.log("  enabled plaintext token storage (no keychain in container)");
  }
' || echo "  WARNING: could not set storeTokenPlaintext — browser sign-in may not persist"

# --- GitHub auth check (warn only; do not block) ---
# Three supported paths:
#   1. A token in the environment (simplest for containers).
#   2. A pre-authenticated ~/.copilot directory mounted as a volume.
#   3. Sign in from the web UI on first run (device-code flow).
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
  echo "  No GitHub authentication detected yet — sign in from the web UI when it"
  echo "  loads, or provide one of:"
  echo "    - a token via the GITHUB_TOKEN environment variable, or"
  echo "    - a pre-authenticated ~/.copilot mounted at ${HOME}/.copilot"
  echo
fi

# Hand off to the launcher (which starts the CLI server + portal). exec so the
# launcher becomes the container's main process and receives SIGTERM directly.
exec node dist/launcher.js "$@"
