// Offline equivalence check: OLD (readFileSync+split+parse-all) vs NEW
// (streaming readline + substring pre-filter) repairOrphanedTools logic.
// Proves the streaming rewrite yields identical detection + identical output.
//   node tools/repair-check.mjs
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { Readable } from 'node:stream';

const FIXED_TS = 'FIXED_TS';
const FIXED_UUID = 'FIXED_UUID';

// ---- shared post-detection logic (identical in prod) ----
function computeFixes(starts, completions) {
	const orphanedStarts = [...starts.entries()].filter(([id]) => !completions.has(id));
	const removeLines = new Set();
	for (const [tcid, indices] of completions) {
		if (!starts.has(tcid)) indices.forEach((i) => removeLines.add(i));
		if (indices.length > 1) indices.slice(1).forEach((i) => removeLines.add(i));
	}
	const insertions = new Map();
	for (const [toolCallId, { lineIndex, parentId, timestamp }] of orphanedStarts) {
		insertions.set(lineIndex, JSON.stringify({
			type: 'tool.execution_complete',
			data: { toolCallId, success: false, result: { content: 'Error: Server was interrupted during execution' } },
			id: FIXED_UUID, timestamp, parentId,
		}));
	}
	return { orphanedStarts, removeLines, insertions };
}

// ---- OLD impl ----
function oldParse(content) {
	const lines = content.split('\n').filter((l) => l.trim());
	const starts = new Map(), completions = new Map();
	for (let i = 0; i < lines.length; i++) {
		try {
			const e = JSON.parse(lines[i]);
			const t = e.data?.toolCallId; if (!t) continue;
			if (e.type === 'tool.execution_start') starts.set(t, { lineIndex: i, parentId: e.id ?? '', timestamp: e.timestamp ?? FIXED_TS });
			else if (e.type === 'tool.execution_complete') { if (!completions.has(t)) completions.set(t, []); completions.get(t).push(i); }
		} catch { /* skip */ }
	}
	return { lines, starts, completions };
}
function oldRewrite(lines, removeLines, insertions) {
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		if (removeLines.has(i)) continue;
		out.push(lines[i]);
		if (insertions.has(i)) out.push(insertions.get(i));
	}
	return out.join('\n') + '\n';
}

