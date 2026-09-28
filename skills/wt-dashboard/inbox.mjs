// Notifications inbox: one feed in <data root>/data/wt.db (table notifications), the single source for the
// in-app inbox, native notifications and the tray count. Items are inserted; read/resolved/cleared update the row. Pure pieces (kind mapping, actionable, resolution) are exported for parse.test.mjs.
import { join } from 'node:path'
import { readdirSync, lstatSync, readFileSync } from 'node:fs'
import { open, tx } from './store.mjs'
import { randomUUID } from 'node:crypto'

export const KINDS = ['needs-you', 'question', 'mention-user', 'room-suggestion', 'agent-done', 'agent-stalled', 'ci-failed', 'server', 'usage', 'room-created', 'memory', 'memory-proposal', 'watchdog', 'pr-held', 'routing-escalation', 'ask']
export const ACTIONABLE = new Set(['needs-you', 'question', 'mention-user', 'room-suggestion', 'memory-proposal', 'pr-held', 'routing-escalation', 'ask'])

// A transition (from server.mjs transitions()) → an inbox item draft.
export function itemFromTransition(e) {
  const room = e.key?.startsWith('room:') ? e.key.slice(5) : null
  const kind = e.type === 'needs_you' ? (room ? 'mention-user' : 'question') : e.type === 'done' ? 'agent-done' : e.type === 'stalled' ? 'agent-stalled' : 'ci-failed'
  const what = { question: 'asks you', 'mention-user': 'mentioned you', 'agent-done': 'is done', 'agent-stalled': 'looks stalled', 'ci-failed': 'CI failing' }[kind]
  return {
    kind, key: e.dedupe,
    title: kind === 'ci-failed' ? `${e.name} · CI failing` : `${e.name}${e.project && !room ? ` (${e.project})` : ''} ${what}`,
    body: (e.text ?? '').slice(0, 300),
    target: room ? { room } : e.key ? { agent: e.key } : { pr: e.name, url: e.url ?? null },
  }
}

// Which unresolved actionable items no longer hold. `needs`: Set of target keys still needing the user
// (agent keys and `room:<slug>` for room mentions); `suggested`: Set of ticket ids still suggested;
// `proposals`: Set of wt-memory ids still pending, or null when unknown (then none resolve); `holds`: Set of
// pr-held keys still held (reviewHolds), or null when unknown. `openAsks`: Set of still-open ask ids, or null
// when unknown (then an `ask` item is left alone — asks.mjs resolves its own inbox item when the ask closes).
export function toResolve(items, needs, suggested, proposals = null, holds = null, openAsks = null) {
  return items.filter((it) => !it.resolvedAt && ACTIONABLE.has(it.kind) && (
    it.kind === 'memory-proposal' ? proposals !== null && !proposals.has(it.target.memory)
    : it.kind === 'pr-held' ? holds !== null && !holds.has(it.key)
    : it.kind === 'ask' ? openAsks !== null && !openAsks.has(it.target.ask)
    : it.kind === 'room-suggestion' ? !suggested.has(it.target.task)
      : it.kind === 'mention-user' ? !needs.has(`room:${it.target.room}`)
        : !needs.has(it.target.agent)
  )).map((it) => it.id)
}

// WP-116: PRs a wt-watch-prs reviewer holds (state "changes-requested"), from <root>/<owner>-<repo>/state.json,
// as inbox drafts. The files are agent-written, so untrusted: no symlinks, ≤1 MB, digit PR keys only, the repo
// from the dir name (never the JSON), the note cut to 500 chars. A missing root is no holds.
export function reviewHolds(root) {
  let dirs = []
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return [] }
  return dirs.flatMap((d) => {
    const f = join(root, d.name, 'state.json')
    try {
      const st = lstatSync(f)
      if (!st.isFile() || st.size > 1_000_000) return []
      const reviewed = JSON.parse(readFileSync(f, 'utf8'))?.reviewed ?? {}
      return Object.entries(reviewed).filter(([n, e]) => /^\d{1,7}$/.test(n) && e?.state === 'changes-requested').map(([n, e]) => ({
        kind: 'pr-held', key: `pr-held|${d.name}#${n}`, title: `Held PR #${n} (${d.name})`,
        body: typeof e.outcome === 'string' ? e.outcome.slice(0, 500) : '', target: { pr: `${d.name}#${n}` },
      }))
    } catch { return [] }
  })
}

