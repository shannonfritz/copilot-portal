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
import { RulesStore } from './rules.js';
import type { ApprovalRule } from './rules.js';

export type { SessionMetadata };
export type { ApprovalRule };

export interface PortalInfo {
	version: string;
	login: string;
	models: Array<{ id: string; name: string }>;
}

export interface PortalEvent {
	type: 'delta' | 'idle' | 'message_end' | 'error' | 'approval_request' | 'approval_resolved' | 'input_request' | 'tool_call' | 'tool_start' | 'tool_complete' | 'intent' | 'session_switched' | 'session_not_found' | 'session_renamed' | 'thinking' | 'reasoning_delta' | 'sync' | 'model_changed' | 'rules_list' | 'history_meta' | 'history_user' | 'cli_approval_pending' | 'cli_approval_resolved' | 'turn_stopping';
	content?: string;
	role?: 'user' | 'assistant';
	intermediate?: boolean; // true for assistant.message events that were mid-turn (history replay)
	total?: number;
	shown?: number;
	requestId?: string;
	approval?: { requestId: string; action: string; summary: string; details: unknown; alwaysPattern?: string };
	inputRequest?: { requestId: string; question: string; choices?: string[]; allowFreeform?: boolean };
	sessionId?: string;
	context?: SessionContext | null;
	model?: string;
	toolCallId?: string;
	toolName?: string;
	mcpServerName?: string;
	displayLabel?: string;
	rules?: ApprovalRule[];
	summary?: string;
}

type PendingApproval = {
	resolve: (r: PermissionRequestResult) => void;
	reject: (e: Error) => void;
	event: PortalEvent;
	req: PermissionRequest;
	timeout: ReturnType<typeof setTimeout>;
};

type PendingInput = {
	resolve: (r: UserInputResponse) => void;
	reject: (e: Error) => void;
	event: PortalEvent;
	timeout: ReturnType<typeof setTimeout>;
};

/** Wraps one CopilotSession and fans events out to multiple WS listeners. */
export class SessionHandle {
	readonly sessionId: string;
	private session: CopilotSession;
	titleChangedCallback?: () => Promise<void>;
	private listeners = new Set<(e: PortalEvent) => void>();
	/** True until the first portal client ever connects — prevents evict-on-connect for brand-new sessions. */
	isNew = true;
	private pendingApprovals = new Map<string, PendingApproval>();
	private pendingInputs = new Map<string, PendingInput>();
	private counter = 0;
	private pendingCompletionCount = 0; // # of permission.completed events expected for already-resolved approvals
	private log: (msg: string) => void;
	private lastSyncedCount = 0;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private sessionGeneration = 0;
	private isReconnecting = false;
	private reconnectFn: ((id: string) => Promise<CopilotSession>) | null = null;
	private getModTimeFn: (() => Promise<Date | null>) | null = null;
	private lastKnownModTime: Date | null = null;
	private rulesStore: RulesStore | null = null;

	// Active turn state — replayed to newly joining clients
	private isTurnActive = false;
	private isPortalTurn = false; // true when the current turn was initiated from the portal
	private activeDeltaBuffer = '';
	private activeReasoningBuffer = '';
	private activeUserMessage = ''; // current in-flight user message (CLI or portal)
	private cliApprovalSummary: string | null = null; // set when CLI turn is waiting for tool approval
	lastKnownSummary: string | undefined = undefined; // tracked by getModTimeFn to detect /rename

	constructor(
		session: CopilotSession,
		log: (msg: string) => void,
		reconnectFn?: (id: string) => Promise<CopilotSession>,
		getModTimeFn?: () => Promise<Date | null>,
		rulesStore?: RulesStore,
	) {
		this.sessionId = session.sessionId;
		this.session = session;
		this.log = log;
		this.reconnectFn = reconnectFn ?? null;
		this.getModTimeFn = getModTimeFn ?? null;
		this.rulesStore = rulesStore ?? null;
		this.attachListeners();
	}

