import { PortalServer } from './server.js';
import qrcode from 'qrcode-terminal';
import { exec } from 'node:child_process';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
	console.log(`Usage: node dist/server.js [options]

Options:
  --port <n>     Port to listen on (default: 3847)
  --data <dir>   Data directory for token, rules, and settings
  --launch       Open the portal URL in your default browser on start
  --no-qr        Suppress the QR code output
  --help         Show this help

See README.md for full setup instructions.`);
	process.exit(0);
}

const getArg = (flag: string) => {
	const i = args.indexOf(flag);
	return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};

const PORT = parseInt(getArg('--port') ?? '3847', 10);
const DATA_DIR = getArg('--data');
const LAUNCH = args.includes('--launch');
const NO_QR = args.includes('--no-qr');

const server = new PortalServer(PORT, DATA_DIR);

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
