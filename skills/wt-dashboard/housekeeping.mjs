// Housekeeping: prune old uploads, compact the inbox, rotate append-only logs, drop stale agent cache files.
// Runs hourly from server.mjs (and once a minute after start). Every delete/rename/truncate goes through guard():
// only regular files strictly inside one of `roots`, never a symlink. dryRun reports without touching anything.
import { readdir, lstat, rm, rename, copyFile, truncate, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export const DEFAULTS = { uploadsDays: 30, resolvedDays: 14, rotateMB: 5, rotateKeep: 2, cacheDays: 7, missingAgentHours: 24 }
const DAY = 86_400_000

export function cleanSettings(b = {}) {
  const out = {}
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const v = b[k] ?? d
    if (k === 'missingAgentHours') { // WP-364: 0 = off
      if (!Number.isInteger(v) || v < 0 || v > 720) throw Object.assign(new Error(`${k}: a whole number 0–720 (0 = off)`), { status: 400 })
      out[k] = v; continue
    }
    if (!Number.isInteger(v) || v < 1 || v > 3650) throw Object.assign(new Error(`${k}: a whole number 1–3650`), { status: 400 })
    out[k] = v
  }
  return out
}

// WP-364: forget agents-table rows that have been missing/exited longer than `hours`. Kept: a paused row, a row of a
// paused project (Resume respawns from it), a row whose ticket card is still open (the work may resume), a name that
// is live again. The watcher stays a pure mirror; this is the only automatic delete. Returns the names forgotten.
export async function sweepMissingAgents({ rows, hours, now = Date.now(), projectPaused = () => false, ticketOpen = async () => false, liveNames = new Set(), current = null, remove, dryRun = false }) {
  if (!hours || hours <= 0) return []
  const out = []
  for (const r of rows) {
    if (r.state !== 'missing' && r.state !== 'exited') continue
    const at = r.gone_at ?? r.seen_at ?? r.created_at
    if (!at || now - at <= hours * 3_600_000) continue
    if (liveNames.has(r.name) || (r.project && projectPaused(r.project))) continue
    // fail closed: ticketOpen resolves false only for a card that is known to be closed or absent; any error keeps the row
    if (r.ticket && await ticketOpen(r.ticket).catch(() => true)) continue
    // re-read just before the delete: a respawn or pause may have landed since `rows` was listed
    const fresh = current ? current(r.name) : r
    if (!fresh || !['missing', 'exited'].includes(fresh.state)) continue
    if (!dryRun) remove(r.name)
    out.push(r.name)
  }
  return out
}

