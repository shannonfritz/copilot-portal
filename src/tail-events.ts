/**
 * Byte-accurate backward reader for a session's append-only `events.jsonl`.
 *
 * WHY: `getHistory` renders only the last N messages, but the SDK's `getEvents()`
 * parses the ENTIRE file first (session.ts) — driving the CLI's V8 heap over its
 * ceiling on very large sessions (GC death-spiral / OOM). Reading just the tail we
 * actually display costs ~0.3% of a 346 MB file (proven byte-identical to a full
 * parse by tools/tail-read-harness.mjs), sidestepping the cliff entirely.
 *
 * HOW: read fixed-size chunks backward from `fromOffset` (default EOF), peeling
 * COMPLETE lines from the right. The still-incomplete left fragment is carried as
 * raw BYTES — never round-tripped through a string — so a multi-byte UTF-8
 * character split across a chunk boundary can't be corrupted. We stop as soon as
 * we've seen `wantMessages` user/assistant message lines, or a safety cap trips.
 *
 * Contiguity: the kept lines form one contiguous byte range [oldestOffset, fromOffset),
 * so `oldestOffset` is an exact cursor for fetching the next older page (pagination).
 */
import * as fs from 'node:fs';

const NEWLINE = 0x0a;

/** Top-level key order is type-first in persisted events (verified), so a cheap prefix
 *  test classifies a message line without JSON-parsing a possibly-huge line just to count. */
