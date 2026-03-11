// spike/test.mjs — quick smoke test of @github/copilot-sdk
// Tests: connect, create session, send message, stream response, resume session
import { CopilotClient } from '@github/copilot-sdk';

const client = new CopilotClient();

console.log('Starting client...');
await client.start();
console.log('Client started. Auth status:');
const auth = await client.getAuthStatus();
console.log(' ', JSON.stringify(auth));

console.log('\nCreating session...');
const session = await client.createSession({
  onPermissionRequest: async (req) => {
    console.log('[PERMISSION]', JSON.stringify(req));
    return { approved: true }; // auto-approve for spike
  },
});
console.log('Session ID:', session.sessionId);

// Subscribe to all events
session.on((event) => {
  if (event.type === 'assistant.streaming_delta') {
    process.stdout.write(event.data?.delta ?? '');
  } else if (event.type === 'assistant.message') {
    console.log('\n[idle — full message length:', event.data?.content?.length, ']');
  } else if (event.type === 'session.idle') {
    // handled via sendAndWait
  } else {
    console.log('[event]', event.type, JSON.stringify(event.data ?? '').slice(0, 80));
  }
});

console.log('\nSending prompt...');
const response = await session.sendAndWait({ prompt: 'Reply with exactly: SPIKE_OK' }, 30000);
console.log('Response:', response?.data?.content);

const sid = session.sessionId;
console.log('\nDisconnecting session (preserves history on disk)...');
await session.disconnect();

console.log('\nResuming session by ID:', sid);
const resumed = await client.resumeSession(sid, {
  onPermissionRequest: async () => ({ approved: true }),
});
const history = await resumed.getMessages();
console.log('History events after resume:', history.length);
const msgs = history.filter(e => e.type === 'assistant.message' || e.type === 'user.message');
console.log('Messages:', msgs.map(e => `[${e.type}] ${String(e.data?.content ?? '').slice(0, 40)}`));

await resumed.disconnect();
await client.stop();
console.log('\nSPIKE COMPLETE');
