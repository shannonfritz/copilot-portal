/**
 * Update checker — periodically polls the npm registry for newer versions
 * of key dependencies and exposes the results via a simple API.
 */
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

export interface PackageUpdate {
	name: string;
	installed: string;
	latest: string;
	hasUpdate: boolean;
}

export interface PortalUpdate {
	installed: string;
	latest: string;
	hasUpdate: boolean;
	downloadUrl: string | null;
}

export interface UpdateStatus {
	packages: PackageUpdate[];
	portal: PortalUpdate | null;
	lastChecked: number | null;  // ms epoch
	checking: boolean;
	applying: boolean;
	restartNeeded: boolean;
	error: string | null;
}

/** Packages to monitor for updates */
const TRACKED_PACKAGES = ['@github/copilot-sdk'] as const;

/** How often to auto-check (ms) — 4 hours */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export class UpdateChecker {
	private packages: PackageUpdate[] = [];
	private portal: PortalUpdate | null = null;
	private lastChecked: number | null = null;
	private checking = false;
	private applying = false;
	private portalRestartNeeded = false;
	private error: string | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private log: (msg: string) => void;
	/** Versions at process start — if on-disk versions differ after an apply, restart is needed */
	private startupVersions: Record<string, string> = {};
	private repoOwner: string;
	private repoName: string;

	constructor(log: (msg: string) => void) {
		this.log = log;
		// Snapshot versions at startup
		for (const name of TRACKED_PACKAGES) {
			const v = getInstalledVersion(name);
			if (v) this.startupVersions[name] = v;
		}
		const cliV = getInstalledVersion('@github/copilot');
		if (cliV) this.startupVersions['@github/copilot'] = cliV;
		// Parse GitHub repo from package.json for portal self-update
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
			const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
			const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
			this.repoOwner = match?.[1] ?? '';
			this.repoName = match?.[2] ?? '';
		} catch {
			this.repoOwner = '';
			this.repoName = '';
		}
	}

	/** Start periodic checking. First check runs immediately. */
	start(): void {
		this.check(); // fire-and-forget first check
		this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
	}

	stop(): void {
		if (this.timer) { clearInterval(this.timer); this.timer = null; }
	}

	/** Current status snapshot */
	getStatus(): UpdateStatus {
		return {
			packages: this.packages,
			portal: this.portal,
			lastChecked: this.lastChecked,
			checking: this.checking,
			applying: this.applying,
			// Never surface "restart needed" while an apply is still running — npm
			// install rewrites the on-disk version BEFORE `npm run build` finishes,
			// which would otherwise pop the Restart button mid-build (and a restart
			// there corrupts node_modules/dist). Only report it once we're idle.
			restartNeeded: this.applying ? false : this.isRestartNeeded(),
			error: this.error,
		};
	}

	/** True while an update (packages or portal) is being applied. Single source
	 *  of truth used to hard-gate every restart path. */
	isBusy(): boolean {
		return this.applying;
	}

	/** True if on-disk versions differ from what this process loaded at startup */
	private isRestartNeeded(): boolean {
		if (this.portalRestartNeeded) return true;
		for (const [name, startVer] of Object.entries(this.startupVersions)) {
			const currentOnDisk = getInstalledVersion(name);
			if (currentOnDisk && currentOnDisk !== startVer) return true;
		}
		return false;
	}

	/** Returns true if any tracked package has an update available */
	get hasUpdates(): boolean {
		return this.packages.some(p => p.hasUpdate);
	}

	/** Manually trigger a check */
	async check(): Promise<UpdateStatus> {
		if (this.checking) return this.getStatus();
		this.checking = true;
		this.error = null;
		try {
			const results: PackageUpdate[] = [];
			for (const name of TRACKED_PACKAGES) {
				const installed = getInstalledVersion(name);
				const latest = await fetchLatestVersion(name, this.log);
				const hasUpdate = !!(installed && latest && latest !== installed && isNewer(latest, installed));
				results.push({ name, installed: installed ?? 'unknown', latest: latest ?? 'unknown', hasUpdate });
			}
			// Also check the CLI binary version (bundled as @github/copilot via copilot-sdk)
			const cliInstalled = getInstalledVersion('@github/copilot');
			const cliLatest = await fetchLatestVersion('@github/copilot', this.log);
			const cliHasUpdate = !!(cliInstalled && cliLatest && cliLatest !== cliInstalled && isNewer(cliLatest, cliInstalled));
			results.push({ name: '@github/copilot', installed: cliInstalled ?? 'unknown', latest: cliLatest ?? 'unknown', hasUpdate: cliHasUpdate });

			this.packages = results;
			this.lastChecked = Date.now();

			// Check for portal self-update via GitHub Releases
			if (this.repoOwner && this.repoName) {
				this.log(`[Update] Checking portal releases for ${this.repoOwner}/${this.repoName}...`);
				try {
					const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
					const installed = pkg.version ?? 'unknown';
					// If we're running a pre-release (e.g. -rc.N), track the pre-release
					// channel so we see newer rc's AND the eventual final; a stable build
					// only tracks stable releases.
					const installedIsPre = installed.includes('-');
					const release = await fetchLatestRelease(this.repoOwner, this.repoName, installedIsPre, this.log);
					if (release) {
						const latestVer = release.tag.replace(/^v/, '');
						const hasUpdate = isNewer(latestVer, installed);
						this.portal = { installed, latest: latestVer, hasUpdate, downloadUrl: release.zipUrl };
						if (hasUpdate) {
							this.log(`[Update] Portal update available: v${installed} → v${latestVer}`);
						} else if (installedIsPre && release.latestStableTag && isNewer(installed, release.latestStableTag)) {
							const stable = release.latestStableTag.replace(/^v/, '');
							this.log(`[Update] Portal v${installed} is a pre-release ahead of the latest stable (v${stable})`);
						} else {
							this.log(`[Update] Portal v${installed} is up to date (latest: v${latestVer})`);
						}
					} else {
						this.log(`[Update] No release found for ${this.repoOwner}/${this.repoName}`);
					}
				} catch (e) {
					this.log(`[Update] Portal version check failed: ${e}`);
				}
			} else {
				this.log(`[Update] No repository configured — skipping portal update check`);
			}

			// Report installed CLI/SDK versions on every check so a manual [u]pdate
			// check answers "up to date — at what version?" (4h cadence = negligible
			// noise). The startup [Versions] line is a one-shot boot snapshot and the
			// only readout in container mode; these complement it per-check.
			for (const p of results) {
				this.log(`[Version] ${p.name} ${p.installed} (package)`);
			}

			const updatable = results.filter(p => p.hasUpdate);
			if (updatable.length > 0) {
				this.log(`[Update] Updates available: ${updatable.map(p => `${p.name} ${p.installed} → ${p.latest}`).join(', ')}`);
			} else {
				this.log(`[Update] All packages up to date`);
			}
		} catch (e) {
			this.error = String(e);
			this.log(`[Update] Check failed: ${this.error}`);
		} finally {
			this.checking = false;
		}
		return this.getStatus();
	}

	/** Apply available updates: npm update + rebuild. Returns the new status. */
	async apply(): Promise<UpdateStatus> {
		if (this.applying) return this.getStatus();
		this.applying = true;
		this.error = null;
		try {
			this.log(`[Update] Applying updates...`);

			// Update packages. Use `npm install pkg@latest` instead of `npm update`
			// because npm update respects the semver range in package.json (e.g. ^0.1.32
			// won't update to 0.2.0). Install @latest forces the newest version.
			const updatable = this.packages.filter(p => p.hasUpdate).map(p => `${p.name}@latest`);
			if (updatable.length > 0) {
				await runCommand(`npm install --no-fund --no-audit ${updatable.join(' ')}`, PROJECT_ROOT);
				this.log(`[Update] npm install complete`);
				process.title = 'Copilot Portal';
			}

			// 2. Rebuild the server and UI (skip if no build script — e.g. release packages ship pre-built)
			const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
			if (pkg.scripts?.build) {
				await runCommand('npm run build', PROJECT_ROOT);
				this.log(`[Update] Rebuild complete`);
				process.title = 'Copilot Portal';
			} else {
				this.log(`[Update] No build script — skipping rebuild (pre-built release)`);
			}

			// 3. Re-check versions so the status reflects post-update state
			await this.check();

			this.log(`[Update] Update applied successfully. Restart required to use new versions.`);
		} catch (e) {
			this.error = String(e);
			this.log(`[Update] Apply failed: ${this.error}`);
		} finally {
			this.applying = false;
		}
		return this.getStatus();
	}

	/** Download and extract a portal update from GitHub Releases */
	async applyPortalUpdate(): Promise<UpdateStatus> {
		if (this.applying || !this.portal?.hasUpdate || !this.portal.downloadUrl) return this.getStatus();
		this.applying = true;
		this.error = null;
		try {
			this.log(`[Update] Downloading portal v${this.portal.latest}...`);
			const zipPath = path.join(PROJECT_ROOT, 'portal-update.zip');
			await downloadFile(this.portal.downloadUrl, zipPath, this.log);
			this.log(`[Update] Extracting update...`);
			// Extract zip — overwrite existing files
			if (process.platform === 'win32') {
				await runCommand(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${PROJECT_ROOT}' -Force"`, PROJECT_ROOT);
			} else {
				await runCommand(`unzip -o "${zipPath}" -d "${PROJECT_ROOT}"`, PROJECT_ROOT);
			}
			// Clean up zip
			try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
			this.log(`[Update] Portal updated to v${this.portal.latest}. Restart required.`);
			this.portalRestartNeeded = true;
			// Mark as needing restart
			this.portal = { ...this.portal, hasUpdate: false };
		} catch (e) {
			this.error = String(e);
			this.log(`[Update] Portal update failed: ${this.error}`);
			// Clean up partial download
			try { fs.unlinkSync(path.join(PROJECT_ROOT, 'portal-update.zip')); } catch { /* ignore */ }
		} finally {
			this.applying = false;
		}
		return this.getStatus();
	}
}

