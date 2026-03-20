import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionPool } from './session.js';
import { RulesStore } from './rules.js';
import { UpdateChecker } from './updater.js';
import type { PortalEvent, PortalInfo } from './session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class PortalServer {
	private httpServer: http.Server;
	private wss: WebSocketServer;
	private token: string;
	private pool: SessionPool;
	private webuiPath: string;
	private debugDir: string;
	private dataDir: string;
	private clientCounter = 0;
	private logStream: fs.WriteStream | null = null;
	private portalInfo: PortalInfo | null = null;
	private shields: Record<string, boolean> = {};
	private updater: UpdateChecker;
	constructor(private port: number, dataDir?: string, opts?: { newToken?: boolean }) {
		this.webuiPath = path.join(__dirname, '..', 'dist', 'webui');
		this.debugDir = path.join(__dirname, '..', 'debug');
		this.dataDir = dataDir ?? path.join(__dirname, '..', 'data');
		if (opts?.newToken) {
			const tokenFile = path.join(this.dataDir, 'token.txt');
			try { fs.unlinkSync(tokenFile); } catch {}
		}
		this.token = this.loadOrCreateToken();
		const workspacePath = path.join(this.dataDir, 'workspaces', 'default');
		try { fs.mkdirSync(workspacePath, { recursive: true }); } catch {}
		this.pool = new SessionPool((msg) => this.log(msg), new RulesStore(this.dataDir), workspacePath);
		this.updater = new UpdateChecker((msg) => this.log(msg));
		this.pool.onTitleChanged = (sessionId, summary) => {
			this.broadcastAll({ type: 'session_renamed', sessionId, summary });
		};

		this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));

		this.wss = new WebSocketServer({
			server: this.httpServer,
			perMessageDeflate: false,
			verifyClient: ({ req }, callback) => {
				const url = new URL(req.url ?? '/', 'http://localhost');
				const t = url.searchParams.get('token');
				if (t !== this.token) {
					callback(false, 401, 'Unauthorized');
				} else {
					callback(true);
				}
			},
		});

		this.wss.on('error', (err) => this.log(`[WS Error] ${err.message}`));

		this.wss.on('connection', async (ws, req) => {
			const clientId = `C${++this.clientCounter}`;
			const ip = req.socket.remoteAddress ?? 'unknown';
			const url = new URL(req.url ?? '/', 'http://localhost');
			let sessionId = url.searchParams.get('session') ?? null;
				const historyParam = url.searchParams.get('history');
				const historyLimit = historyParam === 'all' ? undefined : (historyParam ? parseInt(historyParam, 10) || 50 : 50);
			const isManagement = url.searchParams.get('management') === '1';

			this.log(`[${clientId}] Connected from ${ip}, session=${sessionId?.slice(0, 8) ?? (isManagement ? 'mgmt' : 'auto')}`);

			// Management connections: no session, just here to receive broadcasts
			if (isManagement) {
				const pingInterval = setInterval(() => {
					if (ws.readyState === WebSocket.OPEN) ws.ping();
				}, 30_000);
				ws.on('message', (data) => {
					try { if (JSON.parse(data.toString()).type === 'ping') ws.send('{"type":"pong"}'); } catch {}
				});
				ws.on('close', () => clearInterval(pingInterval));
				return;
			}

			// Resolve session — use requested ID, fall back to last session
			try {
				if (!sessionId) {
					sessionId = await this.pool.getLastSessionId();
				}
				if (!sessionId) {
					this.log(`[${clientId}] No session available, creating new`);
					const handle = await this.pool.create();
					sessionId = handle.sessionId;
				}
			} catch (e) {
				this.log(`[${clientId}] Session resolve error: ${e}`);
				ws.close(1011, 'Session error');
				return;
			}

			// Connect to the session — evict first if no other clients are watching
			// AND no turn is active, so we get a fresh snapshot with CLI messages.
			// Never evict during an active turn — that would abort the response.
			// Never evict a brand-new session (isNew=true) — it was just created by this
			// portal client and has no CLI history to sync; evicting it would disconnect
			// the session before it's ever been saved, causing a session_not_found error.
			let handle;
			try {
				const existing = this.pool.getHandle(sessionId);
				if (existing && existing.listenerCount === 0 && !existing.turnActive && !existing.isNew) {
					await this.pool.evict(sessionId);
				}
				handle = await this.pool.connect(sessionId);
			} catch (e) {
				this.log(`[${clientId}] Connect error: ${e}`);
				const msg = String(e);
				const isNotFound = msg.includes('Session not found') || msg.includes('not found');
				if (isNotFound && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: 'session_not_found', sessionId }));
				}
				ws.close(isNotFound ? 4404 : 1011, msg);
				return;
			}

			// Per-client event listener — routes session events to this WS only.
			// cancelled is set synchronously when the WS closes so any in-flight
			// async work (e.g. getHistory) never sends data to a closed/stale connection.
			let cancelled = false;
			const listener = (event: PortalEvent) => {
				if (!cancelled && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
			};
			handle.addListener(listener);

			// Notify client of confirmed session ID + session context (cwd, git info)
			if (!cancelled && ws.readyState === WebSocket.OPEN) {
				const sessions = await this.pool.listSessions().catch(() => []);
				const meta = sessions.find(s => s.sessionId === sessionId);
				ws.send(JSON.stringify({ type: 'session_switched', sessionId, context: meta?.context ?? null, summary: meta?.summary ?? null, model: handle.currentModel ?? null }));

				// For brand-new sessions the CLI subprocess may not have written cwd yet —
				// retry with increasing delays until context arrives or we give up.
				if (!meta?.context) {
					const retryDelays = [1000, 2000, 3000];
					const tryContext = async (attempt: number) => {
						if (cancelled || ws.readyState !== WebSocket.OPEN) return;
						const sessions2 = await this.pool.listSessions().catch(() => []);
						const meta2 = sessions2.find(s => s.sessionId === sessionId);
						if (meta2?.context) {
							ws.send(JSON.stringify({ type: 'session_context_updated', sessionId, context: meta2.context }));
						} else if (attempt < retryDelays.length - 1) {
							setTimeout(() => tryContext(attempt + 1), retryDelays[attempt + 1]);
						}
					};
					setTimeout(() => tryContext(0), retryDelays[0]);
				}
			}

			// Replay history + pending requests.
			// We capture sessionId at this point — it never changes for this connection.
			const historySessionId = sessionId;
			handle.getHistory(historyLimit).then((events) => {
				if (cancelled || ws.readyState !== WebSocket.OPEN) return;
				ws.send(JSON.stringify({ type: 'history_start', sessionId: historySessionId }));
				for (const e of events) {
					if (cancelled) return; // stop mid-send if connection drops
					ws.send(JSON.stringify(e));
				}
				if (cancelled) return;
				ws.send(JSON.stringify({ type: 'history_end', sessionId: historySessionId }));
				// Catch up new client on any in-progress turn (thinking/streaming)
				const activeTurnEvents = handle.getActiveTurnEvents();
				this.log('[' + clientId + '] Active turn events: ' + (activeTurnEvents.map(e => e.type).join(', ') || 'none') + ' (isTurnActive=' + handle.turnActive + ')');
				for (const e of activeTurnEvents) ws.send(JSON.stringify(e));
				for (const e of handle.getPendingApprovalEvents()) ws.send(JSON.stringify(e));
				for (const e of handle.getPendingInputEvents()) ws.send(JSON.stringify(e));
				for (const e of handle.getCliPendingEvents()) ws.send(JSON.stringify(e));
				// Send current approval rules and approveAll state for this session
				ws.send(JSON.stringify({ type: 'rules_list', rules: handle.getRulesList() }));
				ws.send(JSON.stringify({ type: 'approve_all_changed', approveAll: handle.getApproveAll() }));
			}).catch((e) => this.log(`[${clientId}] History error: ${e}`));

			// Keep-alive ping every 30s
			const pingInterval = setInterval(() => {
				if (!cancelled && ws.readyState === WebSocket.OPEN) ws.ping();
			}, 30_000);

			ws.on('message', (data) => {
				const str = data.toString();
				// Application-level heartbeat — browser WS API doesn't expose protocol pings
				if (str === '{"type":"ping"}') { ws.send('{"type":"pong"}'); return; }
				this.handleMessage(str, clientId, handle);
			});
			ws.on('error', (err) => this.log(`[${clientId}] Error: ${err.message}`));
			ws.on('close', (code, reason) => {
				cancelled = true; // prevent any pending async sends for this connection
				clearInterval(pingInterval);
				handle.removeListener(listener);
				this.log(`[${clientId}] Disconnected (code: ${code})`);
			});
		});
	}

	private handleMessage(
		raw: string,
		clientId: string,
		handle: Awaited<ReturnType<SessionPool['connect']>>,
	) {
		try {
			const msg = JSON.parse(raw) as {
				type: string;
				content?: string;
				requestId?: string;
				approved?: boolean;
				answer?: string;
				wasFreeform?: boolean;
				kind?: string;
				pattern?: string;
				ruleId?: string;
			};
			if (msg.type === 'prompt' && msg.content) {
				this.log(`[${clientId}] Prompt: ${msg.content.slice(0, 80)}`);
				handle.send(msg.content).catch((e) => {
					if (handle.listenerCount > 0) {
						// Use the private broadcast via the event
					}
					this.log(`[${clientId}] Send error: ${e}`);
				});
			} else if (msg.type === 'stop') {
				handle.abort();
			} else if (msg.type === 'set_model' && msg.content) {
				handle.setModel(msg.content).catch((e) => this.log(`[${clientId}] setModel error: ${e}`));
			} else if (msg.type === 'approval_response' && msg.requestId != null) {
				handle.resolveApproval(msg.requestId, msg.approved ?? false);
			} else if (msg.type === 'approval_response_always' && msg.requestId != null && msg.kind && msg.pattern) {
				handle.resolveApproval(msg.requestId, true);
				handle.addRule(msg.kind, msg.pattern);
				this.log(`[${clientId}] Rule added: ${msg.kind} "${msg.pattern}"`);
			} else if (msg.type === 'rule_delete' && msg.ruleId) {
				handle.removeRule(msg.ruleId);
				this.log(`[${clientId}] Rule deleted: ${msg.ruleId}`);
			} else if (msg.type === 'rules_clear') {
				handle.clearRules();
				this.log(`[${clientId}] Rules cleared`);
			} else if (msg.type === 'set_approve_all' && msg.approveAll != null) {
				handle.setApproveAll(!!msg.approveAll);
				this.log(`[${clientId}] approveAll: ${msg.approveAll}`);
			} else if (msg.type === 'input_response' && msg.requestId != null) {
				handle.resolveUserInput(msg.requestId, msg.answer ?? '', msg.wasFreeform ?? true);
			} else {
				this.log(`[${clientId}] Unknown message: ${msg.type}`);
			}
		} catch (e) {
			this.log(`[${clientId}] Parse error: ${e}`);
		}
	}

	private loadShields(): void {
		try {
			const f = path.join(this.dataDir, 'session-shields.json');
			if (fs.existsSync(f)) this.shields = JSON.parse(fs.readFileSync(f, 'utf8'));
		} catch {}
	}

	private saveShields(): void {
		try {
			fs.mkdirSync(this.dataDir, { recursive: true });
			fs.writeFileSync(path.join(this.dataDir, 'session-shields.json'), JSON.stringify(this.shields, null, 2));
		} catch {}
	}


	private log(msg: string) {
		const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		const line = `[${ts}] ${msg}`;
		process.stdout.write(line + '\n');
		this.logStream?.write(line + '\n');
	}

	private loadOrCreateToken(): string {
		const tokenFile = path.join(this.dataDir, 'token.txt');
		try {
			if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim();
		} catch {}
		const token = crypto.randomBytes(16).toString('hex');
		try {
			fs.mkdirSync(this.dataDir, { recursive: true });
			fs.writeFileSync(tokenFile, token);
		} catch {}
		return token;
	}

	private checkToken(url: URL, req?: http.IncomingMessage): boolean {
		if (url.searchParams.get('token') === this.token) return true;
		const auth = req?.headers['authorization'] ?? '';
		return auth === `Bearer ${this.token}`;
	}

	private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const method = req.method ?? 'GET';

		// API routes — require token
		if (url.pathname.startsWith('/api/')) {
			if (!this.checkToken(url, req)) { res.writeHead(401); res.end('Unauthorized'); return; }
		}

		if (url.pathname === '/api/info' && method === 'GET') {
			this.sendJson(res, 200, this.portalInfo ?? { version: 'unknown', login: 'unknown', models: [] });
			return;
		}

		if (url.pathname === '/api/models' && method === 'GET') {
			try {
				const allModels = await this.pool.listModels();
				const models = allModels
					.filter(m => !m.policy || m.policy.state === 'enabled')
					.map(m => ({ id: m.id, name: m.name }));
				if (this.portalInfo) this.portalInfo = { ...this.portalInfo, models };
				this.sendJson(res, 200, models);
			} catch {
				this.sendJson(res, 200, this.portalInfo?.models ?? []);
			}
			return;
		}

		if (url.pathname === '/api/sessions' && method === 'GET') {
			try {
				const sessions = await this.pool.listSessions();
				this.sendJson(res, 200, sessions.map(s => ({ ...s, shielded: this.shields[s.sessionId] ?? false })));
			} catch (e) {
				this.sendJson(res, 500, { error: String(e) });
			}
			return;
		}

		const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
		if (sessionMatch && method === 'DELETE') {
			const sessionId = sessionMatch[1];
			if (this.shields[sessionId]) {
				this.sendJson(res, 403, { error: 'Session is shielded' });
				return;
			}
			try {
				await this.pool.deleteSession(sessionId);
				this.broadcastAll({ type: 'session_deleted', sessionId });
				this.sendJson(res, 200, { ok: true });
				this.log(`[API] Deleted session: ${sessionId.slice(0, 8)}`);
			} catch (e) {
				this.sendJson(res, 500, { error: String(e) });
			}
			return;
		}

		const shieldMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/shield$/);
		if (shieldMatch && method === 'PATCH') {
			const sessionId = shieldMatch[1];
			this.shields[sessionId] = !this.shields[sessionId];
			if (!this.shields[sessionId]) delete this.shields[sessionId];
			this.saveShields();
			const shielded = this.shields[sessionId] ?? false;
			this.broadcastAll({ type: 'session_shield_changed', sessionId, shielded });
			this.sendJson(res, 200, { shielded });
			this.log(`[API] Session ${sessionId.slice(0, 8)} ${shielded ? 'shielded' : 'unshielded'}`);
			return;
		}


		if (url.pathname === '/api/sessions' && method === 'POST') {
			const body = await this.readBody(req);
			const { sessionId } = JSON.parse(body || '{}') as { sessionId?: string };
			try {
				if (sessionId) {
					// Pre-warm: connect to the session so it's ready when client navigates
					await this.pool.connect(sessionId);
					this.sendJson(res, 200, { sessionId });
				} else {
					const handle = await this.pool.create();
					const newId = handle.sessionId;
					// Broadcast so other clients' pickers update
					const sessions = await this.pool.listSessions().catch(() => []);
					const shields = this.loadShields();
					const newSession = sessions.find(s => s.sessionId === newId);
					if (newSession) {
						this.broadcastAll({ type: 'session_created', session: { ...newSession, shielded: this.shields[newId] ?? false } });
					}
					this.sendJson(res, 201, { sessionId: newId });
				}
			} catch (e) {
				this.sendJson(res, 500, { error: String(e) });
			}
			return;
		}

		// --- Update management endpoints ---

		if (url.pathname === '/api/updates' && method === 'GET') {
			this.sendJson(res, 200, this.updater.getStatus());
			return;
		}

		if (url.pathname === '/api/updates/check' && method === 'POST') {
			const status = await this.updater.check();
			this.sendJson(res, 200, status);
			return;
		}

		if (url.pathname === '/api/updates/apply' && method === 'POST') {
			if (this.updater.getStatus().applying) {
				this.sendJson(res, 409, { error: 'Update already in progress' });
				return;
			}
			const status = await this.updater.apply();
			this.sendJson(res, 200, status);
			return;
		}

		if (url.pathname === '/api/restart' && method === 'POST') {
			// Check for active turns across all sessions
			const activeSessions = this.pool.getActiveTurnSessions();

			const body = await this.readBody(req).catch(() => '{}');
			const { force } = JSON.parse(body || '{}') as { force?: boolean };

			if (activeSessions.length > 0 && !force) {
				this.sendJson(res, 409, {
					error: 'Active turns in progress',
					activeSessions: activeSessions.map(id => id.slice(0, 8)),
					message: 'Sessions have active turns. Wait for them to finish or use force:true to restart anyway.',
				});
				return;
			}

			this.sendJson(res, 200, { ok: true, message: 'Restarting...' });
			this.log('[Update] Restart requested — graceful shutdown...');

			// Notify all connected clients that a restart is imminent
			this.broadcastAll({ type: 'info', content: 'Server restarting…' });

			// Graceful shutdown: stop pool (disconnects sessions), close HTTP, exit with restart code
			setTimeout(async () => {
				await this.stop();
				process.exit(75);
			}, 500); // small delay so the HTTP response and broadcast can flush
			return;
		}

		if (url.pathname === '/' || url.pathname === '/index.html') {
			if (!this.checkToken(url, req)) {
				res.writeHead(401, { 'Content-Type': 'text/html' });
				res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:4em"><h2>Access Denied</h2><p>A valid <code>?token=</code> is required. Check the server console for the URL.</p></body></html>');
				return;
			}
			const indexPath = path.join(this.webuiPath, 'index.html');
			fs.readFile(indexPath, 'utf8', (err, html) => {
				if (err) { res.writeHead(404); res.end('Web UI not built.'); return; }
				res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
				res.end(html);
			});
			return;
		}

		const filePath = path.normalize(path.join(this.webuiPath, url.pathname));
		if (!filePath.startsWith(this.webuiPath)) {
			res.writeHead(403); res.end('Forbidden'); return;
		}
		fs.readFile(filePath, (err, data) => {
			if (err) { res.writeHead(404); res.end('Not found'); return; }
			const mime: Record<string, string> = {
				'.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
				'.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
			};
			res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] ?? 'application/octet-stream' });
			res.end(data);
		});
	}

	private sendJson(res: http.ServerResponse, status: number, body: unknown) {
		const data = JSON.stringify(body);
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(data);
	}

	private readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on('data', (c: Buffer) => {
				size += c.length;
				if (size > 1024 * 1024) { req.destroy(); reject(new Error('Request body too large')); return; }
				chunks.push(c);
			});
			req.on('end', () => resolve(Buffer.concat(chunks).toString()));
		});
	}

	getLocalIP(): string {
		const nets = os.networkInterfaces();
		for (const name of Object.keys(nets)) {
			for (const net of nets[name] ?? []) {
				if (net.family === 'IPv4' && !net.internal) return net.address;
			}
		}
		return 'localhost';
	}

	getURL(): string {
		return `http://${this.getLocalIP()}:${this.port}?token=${this.token}`;
	}

	async start(): Promise<void> {
		this.loadShields();
		await this.pool.start();
		// Cache portal info (version, user, models) once at startup
		try {
			const [status, auth, allModels] = await Promise.all([
				this.pool.getStatus(),
				this.pool.getAuthStatus(),
				this.pool.listModels(),
			]);
			this.portalInfo = {
				version: status.version,
				login: auth.login ?? 'unknown',
				models: allModels
					.filter(m => !m.policy || m.policy.state === 'enabled')
					.map(m => ({ id: m.id, name: m.name })),
			};
			this.log(`[Pool] Models available: ${this.portalInfo.models.length}`);
		} catch (e) {
			this.log(`[Pool] Could not fetch portal info: ${e}`);
		}
		// Start periodic update checker
		this.updater.start();
		return new Promise((resolve, reject) => {
			this.httpServer.on('error', reject);
			this.httpServer.listen(this.port, '0.0.0.0', () => {
				this.initDebugFiles();
				this.log(`[Build] v${__VERSION__} build ${__BUILD__}`);
				this.log(`Server started on port ${this.port}`);
				this.log(`Open: ${this.getURL()}`);
				resolve();
			});
		});
	}

	private initDebugFiles() {
		try {
			if (!fs.existsSync(this.debugDir)) fs.mkdirSync(this.debugDir, { recursive: true });
			this.logStream = fs.createWriteStream(path.join(this.debugDir, 'server.log'), { flags: 'w' });
		} catch (e) {
			process.stderr.write(`[Debug] Could not init debug files: ${e}\n`);
		}
	}

	private broadcastAll(msg: object): void {
		const data = JSON.stringify(msg);
		for (const client of this.wss.clients) {
			if (client.readyState === WebSocket.OPEN) client.send(data);
		}
	}

	async stop(): Promise<void> {
		this.updater.stop();
		await this.pool.stop();
		// Forcefully close all open WebSocket connections so httpServer.close() doesn't hang
		for (const client of this.wss.clients) client.terminate();
		this.wss.close();
		// Close any lingering HTTP keep-alive connections (Node 18.2+)
		if (typeof (this.httpServer as NodeJS.EventEmitter & { closeAllConnections?: () => void }).closeAllConnections === 'function') {
			(this.httpServer as NodeJS.EventEmitter & { closeAllConnections: () => void }).closeAllConnections();
		}
		return new Promise((resolve) => {
			this.httpServer.close(() => {
				this.logStream?.end();
				this.logStream = null;
				resolve();
			});
		});
	}
}
