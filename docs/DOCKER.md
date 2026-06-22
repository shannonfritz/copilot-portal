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
| `copilot-config` | `/root/.copilot` | **Auth, sessions, skills, agents, MCP config** — the important one |
| `portal-data` | `/app/data` | Portal access token, tunnel config, debug logs |
| *(your choice)* | e.g. `/work` | The directories you want Copilot to be able to read/edit |

Mount the folders you want Copilot to operate on, or it only sees its own scratch
space. Example in `docker-compose.yml`:

```yaml
    volumes:
      - copilot-config:/root/.copilot
      - portal-data:/app/data
      - /mnt/tank/projects:/work
```

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
- **The terminal Console keys** (`[u]`, `[t]`, `[r]`, …) require a TTY and are
  inactive in a detached container. Native equivalents: `docker logs` (event log),
  `docker restart` (restart), rebuild/pull (update), `docker stop` (quit).

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