/** Read the installed version of a package from its package.json in node_modules */
function getInstalledVersion(name: string): string | null {
	try {
		const pkgPath = path.join(PROJECT_ROOT, 'node_modules', ...name.split('/'), 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		return pkg.version ?? null;
	} catch {
		return null;
	}
}

/** Fetch the latest published version from the npm registry */
function fetchLatestVersion(name: string, log?: (msg: string) => void): Promise<string | null> {
	return new Promise((resolve) => {
		const url = `https://registry.npmjs.org/${name}/latest`;
		const req = https.get(url, { headers: { Accept: 'application/json' }, timeout: 10_000 }, (res) => {
			if (res.statusCode !== 200) { log?.(`[Update] Registry returned ${res.statusCode} for ${name}`); resolve(null); res.resume(); return; }
			let body = '';
			res.on('data', (chunk: Buffer) => { body += chunk; });
			res.on('end', () => {
				try {
					const data = JSON.parse(body);
					resolve(data.version ?? null);
				} catch { resolve(null); }
			});
		});
		req.on('error', (e) => { log?.(`[Update] Network error fetching ${name}: ${(e as Error).message}`); resolve(null); });
		req.on('timeout', () => { log?.(`[Update] Timeout fetching ${name}`); req.destroy(); resolve(null); });
	});
}

/** Parse a semver string into its numeric core and pre-release identifiers. */
function parseSemver(v: string): { core: number[]; pre: (string | number)[] } {
	const clean = v.replace(/^v/, '').trim();
	const dash = clean.indexOf('-');
	const coreStr = dash === -1 ? clean : clean.slice(0, dash);
	const preStr = dash === -1 ? '' : clean.slice(dash + 1);
	const core = coreStr.split('.').map(n => parseInt(n, 10) || 0);
	while (core.length < 3) core.push(0);
	const pre = preStr
		? preStr.split('.').map(id => (/^\d+$/.test(id) ? parseInt(id, 10) : id))
		: [];
	return { core, pre };
}

/**
 * Compare two pre-release identifier lists per semver §11. Returns 1 if `a`
 * has higher precedence, -1 if lower, 0 if equal. A version with NO pre-release
 * (e.g. `0.8.0`) outranks one that has one (e.g. `0.8.0-rc.16`).
 */
function comparePrerelease(a: (string | number)[], b: (string | number)[]): number {
	if (a.length === 0 && b.length === 0) return 0;
	if (a.length === 0) return 1;  // a is a final release, higher precedence
	if (b.length === 0) return -1; // b is a final release, higher precedence
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const ai = a[i];
		const bi = b[i];
		if (ai === bi) continue;
		const aNum = typeof ai === 'number';
		const bNum = typeof bi === 'number';
		if (aNum && bNum) return (ai as number) > (bi as number) ? 1 : -1;
		if (aNum) return -1; // numeric identifiers rank below alphanumeric
		if (bNum) return 1;
		return (ai as string) > (bi as string) ? 1 : -1;
	}
	if (a.length === b.length) return 0;
	return a.length > b.length ? 1 : -1; // more fields = higher precedence
}

