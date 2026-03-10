import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const buildTime = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	define: {
		__BUILD_TIME__: JSON.stringify(buildTime),
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
