import { PortalServer } from './server.js';
import qrcode from 'qrcode-terminal';

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

// Print QR code for easy phone access
console.log('\nScan to open on your phone:');
qrcode.generate(server.getURL(), { small: true });
