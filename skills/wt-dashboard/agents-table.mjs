// WP-348: one durable row per local pane agent in wt.db, keyed by its stable name. herdr is something the dashboard
// watches (reconcile, below), not the source of truth. The table is lazy like project_pauses/projects: store.mjs's staged
// migrations only import when legacy *files* are present, which cannot carry this import.
// Never stored: task, task_state, handoff_* (LIVE_KEYS) or a pane key. tags = roles.mjs MIRRORED_KEYS only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIRRORED_KEYS } from './roles.mjs'

export const STATES = ['running', 'idle', 'paused', 'exited', 'missing']
const KEEP = new Set([...MIRRORED_KEYS, 'ticket', 'model', 'effort', 'team']) // model/effort: Resume keeps the spawn tier; team: refill counts a paused member. None is a task or handoff key
export const mirrored = (tokens = {}) => Object.fromEntries(Object.entries(tokens).filter(([k, v]) => KEEP.has(k) && typeof v === 'string' && v))
const COLS = ['role', 'persona', 'project', 'cwd', 'session', 'pane', 'stable_pane', 'ticket', 'tags', 'state', 'mid_turn', 'seen_at', 'gone_at', 'paused_at']
const view = (r) => r && { ...r, tags: JSON.parse(r.tags || '{}'), mid_turn: !!r.mid_turn }

