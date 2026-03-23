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

	const showHelp = () => {
		console.log('\n  Keys: [q] QR code  [u] URL  [r] Restart  [x] Exit\n');
	};
	showHelp();

	process.stdin.on('data', (key: string) => {
		switch (key.toLowerCase()) {
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
			case '?':
			case 'h':
				showHelp();
				break;
			case '\u0003': // Ctrl+C
				console.log('\nShutting down...');
				server.stop().then(() => process.exit(0));
				break;
		}
	});
}
