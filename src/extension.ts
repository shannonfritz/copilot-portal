import * as vscode from 'vscode';
import { PortalServer } from './server';

let server: PortalServer | undefined;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('Copilot Portal');
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'copilot-portal.showQR';
	context.subscriptions.push(statusBarItem, outputChannel);

	context.subscriptions.push(
		vscode.commands.registerCommand('copilot-portal.start', () => startServer(context)),
		vscode.commands.registerCommand('copilot-portal.stop', () => stopServer()),
		vscode.commands.registerCommand('copilot-portal.showQR', () => showQR(context)),
	);

	const config = vscode.workspace.getConfiguration('copilotPortal');
	if (config.get<boolean>('autoStart')) {
		startServer(context);
	}
}

async function startServer(context: vscode.ExtensionContext) {
	if (server) {
		vscode.window.showInformationMessage('Copilot Portal is already running.');
		return;
	}

	const config = vscode.workspace.getConfiguration('copilotPortal');
	const port = config.get<number>('port') ?? 3847;

	server = new PortalServer(port, context, outputChannel);
	try {
		await server.start();
		statusBarItem.text = `$(broadcast) Portal: ${port}`;
		statusBarItem.tooltip = 'Copilot Portal running — click for QR code';
		statusBarItem.show();
		outputChannel.appendLine(`Server started on port ${port}`);
		outputChannel.appendLine(`Phone URL: ${server.getURL()}`);
		outputChannel.show();
	} catch (err) {
		server = undefined;
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Copilot Portal failed to start: ${msg}`);
	}
}

async function stopServer() {
	if (!server) return;
	await server.stop();
	server = undefined;
	statusBarItem.hide();
	outputChannel.appendLine('Server stopped.');
	vscode.window.showInformationMessage('Copilot Portal stopped.');
}

async function showQR(context: vscode.ExtensionContext) {
	if (!server) {
		const choice = await vscode.window.showInformationMessage(
			'Copilot Portal is not running. Start it?',
			'Start',
		);
		if (choice === 'Start') {
			await startServer(context);
		} else {
			return;
		}
	}
	server?.showQRCode(context);
}

export function deactivate() {
	server?.stop();
}
