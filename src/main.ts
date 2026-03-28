import { PortalServer } from './server.js';
import qrcode from 'qrcode-terminal';
import { exec, spawnSync } from 'node:child_process';

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
	await server.stop().catch(() => {});
	if (process.platform === 'win32') {
		spawnSync('pwsh', ['-NoProfile', '-Command',
			`Get-NetTCPConnection -LocalPort 3848 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`
		], { stdio: 'ignore', windowsHide: true });
	}
	process.exit(0);
});

process.on('SIGTERM', async () => {
	await server.stop().catch(() => {});
	if (process.platform === 'win32') {
		spawnSync('pwsh', ['-NoProfile', '-Command',
			`Get-NetTCPConnection -LocalPort 3848 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`
		], { stdio: 'ignore', windowsHide: true });
	}
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
				return;
			}
		}
		// Unrecognized key — re-show the menu
		renderCliPage();
	};

	let confirmingCliLaunch: { sessionId?: string } | null = null;

	const launchCliTui = (sessionId?: string) => {
		// Show confirmation — switching from headless to TUI requires server restart
		confirmingCliLaunch = { sessionId };
		console.log('\n  This will restart the CLI server in TUI mode.');
		console.log('  The portal will briefly disconnect and reconnect.');
		console.log('\n  [y] Continue  [n] Cancel\n');
	};

	const handleConfirm = (key: string) => {
		if (!confirmingCliLaunch) return;
		if (key === 'n' || key === 'c') {
			confirmingCliLaunch = null;
			console.log('  Cancelled.\n');
			return;
		}
		if (key === 'y') {
			const sessionId = confirmingCliLaunch.sessionId;
			confirmingCliLaunch = null;

			console.log('  Stopping headless CLI server...');
			// Notify portal clients that the CLI server is switching
			server.broadcastAll({ type: 'info', content: 'Switching CLI Server to TUI mode - reloading...' });
			// Kill the process on port 3848
			if (process.platform === 'win32') {
				spawnSync('pwsh', ['-NoProfile', '-Command',
					`Get-NetTCPConnection -LocalPort 3848 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`
				], { stdio: 'ignore', windowsHide: true });
			}

			// Wait a moment for port to free, then launch TUI server
			setTimeout(() => {
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
				console.log(`  CLI TUI opening${sessionId ? ` (session ${sessionId.slice(0, 8)})` : ' (new session)'}...`);
				console.log('  Portal will reconnect automatically.\n');
				// Tell clients to reload so they reconnect to the new CLI server
				setTimeout(() => {
					server.broadcastAll({ type: 'reload' });
				}, 3000);
			}, 1500);
			return;
		}
		// Unrecognized — re-show prompt
		console.log('\n  [y] Continue  [n] Cancel\n');
	};

	let updateInProgress = false;

	const killCliServer = () => {
		if (process.platform === 'win32') {
			spawnSync('pwsh', ['-NoProfile', '-Command',
				`Get-NetTCPConnection -LocalPort 3848 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`
			], { stdio: 'ignore', windowsHide: true });
		}
	};

	const shutdown = async () => {
		console.log('\nShutting down...');
		await server.stop().catch(() => {}); // disconnect SDK first
		killCliServer(); // then kill CLI process
		process.exit(0);
	};

	const showHelp = () => {
		console.log('\n  Command Keys: [t] CLI TUI  [l] Launch Browser  [q] QR/URL  [u] Update  [r] Restart  [x] Exit\n');
	};
	showHelp();

	process.stdin.on('data', (key: string) => {
		// If confirming CLI launch, handle y/n
		if (confirmingCliLaunch) {
			handleConfirm(key.toLowerCase());
			return;
		}
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
				console.log(`\n  ${server.getURL()}\n`);
				console.log('Scan to open on your phone:');
				qrcode.generate(server.getURL(), { small: true });
				break;
			case 'u':
				if (updateInProgress) { console.log('\n  Update already in progress...\n'); break; }
				console.log('\n  Checking for updates...');
				server.checkForUpdates().then(async (result) => {
					if (!result.hasUpdates) {
						console.log(`  ${result.summary}\n`);
						return;
					}
					console.log(`  Available: ${result.summary}`);
					console.log('  Applying updates...');
					updateInProgress = true;
					const msg = await server.applyUpdates();
					updateInProgress = false;
					console.log(`  ${msg}\n`);
				}).catch((e) => {
					updateInProgress = false;
					console.log(`  Update check failed: ${e}\n`);
				});
				break;
			case 'r':
				console.log('\nRestarting...');
				process.exit(75); // launcher catches this and relaunches
				break;
			case 'x':
				shutdown();
				break;
			case '\u0003': // Ctrl+C
				shutdown();
				break;
			default:
				showHelp();
				break;
		}
	});
}
