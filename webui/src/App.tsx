import { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ComponentProps } from 'react';

// Wraps pre in a scrollable div so long code lines don't overflow the bubble
const mdComponents: ComponentProps<typeof Markdown>['components'] = {
	pre: ({ children }) => (
		<div className="code-scroll" style={{ margin: '0.5em 0' }}>
			<pre style={{ margin: 0 }}>{children}</pre>
		</div>
	),
	table: ({ children }) => (
		<div className="code-scroll" style={{ margin: '0.5em 0' }}>
			<table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>{children}</table>
		</div>
	),
	th: ({ children }) => (
		<th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>{children}</th>
	),
	ol: ({ children }) => (
		<ol style={{ listStyleType: 'decimal', paddingLeft: '1.5em', margin: '0.5em 0' }}>{children}</ol>
	),
	ul: ({ children }) => (
		<ul style={{ listStyleType: 'disc', paddingLeft: '1.5em', margin: '0.5em 0' }}>{children}</ul>
	),
	li: ({ children }) => (
		<li style={{ display: 'list-item', margin: '0.25em 0' }}>{children}</li>
	),
};

const AssistantMarkdown = ({ content }: { content: string }) => (
	<Markdown className="prose prose-sm max-w-none" remarkPlugins={[remarkGfm]} components={mdComponents}>
		{content}
	</Markdown>
);

interface Message {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	reasoning?: string;
	timestamp: number;
	fromHistory?: boolean;
}

interface ToolEvent {
	id: string;
	type: 'tool_start' | 'tool_complete' | 'tool_output' | 'intent';
	toolName?: string;
	toolCallId?: string;
	mcpServerName?: string;
	content?: string;
	timestamp: number;
}

interface ApprovalRequest {
	requestId: string;
	action: string;
	summary: string;
	details: unknown;
	alwaysPattern?: string;
}

interface ApprovalRule {
	id: string;
	sessionId: string;
	kind: string;
	pattern: string;
	createdAt: number;
}

interface InputRequest {
	requestId: string;
	question: string;
	choices?: string[];
	allowFreeform?: boolean;
}

interface PortalInfo {
	version: string;
	login: string;
	models: Array<{ id: string; name: string }>;
}

interface SessionContext {
	cwd: string;
	gitRoot?: string;
	repository?: string;
	branch?: string;
}

