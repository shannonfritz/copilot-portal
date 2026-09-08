/**
 * Launcher with CLI server management and restart support.
 *
 * Default (connected mode):
 *   1. Check if CLI server is already listening on port 3848
 *   2. If not, launch `copilot --server --port 3848` as a background process
 *   3. Wait for port 3848 to accept connections
 *   4. Start portal server with --cli-url localhost:3848
 *
 * Standalone mode (--standalone):
 *   Starts portal server without CLI — spawns its own CLI subprocess.
 *
 * Restart support:
 *   Exit code 75 triggers a relaunch of the portal server.
 */
import { spawn, spawnSync, exec, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliNodeOptions, cliSpawnEnv, cliHeapMb, containerMemoryLimitMb } from './cli-env.js';

function log(msg: string): void {
	const now = new Date();
	const h = now.getHours(); const m = now.getMinutes(); const s = now.getSeconds();
	const ampm = h >= 12 ? 'PM' : 'AM';
	const hh = String(h > 12 ? h - 12 : h || 12).padStart(2, '0');
	const ts = `${hh}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ampm}`;
	console.log(`[${ts}] ${msg}`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(__dirname, 'server.js');
const args = process.argv.slice(2);

const RESTART_CODE = 75;
const REAUTH_CODE = 76;
const CLI_PORT = 3848;
const PROJECT_ROOT = path.join(__dirname, '..');
const DEPS_STAMP = path.join(PROJECT_ROOT, 'node_modules', '.portal-deps-version');

// True once we've spawned the portal server at least once. Auto-launch of the
// browser should happen only on the very first start of the process tree, never
// on a launcher-driven relaunch (exit-75 restart, exit-76 sign-in/out, or a
// CLI-version restart) — in every relaunch case a browser tab is already open,
// so re-opening it just pops a duplicate. We signal this to the child via the
// PORTAL_NO_AUTOLAUNCH env var, which main.ts honors.
let serverStarted = false;

const standalone = args.includes('--standalone');
// Remove --standalone from args passed to server (it doesn't know about it)
const serverArgs = args.filter(a => a !== '--standalone');

// Tracks an access token WE injected from the portal's saved token file, so we
// can clear it on logout without ever touching an env var the host set itself.
let injectedAccessToken: string | null = null;
// The COPILOT_GITHUB_TOKEN the host provided (e.g. via docker-compose), captured
// once at startup before we ever inject a pasted token. On logout we restore this
// rather than leaving the container with no token at all.
const hostAccessToken: string | null = process.env.COPILOT_GITHUB_TOKEN ?? null;

/**
 * If the portal saved a pasted access token (data/gh-pat), inject it as
 * COPILOT_GITHUB_TOKEN so the CLI — spawned below and inheriting our env —
 * authenticates with it. Runs on boot and on every exit-76 restart, so a saved
 * token survives restarts. If the file was removed (logout), restore the host's
 * own token if it set one, otherwise clear the copy we injected.
 */
function loadStoredAccessToken(): void {
	try {
		const f = path.join(__dirname, '..', 'data', 'gh-pat');
		const tok = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
		if (tok) {
			process.env.COPILOT_GITHUB_TOKEN = tok;
			injectedAccessToken = tok;
			log('[Launcher] Using saved access token (COPILOT_GITHUB_TOKEN)');
		} else if (injectedAccessToken && process.env.COPILOT_GITHUB_TOKEN === injectedAccessToken) {
			injectedAccessToken = null;
			if (hostAccessToken) {
				process.env.COPILOT_GITHUB_TOKEN = hostAccessToken;
				log('[Launcher] Cleared saved access token — restored host-provided token');
			} else {
				delete process.env.COPILOT_GITHUB_TOKEN;
				log('[Launcher] Cleared saved access token');
			}
		}
	} catch { /* ignore */ }
}

function packageVersion(): string | null {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
		return typeof pkg.version === 'string' ? pkg.version : null;
	} catch {
		return null;
	}
}

function depsStampVersion(): string | null {
	try {
		return fs.readFileSync(DEPS_STAMP, 'utf8').trim() || null;
	} catch {
		return null;
	}
}

function runNpmInstallForLauncher(): void {
	log('[Launcher] Refreshing dependencies before server restart...');
	const flags = '--no-fund --no-audit --fetch-retries=0 --fetch-timeout=60000';
	try {
		execSync(`npm install ${flags}`, { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 10 * 60 * 1000 });
	} catch (e) {
		log(`[Launcher] Configured registry install failed; retrying against public npmjs... (${String(e).split('\n')[0]})`);
		execSync(`npm install ${flags} --registry=https://registry.npmjs.org/`, { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 10 * 60 * 1000 });
	}
	const ver = packageVersion();
	if (ver) {
		fs.writeFileSync(DEPS_STAMP, ver);
		log(`[Launcher] Stamped node_modules/.portal-deps-version = ${ver}`);
	}
}

/** In-app restart relaunches through this launcher, bypassing start-portal.cmd/sh.
 *  Reconcile dependencies here too so a self-update cannot boot new dist/ against
 *  old node_modules or leave the next manual start to do the real install.
 *
 *  Skipped in container mode: the image's node_modules is baked at build time by
 *  `npm ci`, so it is correct by construction and the app version can never drift
 *  from it. The runtime image also ships no package-lock.json or patch.mjs (the
 *  postinstall script), so an `npm install` there fails outright and would take
 *  the launcher down on boot. */
function ensureDependenciesCurrent(): void {
	if (process.env.COPILOT_CONTAINER === '1' || process.env.COPILOT_CONTAINER === 'true') return;
	const ver = packageVersion();
	if (!ver || !fs.existsSync(path.join(PROJECT_ROOT, 'node_modules'))) return;
	const stamped = depsStampVersion();
	if (stamped === ver) return;
	log(`[Launcher] Dependency stamp mismatch (built for "${stamped ?? 'unknown'}", package is "${ver}")`);
	try {
		runNpmInstallForLauncher();
	} catch (e) {
		// Never let a failed refresh prevent the portal from starting — a stale
		// node_modules usually still runs, and start-portal.cmd/sh will retry.
		log(`[Launcher] Dependency refresh failed, continuing with existing node_modules: ${String(e).split('\n')[0]}`);
	}
}

/** Check if a TCP port is accepting connections */
function isPortListening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = net.createConnection({ port, host: 'localhost' }, () => {
			sock.destroy();
			resolve(true);
		});
		sock.on('error', () => resolve(false));
		sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
	});
}

