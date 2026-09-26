// Housekeeping: prune old uploads, compact the inbox, rotate append-only logs, drop stale agent cache files.
// Runs hourly from server.mjs (and once a minute after start). Every delete/rename/truncate goes through guard():
// only regular files strictly inside one of `roots`, never a symlink. dryRun reports without touching anything.
import { readdir, lstat, rm, rename, copyFile, truncate, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export const DEFAULTS = { uploadsDays: 30, resolvedDays: 14, rotateMB: 5, rotateKeep: 2, cacheDays: 7 }
const DAY = 86_400_000

export function cleanSettings(b = {}) {
  const out = {}
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const v = b[k] ?? d
    if (!Number.isInteger(v) || v < 1 || v > 3650) throw Object.assign(new Error(`${k}: a whole number 1–3650`), { status: 400 })
    out[k] = v
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
  return sum
}
