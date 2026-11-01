// WP-378 U5: hc terminals -> the dashboard's agents. Pure (no hc call, no server state) so the listing, the ghost rule and the
// core-identity rule are unit-tested directly. The one hc call per tick lives in server.mjs (hc.mjs `list({all:true})`).
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// hc status word -> the dashboard's AgentState. `done` is the resting state after a turn (S1); `error` has no state of its own.
const STATUS = { idle: 'idle', working: 'working', done: 'done', blocked: 'blocked', error: 'unknown' }
export const POOL_LABEL = 'wt.pool' // the pool a terminal belongs to (herdr's workspace): `<repo>-<role>s`

// Is this terminal one of the pack's agents, and in which state? null = not an agent (a user's shell, a finished one-off).
//  - live and running claude (or any program that reports a status) -> its reported state; a claude that has not reported yet is idle
//  - finished, or live but not claude (a `keep` shell at an agent's address, S5-8) -> `exited`, only when the pack knows the name
//    (agents-table row) or the terminal still carries a role label; anything else is somebody's terminal, not ours (never typed into)
//  - a `<project>-shells` terminal is the Terminals view's, never an agent
export function agentStatus(t, known = new Set()) {
  if (String(t.labels?.[POOL_LABEL] ?? '').endsWith('-shells')) return null
  const live = t.alive && (t.status != null || t.program === 'claude')
  if (live) return STATUS[t.status] ?? (t.status ? 'unknown' : 'idle')
  return (t.name && known.has(t.name)) || t.labels?.role ? 'exited' : null
}

// The rows listAgents() builds from: the herdr-shaped record per agent terminal, plus the maps paneMeta() serves.
// `tagKeys`: the pane-token names the pack mirrors (roles.mjs TAG_KEYS); other labels (wt.pool, a user's own) are not tokens.
export function snapshot(terminals, { known = new Set(), tagKeys = [] } = {}) {
  const agents = [], ws = new Map(), tokens = new Map(), ids = new Set()
  for (const t of terminals) {
    ids.add(t.id)
    ws.set(t.id, t.labels?.[POOL_LABEL] ?? undefined)
    tokens.set(t.id, Object.fromEntries(Object.entries(t.labels ?? {}).filter(([k, v]) => tagKeys.includes(k) && typeof v === 'string')))
    const status = agentStatus(t, known)
    if (!status) continue
    agents.push({
      pane_id: t.id, name: t.name ?? t.id, agent_status: status, cwd: t.foreground?.cwd ?? t.cwd, foreground_cwd: t.foreground?.cwd ?? t.cwd,
      state_change_seq: `${t.turn}:${t.status ?? t.state}`, // paneStale compares it for inequality only
      workspace_id: t.id, pid: t.foreground?.pid ?? null, title: t.title || '',
      blocked: t.status === 'blocked' ? { kind: t.statusKind, msg: t.statusMsg } : null,
    })
  }
  return { agents, ws, tokens, ids }
}

// claude agents --json ({sessionId, pid}[]) -> terminal pid -> session id. A terminal's claude pid is the foreground pid (the launcher execs it).
export const sessionsByPid = (rows) => new Map((Array.isArray(rows) ? rows : []).filter((x) => x?.sessionId && x?.pid != null).map((x) => [Number(x.pid), x.sessionId]))

// D4: the dashboard remembers the core it last saw (`hc server status --json` core.id). A different id means a different core
// (new machine state dir, reinstall, another HC_SESSION): its addresses t1.. alias nothing we know, so every agents-table row and
// pane key is dropped. First sight stores the id and drops nothing. `file` holds {id}; dropRows()/dropKeys() are injected.
export function coreChanged(file, id, { dropRows = () => {}, dropKeys = () => {} } = {}) {
  if (!id) return 'unknown'
  let had = null
  try { had = JSON.parse(readFileSync(file, 'utf8')).id ?? null } catch { /* first sight */ }
  if (had === id) return 'same'
  if (had) { dropRows(); dropKeys() }
  writeFileSync(file, JSON.stringify({ id, at: Date.now() }))
  return had ? 'changed' : 'new'
}
// pane-keys/<address>: remove every key file (they belonged to the old core's terminals)
export function dropPaneKeys(dir) {
  let n = 0
  try { for (const f of readdirSync(dir)) { try { unlinkSync(join(dir, f)); n++ } catch { /* gone */ } } } catch { /* no dir */ }
  return n
}
