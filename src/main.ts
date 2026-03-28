import { PortalServer } from './server.js';
import qrcode from 'qrcode-terminal';
import { exec } from 'node:child_process';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
	console.log(`Usage: node dist/server.js [options]

Options:
  --port <n>       Port to listen on (default: 3847)
  --cli-url <url>  Connect to a running CLI server (e.g. localhost:3848)
  --data <dir>     Data directory for token, rules, and settings
  --new-token      Generate a new access token (invalidates existing URLs)
  --launch         Open the portal URL in your default browser on start
  --no-qr          Suppress the QR code output
  --help           Show this help

See README.md for full setup instructions.`);
	process.exit(0);
}

const getArg = (flag: string) => {
	const i = args.indexOf(flag);
	return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};

const PORT = parseInt(getArg('--port') ?? '3847', 10);
const CLI_URL = getArg('--cli-url');
const DATA_DIR = getArg('--data');
const LAUNCH = args.includes('--launch');
const NO_QR = args.includes('--no-qr');
const NEW_TOKEN = args.includes('--new-token');

const server = new PortalServer(PORT, DATA_DIR, { newToken: NEW_TOKEN, cliUrl: CLI_URL });

process.on('SIGINT', async () => {
	console.log('\nShutting down...');
	await server.stop();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	await server.stop();
	process.exit(0);
});

await server.start();

// Print QR code for easy phone access
if (!NO_QR) {
	console.log('\nScan to open on your phone:');
	qrcode.generate(server.getURL(), { small: true });
}

if (LAUNCH) {
	const url = server.getURL();
	const cmd = process.platform === 'win32' ? `start "" "${url}"`
		: process.platform === 'darwin' ? `open "${url}"`
		: `xdg-open "${url}"`;
	exec(cmd);
}

// Console key commands
if (process.stdin.isTTY) {
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding('utf8');

	let cliPickerState: { sessions: Array<{ sessionId: string; summary?: string }>; page: number } | null = null;

	const showCliPicker = async () => {
		const sessions = await server.listSessions();
		if (sessions.length === 0) {
			console.log('\n  No sessions found. Press [n] to create a new one.\n');
		}
		cliPickerState = { sessions, page: 0 };
		renderCliPage();
	};

	const renderCliPage = () => {
		if (!cliPickerState) return;
		const { sessions, page } = cliPickerState;
		const pageSize = 9;
		const start = page * pageSize;
		const pageItems = sessions.slice(start, start + pageSize);
		console.log('\n  Open CLI TUI for session:');
		pageItems.forEach((s, i) => {
			const label = (s.summary ?? '(untitled)').split('\n')[0].slice(0, 60);
			console.log(`    [${i + 1}] ${s.sessionId.slice(0, 8)} ${label}`);
		});
		const hasMore = start + pageSize < sessions.length;
		console.log(`\n    [n] New session${hasMore ? '  [m] More' : ''}  [c] Cancel\n`);
	};

	const handleCliPick = (key: string) => {
		if (!cliPickerState) return;
		if (key === 'c') {
			cliPickerState = null;
			console.log('  Cancelled.\n');
			return;
		}
		if (key === 'n') {
			cliPickerState = null;
			launchCliTui();
			return;
		}
		if (key === 'm') {
			const pageSize = 9;
			const maxPage = Math.floor((cliPickerState.sessions.length - 1) / pageSize);
			cliPickerState.page = cliPickerState.page >= maxPage ? 0 : cliPickerState.page + 1;
			renderCliPage();
			return;
		}
		const idx = parseInt(key, 10);
		if (idx >= 1 && idx <= 9) {
			const start = cliPickerState.page * 9;
			const session = cliPickerState.sessions[start + idx - 1];
			if (session) {
				cliPickerState = null;
				launchCliTui(session.sessionId);
			}
		}
	};

	const launchCliTui = (sessionId?: string) => {
		const args = ['--ui-server', '--port', '3848'];
		if (sessionId) args.push('--resume', sessionId);
		const cmd = `copilot ${args.join(' ')}`;
		if (process.platform === 'win32') {
			exec(`wt -w 0 new-tab --title "Copilot CLI" ${cmd}`);
		} else if (process.platform === 'darwin') {
			exec(`osascript -e 'tell app "Terminal" to do script "${cmd}"'`);
		} else {
			exec(`x-terminal-emulator -e "${cmd}" 2>/dev/null || xterm -e "${cmd}" &`);
		}
		console.log(`  CLI TUI opening${sessionId ? ` (session ${sessionId.slice(0, 8)})` : ' (new session)'}...\n`);
	};

	const showHelp = () => {
		console.log('\n  Command Keys: [t] CLI TUI  [l] Launch Browser  [q] QR code  [u] URL  [r] Restart  [x] Exit\n');
	};
	showHelp();

	process.stdin.on('data', (key: string) => {
		// If CLI picker is active, route keys there
		if (cliPickerState) {
			handleCliPick(key.toLowerCase());
			return;
		}
		switch (key.toLowerCase()) {
			case 't':
				showCliPicker();
				break;
			case 'l': {
				const url = server.getURL();
				const cmd = process.platform === 'win32' ? `start "" "${url}"`
					: process.platform === 'darwin' ? `open "${url}"`
					: `xdg-open "${url}"`;
				exec(cmd);
				console.log(`\n  Opened in browser\n`);
				break;
			}
			case 'q':
				console.log('\nScan to open on your phone:');
				qrcode.generate(server.getURL(), { small: true });
				break;
			case 'u':
				console.log(`\n  ${server.getURL()}\n`);
				break;
			case 'r':
				console.log('\nRestarting...');
				process.exit(75); // launcher catches this and relaunches
				break;
			case 'x':
				console.log('\nShutting down...');
				server.stop().then(() => process.exit(0));
				break;
			case '\u0003': // Ctrl+C
				console.log('\nShutting down...');
				server.stop().then(() => process.exit(0));
				break;
			default:
				showHelp();
				break;
		}
	});
}
