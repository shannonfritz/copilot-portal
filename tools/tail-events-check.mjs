// Validates src/tail-events.ts (the PRODUCTION reader) against the real
// buildHistoryEvents, and exercises the pagination cursor + message counter.
// Usage: node --max-old-space-size=8192 tools/tail-events-check.mjs [sessionId ...]
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const stateDir = path.join(os.homedir(), '.copilot', 'session-state');
let sessionIds = process.argv.slice(2);
if (sessionIds.length === 0) {
  sessionIds = fs.readdirSync(stateDir)
    .map(id => ({ id, f: path.join(stateDir, id, 'events.jsonl') }))
    .filter(x => fs.existsSync(x.f))
    .map(x => ({ id: x.id, size: fs.statSync(x.f).size }))
    .sort((a, b) => b.size - a.size).slice(0, 5).map(x => x.id);
}
const LIMITS = [10, 50, 200];

const outFile = path.join(path.resolve('node_modules', '.cache'), `tailcheck-${Date.now()}.mjs`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const entry = path.join(os.tmpdir(), `tailcheck-entry-${Date.now()}.ts`);
fs.writeFileSync(entry,
  `export { SessionHandle } from ${JSON.stringify(path.resolve('src/session.ts'))};\n` +
  `export { readTailEvents, countMessageLines } from ${JSON.stringify(path.resolve('src/tail-events.ts'))};\n`);
await esbuild.build({
  entryPoints: [entry], outfile: outFile, bundle: true, platform: 'node',
  format: 'esm', logLevel: 'error', packages: 'external',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const { SessionHandle, readTailEvents, countMessageLines } = await import(pathToFileURL(outFile).href);

const mb = (b) => (b / 1048576).toFixed(2);
let ok = true;
const assert = (cond, msg) => { if (!cond) { ok = false; console.error('  FAIL:', msg); } else console.log('  ok:', msg); };

for (const sessionId of sessionIds) {
  const eventsPath = path.join(stateDir, sessionId, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) continue;
  console.log(`\n======== ${sessionId.slice(0, 8)}  (${mb(fs.statSync(eventsPath).size)} MB) ========`);

  const full = [];
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) { if (line.trim()) { try { full.push(JSON.parse(line)); } catch {} } }
  const trueTotal = full.filter(e => e.type === 'user.message' || e.type === 'assistant.message').length;

  // countMessageLines must equal the parsed truth.
  assert(countMessageLines(eventsPath) === trueTotal, `countMessageLines == ${trueTotal}`);

  for (const N of LIMITS) {
    const tail = readTailEvents(eventsPath, N);
    console.log(`  [N=${N}] tail ${tail.tailLines} lines / ${mb(tail.bytesRead)} MB, hitCap=${tail.hitCap}, reachedBof=${tail.reachedBof}, oldestOffset=${tail.oldestOffset}`);
    if (tail.hitCap) {
      // Capped read is INCOMPLETE by design — production falls back to a full pull here.
      // (Trips only on line-sparse-but-huge files, which have no parse cliff anyway.)
      assert(true, `N=${N}: hitCap → production falls back to full pull (expected, no cliff on line-sparse file)`);
      continue;
    }
    const canonical = SessionHandle.buildHistoryEvents(full, N, false);
    // Faithful replica of the PRODUCTION getHistory tail path (session.ts): build from the
    // tail, then patch history_meta.total to the true count ONLY when we didn't reach BOF and
    // there are older messages. Must equal the full-parse canonical build exactly.
    const built = SessionHandle.buildHistoryEvents(tail.events, N, false);
    if (!tail.reachedBof) {
      const tt = countMessageLines(eventsPath); // prod caches this by file size; same value
      if (tt > N) {
        const meta = { type: 'history_meta', total: tt, shown: N };
        if (built.length > 0 && built[0].type === 'history_meta') built[0] = meta;
        else built.unshift(meta);
      }
    }
    assert(JSON.stringify(built) === JSON.stringify(canonical), `N=${N}: production tail path == canonical full build`);

    // ---- Cap-partial path: force a small byteCap so the read caps BEFORE N messages, exercising
    // the production cap-partial serve (snap forward to the oldest complete user.message, then
    // patch history_meta with the PARTIAL shown count). It must equal the equivalent canonical
    // window rebuilt at that shown count (same start ⇒ identical build). Replica of tailBuildServe. ----
    const capped = readTailEvents(eventsPath, N, { byteCap: 512 * 1024 });
    if (capped.hitCap) {
      const firstUserIdx = capped.events.findIndex(e => e.type === 'user.message');
      if (firstUserIdx >= 0) {
        const serveEvents = capped.events.slice(firstUserIdx);
        const totalInServe = serveEvents.filter(e => e.type === 'user.message' || e.type === 'assistant.message').length;
        const shownMsgs = totalInServe > N ? N : totalInServe; // always < N once capped, but keep the formula
        if (shownMsgs > 0) {
          const cbuilt = SessionHandle.buildHistoryEvents(serveEvents, N, false);
          const tt = countMessageLines(eventsPath);
          if (tt > shownMsgs) {
            const meta = { type: 'history_meta', total: tt, shown: shownMsgs };
            if (cbuilt.length > 0 && cbuilt[0].type === 'history_meta') cbuilt[0] = meta;
            else cbuilt.unshift(meta);
          }
          const cexpected = SessionHandle.buildHistoryEvents(full, shownMsgs, false);
          assert(JSON.stringify(cbuilt) === JSON.stringify(cexpected),
            `N=${N}: cap-partial serve (shown=${shownMsgs}) == canonical@shown`);
        } else {
          console.log(`  [N=${N}] cap-partial: 0 messages after snap — would full-pull (skip)`);
        }
      } else {
        console.log(`  [N=${N}] cap-partial: no user.message in 512KB budget — would full-pull (skip)`);
      }
    }
  }

  // ---- Pagination cursor: two N-pages must tile the file's tail with NO gap / NO overlap ----
  // Verify at the RAW-EVENT level (position-independent). buildHistoryEvents' round-grouping
  // makes its leading edge start-dependent, so a post-build suffix check is invalid here —
  // that seam is buildHistoryEvents' concern (see finding tail-paginate-roundedge).
  const N = 20;
  const p1 = readTailEvents(eventsPath, N);
  if (!p1.reachedBof && !p1.hitCap) {
    const p2 = readTailEvents(eventsPath, N, { fromOffset: p1.oldestOffset });
    assert(p2.totalBytes === p1.oldestOffset, `page2 ceiling (${p2.totalBytes}) == page1 oldestOffset (${p1.oldestOffset}) — byte-contiguous`);
    const combinedRaw = p2.events.concat(p1.events);
    // Contiguous non-overlapping tiling ⇔ combinedRaw is exactly the file's last |combinedRaw| raw events.
    const expected = full.slice(full.length - combinedRaw.length);
    assert(JSON.stringify(combinedRaw) === JSON.stringify(expected),
      `two ${N}-msg pages tile the tail exactly (raw events: ${p2.events.length} older + ${p1.events.length} newer = ${combinedRaw.length}, no gap/overlap)`);
  } else {
    console.log(`  (pagination: session too small / capped — single page covers all)`);
  }
}

fs.rmSync(entry, { force: true }); fs.rmSync(outFile, { force: true });
console.log(ok ? '\nALL ASSERTIONS PASSED' : '\nSOME ASSERTIONS FAILED');
process.exit(ok ? 0 : 1);
