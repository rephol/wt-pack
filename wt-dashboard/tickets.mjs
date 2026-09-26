// Local ticket boards in DATA/wt.db (store.mjs): boards { project, key, next } and one row per ticket. Ids are <KEY>-N.
// The server is the only writer (the wt-ticket CLI goes through the API); each change is one transaction.
import { join } from 'node:path'
import { open, tx } from './store.mjs'

export const COLUMNS = ['backlog', 'ready', 'planning', 'building', 'review', 'done', 'blocked']
export const TYPES = ['bug', 'ux', 'gap', 'debt', 'feature']
export const SIZES = ['S', 'M', 'L']
const PROJECT = /^[\w.-]{1,64}$/
const err = (status, m) => Object.assign(new Error(m), { status })

// wt-pack → WP; one letter → first 3 letters; letters only, 2–5; taken → add the name's next letter.
export function deriveKey(project, taken = new Set()) {
  const words = project.split(/[-_]/).map((w) => w.replace(/[^a-z]/gi, '')).filter(Boolean)
  let key = words.map((w) => w[0]).join('').toUpperCase()
  const letters = words.join('').toUpperCase()
  if (key.length < 2) key = letters.slice(0, 3)
  key = key.slice(0, 5)
  let i = key.length
  while (taken.has(key) && key.length < 5 && i < letters.length) key += letters[i++]
  while (taken.has(key) || key.length < 2) {
    if (key.length >= 5) throw err(409, `no free key for ${project}`)
    key += 'X'
  }
  return key
}

// Validation at the boundary: unknown fields dropped, enums and sizes checked.
export function clean(b, { create = false } = {}) {
  const out = {}
  const str = (k, max, min = 0) => {
    if (b[k] === undefined) return
    if (typeof b[k] !== 'string' || b[k].trim().length < min || b[k].length > max) throw err(400, `${k}: ${min ? `${min}–` : 'up to '}${max} chars`)
    out[k] = k === 'title' ? b[k].trim() : b[k]
  }
  str('title', 200, 1)
  if (create && !out.title) throw err(400, 'title required')
  str('body', 20_000)
  if (b.type !== undefined && !TYPES.includes(b.type)) throw err(400, `type: ${TYPES.join('|')}`)
  if (b.type !== undefined) out.type = b.type
  if (b.size !== undefined && b.size !== null && !SIZES.includes(b.size)) throw err(400, `size: ${SIZES.join('|')}`)
  if (b.size !== undefined) out.size = b.size
  if (b.priority !== undefined && !(Number.isInteger(b.priority) && b.priority >= 0 && b.priority <= 4)) throw err(400, 'priority: 0-4')
  if (b.priority !== undefined) out.priority = b.priority
  if (b.column !== undefined && !COLUMNS.includes(b.column)) throw err(400, `column: ${COLUMNS.join('|')}`)
  if (b.column !== undefined) out.column = b.column
  if (b.labels !== undefined) {
    if (!Array.isArray(b.labels) || b.labels.length > 20 || !b.labels.every((l) => typeof l === 'string' && l.length && l.length <= 40)) throw err(400, 'labels: up to 20, each 1–40 chars')
    out.labels = b.labels
  }
  if (b.links !== undefined) {
    if (!Array.isArray(b.links) || b.links.length > 20 || !b.links.every((l) => typeof l === 'string' && /^https?:\/\/\S+$/.test(l) && l.length <= 2000)) throw err(400, 'links: up to 20 http(s) URLs')
    out.links = b.links
  }
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 20_000)) throw err(400, 'note: up to 20000 chars')
  if (b.note !== undefined) out.note = b.note
  return out
}

