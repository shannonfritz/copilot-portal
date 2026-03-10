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

	async sendPrompt(prompt: string) {
		if (this.abortController) {
			this.abortController.abort();
		}
		this.abortController = new AbortController();
		this.messages.push(vscode.LanguageModelChatMessage.User(prompt));

		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			const model = models[0];
			if (!model) {
				this.onEvent({
					type: 'error',
					content: 'No Copilot model available. Make sure GitHub Copilot is installed and authenticated in VS Code.',
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