/** Wait for a port to start listening, with timeout */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await isPortListening(port)) return true;
		await new Promise(r => setTimeout(r, 500));
	}
	return false;
}

/** Launch the CLI as a headless JSON-RPC server. Returns true if launch was attempted. */
function launchCli(port: number): boolean {
	if (process.platform === 'win32') {
		// Resolve full path to copilot.exe so Start-Process can find it
		const which = spawnSync('where.exe', ['copilot.exe'], { stdio: 'pipe', windowsHide: true });
		if (which.status !== 0) {
			console.error(`[Launcher] copilot.exe not found on PATH.`);
			console.error(`[Launcher] Install GitHub Copilot CLI: winget install GitHub.CopilotCLI`);
			return false;
		}
		const copilotPath = which.stdout.toString().trim().split(/\r?\n/)[0];
		// Raise the CLI's V8 heap so large-session resume doesn't OOM (see cli-env.ts).
		// $env:NODE_OPTIONS is set inside the pwsh command so Start-Process's child
		// inherits it (Start-Process doesn't take our exec env reliably otherwise).
		exec(`pwsh -NoProfile -Command "$env:NODE_OPTIONS='${cliNodeOptions()}'; Start-Process -FilePath '${copilotPath}' -ArgumentList '--server','--port','${port}' -WindowStyle Hidden"`, { windowsHide: true },
			(err) => {
				if (err) {
					console.error(`[Launcher] Failed to launch CLI: ${err.message}`);
					cliLaunched = false;
				}
			});
	} else {
		const child = spawn('copilot', ['--server', '--port', String(port)], {
			stdio: 'ignore',
			detached: true,
			env: cliSpawnEnv(),
		});
		child.on('error', (err) => {
			console.error(`[Launcher] Failed to spawn copilot: ${err.message}`);
			console.error(`[Launcher] Install GitHub Copilot CLI: https://docs.github.com/copilot/how-tos/copilot-cli`);
			cliLaunched = false;
		});
		cliPid = child.pid ?? null;
		child.unref();
	}
	cliLaunched = true;
	log(`[Launcher] CLI server started (heap ${cliHeapMb()}MB${containerMemoryLimitMb() !== null ? `, container limit ${containerMemoryLimitMb()}MB` : ''})`);
	return true;
}

let cliLaunched = false;
let cliStartVersion: string | null = null;
let cliPid: number | null = null;