	addListener(fn: (e: PortalEvent) => void): void {
		this.isNew = false; // once a client connects, no longer considered brand-new
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
		const events: PortalEvent[] = [];
		if (this.activeUserMessage) events.push({ type: 'sync', role: 'user', content: this.activeUserMessage });
		events.push({ type: 'thinking', content: '' });
		if (this.activeReasoningBuffer) events.push({ type: 'reasoning_delta', content: this.activeReasoningBuffer });
		if (this.activeDeltaBuffer) events.push({ type: 'delta', content: this.activeDeltaBuffer });
		if (this.cliApprovalSummary) events.push({ type: 'cli_approval_pending', content: this.cliApprovalSummary });
		return events;
	}

	private broadcast(event: PortalEvent): void {
		for (const fn of this.listeners) fn(event);
	}

	async getHistory(limit?: number): Promise<PortalEvent[]> {
		const events = await this.session.getMessages();
		this.log(`[History] ${events.length} events: ${events.map((e: { type: string }) => e.type).join(', ').slice(0, 200)}`);
		const relevantEvents = events.filter((e: { type: string }) => e.type === 'user.message' || e.type === 'assistant.message');
const total = relevantEvents.length;
const slicedEvents = (limit != null && total > limit)
? (() => {
// Find the offset in the full events array to keep the last limit relevant messages
let kept = 0;
let cutIdx = 0;
for (let i = events.length - 1; i >= 0; i--) {
const t = (events[i] as { type: string }).type;
if (t === 'user.message' || t === 'assistant.message') kept++;
if (kept >= limit) { cutIdx = i; break; }
}
return events.slice(cutIdx);
})()
: events;
const shown = slicedEvents.filter((e: { type: string }) => e.type === 'user.message' || e.type === 'assistant.message').length;
const result: PortalEvent[] = [];
if (total !== shown) result.push({ type: 'history_meta', total, shown });
		// Collect assistant messages per round (between user.messages) so we can
		// mark all-but-last as intermediate (they were mid-turn "notes to self")
		const roundMsgs: string[] = [];

		const flushRound = (allIntermediate = false) => {
			for (let i = 0; i < roundMsgs.length; i++) {
				const content = roundMsgs[i];
				if (!content) continue;
				const intermediate = allIntermediate || i < roundMsgs.length - 1;
				result.push({ type: 'delta', content });
				result.push({ type: 'idle', intermediate: intermediate || undefined });
			}
			roundMsgs.length = 0;
		};

		for (const e of slicedEvents) {
			if (e.type === 'user.message') {
				flushRound();
				result.push({ type: 'history_user', content: e.data?.content ?? '' });
			} else if (e.type === 'assistant.message') {
				roundMsgs.push(e.data?.content ?? '');
			}
		}
		// If the turn is still active, every message in the last round is intermediate
		// (more tool calls / messages are coming — none of them are the final reply yet)
		flushRound(this.isTurnActive);
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
		// Never reconnect while approvals or inputs are pending — would orphan the promises
		if (this.pendingApprovals.size > 0 || this.pendingInputs.size > 0) return;
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
			// Signal thinking/idle to the UI based on what arrived
			const lastNew = newMsgs[newMsgs.length - 1];
			if (lastNew?.type === 'user.message') {
				// User message arrived but no assistant yet — show thinking
				this.broadcast({ type: 'thinking', content: '' });
			} else if (lastNew?.type === 'assistant.message') {
				// Assistant responded — clear thinking regardless of isTurnActive
				this.broadcast({ type: 'idle' });
			}
		} catch (e) {
			this.log(`[Sync] Error: ${e}`);
		}
	}

	/** Advance lastSyncedCount without broadcasting — used after portal turns to skip re-syncing. */
	private async advanceSyncCount(): Promise<void> {
		try {
			const msgs = await this.session.getMessages();
			const count = msgs.filter((m: {type:string}) => m.type === 'user.message' || m.type === 'assistant.message').length;
			if (count > this.lastSyncedCount) {
				this.log(`[Sync] Portal turn: skipping ${count - this.lastSyncedCount} message(s), advancing cursor to ${count}`);
				this.lastSyncedCount = count;
			}
		} catch (_) { /* ignore */ }
	}

	/** Called when session modifiedTime advances without a portal turn — CLI sent messages. */
	private async reconnectFromCli(): Promise<void> {
		if (this.isReconnecting || !this.reconnectFn || this.listeners.size === 0) return;
		if (this.pendingApprovals.size > 0 || this.pendingInputs.size > 0) return;
		this.isReconnecting = true;
		this.log('[Sync] External change detected — refreshing connection for CLI messages...');
		try {
			const gen = ++this.sessionGeneration;
			const oldSession = this.session;
			// One final check: if a turn became active in the brief window before we got here,
			// the user.message live event already handled it — no need to reconnect.
			if (this.isTurnActive) {
				this.log('[Sync] Turn became active, skipping CLI reconnect');
				this.sessionGeneration--; // undo gen bump
				return;
			}
			// Disconnect old IPC connection first — forces a fresh cursor on reconnect
			await oldSession.disconnect().catch(() => {});
			const newSession = await this.reconnectFn(this.sessionId);
			if (this.sessionGeneration !== gen) return; // concurrent reconnect won the race
			this.session = newSession;
			this.attachListeners();
			const msgs = await this.session.getMessages();
			this.log(`[Sync] Post-reconnect getMessages: ${msgs.length} (lastSyncedCount=${this.lastSyncedCount})`);
			await this.syncMessages();
			// Check if title changed (e.g. /rename from CLI — doesn't fire session.title_changed)
			void this.titleChangedCallback?.();
			// Re-broadcast any pending approvals/inputs in case reconnect disrupted the UI state
			for (const p of this.pendingApprovals.values()) this.broadcast(p.event);
			for (const p of this.pendingInputs.values()) this.broadcast(p.event);
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
		// Mark turn active immediately so pollForChanges() won't reconnect when
		// user.message fires and changes modifiedTime.
		this.isTurnActive = true;
		this.isPortalTurn = true;
		this.activeUserMessage = prompt;
		this.log(`[${this.sessionId.slice(0, 8)}] Sending prompt (${prompt.length} chars)`);
		try {
			await this.session.send({ prompt });
		} catch (e) {
			this.isTurnActive = false;
			throw e;
		}
	}

	async abort(): Promise<void> {
		this.broadcast({ type: 'turn_stopping' });
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
		// Only return the currently-active approval (the one being shown to clients).
		// Others are queued and will be sent automatically after the current one resolves.
		if (!this.activeApprovalId) return [];
		const p = this.pendingApprovals.get(this.activeApprovalId);
		return p ? [p.event] : [];
	}

	getPendingInputEvents(): PortalEvent[] {
		return Array.from(this.pendingInputs.values()).map(p => p.event);
	}

	denyAllPending(): void {
		this.activeApprovalId = null;
		for (const [id, p] of this.pendingApprovals) {
			this.log(`[Session] Auto-denying approval ${id}`);
			clearTimeout(p.timeout);
			this.pendingApprovals.delete(id);
			p.resolve({ kind: 'denied-interactively-by-user' });
		}
		for (const [id, p] of this.pendingInputs) {
			this.log(`[Session] Auto-cancelling input ${id}`);
			clearTimeout(p.timeout);
			this.pendingInputs.delete(id);
			p.reject(new Error('No clients connected'));
		}
	}

	resolveApproval(requestId: string, approved: boolean): void {
		const p = this.pendingApprovals.get(requestId);
		if (!p) return;
		clearTimeout(p.timeout);
		this.pendingApprovals.delete(requestId);
		if (this.activeApprovalId === requestId) this.activeApprovalId = null;
		p.resolve(approved ? { kind: 'approved' } : { kind: 'denied-interactively-by-user' });
		this.log(`[Session] Approval ${approved ? 'granted' : 'denied'}: ${requestId}`);
		this.pendingCompletionCount++; // expect one permission.completed for this resolved approval
		this.broadcast({ type: 'approval_resolved', requestId });
		this.broadcastNextApproval();
	}

	resolveUserInput(requestId: string, answer: string, wasFreeform: boolean): void {
		const p = this.pendingInputs.get(requestId);
		if (!p) return;
		clearTimeout(p.timeout);
		this.pendingInputs.delete(requestId);
		p.resolve({ answer, wasFreeform });
		this.log(`[Session] Input answered: "${answer.slice(0, 40)}"`);
		this.broadcast({ type: 'approval_resolved', requestId });
	}

	private activeApprovalId: string | null = null;

	private broadcastNextApproval(): void {
		if (this.activeApprovalId) return;
		for (const [id, p] of this.pendingApprovals) {
			this.activeApprovalId = id;
			this.broadcast(p.event);
			break;
		}
	}

	handlePermissionRequest(req: PermissionRequest): Promise<PermissionRequestResult> {
		const requestId = `approval-${++this.counter}`;
		this.log(`[Session] Permission request: ${JSON.stringify(req).slice(0, 200)}`);
		const r = req as PermissionRequest & { fullCommandText?: string; path?: string; url?: string; toolName?: string; subject?: string; intention?: string };
		const summary = r.fullCommandText ?? r.path ?? r.url ?? r.intention ?? r.subject ?? r.toolName ?? r.kind;
		const alwaysPattern = RulesStore.computePattern(req);

		// Auto-approve if a matching rule exists
		const matchingRule = this.rulesStore?.matchesRequest(this.sessionId, req) ?? null;
		if (matchingRule) {
			this.log(`[Session] Auto-approved by rule "${matchingRule.pattern}": ${requestId}`);
			return Promise.resolve({ kind: 'approved' });
		}

		const event: PortalEvent = {
			type: 'approval_request',
			requestId,
			approval: { requestId, action: r.kind, details: req, summary, alwaysPattern },
		};
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (this.pendingApprovals.has(requestId)) {
					this.pendingApprovals.delete(requestId);
					if (this.activeApprovalId === requestId) this.activeApprovalId = null;
					resolve({ kind: 'denied-interactively-by-user', feedback: 'Timed out' });
					this.pendingCompletionCount++; // expect one permission.completed for this timed-out approval
					this.broadcastNextApproval();
				}
			}, 5 * 60 * 1000);
			this.pendingApprovals.set(requestId, { resolve, reject, event, req, timeout });
			// Queue: broadcast immediately only if no approval is currently being shown
			this.broadcastNextApproval();
		});
	}

	addRule(kind: string, pattern: string): void {
		if (!this.rulesStore) return;
		this.rulesStore.addRule(this.sessionId, kind, pattern);
		this.broadcast({ type: 'rules_list', rules: this.rulesStore.getRules(this.sessionId) });
		// Auto-resolve any queued approvals that now match the new rule
		for (const [id, p] of this.pendingApprovals) {
			if (this.rulesStore.matchesRequest(this.sessionId, p.req)) {
				this.log(`[Session] Auto-approved queued approval by new rule "${pattern}": ${id}`);
				clearTimeout(p.timeout);
				this.pendingApprovals.delete(id);
				if (this.activeApprovalId === id) this.activeApprovalId = null;
				p.resolve({ kind: 'approved' });
				this.broadcast({ type: 'approval_resolved', requestId: id });
			}
		}
		this.broadcastNextApproval();
	}

	removeRule(ruleId: string): void {
		if (!this.rulesStore) return;
		this.rulesStore.removeRule(this.sessionId, ruleId);
		this.broadcast({ type: 'rules_list', rules: this.rulesStore.getRules(this.sessionId) });
	}

	clearRules(): void {
		if (!this.rulesStore) return;
		this.rulesStore.clearRules(this.sessionId);
		this.broadcast({ type: 'rules_list', rules: [] });
	}

	getRulesList(): ApprovalRule[] {
		return this.rulesStore?.getRules(this.sessionId) ?? [];
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
			const timeout = setTimeout(() => {
				if (this.pendingInputs.has(requestId)) {
					this.pendingInputs.delete(requestId);
					reject(new Error('Input timed out'));
				}
			}, 5 * 60 * 1000);
			this.pendingInputs.set(requestId, { resolve, reject, event, timeout });
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
			} else if (event.type === 'user.message') {
				// CLI sent a message — mark turn active immediately so getActiveTurnEvents()
				// returns a thinking state for any client that connects before assistant.turn_start
				const content = (event.data as { content?: string })?.content ?? '';
				if (content) {
					this.isTurnActive = true;
					this.activeUserMessage = content;
					this.activeDeltaBuffer = '';
					this.activeReasoningBuffer = '';
					this.broadcast({ type: 'sync', role: 'user', content });
					this.broadcast({ type: 'thinking', content: '' });
				}
			} else if (event.type === 'assistant.intent') {
				const intent = (event.data as { intent?: string }).intent ?? '';
				if (intent) this.broadcast({ type: 'intent', content: intent });
			} else if (event.type === 'session.title_changed') {
				void this.syncMessages();
				void this.titleChangedCallback?.();
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
				if (!deltasSent && content) {
					// No deltas were streamed — send the full content as a single delta first
					this.broadcast({ type: 'delta', content });
				}
				// Always commit this message on the client, whether it arrived via deltas or as a blob
				this.broadcast({ type: 'message_end' });
				deltasSent = false;
			} else if (event.type === 'tool.execution_start') {
				toolsInFlight++;
				const d = event.data as { toolCallId?: string; toolName?: string; mcpServerName?: string; arguments?: unknown };
				this.log(`[Session] Tool start (${toolsInFlight} in flight): ${d.toolName}`);
				const args = (d.arguments ?? {}) as Record<string, unknown>;
				const labelVal = args.command ?? args.path ?? args.query ?? args.script ?? args.url ?? Object.values(args)[0] ?? '';
				const displayLabel = String(labelVal).replace(/\s+/g, ' ').trim().slice(0, 200);
				this.broadcast({ type: 'tool_start', toolCallId: d.toolCallId, toolName: d.toolName, mcpServerName: d.mcpServerName, displayLabel, content: JSON.stringify(args) });
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
				// Clear any lingering CLI approval banner
				if (this.cliApprovalSummary) {
					this.cliApprovalSummary = null;
					this.broadcast({ type: 'cli_approval_resolved' });
				}
				if (toolsInFlight > 0) {
					this.log(`[Event] session.idle with ${toolsInFlight} tools still in flight — resetting counter`);
					toolsInFlight = 0;
				}
				// For CLI turns, guarantee the user message reaches all clients before idle —
				// the live user.message broadcast can be lost if reconnectFromCli ran and discarded it.
				if (!this.isPortalTurn && this.activeUserMessage) {
					this.broadcast({ type: 'sync', role: 'user', content: this.activeUserMessage });
				}
				this.activeUserMessage = '';
				this.broadcast({ type: 'idle' });
				if (this.isPortalTurn) {
					// Portal turn: client already has all content from the delta stream.
					// Just advance the sync cursor so polls don't re-broadcast these messages.
					this.isPortalTurn = false;
					void this.advanceSyncCount();
				} else {
					void this.syncMessages();
				}
				// Re-seed modTime so the turn's messages don't trigger a spurious CLI reconnect
				if (this.getModTimeFn) {
					this.getModTimeFn().then(t => { if (t) this.lastKnownModTime = t; }).catch(() => {});
				}
			} else if (event.type === 'session.error') {
				this.isTurnActive = false;
				this.activeUserMessage = '';
				this.activeDeltaBuffer = '';
				this.activeReasoningBuffer = '';
				const msg = (event.data as { message?: string })?.message ?? 'Unknown error';
				this.log(`[Session] Error: ${msg}`);
				this.broadcast({ type: 'error', content: msg });
			} else if (event.type === 'permission.requested') {
				// CLI turn waiting for tool approval — portal can't approve, but inform the user
				if (!this.isPortalTurn) {
					const d = event.data as {
						kind?: string; fullCommandText?: string; intention?: string;
						path?: string; url?: string; toolName?: string; subject?: string;
					};
					const desc = d.fullCommandText ?? d.path ?? d.url ?? d.intention ?? d.subject ?? d.toolName ?? d.kind ?? 'tool';
					const kind = d.kind ?? 'tool';
					this.cliApprovalSummary = `${kind}: ${desc}`;
					this.log(`[Session] CLI waiting for approval: ${this.cliApprovalSummary}`);
					this.broadcast({ type: 'cli_approval_pending', content: this.cliApprovalSummary });
				}
			} else if (event.type === 'permission.completed') {
				this.log(`[Session] Permission completed: ${JSON.stringify(event.data).slice(0, 200)}`);
				// Clear CLI approval banner (set by permission.requested, or used as a dismissal signal)
				if (this.cliApprovalSummary) {
					this.cliApprovalSummary = null;
					this.broadcast({ type: 'cli_approval_resolved' });
				} else if (!this.isPortalTurn && this.pendingCompletionCount === 0) {
					// CLI turn: tool was just approved at the terminal — dismiss any hint the client is showing
					this.broadcast({ type: 'cli_approval_resolved' });
				}
				if (this.pendingCompletionCount > 0) {
					// This completion is for an approval already resolved by the portal (or timed out).
					// activeApprovalId has already advanced to the next queued approval — don't touch it.
					this.pendingCompletionCount--;
					this.log(`[Session] permission.completed for portal-resolved approval (${this.pendingCompletionCount} remaining)`);
				} else {
					// External resolution (e.g. CLI client) — clear the active approval now.
					if (this.activeApprovalId && this.pendingApprovals.has(this.activeApprovalId)) {
						const p = this.pendingApprovals.get(this.activeApprovalId)!;
						clearTimeout(p.timeout);
						this.pendingApprovals.delete(this.activeApprovalId);
						this.broadcast({ type: 'approval_resolved', requestId: this.activeApprovalId });
						this.log(`[Session] Cleared portal approval ${this.activeApprovalId} (resolved externally)`);
					}
					this.activeApprovalId = null;
					this.broadcastNextApproval();
				}
			}
		});
	}
}