export class Tickets {
  // reserved: keys owned by Linear (PROJECT_BY_TEAM), never given to a board.
  constructor({ dir, reserved = [], log = console.error }) {
    Object.assign(this, { file: join(dir, 'wt.db'), reserved: new Set(reserved), log })
  }
  get db() { return open(this.file, { log: this.log }) } // lazy: server.mjs is imported by tests
  // { project: key } for every board.
  async keys() {
    return Object.fromEntries(this.db.prepare('SELECT project, key FROM boards').all().map((r) => [r.project, r.key]))
  }
  // Existing board, or a new one whose key is picked in the same transaction.
  async board(project) {
    if (!PROJECT.test(project ?? '')) throw err(400, 'project required')
    return tx(this.db, () => {
      const have = this.db.prepare('SELECT key, next FROM boards WHERE project = ?').get(project)
      if (have) return { ...have }
      const taken = new Set([...this.reserved, ...this.db.prepare('SELECT key FROM boards').all().map((r) => r.key)])
      const b = { key: deriveKey(project, taken), next: 1 }
      this.db.prepare('INSERT INTO boards (project, key, next) VALUES (?, ?, ?)').run(project, b.key, b.next)
      return b
    })
  }
  // A read never creates a board (a typo'd project must not take a key); the first create does.
  async list(project, column) {
    if (!PROJECT.test(project ?? '')) throw err(400, 'project required')
    const key = this.db.prepare('SELECT key FROM boards WHERE project = ?').get(project)?.key ?? null
    const tickets = this.db.prepare('SELECT json FROM tickets WHERE project = ? ORDER BY seq').all(project).map((r) => JSON.parse(r.json))
    return { key, tickets: column ? tickets.filter((t) => t.column === column) : tickets }
  }
  row(id) {
    const r = this.db.prepare('SELECT json FROM tickets WHERE id = ?').get(String(id).toUpperCase())
    if (!r) throw err(404, `no ticket ${id}`)
    return JSON.parse(r.json)
  }
  async get(id) { return this.row(id) }
  async create(project, body, author) {
    const f = clean(body, { create: true })
    await this.board(project)
    return tx(this.db, () => {
      const b = this.db.prepare('SELECT key, next FROM boards WHERE project = ?').get(project)
      const at = new Date().toISOString()
      const t = { id: `${b.key}-${b.next}`, title: f.title, body: f.body ?? '', type: f.type ?? 'feature', size: f.size ?? null,
        priority: f.priority ?? 0, labels: f.labels ?? [], links: f.links ?? [], column: f.column ?? 'backlog', assignee: null,
        created: at, updated: at, history: [{ at, author: author.name, kind: 'create', to: f.column ?? 'backlog' }] }
      this.db.prepare('INSERT INTO tickets (id, project, seq, json) VALUES (?, ?, ?, ?)').run(t.id, project, b.next, JSON.stringify(t))
      this.db.prepare('UPDATE boards SET next = ? WHERE project = ?').run(b.next + 1, project)
      return t
    })
  }
  // fn(ticket, at) → mutated copy; read, apply and write in one transaction.
  async mutate(id, fn) {
    return tx(this.db, () => {
      const old = this.row(id)
      const at = new Date().toISOString()
      const t = fn(structuredClone(old), at)
      if (JSON.stringify(t) === JSON.stringify(old)) return t // no-op: no write, no updated bump
      t.updated = at
      this.db.prepare('UPDATE tickets SET json = ? WHERE id = ?').run(JSON.stringify(t), old.id)
      return t
    })
  }
  // assignee: already resolved by the caller ({name,pane} | null) or undefined.
  async patch(id, body, author, assignee) {
    const f = clean(body)
    return this.mutate(id, (t, at) => {
      const { column, note, ...rest } = f
      if (column && column !== t.column) {
        if (column === 'blocked' && !note?.trim()) throw err(400, 'moving to blocked needs a note (the reason)')
        t.history.push({ at, author: author.name, kind: 'move', from: t.column, to: column, ...(note ? { text: note } : {}) })
        t.column = column
      } else if (note?.trim()) t.history.push({ at, author: author.name, kind: 'comment', text: note })
      const edited = Object.keys(rest).filter((k) => JSON.stringify(t[k]) !== JSON.stringify(rest[k]))
      if (edited.length) t.history.push({ at, author: author.name, kind: 'edit', text: edited.join(', ') })
      Object.assign(t, rest)
      if (assignee !== undefined && assignee?.name !== t.assignee?.name) {
        t.history.push({ at, author: author.name, kind: 'assign', from: t.assignee?.name ?? null, to: assignee?.name ?? null })
        t.assignee = assignee
      }
      return t
    })
  }
  async comment(id, text, author) {
    if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw err(400, 'text: 1–20000 chars')
    return this.mutate(id, (t, at) => (t.history.push({ at, author: author.name, kind: 'comment', text }), t))
  }
  async claim(id, who, force = false) {
    return this.mutate(id, (t, at) => {
      if (t.assignee && t.assignee.name !== who.name && !force) throw err(409, `${t.id} is held by ${t.assignee.name} (use force)`)
      if (t.assignee?.name !== who.name) t.history.push({ at, author: who.name, kind: 'assign', from: t.assignee?.name ?? null, to: who.name })
      t.assignee = who
      return t
    })
  }
}

// `WP-12 [ready] (bug,M,P2) title @assignee`; priority is Linear's scale, 0 = none (omitted), 1 urgent … 4 low.
export const ticketRow = (t) => `${t.id} [${t.column}] (${[t.type, t.size, t.priority && `P${t.priority}`].filter(Boolean).join(',')}) ${t.title}${t.assignee ? ` @${t.assignee.name}` : ''}`
export const ticketText = (t) => [ticketRow(t), ...(t.links.length ? [t.links.join(' ')] : []), '', t.body, '',
  ...t.history.map((h) => `[${h.at.slice(0, 16).replace('T', ' ')}] ${h.author} ${h.kind}${h.from !== undefined || h.to !== undefined ? ` ${h.from ?? '—'} → ${h.to ?? '—'}` : ''}${h.text ? `: ${h.text}` : ''}`)].join('\n') + '\n'
