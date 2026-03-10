import { useState, useEffect, useRef, useCallback } from 'react';

interface Message {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	timestamp: number;
}

interface ToolEvent {
	id: string;
	type: 'tool_call' | 'tool_result';
	toolName: string;
	data: unknown;
	timestamp: number;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'no_token';

function getToken(): string | null {
	// Injected by the server into the page
	const injected = (window as unknown as Record<string, unknown>).__PORTAL_TOKEN__;
	if (typeof injected === 'string') {
		localStorage.setItem('portal_token', injected);
		return injected;
	}
	// Fallback: URL param (for manual entry)
	const urlToken = new URLSearchParams(window.location.search).get('token');
	if (urlToken) {
		localStorage.setItem('portal_token', urlToken);
		return urlToken;
	}
	// Fallback: localStorage (if previously connected)
	return localStorage.getItem('portal_token');
}

export default function App() {
	const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
	const [messages, setMessages] = useState<Message[]>([]);
	const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
	const [streamingContent, setStreamingContent] = useState('');
	const [isThinking, setIsThinking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [input, setInput] = useState('');
	const [isStreaming, setIsStreaming] = useState(false);

	const wsRef = useRef<WebSocket | null>(null);
	const streamingRef = useRef('');
	const chatEndRef = useRef<HTMLDivElement>(null);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const connect = useCallback(() => {
		const token = getToken();
		if (!token) {
			setConnectionState('no_token');
			return;
		}

		const wsUrl = `ws://${window.location.host}?token=${token}`;
		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;

		ws.onopen = () => setConnectionState('connected');

		ws.onmessage = (e) => {
			try {
				const event = JSON.parse(e.data as string) as {
					type: string;
					content?: string;
					toolName?: string;
					params?: unknown;
					result?: unknown;
				};

				if (event.type === 'delta') {
					setIsThinking(false);
					setIsStreaming(true);
					streamingRef.current += event.content ?? '';
					setStreamingContent(streamingRef.current);
				} else if (event.type === 'thinking') {
					setIsThinking(true);
				} else if (event.type === 'tool_call') {
					setIsThinking(false);
					setToolEvents((prev) => [
						...prev,
						{
							id: `tc-${Date.now()}`,
							type: 'tool_call',
							toolName: event.toolName ?? 'unknown',
							data: event.params,
							timestamp: Date.now(),
						},
					]);
				} else if (event.type === 'tool_result') {
					setToolEvents((prev) => [
						...prev,
						{
							id: `tr-${Date.now()}`,
							type: 'tool_result',
							toolName: event.toolName ?? 'tool',
							data: event.result,
							timestamp: Date.now(),
						},
					]);
				} else if (event.type === 'idle') {
					const final = streamingRef.current;
					if (final) {
						setMessages((prev) => [
							...prev,
							{ id: `msg-${Date.now()}`, role: 'assistant', content: final, timestamp: Date.now() },
						]);
					}
					streamingRef.current = '';
					setStreamingContent('');
					setIsStreaming(false);
					setIsThinking(false);
				} else if (event.type === 'error') {
					setError(event.content ?? 'Unknown error');
					setIsStreaming(false);
					setIsThinking(false);
				}
			} catch {}
		};

		ws.onclose = () => {
			setConnectionState('disconnected');
			setIsStreaming(false);
			setIsThinking(false);
			reconnectTimer.current = setTimeout(() => connect(), 3000);
		};

		ws.onerror = () => ws.close();
	}, []);

	useEffect(() => {
		connect();
		return () => {
			if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
			wsRef.current?.close();
		};
	}, [connect]);

	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, streamingContent, toolEvents, isThinking]);

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
						Open the URL from VS Code (use "Copilot Portal: Show QR Code").
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-full flex-col">
			{/* Header */}
			<header
				className="flex items-center justify-between border-b px-4 py-3"
				style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
			>
				<div className="flex items-center gap-2.5">
					<svg className="size-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
						<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
					</svg>
					<span className="font-semibold">Copilot Portal</span>
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
				<div className="flex-1 overflow-y-auto p-4 pb-2">
					{messages.length === 0 && !isStreaming && !isThinking && (
						<div
							className="flex h-full flex-col items-center justify-center text-center"
							style={{ color: 'var(--text-muted)' }}
						>
							<svg
								className="mb-3 size-14 opacity-40"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								viewBox="0 0 24 24"
							>
								<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
							</svg>
							<p className="text-sm">
								{connectionState === 'connected' ? 'Send a prompt to Copilot' : 'Connecting…'}
							</p>
						</div>
					)}

					{messages.map((msg) => (
						<div
							key={msg.id}
							className="mb-3"
							style={{
								display: 'flex',
								justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
							}}
						>
							<div
								className="max-w-[85%] rounded-xl px-4 py-3 text-sm"
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
								<div className="whitespace-pre-wrap break-words">{msg.content}</div>
								<div className="mt-1 text-xs opacity-50">
									{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
								</div>
							</div>
						</div>
					))}

					{toolEvents.map((tc) => (
						<div
							key={tc.id}
							className="mb-2 rounded-lg border p-3 text-xs"
							style={{
								borderColor: tc.type === 'tool_call' ? 'var(--tool-call)' : 'var(--success)',
								background: tc.type === 'tool_call' ? 'rgba(220,220,170,0.08)' : 'rgba(78,201,176,0.08)',
							}}
						>
							<div
								className="mb-1 flex items-center gap-1.5 font-medium"
								style={{ color: tc.type === 'tool_call' ? 'var(--tool-call)' : 'var(--success)' }}
							>
								<span>{tc.type === 'tool_call' ? '⚙️' : '✅'}</span>
								<span>
									{tc.type === 'tool_call' ? 'Calling' : 'Result'}: {tc.toolName}
								</span>
							</div>
							{tc.data != null && (
								<pre className="overflow-auto rounded px-2 py-1.5 font-mono" style={{ background: 'var(--bg)', color: 'var(--text-muted)' }}>
									{typeof tc.data === 'string' ? tc.data.slice(0, 300) : JSON.stringify(tc.data, null, 2).slice(0, 300)}
								</pre>
							)}
						</div>
					))}

					{isThinking && (
						<div className="mb-2 flex items-center gap-2 py-1 text-sm" style={{ color: 'var(--text-muted)' }}>
							<span className="flex gap-1">
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
							<span>Thinking…</span>
						</div>
					)}

					{isStreaming && streamingContent && (
						<div
							className="mb-3 max-w-[85%] rounded-xl px-4 py-3 text-sm"
							style={{
								background: 'var(--surface)',
								border: `1px solid var(--border)`,
								borderRadius: '18px 18px 18px 4px',
							}}
						>
							<div className="whitespace-pre-wrap break-words">{streamingContent}</div>
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

				{/* Input */}
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
								placeholder={connectionState === 'connected' ? 'Ask Copilot…' : 'Connecting…'}
								disabled={connectionState !== 'connected'}
								rows={1}
								value={input}
								onChange={(e) => setInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter' && !e.shiftKey) {
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
			</main>
		</div>
	);
}
