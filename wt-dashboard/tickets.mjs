// Local ticket boards: one DATA/tickets/<project>.json per project, { key, next, tickets }. Ids are <KEY>-N.
// The server is the only writer (the wt-ticket CLI goes through the API), so an in-process lock is enough.
// ponytail: per-project in-process lock; the server is the only writer.
import { readFile, readdir, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from './rooms.mjs'

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
    Object.assign(this, { dir: join(dir, 'tickets'), reserved: new Set(reserved), log })
    this.locks = new Map()
    this.boards = new Map() // project -> board (cache; the server is the only writer)
  }
  lock(name, fn) {
    const p = (this.locks.get(name) ?? Promise.resolve()).then(fn, fn)
    this.locks.set(name, p.catch(() => {}))
    return p
  }
  file(project) { return join(this.dir, `${project}.json`) }
  async read(project) {
    if (this.boards.has(project)) return this.boards.get(project)
    const raw = await readFile(this.file(project), 'utf8').catch(() => null)
    if (raw === null) return null
    try {
      const b = JSON.parse(raw)
      if (typeof b?.key !== 'string' || !Array.isArray(b.tickets)) throw new Error('bad shape')
      this.boards.set(project, b)
      return b
    } catch (e) {
      const to = `${this.file(project)}.corrupt-${Date.now()}`
      this.log(`tickets/${project}.json unreadable (${e.message}); kept as ${to}`)
      await rename(this.file(project), to).catch(() => {})
      return null
    }
  }
  async save(project, b) {
    await mkdir(this.dir, { recursive: true })
    await atomicWrite(this.file(project), JSON.stringify(b, null, 2))
    this.boards.set(project, b)
  }
  async projects() {
    return (await readdir(this.dir).catch(() => [])).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((p) => PROJECT.test(p))
  }
  // { project: key } for every board on disk.
  async keys() {
    const out = {}
    for (const p of await this.projects()) { const b = await this.read(p); if (b) out[p] = b.key }
    return out
  }
  async projectOf(id) {
    const key = String(id).split('-')[0].toUpperCase()
    const hit = Object.entries(await this.keys()).find(([, k]) => k === key)
    if (!hit) throw err(404, `no board for ${key}`)
    return hit[0]
  }
  // Existing board, or a new one whose key is picked under one global lock.
  board(project) {
    if (!PROJECT.test(project ?? '')) throw err(400, 'project required')
    return this.lock('__keys__', async () => {
      const have = await this.read(project)
      if (have) return have
      const taken = new Set([...this.reserved, ...Object.values(await this.keys())])
      const b = { key: deriveKey(project, taken), next: 1, tickets: [] }
      await this.save(project, b)
      return b
    })
  }
  // A read never creates a board (a typo'd project must not take a key); the first create does.
  async list(project, column) {
    if (!PROJECT.test(project ?? '')) throw err(400, 'project required')
    const b = await this.read(project) ?? { key: null, tickets: [] }
    return { key: b.key, tickets: column ? b.tickets.filter((t) => t.column === column) : b.tickets }
  }
  async get(id) {
    const t = (await this.read(await this.projectOf(id)))?.tickets.find((x) => x.id === String(id).toUpperCase())
    if (!t) throw err(404, `no ticket ${id}`)
    return t
  }
  async create(project, body, author) {
    const f = clean(body, { create: true })
    await this.board(project)
    return this.lock(project, async () => {
      const b = await this.read(project)
      const at = new Date().toISOString()
      const t = { id: `${b.key}-${b.next}`, title: f.title, body: f.body ?? '', type: f.type ?? 'feature', size: f.size ?? null,
        priority: f.priority ?? 0, labels: f.labels ?? [], links: f.links ?? [], column: f.column ?? 'backlog', assignee: null,
        created: at, updated: at, history: [{ at, author: author.name, kind: 'create', to: f.column ?? 'backlog' }] }
      await this.save(project, { ...b, next: b.next + 1, tickets: [...b.tickets, t] })
      return t
    })
  }
  // fn(ticket, at) → mutated copy; runs under the project's lock against the latest file.
  async mutate(id, fn) {
    const project = await this.projectOf(id)
    return this.lock(project, async () => {
      const b = await this.read(project)
      const i = b.tickets.findIndex((x) => x.id === String(id).toUpperCase())
      if (i < 0) throw err(404, `no ticket ${id}`)
      const at = new Date().toISOString()
      const t = fn(structuredClone(b.tickets[i]), at)
      if (JSON.stringify(t) === JSON.stringify(b.tickets[i])) return t // no-op: no write, no updated bump
      t.updated = at
      await this.save(project, { ...b, tickets: b.tickets.with(i, t) })
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

// `WP-12 [ready] (bug,M,P2) title @assignee`
export const ticketRow = (t) => `${t.id} [${t.column}] (${[t.type, t.size, `P${t.priority}`].filter(Boolean).join(',')}) ${t.title}${t.assignee ? ` @${t.assignee.name}` : ''}`
export const ticketText = (t) => [ticketRow(t), ...(t.links.length ? [t.links.join(' ')] : []), '', t.body, '',
  ...t.history.map((h) => `[${h.at.slice(0, 16).replace('T', ' ')}] ${h.author} ${h.kind}${h.from !== undefined || h.to !== undefined ? ` ${h.from ?? '—'} → ${h.to ?? '—'}` : ''}${h.text ? `: ${h.text}` : ''}`)].join('\n') + '\n'
