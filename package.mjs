// package.mjs — Bump BUILD, build, and create a distributable zip.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';

const root = join(fileURLToPath(import.meta.url), '..');
process.chdir(root);

// 1. Compute today's date prefix and bump BUILD (resets daily)
const now = new Date();
const yy = now.getUTCFullYear().toString().slice(2);
const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
const dd = String(now.getUTCDate()).padStart(2, '0');
const today = `${yy}${mm}${dd}`;

const buildRaw = readFileSync('BUILD', 'utf8').trim();
// The BUILD counter is owned SOLELY by local validation/package runs. When
// NO_BUILD_BUMP is set (CI release builds), stamp the artifact with exactly the
// committed value and do NOT advance or rewrite it. This keeps the counter
// drift-free: the shipped build number always equals the last build you
// committed, and rebuilding the same tag is reproducible.
const noBump = process.env.NO_BUILD_BUMP === '1' || process.env.NO_BUILD_BUMP === 'true';
let build;
if (noBump) {
	// Use the committed value verbatim (no +1, no write).
	build = buildRaw;
	console.log('  • NO_BUILD_BUMP set — using committed BUILD as-is (no increment)');
} else {
	// BUILD file format: "YYMMDD-NN" (e.g. "260323-01") or legacy plain number
	const match = buildRaw.match(/^(\d{6})-(\d+)$/);
	const prevDate = match ? match[1] : '';
	const prevNum = match ? parseInt(match[2], 10) : 0;
	const buildNum = (prevDate === today) ? prevNum + 1 : 1;
	build = `${today}-${String(buildNum).padStart(2, '0')}`;
	writeFileSync('BUILD', `${build}\n`);
}

// 2. Read version + runtime deps from package.json and sync to package.dist.json.
//    package.json's `dependencies` are exactly the runtime closure (devDeps are kept
//    separate), and the zip needs that same closure at `npm install` time — so the dist
//    manifest INHERITS dependencies wholesale from package.json. This makes package.json
//    the single source of truth for runtime versions and prevents the dist manifest from
//    silently rotting (it previously hand-carried a stale `@github/copilot-sdk ^0.3.0`).
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const pkgVersion = pkg.version;
const distPkg = JSON.parse(readFileSync('package.dist.json', 'utf8'));
let distChanged = false;
if (distPkg.version !== pkgVersion) {
	distPkg.version = pkgVersion;
	distChanged = true;
	console.log(`  ⚠ Synced package.dist.json version to ${pkgVersion}`);
}
if (JSON.stringify(distPkg.dependencies) !== JSON.stringify(pkg.dependencies)) {
	distPkg.dependencies = pkg.dependencies;
	distChanged = true;
	console.log(`  ⚠ Synced package.dist.json dependencies from package.json`);
}
if (distChanged) {
	writeFileSync('package.dist.json', JSON.stringify(distPkg, null, '\t') + '\n');
}
console.log(`\n  Version: ${pkgVersion}  Build: ${build}\n`);

// 2b. Floor guardrail (best-effort, WARN-only). The corporate npm proxy
//     (packagefeedproxy.microsoft.io) quarantines newly published versions for several
//     days. A dependency FLOOR that sits above the proxy's newest cleared *stable*
//     version strands fresh installs on Microsoft-managed devices (they can't reach
//     public npmjs). This catches that drift at package time — it would have flagged the
//     `@github/copilot ^1.0.70` floor while the proxy only had 1.0.69. Scope: the
//     @github/* packages (the moving targets that ride the quarantine); the rest are
//     long-stable. Skipped in CI (GitHub runners can't reach the proxy) and off-network;
//     opt out with SKIP_FLOOR_CHECK=1. Never throws — a package build must not depend on
//     corporate network reachability.
if (!process.env.CI && process.env.SKIP_FLOOR_CHECK !== '1') {
	const PROXY = 'https://packagefeedproxy.microsoft.io/npm/';
	const cmp = (a, b) => { for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
	const core = (v) => v.split('-')[0].split('.').map(Number);
	for (const dep of Object.keys(pkg.dependencies).filter((d) => d.startsWith('@github/'))) {
		const range = pkg.dependencies[dep];
		const m = range.match(/(\d+)\.(\d+)\.(\d+)/);
		if (!m) continue;
		const floor = [+m[1], +m[2], +m[3]]; // ^X.Y.Z → same major, >= X.Y.Z
		let versions;
		try {
			versions = JSON.parse(execSync(
				`npm view "${dep}" versions --registry ${PROXY} --json`,
				{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 },
			).trim());
			if (!Array.isArray(versions)) versions = [versions];
		} catch {
			console.log(`  • floor check skipped for ${dep} (proxy not reachable)`);
			continue;
		}
		const stable = versions.filter((v) => !v.includes('-')).map(core).sort(cmp);
		const newest = stable[stable.length - 1];
		const ok = stable.some((v) => v[0] === floor[0] && cmp(v, floor) >= 0);
		if (ok) {
			console.log(`  • floor ok: ${dep} ${range} → proxy newest stable ${newest.join('.')}`);
		} else {
			console.log(`\n  ⚠ FLOOR WARNING: ${dep} ${range} has NO matching stable on the`);
			console.log(`    Microsoft package proxy yet (newest stable there: ${newest ? newest.join('.') : 'none'}).`);
			console.log(`    Fresh installs on managed devices (where public npm is blocked) will`);
			console.log(`    FAIL until the proxy clears a matching version. Consider lowering the floor.\n`);
		}
	}
}

// 3. Build
execSync('npm run build', { stdio: 'inherit' });

// 4. Stage files
const stamp = `copilot-portal-v${pkgVersion}-build-${build}`;
const stage = join(process.env.TEMP || '/tmp', stamp);
if (existsSync(stage)) rmSync(stage, { recursive: true });
mkdirSync(stage, { recursive: true });

const files = [
	'dist', 'bin', 'examples', 'package.dist.json', 'patch.mjs', 'README.md', 'CHANGELOG.md', 'BUILD',
	'start-portal.cmd', 'start-portal.sh',
];
for (const f of files) {
	if (!existsSync(f)) {
		console.log(`  • skipping ${f} (not present)`);
		continue;
	}
	const dest = f === 'package.dist.json' ? join(stage, 'package.json') : join(stage, f);
	cpSync(f, dest, { recursive: true });
}

// 5. Create zip in releases/ directory
const releasesDir = join(root, 'releases');
if (!existsSync(releasesDir)) mkdirSync(releasesDir, { recursive: true });
const zipName = `${stamp}.zip`;
const zipPath = join(releasesDir, zipName);
if (existsSync(zipPath)) rmSync(zipPath);

if (process.platform === 'win32') {
	const ps = `$items = @(); Get-ChildItem -LiteralPath '${stage}' | ForEach-Object { $items += $_.FullName }; Compress-Archive -LiteralPath $items -DestinationPath '${zipPath}'`;
	execSync(`pwsh -NoProfile -Command "${ps}"`, { stdio: 'inherit' });
} else {
	execSync(`cd "${stage}" && zip -r "${zipPath}" .`, { stdio: 'inherit' });
}

// 6. Cleanup
rmSync(stage, { recursive: true });

console.log(`\n  ✔ ${zipName} created`);
console.log(noBump ? `  ✔ BUILD kept at ${build} (no increment)` : `  ✔ BUILD bumped to ${build}`);
console.log(`\n  Don't forget to commit the BUILD file!\n`);
