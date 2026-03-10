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
		// Preferred model families in order — avoid "Internal only" models
		const preferred = ['gpt-4.1', 'gpt-4o', 'claude-3.5-sonnet', 'claude-sonnet-4'];
		for (const family of preferred) {
			const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
			if (model) {
				this.outputChannel.appendLine(`[Agent] Using model: ${model.name} (family: ${family})`);
				return model;
			}
		}
		// Fallback: any model that isn't marked internal
		const all = await vscode.lm.selectChatModels({ vendor: 'copilot' });
		const model = all.find((m) => !m.name.toLowerCase().includes('internal'));
		if (model) {
			this.outputChannel.appendLine(`[Agent] Using fallback model: ${model.name}`);
			return model;
		}
		// Last resort: whatever is available
		if (all[0]) {
			this.outputChannel.appendLine(`[Agent] Using last-resort model: ${all[0].name}`);
			return all[0];
		}
		return undefined;
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

			this.outputChannel.appendLine(`[Agent] Sending prompt to ${model.name}: ${prompt.slice(0, 80)}...`);

			const response = await model.sendRequest(this.messages, {}, this.abortController.signal);

			let fullResponse = '';
			for await (const chunk of response.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					fullResponse += chunk.value;
					this.onEvent({ type: 'delta', content: chunk.value });
				}
			}

			this.messages.push(vscode.LanguageModelChatMessage.Assistant(fullResponse));
			this.outputChannel.appendLine(`[Agent] Response complete (${fullResponse.length} chars)`);
			this.onEvent({ type: 'idle' });
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') return;
			const msg = error instanceof Error ? error.message : String(error);
			this.outputChannel.appendLine(`[Agent] Error: ${msg}`);
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
