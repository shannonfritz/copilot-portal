import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionPool } from './session.js';
import { RulesStore } from './rules.js';
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

	constructor(private port: number) {
		this.webuiPath = path.join(__dirname, '..', 'dist', 'webui');
		this.debugDir = path.join(__dirname, '..', 'debug');
		this.dataDir = path.join(__dirname, '..', 'data');
		this.token = this.loadOrCreateToken();
		this.pool = new SessionPool((msg) => this.log(msg), new RulesStore(this.dataDir));

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
			const isManagement = url.searchParams.get('management') === '1';

			this.log(`[${clientId}] Connected from ${ip}, session=${sessionId?.slice(0, 8) ?? (isManagement ? 'mgmt' : 'auto')}`);

			// Management connections: no session, just here to receive broadcasts
			if (isManagement) {
				const pingInterval = setInterval(() => {
					if (ws.readyState === WebSocket.OPEN) ws.ping();
				}, 30_000);
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
			let handle;
			try {
				const existing = this.pool.getHandle(sessionId);
				if (existing && existing.listenerCount === 0 && !existing.turnActive) {
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

			// Per-client event listener — routes session events to this WS only
			const listener = (event: PortalEvent) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
			};
			handle.addListener(listener);

			// Notify client of confirmed session ID + session context (cwd, git info)
			if (ws.readyState === WebSocket.OPEN) {
				const sessions = await this.pool.listSessions().catch(() => []);
				const meta = sessions.find(s => s.sessionId === sessionId);
				ws.send(JSON.stringify({ type: 'session_switched', sessionId, context: meta?.context ?? null }));
			}

			// Replay history + pending requests
			handle.getHistory().then((events) => {
				if (ws.readyState !== WebSocket.OPEN) return;
				ws.send(JSON.stringify({ type: 'history_start' }));
				for (const e of events) ws.send(JSON.stringify(e));
				ws.send(JSON.stringify({ type: 'history_end' }));
				// Catch up new client on any in-progress turn (thinking/streaming)
				for (const e of handle.getActiveTurnEvents()) ws.send(JSON.stringify(e));
				for (const e of handle.getPendingApprovalEvents()) ws.send(JSON.stringify(e));
				for (const e of handle.getPendingInputEvents()) ws.send(JSON.stringify(e));
				// Send current approval rules for this session
				ws.send(JSON.stringify({ type: 'rules_list', rules: handle.getRulesList() }));
			}).catch((e) => this.log(`[${clientId}] History error: ${e}`));

			// Keep-alive ping every 30s
			const pingInterval = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.ping();
			}, 30_000);

			ws.on('message', (data) => this.handleMessage(data.toString(), clientId, handle));
			ws.on('error', (err) => this.log(`[${clientId}] Error: ${err.message}`));
			ws.on('close', (code, reason) => {
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
			} else if (msg.type === 'input_response' && msg.requestId != null) {
				handle.resolveUserInput(msg.requestId, msg.answer ?? '', msg.wasFreeform ?? true);
			} else {
				this.log(`[${clientId}] Unknown message: ${msg.type}`);
			}
		} catch (e) {
			this.log(`[${clientId}] Parse error: ${e}`);
		}
	}

	private loadShields(): Record<string, boolean> {
		try {
			const f = path.join(this.dataDir, 'session-shields.json');
			if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
		} catch {}
		return {};
	}

	private saveShields(shields: Record<string, boolean>): void {
		try {
			fs.mkdirSync(this.dataDir, { recursive: true });
			fs.writeFileSync(path.join(this.dataDir, 'session-shields.json'), JSON.stringify(shields, null, 2));
		} catch {}
	}

	private log(msg: string) {
		const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		const line = `[${ts}] ${msg}`;
		process.stdout.write(line + '\n');
		this.logStream?.write(line + '\n');
	}

	private loadOrCreateToken(): string {
		const tokenFile = path.join(this.debugDir, 'token.txt');
		try {
			if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim();
		} catch {}
		const token = crypto.randomBytes(16).toString('hex');
		try {
			fs.mkdirSync(this.debugDir, { recursive: true });
			fs.writeFileSync(tokenFile, token);
		} catch {}
		return token;
	}

	private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const method = req.method ?? 'GET';

		if (url.pathname === '/api/info' && method === 'GET') {
			this.sendJson(res, 200, this.portalInfo ?? { version: 'unknown', login: 'unknown', models: [] });
			return;
		}

		if (url.pathname === '/api/sessions' && method === 'GET') {
			try {
				const shields = this.loadShields();
				const sessions = await this.pool.listSessions();
				this.sendJson(res, 200, sessions.map(s => ({ ...s, shielded: shields[s.sessionId] ?? false })));
			} catch (e) {
				this.sendJson(res, 500, { error: String(e) });
			}
			return;
		}

		const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
		if (sessionMatch && method === 'DELETE') {
			const sessionId = sessionMatch[1];
			const shields = this.loadShields();
			if (shields[sessionId]) {
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
			const shields = this.loadShields();
			shields[sessionId] = !shields[sessionId];
			if (!shields[sessionId]) delete shields[sessionId];
			this.saveShields(shields);
			const shielded = shields[sessionId] ?? false;
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
						this.broadcastAll({ type: 'session_created', session: { ...newSession, shielded: shields[newId] ?? false } });
					}
					this.sendJson(res, 201, { sessionId: newId });
				}
			} catch (e) {
				this.sendJson(res, 500, { error: String(e) });
			}
			return;
		}

		if (url.pathname === '/' || url.pathname === '/index.html') {
			const indexPath = path.join(this.webuiPath, 'index.html');
			fs.readFile(indexPath, 'utf8', (err, html) => {
				if (err) { res.writeHead(404); res.end('Web UI not built.'); return; }
				const injected = html.replace(
					'</head>',
					`<script>window.__PORTAL_TOKEN__ = "${this.token}";</script></head>`,
				);
				res.writeHead(200, { 'Content-Type': 'text/html' });
				res.end(injected);
			});
			return;
		}

		const filePath = path.join(this.webuiPath, url.pathname);
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
		return new Promise((resolve) => {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c));
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
		return new Promise((resolve, reject) => {
			this.httpServer.on('error', reject);
			this.httpServer.listen(this.port, '0.0.0.0', () => {
				this.initDebugFiles();
				this.log(`[Build] ${__BUILD_TIME__}`);
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
			fs.writeFileSync(path.join(this.debugDir, 'connection.json'), JSON.stringify({
				url: `ws://${this.getLocalIP()}:${this.port}`,
				token: this.token,
				port: this.port,
				startedAt: new Date().toISOString(),
			}, null, 2));
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
		await this.pool.stop();
		this.wss.close();return new Promise((resolve) => {
			this.httpServer.close(() => {
				this.logStream?.end();
				this.logStream = null;
				try { fs.unlinkSync(path.join(this.debugDir, 'connection.json')); } catch {}
				resolve();
			});
		});
	}
}