/** Capture the current on-disk CLI version */
function captureCliVersion(): void {
	try {
		const pkgPath = path.join(__dirname, '..', 'node_modules', '@github', 'copilot', 'package.json');
		cliStartVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version ?? null;
	} catch { cliStartVersion = null; }
}

/** Stop the CLI server process if we launched it */
function stopCli(): void {
	if (!cliLaunched) return;
	stopCliWatchdog();
	cliLaunched = false;
	log(`[Launcher] Stopping CLI server...`);
	try {
		if (process.platform === 'win32') {
			// spawnSync so it works in 'exit' handler (synchronous only)
			spawnSync('pwsh', ['-NoProfile', '-Command',
				`Get-NetTCPConnection -LocalPort ${CLI_PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`
			], { stdio: 'ignore', windowsHide: true });
		} else if (cliPid) {
			// Kill the detached CLI we spawned (and its group) so it doesn't
			// linger when the launcher shuts down (e.g. SIGTERM from `docker stop`).
			try { process.kill(cliPid, 'SIGTERM'); } catch { /* already gone */ }
		}
	} catch { /* already dead */ }
}

/**
 * Watchdog: keep the CLI server alive.
 *
 * The CLI is a separate process. If it dies mid-run — most commonly killed by
 * the kernel/cgroup while resuming a very large session in a memory-capped
 * container — nothing used to bring it back. The portal stayed up and every
 * client looped forever on "CLI server not available after 15s", because the
 * pool only ever *waits* for port 3848; it never relaunches the process behind
 * it. This closes that gap.
 */
const CLI_WATCHDOG_INTERVAL_MS = 10_000;
const CLI_WATCHDOG_MAX_BACKOFF_MS = 60_000;
let cliWatchdogTimer: NodeJS.Timeout | null = null;
let cliWatchdogMisses = 0;
let cliRelaunchFailures = 0;
let cliRelaunchBlockedUntil = 0;

function startCliWatchdog(): void {
	if (cliWatchdogTimer) return;
	cliWatchdogMisses = 0;
	cliRelaunchFailures = 0;
	cliRelaunchBlockedUntil = 0;
	cliWatchdogTimer = setInterval(() => { void checkCliAlive(); }, CLI_WATCHDOG_INTERVAL_MS);
	cliWatchdogTimer.unref?.();
}

function stopCliWatchdog(): void {
	if (!cliWatchdogTimer) return;
	clearInterval(cliWatchdogTimer);
	cliWatchdogTimer = null;
}

async function checkCliAlive(): Promise<void> {
	if (!cliLaunched) return;
	if (await isPortListening(CLI_PORT)) {
		if (cliWatchdogMisses > 0) log(`[Launcher] CLI server healthy again`);
		cliWatchdogMisses = 0;
		cliRelaunchFailures = 0;
		return;
	}
	// Require two consecutive misses so a deliberate CLI restart (e.g. the
	// portal's /api/restart-cli, which briefly closes the port) isn't treated
	// as a crash and double-launched.
	cliWatchdogMisses++;
	if (cliWatchdogMisses < 2) return;
	if (Date.now() < cliRelaunchBlockedUntil) return;

	log(`[Launcher] CLI server is gone (port ${CLI_PORT} closed) — relaunching...`);
	cliLaunched = false;
	if (!launchCli(CLI_PORT)) {
		cliRelaunchFailures++;
		cliRelaunchBlockedUntil = Date.now() + relaunchBackoffMs();
		log(`[Launcher] CLI relaunch failed (attempt ${cliRelaunchFailures}) — retrying in ${Math.round(relaunchBackoffMs() / 1000)}s`);
		return;
	}
	const ready = await waitForPort(CLI_PORT, 30000);
	if (ready) {
		log(`[Launcher] CLI server recovered`);
		cliWatchdogMisses = 0;
		cliRelaunchFailures = 0;
		cliRelaunchBlockedUntil = 0;
		captureCliVersion();
	} else {
		cliRelaunchFailures++;
		cliRelaunchBlockedUntil = Date.now() + relaunchBackoffMs();
		log(`[Launcher] CLI server did not come back within 30s (attempt ${cliRelaunchFailures}) — retrying in ${Math.round(relaunchBackoffMs() / 1000)}s`);
	}
}

function relaunchBackoffMs(): number {
	const n = Math.max(1, cliRelaunchFailures);
	return Math.min(CLI_WATCHDOG_MAX_BACKOFF_MS, 5000 * 2 ** (n - 1));
}

