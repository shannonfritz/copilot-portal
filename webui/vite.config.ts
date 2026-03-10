import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: {
		outDir: '../dist/webui',
		emptyOutDir: true,
	},
	server: {
		// In dev mode, proxy WebSocket and API to the extension server
		proxy: {
			'/ws': { target: 'ws://localhost:3847', ws: true },
		},
	},
});
