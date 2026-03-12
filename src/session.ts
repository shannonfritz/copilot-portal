import { CopilotClient } from '@github/copilot-sdk';
import type { CopilotSession } from '@github/copilot-sdk';
import type {
	SessionMetadata,
	SessionContext,
	PermissionRequest,
	PermissionRequestResult,
	UserInputRequest,
	UserInputResponse,
} from '@github/copilot-sdk';

export type { SessionMetadata };

export interface PortalInfo {
	version: string;
	login: string;
	models: Array<{ id: string; name: string }>;
}

export interface PortalEvent {
	type: 'delta' | 'idle' | 'error' | 'approval_request' | 'approval_resolved' | 'input_request' | 'tool_call' | 'tool_start' | 'tool_complete' | 'intent' | 'session_switched' | 'session_not_found' | 'thinking' | 'reasoning_delta' | 'sync' | 'model_changed';
	content?: string;
	role?: 'user' | 'assistant';
	requestId?: string;
	approval?: { requestId: string; action: string; summary: string; details: unknown };
	inputRequest?: { requestId: string; question: string; choices?: string[]; allowFreeform?: boolean };
	sessionId?: string;
	context?: SessionContext | null;
	model?: string;
	toolCallId?: string;
	toolName?: string;
	mcpServerName?: string;
}

type PendingApproval = {
	resolve: (r: PermissionRequestResult) => void;
	reject: (e: Error) => void;
	event: PortalEvent;
};

type PendingInput = {
	resolve: (r: UserInputResponse) => void;
	reject: (e: Error) => void;
	event: PortalEvent;
};

/** Wraps one CopilotSession and fans events out to multiple WS listeners. */
export class SessionHandle {
	readonly sessionId: string;
	private session: CopilotSession;
	private listeners = new Set<(e: PortalEvent) => void>();
	private pendingApprovals = new Map<string, PendingApproval>();
	private pendingInputs = new Map<string, PendingInput>();
	private counter = 0;
	private log: (msg: string) => void;
	private lastSyncedCount = 0;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private sessionGeneration = 0;
	private isReconnecting = false;
	private reconnectFn: ((id: string) => Promise<CopilotSession>) | null = null;
	private getModTimeFn: (() => Promise<Date | null>) | null = null;
	private lastKnownModTime: Date | null = null;

	// Active turn state — replayed to newly joining clients
	private isTurnActive = false;
	private activeDeltaBuffer = '';
	private activeReasoningBuffer = '';

	constructor(
		session: CopilotSession,
		log: (msg: string) => void,
		reconnectFn?: (id: string) => Promise<CopilotSession>,
		getModTimeFn?: () => Promise<Date | null>,
	) {
		this.sessionId = session.sessionId;
		this.session = session;
		this.log = log;
		this.reconnectFn = reconnectFn ?? null;
		this.getModTimeFn = getModTimeFn ?? null;
		this.attachListeners();
	}

	addListener(fn: (e: PortalEvent) => void): void {
		this.listeners.add(fn);
		if (this.listeners.size === 1) this.startPoll();
	}

	removeListener(fn: (e: PortalEvent) => void): void {
		this.listeners.delete(fn);
		if (this.listeners.size === 0) {
			this.stopPoll();
			// Only deny pending approvals if no turn is active — if a turn is
			// running we want it to complete so the user can see the result on reconnect
			if (!this.isTurnActive) this.denyAllPending();
		}
	}

	get listenerCount(): number { return this.listeners.size; }
	get turnActive(): boolean { return this.isTurnActive; }

	/** Events to send to a newly joining client to catch up on an in-progress turn. */
	getActiveTurnEvents(): PortalEvent[] {
		if (!this.isTurnActive) return [];
		const events: PortalEvent[] = [{ type: 'thinking', content: '' }];
		if (this.activeReasoningBuffer) events.push({ type: 'reasoning_delta', content: this.activeReasoningBuffer });
		if (this.activeDeltaBuffer) events.push({ type: 'delta', content: this.activeDeltaBuffer });
		return events;
	}

	private broadcast(event: PortalEvent): void {
		for (const fn of this.listeners) fn(event);
	}

	async getHistory(): Promise<PortalEvent[]> {
		const events = await this.session.getMessages();
		this.log(`[History] ${events.length} events: ${events.map((e: { type: string }) => e.type).join(', ').slice(0, 200)}`);
		const result: PortalEvent[] = [];
		for (const e of events) {
			if (e.type === 'user.message') {
				result.push({ type: 'delta', content: `__USER__${e.data?.content ?? ''}` });
				result.push({ type: 'idle' });
			} else if (e.type === 'assistant.message') {
				result.push({ type: 'delta', content: e.data?.content ?? '' });
				result.push({ type: 'idle' });
			}
		}
		return result;
	}

