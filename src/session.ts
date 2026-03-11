import { CopilotClient } from '@github/copilot-sdk';
import type { CopilotSession, AssistantMessageEvent } from '@github/copilot-sdk';
import type { SessionMetadata, PermissionRequest, PermissionRequestResult } from '@github/copilot-sdk';

export type { SessionMetadata };

export interface PortalEvent {
	type: 'delta' | 'idle' | 'error' | 'approval_request' | 'tool_call' | 'session_switched';
	content?: string;
	requestId?: string;
	approval?: {
		requestId: string;
		action: string;
		details: unknown;
	};
	sessionId?: string;
	sessionSummary?: string;
}

type PendingApproval = {
	resolve: (result: PermissionRequestResult) => void;
	reject: (err: Error) => void;
};

export class SessionManager {
	private client: CopilotClient;
	private activeSession: CopilotSession | null = null;
	private pendingApprovals = new Map<string, PendingApproval>();
	private approvalCounter = 0;
	private onEvent: (event: PortalEvent) => void;
	private logFn: (msg: string) => void;

	constructor(onEvent: (event: PortalEvent) => void, logFn: (msg: string) => void) {
		this.onEvent = onEvent;
		this.logFn = logFn;
		this.client = new CopilotClient();
	}

	private log(msg: string) { this.logFn(msg); }

	async start() {
		this.log('[Session] Starting Copilot client...');
		await this.client.start();
		const auth = await this.client.getAuthStatus();
		this.log(`[Session] Authenticated as: ${auth.login ?? 'unknown'}`);
	}

	async stop() {
		if (this.activeSession) {
			await this.activeSession.disconnect().catch(() => {});
			this.activeSession = null;
		}
		await this.client.stop();
	}

	async listSessions(): Promise<SessionMetadata[]> {
		const sessions = await this.client.listSessions();
		return sessions.sort((a, b) =>
			new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime()
		);
	}

	async newSession(): Promise<string> {
		if (this.activeSession) {
			await this.activeSession.disconnect().catch(() => {});
		}
		this.activeSession = await this.client.createSession({
			onPermissionRequest: (req) => this.handlePermissionRequest(req),
		});
		this.attachSessionListeners(this.activeSession);
		const sid = this.activeSession.sessionId;
		this.log(`[Session] New session: ${sid}`);
		this.onEvent({ type: 'session_switched', sessionId: sid });
		return sid;
	}

	async resumeSession(sessionId: string): Promise<void> {
		if (this.activeSession) {
			await this.activeSession.disconnect().catch(() => {});
		}
		this.activeSession = await this.client.resumeSession(sessionId, {
			onPermissionRequest: (req) => this.handlePermissionRequest(req),
		});
		this.attachSessionListeners(this.activeSession);
		this.log(`[Session] Resumed session: ${sessionId}`);
		this.onEvent({ type: 'session_switched', sessionId });
	}

	async getHistory(): Promise<PortalEvent[]> {
		if (!this.activeSession) return [];
		const events = await this.activeSession.getMessages();
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

	async sendPrompt(prompt: string): Promise<void> {
		if (!this.activeSession) throw new Error('No active session. Create or resume one first.');
		this.log(`[Session] Sending prompt (${prompt.length} chars)`);
		await this.activeSession.send({ prompt });
	}

	async abort(): Promise<void> {
		if (!this.activeSession) return;
		await this.activeSession.abort();
		this.log('[Session] Aborted');
	}

	resolveApproval(requestId: string, approved: boolean): void {
		const pending = this.pendingApprovals.get(requestId);
		if (!pending) {
			this.log(`[Session] Unknown approval requestId: ${requestId}`);
			return;
		}
		this.pendingApprovals.delete(requestId);
		pending.resolve({ approved });
		this.log(`[Session] Approval ${approved ? 'granted' : 'denied'} for ${requestId}`);
	}

	get activeSessionId(): string | null {
		return this.activeSession?.sessionId ?? null;
	}

	private attachSessionListeners(session: CopilotSession) {
		session.on((event) => {
			if (event.type === 'assistant.message_delta') {
				// Streaming delta (fires when available)
				const delta = (event.data as { deltaContent?: string }).deltaContent ?? '';
				if (delta) this.onEvent({ type: 'delta', content: delta });
			} else if (event.type === 'assistant.message') {
				// Full message — use as fallback if no deltas arrived, or as final content
				const content = (event.data as { content?: string }).content ?? '';
				this.onEvent({ type: 'delta', content });
			} else if (event.type === 'session.idle') {
				this.onEvent({ type: 'idle' });
			} else if (event.type === 'session.error') {
				const msg = (event.data as { message?: string })?.message ?? 'Unknown error';
				this.log(`[Session] Error: ${msg}`);
				this.onEvent({ type: 'error', content: msg });
			} else if (event.type === 'tool.call') {
				this.log(`[Session] Tool call: ${JSON.stringify(event.data).slice(0, 80)}`);
				this.onEvent({ type: 'tool_call', content: JSON.stringify(event.data) });
			}
		});
	}

	private handlePermissionRequest(req: PermissionRequest): Promise<PermissionRequestResult> {
		const requestId = `approval-${++this.approvalCounter}`;
		this.log(`[Session] Permission request ${requestId}: ${JSON.stringify(req).slice(0, 80)}`);
		this.onEvent({
			type: 'approval_request',
			approval: { requestId, action: (req as { action?: string }).action ?? 'unknown', details: req },
		});
		return new Promise<PermissionRequestResult>((resolve, reject) => {
			this.pendingApprovals.set(requestId, { resolve, reject });
			// Auto-timeout after 5 minutes
			setTimeout(() => {
				if (this.pendingApprovals.has(requestId)) {
					this.pendingApprovals.delete(requestId);
					reject(new Error('Approval timed out after 5 minutes'));
				}
			}, 5 * 60 * 1000);
		});
	}
}
