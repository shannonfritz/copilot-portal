// Offline harness for TAIL-LOADING (feature: load only the tail of a large
// events.jsonl instead of parsing the whole file). NO live SDK connection.
//
// It proves the one load-bearing claim behind the feature:
//   buildHistoryEvents( tailRead(file, N), N )  ==  buildHistoryEvents( full, N )
//   byte-for-byte, once history_meta.total (the only value a tail can't know
//   locally) is supplied — which production will get from a cheap line-count.
//
// For each session and each N it reports:
//   • rest-identical  : outputs equal after IGNORING history_meta.total  (the pure win)
//   • full-identical  : outputs equal after INJECTING the true total      (end-state)
//   • bytes read by the tail vs the whole file  (the cliff-avoidance payoff)
//
// The backward reader here is the reference implementation for src/tail-events.ts.
// Usage: node --max-old-space-size=8192 tools/tail-read-harness.mjs [sessionId ...]
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const stateDir = path.join(os.homedir(), '.copilot', 'session-state');
let sessionIds = process.argv.slice(2);
if (sessionIds.length === 0) {
  // Default: the biggest few local sessions (most interesting for tail-loading).
  sessionIds = fs.readdirSync(stateDir)
    .map(id => ({ id, f: path.join(stateDir, id, 'events.jsonl') }))
    .filter(x => fs.existsSync(x.f))
    .map(x => ({ id: x.id, size: fs.statSync(x.f).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 5)
    .map(x => x.id);
}
const LIMITS = [10, 50, 200];

// ---- Bundle session.ts so we can call the REAL buildHistoryEvents -----------------------
const outFile = path.join(path.resolve('node_modules', '.cache'), `tailread-${Date.now()}.mjs`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const entry = path.join(os.tmpdir(), `tailread-entry-${Date.now()}.ts`);
fs.writeFileSync(entry, `export { SessionHandle } from ${JSON.stringify(path.resolve('src/session.ts'))};\n`);
await esbuild.build({
  entryPoints: [entry], outfile: outFile, bundle: true, platform: 'node',
  format: 'esm', logLevel: 'error', packages: 'external',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const { SessionHandle } = await import(pathToFileURL(outFile).href);

const NL = 0x0a;
const MSG_RE = /^\s*\{"type":"(?:user|assistant)\.message"/; // top-level key order is type-first (verified)
const isMsgLine = (line) => MSG_RE.test(line);
const mb = (b) => (b / 1048576).toFixed(2);

/**
 * Byte-accurate backward reader: read events.jsonl from EOF in chunks until we have
 * `wantMessages` user/assistant message lines (or hit a cap), returning the tail in
 * chronological order plus stats. Bytes are peeled without round-tripping the incomplete
 * left fragment through a string (that would corrupt a multi-byte char split across a
 * chunk boundary). This is the reference for the production tail-events.ts reader.
 */
function tailReadEvents(filePath, wantMessages, { chunkBytes = 1 << 18, byteCap = 96 << 20, lineCap = 500000 } = {}) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;        // snapshot; ignore anything appended past here
    let pos = size;
    let pending = Buffer.alloc(0);             // incomplete LEFT line fragment (raw bytes)
    const linesNewestFirst = [];
    let msgCount = 0, bytesRead = 0, hitCap = false;

    const pushComplete = (completeBytes) => {
      // completeBytes: one-or-more whole lines (no leading partial). Split on NL; the
      // rightmost element is a full line (a just-completed fragment or EOF line).
      const strs = completeBytes.toString('utf8').split('\n');
      for (let i = strs.length - 1; i >= 0; i--) {
        const line = strs[i];
        if (!line.trim()) continue;
        linesNewestFirst.push(line);
        if (isMsgLine(line)) msgCount++;
      }
    };

    while (pos > 0) {
      const len = Math.min(chunkBytes, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, pos);
      bytesRead += len;
      pending = pending.length ? Buffer.concat([chunk, pending]) : chunk;

      const firstNl = pending.indexOf(NL);
      if (firstNl >= 0) {
        pushComplete(pending.subarray(firstNl + 1));
        pending = Buffer.from(pending.subarray(0, firstNl)); // detached copy of the incomplete left fragment
      }
      if (msgCount >= wantMessages) break;      // pos>0 here => `pending` is a partial older line: discard it
      if (bytesRead >= byteCap) { hitCap = true; break; }
      if (linesNewestFirst.length >= lineCap) { hitCap = true; break; }
    }
    // Reached beginning of file: the surviving `pending` is the first (complete) line.
    if (pos === 0 && pending.length) {
      const line = pending.toString('utf8');
      if (line.trim()) { linesNewestFirst.push(line); if (isMsgLine(line)) msgCount++; }
    }

    const events = [];
    for (let i = linesNewestFirst.length - 1; i >= 0; i--) {    // reverse -> chronological
      try { events.push(JSON.parse(linesNewestFirst[i])); } catch { /* skip partial */ }
    }
    return { events, bytesRead, totalBytes: size, hitCap, tailLines: linesNewestFirst.length, tailMsgs: msgCount };
  } finally {
    fs.closeSync(fd);
  }
}

/** Cheap streaming count of message lines (no JSON.parse) — what production would use for total. */
function countMessages(filePath) {
  const buf = fs.readFileSync(filePath, 'utf8'); // harness-only; prod would stream
  let n = 0;
  for (const line of buf.split('\n')) if (line && isMsgLine(line)) n++;
  return n;
}

/** history_meta is the first emitted event (session.ts:598) when total!==shown. Split it off. */
function splitMeta(events) {
  if (events.length && events[0].type === 'history_meta') return { meta: events[0], rest: events.slice(1) };
  return { meta: null, rest: events };
}

let ok = true;
const assert = (cond, msg) => { if (!cond) { ok = false; console.error('  FAIL:', msg); } else console.log('  ok:', msg); };

for (const sessionId of sessionIds) {
  const eventsPath = path.join(stateDir, sessionId, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) { console.error('No events.jsonl at', eventsPath); continue; }
  const sizeMB = mb(fs.statSync(eventsPath).size);
  console.log(`\n================ ${sessionId.slice(0, 8)}  (${sizeMB} MB) ================`);

  // Full parse = canonical input (stand-in for getEvents(); the live shadow proves getEvents()==file).
  const full = [];
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { full.push(JSON.parse(line)); } catch { /* skip partial */ }
  }
  const trueTotal = full.filter(e => e.type === 'user.message' || e.type === 'assistant.message').length;
  console.log(`  full: ${full.length} events, ${trueTotal} messages`);

  for (const N of LIMITS) {
    const canonical = SessionHandle.buildHistoryEvents(full, N, false);
    const tail = tailReadEvents(eventsPath, N);
    const tailBuilt = SessionHandle.buildHistoryEvents(tail.events, N, false);

    // (a) rest-identical: equal after ignoring history_meta entirely (the pure tail-vs-full win).
    const c = splitMeta(canonical), t = splitMeta(tailBuilt);
    const restA = JSON.stringify(c.rest), restB = JSON.stringify(t.rest);
    let firstDiff = -1;
    if (restA !== restB) {
      const n = Math.min(c.rest.length, t.rest.length);
      for (let i = 0; i < n; i++) { if (JSON.stringify(c.rest[i]) !== JSON.stringify(t.rest[i])) { firstDiff = i; break; } }
      if (firstDiff < 0) firstDiff = n;
    }

    // (b) full-identical: inject the true total into the tail build, then compare EVERYTHING.
    const patched = tailBuilt.slice();
    if (c.meta) {
      const fixed = { ...c.meta }; // { type:'history_meta', total:trueTotal, shown:N }
      if (t.meta) patched[0] = fixed; else patched.unshift(fixed);
    }
    const fullIdentical = JSON.stringify(patched) === JSON.stringify(canonical);

    const pct = (100 * tail.bytesRead / tail.totalBytes).toFixed(2);
    console.log(`\n  [N=${N}] canonical=${canonical.length}  tailBuilt=${tailBuilt.length}  ` +
      `tail read ${tail.tailLines} lines / ${mb(tail.bytesRead)} MB (${pct}% of file)${tail.hitCap ? '  ⚠HIT-CAP' : ''}`);
    assert(restA === restB,
      `rest-identical (ignoring history_meta.total)${restA === restB ? '' : ` — first diff @${firstDiff}`}`);
    assert(fullIdentical,
      `full-identical after injecting true total=${trueTotal} (meta canonical=${c.meta ? c.meta.total : 'none'} tail=${t.meta ? t.meta.total : 'none'})`);
    if (tail.hitCap) console.log(`     note: tail hit the byte/line cap — production would fall back to a full pull here.`);
  }
}

fs.rmSync(entry, { force: true }); fs.rmSync(outFile, { force: true });
console.log(ok ? '\nALL ASSERTIONS PASSED' : '\nSOME ASSERTIONS FAILED');
process.exit(ok ? 0 : 1);