	private startPoll(): void {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => { void this.pollForChanges(); }, 2000);
	}

	private stopPoll(): void {
		if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
	}

	private async pollForChanges(): Promise<void> {
		if (this.listeners.size === 0 || this.isTurnActive || this.isReconnecting) return;
		void this.syncMessages();
		if (!this.getModTimeFn) return;
		try {
			const modTime = await this.getModTimeFn();
			if (modTime === null) return;
			if (this.lastKnownModTime === null) {
				this.lastKnownModTime = modTime; // seed on first poll, no reconnect
			} else if (modTime > this.lastKnownModTime) {
				this.lastKnownModTime = modTime;
				void this.reconnectFromCli();
			}
		} catch (_) { /* ignore */ }
	}

	private async syncMessages(): Promise<void> {
		if (this.listeners.size === 0) return;
		try {
			const msgs = await this.session.getMessages();
			const interesting = msgs.filter((m: {type:string}) => m.type === 'user.message' || m.type === 'assistant.message');
			if (interesting.length <= this.lastSyncedCount) return;
			const newMsgs = interesting.slice(this.lastSyncedCount);
			this.log(`[Sync] ${newMsgs.length} new message(s) (total ${interesting.length})`);
			for (const msg of newMsgs) {
				const role = msg.type === 'user.message' ? 'user' : 'assistant';
				const content = (msg.data as { content?: string })?.content ?? '';
				if (content) this.broadcast({ type: 'sync', role, content });
			}
			this.lastSyncedCount = interesting.length;
		} catch (e) {
			this.log(`[Sync] Error: ${e}`);
		}
	}

	/** Called when session modifiedTime advances without a portal turn — CLI sent messages. */
	private async reconnectFromCli(): Promise<void> {
		if (this.isReconnecting || !this.reconnectFn || this.listeners.size === 0) return;
		this.isReconnecting = true;
		this.log('[Sync] External change detected — refreshing connection for CLI messages...');
		try {
			const gen = ++this.sessionGeneration;
			const oldSession = this.session;
			// Disconnect old IPC connection first — forces a fresh cursor on reconnect
			await oldSession.disconnect().catch(() => {});
			const newSession = await this.reconnectFn(this.sessionId);
			if (this.sessionGeneration !== gen) return; // concurrent reconnect won the race
			this.session = newSession;
			this.attachListeners();
			const msgs = await this.session.getMessages();
			this.log(`[Sync] Post-reconnect getMessages: ${msgs.length} (lastSyncedCount=${this.lastSyncedCount})`);
			await this.syncMessages();
			// Re-seed modTime AFTER reconnect since resumeSession() itself updates it
			if (this.getModTimeFn) {
				const t = await this.getModTimeFn().catch(() => null);
				if (t) this.lastKnownModTime = t;
			}
		} catch (e) {
			this.log(`[Sync] CLI reconnect error: ${e}`);
		} finally {
			this.isReconnecting = false;
		}
	}

		async send(prompt: string): Promise<void> {
		this.log(`[${this.sessionId.slice(0, 8)}] Sending prompt (${prompt.length} chars)`);
		await this.session.send({ prompt });
	}

	async abort(): Promise<void> {
		await this.session.abort();
	}

	async setModel(model: string): Promise<void> {
		await this.session.setModel(model);
		this.log(`[Session] Model changed to: ${model}`);
		this.broadcast({ type: 'model_changed', model });
	}

	async disconnect(): Promise<void> {
		await this.session.disconnect().catch(() => {});
	}

	getPendingApprovalEvents(): PortalEvent[] {
		return Array.from(this.pendingApprovals.values()).map(p => p.event);
	}

	getPendingInputEvents(): PortalEvent[] {
		return Array.from(this.pendingInputs.values()).map(p => p.event);
	}

	denyAllPending(): void {
		for (const [id, p] of this.pendingApprovals) {
			this.log(`[Session] Auto-denying approval ${id}`);
			this.pendingApprovals.delete(id);
			p.resolve({ kind: 'denied-interactively-by-user' });
		}
		for (const [id, p] of this.pendingInputs) {
			this.log(`[Session] Auto-cancelling input ${id}`);
			this.pendingInputs.delete(id);
			p.reject(new Error('No clients connected'));
		}
	}

	resolveApproval(requestId: string, approved: boolean): void {
		const p = this.pendingApprovals.get(requestId);
		if (!p) return;
		this.pendingApprovals.delete(requestId);
		p.resolve(approved ? { kind: 'approved' } : { kind: 'denied-interactively-by-user' });
		this.log(`[Session] Approval ${approved ? 'granted' : 'denied'}: ${requestId}`);
		// Tell all clients to dismiss this approval card
		this.broadcast({ type: 'approval_resolved', requestId });
	}

	resolveUserInput(requestId: string, answer: string, wasFreeform: boolean): void {
		const p = this.pendingInputs.get(requestId);
		if (!p) return;
		this.pendingInputs.delete(requestId);
		p.resolve({ answer, wasFreeform });
		this.log(`[Session] Input answered: "${answer.slice(0, 40)}"`);
		// Tell all clients to dismiss this input card
		this.broadcast({ type: 'approval_resolved', requestId });
	}

	handlePermissionRequest(req: PermissionRequest): Promise<PermissionRequestResult> {
		const requestId = `approval-${++this.counter}`;
		this.log(`[Session] Permission request: ${JSON.stringify(req).slice(0, 200)}`);
		const r = req as PermissionRequest & { fullCommandText?: string; path?: string; url?: string; toolName?: string };
		const summary = r.fullCommandText ?? r.path ?? r.url ?? r.toolName ?? r.kind;
		const event: PortalEvent = {
			type: 'approval_request',
			requestId,
			approval: { requestId, action: r.kind, details: req, summary },
		};
		this.broadcast(event);
		return new Promise((resolve, reject) => {
			this.pendingApprovals.set(requestId, { resolve, reject, event });
			setTimeout(() => {
				if (this.pendingApprovals.has(requestId)) {
					this.pendingApprovals.delete(requestId);
					resolve({ kind: 'denied-interactively-by-user', feedback: 'Timed out' });
				}
			}, 5 * 60 * 1000);
		});
	}

	handleUserInputRequest(req: UserInputRequest): Promise<UserInputResponse> {
		const requestId = `input-${++this.counter}`;
		this.log(`[Session] Input request: "${req.question.slice(0, 80)}"`);
		const event: PortalEvent = {
			type: 'input_request',
			requestId,
			inputRequest: { requestId, question: req.question, choices: req.choices, allowFreeform: req.allowFreeform },
		};
		this.broadcast(event);
		return new Promise((resolve, reject) => {
			this.pendingInputs.set(requestId, { resolve, reject, event });
			setTimeout(() => {
				if (this.pendingInputs.has(requestId)) {
					this.pendingInputs.delete(requestId);
					reject(new Error('Input timed out'));
				}
			}, 5 * 60 * 1000);
		});
	}

	private attachListeners(): void {
		const gen = this.sessionGeneration;
		let deltasSent = false;
		let toolsInFlight = 0;
		this.session.on((event) => {
			if (this.sessionGeneration !== gen) return; // stale listener from old connection
			this.log(`[Event] ${event.type}`);
			if (event.type === 'assistant.turn_start') {
				this.isTurnActive = true;
				this.activeDeltaBuffer = '';
				this.activeReasoningBuffer = '';
				this.broadcast({ type: 'thinking', content: '' });
			} else if (event.type === 'assistant.intent') {
				const intent = (event.data as { intent?: string }).intent ?? '';
				if (intent) this.broadcast({ type: 'intent', content: intent });
			} else if (event.type === 'session.title_changed') {
				void this.syncMessages();
			} else if (event.type === 'assistant.reasoning_delta') {
				const delta = (event.data as { deltaContent?: string }).deltaContent ?? '';
				if (delta) {
					this.activeReasoningBuffer += delta;
					this.broadcast({ type: 'reasoning_delta', content: delta });
				}
			} else if (event.type === 'assistant.message_delta') {
				const delta = (event.data as { deltaContent?: string }).deltaContent ?? '';
				if (delta) {
					deltasSent = true;
					this.activeDeltaBuffer += delta;
					this.broadcast({ type: 'delta', content: delta });
				}
			} else if (event.type === 'assistant.message') {
				const content = (event.data as { content?: string }).content ?? '';
				this.log(`[Session] Assistant message: ${content.slice(0, 200)}`);
				if (!deltasSent) {
					if (content) this.broadcast({ type: 'delta', content });
				}
				deltasSent = false;
			} else if (event.type === 'tool.execution_start') {
				toolsInFlight++;
				const d = event.data as { toolCallId?: string; toolName?: string; mcpServerName?: string; arguments?: unknown };
				this.log(`[Session] Tool start (${toolsInFlight} in flight): ${d.toolName}`);
				this.broadcast({ type: 'tool_start', toolCallId: d.toolCallId, toolName: d.toolName, mcpServerName: d.mcpServerName, content: JSON.stringify(d.arguments ?? {}) });
			} else if (event.type === 'tool.execution_complete') {
				toolsInFlight = Math.max(0, toolsInFlight - 1);
				const d = event.data as { toolCallId?: string; success?: boolean };
				this.log(`[Session] Tool complete (${toolsInFlight} remaining): ${d.toolCallId}`);
				this.broadcast({ type: 'tool_complete', toolCallId: d.toolCallId, content: d.success ? 'success' : 'failed' });
			} else if (event.type === 'tool.execution_partial_result') {
				const d = event.data as { toolCallId?: string; output?: string };
				if (d.output) this.broadcast({ type: 'tool_call', toolCallId: d.toolCallId, content: d.output });
			} else if (event.type === 'session.idle') {
				this.isTurnActive = false;
				this.activeDeltaBuffer = '';
				this.activeReasoningBuffer = '';
				if (toolsInFlight === 0) {
					this.broadcast({ type: 'idle' });
					void this.syncMessages();
				} else {
					this.log(`[Event] session.idle suppressed (${toolsInFlight} tools in flight)`);
				}
			} else if (event.type === 'session.error') {
				this.isTurnActive = false;
				this.activeDeltaBuffer = '';
				this.activeReasoningBuffer = '';
				const msg = (event.data as { message?: string })?.message ?? 'Unknown error';
				this.log(`[Session] Error: ${msg}`);
				this.broadcast({ type: 'error', content: msg });
			} else if (event.type === 'permission.completed') {
				this.log(`[Session] Permission completed: ${JSON.stringify(event.data).slice(0, 200)}`);
			}
		});
	}
}