async function start() {
	// Set terminal tab title
	process.stdout.write('\x1b]0;Copilot Portal\x07');

	ensureDependenciesCurrent();

	// Pick up a portal-saved access token before spawning the CLI (which inherits
	// our env). Runs on boot and on every restart, so it survives exit-76 cycles.
	loadStoredAccessToken();

	let cliUrl: string | undefined;

	if (!standalone) {
		// Check if --cli-url was explicitly provided
		const cliUrlIdx = serverArgs.indexOf('--cli-url');
		if (cliUrlIdx !== -1 && cliUrlIdx + 1 < serverArgs.length) {
			cliUrl = serverArgs[cliUrlIdx + 1];
			log(`[Launcher] Using provided CLI server: ${cliUrl}`);
		} else {
			// Auto-detect or launch CLI server
			const alreadyRunning = await isPortListening(CLI_PORT);
			if (alreadyRunning) {
				log(`[Launcher] CLI server detected on port ${CLI_PORT}`);
			} else {
				log(`[Launcher] Starting CLI server (port ${CLI_PORT})...`);
				const launched = launchCli(CLI_PORT);
				if (launched) {
					const ready = await waitForPort(CLI_PORT, 30000);
					if (!ready) {
						log(`[Launcher] CLI server did not start within 30s — falling back to standalone mode`);
					}
				} else {
					log(`[Launcher] Falling back to standalone mode`);
				}
			}
			if (await isPortListening(CLI_PORT)) {
				cliUrl = `localhost:${CLI_PORT}`;
			}
		}
	}

	if (cliUrl) {
		log(`[Launcher] Connecting to CLI server at ${cliUrl}`);
		captureCliVersion();
		if (cliLaunched) startCliWatchdog();
	} else {
		log(`[Launcher] Standalone mode — spawning own CLI subprocess`);
	}

	launch(cliUrl);
}

function launch(cliUrl?: string) {
	const extraArgs = cliUrl ? ['--cli-url', cliUrl] : [];
	// Suppress browser auto-launch on every spawn after the first (relaunches).
	const relaunch = serverStarted;
	serverStarted = true;
	const childEnv = relaunch
		? { ...process.env, PORTAL_NO_AUTOLAUNCH: '1' }
		: process.env;
	const child = spawn(process.execPath, [serverScript, ...serverArgs, ...extraArgs], {
		cwd: process.cwd(),
		stdio: 'inherit',
		env: childEnv,
	});

	child.on('exit', (code) => {
		if (code === REAUTH_CODE) {
			// Portal completed a sign-in. Restart the CLI server so it re-reads the
			// new credentials, then relaunch the portal (it reconnects authenticated).
			log('[Launcher] Re-authenticated — restarting CLI server to load new credentials');
			process.stdout.write('\x1b]0;Copilot Portal\x07');
			stopCli();
			setTimeout(() => start(), 800);
			return;
		}
		if (code === RESTART_CODE) {
			log('[Launcher] Restarting server...');
			process.stdout.write('\x1b]0;Copilot Portal\x07');
			// Check if CLI package version changed — only restart CLI if it did
			log(`[Launcher] cliLaunched=${cliLaunched}, cliStartVersion=${cliStartVersion}`);
			if (cliLaunched) {
				try {
					const pkgPath = path.join(__dirname, '..', 'node_modules', '@github', 'copilot', 'package.json');
					const diskVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
					log(`[Launcher] CLI version check: start=${cliStartVersion} disk=${diskVersion}`);
					if (diskVersion && cliStartVersion && diskVersion !== cliStartVersion) {
						log(`[Launcher] CLI updated (${cliStartVersion} → ${diskVersion}) — restarting CLI server`);
						stopCli();
						// Small delay to let the port free up before relaunching
						setTimeout(() => start(), 500);
						return;
					} else {
						log(`[Launcher] CLI version unchanged — keeping CLI running`);
					}
				} catch (e) {
					log(`[Launcher] CLI version check failed: ${e}`);
				}
			} else {
				log(`[Launcher] CLI not managed by launcher — skipping CLI restart`);
			}
			launch(cliUrl);
		} else {
			stopCli(); // clean up CLI server on normal exit
			process.exit(code ?? 0);
		}
	});

	// Forward SIGINT/SIGTERM to child and clean up CLI
	const forward = (sig: NodeJS.Signals) => {
		child.kill(sig);
	};
	process.on('SIGINT', () => { forward('SIGINT'); stopCli(); });
	process.on('SIGTERM', () => { forward('SIGTERM'); stopCli(); });
	// Catch-all: clean up CLI on any exit (e.g. terminal window closed)
	process.on('exit', () => stopCli());
}

start();
