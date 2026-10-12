// WP-346 project pause: save a project's agents, despawn them, and bring them back later. State lives in wt.db
// (table project_pauses, created here). Dispatch, routines, keepwarm and team refill skip a paused project.
// The side effects (herdr, agents.sh, the headless supervisor, the board) are injected, so the logic is testable with fakes.
const err = (status, m) => Object.assign(new Error(m), { status })

export class Pauses {
  // open: () => db, called on first use so importing the server (tests) opens nothing.
  constructor(open) { this.open = open }
  get db() {
    if (!this._db) { this._db = this.open(); this._db.exec('CREATE TABLE IF NOT EXISTS project_pauses (project TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL)') }
    return this._db
  }
  get(project) { const r = this.db.prepare('SELECT at, json FROM project_pauses WHERE project = ?').get(project); return r && { at: r.at, ...JSON.parse(r.json) } }
  has(project) { return !!this.db.prepare('SELECT 1 FROM project_pauses WHERE project = ?').get(project) }
  set(project, rec, at = Date.now()) { this.db.prepare('INSERT OR REPLACE INTO project_pauses (project, at, json) VALUES (?, ?, ?)').run(project, at, JSON.stringify(rec)) }
  clear(project) { this.db.prepare('DELETE FROM project_pauses WHERE project = ?').run(project) }
}

// What resume needs of one live agent row (server.mjs agents()/headlessRows()), pane tokens included.
export function snapshotAgent(a) {
  const midTurn = a.status === 'working'
  if (a.headless) return { kind: 'headless', id: a.id, name: a.name, session: a.session, midTurn }
  const t = a.paneTokens ?? {}
  return { kind: 'pane', name: a.name, role: t.role ?? a.tags?.role, persona: t.persona, cwd: a.cwd, session: a.session, tokens: t, midTurn }
}

// d: { agents(), rm(pane), stopHeadless(id), mark(names, paused) }
export async function pauseProject(project, pauses, d) {
  if (pauses.has(project)) throw err(409, `${project} is already paused`)
  const live = (await d.agents()).filter((a) => a.local && a.project === project)
  const saved = live.map(snapshotAgent)
  pauses.set(project, { agents: saved }) // saved first: a crash mid-despawn leaves a resumable record
  const failed = []
  for (const [i, a] of live.entries()) {
    try { await (a.headless ? d.stopHeadless(a.id) : d.rm(a.id)) } catch (e) { failed.push({ name: a.name, error: e.message }); saved[i].left = true }
  }
  await d.mark(saved.map((s) => s.name), true)
  pauses.set(project, { agents: saved }, pauses.get(project).at)
  return { project, agents: saved.length, midTurn: saved.filter((s) => s.midTurn).length, failed }
}

// d: { spawn(agent) → pane id, resumeHeadless(id, text), send(pane, text), mark(names, paused) }
export async function resumeProject(project, pauses, d) {
  const rec = pauses.get(project)
  if (!rec) throw err(409, `${project} is not paused`)
  const left = [], failed = []
  for (const a of rec.agents) {
    if (a.left) continue // never despawned (pause could not close it): still running
    try {
      if (a.kind === 'headless') await d.resumeHeadless(a.id, a.midTurn ? 'continue' : null)
      else { const pane = await d.spawn(a); if (a.midTurn) await d.send(pane, 'continue') }
    } catch (e) { failed.push({ name: a.name, error: e.message }); left.push(a) }
  }
  if (failed.length) { pauses.set(project, { agents: left }, rec.at); return { project, resumed: rec.agents.length - left.length, failed } } // retry resumes only the rest
  pauses.clear(project)
  await d.mark(rec.agents.map((a) => a.name), false)
  return { project, resumed: rec.agents.length, failed }
}