interface SessionInfo {
	sessionId: string;
	summary?: string;
	startTime?: string;
	modifiedTime?: string;
	shielded?: boolean;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'no_token';

function getToken(): string | null {
	const injected = (window as unknown as Record<string, unknown>).__PORTAL_TOKEN__;
	if (typeof injected === 'string') {
		localStorage.setItem('portal_token', injected);
		return injected;
	}
	const urlToken = new URLSearchParams(window.location.search).get('token');
	if (urlToken) {
		localStorage.setItem('portal_token', urlToken);
		return urlToken;
	}
	return localStorage.getItem('portal_token');
}

function timeAgo(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const m = Math.floor(diff / 60000);
	if (m < 1) return 'just now';
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const copy = () => {
		const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
		if (navigator.clipboard) {
			navigator.clipboard.writeText(text).then(done).catch(() => fallback());
		} else {
			fallback();
		}
		function fallback() {
			const el = document.createElement('textarea');
			el.value = text;
			el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
			document.body.appendChild(el);
			el.select();
			document.execCommand('copy');
			document.body.removeChild(el);
			done();
		}
	};
	return (
		<button
			type="button"
			onClick={copy}
			className="shrink-0 rounded p-0.5 opacity-40 hover:opacity-80 transition-opacity"
			title="Copy"
			style={{ color: 'inherit' }}
		>
			{copied
				? <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
				: <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
			}
		</button>
	);
}

function ThoughtBubble({ reasoning, defaultExpanded = false }: { reasoning: string; defaultExpanded?: boolean }) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	return (
		<div className="mb-1 max-w-[85%]">
			<button
				type="button"
				className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"
				style={{ background: 'rgba(100,100,120,0.12)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
				onClick={() => setExpanded(e => !e)}
			>
				<span style={{ fontSize: '10px' }}>{expanded ? '▾' : '▸'}</span>
				<span className="italic">Thought{expanded ? '' : '…'}</span>
			</button>
			{expanded && (
				<div
					className="mt-1 rounded-xl px-3 py-2 text-xs"
					style={{
						background: 'rgba(100,100,120,0.08)',
						border: '1px solid var(--border)',
						color: 'var(--text-muted)',
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-words',
					}}
				>
					{reasoning}
				</div>
			)}
		</div>
	);
}

function SessionDrawer({
	open,
	onToggle,
	info,
	context,
	activeModel,
	onChangeModel,
}: {
	open: boolean;
	onToggle: () => void;
	info: PortalInfo | null;
	context: SessionContext | null;
	activeModel: string | null;
	onChangeModel: (id: string) => void;
}) {
	const [showModelPicker, setShowModelPicker] = useState(false);
	const currentModelId = activeModel ?? info?.models[0]?.id ?? null;
	const currentModelName = info?.models.find(m => m.id === currentModelId)?.name ?? currentModelId ?? '…';
	const cwd = context?.cwd ?? null;
	const branch = context?.branch ?? null;
	const shortCwd = cwd ? cwd.split(/[\\/]/).pop() || cwd : null;

	return (
		<div style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
			{/* Always-visible collapsed bar */}
			<button
				type="button"
				className="flex w-full items-center gap-2 px-4 py-2 text-xs"
				style={{ color: 'var(--text-muted)' }}
				onClick={onToggle}
			>
				<svg className="size-3.5 shrink-0" fill="none" stroke="var(--primary)" strokeWidth="2" viewBox="0 0 24 24">
					<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
				</svg>
				{shortCwd && (
					<>
						<span className="font-mono truncate max-w-[120px]">{shortCwd}</span>
						<span style={{ color: 'var(--border)' }}>·</span>
					</>
				)}
				<span className="truncate">{currentModelName}</span>
				<span className="ml-auto shrink-0">{open ? '▴' : '▾'}</span>
			</button>

			{/* Expandable panel */}
			{open && (
				<div className="px-4 pb-4 pt-1">
					{/* Version + user */}
					<div className="mb-3 flex items-center gap-2.5">
						<div className="flex size-8 shrink-0 items-center justify-center rounded-lg" style={{ background: 'rgba(88,166,255,0.15)', border: '1px solid rgba(88,166,255,0.3)' }}>
							<svg className="size-4" fill="none" stroke="var(--primary)" strokeWidth="1.5" viewBox="0 0 24 24">
								<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
							</svg>
						</div>
						<div>
							<div className="text-sm font-semibold">GitHub Copilot</div>
							<div className="text-xs" style={{ color: 'var(--text-muted)' }}>
								{info ? `v${info.version} · ${info.login}` : 'Loading…'}
							</div>
						</div>
					</div>

					{/* cwd / branch */}
					{cwd && (
						<div className="mb-3 flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs" style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
							<svg className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
								<path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
							</svg>
							<span className="truncate font-mono" style={{ color: 'var(--text-muted)' }}>{cwd}</span>
							{branch && (
								<>
									<span style={{ color: 'var(--border)' }}>·</span>
									<svg className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
										<path d="M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9" />
									</svg>
									<span className="font-mono" style={{ color: 'var(--text-muted)' }}>{branch}</span>
								</>
							)}
						</div>
					)}

					{/* Model selector */}
					<div className="relative">
						<button
							type="button"
							className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm"
							style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
							onClick={() => setShowModelPicker(v => !v)}
						>
							<div className="flex items-center gap-2">
								<svg className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
									<circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" />
								</svg>
								<span>{currentModelName}</span>
							</div>
							<span style={{ color: 'var(--text-muted)' }}>{showModelPicker ? '▴' : '▾'}</span>
						</button>
						{showModelPicker && info && (
							<div
								className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg py-1"
								style={{ background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
							>
								{info.models.map(m => (
									<button
										key={m.id}
										type="button"
										className="flex w-full items-center gap-2 px-3 py-2 text-sm"
										style={{ background: m.id === currentModelId ? 'rgba(88,166,255,0.12)' : 'transparent' }}
										onClick={() => { onChangeModel(m.id); setShowModelPicker(false); }}
									>
										<span className="w-4 text-xs shrink-0" style={{ color: 'var(--primary)' }}>
											{m.id === currentModelId ? '✓' : ''}
										</span>
										<span>{m.name}</span>
									</button>
								))}
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

export default function App() {
	const hasSessionInUrl = !!new URLSearchParams(window.location.search).get('session');
	const [connectionState, setConnectionState] = useState<ConnectionState>(hasSessionInUrl ? 'connecting' : 'disconnected');
	const [messages, setMessages] = useState<Message[]>([]);
	const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
	const [streamingContent, setStreamingContent] = useState('');
	const [isThinking, setIsThinking] = useState(false);
	const [thinkingText, setThinkingText] = useState('');
	const [reasoningText, setReasoningText] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [input, setInput] = useState('');
	const [isStreaming, setIsStreaming] = useState(false);
	const [showPicker, setShowPicker] = useState(!hasSessionInUrl);
	const [showQR, setShowQR] = useState(false);
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	const [activeSessionId, setActiveSessionId] = useState<string | null>(
		new URLSearchParams(window.location.search).get('session')
	);
	const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
	const [pendingInput, setPendingInput] = useState<InputRequest | null>(null);
	const [freeformAnswer, setFreeformAnswer] = useState('');
	const [rules, setRules] = useState<ApprovalRule[]>([]);
	const [showRules, setShowRules] = useState(false);
	const [connectingSecs, setConnectingSecs] = useState(0);
	const [portalInfo, setPortalInfo] = useState<PortalInfo | null>(null);
	const [sessionContext, setSessionContext] = useState<SessionContext | null>(null);
	const [activeModel, setActiveModel] = useState<string | null>(null);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [noSession, setNoSession] = useState(!hasSessionInUrl);
	const noSessionRef = useRef(!hasSessionInUrl);

	const wsRef = useRef<WebSocket | null>(null);
	const streamingRef = useRef('');
	const reasoningRef = useRef('');
	const chatEndRef = useRef<HTMLDivElement>(null);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const inHistoryRef = useRef(false);
	const historyBufferRef = useRef<Message[]>([]);
	const lastConnectTime = useRef(0);

	// Fetch portal info (version, user, models) once on mount
	useEffect(() => {
		fetch('/api/info').then(r => r.json()).then(setPortalInfo).catch(() => {});
		// If starting with no session, pre-load the session list for the picker
		if (!hasSessionInUrl) {
			fetch('/api/sessions').then(r => r.json()).then(setSessions).catch(() => {});
		}
	}, []);

	// Auto-collapse drawer when first message arrives
	const drawerAutoCollapsedRef = useRef(false);
	useEffect(() => {
		if (messages.length > 0 && drawerOpen && !drawerAutoCollapsedRef.current) {
			drawerAutoCollapsedRef.current = true;
			setDrawerOpen(false);
		}
		if (messages.length === 0) drawerAutoCollapsedRef.current = false;
	}, [messages.length, drawerOpen]);

	const enterNoSession = useCallback(() => {
		// Null callbacks first so onclose doesn't trigger a reconnect
		const ws = wsRef.current;
		if (ws) { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; ws.close(); }
		wsRef.current = null;
		if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
		noSessionRef.current = true;
		setNoSession(true);
		setActiveSessionId(null);
		setSessionContext(null);
		setMessages([]);
		setStreamingContent('');
		setIsStreaming(false);
		setIsThinking(false);
		setConnectionState('disconnected');
		setShowPicker(true);
		setPendingApproval(null);
		setPendingInput(null);
		setRules([]);
		const params = new URLSearchParams(window.location.search);
		params.delete('session');
		window.history.replaceState(null, '', `?${params.toString()}`);

		// Open a lightweight management WS to receive session broadcasts (delete/shield)
		const token = getToken();
		if (token) {
			const mgmtWs = new WebSocket(`ws://${window.location.host}?token=${token}&management=1`);
			mgmtWs.onmessage = (e) => {
				try {
					const event = JSON.parse(e.data as string) as { type: string; sessionId?: string; shielded?: boolean; session?: SessionInfo };
					if (event.type === 'session_deleted') {
						setSessions(prev => prev.filter(s => s.sessionId !== event.sessionId));
					} else if (event.type === 'session_shield_changed') {
						setSessions(prev => prev.map(s => s.sessionId === event.sessionId ? { ...s, shielded: event.shielded ?? false } : s));
					} else if (event.type === 'session_created' && event.session) {
						setSessions(prev => prev.some(s => s.sessionId === event.session!.sessionId) ? prev : [event.session!, ...prev]);
					}
				} catch {}
			};
			mgmtWs.onerror = () => mgmtWs.close();
			// Store so it can be cleaned up when a session is selected
			wsRef.current = mgmtWs;
		}
	}, []);

	const connect = useCallback(() => {
		const token = getToken();
		if (!token) { setConnectionState('no_token'); return; }
		if (noSessionRef.current) return; // user must pick a session first

		// Kill any existing connection before creating a new one.
		// Null out callbacks first so onclose doesn't schedule another reconnect.
		lastConnectTime.current = Date.now();
		setConnectionState('connecting');
		const prev = wsRef.current;
		if (prev) {
			prev.onopen = null;
			prev.onmessage = null;
			prev.onerror = null;
			prev.onclose = null;
			if (prev.readyState !== WebSocket.CLOSED) prev.close();
		}

		const sessionId = new URLSearchParams(window.location.search).get('session');
		const sessionParam = sessionId ? `&session=${sessionId}` : '';
		const wsUrl = `ws://${window.location.host}?token=${token}${sessionParam}`;
		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;

		ws.onopen = () => setConnectionState('connected');

		ws.onmessage = (e) => {
			try {
				const event = JSON.parse(e.data as string) as {
					type: string;
					content?: string;
					sessionId?: string;
					shielded?: boolean;
					toolName?: string;
					params?: unknown;
					result?: unknown;
					requestId?: string;
					approval?: ApprovalRequest;
					inputRequest?: InputRequest;
					session?: SessionInfo;
					model?: string;
					toolCallId?: string;
					mcpServerName?: string;
				};

				if (event.type === 'history_start') {
					inHistoryRef.current = true;
					historyBufferRef.current = [];
					// Clear any in-progress streaming from a previous connection
					streamingRef.current = '';
					reasoningRef.current = '';
					setStreamingContent('');
					setIsStreaming(false);
					setIsThinking(false);
					setThinkingText('');
					setReasoningText('');
					return;
				}

				if (event.type === 'history_end') {
					inHistoryRef.current = false;
					// Flush any remaining assistant content
					if (streamingRef.current) {
						historyBufferRef.current.push({
							id: `hist-${Date.now()}-a`,
							role: 'assistant',
							content: streamingRef.current,
							timestamp: Date.now(),
							fromHistory: true,
						});
						streamingRef.current = '';
					}
					setMessages(historyBufferRef.current);
					// Auto-open drawer when session is empty (new session)
					if (historyBufferRef.current.length === 0) setDrawerOpen(true);
					historyBufferRef.current = [];
					return;
				}

				if (event.type === 'session_switched') {
					const newId = event.sessionId ?? null;
					setActiveSessionId(newId);
					setSessionContext((event as { context?: SessionContext | null }).context ?? null);
					// Keep URL in sync — update ?session= without reloading
					if (newId) {
						const params = new URLSearchParams(window.location.search);
						params.set('session', newId);
						window.history.replaceState(null, '', `?${params.toString()}`);
					}
					return;
				}

				if (event.type === 'model_changed') {
					setActiveModel(event.model ?? null);
					return;
				}

				if (event.type === 'session_not_found') {
					enterNoSession();
					return;
				}

				if (event.type === 'session_deleted') {
					setSessions(prev => prev.filter(s => s.sessionId !== event.sessionId));
					if (event.sessionId === activeSessionId) enterNoSession();
					return;
				}

				if (event.type === 'session_shield_changed') {
					setSessions(prev => prev.map(s => s.sessionId === event.sessionId ? { ...s, shielded: event.shielded } : s));
					return;
				}

				if (event.type === 'session_created' && event.session) {
					setSessions(prev => prev.some(s => s.sessionId === event.session!.sessionId) ? prev : [event.session!, ...prev]);
					return;
				}

				if (inHistoryRef.current) {
					// History replay: delta events carry __USER__ prefix for user turns
					if (event.type === 'delta') {
						const raw = event.content ?? '';
						if (raw.startsWith('__USER__')) {
							// Flush any pending assistant content first
							if (streamingRef.current) {
								historyBufferRef.current.push({
									id: `hist-${Date.now()}-a`,
									role: 'assistant',
									content: streamingRef.current,
									timestamp: Date.now(),
									fromHistory: true,
								});
								streamingRef.current = '';
							}
							historyBufferRef.current.push({
								id: `hist-${Date.now()}-u`,
								role: 'user',
								content: raw.slice('__USER__'.length),
								timestamp: Date.now(),
								fromHistory: true,
							});
						} else {
							streamingRef.current += raw;
						}
					} else if (event.type === 'idle') {
						if (streamingRef.current) {
							historyBufferRef.current.push({
								id: `hist-${Date.now()}-a`,
								role: 'assistant',
								content: streamingRef.current,
								timestamp: Date.now(),
								fromHistory: true,
							});
							streamingRef.current = '';
						}
					}
					return;
				}

				// Live events
				if (event.type === 'delta') {
					setIsThinking(false);
					setThinkingText('');
					setIsStreaming(true);
					streamingRef.current += event.content ?? '';
					setStreamingContent(streamingRef.current);
				} else if (event.type === 'thinking') {
					setIsThinking(true);
					if (event.content) setThinkingText(event.content);
				} else if (event.type === 'reasoning_delta') {
					if (event.content) {
						reasoningRef.current += event.content;
						setReasoningText(reasoningRef.current);
					}
				} else if (event.type === 'sync') {
					// Message synced from CLI activity — dedup against locally-added messages
					const syncEvent = event as typeof event & { role?: string };
					const role = syncEvent.role === 'user' ? 'user' : 'assistant';
					const content = event.content ?? '';
					if (content) {
						setMessages((prev) => {
							if (prev.some(m => m.role === role && m.content === content)) return prev;
							return [...prev, { id: `sync-${Date.now()}-${Math.random()}`, role, content, timestamp: Date.now() }];
						});
						// A new user message from CLI means a new turn is starting — clear tool events
						if (role === 'user') setToolEvents([]);
					}
				} else if (event.type === 'intent') {
					setToolEvents((prev) => [...prev, { id: `intent-${Date.now()}`, type: 'intent', content: event.content, timestamp: Date.now() }]);
				} else if (event.type === 'tool_start') {
					setIsThinking(false);
					setToolEvents((prev) => [...prev, { id: `ts-${event.toolCallId ?? Date.now()}`, type: 'tool_start', toolCallId: event.toolCallId, toolName: event.toolName, mcpServerName: event.mcpServerName, content: event.content, timestamp: Date.now() }]);
				} else if (event.type === 'tool_complete') {
					setToolEvents((prev) => prev.map(te => te.toolCallId === event.toolCallId ? { ...te, type: 'tool_complete' as const } : te));
				} else if (event.type === 'tool_call') {
					// tool_output (partial result streaming)
					setToolEvents((prev) => [...prev, { id: `to-${Date.now()}`, type: 'tool_output', toolCallId: event.toolCallId, content: event.content, timestamp: Date.now() }]);
				} else if (event.type === 'idle') {
					const final = streamingRef.current;
					if (final) {
						// Dedup: sync poll may have already added this message if it arrived before idle
						setMessages((prev) => {
							if (prev.some(m => m.role === 'assistant' && m.content === final)) return prev;
							return [
								...prev,
								{
									id: `msg-${Date.now()}`,
									role: 'assistant',
									content: final,
									reasoning: reasoningRef.current || undefined,
									timestamp: Date.now(),
								},
							];
						});
					}
					streamingRef.current = '';
					reasoningRef.current = '';
					setStreamingContent('');
					setIsStreaming(false);
					setIsThinking(false);
					setThinkingText('');
					setReasoningText('');
					setToolEvents([]);
				} else if (event.type === 'error') {
					setError(event.content ?? 'Unknown error');
					setIsStreaming(false);
					setIsThinking(false);
				} else if (event.type === 'approval_request' && event.approval) {
					setPendingApproval(event.approval);
				} else if (event.type === 'approval_resolved') {
					// Another client resolved this approval/input — dismiss it here too
					setPendingApproval(prev => prev?.requestId === event.requestId ? null : prev);
					setPendingInput(prev => prev?.requestId === event.requestId ? null : prev);
				} else if (event.type === 'input_request' && event.inputRequest) {
					setFreeformAnswer('');
					setPendingInput(event.inputRequest);
				} else if (event.type === 'rules_list') {
					setRules(event.rules ?? []);
				}
			} catch {}
		};

		ws.onclose = (e) => {
			// Ignore close events from replaced connections
			if (wsRef.current !== ws) return;
			setConnectionState('disconnected');
			setIsStreaming(false);
			setIsThinking(false);
			if (e.code === 4404) return; // session not found — handled above, don't retry
			if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
			reconnectTimer.current = setTimeout(() => connect(), 2000);
		};

		ws.onerror = () => ws.close();
	}, []);

	useEffect(() => {
		if (noSessionRef.current) {
			// Start in no-session mode — open management WS for live broadcasts
			const token = getToken();
			if (token) {
				const mgmtWs = new WebSocket(`ws://${window.location.host}?token=${token}&management=1`);
				mgmtWs.onmessage = (e) => {
					try {
						const event = JSON.parse(e.data as string) as { type: string; sessionId?: string; shielded?: boolean; session?: SessionInfo };
						if (event.type === 'session_deleted') {
							setSessions(prev => prev.filter(s => s.sessionId !== event.sessionId));
						} else if (event.type === 'session_shield_changed') {
							setSessions(prev => prev.map(s => s.sessionId === event.sessionId ? { ...s, shielded: event.shielded ?? false } : s));
						} else if (event.type === 'session_created' && event.session) {
							setSessions(prev => prev.some(s => s.sessionId === event.session!.sessionId) ? prev : [event.session!, ...prev]);
						}
					} catch {}
				};
				mgmtWs.onerror = () => mgmtWs.close();
				wsRef.current = mgmtWs;
			}
		} else {
			connect();
		}
		return () => {
			if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
			wsRef.current?.close();
		};
	}, [connect]);

	// Count seconds since entering 'connecting' state (continuously, not reset on retries)
	useEffect(() => {
		if (connectionState !== 'connecting') { setConnectingSecs(0); return; }
		const start = Date.now();
		setConnectingSecs(1); // start at 1 immediately
		const t = setInterval(() => setConnectingSecs(Math.floor((Date.now() - start) / 1000) + 1), 1000);
		return () => clearInterval(t);
	}, [connectionState]);

	// iOS Safari: reconnect when page becomes visible/focused after being backgrounded.
	// Guard: skip if connect() was called < 3s ago (initial load / just reconnected).
	useEffect(() => {
		const tryReconnect = () => {
			if (Date.now() - lastConnectTime.current < 1500) return; // too soon after last connect
			const ws = wsRef.current;
			if (!ws || ws.readyState === WebSocket.OPEN) return;
			if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
			if (ws.readyState === WebSocket.CONNECTING) ws.close();
			connect();
		};
		const onVisibility = () => { if (document.visibilityState === 'visible') tryReconnect(); };
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('focus', tryReconnect);
		window.addEventListener('pageshow', tryReconnect);
		// Retry every 2s if still not connected — iOS needs ~3 attempts before succeeding
		const retryInterval = setInterval(() => {
			if (wsRef.current?.readyState !== WebSocket.OPEN) connect();
		}, 2000);
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('focus', tryReconnect);
			window.removeEventListener('pageshow', tryReconnect);
			clearInterval(retryInterval);
		};
	}, [connect]);

	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, streamingContent, toolEvents, isThinking]);

	const openPicker = useCallback(async () => {
		try {
			const res = await fetch('/api/sessions');
			const data = await res.json() as SessionInfo[];
			setSessions(data);
			setShowPicker(true);
		} catch {
			setError('Could not load sessions');
		}
	}, []);

	const switchSession = useCallback((sessionId: string) => {
		noSessionRef.current = false;
		setNoSession(false);
		setShowPicker(false);
		const params = new URLSearchParams(window.location.search);
		params.set('session', sessionId);
		window.location.search = params.toString();
	}, []);

	const newSession = useCallback(async () => {
		setShowPicker(false);
		try {
			const res = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
			const { sessionId } = await res.json() as { sessionId: string };
			noSessionRef.current = false;
			setNoSession(false);
			const params = new URLSearchParams(window.location.search);
			params.set('session', sessionId);
			window.location.search = params.toString();
		} catch {
			setError('Could not create session');
		}
	}, []);

	const changeModel = useCallback((modelId: string) => {
		setActiveModel(modelId);
		setShowModelPicker(false);
		wsRef.current?.send(JSON.stringify({ type: 'set_model', content: modelId }));
	}, []);

	const toggleShield = useCallback(async (sessionId: string, e: React.MouseEvent) => {
		e.stopPropagation();
		setSessions(prev => prev.map(s => s.sessionId === sessionId ? { ...s, shielded: !s.shielded } : s));
		try {
			await fetch(`/api/sessions/${sessionId}/shield`, { method: 'PATCH' });
		} catch {
			// revert on error
			setSessions(prev => prev.map(s => s.sessionId === sessionId ? { ...s, shielded: !s.shielded } : s));
		}
	}, []);

	const deleteSession = useCallback(async (sessionId: string, e: React.MouseEvent) => {
		e.stopPropagation();
		const wasActive = sessionId === activeSessionId;
		try {
			const res = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
			if (!res.ok) { setError('Could not delete session'); return; }
			setSessions(prev => prev.filter(s => s.sessionId !== sessionId));
			setConfirmDeleteId(null);
			if (wasActive) enterNoSession();
		} catch {
			setError('Could not delete session');
		}
	}, [activeSessionId, enterNoSession]);

	const respondApproval = useCallback((approved: boolean) => {
		if (!pendingApproval) return;
		wsRef.current?.send(JSON.stringify({ type: 'approval_response', requestId: pendingApproval.requestId, approved }));
		setPendingApproval(null);
	}, [pendingApproval]);

	const respondApprovalAlways = useCallback(() => {
		if (!pendingApproval?.alwaysPattern) return;
		wsRef.current?.send(JSON.stringify({
			type: 'approval_response_always',
			requestId: pendingApproval.requestId,
			kind: pendingApproval.action,
			pattern: pendingApproval.alwaysPattern,
		}));
		setPendingApproval(null);
	}, [pendingApproval]);

	const deleteRule = useCallback((ruleId: string) => {
		wsRef.current?.send(JSON.stringify({ type: 'rule_delete', ruleId }));
	}, []);

	const clearAllRules = useCallback(() => {
		wsRef.current?.send(JSON.stringify({ type: 'rules_clear' }));
	}, []);

	const respondInput = useCallback((answer: string, wasFreeform: boolean) => {
		if (!pendingInput) return;
		wsRef.current?.send(JSON.stringify({ type: 'input_response', requestId: pendingInput.requestId, answer, wasFreeform }));
		setPendingInput(null);
		setFreeformAnswer('');
	}, [pendingInput]);

	const sendPrompt = () => {
		const prompt = input.trim();
		if (!prompt || connectionState !== 'connected') return;
		setMessages((prev) => [
			...prev,
			{ id: `msg-${Date.now()}`, role: 'user', content: prompt, timestamp: Date.now() },
		]);
		setToolEvents([]);
		setError(null);
		setInput('');
		setIsThinking(true);
		setThinkingText('');
		setReasoningText('');
		reasoningRef.current = '';
		wsRef.current?.send(JSON.stringify({ type: 'prompt', content: prompt }));
	};

	const stopAgent = () => {
		wsRef.current?.send(JSON.stringify({ type: 'stop' }));
		setIsStreaming(false);
		setIsThinking(false);
	};

	if (connectionState === 'no_token') {
		return (
			<div className="flex min-h-full flex-col items-center justify-center p-6 text-center">
				<div className="max-w-sm rounded-xl p-8" style={{ background: 'var(--surface)' }}>
					<h1 className="mb-3 text-xl font-semibold">Token Required</h1>
					<p className="mb-4 text-sm" style={{ color: 'var(--text-muted)' }}>
						Open the URL shown in the terminal (includes <code>?token=…</code>).
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col" style={{ height: '100%' }}>
			{/* QR Code Modal */}
			{showQR && (
				<div
					className="fixed inset-0 z-50 flex items-start justify-center p-4"
					style={{ background: 'rgba(0,0,0,0.6)' }}
					onClick={() => setShowQR(false)}
				>
					<div
						className="flex flex-col items-center gap-4 rounded-2xl p-6"
						style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
						onClick={(e) => e.stopPropagation()}
					>
						<h2 className="font-semibold">Open on another device</h2>
						<div className="rounded-xl p-3" style={{ background: 'white' }}>
							<QRCodeSVG value={window.location.href} size={220} />
						</div>
						<p className="max-w-xs text-center text-xs" style={{ color: 'var(--text-muted)' }}>
							Scan to open this session on your phone or tablet
						</p>
					</div>
				</div>
			)}

			{/* Rules Drawer */}
			{showRules && (
				<div
					className="fixed inset-0 z-50 flex items-start justify-center p-4"
					style={{ background: 'rgba(0,0,0,0.6)' }}
					onClick={() => setShowRules(false)}
				>
					<div
						className="w-full max-w-md rounded-2xl p-4"
						style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
						onClick={(e) => e.stopPropagation()}
					>
						<div className="mb-3 flex items-center justify-between">
							<h2 className="font-semibold">Always-Allow Rules</h2>
							{rules.length > 0 && (
								<button
									className="rounded-lg px-3 py-1.5 text-xs font-medium"
									style={{ background: 'var(--error)', color: 'white' }}
									onClick={clearAllRules}
									type="button"
								>
									Clear All
								</button>
							)}
						</div>
						{rules.length === 0 ? (
							<p className="py-4 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
								No rules yet. Use "Allow Always" on a permission request to add one.
							</p>
						) : (
							<div style={{ maxHeight: 'calc(100vh - 16rem)', overflowY: 'auto' }}>
								{rules.map(rule => (
									<div
										key={rule.id}
										className="mb-2 flex items-center gap-2 rounded-xl px-3 py-2"
										style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
									>
										<span className="rounded px-1.5 py-0.5 text-xs font-mono" style={{ background: 'rgba(220,220,170,0.15)', color: 'var(--tool-call)', border: '1px solid var(--tool-call)' }}>
											{rule.kind}
										</span>
										<code className="min-w-0 flex-1 truncate text-xs font-mono" style={{ color: 'var(--text)' }}>
											{rule.pattern}
										</code>
										<button
											className="shrink-0 rounded p-1 opacity-60 hover:opacity-100"
											onClick={() => deleteRule(rule.id)}
											title="Remove rule"
											type="button"
										>
											<svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
												<path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
											</svg>
										</button>
									</div>
								))}
							</div>
						)}
					</div>
				</div>
			)}

			{/* Session Picker Modal */}
			{showPicker && (
				<div
					className="fixed inset-0 z-50 flex items-start justify-center p-4"
					style={{ background: 'rgba(0,0,0,0.6)' }}
					onClick={() => { if (!noSession) setShowPicker(false); }}
				>
					<div
						className="w-full max-w-md rounded-2xl p-4"
						style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
						onClick={(e) => e.stopPropagation()}
					>
						<div className="mb-3 flex items-center justify-between">
							<h2 className="font-semibold">Sessions</h2>
							<button
								className="rounded-lg px-3 py-1.5 text-sm font-medium"
								style={{ background: 'var(--primary)', color: 'white' }}
								onClick={newSession}
								type="button"
							>
								+ New
							</button>
						</div>
						<div style={{ maxHeight: "calc(100vh - 12rem)", overflowY: "auto" }}>
							{sessions.map((s) => {
								const isActive = s.sessionId === activeSessionId;
								const isConfirming = confirmDeleteId === s.sessionId;
								return (
									<div
										key={s.sessionId}
										className="mb-2 flex items-center rounded-xl"
										style={{
											background: isActive ? 'rgba(88,166,255,0.12)' : 'var(--bg)',
											border: `1px solid ${isActive ? 'var(--primary)' : 'var(--border)'}`,
										}}
									>
										{/* Clickable session info */}
										<button
											className="min-w-0 flex-1 p-3 text-left"
											onClick={() => switchSession(s.sessionId)}
											type="button"
										>
											<div className="truncate text-sm font-medium">
												{s.summary ?? s.sessionId.slice(0, 8) + '…'}
											</div>
											<div className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
												{s.modifiedTime ? timeAgo(s.modifiedTime) : ''}
												{' · '}{s.sessionId.slice(0, 8)}
											</div>
										</button>

										{/* Action buttons */}
										{isConfirming ? (
											<div className="flex shrink-0 items-center gap-1 pr-2">
												<span className="text-xs" style={{ color: isActive ? 'var(--error)' : 'var(--text-muted)' }}>{isActive ? 'End + Delete?' : 'Delete?'}</span>
												<button
													onClick={(e) => deleteSession(s.sessionId, e)}
													className="rounded px-2 py-1 text-xs font-medium"
													style={{ background: 'var(--error)', color: 'white' }}
													type="button"
												>Yes</button>
												<button
													onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
													className="rounded px-2 py-1 text-xs"
													style={{ background: 'var(--border)' }}
													type="button"
												>No</button>
											</div>
										) : (
											<div className="flex shrink-0 items-center gap-0.5 pr-2">
												{/* Shield toggle */}
												<button
													onClick={(e) => toggleShield(s.sessionId, e)}
													className="rounded p-1.5 opacity-70 hover:opacity-100"
													title={s.shielded ? 'Remove shield' : 'Shield session'}
													type="button"
												>
													<svg className="size-4" viewBox="0 0 24 24" fill={s.shielded ? '#f5a623' : 'none'} stroke={s.shielded ? '#f5a623' : 'currentColor'} strokeWidth="2">
														<path d="M12 2L4 5v6c0 5.25 3.75 10.15 8 11 4.25-.85 8-5.75 8-11V5L12 2z" />
													</svg>
												</button>
												{/* Delete — disabled only if shielded */}
												<button
													onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(s.sessionId); }}
													className="rounded p-1.5"
													style={{ opacity: s.shielded ? 0.25 : 0.7, cursor: s.shielded ? "not-allowed" : "pointer" }}
													title={s.shielded ? 'Remove shield to delete' : isActive ? 'Delete current session' : 'Delete session'}
													disabled={s.shielded}
													type="button"
												>
													<svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
														<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" strokeLinecap="round" strokeLinejoin="round" />
													</svg>
												</button>
											</div>
										)}
									</div>
								);
							})}
						</div>
					</div>
				</div>
			)}

			{/* Header */}
			<header
				className="flex items-center justify-between border-b px-4 py-3"
				style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
			>
				<div className="flex items-center gap-2.5">
					<svg className="size-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
						<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
					</svg>
					<div>
						<span className="font-semibold">Copilot Portal</span>
						<div className="text-xs" style={{ color: 'var(--text-muted)' }}>{__BUILD_TIME__}</div>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{isStreaming && (
						<button
							className="rounded-lg px-3 py-1.5 text-sm font-medium"
							style={{ background: 'var(--error)', color: 'white' }}
							onClick={stopAgent}
							type="button"
						>
							Stop
						</button>
					)}
					{activeSessionId && (
						<span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
							{activeSessionId.slice(0, 8)}
						</span>
					)}
					<button
						className="rounded-lg px-3 py-1.5 text-sm font-medium"
						style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
						onClick={openPicker}
						type="button"
						title="Switch session"
					>
						Sessions
					</button>
					<button
						className="rounded-lg px-2 py-1.5 text-sm"
						style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
						onClick={() => setShowQR(v => !v)}
						type="button"
						title="Show QR code"
					>
						⬛
					</button>
					<button
						className="rounded-lg px-2 py-1.5 text-sm"
						style={{ background: rules.length > 0 ? 'rgba(88,166,255,0.12)' : 'var(--bg)', border: `1px solid ${rules.length > 0 ? 'var(--primary)' : 'var(--border)'}`, color: rules.length > 0 ? 'var(--primary)' : undefined }}
						onClick={() => setShowRules(v => !v)}
						type="button"
						title={`Always-allow rules (${rules.length})`}
					>
						{rules.length > 0 ? `✓ ${rules.length}` : '✓'}
					</button>
					<div
						className="size-2.5 rounded-full"
						style={{
							background:
								connectionState === 'connected'
									? 'var(--success)'
									: connectionState === 'connecting'
										? 'var(--tool-call)'
										: 'var(--error)',
						}}
						title={connectionState}
					/>
				</div>
			</header>

			{/* Chat */}
			<main className="flex flex-1 flex-col overflow-hidden">
				{/* Session info drawer — always visible when connected */}
				{connectionState === 'connected' && (
					<SessionDrawer
						open={drawerOpen}
						onToggle={() => setDrawerOpen(v => !v)}
						info={portalInfo}
						context={sessionContext}
						activeModel={activeModel}
						onChangeModel={changeModel}
					/>
				)}
				{/* Landing state — no active session */}
{noSession && !showPicker && (
<div className="flex flex-1 flex-col items-center justify-center text-center gap-4 p-8">
<span style={{ fontSize: '3rem' }}>🤖</span>
<p className="text-lg font-medium">No active session</p>
<p className="text-sm" style={{ color: 'var(--text-muted)' }}>Select an existing session or create a new one.</p>
<button
className="rounded-xl px-6 py-3 text-sm font-medium"
style={{ background: 'var(--btn-bg)', color: 'var(--btn-text)' }}
onClick={() => setShowPicker(true)}
>Browse Sessions</button>
</div>
)}

<div className="flex-1 overflow-y-auto p-4 pb-2" style={{ display: noSession ? 'none' : undefined }}>
					{messages.length === 0 && !isStreaming && !isThinking && connectionState !== 'connected' && (
						<div className="flex h-full flex-col items-center justify-center text-center" style={{ color: 'var(--text-muted)' }}>
							<p className="text-sm">{`Connecting… ${connectingSecs}s`}</p>
						</div>
					)}

					{messages.map((msg) => (
						<div
							key={msg.id}
							className="mb-3"
							style={{
								display: 'flex',
								flexDirection: 'column',
								alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
							}}
						>
							{msg.reasoning && (
								<ThoughtBubble reasoning={msg.reasoning} />
							)}
							<div
								className={msg.role === 'user' ? 'max-w-[85%] rounded-xl px-4 py-3 text-sm' : 'w-full rounded-xl px-4 py-3 text-sm'}
								style={
									msg.role === 'user'
										? { background: 'var(--primary)', color: 'white', borderRadius: '18px 18px 4px 18px' }
										: {
												background: 'var(--surface)',
												border: `1px solid var(--border)`,
												borderRadius: '18px 18px 18px 4px',
											}
								}
							>
								{msg.role === 'assistant'
									? <AssistantMarkdown content={msg.content} />
									: <div className="whitespace-pre-wrap break-words">{msg.content}</div>
								}
								<div className="mt-1 flex items-center justify-between gap-2 text-xs opacity-50">
									<span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
									<CopyButton text={msg.content} />
								</div>
							</div>
						</div>
					))}

					{toolEvents.map((tc) => {
						if (tc.type === 'intent') {
							return (
								<div key={tc.id} className="mb-1 flex items-center gap-1.5 text-xs italic py-0.5" style={{ color: 'var(--purple, #c586c0)' }}>
									<span>●</span>
									<span>{tc.content}</span>
								</div>
							);
						}
						if (tc.type === 'tool_output') return null;
						const isComplete = tc.type === 'tool_complete';
						const isFailed = isComplete && tc.content === 'failed';
						const label = tc.mcpServerName ? `${tc.mcpServerName} › ${tc.toolName}` : (tc.toolName ?? 'tool');
						return (
							<div
								key={tc.id}
								className="mb-2 rounded-lg border p-3 text-xs"
								style={{
									borderColor: isFailed ? 'var(--error)' : isComplete ? 'var(--success)' : 'var(--tool-call)',
									background: isFailed ? 'rgba(244,135,113,0.08)' : isComplete ? 'rgba(78,201,176,0.08)' : 'rgba(220,220,170,0.08)',
								}}
							>
								<div
									className="flex items-center gap-1.5 font-medium"
									style={{ color: isFailed ? 'var(--error)' : isComplete ? 'var(--success)' : 'var(--tool-call)' }}
								>
									<span>{isFailed ? '✗' : isComplete ? '✅' : '⚙️'}</span>
									<span>{isFailed ? 'Failed' : isComplete ? 'Done' : 'Running'}: {label}</span>
								</div>
							</div>
						);
					})}

					{reasoningText && isThinking && (
						<ThoughtBubble reasoning={reasoningText} defaultExpanded />
					)}

					{isThinking && (
						<div className="mb-2 flex items-center gap-2 py-1 text-sm" style={{ color: 'var(--text-muted)' }}>
							<span className="flex shrink-0 gap-1">
								{[0, 0.2, 0.4].map((delay) => (
									<span
										key={delay}
										className="size-1.5 rounded-full"
										style={{
											background: 'var(--text-muted)',
											animation: `thinking 1.2s ${delay}s infinite`,
											display: 'inline-block',
										}}
									/>
								))}
							</span>
							<span className="truncate italic">
								{thinkingText ? thinkingText.slice(-80) : 'Thinking…'}
							</span>
						</div>
					)}

					{isStreaming && streamingContent && (
						<div
							className="mb-3 w-full rounded-xl px-4 py-3 text-sm"
							style={{
								background: 'var(--surface)',
								border: `1px solid var(--border)`,
								borderRadius: '18px 18px 18px 4px',
							}}
						>
							<AssistantMarkdown content={streamingContent} />
							<span
								className="ml-0.5 inline-block size-2 align-text-bottom"
								style={{ background: 'var(--primary)', animation: 'blink 1s infinite' }}
							/>
						</div>
					)}

					{error && (
						<div
							className="mb-2 rounded-xl px-4 py-3 text-sm"
							style={{ background: 'rgba(244,135,113,0.12)', border: '1px solid var(--error)', color: 'var(--error)' }}
						>
							<strong>Error:</strong> {error}
						</div>
					)}

					<div ref={chatEndRef} />
				</div>

				{/* Pinned interaction zone — approval & input cards sit above the input bar */}
				{(pendingApproval || pendingInput) && (
					<div className="border-t px-4 pt-3 pb-1" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
						{pendingApproval && (
							<div className="mb-2 rounded-xl border p-3" style={{ borderColor: 'var(--tool-call)', background: 'rgba(220,220,170,0.08)' }}>
								<div className="mb-1 flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--tool-call)' }}>
									<span>⚠️</span> Permission Request — <span className="font-mono text-xs">{pendingApproval.action}</span>
								</div>
								<pre className="mb-2 overflow-auto rounded px-3 py-2 text-xs font-mono" style={{ background: 'var(--bg)', color: 'var(--text)', maxHeight: 80 }}>{pendingApproval.summary}</pre>
								<div className="flex flex-col gap-1.5">
									<div className="flex gap-2">
										<button className="flex-1 rounded-lg py-2 text-sm font-medium" style={{ background: 'var(--success)', color: 'white' }} onClick={() => respondApproval(true)} type="button">Allow</button>
										<button className="flex-1 rounded-lg py-2 text-sm font-medium" style={{ background: 'var(--error)', color: 'white' }} onClick={() => respondApproval(false)} type="button">Deny</button>
									</div>
									{pendingApproval.alwaysPattern && (
										<button
											className="w-full rounded-lg py-1.5 text-xs font-medium"
											style={{ background: 'rgba(220,200,100,0.15)', border: '1px solid var(--tool-call)', color: 'var(--tool-call)' }}
											onClick={respondApprovalAlways}
											type="button"
										>
											Allow Always: <code className="font-mono">{pendingApproval.alwaysPattern}</code>
										</button>
									)}
								</div>
							</div>
						)}
						{pendingInput && (
							<div className="mb-2 rounded-xl border p-3" style={{ borderColor: 'var(--primary)', background: 'rgba(88,166,255,0.08)' }}>
								<div className="mb-2 text-sm font-semibold">{pendingInput.question}</div>
								{pendingInput.choices && pendingInput.choices.length > 0 && (
									<div className="mb-2 flex flex-col gap-1.5">
										{pendingInput.choices.map((choice, i) => (
											<button key={i} className="rounded-lg px-3 py-2 text-left text-sm" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }} onClick={() => respondInput(choice, false)} type="button">{choice}</button>
										))}
									</div>
								)}
								{(pendingInput.allowFreeform !== false || !pendingInput.choices?.length) && (
									<div className="flex gap-2">
										<input
											className="flex-1 rounded-lg border px-3 py-2 text-sm"
											style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
											placeholder="Type your answer…"
											value={freeformAnswer}
											onChange={(e) => setFreeformAnswer(e.target.value)}
											onKeyDown={(e) => { if (e.key === 'Enter') respondInput(freeformAnswer, true); }}
											autoFocus
										/>
										<button className="rounded-lg px-4 py-2 text-sm font-medium" style={{ background: 'var(--primary)', color: 'white' }} onClick={() => respondInput(freeformAnswer, true)} type="button">Send</button>
									</div>
								)}
							</div>
						)}
					</div>
				)}

				{/* Input */}
				{!noSession && <>
				<form
					className="border-t px-4 py-3"
					style={{
						background: 'var(--surface)',
						borderColor: 'var(--border)',
						paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))',
					}}
					onSubmit={(e) => {
						e.preventDefault();
						sendPrompt();
					}}
				>
					<div className="flex items-end gap-2">
						<div className="flex-1 overflow-hidden rounded-xl border" style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}>
							<textarea
								className="w-full resize-none bg-transparent px-4 py-3 text-sm outline-none"
								style={{ color: 'var(--text)', minHeight: 44, maxHeight: 120 }}
								placeholder={connectionState === 'connected' ? 'Ask Copilot…' : `Connecting… ${connectingSecs}s`}
								disabled={connectionState !== 'connected'}
								rows={1}
								value={input}
								onChange={(e) => setInput(e.target.value)}
								enterKeyHint="enter"
								onKeyDown={(e) => {
									// Touch devices (iOS): Enter adds newlines — send via button only.
									// Desktop: Enter sends, Shift+Enter adds newline.
									const isTouch = window.matchMedia('(hover: none)').matches;
									if (e.key === 'Enter' && !e.shiftKey && !isTouch) {
										e.preventDefault();
										sendPrompt();
									}
								}}
							/>
						</div>
						<button
							className="flex size-11 shrink-0 items-center justify-center rounded-full border-none"
							style={{
								background: input.trim() && connectionState === 'connected' ? 'var(--primary)' : 'var(--border)',
								color: 'white',
								cursor: input.trim() && connectionState === 'connected' ? 'pointer' : 'default',
							}}
							disabled={!input.trim() || connectionState !== 'connected'}
							type="submit"
						>
							<svg className="size-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
								<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
							</svg>
						</button>
					</div>
				</form>
				</>
				}
			</main>
		</div>
	);
}
