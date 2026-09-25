// Notifications inbox: one feed at <data root>/data/notifications.jsonl, the single source for the in-app
// inbox, native notifications and the tray count. Items are appended; later {type:'update'} lines mark them
// read or resolved. Pure pieces (kind mapping, actionable, resolution) are exported for parse.test.mjs.
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const KINDS = ['needs-you', 'question', 'mention-user', 'room-suggestion', 'agent-done', 'agent-stalled', 'ci-failed', 'server', 'usage']
export const ACTIONABLE = new Set(['needs-you', 'question', 'mention-user', 'room-suggestion'])

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
// (agent keys and `room:<slug>` for room mentions); `suggested`: Set of ticket ids still suggested.
export function toResolve(items, needs, suggested) {
  return items.filter((it) => !it.resolvedAt && ACTIONABLE.has(it.kind) && (
    it.kind === 'room-suggestion' ? !suggested.has(it.target.task)
      : it.kind === 'mention-user' ? !needs.has(`room:${it.target.room}`)
        : !needs.has(it.target.agent)
  )).map((it) => it.id)
}

export class Inbox {
  constructor(file) { Object.assign(this, { file, items: null, subs: new Set() }) }
  async load() {
    if (this.items) return
    await mkdir(dirname(this.file), { recursive: true })
    const byId = new Map()
    for (const l of (await readFile(this.file, 'utf8').catch(() => '')).split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(l)
        if (e.type === 'update') Object.assign(byId.get(e.id) ?? {}, e.patch)
        else byId.set(e.id, e)
      } catch { /* torn line */ }
    }
    this.items = [...byId.values()]
  }
  async add(draft) {
    await this.load()
    // One item per condition: an actionable one is skipped while an unresolved item with its key exists;
    // any kind is skipped if an item with its key was made in the last 60s.
    const now = Date.now()
    if (this.items.some((it) => it.key === draft.key && ((ACTIONABLE.has(draft.kind) && !it.resolvedAt) || now - Date.parse(it.ts) < 60_000))) return null
    const it = { id: randomUUID(), ts: new Date(now).toISOString(), read: false, resolvedAt: null, ...draft }
    this.items.push(it)
    await appendFile(this.file, JSON.stringify(it) + '\n')
    for (const f of this.subs) f(it)
    return it
  }
  async patch(ids, patch) {
    await this.load()
    const set = new Set(ids)
    const hit = this.items.filter((it) => set.has(it.id))
    for (const it of hit) Object.assign(it, patch)
    if (hit.length) await appendFile(this.file, hit.map((it) => JSON.stringify({ type: 'update', id: it.id, patch })).join('\n') + '\n')
    return hit.length
  }
  resolve(ids) { return ids.length ? this.patch(ids, { resolvedAt: new Date().toISOString() }) : 0 }
  // Cleared items stay in the jsonl (an update line) but are never listed or counted.
  list(limit = 300) { return this.items.filter((it) => !it.clearedAt).slice(-limit).reverse() }
  // The tray/badge: unresolved actionable items.
  open() { return this.items.filter((it) => !it.resolvedAt && !it.clearedAt && ACTIONABLE.has(it.kind)) }
  // `which`: {ids} | {allRead: true} | {all: true}
  clear(which) {
    const live = this.items.filter((it) => !it.clearedAt)
    const ids = which.all ? live.map((it) => it.id) : which.allRead ? live.filter((it) => it.read).map((it) => it.id) : (which.ids ?? []).filter((x) => typeof x === 'string')
    return this.patch(ids, { clearedAt: new Date().toISOString(), read: true })
  }
}
