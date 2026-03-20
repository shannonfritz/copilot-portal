const esbuild = require('esbuild');
const fs = require('fs');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const buildNum = parseInt(fs.readFileSync('BUILD', 'utf8').trim(), 10) || 0;
const now = new Date();
const yy = now.getUTCFullYear().toString().slice(2);
const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
const dd = String(now.getUTCDate()).padStart(2, '0');
const build = `${yy}${mm}${dd}-${String(buildNum).padStart(2, '0')}`;

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: ['src/main.ts'],
	bundle: true,
	outfile: 'dist/server.js',
	// Leave all node_modules to Node.js — avoids CJS/ESM interop issues
	packages: 'external',
	format: 'esm',
	platform: 'node',
	target: 'node22',
	sourcemap: !production,
	minify: production,
	define: {
		__VERSION__: JSON.stringify(version),
		__BUILD__: JSON.stringify(build),
	},
};

if (watch) {
	esbuild.context(options).then((ctx) => {
		ctx.watch();
		console.log('Watching for changes...');
	}).catch(console.error);
} else {
	Promise.all([
		esbuild.build(options),
		esbuild.build({
			entryPoints: ['src/launcher.ts'],
			bundle: true,
			outfile: 'dist/launcher.js',
			packages: 'external',
			format: 'esm',
			platform: 'node',
			target: 'node22',
			minify: production,
		}),
	]).catch(() => process.exit(1));
}
