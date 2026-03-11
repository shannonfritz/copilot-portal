import { PortalServer } from './server.js';

const PORT = parseInt(process.env.PORTAL_PORT ?? '3847', 10);
const server = new PortalServer(PORT);

process.on('SIGINT', async () => {
	console.log('\nShutting down...');
	await server.stop();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	await server.stop();
	process.exit(0);
});

await server.start();
