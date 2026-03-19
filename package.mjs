// package.mjs — Bump BUILD, build, and create a distributable zip.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';

const root = join(fileURLToPath(import.meta.url), '..');
process.chdir(root);

// 1. Bump BUILD
const prev = parseInt(readFileSync('BUILD', 'utf8').trim(), 10) || 0;
const buildNum = prev + 1;
writeFileSync('BUILD', `${buildNum}\n`);

// 2. Compute version string
const now = new Date();
const yy = now.getUTCFullYear().toString().slice(2);
const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
const dd = String(now.getUTCDate()).padStart(2, '0');
const version = `${yy}${mm}${dd}-${String(buildNum).padStart(2, '0')}`;
console.log(`\n  Building version: ${version}\n`);

// 3. Build
execSync('npm run build', { stdio: 'inherit' });

// 4. Stage files
const stamp = `copilot-portal-${version}`;
const stage = join(process.env.TEMP || '/tmp', stamp);
if (existsSync(stage)) rmSync(stage, { recursive: true });
mkdirSync(stage, { recursive: true });

const files = [
	'dist', 'package.dist.json', 'patch.mjs', 'README.md', 'BUILD',
	'install.cmd', 'install.sh',
	'start.cmd', 'start.sh',
	'start-and-launch.cmd', 'start-and-launch.sh',
];
for (const f of files) {
	const dest = f === 'package.dist.json' ? join(stage, 'package.json') : join(stage, f);
	cpSync(f, dest, { recursive: true });
}

// 5. Create zip (PowerShell on Windows, zip on Unix)
const zipName = `${stamp}.zip`;
const zipPath = join(root, zipName);
if (existsSync(zipPath)) rmSync(zipPath);

if (process.platform === 'win32') {
	execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}'"`, { stdio: 'inherit' });
} else {
	execSync(`cd "${stage}" && zip -r "${zipPath}" .`, { stdio: 'inherit' });
}

// 6. Cleanup
rmSync(stage, { recursive: true });

console.log(`\n  ✔ ${zipName} created`);
console.log(`  ✔ BUILD bumped to ${buildNum}`);
console.log(`\n  Don't forget to commit the BUILD file!\n`);