/**
 * Semver comparison: is `a` newer than `b`? Handles `x.y.z` cores plus
 * `-prerelease` tags, so `0.8.0` > `0.8.0-rc.16` > `0.8.0-rc.2` > `0.7.5`.
 */
function isNewer(a: string, b: string): boolean {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	for (let i = 0; i < 3; i++) {
		if (pa.core[i] > pb.core[i]) return true;
		if (pa.core[i] < pb.core[i]) return false;
	}
	return comparePrerelease(pa.pre, pb.pre) > 0;
}

/** Run a shell command and return stdout. Rejects on non-zero exit. */
function runCommand(cmd: string, cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		// maxBuffer raised to 64MB: `npm ci` + build emit far more than the 1MB
		// default, which would otherwise abort with ERR_CHILD_PROCESS_STDIO_MAXBUFFER
		// and report the update as failed even when it actually succeeded.
		exec(cmd, { cwd, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				const details = [stderr, stdout, err.message].filter(s => s?.trim()).join('\n');
				reject(new Error(`${cmd} failed: ${details}`));
			}
			else resolve(stdout);
		});
	});
}

/** Get a GitHub token from environment or gh CLI */
function getGitHubToken(): string | null {
	// Check environment first
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
	// Try gh CLI's cached token
	try {
		return execSync('gh auth token', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).toString().trim() || null;
	} catch { return null; }
}

