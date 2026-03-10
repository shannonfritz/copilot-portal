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
		private logFn: (msg: string) => void,
	) {}

	private async selectModel(): Promise<vscode.LanguageModelChat | undefined> {
		// Log all available models to help diagnose access issues
		const all = await vscode.lm.selectChatModels({ vendor: 'copilot' });
		this.log(`[Agent] Available models: ${all.map((m) => `${m.name} (id:${m.id} family:${m.family})`).join(', ') || 'none'}`);

		// Try preferred models by ID — skip 'auto' (reserved for Copilot Chat itself, returns 400 for 3rd-party extensions)
		const preferredIds = ['claude-sonnet-4.6', 'gpt-4.1', 'gpt-4o', 'claude-haiku-4.5'];
		for (const id of preferredIds) {
			const model = all.find((m) => m.id === id);
			if (model) {
				this.log(`[Agent] Selected: ${model.name} (id: ${id})`);
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
		this.logFn(msg);
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
			const extra = JSON.stringify(error, Object.getOwnPropertyNames(error));
			this.log(`[Agent] Error: ${msg}`);
			this.log(`[Agent] Error detail: ${extra.slice(0, 500)}`);
			this.log(`[Agent] Tip: open Help > Toggle Developer Tools > Console in VS Code for full details`);
			// Remove the failed user message so history stays clean for next attempt
			this.messages.pop();
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
