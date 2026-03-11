import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionManager } from './session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class PortalServer {
	private httpServer: http.Server;
	private wss: WebSocketServer;
	private clients = new Set<WebSocket>();
	private token: string;
	private sessions: SessionManager;
	private webuiPath: string;
	private clientCounter = 0;
	private logStream: fs.WriteStream | null = null;
	private debugDir: string;

	constructor(private port: number) {
		this.token = crypto.randomBytes(16).toString('hex');
		this.webuiPath = path.join(__dirname, '..', 'dist', 'webui');
		this.debugDir = path.join(__dirname, '..', 'debug');
		this.sessions = new SessionManager(
			(event) => this.broadcast(event),
			(msg) => this.log(msg),
		);

		this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));

		this.wss = new WebSocketServer({
			server: this.httpServer,
			perMessageDeflate: false, // fixes iOS Safari 1006/1001 drops
			verifyClient: ({ req }, callback) => {
				const url = new URL(req.url ?? '/', 'http://localhost');
				const t = url.searchParams.get('token');
				if (t !== this.token) {
					this.log(`[Upgrade] Token mismatch — rejecting`);
					callback(false, 401, 'Unauthorized');
				} else {
					this.log(`[Upgrade] Token valid — accepting WebSocket`);
					callback(true);
				}
			},
		});

		this.wss.on('error', (err) => this.log(`[WS Error] ${err.message}`));

		this.wss.on('connection', (ws, req) => {
			const clientId = `C${++this.clientCounter}`;
			const ip = req.socket.remoteAddress ?? 'unknown';
			this.log(`[${clientId}] Connected from ${ip}`);
			this.clients.add(ws);

			// Replay history to the new client
			this.sessions.getHistory().then((events) => {
				if (ws.readyState !== WebSocket.OPEN) return;
				ws.send(JSON.stringify({ type: 'history_start' }));
				for (const e of events) ws.send(JSON.stringify(e));
				ws.send(JSON.stringify({ type: 'history_end' }));
			}).catch((e) => this.log(`[${clientId}] History error: ${e}`));

			// Keep-alive ping every 30s
			const pingInterval = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.ping();
			}, 30_000);

			ws.on('message', (data) => this.handleMessage(data.toString(), clientId));
			ws.on('error', (err) => this.log(`[${clientId}] Error: ${err.message}`));
			ws.on('close', (code, reason) => {
				clearInterval(pingInterval);
				this.clients.delete(ws);
				this.log(`[${clientId}] Disconnected (code: ${code}, reason: ${reason.toString() || 'none'})`);
			});
		});
	}

	private log(msg: string) {
		const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		const line = `[${ts}] ${msg}`;
		process.stdout.write(line + '\n');
		this.logStream?.write(line + '\n');
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

	private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
		const url = new URL(req.url ?? '/', `http://localhost`);
		const method = req.method ?? 'GET';

		// ── REST API ────────────────────────────────────────────────────────────
		if (url.pathname === '/api/sessions' && method === 'GET') {
			try {
				const list = await this.sessions.listSessions();
				this.sendJson(res, 200, list);
			} catch (e) {
				this.sendJson(res, 500, { error: String(e) });
			}
			return;
		}

		if (url.pathname === '/api/sessions' && method === 'POST') {
			const body = await this.readBody(req);
			const { sessionId } = JSON.parse(body || '{}') as { sessionId?: string };
			try {
				if (sessionId) {
					await this.sessions.resumeSession(sessionId);
					this.sendJson(res, 200, { sessionId });
				} else {
					const newId = await this.sessions.newSession();
					this.sendJson(res, 201, { sessionId: newId });
				}
			} catch (e) {
				this.sendJson(res, 500, { error: String(e) });
			}
			return;
		}

		// ── Static web UI ───────────────────────────────────────────────────────
		if (url.pathname === '/' || url.pathname === '/index.html') {
			const indexPath = path.join(this.webuiPath, 'index.html');
			fs.readFile(indexPath, 'utf8', (err, html) => {
				if (err) { res.writeHead(404); res.end('Web UI not built. Run npm run build:ui'); return; }
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

	private handleMessage(raw: string, clientId: string) {
		try {
			const msg = JSON.parse(raw) as { type: string; content?: string; requestId?: string; approved?: boolean };
			if (msg.type === 'prompt' && msg.content) {
				this.log(`[${clientId}] Prompt: ${msg.content.slice(0, 80)}`);
				this.sessions.sendPrompt(msg.content).catch((e) => {
					this.broadcast({ type: 'error', content: String(e) });
				});
			} else if (msg.type === 'stop') {
				this.log(`[${clientId}] Stop requested`);
				this.sessions.abort();
			} else if (msg.type === 'approval_response' && msg.requestId != null) {
				this.log(`[${clientId}] Approval ${msg.approved ? 'granted' : 'denied'}: ${msg.requestId}`);
				this.sessions.resolveApproval(msg.requestId, msg.approved ?? false);
			} else {
				this.log(`[${clientId}] Unknown message: ${msg.type}`);
			}
		} catch (e) {
			this.log(`[${clientId}] Parse error: ${e}`);
		}
	}

	broadcast(event: object) {
		const data = JSON.stringify(event);
		for (const client of this.clients) {
			if (client.readyState === WebSocket.OPEN) client.send(data);
		}
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
		await this.sessions.start();
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

	async stop(): Promise<void> {
		await this.sessions.stop();
		for (const client of this.clients) client.terminate();
		this.clients.clear();
		this.wss.close();
		return new Promise((resolve) => {
			this.httpServer.close(() => {
				this.logStream?.end();
				this.logStream = null;
				try { fs.unlinkSync(path.join(this.debugDir, 'connection.json')); } catch {}
				resolve();
			});
		});
	}
}