type PortalRelease = { tag: string; zipUrl: string; prerelease: boolean; latestStableTag: string | null };

/**
 * Fetch the portal release to compare against. When `includePrereleases` is
 * false (running a stable build) this hits `/releases/latest`, which GitHub
 * defines as the newest NON-prerelease. When true (running a pre-release like
 * an `-rc`) it lists releases and returns the newest overall by semver — so an
 * rc tracks newer rc's AND the eventual final, while never getting stranded.
 * Either way `latestStableTag` carries the newest non-prerelease for logging.
 * Tries unauthenticated first, falls back to auth for private repos.
 */
function fetchLatestRelease(owner: string, repo: string, includePrereleases: boolean, log?: (msg: string) => void): Promise<PortalRelease | null> {
	const zipUrlOf = (rel: { assets?: { name: string; url?: string; browser_download_url?: string }[] }, token?: string): string | null => {
		// For private repos, use API URL (requires auth + Accept: application/octet-stream)
		// For public repos, browser_download_url works without auth
		const asset = (rel.assets ?? []).find(a => a.name.endsWith('.zip'));
		return (token ? asset?.url : asset?.browser_download_url) ?? null;
	};
	const doFetch = (token?: string): Promise<PortalRelease | null> => new Promise((resolve) => {
		const url = includePrereleases
			? `/repos/${owner}/${repo}/releases?per_page=30`
			: `/repos/${owner}/${repo}/releases/latest`;
		const headers: Record<string, string> = { 'User-Agent': 'copilot-portal', Accept: 'application/vnd.github+json' };
		if (token) headers['Authorization'] = `Bearer ${token}`;
		const req = https.get({
			hostname: 'api.github.com',
			path: url,
			headers,
			timeout: 10_000,
		}, (res) => {
			if (res.statusCode === 404 && !token) {
				// Private repo — resolve null to trigger auth fallback
				resolve(null); res.resume(); return;
			}
			if (res.statusCode !== 200) { log?.(`[Update] GitHub API returned ${res.statusCode} for releases`); resolve(null); res.resume(); return; }
			let body = '';
			res.on('data', (chunk: Buffer) => { body += chunk; });
			res.on('end', () => {
				try {
					const data = JSON.parse(body);
					if (Array.isArray(data)) {
						// Pre-release channel: pick the newest release overall (incl.
						// pre-releases) that ships a zip, and track the newest stable.
						let chosen: PortalRelease | null = null;
						let latestStableTag: string | null = null;
						for (const rel of data) {
							if (rel.draft) continue;
							const tag: string = rel.tag_name ?? '';
							if (!tag) continue;
							if (!rel.prerelease && (!latestStableTag || isNewer(tag, latestStableTag))) latestStableTag = tag;
							const zipUrl = zipUrlOf(rel, token);
							if (!zipUrl) continue;
							if (!chosen || isNewer(tag, chosen.tag)) chosen = { tag, zipUrl, prerelease: !!rel.prerelease, latestStableTag: null };
						}
						resolve(chosen ? { ...chosen, latestStableTag } : null);
					} else {
						const tag: string = data.tag_name ?? '';
						const zipUrl = zipUrlOf(data, token);
						resolve(tag && zipUrl ? { tag, zipUrl, prerelease: !!data.prerelease, latestStableTag: tag } : null);
					}
				} catch { resolve(null); }
			});
		});
		req.on('error', (e) => { log?.(`[Update] GitHub API error: ${(e as Error).message}`); resolve(null); });
		req.on('timeout', () => { log?.(`[Update] GitHub API timeout`); req.destroy(); resolve(null); });
	});

	// Try unauthenticated first, fall back to authenticated for private repos
	return doFetch().then(result => {
		if (result) return result;
		const token = getGitHubToken();
		if (!token) return null;
		log?.(`[Update] Retrying with auth token...`);
		return doFetch(token);
	});
}

