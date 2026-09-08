/**
 * Heap sizing for the spawned Copilot CLI (`copilot --server`).
 *
 * The CLI is a Node process. Resuming a very large session loads the whole
 * event history into memory and, on big sessions, drove it into Node's ~4GB
 * default V8 old-space ceiling and crashed with "FATAL ERROR: Reached heap
 * limit — JavaScript heap out of memory" (observed 2026-07-11 on a
 * ~13k-message session). That kills the shared CLI and takes every connected
 * client down with it (the mobile "black screen" incident).
 *
 * Raising `--max-old-space-size` via NODE_OPTIONS gives the CLI headroom so a
 * large-but-reasonable session resumes instead of OOM-crashing. NODE_OPTIONS is
 * inherited by child Node processes, so it applies whether `copilot` is the
 * Node process itself or a thin launcher that spawns one.
 *
 * This is applied at EVERY point where the portal spawns `copilot --server`
 * (launcher, restart handler, TUI-exit relauncher) on every platform.
 */

import * as fs from 'node:fs';

/** V8 old-space ceiling (MB) for the spawned CLI server when memory is unconstrained. */
export const CLI_HEAP_MB = 8192;

/** Smallest heap we'll ever hand the CLI, even on a tiny container. */
const CLI_HEAP_MIN_MB = 1024;

/**
 * Container memory limit in MB, or null when unconstrained/undetectable.
 *
 * In a container, a heap ceiling larger than the cgroup limit is actively
 * harmful: V8 happily grows past the limit instead of collecting, and the
 * kernel SIGKILLs the process. That looks nothing like an OOM — the CLI just
 * vanishes, port 3848 goes dead, and the portal loops "CLI server not
 * available" forever. Sizing the heap under the cgroup limit makes V8 collect
 * instead of getting killed.
 */
export function containerMemoryLimitMb(): number | null {
	const sources = [
		'/sys/fs/cgroup/memory.max',                     // cgroup v2
		'/sys/fs/cgroup/memory/memory.limit_in_bytes',   // cgroup v1
	];
	for (const file of sources) {
		try {
			const raw = fs.readFileSync(file, 'utf8').trim();
			if (!raw || raw === 'max') continue;
			const bytes = Number(raw);
			if (!Number.isFinite(bytes) || bytes <= 0) continue;
			// cgroup v1 reports a near-int64 sentinel when unlimited.
			if (bytes > 512 * 1024 * 1024 * 1024) continue;
			return Math.floor(bytes / (1024 * 1024));
		} catch { /* not present on this platform */ }
	}
	return null;
}

/**
 * The heap ceiling (MB) to actually use: CLI_HEAP_MB normally, or ~75% of the
 * container memory limit when that is smaller (leaving room for the portal
 * server, the CLI's non-heap memory, and the OS).
 */
export function cliHeapMb(): number {
	const limit = containerMemoryLimitMb();
	if (limit === null) return CLI_HEAP_MB;
	const budget = Math.floor(limit * 0.75);
	return Math.max(CLI_HEAP_MIN_MB, Math.min(CLI_HEAP_MB, budget));
}

/** The Node flag that sets the CLI's heap limit. */
export function cliHeapFlag(): string {
	return `--max-old-space-size=${cliHeapMb()}`;
}

/**
 * Compute the NODE_OPTIONS string for the spawned CLI: the caller's existing
 * NODE_OPTIONS with our heap flag appended. Idempotent — if a
 * `--max-old-space-size` is already present (user-set or a prior call) we leave
 * it untouched rather than stacking a second, conflicting flag.
 */
export function cliNodeOptions(base: NodeJS.ProcessEnv = process.env): string {
	const existing = (base.NODE_OPTIONS ?? '').trim();
	if (existing.includes('--max-old-space-size')) return existing;
	const flag = cliHeapFlag();
	return existing ? `${existing} ${flag}` : flag;
}

/**
 * process.env clone with NODE_OPTIONS augmented for the CLI heap. Pass as the
 * `env` option to spawn/exec so the child `copilot` inherits the larger heap.
 */
export function cliSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base, NODE_OPTIONS: cliNodeOptions(base) };
}
