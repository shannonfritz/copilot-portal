const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	outfile: 'dist/extension.js',
	external: ['vscode'],
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	sourcemap: !production,
	minify: production,
};

if (watch) {
	esbuild.context(options).then((ctx) => {
		ctx.watch();
		console.log('Watching for changes...');
	}).catch(console.error);
} else {
	esbuild.build(options).catch(() => process.exit(1));
}
