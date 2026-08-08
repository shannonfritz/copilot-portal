// Resume-timing harness. Isolates WHY cold-open of a large session is slow.
//
// Spawns its OWN headless copilot CLI (separate process — NOT the portal's shared
// CLI on :3848), resumes the target session under ONE config variant, and times:
//   • resumeMs        — the client.resumeSession() call (the CLI's session.resume RPC)
//   • firstRpcMs      — a trivial model.getCurrent() AFTER resume returns; if the CLI
//                       is still doing heavy async work (MCP connect / embedding build)
//                       on the JSON-RPC channel, this trivial call is starved and slow.
//   • mcp events      — timestamps of mcp_server_status_changed, to see when MCP connects
//                       relative to resume returning.
//
// Run ONE variant per process so each gets a clean 8GB-heap CLI (avoids stacking
// two 376MB resumes in one heap). Safe: mirrors the user's own `copilot --resume`.
//
// Usage:
//   node tools/resume-timing-harness.mjs <variant> [sessionId]
//   variant ∈ full | nomcp | noembed | noconfig
//   sessionId defaults to the largest local session.
import { CopilotClient } from '@github/copilot-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const variant = process.argv[2] ?? 'full';
const VALID = ['full', 'nomcp', 'noembed', 'noconfig', 'embedcache'];
if (!VALID.includes(variant)) {
  console.error(`variant must be one of: ${VALID.join(', ')}`);
  process.exit(2);
}

const stateDir = path.join(os.homedir(), '.copilot', 'session-state');
let sessionId = process.argv[3];
if (!sessionId) {
  sessionId = fs.readdirSync(stateDir)
    .map(id => ({ id, f: path.join(stateDir, id, 'events.jsonl') }))
    .filter(x => fs.existsSync(x.f))
    .map(x => ({ id: x.id, size: fs.statSync(x.f).size }))
    .sort((a, b) => b.size - a.size)[0]?.id;
}
const eventsFile = path.join(stateDir, sessionId, 'events.jsonl');
const sizeMB = fs.existsSync(eventsFile) ? (fs.statSync(eventsFile).size / 1048576).toFixed(1) : '?';

// ── replicate the portal's MCP loader (user config + installed plugins) ──────────
function loadMcpServers() {
  const servers = {};
  const home = os.homedir();
  try {
    const p = path.join(home, '.copilot', 'mcp-config.json');
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (c.mcpServers) Object.assign(servers, c.mcpServers);
    }
  } catch {}
  try {
    const pluginsDir = path.join(home, '.copilot', 'installed-plugins');
    if (fs.existsSync(pluginsDir)) {
      for (const mkt of fs.readdirSync(pluginsDir)) {
        const mDir = path.join(pluginsDir, mkt);
        if (!fs.statSync(mDir).isDirectory()) continue;
        for (const plugin of fs.readdirSync(mDir)) {
          const f = path.join(mDir, plugin, '.mcp.json');
          try {
            if (fs.existsSync(f)) {
              const c = JSON.parse(fs.readFileSync(f, 'utf8'));
              if (c.mcpServers) Object.assign(servers, c.mcpServers);
            }
          } catch {}
        }
      }
    }
  } catch {}
  return servers;
}

const allMcp = loadMcpServers();
const mcpServers = variant === 'nomcp' ? {} : allMcp;

// ── config per variant (baseline mirrors the portal's resumeSession at session.ts:2837)
const config = {
  workingDirectory: process.cwd(),
  enableConfigDiscovery: variant !== 'noconfig',
  mcpServers,
};
if (variant === 'noembed') config.skipEmbeddingRetrieval = true;
if (variant === 'embedcache') config.embeddingCacheStorage = 'persistent';

const t = () => new Date().toLocaleTimeString([], { hour12: false });
const log = (...a) => console.log(`[${t()}]`, ...a);

log(`variant=${variant} session=${sessionId?.slice(0, 8)} size=${sizeMB}MB mcpCount=${Object.keys(mcpServers).length} configDiscovery=${config.enableConfigDiscovery} skipEmbed=${!!config.skipEmbeddingRetrieval}`);

// Raise the spawned CLI's heap exactly like the portal (cli-env.ts CLI_HEAP_MB=8192).
const existingNO = (process.env.NODE_OPTIONS ?? '').trim();
const NODE_OPTIONS = existingNO.includes('--max-old-space-size')
  ? existingNO
  : (existingNO ? `${existingNO} --max-old-space-size=8192` : '--max-old-space-size=8192');
const env = { ...process.env, NODE_OPTIONS };

const client = new CopilotClient({ env });

const mcpTimings = [];
config.onEvent = (ev) => {
  if (ev?.type === 'session.mcp_server_status_changed') {
    mcpTimings.push(`${t()} ${ev.serverName}->${ev.status}`);
  }
};

const t0 = Date.now();
let handle;
try {
  handle = await client.resumeSession(sessionId, config);
} catch (e) {
  log(`resumeSession FAILED: ${e?.message ?? e}`);
  process.exit(1);
}
const tResume = Date.now();
log(`resumeMs=${tResume - t0}`);

// Trivial RPC right after resume — measures post-resume channel starvation.
let firstRpcMs = -1;
try {
  const r0 = Date.now();
  await handle.rpc.model.getCurrent();
  firstRpcMs = Date.now() - r0;
} catch (e) {
  log(`model.getCurrent failed: ${e?.message ?? e}`);
}
log(`firstRpcMs=${firstRpcMs}`);

// Give MCP a moment to emit connect events so we can see their timing vs resume.
await new Promise(r => setTimeout(r, 8000));
log(`mcp events (${mcpTimings.length}):`);
for (const m of mcpTimings) log('   ', m);

log(`SUMMARY variant=${variant} resumeMs=${tResume - t0} firstRpcMs=${firstRpcMs} totalToUsableMs=${Date.now() - t0}`);

try { await handle.disconnect?.(); } catch {}
try { await client.stop?.(); } catch {}
process.exit(0);
