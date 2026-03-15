import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };
const buildTime = new Date().toISOString().replace('T', ' ').slice(0, 16);

export default defineConfig({
	plugins: [react(), tailwindcss()],
	define: {
		__BUILD_TIME__: JSON.stringify(buildTime),
		__VERSION__: JSON.stringify(version),
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