// ---- NEW impl (streaming, mirrors session.ts — reads from a real file) ----
async function newParseFile(p) {
	const rl = readline.createInterface({ input: fs.createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
	const starts = new Map(), completions = new Map();
	let i = -1;
	for await (const raw of rl) {
		if (!raw.trim()) continue;
		i++;
		if (!raw.includes('tool.execution_')) continue;
		try {
			const e = JSON.parse(raw);
			const t = e.data?.toolCallId; if (!t) continue;
			if (e.type === 'tool.execution_start') starts.set(t, { lineIndex: i, parentId: e.id ?? '', timestamp: e.timestamp ?? FIXED_TS });
			else if (e.type === 'tool.execution_complete') { if (!completions.has(t)) completions.set(t, []); completions.get(t).push(i); }
		} catch { /* skip */ }
	}
	return { starts, completions };
}
async function newRewriteFile(p, removeLines, insertions) {
	const rl = readline.createInterface({ input: fs.createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
	let out = '', j = -1;
	for await (const raw of rl) {
		if (!raw.trim()) continue;
		j++;
		if (removeLines.has(j)) continue;
		out += raw + '\n';
		const ins = insertions.get(j);
		if (ins !== undefined) out += ins + '\n';
	}
	return out;
}
const TMP = path.join(os.tmpdir(), `repair-check-${process.pid}.jsonl`);
async function newParseStr(content) { fs.writeFileSync(TMP, content); return newParseFile(TMP); }
async function newRewriteStr(content, removeLines, insertions) { fs.writeFileSync(TMP, content); return newRewriteFile(TMP, removeLines, insertions); }

function mapEq(a, b, valEq) {
	if (a.size !== b.size) return false;
	for (const [k, v] of a) { if (!b.has(k)) return false; if (!valEq(v, b.get(k))) return false; }
	return true;
}
const startEq = (x, y) => x.lineIndex === y.lineIndex && x.parentId === y.parentId && x.timestamp === y.timestamp;
const arrEq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', name); } }

// ---- 1. Real local sessions: pass-1 equivalence ----
const stateDir = path.join(os.homedir(), '.copilot', 'session-state');
const ids = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((d) => fs.existsSync(path.join(stateDir, d, 'events.jsonl'))) : [];
console.log(`Real sessions found: ${ids.length}`);
for (const id of ids) {
	const p = path.join(stateDir, id, 'events.jsonl');
	const sz = fs.statSync(p).size;
	// only read files up to ~50MB into memory for the OLD side of the comparison
	if (sz > 50 * 1024 * 1024) { console.log(`  (skip ${id.slice(0,8)} — ${(sz/1048576).toFixed(0)}MB too big for in-mem OLD baseline)`); continue; }
	const content = fs.readFileSync(p, 'utf8');
	const o = oldParse(content);
	const n = await newParseFile(p);
	const ok = mapEq(o.starts, n.starts, startEq) && mapEq(o.completions, n.completions, arrEq);
	check(`parse-eq ${id.slice(0,8)} (starts=${o.starts.size} completes=${o.completions.size})`, ok);
	// also confirm no-change case is truly no-change (common path)
	const fx = computeFixes(o.starts, o.completions);
	if (fx.orphanedStarts.length === 0 && fx.removeLines.size === 0) {
		// nothing to do — both impls return without writing; nothing to compare
	} else {
		const outOld = oldRewrite(o.lines, fx.removeLines, fx.insertions);
		const outNew = await newRewriteFile(p, fx.removeLines, fx.insertions);
		check(`rewrite-eq ${id.slice(0,8)}`, outOld === outNew);
	}
}

// ---- 2. Synthetic cases: pass-2 byte-identical ----
function ev(type, tcid, extra = {}) { return JSON.stringify({ type, data: { toolCallId: tcid }, ...extra }); }
const msg = (s) => JSON.stringify({ type: 'user.message', data: { text: s } });
const cases = {
	'matched-pair': [msg('hi'), ev('tool.execution_start', 'A', { id: 'pA', timestamp: 'tA' }), ev('tool.execution_complete', 'A'), msg('bye')].join('\n') + '\n',
	'orphaned-start': [msg('hi'), ev('tool.execution_start', 'B', { id: 'pB', timestamp: 'tB' }), msg('interrupted?')].join('\n') + '\n',
	'orphaned-complete': [msg('hi'), ev('tool.execution_complete', 'C'), msg('x')].join('\n') + '\n',
	'duplicate-complete': [ev('tool.execution_start', 'D', { id: 'pD', timestamp: 'tD' }), ev('tool.execution_complete', 'D'), ev('tool.execution_complete', 'D')].join('\n') + '\n',
	'blank-lines': ['', msg('a'), '', ev('tool.execution_start', 'E', { id: 'pE', timestamp: 'tE' }), '', msg('b'), ''].join('\n') + '\n',
	'no-trailing-newline': [msg('a'), ev('tool.execution_start', 'F', { id: 'pF', timestamp: 'tF' })].join('\n'),
	'mixed': [msg('1'), ev('tool.execution_start', 'G', { id: 'pG', timestamp: 'tG' }), ev('tool.execution_complete', 'G'),
		ev('tool.execution_start', 'H', { id: 'pH', timestamp: 'tH' }), // orphan
		ev('tool.execution_complete', 'Z'), // orphan complete
		ev('tool.execution_start', 'I', { id: 'pI', timestamp: 'tI' }), ev('tool.execution_complete', 'I'), ev('tool.execution_complete', 'I'), // dup
		msg('2')].join('\n') + '\n',
};
for (const [name, content] of Object.entries(cases)) {
	const o = oldParse(content);
	const n = await newParseStr(content);
	check(`syn parse-eq ${name}`, mapEq(o.starts, n.starts, startEq) && mapEq(o.completions, n.completions, arrEq));
	const fxO = computeFixes(o.starts, o.completions);
	const fxN = computeFixes(n.starts, n.completions);
	check(`syn fixes-eq ${name}`, fxO.removeLines.size === fxN.removeLines.size && fxO.orphanedStarts.length === fxN.orphanedStarts.length);
	const outOld = oldRewrite(o.lines, fxO.removeLines, fxO.insertions);
	const outNew = await newRewriteStr(content, fxN.removeLines, fxN.insertions);
	check(`syn rewrite-eq ${name}`, outOld === outNew);
	// sanity: orphaned-start case must actually inject a completion
	if (name === 'orphaned-start') check('syn orphaned-start injects completion', outNew.includes('Server was interrupted'));
}

console.log(`\n${fail === 0 ? '✓ ALL PASSED' : '✗ FAILURES'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