// `ctx`: { roots, uploads, roomRefs: string (messages of non-archived rooms), extraRefs: string (text that may name uploads),
//   inbox (Inbox), rotate: [{file, mode: 'rename'|'copytruncate'}], memCache, agentsCache,
//   live: {sessions: Set, names: Set} | null (null = unknown → caches untouched), settings, now, dryRun }
export async function housekeep(ctx) {
  const s = { ...DEFAULTS, ...ctx.settings }
  const now = ctx.now ?? Date.now()
  const sum = { at: new Date(now).toISOString(), dryRun: !!ctx.dryRun, files: 0, bytes: 0, actions: [], errors: [] }
  const guard = async (f) => {
    const p = resolve(f)
    const st = await lstat(p) // ENOENT: nothing to do (callers skip it quietly)
    if (!st.isFile()) throw new Error(`not a regular file: ${p}`)
    const real = await realpath(p)
    const ok = await Promise.all(ctx.roots.map(async (r) => p.startsWith(resolve(r) + sep) && real.startsWith((await realpath(r).catch(() => resolve(r))) + sep)))
    if (!ok.some(Boolean)) throw new Error(`outside the allowed dirs: ${p}`)
    return st
  }
  const act = async (what, f, fn) => {
    try {
      const st = await guard(f)
      if (!ctx.dryRun) await fn()
      sum.actions.push(`${what} ${f}`)
      return st
    } catch (e) { if (e.code !== 'ENOENT') sum.errors.push(`${what} ${f}: ${e.message}`) }
  }
  const del = async (f) => { const st = await act('delete', f, () => rm(f)); if (st) { sum.files++; sum.bytes += st.size } }

  // 1. uploads older than N days, unless a non-archived room message (or the profile) names them.
  if (ctx.uploads) {
    const refs = (ctx.extraRefs ?? '') + (ctx.roomRefs ?? '')
    for (const day of await readdir(ctx.uploads, { withFileTypes: true }).catch(() => [])) {
      if (!day.isDirectory()) continue
      for (const f of await readdir(join(ctx.uploads, day.name)).catch(() => [])) {
        const p = join(ctx.uploads, day.name, f)
        const st = await lstat(p).catch(() => null)
        if (st?.isFile() && now - st.mtimeMs > s.uploadsDays * DAY && !refs.includes(f)) await del(p)
      }
    }
  }
  // 2. inbox: drop items resolved (or cleared) more than N days ago (row deletes; wt.db does not shrink).
  if (ctx.inbox) {
    try {
      const n = await ctx.inbox.compact((it) => [it.resolvedAt, it.clearedAt].some((t) => t && now - Date.parse(t) > s.resolvedDays * DAY), { dryRun: ctx.dryRun })
      if (n.dropped) sum.actions.push(`inbox: drop ${n.dropped} old resolved items`)
    } catch (e) { sum.errors.push(`inbox: ${e.message}`) }
  }
  // 3. rotate append-only files over the size limit: f → f.1 → f.2 …, keeping `rotateKeep`.
  for (const { file, mode } of ctx.rotate ?? []) {
    const st = await lstat(file).catch(() => null)
    if (!st || st.size < s.rotateMB * 1024 * 1024) continue
    const old = `${file}.${s.rotateKeep}`
    if (await lstat(old).catch(() => null)) await del(old)
    for (let i = s.rotateKeep - 1; i >= 1; i--) await act('rotate', `${file}.${i}`, () => rename(`${file}.${i}`, `${file}.${i + 1}`))
    // launchd and the app keep their log open: copy then truncate in place (they write O_APPEND, so they continue at 0).
    if (mode === 'copytruncate') await act('rotate', file, async () => { await copyFile(file, `${file}.1`); await truncate(file, 0) })
    else await act('rotate', file, () => rename(file, `${file}.1`))
  }
  // 4. agent caches for sessions/agents that no longer exist, older than N days. Unknown liveness → untouched.
  if (ctx.live) {
    const stale = async (dir, match) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!e.isFile() || !match(e.name)) continue
        const p = join(dir, e.name)
        const st = await lstat(p).catch(() => null)
        if (st && now - st.mtimeMs > s.cacheDays * DAY) await del(p)
      }
    }
    if (ctx.memCache) await stale(ctx.memCache, (f) => { const m = f.match(/^(.+)\.hash$/); return m && !ctx.live.sessions.has(m[1]) })
    if (ctx.agentsCache) await stale(ctx.agentsCache, (f) => { const m = f.match(/^mcp-(.+)\.json$/); return m && !ctx.live.names.has(m[1]) })
  }
  // 5. WP-364: missing/exited agent rows past `missingAgentHours`.
  if (ctx.agentRows) {
    try {
      const gone = await sweepMissingAgents({ rows: ctx.agentRows, hours: s.missingAgentHours, now, projectPaused: ctx.projectPaused, ticketOpen: ctx.ticketOpen, liveNames: ctx.live?.names, current: ctx.agentRow, remove: ctx.forgetAgent, dryRun: ctx.dryRun })
      sum.forgotAgents = gone.length
      if (gone.length) { sum.actions.push(`forget ${gone.length} missing agents`); if (!ctx.dryRun) (ctx.log ?? console.log)(`housekeeping: forgot ${gone.length} missing agents`) }
    } catch (e) { sum.errors.push(`agents: ${e.message}`) }
  }
  return sum
}