// WT_JEV_INBOX_RANK: one score per new item, stored as `urgency` 0-3 (noise, FYI, needs attention soon, blocking).
export const inboxRank = {
  questions: () => ({ urgency: { type: 'score', instructions: 'How urgent is this dashboard notification for the developer who runs these coding agents?',
    criteria: ['noise: nothing to do and nothing worth knowing', 'FYI: worth knowing, no action needed', 'needs attention soon: the user should act within the hour', 'blocking: an agent or the work is stopped until the user acts'] } }),
  // Jev's score answer: {score: expected level 0-3, probabilities, confidence}.
  decide: (a) => (typeof a?.urgency?.score === 'number' ? Math.max(0, Math.min(3, Math.round(a.urgency.score))) : null),
  state: (it) => ({ kind: it.kind, title: it.title, body: it.body }),
}

export class Inbox {
  // dir: the data dir; items live in its wt.db (store.mjs). `items` is the in-memory copy: the server is the only
  // writer, and each change updates it in the same call as the DB.
  constructor(dir) { Object.assign(this, { file: join(dir, 'wt.db'), items: null, subs: new Set() }) }
  get db() { return open(this.file) }
  async load() {
    if (this.items) return
    this.items = this.db.prepare('SELECT json FROM notifications ORDER BY seq').all().map((r) => JSON.parse(r.json))
  }
  async add(draft) {
    await this.load()
    // One item per condition: an actionable one is skipped while an unresolved item with its key exists;
    // any kind is skipped if an item with its key was made in the last 60s.
    const now = Date.now()
    if (this.items.some((it) => it.key === draft.key && ((ACTIONABLE.has(draft.kind) && !it.resolvedAt) || now - Date.parse(it.ts) < 60_000))) return null
    const it = { id: randomUUID(), ts: new Date(now).toISOString(), read: false, resolvedAt: null, ...draft }
    this.db.prepare('INSERT INTO notifications (id, json) VALUES (?, ?)').run(it.id, JSON.stringify(it))
    this.items.push(it)
    for (const f of this.subs) f(it)
    return it
  }
  async patch(ids, patch) {
    await this.load()
    const set = new Set(ids)
    const hit = this.items.filter((it) => set.has(it.id))
    tx(this.db, () => {
      const up = this.db.prepare('UPDATE notifications SET json = ? WHERE id = ?')
      for (const it of hit) up.run(JSON.stringify({ ...it, ...patch }), it.id)
    })
    for (const it of hit) Object.assign(it, patch)
    return hit.length
  }
  // Drop items matching `drop`. Returns {dropped}.
  async compact(drop, { dryRun = false } = {}) {
    await this.load()
    const gone = this.items.filter(drop)
    if (gone.length && !dryRun) {
      tx(this.db, () => { const del = this.db.prepare('DELETE FROM notifications WHERE id = ?'); for (const it of gone) del.run(it.id) })
      this.items = this.items.filter((it) => !gone.includes(it))
    }
    return { dropped: gone.length }
  }
  resolve(ids) { return ids.length ? this.patch(ids, { resolvedAt: new Date().toISOString() }) : 0 }
  // Cleared items stay in the DB but are never listed or counted.
  list(limit = 300) { return this.items.filter((it) => !it.clearedAt).slice(-limit).reverse() }
  // The tray/badge: unresolved actionable items.
  open() { return this.items.filter((it) => !it.resolvedAt && !it.clearedAt && ACTIONABLE.has(it.kind)) }
  // `which`: {ids} | {allRead: true} | {all: true}
  async clear(which) {
    await this.load() // a fresh Inbox (no list/add yet) has items === null
    const live = this.items.filter((it) => !it.clearedAt)
    const ids = which.all ? live.map((it) => it.id) : which.allRead ? live.filter((it) => it.read).map((it) => it.id) : (which.ids ?? []).filter((x) => typeof x === 'string')
    return this.patch(ids, { clearedAt: new Date().toISOString(), read: true })
  }
}
