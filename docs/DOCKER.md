# Running Copilot Portal in a Container

> **Status: experimental.** This runs the portal web UI together with the GitHub
> Copilot CLI (as a local subprocess) inside a single Docker container — handy for
> always-on, headless hosts like **TrueNAS SCALE**, Synology, or any Docker engine.
>
> Native `npm start` on Windows/macOS/Linux is unaffected by any of this. The
> container behavior is opt-in via the `COPILOT_CONTAINER` flag.

## What's in the image

A single container that, on start, launches `copilot --server` on an internal
port and the portal web server on **3847**. It includes:

- **Node 22** (base image)
- **PowerShell 7** (`pwsh`) — the Copilot CLI uses it to run shell-command tools
- The built portal (`dist/`) and the **patched** `node_modules` (the `patch.mjs`
  SDK fix is applied at build time)

It also:

- **Runs as a non-root user** (`568:568` by default — TrueNAS SCALE's `apps`
  user) so files it writes to mounted datasets are owned sensibly. Override with
  `--build-arg PUID=… --build-arg PGID=…` at build, or `user: "uid:gid"` at run.
- **Exposes a health probe** at `GET /healthz` (unauthenticated, no secrets), wired
  to a Docker `HEALTHCHECK` so the engine/TrueNAS report real readiness.
- **Auto-creates a fresh per-session workspace** (`/work/YYMMDD-NN`) for each new
  session — see `PORTAL_WORKSPACE_DIR` below.

## Authentication

The CLI is interactive to log in (`copilot login` opens a browser), which a
headless container can't do. Two supported paths — you can use either or both:

### 1. Token (simplest)

Set a GitHub token with Copilot access in the environment. The CLI reads, in
order: `GITHUB_COPILOT_GITHUB_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`.

```bash
echo "GITHUB_TOKEN=ghp_xxxxxxxx" > .env   # next to docker-compose.yml
```

### 2. Mounted, pre-authenticated `~/.copilot`

Authenticate once (on a desktop, or via `docker exec -it copilot-portal copilot
login` using the device-code flow), and the cached credentials in the persisted
`~/.copilot` volume survive restarts and rebuilds.

> The portal also has its **own** access token (printed in the logs / shown in the
> QR code) that gates who can open the web UI. That is separate from GitHub auth.

## Volumes (persist these)

| Volume | Container path | Holds |
| --- | --- | --- |
| `copilot-config` | `/home/copilot/.copilot` | **Auth, sessions, skills, agents, MCP config** — the important one |
| `portal-data` | `/app/data` | Portal access token, tunnel config, debug logs |
| `work-data` *(or a bind mount)* | `/work` | Per-session workspaces Copilot reads/edits |

Mount the folders you want Copilot to operate on, or it only sees its own scratch
space. Example in `docker-compose.yml`:

```yaml
    volumes:
      - copilot-config:/home/copilot/.copilot
      - portal-data:/app/data
      - /mnt/tank/apps/copilot-work:/work   # bind mount for LAN/SMB access
```

> **File ownership:** the container writes as `568:568` by default. Named volumes
> get this ownership automatically. For a **bind mount** (e.g. an SMB-shared
> dataset), make sure the host directory is owned by — or group-writable to —
> `568`, or set `user:` in compose to match your host account.

> **Upgrading from a pre-`568` (root-era) image:** volumes created when the
> container ran as root are owned by `root` and the non-root user can't write them
> — the CLI fails with `Permission denied (os error 13)` and the entrypoint stops
> with a clear message. Fix it once from the host:
>
> ```bash
> docker compose down
> docker run --rm -v <project>_copilot-config:/c -v <project>_portal-data:/d \
>   alpine chown -R 568:568 /c /d
> docker compose up -d
> ```
> (`<project>` is the compose project name — usually the folder name. Check with
> `docker volume ls`.)

## Environment variables (config contract)