/** Manages multiple CopilotSession instances under a single CopilotClient (one auth). */
export class SessionPool {
	private client: CopilotClient;
	onTitleChanged?: (sessionId: string, summary: string | undefined) => void;
	private pool = new Map<string, SessionHandle>();
	private connecting = new Map<string, Promise<SessionHandle>>();
	private log: (msg: string) => void;
	readonly rulesStore: RulesStore;

	constructor(log: (msg: string) => void, rulesStore: RulesStore) {
		this.log = log;
		this.client = new CopilotClient();
		this.rulesStore = rulesStore;
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

	/** Returns handle from pool, or connects to the session and caches it. Concurrent calls for the same sessionId share a single in-flight promise. */
	async connect(sessionId: string): Promise<SessionHandle> {
		if (this.pool.has(sessionId)) {
			this.log(`[Pool] Reusing: ${sessionId.slice(0, 8)}`);
			return this.pool.get(sessionId)!;
		}
		if (this.connecting.has(sessionId)) {
			this.log(`[Pool] Joining in-flight connect: ${sessionId.slice(0, 8)}`);
			return this.connecting.get(sessionId)!;
		}
		const p = this._doConnect(sessionId);
		this.connecting.set(sessionId, p);
		try {
			return await p;
		} finally {
			this.connecting.delete(sessionId);
		}
	}

	private async _doConnect(sessionId: string): Promise<SessionHandle> {
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
				// Piggyback: if summary changed since last check, broadcast it now
				if (meta?.summary !== handle.lastKnownSummary) {
					handle.lastKnownSummary = meta?.summary;
					if (handle.lastKnownSummary !== undefined) {
						this.log(`[TitleChanged] session=${sessionId.slice(0,8)} summary=${handle.lastKnownSummary}`);
						this.onTitleChanged?.(sessionId, handle.lastKnownSummary);
					}
				}
				return meta?.modifiedTime ? new Date(meta.modifiedTime) : null;
			},
			this.rulesStore,
		);
		this.pool.set(sessionId, handle);
		handle.titleChangedCallback = async () => {
			try {
				const sessions = await this.client.listSessions();
				const meta = sessions.find(s => s.sessionId === sessionId);
				const summary = meta?.summary;
				if (summary !== handle.lastKnownSummary) {
					handle.lastKnownSummary = summary;
					this.log(`[TitleChanged] session=${sessionId.slice(0,8)} summary=${summary ?? '(none)'}`);
					this.onTitleChanged?.(sessionId, summary);
				}
			} catch {}
		};
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
		handle = new SessionHandle(session, this.log, undefined, undefined, this.rulesStore);
		this.pool.set(session.sessionId, handle);
		handle.titleChangedCallback = async () => {
			try {
				const sessions = await this.client.listSessions();
				const meta = sessions.find(s => s.sessionId === session.sessionId);
				const summary = meta?.summary;
				if (summary !== handle.lastKnownSummary) {
					handle.lastKnownSummary = summary;
					this.onTitleChanged?.(session.sessionId, summary);
				}
			} catch {}
		};
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
		this.rulesStore.removeSession(sessionId);
		this.log(`[Pool] Deleted: ${sessionId.slice(0, 8)}`);
	}
}
