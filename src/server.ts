import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { WebSocketServer, WebSocket } from 'ws';
import { PortalAgent } from './agent';
import { showQRPanel } from './qrcode';

export class PortalServer {
	private httpServer: http.Server;
	private wss: WebSocketServer;
	private clients = new Set<WebSocket>();
	private token: string;
	private agent: PortalAgent;
	private webuiPath: string;

	constructor(
		private port: number,
		private context: vscode.ExtensionContext,
		private outputChannel: vscode.OutputChannel,
	) {
		this.token = crypto.randomBytes(16).toString('hex');
		this.webuiPath = path.join(context.extensionPath, 'dist', 'webui');
		this.agent = new PortalAgent((event) => this.broadcast(event), outputChannel);

		this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));

		this.wss = new WebSocketServer({
			server: this.httpServer,
			verifyClient: ({ req }, callback) => {
				const url = new URL(req.url ?? '/', 'http://localhost');
				const receivedToken = url.searchParams.get('token');
				if (receivedToken !== this.token) {
					this.log(`[Upgrade] Token mismatch — rejecting`);
					callback(false, 401, 'Unauthorized');
				} else {
					this.log(`[Upgrade] Token valid — accepting WebSocket`);
					callback(true);
				}
			},
		});

		this.wss.on('error', (err) => this.log(`[WS Server Error] ${err.message}`));

		this.wss.on('connection', (ws, req) => {
			this.log(`[WS] Phone connected from ${req.socket.remoteAddress}`);
			this.clients.add(ws);

			// Keep-alive ping every 30s to prevent iOS from dropping idle connections
			const pingInterval = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.ping();
			}, 30_000);

			ws.on('message', (data) => this.handleMessage(data.toString()));
			ws.on('error', (err) => this.log(`[WS] Client error: ${err.message}`));
			ws.on('close', (code, reason) => {
				clearInterval(pingInterval);
				this.clients.delete(ws);
				this.log(`[WS] Phone disconnected (code: ${code}, reason: ${reason.toString() || 'none'})`);
			});
		});
	}

	private log(msg: string) {
		const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		this.outputChannel.appendLine(`[${ts}] ${msg}`);
	}

	private handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
		const url = new URL(req.url ?? '/', `http://localhost`);

		// Serve index.html for root, injecting the token so the UI auto-connects
		if (url.pathname === '/' || url.pathname === '/index.html') {
			const indexPath = path.join(this.webuiPath, 'index.html');
			fs.readFile(indexPath, 'utf8', (err, html) => {
				if (err) {
					res.writeHead(404);
					res.end('Web UI not found. Run "npm run build:ui" first.');
					return;
				}
				// Inject token as a global so the UI can connect without it being in the URL
				const injected = html.replace(
					'</head>',
					`<script>window.__PORTAL_TOKEN__ = "${this.token}";</script></head>`,
				);
				res.writeHead(200, { 'Content-Type': 'text/html' });
				res.end(injected);
			});
			return;
		}

		// Serve other static assets
		const filePath = path.join(this.webuiPath, url.pathname);
		fs.readFile(filePath, (err, data) => {
			if (err) {
				res.writeHead(404);
				res.end('Not found');
				return;
			}
			const ext = path.extname(filePath);
			const mime: Record<string, string> = {
				'.html': 'text/html',
				'.js': 'application/javascript',
				'.css': 'text/css',
				'.ico': 'image/x-icon',
				'.png': 'image/png',
				'.svg': 'image/svg+xml',
				'.woff2': 'font/woff2',
			};
			res.writeHead(200, { 'Content-Type': mime[ext] ?? 'application/octet-stream' });
			res.end(data);
		});
	}

	private handleMessage(raw: string) {
		try {
			const msg = JSON.parse(raw) as { type: string; content?: string };
			if (msg.type === 'prompt' && msg.content) {
				this.log(`[Message] Prompt: ${msg.content.slice(0, 80)}`);
				this.agent.sendPrompt(msg.content);
			} else if (msg.type === 'stop') {
				this.log('[Message] Stop requested');
				this.agent.stop();
			} else {
				this.log(`[Message] Unknown type: ${msg.type}`);
			}
		} catch (e) {
			this.log(`[Message] Parse error: ${e}`);
		}
	}

	broadcast(event: object) {
		const data = JSON.stringify(event);
		for (const client of this.clients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(data);
			}
		}
	}

	getLocalIP(): string {
		const nets = os.networkInterfaces();
		for (const name of Object.keys(nets)) {
			for (const net of nets[name] ?? []) {
				if (net.family === 'IPv4' && !net.internal) {
					return net.address;
				}
			}
		}
		return 'localhost';
	}

	getURL(): string {
		return `http://${this.getLocalIP()}:${this.port}?token=${this.token}`;
	}

	showQRCode(context: vscode.ExtensionContext) {
		showQRPanel(context, this.getURL());
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.httpServer.on('error', reject);
			this.httpServer.listen(this.port, '0.0.0.0', () => {
				this.log(`[Build] ${__BUILD_TIME__}`);
				resolve();
			});
		});
	}

	stop(): Promise<void> {
		return new Promise((resolve) => {
			for (const client of this.clients) client.terminate();
			this.clients.clear();
			this.wss.close();
			this.httpServer.close(() => resolve());
		});
	}
}
