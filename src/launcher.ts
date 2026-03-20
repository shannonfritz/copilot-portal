/**
 * Launcher with restart support.
 * Runs dist/server.js and relaunches it when it exits with code 75 (restart requested).
 * All other exit codes terminate the launcher.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(__dirname, 'server.js');
const args = process.argv.slice(2);

const RESTART_CODE = 75;

function launch() {
	const child = spawn(process.execPath, [serverScript, ...args], {
		cwd: process.cwd(),
		stdio: 'inherit',
	});

	child.on('exit', (code) => {
		if (code === RESTART_CODE) {
			console.log('\n[Launcher] Restarting server...\n');
			launch();
		} else {
			process.exit(code ?? 0);
		}
	});

	// Forward SIGINT/SIGTERM to child
	const forward = (sig: NodeJS.Signals) => {
		child.kill(sig);
	};
	process.on('SIGINT', () => forward('SIGINT'));
	process.on('SIGTERM', () => forward('SIGTERM'));
}

launch();
