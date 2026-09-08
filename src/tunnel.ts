import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface TunnelConfig {
	name: string;
	allowAnonymous: boolean;
	wasRunning?: boolean;
}

export interface TunnelState {
	running: boolean;
	url?: string;
	config?: TunnelConfig;
	restarting?: boolean;
	restartFailures?: number;
}

type TunnelNotify = (level: 'info' | 'warning', message: string, url?: string) => void;

export class TunnelManager {
	private process: ChildProcess | null = null;
	private url: string | null = null;
	private config: TunnelConfig | null = null;
	private configPath: string;
	private port: number;

	private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private log: ((msg: string) => void) | null = null;
	private getToken: (() => string) | null = null;
	private onRestart: ((url: string) => void) | null = null;
	private notify: TunnelNotify | null = null;
	private expectedStops = new WeakSet<ChildProcess>();
	private restarting = false;
	private restartFailures = 0;
	private failureBannerShown = false;

	constructor(dataDir: string, port: number) {
		this.configPath = join(dataDir, 'tunnel.json');
		this.port = port;
		this.loadConfig();
	}

	private loadConfig(): void {
		try {
			if (existsSync(this.configPath)) {
				this.config = JSON.parse(readFileSync(this.configPath, 'utf8'));
			}
		} catch { /* ignore corrupt config */ }
	}

	private saveConfig(config: TunnelConfig): void {
		this.config = config;
		writeFileSync(this.configPath, JSON.stringify(config, null, 2) + '\n');
	}

	/** Check if devtunnel CLI is available */
	isInstalled(): boolean {
		try {
			execSync(process.platform === 'win32' ? 'where.exe devtunnel' : 'which devtunnel', { stdio: 'ignore' });
			return true;
		} catch { return false; }
	}

