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

/**
 * Public npm registry — used as a FALLBACK only.
 *
 * We prefer npm's CONFIGURED registry (see fetchLatestVersion) and fall back to
 * this public host only if the configured one can't resolve. Microsoft-managed
 * devices block the public npm hosts ("[TE] NPM URL Block" / Tech Eviction)
 * while routing npm at an approved, reachable feed
 * (`packagefeedproxy.microsoft.io`). Forcing this host there hung each check
 * ~72s AND fired a Windows Security toast on every check — so it must never be
 * the forced primary. The prerelease guard in computeHasUpdate() keeps a mirror's
 * occasional prerelease `latest` (e.g. 1.0.7-preview.0) from being offered onto a
 * stable install.
 */
const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org';

/** npm flags that fail fast on a blocked/unreachable registry. npm's default
 *  fetch-timeout is ~5min and it retries, which on a blocked host stacked into a
 *  ~72s hang per call. Cap it so a blocked registry fails in seconds. */
const NPM_VIEW_FLAGS = '--fetch-retries=1 --fetch-timeout=15000';
const NPM_INSTALL_FLAGS = '--no-fund --no-audit --fetch-retries=1 --fetch-timeout=60000';

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

	/** Decide whether `latest` should be offered over `installed`, with a
	 *  prerelease guard: a prerelease `latest` (e.g. the corporate feed surfacing
	 *  1.0.7-preview.0) is only offered when the installed build is itself a
	 *  prerelease — so a stable install is never nudged onto a preview. */
	private computeHasUpdate(installed: string | null, latest: string | null): boolean {
		if (!installed || !latest || latest === installed) return false;
		if (!isNewer(latest, installed)) return false;
		if (isPrerelease(latest) && !isPrerelease(installed)) return false;
		return true;
	}

	/** Manually trigger a check */
	async check(): Promise<UpdateStatus> {
		if (this.checking) return this.getStatus();
		this.checking = true;
		this.error = null;
		try {
			const configuredReg = getConfiguredRegistry();
			this.log(`[Update] Checking for updates via ${configuredReg ?? 'the configured npm registry'} (public npm registry as fallback)...`);
			const results: PackageUpdate[] = [];
			for (const name of TRACKED_PACKAGES) {
				const installed = getInstalledVersion(name);
				const latest = await fetchLatestVersion(name, this.log);
				const hasUpdate = this.computeHasUpdate(installed, latest);
				results.push({ name, installed: installed ?? 'unknown', latest: latest ?? 'unknown', hasUpdate });
			}
			// Also check the CLI binary version (bundled as @github/copilot via copilot-sdk)
			const cliInstalled = getInstalledVersion('@github/copilot');
			const cliLatest = await fetchLatestVersion('@github/copilot', this.log);
			const cliHasUpdate = this.computeHasUpdate(cliInstalled, cliLatest);
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
	// ---------------------------------------------------------------------------
	// Shared building blocks — used by apply() (CLI/SDK), applyPortalUpdate()
	// (portal-only), and applyAll() (combined). Keeping these in one place means
	// all three paths run the exact same battle-tested install / verify / stamp
	// logic instead of drifting copies.
	// ---------------------------------------------------------------------------

	/** CLI/SDK updates resolved to pinned install targets (never the moving @latest tag). */
	private packageTargets(): { name: string; version: string }[] {
		return this.packages
			.filter(p => p.hasUpdate && p.latest && p.latest !== 'unknown')
			.map(p => ({ name: p.name, version: p.latest }));
	}

	/** Download the portal release zip and extract it over PROJECT_ROOT. */
	private async extractPortalZip(): Promise<void> {
		this.log(`[Update] Downloading portal v${this.portal!.latest}...`);
		const zipPath = path.join(PROJECT_ROOT, 'portal-update.zip');
		await downloadFile(this.portal!.downloadUrl!, zipPath, this.log);
		this.log(`[Update] Extracting update...`);
		if (process.platform === 'win32') {
			await runCommand(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${PROJECT_ROOT}' -Force"`, PROJECT_ROOT);
		} else {
			await runCommand(`unzip -o "${zipPath}" -d "${PROJECT_ROOT}"`, PROJECT_ROOT);
		}
		try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
	}

	/** Install explicit pinned package targets, then verify on disk and self-heal a
	 *  desynced tree (logical state at target but physical files left behind, which
	 *  makes `npm install pkg@X` a silent no-op). Throws if disk still won't match. */
	private async installPackageTargets(targets: { name: string; version: string }[]): Promise<void> {
		if (targets.length === 0) return;
		const specs = targets.map(t => `${t.name}@${t.version}`).join(' ');
		await runNpmInstall(specs, this.log);
		this.log(`[Update] npm install complete`);
		process.title = 'Copilot Portal';
		const mismatched = targets.filter(t => getInstalledVersion(t.name) !== t.version);
		if (mismatched.length > 0) {
			for (const t of mismatched) {
				this.log(`[Update] ${t.name} on disk is ${getInstalledVersion(t.name) ?? 'missing'}, expected ${t.version} — forcing clean re-extract`);
				fs.rmSync(path.join(PROJECT_ROOT, 'node_modules', ...t.name.split('/')), { recursive: true, force: true });
			}
			await runNpmInstall('', this.log);
			this.log(`[Update] Re-extract complete`);
			process.title = 'Copilot Portal';
			const stillWrong = mismatched.filter(t => getInstalledVersion(t.name) !== t.version);
			if (stillWrong.length > 0) {
				const detail = stillWrong.map(t => `${t.name} (on disk ${getInstalledVersion(t.name) ?? 'missing'}, expected ${t.version})`).join(', ');
				throw new Error(`Update did not take effect on disk after re-extract: ${detail}`);
			}
			for (const t of mismatched) this.log(`[Update] ${t.name} re-extracted to ${t.version}`);
		}
	}

	/** Rebuild server + UI if a build script exists (release packages ship pre-built → skipped). */
	private async rebuildIfNeeded(): Promise<void> {
		const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
		if (pkg.scripts?.build) {
			await runCommand('npm run build', PROJECT_ROOT);
			this.log(`[Update] Rebuild complete`);
			process.title = 'Copilot Portal';
		} else {
			this.log(`[Update] No build script — skipping rebuild (pre-built release)`);
		}
	}

	/** Stamp node_modules/.portal-deps-version = current package.json version so a later
	 *  cold start-portal.cmd launch sees deps already match and skips a redundant reinstall.
	 *  Best-effort: a failure here never fails the update (the .cmd stamp check is the backstop). */
	private stampDepsVersion(): void {
		try {
			const newVer = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
			if (newVer) {
				fs.writeFileSync(path.join(PROJECT_ROOT, 'node_modules', '.portal-deps-version'), String(newVer));
				this.log(`[Update] Stamped node_modules/.portal-deps-version = ${newVer}`);
			}
		} catch (e) {
			this.log(`[Update] Could not stamp deps-version marker: ${String(e).split('\n')[0]}`);
		}
	}

	/** Shared apply-error handler: map a yanked-target npm failure to a calm message,
	 *  otherwise surface the raw error. Sets this.error + logs. */
	private handleApplyError(e: unknown): void {
		const raw = String(e);
		if (/ETARGET|E404|No matching version|could not be found/i.test(raw)) {
			// A version we offered was pulled from npm between our pre-flight re-check and
			// the install (a yanked release). The installed version is untouched; the next
			// check re-resolves against npm's current `latest`.
			this.error = 'Update target is no longer available on npm (it may have been unpublished). Your installed version is unchanged — this usually clears on the next check.';
			this.log(`[Update] Apply skipped: ${this.error}`);
			this.log(`[Update] (npm detail: ${raw.split('\n').find(l => /npm error/i.test(l))?.trim() ?? raw.split('\n')[0]})`);
		} else {
			this.error = raw;
			this.log(`[Update] Apply failed: ${this.error}`);
		}
	}

	async apply(): Promise<UpdateStatus> {
		if (this.applying) return this.getStatus();
		this.applying = true;
		this.error = null;
		try {
			this.log(`[Update] Applying updates...`);

			// Re-check right before installing. The cached `hasUpdate` flags can be stale:
			// the user may have waited days since the last check (a newer version may be
			// out now), or — as happened with @github/copilot 1.0.70 — a version can be
			// UNPUBLISHED from npm AFTER we detected it, rolling the `latest` dist-tag
			// backward. Acting on the stale flag runs `npm install @latest` against a
			// target that no longer satisfies our pin → a scary ETARGET. A fresh check
			// re-resolves against npm's CURRENT `latest`, so we install what's actually
			// installable now (grabbing an even-newer drop), or cleanly no-op if the
			// offered update evaporated.
			await this.check();

			// Install the EXACT versions we resolved as `latest`, pinned — not the moving
			// `@latest` tag — so the pre-flight check and the install can't disagree, and
			// verify + self-heal a desynced tree.
			const targets = this.packageTargets();
			if (targets.length > 0) {
				await this.installPackageTargets(targets);
			} else {
				this.log(`[Update] Nothing to install — packages already at the latest release.`);
			}

			// Rebuild (skip if no build script — release packages ship pre-built).
			await this.rebuildIfNeeded();

			// Keep the deps stamp current so a later cold start-portal.cmd launch doesn't
			// redundantly reinstall (writes the same portal version in the CLI-only case).
			this.stampDepsVersion();

			// Re-check versions so the status reflects post-update state
			await this.check();

			this.log(`[Update] Update applied successfully. Restart required to use new versions.`);
		} catch (e) {
			this.handleApplyError(e);
		} finally {
			this.applying = false;
		}
		return this.getStatus();
	}

	/** Portal-only self-update: download + extract the release zip, reconcile deps,
	 *  stamp, and flag restart. Kept as a standalone fallback; the UI uses applyAll(). */
	async applyPortalUpdate(): Promise<UpdateStatus> {
		if (this.applying || !this.portal?.hasUpdate || !this.portal.downloadUrl) return this.getStatus();
		this.applying = true;
		this.error = null;
		try {
			await this.extractPortalZip();

			// Reconcile node_modules against the freshly-extracted package.json. The
			// release zip ships app files (dist/, package.json) but NOT node_modules, so
			// a portal update that bumps a dependency would otherwise leave the NEW code
			// running against the OLD node_modules until the next start-portal.cmd cold
			// launch reconciled it — and the in-app Restart bypasses that script entirely.
			// Best-effort: the extract already succeeded, so a transient failure here must
			// NOT fail the whole update; we skip the stamp so start-portal.cmd reconciles
			// on the next launch (today's safety net — never worse than current behavior).
			try {
				this.log(`[Update] Reconciling dependencies for v${this.portal.latest}...`);
				await runNpmInstall('', this.log);
				process.title = 'Copilot Portal';
				this.log(`[Update] Dependencies reconciled`);
				this.stampDepsVersion();
			} catch (e) {
				this.log(`[Update] Dependency reconcile deferred to next launch (in-app reconcile failed: ${String(e).split('\n')[0]})`);
			}

			this.log(`[Update] Portal updated to v${this.portal.latest}. Restart required.`);
			this.portalRestartNeeded = true;
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

	/** Combined, server-orchestrated apply: portal zip (if any) THEN CLI/SDK targets,
	 *  in a SINGLE `applying` window with one deps reconcile, one stamp, and one restart
	 *  signal. This is the path the UI should call — ordering, partial-failure handling,
	 *  and restart gating live on the server, not stitched together in the browser.
	 *
	 *  Ordering matters: the portal zip is extracted FIRST so it lands the new
	 *  package.json/lockfile, then a single `npm install <pinned CLI/SDK targets>` both
	 *  bumps CLI/SDK to the chosen versions AND reconciles the rest of the tree from that
	 *  new lockfile in one pass — no double install, no transient downgrade window. */
	async applyAll(): Promise<UpdateStatus> {
		if (this.applying) return this.getStatus();
		this.applying = true;
		this.error = null;
		let portalExtracted = false;
		let reconciled = true;
		try {
			this.log(`[Update] Applying all updates...`);

			// 1. Portal self-update first — extract new app files so the subsequent install
			//    reconciles against the NEW manifest. Setting portalRestartNeeded here means
			//    that even if a later CLI/SDK step fails, the Restart button still surfaces
			//    (the new dist/ on disk must be picked up) instead of being suppressed.
			if (this.portal?.hasUpdate && this.portal.downloadUrl) {
				await this.extractPortalZip();
				portalExtracted = true;
				this.portalRestartNeeded = true;
				this.portal = { ...this.portal, hasUpdate: false };
			}

			// 2. Re-resolve CLI/SDK targets against the (possibly new) lockfile + npm latest.
			await this.check();
			const targets = this.packageTargets();

			// 3. ONE install pass covering both.
			if (targets.length > 0) {
				// Bumps CLI/SDK to the pinned targets AND reconciles the rest of the tree
				// from the lockfile in a single operation. A hard failure here is a real
				// failure (surfaced below); the portal restart flag already ensures the
				// user can still restart into the new portal code.
				await this.installPackageTargets(targets);
			} else if (portalExtracted) {
				// Portal-only bump: reconcile the tree from the new lockfile. Best-effort —
				// a transient blip leaves the stamp stale so start-portal.cmd retries next
				// launch (never worse than today), and doesn't fail the portal update.
				try {
					this.log(`[Update] Reconciling dependencies for v${this.portal?.latest ?? ''}...`);
					await runNpmInstall('', this.log);
					process.title = 'Copilot Portal';
					this.log(`[Update] Dependencies reconciled`);
				} catch (e) {
					reconciled = false;
					this.log(`[Update] Dependency reconcile deferred to next launch (in-app reconcile failed: ${String(e).split('\n')[0]})`);
				}
			} else {
				this.log(`[Update] Nothing to apply — already up to date.`);
			}

			// 4. Rebuild if a build script exists (release packages ship pre-built → skipped).
			await this.rebuildIfNeeded();

			// 5. Stamp the deps marker (only if we didn't skip a needed reconcile) + refresh status.
			if (reconciled) this.stampDepsVersion();
			await this.check();

			this.log(`[Update] All updates applied. Restart required.`);
		} catch (e) {
			this.handleApplyError(e);
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

/** True if a semver string carries a prerelease segment (e.g. 1.0.7-preview.0). */
function isPrerelease(v: string): boolean {
	return v.includes('-');
}

/** Read npm's configured registry (local, no network). Best-effort. */
function getConfiguredRegistry(): string | null {
	try {
		return execSync('npm config get registry', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 })
			.toString().trim() || null;
	} catch { return null; }
}

/** Run `npm view <name> dist-tags.latest` against a specific registry (or the
 *  configured one when `registry` is undefined). Resolves to the version or null. */
function npmViewLatest(name: string, registry: string | undefined): Promise<string | null> {
	const reg = registry ? ` --registry=${registry}` : '';
	return runCommand(`npm view ${name} dist-tags.latest ${NPM_VIEW_FLAGS}${reg}`, PROJECT_ROOT)
		.then((out) => out.trim() || null);
}

/**
 * Resolve a package's `latest` dist-tag.
 *
 * Registry strategy (managed-device aware): query npm's CONFIGURED registry
 * first, then fall back to public npmjs only if that fails. On Microsoft-managed
 * devices the public npm hosts are blocked ("[TE] NPM URL Block") while an
 * approved feed (`packagefeedproxy.microsoft.io`) is configured and reachable —
 * so forcing npmjs would hang ~72s per call AND trip a Windows Security toast on
 * every check. Preferring the configured registry avoids the block entirely; the
 * npmjs fallback keeps normal (non-managed) machines and mirror-outage cases
 * working. A prerelease guard in computeHasUpdate() prevents a feed's occasional
 * prerelease `latest` from being offered onto a stable install.
 *
 * (Copilot Portal itself is NOT resolved here — it has its own latest/rc release
 * channels via GitHub Releases; see fetchLatestRelease.)
 */
async function fetchLatestVersion(name: string, log?: (msg: string) => void): Promise<string | null> {
	const viaConfigured = await npmViewLatest(name, undefined)
		.catch((e) => { log?.(`[Update] Configured registry could not resolve ${name}: ${(e as Error).message.split('\n')[0]}`); return null; });
	if (viaConfigured) return viaConfigured;

	log?.(`[Update] Falling back to the public npm registry for ${name}...`);
	const viaPublic = await npmViewLatest(name, PUBLIC_NPM_REGISTRY)
		.catch((e) => { log?.(`[Update] Public npm registry could not resolve ${name}: ${(e as Error).message.split('\n')[0]}`); return null; });
	if (viaPublic) return viaPublic;

	log?.(`[Update] Could not reach any npm registry for ${name}. This is expected on networks that block the public npm registry (e.g. managed devices); the update check was skipped and nothing was changed.`);
	return null;
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

/** Install via the configured registry first, falling back to public npmjs.
 *  Same managed-device rationale as fetchLatestVersion: never force the blocked
 *  public host as the primary. `args` is the install target(s) (e.g. `pkg@1.2.3`)
 *  or '' to reinstall from the lockfile. */
async function runNpmInstall(args: string, log?: (msg: string) => void): Promise<void> {
	const base = `npm install ${NPM_INSTALL_FLAGS}`;
	try {
		await runCommand(`${base} ${args}`.trim(), PROJECT_ROOT);
	} catch (e) {
		log?.(`[Update] Install via the configured registry failed; retrying against the public npm registry... (${(e as Error).message.split('\n')[0]})`);
		await runCommand(`${base} --registry=${PUBLIC_NPM_REGISTRY} ${args}`.trim(), PROJECT_ROOT);
	}
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
				// Resolve only after the fd is fully closed (flushed to disk), not merely on
				// 'finish' — on Windows a subsequent Expand-Archive can otherwise open the zip
				// before the OS releases/flushes the handle and read a truncated/locked file.
				file.on('finish', () => { file.close(err => err ? reject(err) : resolve()); });
				file.on('error', (e) => { fs.unlinkSync(dest); reject(e); });
			});
			req.on('error', reject);
			req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
		};
		doGet(url);
	});
}
