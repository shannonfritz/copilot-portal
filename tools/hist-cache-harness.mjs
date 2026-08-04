// Offline harness for the history-cache (Stage 1). Validates against a real
// events.jsonl, with NO live SDK connection:
//   1. The append filter (QUIET_EVENT_TYPES) never drops a PERSISTED event type
//      (a persisted type in the skip-set would silently desync the mirror).
//   2. Seed + append (with ephemeral events filtered) reconstructs a mirror whose
//      buildHistoryEvents output is byte-identical to a fresh full build — at
//      limit=all AND limit=50.
//   3. Residual cost: how long buildHistoryEvents takes on the full array (this is
//      what a cache-served reconnect still pays, vs the ~3.6s getEvents() RPC today).
// Usage: node tools/hist-cache-harness.mjs [sessionId]
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const sessionId = process.argv[2] || '90aa1943-9b54-4477-828a-3e9c07e456d0';
const eventsPath = path.join(os.homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
if (!fs.existsSync(eventsPath)) { console.error('No events.jsonl at', eventsPath); process.exit(1); }

// Bundle session.ts (exports SessionHandle) to a temp ESM module we can import.
const outFile = path.join(path.resolve('node_modules', '.cache'), `histcache-${Date.now()}.mjs`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const entry = path.join(os.tmpdir(), `histcache-entry-${Date.now()}.ts`);
fs.writeFileSync(entry, `export { SessionHandle } from ${JSON.stringify(path.resolve('src/session.ts'))};\n`);
await esbuild.build({
  entryPoints: [entry], outfile: outFile, bundle: true, platform: 'node',
  format: 'esm', logLevel: 'error', packages: 'external',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const { SessionHandle } = await import(pathToFileURL(outFile).href);

// Read events.jsonl (one JSON object per line).
const events = [];
for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { events.push(JSON.parse(line)); } catch { /* skip partial */ }
}
console.log(`Loaded ${events.length} persisted events from ${sessionId.slice(0, 8)}`);

let ok = true;
const assert = (cond, msg) => { if (!cond) { ok = false; console.error('  FAIL:', msg); } else console.log('  ok:', msg); };

// --- Test 1: append filter must not skip any PERSISTED type ---------------------------
// QUIET_EVENT_TYPES is `private static` in TS but a real runtime static field.
const quiet = SessionHandle.QUIET_EVENT_TYPES;
const persistedTypes = [...new Set(events.map(e => e.type))].sort();
console.log(`\n[Test 1] append filter vs ${persistedTypes.length} distinct persisted types`);
const wronglySkipped = persistedTypes.filter(t => quiet.has(t));
assert(wronglySkipped.length === 0,
  `no persisted type is in the ephemeral skip-set${wronglySkipped.length ? ' — OFFENDERS: ' + wronglySkipped.join(', ') : ''}`);
console.log(`  (skip-set: ${[...quiet].join(', ')})`);

// --- Test 2: seed + append (ephemeral filtered) == fresh full build --------------------
// Simulate a mirror seeded at a past point, then live events appended. Interleave
// SYNTHETIC ephemeral events (which a live stream emits but getEvents() never persists)
// to prove the filter drops them and the mirror still matches.
console.log('\n[Test 2] seed + append reconstruction (with synthetic ephemeral noise)');
const seedK = Math.floor(events.length * 0.6);
const mirror = events.slice(0, seedK);            // "seeded from first getEvents() pull"
let appended = 0, skipped = 0;
for (const e of events.slice(seedK)) {
  // inject an ephemeral delta before each real event (as a live stream would)
  for (const noise of [{ type: 'assistant.message_delta', data: { text: 'x' } },
                       { type: 'tool.execution_partial_result', data: {} }]) {
    if (quiet.has(noise.type)) { skipped++; } else { mirror.push(noise); appended++; }
  }
  if (quiet.has(e.type)) { skipped++; continue; }
  mirror.push(e); appended++;
}
console.log(`  seeded ${seedK}, appended ${appended}, skipped(ephemeral) ${skipped}, mirror len ${mirror.length}`);

for (const limit of [undefined, 50]) {
  const canonical = SessionHandle.buildHistoryEvents(events, limit, false);
  const cached = SessionHandle.buildHistoryEvents(mirror, limit, false);
  const a = JSON.stringify(canonical), b = JSON.stringify(cached);
  let firstDiff = -1;
  if (a !== b) {
    const n = Math.min(canonical.length, cached.length);
    for (let i = 0; i < n; i++) { if (JSON.stringify(canonical[i]) !== JSON.stringify(cached[i])) { firstDiff = i; break; } }
    if (firstDiff < 0) firstDiff = n;
  }
  assert(a === b,
    `limit=${limit ?? 'all'}: cached build == canonical (canonical=${canonical.length} cached=${cached.length}${a === b ? '' : `, first diff @${firstDiff}`})`);
}

// --- Test 3: residual per-reconnect cost with a warm cache -----------------------------
console.log('\n[Test 3] residual buildHistoryEvents cost (what a cache-served reconnect still pays)');
for (const limit of [50, undefined]) {
  const t = process.hrtime.bigint();
  const out = SessionHandle.buildHistoryEvents(events, limit, false);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`  limit=${String(limit ?? 'all').padEnd(3)} -> ${out.length} PortalEvents in ${ms.toFixed(1)} ms  (vs ~3600 ms getEvents() RPC eliminated)`);
}

fs.rmSync(entry, { force: true }); fs.rmSync(outFile, { force: true });
console.log(ok ? '\nALL ASSERTIONS PASSED' : '\nSOME ASSERTIONS FAILED');
process.exit(ok ? 0 : 1);
