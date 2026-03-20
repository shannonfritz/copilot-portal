/**
 * Update checker — periodically polls the npm registry for newer versions
 * of key dependencies and exposes the results via a simple API.
 */
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

export interface PackageUpdate {
	name: string;
	installed: string;
	latest: string;
	hasUpdate: boolean;
}

export interface UpdateStatus {
	packages: PackageUpdate[];
	lastChecked: number | null;  // ms epoch
	checking: boolean;
	applying: boolean;
	error: string | null;
}

/** Packages to monitor for updates */
const TRACKED_PACKAGES = ['@github/copilot-sdk'] as const;

/** How often to auto-check (ms) — 4 hours */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export class UpdateChecker {
	private packages: PackageUpdate[] = [];
	private lastChecked: number | null = null;
	private checking = false;
	private applying = false;
	private error: string | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private log: (msg: string) => void;

	constructor(log: (msg: string) => void) {
		this.log = log;
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
			lastChecked: this.lastChecked,
			checking: this.checking,
			applying: this.applying,
			error: this.error,
		};
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
				const latest = await fetchLatestVersion(name);
				const hasUpdate = !!(installed && latest && latest !== installed && isNewer(latest, installed));
				results.push({ name, installed: installed ?? 'unknown', latest: latest ?? 'unknown', hasUpdate });
			}
			// Also check the CLI binary version (bundled as @github/copilot via copilot-sdk)
			const cliInstalled = getInstalledVersion('@github/copilot');
			const cliLatest = await fetchLatestVersion('@github/copilot');
			const cliHasUpdate = !!(cliInstalled && cliLatest && cliLatest !== cliInstalled && isNewer(cliLatest, cliInstalled));
			results.push({ name: '@github/copilot', installed: cliInstalled ?? 'unknown', latest: cliLatest ?? 'unknown', hasUpdate: cliHasUpdate });

			this.packages = results;
			this.lastChecked = Date.now();

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

			// Update tracked packages. @github/copilot is a transitive dependency of
			// @github/copilot-sdk so updating the SDK also pulls the latest CLI binary.
			const pkgNames = [...TRACKED_PACKAGES].join(' ');
			await runCommand(`npm update ${pkgNames}`, PROJECT_ROOT);
			this.log(`[Update] npm update complete`);

			// 2. Rebuild the server and UI
			await runCommand('npm run build', PROJECT_ROOT);
			this.log(`[Update] Rebuild complete`);

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
function fetchLatestVersion(name: string): Promise<string | null> {
	return new Promise((resolve) => {
		const url = `https://registry.npmjs.org/${name}/latest`;
		const req = https.get(url, { headers: { Accept: 'application/json' }, timeout: 10_000 }, (res) => {
			if (res.statusCode !== 200) { resolve(null); res.resume(); return; }
			let body = '';
			res.on('data', (chunk: Buffer) => { body += chunk; });
			res.on('end', () => {
				try {
					const data = JSON.parse(body);
					resolve(data.version ?? null);
				} catch { resolve(null); }
			});
		});
		req.on('error', () => resolve(null));
		req.on('timeout', () => { req.destroy(); resolve(null); });
	});
}

/** Simple semver comparison: is `a` newer than `b`? (handles x.y.z format) */
function isNewer(a: string, b: string): boolean {
	const pa = a.replace(/^v/, '').split('.').map(Number);
	const pb = b.replace(/^v/, '').split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const va = pa[i] ?? 0;
		const vb = pb[i] ?? 0;
		if (va > vb) return true;
		if (va < vb) return false;
	}
	return false;
}

/** Run a shell command and return stdout. Rejects on non-zero exit. */
function runCommand(cmd: string, cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		exec(cmd, { cwd, timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
			else resolve(stdout);
		});
	});
}
