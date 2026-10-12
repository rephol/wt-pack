// WP-346/348 pause: an agent's row in the agents table (agents-table.mjs) is saved as `paused`, then its pane is despawned (agents.sh rm
// --keep-row) or its headless run stopped. Resume respawns it with --resume. A project pause pauses every live agent of the project and
// flags the project (ProjectStore.setPaused) so Dispatch, routines, refill and keepwarm skip it. The side effects are injected.
import { mirrored } from './agents-table.mjs'
const err = (status, m) => Object.assign(new Error(m), { status })
// ponytail: a paused headless run is a row whose pane is its run id ('hl-…'); a run has its own table, this only remembers it.
const isRun = (pane) => String(pane ?? '').startsWith('hl-')

// d: { agents(), rm(pane), stopHeadless(id), mark(names, paused) }
export async function pauseAgent(name, table, d, now = Date.now()) {
  const live = (await d.agents()).find((a) => a.local && a.name === name)
  const row = table.get(name)
  if (row?.state === 'paused') throw err(409, `${name} is already paused`)
  if (!live) throw err(row ? 409 : 404, row ? `${name} is ${row.state}; nothing to pause` : `no agent ${name}`)
  const prev = row ?? null
  table.upsert(name, {
    state: 'paused', paused_at: now, mid_turn: live.status === 'working', pane: live.id, cwd: live.cwd ?? prev?.cwd, session: live.session ?? prev?.session,
    role: live.headless ? live.tags?.role : live.paneTokens?.role ?? live.pool ?? prev?.role, persona: live.paneTokens?.persona ?? live.tags?.persona ?? prev?.persona,
    project: live.project ?? prev?.project, ticket: live.paneTokens?.ticket ?? prev?.ticket, tags: { ...prev?.tags, ...mirrored(live.paneTokens ?? live.tags) },
  }, now) // saved first: a crash mid-despawn leaves a resumable record
  try { await (live.headless ? d.stopHeadless(live.id) : d.rm(live.id)) } catch (e) {
    table.upsert(name, { state: prev?.state ?? 'idle', paused_at: null }) // still running: not paused
    throw e
  }
  await d.mark([name], true)
  return { name, midTurn: live.status === 'working' }
}

// d: { spawn(row) → { pane, fallback? }, resumeHeadless(id, text) → { fallback? }|null, send(pane, text), mark(names, paused) }
export async function resumeAgent(name, table, d) {
  const row = table.get(name)
  if (!row) throw err(404, `no agent ${name}`)
  if (row.state !== 'paused') throw err(409, `${name} is ${row.state}, not paused`)
  let pane = row.pane, fallback = null
  if (isRun(row.pane)) fallback = (await d.resumeHeadless(row.pane, row.mid_turn ? 'continue' : null))?.fallback ?? null
  else {
    const r = await d.spawn(row)
    pane = r.pane; fallback = r.fallback ?? null
  }
  // the row leaves `paused` as soon as the agent is running again; a failed `continue` must not strand a live pane as paused
  table.upsert(name, { state: 'idle', pane, paused_at: null, gone_at: null, mid_turn: false, ...(fallback ? { cwd: fallback.to } : {}) })
  await d.mark([name], false)
  let sendFailed = null
  if (row.mid_turn && !isRun(row.pane)) try { await d.send(pane, 'continue') } catch (e) { sendFailed = e.message }
  return { name, fallback, ...(sendFailed ? { sendFailed } : {}) }
}

export async function pauseProject(project, table, projects, d, now = Date.now()) {
  if (projects.isPaused(project)) throw err(409, `${project} is already paused`)
  const names = (await d.agents()).filter((a) => a.local && a.project === project).map((a) => a.name)
  projects.setPaused(project, now)
  const failed = []
  for (const n of names) await pauseAgent(n, table, d, now).catch((e) => failed.push({ name: n, error: e.message }))
  const paused = table.list().filter((r) => r.project === project && r.state === 'paused')
  return { project, agents: paused.length, midTurn: paused.filter((r) => r.mid_turn).length, failed }
}

export async function resumeProject(project, table, projects, d) {
  if (!projects.isPaused(project)) throw err(409, `${project} is not paused`)
  const rows = table.list().filter((r) => r.project === project && r.state === 'paused')
  const failed = [], fallbacks = []
  for (const r of rows) {
    try { const x = await resumeAgent(r.name, table, d); if (x.fallback) fallbacks.push({ name: r.name, ...x.fallback }) } catch (e) { failed.push({ name: r.name, error: e.message }) }
  }
  if (!failed.length) projects.setPaused(project, null) // a failed agent stays paused, and so does the project: retry resumes only the rest
  return { project, resumed: rows.length - failed.length, failed, fallbacks }
}
