import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'fs';

const buildNum = parseInt(readFileSync('../BUILD', 'utf8').trim(), 10) || 0;
const yy = new Date().getUTCFullYear().toString().slice(2);
const mm = String(new Date().getUTCMonth() + 1).padStart(2, '0');
const dd = String(new Date().getUTCDate()).padStart(2, '0');
const version = `${yy}${mm}${dd}-${String(buildNum).padStart(2, '0')}`;
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