	/** Check if user is logged in */
	isLoggedIn(): boolean {
		try {
			const result = execSync('devtunnel user show', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
			return result.includes('Logged in');
		} catch { return false; }
	}

	/** Generate a random tunnel name */
	static generateName(): string {
		return `portal-${randomBytes(4).toString('hex')}`;
	}

	/** Check if a named tunnel already exists */
	private tunnelExists(name: string): boolean {
		try {
			execSync(`devtunnel show ${name}`, { stdio: 'ignore' });
			return true;
		} catch { return false; }
	}

	/** Create a named tunnel with port forwarding */
	private createTunnel(name: string, allowAnonymous: boolean): void {
		const anonFlag = allowAnonymous ? ' --allow-anonymous' : '';
		execSync(`devtunnel create ${name}${anonFlag}`, { stdio: 'ignore' });
		execSync(`devtunnel port create ${name} -p ${this.port}`, { stdio: 'ignore' });
	}

	/** Start hosting the tunnel, returns the public URL */
	async start(config: TunnelConfig): Promise<string> {
		if (this.process) {
			throw new Error('Tunnel is already running');
		}

		// Ensure tunnel exists
		if (!this.tunnelExists(config.name)) {
			this.createTunnel(config.name, config.allowAnonymous);
		}

		this.saveConfig(config);

		return new Promise<string>((resolve, reject) => {
			const proc = spawn('devtunnel', ['host', config.name], {
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});
			this.process = proc;

			let output = '';
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.killProcess(true);
				reject(new Error('Tunnel failed to start within 15 seconds'));
			}, 15000);

			proc.stdout?.on('data', (data: Buffer) => {
				output += data.toString();
				// Look for the connect URL
				const match = output.match(/Connect via browser:\s+(https:\/\/\S+)/);
				if (match && !settled) {
					settled = true;
					clearTimeout(timeout);
					this.url = match[1];
					this.setWasRunning(true);
					resolve(this.url);
				}
			});

			proc.stderr?.on('data', (data: Buffer) => {
				output += data.toString();
			});

			proc.on('error', (err) => {
				clearTimeout(timeout);
				if (this.process === proc) {
					this.process = null;
					this.url = null;
				}
				if (!settled) {
					settled = true;
					reject(err);
				} else if (!this.expectedStops.has(proc)) {
					this.scheduleRestart(`Tunnel process error: ${err.message}`);
				}
			});

			proc.on('exit', (code) => {
				clearTimeout(timeout);
				if (this.process === proc) {
					this.process = null;
					this.url = null;
				}
				if (this.expectedStops.has(proc)) return;
				const reason = `devtunnel exited${code === null ? '' : ` with code ${code}`}${output.trim() ? `: ${output.trim().slice(-500)}` : ''}`;
				if (!settled) {
					settled = true;
					reject(new Error(reason));
				} else {
					this.scheduleRestart(reason);
				}
			});
		});
	}

	/** Stop the tunnel (user-initiated — clears wasRunning so it won't auto-restart) */
	stop(): void {
		this.stopHealthCheck();
		this.clearRestartTimer();
		this.setWasRunning(false);
		this.killProcess(false);
	}

	/** Shutdown the tunnel process (preserves wasRunning for auto-restart on next launch) */
	shutdown(): void {
		this.stopHealthCheck();
		this.clearRestartTimer();
		this.killProcess(true);
	}

	private killProcess(preserveIntent: boolean): void {
		if (this.process) {
			const proc = this.process;
			const pid = this.process.pid;
			this.expectedStops.add(proc);
			proc.kill('SIGINT');
			// Give it a moment, then force kill
			setTimeout(() => {
				if (!pid) return;
				try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
			}, 3000);
			this.process = null;
			this.url = null;
		}
		if (!preserveIntent) this.restartFailures = 0;
	}

	/** Persist running flag so tunnel can auto-restart after server restart */
	private setWasRunning(running: boolean): void {
		if (this.config) {
			this.config.wasRunning = running;
			this.saveConfig(this.config);
		}
	}

	/** Check if tunnel should auto-start (was running before server restart) */
	shouldAutoStart(): boolean {
		return this.config?.wasRunning === true;
	}

	/** Get current state */
	getState(): TunnelState {
		return {
			running: this.process !== null,
			url: this.url ?? undefined,
			config: this.config ?? undefined,
			restarting: this.restarting || this.restartTimer !== null,
			restartFailures: this.restartFailures,
		};
	}

	/** Get the stored config (if any) */
	getConfig(): TunnelConfig | null {
		return this.config;
	}

	/** Check if config exists */
	hasConfig(): boolean {
		return this.config !== null;
	}

	/** Delete the tunnel from devtunnel service and remove local config */
	reset(): { deleted: boolean; name?: string } {
		this.stop();
		const config = this.config;
		if (config) {
			try {
				execSync(`devtunnel delete ${config.name} --force`, { stdio: 'ignore' });
			} catch { /* tunnel may not exist */ }
			try {
				if (existsSync(this.configPath)) unlinkSync(this.configPath);
			} catch {}
			this.config = null;
			return { deleted: true, name: config.name };
		}
		return { deleted: false };
	}

	/** Start periodic health checks — restarts tunnel if the relay connection goes stale. */
	startHealthCheck(getToken: () => string, onRestart: (url: string) => void, logFn: (msg: string) => void, notify?: TunnelNotify): void {
		this.stopHealthCheck();
		this.log = logFn;
		this.getToken = getToken;
		this.onRestart = onRestart;
		this.notify = notify ?? null;
		this.healthCheckTimer = setInterval(async () => {
			if (!this.config?.wasRunning) return;
			if (!this.process || !this.url) {
				this.scheduleRestart('Tunnel process is not running');
				return;
			}
			let timeout: ReturnType<typeof setTimeout> | null = null;
			try {
				const controller = new AbortController();
				timeout = setTimeout(() => controller.abort(), 10000);
				const resp = await fetch(`${this.url}/api/info?token=${getToken()}`, { signal: controller.signal });
				if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			} catch (e) {
				this.scheduleRestart(`Health check failed: ${String(e).split('\n')[0]}`);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		}, 5 * 60 * 1000); // Every 5 minutes
	}

	stopHealthCheck(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}
	}

	private clearRestartTimer(): void {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
	}

	private scheduleRestart(reason: string): void {
		if (!this.config?.wasRunning || this.restartTimer || this.restarting) return;
		if (!this.isInstalled()) {
			this.log?.(`[Tunnel] Cannot restart tunnel: devtunnel is not installed`);
			this.notify?.('warning', 'Tunnel stopped and cannot restart because devtunnel is not installed.');
			return;
		}
		if (!this.isLoggedIn()) {
			this.log?.(`[Tunnel] Cannot restart tunnel: devtunnel is not logged in`);
			this.notify?.('warning', 'Tunnel stopped and cannot restart because devtunnel is not logged in. Run devtunnel user login locally.');
			return;
		}

		this.restartFailures++;
		const delayMs = Math.min(60_000, 1000 * Math.pow(2, Math.min(this.restartFailures - 1, 6)));
		this.log?.(`[Tunnel] ${reason} — restarting in ${Math.round(delayMs / 1000)}s (attempt ${this.restartFailures})`);
		if (this.restartFailures === 1) {
			this.notify?.('info', 'Tunnel disconnected — reconnecting...');
		} else if (this.restartFailures >= 5 && !this.failureBannerShown) {
			this.failureBannerShown = true;
			this.notify?.('warning', `Tunnel is still down after ${this.restartFailures} reconnect attempts. Portal will keep retrying; check devtunnel locally if this continues.`);
		}
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			void this.restartNow(reason);
		}, delayMs);
	}

	private async restartNow(reason: string): Promise<void> {
		if (!this.config?.wasRunning || this.restarting) return;
		const config = this.config;
		this.restarting = true;
		this.killProcess(true);
		try {
			const newUrl = await this.start(config);
			this.restartFailures = 0;
			this.failureBannerShown = false;
			this.log?.(`[Tunnel] Restarted: ${newUrl}`);
			this.onRestart?.(newUrl);
			this.notify?.('info', `Tunnel reconnected: ${newUrl}`);
		} catch (e) {
			this.restarting = false;
			this.scheduleRestart(`Restart failed after ${reason}: ${String(e).split('\n')[0]}`);
			return;
		}
		this.restarting = false;
	}
}
