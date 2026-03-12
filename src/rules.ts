import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { PermissionRequest } from '@github/copilot-sdk';

export interface ApprovalRule {
	id: string;
	sessionId: string;
	kind: string;
	pattern: string;
	createdAt: number;
}

export class RulesStore {
	private rulesDir: string;
	private cache = new Map<string, ApprovalRule[]>();

	constructor(dataDir: string) {
		this.rulesDir = path.join(dataDir, 'rules');
	}

	/** Computes a human-readable pattern that describes what the rule will match. */
	static computePattern(req: PermissionRequest): string {
		const r = req as PermissionRequest & {
			fullCommandText?: string;
			path?: string;
			url?: string;
			toolName?: string;
			serverName?: string;
		};
		switch (req.kind) {
			case 'shell': {
				const cmd = r.fullCommandText?.trim() ?? '';
				const baseCmd = cmd.split(/\s+/)[0] ?? cmd;
				return baseCmd ? `${baseCmd} *` : cmd;
			}
			case 'read':
			case 'write':
				return r.path ?? req.kind;
			case 'mcp': {
				const server = r.serverName ?? '*';
				const tool = r.toolName ?? '*';
				return `${server}/${tool}`;
			}
			case 'url': {
				try { return new URL(r.url ?? '').hostname; } catch { return r.url ?? req.kind; }
			}
			default:
				return r.toolName ?? req.kind;
		}
	}

	getRules(sessionId: string): ApprovalRule[] {
		if (!this.cache.has(sessionId)) {
			this.cache.set(sessionId, this.load(sessionId));
		}
		return this.cache.get(sessionId)!;
	}

	addRule(sessionId: string, kind: string, pattern: string): ApprovalRule {
		const rules = this.getRules(sessionId);
		const existing = rules.find(r => r.kind === kind && r.pattern === pattern);
		if (existing) return existing;
		const rule: ApprovalRule = { id: crypto.randomBytes(8).toString('hex'), sessionId, kind, pattern, createdAt: Date.now() };
		rules.push(rule);
		this.save(sessionId, rules);
		return rule;
	}

	removeRule(sessionId: string, ruleId: string): void {
		const rules = this.getRules(sessionId).filter(r => r.id !== ruleId);
		this.cache.set(sessionId, rules);
		this.save(sessionId, rules);
	}

	clearRules(sessionId: string): void {
		this.cache.set(sessionId, []);
		this.save(sessionId, []);
	}

	/** Returns the first matching rule for this request, or null if none. */
	matchesRequest(sessionId: string, req: PermissionRequest): ApprovalRule | null {
		const r = req as PermissionRequest & {
			fullCommandText?: string;
			path?: string;
			url?: string;
			toolName?: string;
			serverName?: string;
		};
		for (const rule of this.getRules(sessionId)) {
			if (rule.kind !== req.kind) continue;
			switch (req.kind) {
				case 'shell': {
					const base = rule.pattern.replace(/\s+\*$/, '');
					const cmd = r.fullCommandText?.trim() ?? '';
					if (cmd === base || cmd.startsWith(base + ' ')) return rule;
					break;
				}
				case 'read':
				case 'write':
					if (rule.pattern === r.path) return rule;
					break;
				case 'mcp': {
					const [ruleServer, ruleTool] = rule.pattern.split('/');
					if ((ruleServer === '*' || ruleServer === r.serverName) &&
						(ruleTool === '*' || ruleTool === r.toolName)) return rule;
					break;
				}
				case 'url': {
					try {
						if (rule.pattern === new URL(r.url ?? '').hostname) return rule;
					} catch {}
					break;
				}
				default:
					if (rule.pattern === (r.toolName ?? req.kind)) return rule;
			}
		}
		return null;
	}

	private load(sessionId: string): ApprovalRule[] {
		try {
			const f = path.join(this.rulesDir, `${sessionId}.json`);
			if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
		} catch {}
		return [];
	}

	private save(sessionId: string, rules: ApprovalRule[]): void {
		try {
			fs.mkdirSync(this.rulesDir, { recursive: true });
			fs.writeFileSync(path.join(this.rulesDir, `${sessionId}.json`), JSON.stringify(rules, null, 2));
		} catch {}
	}
}
