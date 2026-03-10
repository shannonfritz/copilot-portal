import * as vscode from 'vscode';

export interface AgentEvent {
	type: 'delta' | 'thinking' | 'tool_call' | 'tool_result' | 'idle' | 'error';
	content?: string;
	toolName?: string;
	params?: unknown;
	result?: unknown;
}

export class PortalAgent {
	private abortController: AbortController | null = null;
	private messages: vscode.LanguageModelChatMessage[] = [];

	constructor(
		private onEvent: (event: AgentEvent) => void,
		private outputChannel: vscode.OutputChannel,
	) {}

	private async selectModel(): Promise<vscode.LanguageModelChat | undefined> {
		// Log all available models to help diagnose access issues
		const all = await vscode.lm.selectChatModels({ vendor: 'copilot' });
		this.log(`[Agent] Available models: ${all.map((m) => `${m.name} (${m.id})`).join(', ') || 'none'}`);

		// Preferred model families in order — avoid "Internal only" models
		const preferred = ['gpt-4.1', 'gpt-4o', 'claude-3.5-sonnet', 'claude-sonnet-4'];
		for (const family of preferred) {
			const [model] = all.filter((m) => m.family === family);
			if (model) {
				this.log(`[Agent] Selected: ${model.name} (family: ${family})`);
				return model;
			}
		}
		// Fallback: any model that isn't marked internal
		const model = all.find((m) => !m.name.toLowerCase().includes('internal'));
		if (model) {
			this.log(`[Agent] Fallback model: ${model.name}`);
			return model;
		}
		if (all[0]) {
			this.log(`[Agent] Last-resort model: ${all[0].name}`);
			return all[0];
		}
		return undefined;
	}

	private log(msg: string) {
		const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		this.outputChannel.appendLine(`[${ts}] ${msg}`);
	}

	async sendPrompt(prompt: string) {
		if (this.abortController) {
			this.abortController.abort();
		}
		this.abortController = new AbortController();
		this.messages.push(vscode.LanguageModelChatMessage.User(prompt));

		try {
			const model = await this.selectModel();
			if (!model) {
				this.onEvent({
					type: 'error',
					content: 'No usable Copilot model found. Make sure GitHub Copilot is installed and authenticated in VS Code.',
				});
				return;
			}

			this.log(`[Agent] Using model: ${model.name}`);

			const response = await model.sendRequest(
				this.messages,
				{ justification: 'Copilot Portal: remote mobile access to Copilot Agent' },
				this.abortController.signal,
			);

			let fullResponse = '';
			for await (const chunk of response.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					fullResponse += chunk.value;
					this.onEvent({ type: 'delta', content: chunk.value });
				}
			}

			this.messages.push(vscode.LanguageModelChatMessage.Assistant(fullResponse));
			this.log(`[Agent] Response complete (${fullResponse.length} chars)`);
			this.onEvent({ type: 'idle' });
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') return;
			const msg = error instanceof Error ? error.message : String(error);
			// Extract any extra fields VS Code puts on the error (code, cause, etc.)
			const extra = JSON.stringify(error, Object.getOwnPropertyNames(error));
			this.log(`[Agent] Error: ${msg}`);
			this.log(`[Agent] Error detail: ${extra.slice(0, 500)}`);
			this.log(`[Agent] Tip: open Help > Toggle Developer Tools > Console in VS Code for full details`);
			this.onEvent({ type: 'error', content: msg });
		} finally {
			this.abortController = null;
		}
	}

	stop() {
		this.abortController?.abort();
		this.abortController = null;
	}

	clearHistory() {
		this.messages = [];
	}
}
