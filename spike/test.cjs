// spike/test.cjs — CJS smoke test for @github/copilot-sdk
const { CopilotClient } = require('@github/copilot-sdk');

async function main() {
  const client = new CopilotClient();
  console.log('Starting client...');
  await client.start();

  const auth = await client.getAuthStatus();
  console.log('Auth:', JSON.stringify(auth));

  console.log('\nCreating session...');
  const session = await client.createSession({
    onPermissionRequest: async (req) => {
      console.log('[PERMISSION]', JSON.stringify(req));
      return { approved: true };
    },
  });
  console.log('Session ID:', session.sessionId);

  session.on((event) => {
    if (event.type === 'assistant.streaming_delta') {
      process.stdout.write(event.data?.delta ?? '');
    } else if (event.type !== 'session.idle' && event.type !== 'session.turnComplete') {
      console.log('\n[event]', event.type, JSON.stringify(event.data ?? '').slice(0, 120));
    }
  });

  console.log('\nSending prompt...');
  const response = await session.sendAndWait({ prompt: 'Reply with exactly: SPIKE_OK' }, 30000);
  console.log('\nFull response:', response?.data?.content);

  // Test resume
  const sid = session.sessionId;
  console.log('\nDisconnecting and resuming session:', sid);
  await session.disconnect();

  const resumed = await client.resumeSession(sid, {
    onPermissionRequest: async () => ({ approved: true }),
  });
  const history = await resumed.getMessages();
  const msgs = history.filter(e => e.type === 'assistant.message' || e.type === 'user.message');
  console.log('History after resume (' + msgs.length + ' messages):');
  msgs.forEach(e => console.log(' ', `[${e.type}]`, String(e.data?.content ?? '').slice(0, 60)));

  await resumed.disconnect();
  await client.stop();
  console.log('\nSPIKE COMPLETE ✅');
}

main().catch(e => { console.error('SPIKE FAILED ❌:', e.message); process.exit(1); });