/** Manages multiple CopilotSession instances under a single CopilotClient (one auth). */
export class SessionPool {
	private client: CopilotClient;
	private pool = new Map<string, SessionHandle>();
	private log: (msg: string) => void;

	constructor(log: (msg: string) => void) {
		this.log = log;
		this.client = new CopilotClient();
	}

	async start(): Promise<void> {
		this.log('[Pool] Starting Copilot client...');
		await this.client.start();
		const auth = await this.client.getAuthStatus();
		this.log(`[Pool] Authenticated as: ${auth.login ?? 'unknown'}`);
	}

	async stop(): Promise<void> {
		for (const handle of this.pool.values()) await handle.disconnect();
		this.pool.clear();
		await this.client.stop();
	}

	async listSessions(): Promise<SessionMetadata[]> {
		const sessions = await this.client.listSessions();
		return sessions.sort((a, b) =>
			new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime()
		);
	}

	async getStatus() { return this.client.getStatus(); }
	async getAuthStatus() { return this.client.getAuthStatus(); }
	async listModels() { return this.client.listModels(); }

	async getLastSessionId(): Promise<string | null> {
		return this.client.getLastSessionId();
	}

	/** Returns the cached handle without connecting (null if not in pool). */
	getHandle(sessionId: string): SessionHandle | null {
		return this.pool.get(sessionId) ?? null;
	}