/** Download a file from a URL (follows redirects, uses GitHub auth for private repos) to a local path */
function downloadFile(url: string, dest: string, log?: (msg: string) => void): Promise<void> {
	const token = getGitHubToken();
	return new Promise((resolve, reject) => {
		const doGet = (getUrl: string, redirects = 0) => {
			if (redirects > 5) { reject(new Error('Too many redirects')); return; }
			const headers: Record<string, string> = { 'User-Agent': 'copilot-portal', Accept: 'application/octet-stream' };
			// Only send auth to GitHub domains (don't leak token to CDN redirects)
			if (token && (getUrl.includes('github.com') || getUrl.includes('githubusercontent.com'))) {
				headers['Authorization'] = `Bearer ${token}`;
			}
			const req = https.get(getUrl, { headers, timeout: 60_000 }, (res) => {
				if (res.statusCode === 302 || res.statusCode === 301) {
					const loc = res.headers.location;
					if (loc) { res.resume(); doGet(loc, redirects + 1); return; }
				}
				if (res.statusCode !== 200) { reject(new Error(`Download failed: HTTP ${res.statusCode}`)); res.resume(); return; }
				const file = fs.createWriteStream(dest);
				res.pipe(file);
				file.on('finish', () => { file.close(); resolve(); });
				file.on('error', (e) => { fs.unlinkSync(dest); reject(e); });
			});
			req.on('error', reject);
			req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
		};
		doGet(url);
	});
}
