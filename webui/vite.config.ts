import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };
const buildNum = parseInt(readFileSync('../BUILD', 'utf8').trim(), 10) || 0;
const now = new Date();
const yy = now.getUTCFullYear().toString().slice(2);
const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
const dd = String(now.getUTCDate()).padStart(2, '0');
const build = `${yy}${mm}${dd}-${String(buildNum).padStart(2, '0')}`;

export default defineConfig({
	plugins: [react(), tailwindcss()],
	define: {
		__VERSION__: JSON.stringify(version),
		__BUILD__: JSON.stringify(build),
	},
	build: {
		outDir: '../dist/webui',
		emptyOutDir: true,
	},
	server: {
		proxy: {
			'/ws': { target: 'ws://localhost:3847', ws: true },
		},
	},
});
