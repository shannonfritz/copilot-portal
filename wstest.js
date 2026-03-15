const WebSocket = require('ws');
const TOKEN = '6af9912bece4b43f8eca8d7585749574';
const TARGET = 'ccfc5434-3e81-465f-a5c2-4aa6a903a849';
const ws = new WebSocket(`ws://localhost:3847?token=${TOKEN}&session=${TARGET}`);

let sessionSwitchedTo = null;
let historyStartSession = null;
let historyEndSession = null;
let msgCount = 0;

ws.on('message', (data) => {
  const ev = JSON.parse(data.toString());
  if (ev.type === 'session_switched') { sessionSwitchedTo = ev.sessionId; }
  if (ev.type === 'history_start') { historyStartSession = ev.sessionId; msgCount = 0; }
  if (ev.type === 'delta') msgCount++;
  if (ev.type === 'history_end') {
    historyEndSession = ev.sessionId;
    console.log('session_switched to:', sessionSwitchedTo);
    console.log('history_start sessionId:', historyStartSession);
    console.log('history_end sessionId:', historyEndSession);
    console.log('delta messages in history:', msgCount);
    console.log('Target session matches?', historyStartSession === TARGET && historyEndSession === TARGET && sessionSwitchedTo === TARGET);
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 10000);