export class AgentTable {
  // open: () => db, called on first use so importing the server (tests) opens nothing.
  // onCreate(table): called once right after the table is first created (the legacy import).
  constructor(open, onCreate) { this.open = open; this.onCreate = onCreate }
  get db() {
    if (!this._db) {
      const db = this._db = this.open()
      this.fresh = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get()
      // creating the table and importing the legacy stores are one transaction: a failed import leaves no table, so the next start retries it
      db.exec('BEGIN')
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS agents (name TEXT PRIMARY KEY, role TEXT, persona TEXT, project TEXT, cwd TEXT, session TEXT,
          pane TEXT, stable_pane TEXT, ticket TEXT, tags TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL, mid_turn INTEGER NOT NULL DEFAULT 0,
          seen_at INTEGER, gone_at INTEGER, paused_at INTEGER, created_at INTEGER NOT NULL)`)
        if (this.fresh) this.onCreate?.(this)
        db.exec('COMMIT')
      } catch (e) { try { db.exec('ROLLBACK') } catch { /* no transaction left */ } this._db = undefined; throw e }
    }
    return this._db
  }
  get(name) { return view(this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name)) }
  list() { return this.db.prepare('SELECT * FROM agents ORDER BY created_at, name').all().map(view) }
  byPane(pane) { return view(this.db.prepare('SELECT * FROM agents WHERE pane = ? OR stable_pane = ?').get(pane, pane)) }
  // patch: any of COLS (tags as an object). Creates the row when missing (state required then).
  upsert(name, patch, now = Date.now()) {
    const p = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === undefined ? null : v]))
    if (p.tags) p.tags = JSON.stringify(mirrored(p.tags))
    if ('mid_turn' in p) p.mid_turn = p.mid_turn ? 1 : 0
    const cols = Object.keys(p).filter((k) => COLS.includes(k))
    if (this.db.prepare('SELECT 1 FROM agents WHERE name = ?').get(name)) {
      if (cols.length) this.db.prepare(`UPDATE agents SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE name = ?`).run(...cols.map((c) => p[c]), name)
    } else {
      this.db.prepare(`INSERT INTO agents (name, created_at, state${cols.filter((c) => c !== 'state').map((c) => `, ${c}`).join('')}) VALUES (?, ?, ?${cols.filter((c) => c !== 'state').map(() => ', ?').join('')})`)
        .run(name, now, p.state ?? 'idle', ...cols.filter((c) => c !== 'state').map((c) => p[c]))
    }
  }
  remove(name) { this.db.prepare('DELETE FROM agents WHERE name = ?').run(name) }

  // One-time import of the stores this replaces, when the table was just created. Legacy files/tables stay in place for
  // rollback; nothing reads them again. dataDir holds agent-tags.json and watchdog.json; setPaused(project, at) flags a project.
  importLegacy(dataDir, setPaused = () => {}, now = Date.now()) {
    this.db // open (sets this.fresh)
    if (!this.fresh) return false
    this.fresh = false
    const json = (f) => { try { return JSON.parse(readFileSync(join(dataDir, f), 'utf8')) } catch { return null } }
    const rows = new Map()
    for (const [name, tags] of Object.entries(json('agent-tags.json') ?? {})) rows.set(name, { tags: mirrored(tags), role: tags.role, persona: tags.persona, project: tags.project, ticket: tags.ticket, state: 'idle' })
    for (const [, v] of Object.entries(json('watchdog.json')?.lastSeen ?? {})) {
      if (!v?.name) continue
      rows.set(v.name, { ...rows.get(v.name), role: v.role, ticket: v.ticket, session: v.session, cwd: v.cwd, seen_at: v.seenAt ?? null, gone_at: v.goneAt ?? null, state: v.goneAt ? 'exited' : 'idle' })
    }
    const pauses = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_pauses'").get()
      ? this.db.prepare('SELECT project, at, json FROM project_pauses').all() : []
    for (const pz of pauses) {
      setPaused(pz.project, pz.at)
      for (const a of JSON.parse(pz.json).agents ?? []) {
        if (a.kind === 'headless') continue // runs keep their own table; the project flag covers them
        rows.set(a.name, { ...rows.get(a.name), role: a.role, persona: a.persona, project: pz.project, cwd: a.cwd, session: a.session, tags: mirrored(a.tokens), ticket: a.tokens?.ticket, mid_turn: a.midTurn, state: 'paused', paused_at: pz.at })
      }
    }
    for (const [name, r] of rows) this.upsert(name, { ...r, tags: r.tags ?? {} }, now)
    return true
  }
}

// The pure watcher. rows: AgentTable.list(); live: local agents from listAgents() ({ name, id, stableId?, session, status, cwd, pool, project,
// ticket, paneTokens }); panes: Set of pane ids herdr still lists. Returns [{ name, patch }] for rows that changed (plus new rows).
export function reconcile(rows, live, panes, now = Date.now()) {
  const byName = new Map(rows.map((r) => [r.name, r]))
  const sessionCount = new Map()
  for (const a of live) if (a.session) sessionCount.set(a.session, (sessionCount.get(a.session) ?? 0) + 1)
  const claimed = new Set(), out = []
  const stateOf = (a) => (a.status === 'exited' ? 'exited' : a.status === 'working' || a.status === 'blocked' ? 'running' : 'idle')
  const fresh = (a, row) => ({
    pane: a.id, stable_pane: a.stableId ?? row?.stable_pane ?? null, cwd: a.cwd ?? null, session: a.session ?? row?.session ?? null, state: stateOf(a),
    role: a.pool && a.pool !== 'other' ? a.pool : row?.role ?? null, project: a.project ?? row?.project ?? null,
    ticket: a.paneTokens?.ticket ?? row?.ticket ?? null, seen_at: now, gone_at: null,
  })
  const changed = (row, patch) => Object.entries(patch).some(([k, v]) => k !== 'seen_at' && k !== 'tags' && (row[k] ?? null) !== v)
  for (const a of live) {
    // 1. session id (only when one live agent carries it: the row follows a pane/name change), 2. name, 3. a new row
    let row = a.session && sessionCount.get(a.session) === 1 ? rows.find((r) => r.session === a.session && !claimed.has(r.name)) : null
    if (!row) { const r = byName.get(a.name); if (r && !claimed.has(r.name)) row = r }
    if (row?.state === 'paused') row = null // only resumeAgent takes a row out of paused
    if (!row) {
      if (byName.has(a.name)) continue // a live agent under a paused/claimed row's name: leave the row alone
      out.push({ name: a.name, patch: { ...fresh(a), tags: mirrored(a.paneTokens), mid_turn: false }, created: true }); claimed.add(a.name); continue
    }
    claimed.add(row.name)
    const patch = fresh(a, row)
    const { model: _m, effort: _e, team: _t, ...kept } = row.tags ?? {} // spawn-owned keys follow the pane (a cleared one drops); the rest merge
    const tags = { ...kept, ...mirrored(a.paneTokens) }
    if (JSON.stringify(tags) !== JSON.stringify(row.tags ?? {})) patch.tags = tags
    if (changed(row, patch) || patch.tags) out.push({ name: row.name, patch })
  }
  for (const r of rows) {
    if (claimed.has(r.name) || r.state === 'paused' || r.state === 'missing') continue
    const present = (r.pane && panes.has(r.pane)) || (r.stable_pane && panes.has(r.stable_pane))
    const state = present ? 'exited' : 'missing'
    if (r.state === state) continue
    out.push({ name: r.name, patch: { state, gone_at: r.gone_at ?? now } })
  }
  return out
}

// A row with no live pane, shaped like an agents() row for the list API and team views (consumers that act on a pane never see it).
export const rowAsAgent = (r) => ({
  key: `local/${r.name}`, id: null, machine: 'local', local: true, name: r.name, status: r.state, state: r.state, statusSince: r.paused_at ?? r.gone_at ?? r.seen_at ?? r.created_at, // WP-350: an imported row may have no stamp
  lastActivity: r.paused_at ?? r.gone_at ?? r.seen_at ?? r.created_at, cwd: r.cwd, project: r.project, session: r.session, pool: r.role ?? 'other', roleBy: 'token',
  tags: { ...r.tags, ...(r.role ? { role: r.role } : {}), ...(r.persona ? { persona: r.persona } : {}), ...(r.project ? { project: r.project } : {}), ...(r.ticket ? { ticket: r.ticket } : {}) },
  paneTokens: {}, workspace: null, asks: false, picker: null, midTurn: r.mid_turn, stored: true,
})