	/** Returns handle from pool, or connects to the session and caches it. */
	async connect(sessionId: string): Promise<SessionHandle> {
		if (this.pool.has(sessionId)) {
			this.log(`[Pool] Reusing: ${sessionId.slice(0, 8)}`);
			return this.pool.get(sessionId)!;
		}
		this.log(`[Pool] Connecting: ${sessionId.slice(0, 8)}...`);
		let handle!: SessionHandle;
		const session = await this.client.resumeSession(sessionId, {
			onPermissionRequest: (req) => handle.handlePermissionRequest(req),
			onUserInputRequest: (req) => handle.handleUserInputRequest(req),
		});
		handle = new SessionHandle(
			session,
			this.log,
			(id) => this.client.resumeSession(id, {
				onPermissionRequest: (req) => handle.handlePermissionRequest(req),
				onUserInputRequest: (req) => handle.handleUserInputRequest(req),
			}),
			async () => {
				const sessions = await this.client.listSessions();
				const meta = sessions.find(s => s.sessionId === sessionId);
				return meta?.modifiedTime ? new Date(meta.modifiedTime) : null;
			},
		);
		this.pool.set(sessionId, handle);
		return handle;
	}

	/** Creates a new session and adds it to the pool. */
	async create(): Promise<SessionHandle> {
		this.log('[Pool] Creating new session...');
		let handle!: SessionHandle;
		const session = await this.client.createSession({
			onPermissionRequest: (req) => handle.handlePermissionRequest(req),
			onUserInputRequest: (req) => handle.handleUserInputRequest(req),
		});
		handle = new SessionHandle(session, this.log);
		this.pool.set(session.sessionId, handle);
		this.log(`[Pool] Created: ${session.sessionId.slice(0, 8)}`);
		return handle;
	}

	async evict(sessionId: string): Promise<void> {
		const handle = this.pool.get(sessionId);
		if (handle) {
			await handle.disconnect();
			this.pool.delete(sessionId);
		}
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.evict(sessionId);
		await this.client.deleteSession(sessionId);
		this.log(`[Pool] Deleted: ${sessionId.slice(0, 8)}`);
	}
}