All optional unless noted. Defaults are baked into the image; the compose file
sets the common ones explicitly for visibility.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | *(empty)* | GitHub token with Copilot access (auth path #1). Also read: `GITHUB_COPILOT_GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`. |
| `PORTAL_WORKSPACE_DIR` | `/work` | Root under which new sessions auto-create `YYMMDD-NN` workspace folders. |
| `UMASK` | `002` | umask for files written into `/work`. `002` = group-writable (`664`/`775`) for an SMB read-write group. |
| `TZ` | `UTC` | Local timezone for log and workspace-folder timestamps (e.g. `America/Chicago`). |
| `COPILOT_CONTAINER` | `1` | Container mode: disables the in-app self-updater and apply endpoints. |
| `COPILOT_AUTO_UPDATE` | `0` | Stops the CLI layer from self-updating (image-managed instead). |
| `PUID` / `PGID` | `568` / `568` | **Build args** (not runtime env) for the non-root uid/gid. Use `user:` in compose to override at runtime. |

## Quick start (any Docker host)

```bash
echo "GITHUB_TOKEN=ghp_xxxxxxxx" > .env
docker compose up -d --build
docker compose logs -f copilot-portal      # grab the login URL/token
# open http://<host>:3847
```

## TrueNAS SCALE

TrueNAS SCALE (Electric Eel 24.10+) runs Docker Compose. Two ways to get the
image onto the box **without publishing it anywhere public**:

**Option A — build on the NAS**
1. Copy this repo to the NAS (git clone or a file share).
2. In **Apps → Discover → Custom App** (or via the CLI), use the compose file in
   this repo. It builds the image locally on first `up`.

**Option B — build elsewhere, ship a tarball** (the "zip equivalent" for Docker)
```bash
# on a build machine (x86_64):
docker build -t copilot-portal:dev .
docker save copilot-portal:dev -o copilot-portal.tar
# copy copilot-portal.tar to the NAS, then on the NAS:
docker load -i copilot-portal.tar
```
Then deploy a Custom App that references the local `copilot-portal:dev` image and
the volumes/ports above. No registry, nothing public.

> TrueNAS SCALE is x86_64. Build the image on an x86_64 host (the CLI ships
> platform-specific binaries selected at `npm ci` time).

## Updates

The container is immutable, so the in-app self-updater is **disabled**
(`COPILOT_CONTAINER=1`). Update by replacing the image:

```bash
git pull                       # get the new portal + pinned CLI/SDK versions
docker compose up -d --build   # rebuild + recreate; volumes carry over
```

Your `~/.copilot` (auth, sessions, skills) and `portal-data` persist across the
swap. Both the portal and the bundled `@github/copilot` CLI update together at
build time.

## What changes in container mode

- **In-app update banners/buttons are suppressed** — `/api/updates/apply*` return a
  "managed by the image" message instead of mutating the container.
- **Runs non-root** (`568:568`) — see the file-ownership note under Volumes.
- **Health probe** — `GET /healthz` backs a Docker `HEALTHCHECK`; orchestrators show
  the container as healthy once the HTTP server is answering.
- **Graceful shutdown** — `init: true` (tini) runs as PID 1 to forward `SIGTERM` and
  reap the CLI subprocess on `docker stop`.
- **The terminal Console keys** (`[u]`, `[t]`, `[r]`, …) require a TTY and are
  inactive in a detached container. Native equivalents: `docker logs` (event log),
  the in-UI **Restart Portal / Restart Copilot** buttons, rebuild/pull (update),
  `docker stop` (quit).

## Caveats / open items

- **Token expiry/refresh** in a long-lived headless container — if a token expires,
  refresh the env value (or re-`copilot login` into the mounted `~/.copilot`).
- **Tunnel** (remote access) is untested in-container; LAN access works out of the
  box since the server binds `0.0.0.0`. Don't expose 3847 to the internet without a
  reverse proxy + real auth.
- **MCP servers** that themselves need binaries/tools must have those present in the
  image or be reachable from it.
- Single GitHub identity for everyone who can reach the portal — appropriate for a
  personal NAS.