const MESSAGE_LINE_RE = /^\s*\{"type":"(?:user|assistant)\.message"/;

export interface TailReadOptions {
	/** Bytes per backward read. Default 256 KiB. */
	chunkBytes?: number;
	/** Abort (hitCap=true) once this many bytes have been read. Default 32 MiB.
	 *  A tail larger than this is pathological — the caller should fall back to a full pull. */
	byteCap?: number;
	/** Abort (hitCap=true) once this many lines have been collected. Default 200k. */
	lineCap?: number;
	/** Read strictly BEFORE this byte offset (for pagination). Default = end of file. */
	fromOffset?: number;
	/** Override the message-line classifier (must mirror buildHistoryEvents' notion of a message). */
	isMessageLine?: (line: string) => boolean;
}

export interface TailReadResult {
	/** Parsed events in chronological order, ready for SessionHandle.buildHistoryEvents. */
	events: Array<{ type: string; data?: unknown }>;
	/** Bytes physically read from disk. */
	bytesRead: number;
	/** Snapshot size of the file (or `fromOffset` if smaller) at read time. */
	totalBytes: number;
	/** Number of raw lines kept. */
	tailLines: number;
	/** Number of user/assistant message lines kept. */
	tailMsgs: number;
	/** True if a cap tripped before `wantMessages` was reached — caller should fall back to a full pull. */
	hitCap: boolean;
	/** True if the read reached the beginning of the range (no older history exists before it). */
	reachedBof: boolean;
	/** Exact byte offset where the OLDEST kept line begins — the cursor for the next older page. */
	oldestOffset: number;
}

/**
 * Read the tail of `filePath` backward until `wantMessages` message lines are collected
 * (or a cap trips). Synchronous but bounded by `byteCap`; the tail we read is tiny in
 * practice (~1 MB for the last 50 messages of a 346 MB session), so it does not
 * meaningfully block the event loop.
 *
 * On `hitCap === true` the result is INCOMPLETE by design — the caller must treat it as a
 * miss and fall back to the authoritative full pull (worst case = today's behavior).
 */
export function readTailEvents(filePath: string, wantMessages: number, opts: TailReadOptions = {}): TailReadResult {
	const chunkBytes = opts.chunkBytes ?? (1 << 18);         // 256 KiB
	const byteCap = opts.byteCap ?? (32 << 20);              // 32 MiB
	const lineCap = opts.lineCap ?? 500_000;
	const isMsg = opts.isMessageLine ?? ((line: string) => MESSAGE_LINE_RE.test(line));

	const fd = fs.openSync(filePath, 'r');
	try {
		const fileSize = fs.fstatSync(fd).size;
		// Snapshot the read ceiling: never read past `fromOffset` (pagination) or a size that
		// grew due to a concurrent live append after we opened.
		const ceiling = Math.min(opts.fromOffset ?? fileSize, fileSize);
		let pos = ceiling;

		let pending = Buffer.alloc(0);          // incomplete LEFT line fragment (raw bytes)
		const linesNewestFirst: string[] = [];
		let msgCount = 0;
		let bytesRead = 0;
		let hitCap = false;
		let oldestOffset = ceiling;             // start offset of the oldest kept line (updated on each push)

		// Push every COMPLETE line found in `region` (bytes to the right of a newline at
		// absolute offset `regionStart`), newest-first. Returns nothing; updates counters.
		const pushRegion = (region: Buffer, regionStart: number): void => {
			const strs = region.toString('utf8').split('\n');
			for (let i = strs.length - 1; i >= 0; i--) {
				const line = strs[i];
				if (!line.trim()) continue;
				linesNewestFirst.push(line);
				if (isMsg(line)) msgCount++;
			}
			// The leftmost non-empty line in this region is the new oldest kept line.
			oldestOffset = regionStart;
		};

		while (pos > 0) {
			const len = Math.min(chunkBytes, pos);
			pos -= len;
			const chunk = Buffer.alloc(len);
			fs.readSync(fd, chunk, 0, len, pos);
			bytesRead += len;
			pending = pending.length ? Buffer.concat([chunk, pending]) : chunk;

			const firstNl = pending.indexOf(NEWLINE);
			if (firstNl >= 0) {
				// Everything after the first newline is one-or-more complete lines. Its absolute
				// start offset is (left edge of pending) + firstNl + 1. The left edge of pending
				// is `pos` (we just prepended the chunk read at `pos`).
				pushRegion(pending.subarray(firstNl + 1), pos + firstNl + 1);
				pending = Buffer.from(pending.subarray(0, firstNl)); // detached incomplete left fragment
			}

			if (msgCount >= wantMessages) {
				// `pending` is a partial OLDER line (its left bytes are unread) — correctly discarded.
				return finish(false);
			}
			if (bytesRead >= byteCap || linesNewestFirst.length >= lineCap) {
				hitCap = true;
				return finish(false);
			}
		}
		// Reached the beginning of the range: the surviving `pending` is a complete line
		// (its left edge is offset 0 / the range start), so keep it.
		if (pending.length) {
			const line = pending.toString('utf8');
			if (line.trim()) {
				linesNewestFirst.push(line);
				if (isMsg(line)) msgCount++;
				oldestOffset = 0;
			}
		}
		return finish(true);

		function finish(reachedBof: boolean): TailReadResult {
			const events: Array<{ type: string; data?: unknown }> = [];
			for (let i = linesNewestFirst.length - 1; i >= 0; i--) {   // reverse -> chronological
				try { events.push(JSON.parse(linesNewestFirst[i])); } catch { /* skip a partial/corrupt line */ }
			}
			return {
				events,
				bytesRead,
				totalBytes: ceiling,
				tailLines: linesNewestFirst.length,
				tailMsgs: msgCount,
				hitCap,
				reachedBof,
				oldestOffset,
			};
		}
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Cheap streaming count of message lines (no JSON.parse of line bodies) — used to supply
 * the true `history_meta.total` a tail read can't know locally. Streams the file so it
 * never holds the whole thing in memory; still O(bytes) but allocation-light (no event
 * objects), so it does not hit the parse cliff.
 */
export function countMessageLines(filePath: string, isMessageLine: (line: string) => boolean = (l) => MESSAGE_LINE_RE.test(l)): number {
	const fd = fs.openSync(filePath, 'r');
	try {
		const chunkBytes = 1 << 20; // 1 MiB
		const buf = Buffer.alloc(chunkBytes);
		let leftover = Buffer.alloc(0);
		let pos = 0;
		const size = fs.fstatSync(fd).size;
		let count = 0;
		while (pos < size) {
			const len = fs.readSync(fd, buf, 0, Math.min(chunkBytes, size - pos), pos);
			if (len <= 0) break;
			pos += len;
			let data = leftover.length ? Buffer.concat([leftover, buf.subarray(0, len)]) : Buffer.from(buf.subarray(0, len));
			let nl: number;
			let start = 0;
			while ((nl = data.indexOf(NEWLINE, start)) >= 0) {
				const line = data.toString('utf8', start, nl);
				if (line && isMessageLine(line)) count++;
				start = nl + 1;
			}
			leftover = Buffer.from(data.subarray(start));
		}
		if (leftover.length) {
			const line = leftover.toString('utf8');
			if (line && isMessageLine(line)) count++;
		}
		return count;
	} finally {
		fs.closeSync(fd);
	}
}
