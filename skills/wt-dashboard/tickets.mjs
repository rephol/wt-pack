// Local ticket boards in DATA/wt.db (store.mjs): boards { project, key, next } and one row per ticket. Ids are <KEY>-N.
// The server is the only writer (the wt-ticket CLI goes through the API); each change is one transaction.
import { join } from 'node:path'
import { open, tx } from './store.mjs'

import { COLUMNS, TYPES, SIZES } from './contracts.mjs' // WP-254: the enums live in contracts.mjs
export { COLUMNS, TYPES, SIZES }
const DEFAULTS = { type: 'feature', size: null, priority: 0 } // create()'s defaults; Jev only fills these
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
  // WP-238: the team that owns the ticket (set by Dispatch on first assign; null = none). Same name shape as teams.
  if (b.team !== undefined && b.team !== null && !(typeof b.team === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(b.team))) throw err(400, 'team: a team name or null')
  if (b.team !== undefined) out.team = b.team
  // WP-147: { worker: {name,pane}, buddy: {name,pane,role} } | null — a paired ticket's worker + buddy.
  if (b.pair !== undefined) {
    const person = (x) => x === null || x === undefined || (typeof x.name === 'string' && typeof x.pane === 'string')
    const buddy = (x) => person(x) && (x == null || typeof x.role === 'string')
    if (b.pair !== null && !(person(b.pair.worker) && buddy(b.pair.buddy)))
      throw err(400, 'pair: {worker:{name,pane}|null, buddy:{name,pane,role}|null} or null')
    out.pair = b.pair
  }
  return out
}

// WP-90 board search. Kept in step with web/src/boardData.ts ticketMatches (parity test in boardData.test.ts).
// History contributes comments and move notes only: edit/assign text is field names, and authors never match.
export function ticketMatches(t, q) {
  const terms = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const notes = (t.history ?? []).filter((h) => (h.kind === 'comment' || h.kind === 'move') && h.text).map((h) => h.text)
  const hay = [t.id, t.title, t.body ?? '', (t.labels ?? []).join(' '), ...notes].join('\n').toLowerCase()
  return terms.every((w) => hay.includes(w))
}

export class Tickets {
  // reserved: keys owned by Linear (PROJECT_BY_TEAM), never given to a board.
  // onReady(project, ticket): a ticket entered Ready (created there or moved in, by anyone).
  // onDone(project, ticket): a ticket entered Done (merge reconcile or a manual move), by anyone.
  // onReopen(project, ticket): a Done ticket left Done (reopened), by anyone.
  // onChange(project): any write to a board or its tickets (WP-253's change stream).
  constructor({ dir, reserved = [], log = console.error, onReady = () => {}, onDone = () => {}, onReopen = () => {}, onChange = () => {} }) {
    Object.assign(this, { file: join(dir, 'wt.db'), reserved: new Set(reserved), log, onReady, onDone, onReopen, onChange })
  }
  // Board 'Auto' (WP-39): Jev may promote Backlog → Ready. Off for a board that does not exist yet.
  async auto(project) { return (await this.settings(project)).auto }
  // { auto, minPriority, dispatch, stallMin } — minPriority: the lowest priority 'Auto' promotes (1 urgent … 4 low, 0 = any);
  // dispatch (WP-52): hand Ready tickets to free agents; stallMin: idle minutes before reconcile flags a card;
  // reportRoom (WP-75): where dispatched work posts its result — null = the project room, '' = none, else a slug;
  // reportOrch: also tell the project's orchestrator.
  async settings(project) {
    const r = this.db.prepare('SELECT auto, min_priority, dispatch, stall_min, report_room, report_orch FROM boards WHERE project = ?').get(project)
    return { auto: !!r?.auto, minPriority: r?.min_priority ?? 2, dispatch: !!r?.dispatch, stallMin: r?.stall_min ?? 45, reportRoom: r?.report_room ?? null, reportOrch: r ? !!r.report_orch : true }
  }
  // Only the fields given change; never creates a board.
  async setSettings(project, { auto, minPriority, dispatch, stallMin, reportRoom, reportOrch }) {
    if (!this.db.prepare('SELECT 1 FROM boards WHERE project = ?').get(project ?? '')) throw err(404, `no board ${project}`)
    if (minPriority !== undefined && !(Number.isInteger(minPriority) && minPriority >= 0 && minPriority <= 4)) throw err(400, 'minPriority: 0-4')
    if (stallMin !== undefined && !(Number.isInteger(stallMin) && stallMin >= 1 && stallMin <= 1440)) throw err(400, 'stallMin: 1-1440')
    if (reportRoom !== undefined && !(reportRoom === null || (typeof reportRoom === 'string' && reportRoom.length <= 64))) throw err(400, 'reportRoom: null, \'\' or a room slug (≤64)')
    if (auto !== undefined) this.db.prepare('UPDATE boards SET auto = ? WHERE project = ?').run(auto ? 1 : 0, project)
    if (minPriority !== undefined) this.db.prepare('UPDATE boards SET min_priority = ? WHERE project = ?').run(minPriority, project)
    if (dispatch !== undefined) this.db.prepare('UPDATE boards SET dispatch = ? WHERE project = ?').run(dispatch ? 1 : 0, project)
    if (stallMin !== undefined) this.db.prepare('UPDATE boards SET stall_min = ? WHERE project = ?').run(stallMin, project)
    if (reportRoom !== undefined) this.db.prepare('UPDATE boards SET report_room = ? WHERE project = ?').run(reportRoom, project)
    if (reportOrch !== undefined) this.db.prepare('UPDATE boards SET report_orch = ? WHERE project = ?').run(reportOrch ? 1 : 0, project)
    this.changed(project)
    return this.settings(project)
  }
  async setAuto(project, on) { return (await this.setSettings(project, { auto: on })).auto }
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
  // q (WP-90): ticketMatches — every whitespace-separated term somewhere in id/title/body/labels/comments.
  async list(project, column, q = '') {
    if (!PROJECT.test(project ?? '')) throw err(400, 'project required')
    if (column && !COLUMNS.includes(column)) throw err(400, `column: ${COLUMNS.join('|')}`)
    const key = this.db.prepare('SELECT key FROM boards WHERE project = ?').get(project)?.key ?? null
    const tickets = this.db.prepare('SELECT json FROM tickets WHERE project = ? ORDER BY seq').all(project).map((r) => JSON.parse(r.json))
    // ponytail: JS filter over the parsed rows (92 tickets today); FTS5 if a board grows to thousands.
    return { key, ...(await this.settings(project)), tickets: tickets.filter((t) => (!column || t.column === column) && ticketMatches(t, q)) }
  }
  row(id) {
    const r = this.db.prepare('SELECT json FROM tickets WHERE id = ?').get(String(id).toUpperCase())
    if (!r) throw err(404, `no ticket ${id}`)
    return JSON.parse(r.json)
  }
  async get(id) { return this.row(id) }
  async project(id) { return this.db.prepare('SELECT project FROM tickets WHERE id = ?').get(String(id).toUpperCase())?.project ?? null }
  async create(project, body, author) {
    const f = clean(body, { create: true })
    await this.board(project)
    const t = tx(this.db, () => {
      const b = this.db.prepare('SELECT key, next FROM boards WHERE project = ?').get(project)
      const at = new Date().toISOString()
      const t = { id: `${b.key}-${b.next}`, title: f.title, body: f.body ?? '', type: f.type ?? 'feature', size: f.size ?? null,
        priority: f.priority ?? 0, labels: f.labels ?? [], links: f.links ?? [], column: f.column ?? 'backlog', assignee: null,
        created: at, updated: at, history: [{ at, author: author.name, kind: 'create', to: f.column ?? 'backlog' }] }
      this.db.prepare('INSERT INTO tickets (id, project, seq, json) VALUES (?, ?, ?, ?)').run(t.id, project, b.next, JSON.stringify(t))
      this.db.prepare('UPDATE boards SET next = ? WHERE project = ?').run(b.next + 1, project)
      return t
    })
    this.changed(project)
    if (t.column === 'ready') this.ready(project, t)
    return t
  }
  // fn(ticket, at) → mutated copy; read, apply and write in one transaction.
  async mutate(id, fn) {
    let entered = false, finished = false, reopened = false, wrote = false
    const t = tx(this.db, () => {
      const old = this.row(id)
      const at = new Date().toISOString()
      const t = fn(structuredClone(old), at)
      if (JSON.stringify(t) === JSON.stringify(old)) return t // no-op: no write, no updated bump
      t.updated = at
      this.db.prepare('UPDATE tickets SET json = ? WHERE id = ?').run(JSON.stringify(t), old.id)
      wrote = true
      if (t.column === 'ready' && old.column !== 'ready') entered = true
      if (t.column === 'done' && old.column !== 'done') finished = true
      if (t.column !== 'done' && old.column === 'done') reopened = true
      return t
    })
    if (wrote) this.changed(await this.project(t.id))
    if (entered) this.ready(await this.project(t.id), t)
    if (finished) this.done(await this.project(t.id), t)
    if (reopened) this.reopen(await this.project(t.id), t)
    return t
  }
  changed(project) { try { this.onChange(project) } catch (e) { this.log('tickets onChange:', e.message) } }
  ready(project, t) { try { this.onReady(project, t) } catch (e) { this.log('tickets onReady:', e.message) } }
  done(project, t) { try { this.onDone(project, t) } catch (e) { this.log('tickets onDone:', e.message) } }
  reopen(project, t) { try { this.onReopen(project, t) } catch (e) { this.log('tickets onReopen:', e.message) } }
  // assignee: already resolved by the caller ({name,pane} | null) or undefined.
  async patch(id, body, author, assignee) {
    const f = clean(body)
    return this.mutate(id, (t, at) => {
      // Back to Backlog: nobody holds it any more, unless the same call names one (WP-49).
      if (f.column === 'backlog' && t.column !== 'backlog' && assignee === undefined) assignee = null
      const { column, note, pair, ...rest } = f
      if (column === 'ready' && t.column !== 'ready' && assignee === undefined) assignee = null // WP-225: back in the queue, nobody holds it
      if (column && column !== t.column) {
        if (column === 'blocked' && !note?.trim()) throw err(400, 'moving to blocked needs a note (the reason)')
        t.history.push({ at, author: author.name, kind: 'move', from: t.column, to: column, ...(note ? { text: note } : {}) })
        t.column = column
        delete t.jev?.applied?.column // moved by hand: no longer Jev's promotion to undo
        if (column === 'ready' || column === 'backlog') delete t.dispatch // back in the queue: dispatch starts over (held too)
      } else if (note?.trim()) t.history.push({ at, author: author.name, kind: 'comment', text: note })
      const edited = Object.keys(rest).filter((k) => JSON.stringify(t[k]) !== JSON.stringify(rest[k]))
      if (edited.length) t.history.push({ at, author: author.name, kind: 'edit', text: edited.join(', ') })
      Object.assign(t, rest)
      for (const k of edited) delete t.jev?.applied?.[k] // the user's value now, not Jev's
      if (assignee !== undefined && assignee?.name !== t.assignee?.name) {
        t.history.push({ at, author: author.name, kind: 'assign', from: t.assignee?.name ?? null, to: assignee?.name ?? null })
        t.assignee = assignee
      }
      if (pair !== undefined && JSON.stringify(pair) !== JSON.stringify(t.pair ?? null)) {
        t.history.push({ at, author: author.name, kind: 'pair', from: t.pair ?? null, to: pair })
        t.pair = pair
      }
      return t
    })
  }
  // Jev's triage (ticketJev.mjs): fill each field in `empty` that is still at its create default and was never
  // edited since; record what changed so the UI can offer undo. d = { type, size, priority, owner, dupes }.
  async jevApply(id, d, empty) {
    return this.mutate(id, (t, at) => {
      const edited = new Set(t.history.filter((h) => h.kind === 'edit' && h.author !== 'jev').flatMap((h) => h.text?.split(', ') ?? []))
      const applied = {}
      for (const k of empty) {
        if (d[k] == null || edited.has(k) || t[k] !== DEFAULTS[k] || d[k] === t[k]) continue
        applied[k] = { from: t[k], to: d[k] }
        t[k] = d[k]
      }
      const labels = t.labels ?? []
      if (d.owner === 'planner' && !edited.has('labels') && !labels.includes('needs-plan')) { // Dispatch routes it to a planner
        applied.labels = { from: labels, to: [...labels, 'needs-plan'] }
        t.labels = applied.labels.to
      }
      t.jev = { at, applied: { ...t.jev?.applied, ...applied }, owner: d.owner ?? null, dupes: d.dupes ?? [] }
      if (Object.keys(applied).length) t.history.push({ at, author: 'jev', kind: 'edit', text: `jev: ${Object.keys(applied).join(', ')}` })
      return t
    })
  }
  // Board 'Auto': Backlog → Ready with Jev's p in the history note; undone like a field (jevUndo 'column').
  async jevPromote(id, p) {
    return this.mutate(id, (t, at) => {
      if (t.column !== 'backlog') return t
      t.history.push({ at, author: 'jev', kind: 'move', from: 'backlog', to: 'ready', text: `Jev auto-promoted (p=${p.toFixed(2)})` })
      t.column = 'ready'
      t.jev = { ...t.jev, applied: { ...t.jev?.applied, column: { from: 'backlog', to: 'ready' } } }
      return t
    })
  }
  async jevUndo(id, field, author) {
    return this.mutate(id, (t, at) => {
      const a = (Object.hasOwn(DEFAULTS, field) || field === 'column' || field === 'labels') && Object.hasOwn(t.jev?.applied ?? {}, field) ? t.jev.applied[field] : null
      if (!a) throw err(400, `no Jev suggestion on ${field}`)
      if (field === 'column') t.history.push({ at, author: author.name, kind: 'move', from: t.column, to: a.from, text: 'undo Jev auto-promote' })
      else t.history.push({ at, author: author.name, kind: 'edit', text: field })
      t[field] = a.from
      delete t.jev.applied[field]
      return t
    })
  }
  async comment(id, text, author) {
    if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw err(400, 'text: 1–20000 chars')
    return this.mutate(id, (t, at) => (t.history.push({ at, author: author.name, kind: 'comment', text }), t))
  }
  // Dispatch's compare-and-set (WP-52): claims an unassigned Ready ticket, or one whose last dispatch failed over
  // 2 min ago; null when anyone else holds it. The lock is on the row, so it survives a restart.
  async dispatchClaim(id, now = Date.now()) {
    let won = false
    const t = await this.mutate(id, (t, at) => {
      const d = t.dispatch
      if (t.column !== 'ready' || t.assignee || (d && !(d.state === 'failed' && now - Date.parse(d.at) > 120_000))) return t
      won = true
      t.dispatch = { state: 'dispatching', at, ...(d?.fails ? { fails: d.fails } : {}) }
      return t
    })
    return won ? t : null
  }
  // obj | null (null = clear, the Retry dispatch action).
  async setDispatch(id, d) {
    return this.mutate(id, (t) => { if (d) t.dispatch = d; else delete t.dispatch; return t })
  }
  // Retry dispatch: clears only a failure, a hold, a restart interruption (WP-252) or a lone stall flag, never a claim in flight or a sent card.
  async dispatchRetry(id) {
    return this.mutate(id, (t) => {
      const d = t.dispatch
      if (d && !['failed', 'held', 'interrupted'].includes(d.state) && d.state !== undefined) throw err(409, `${t.id} dispatch is ${d.state}`)
      delete t.dispatch
      return t
    })
  }
  async claim(id, who, force = false) {
    return this.mutate(id, (t, at) => {
      if (t.assignee && t.assignee.name !== who.name && !force) throw err(409, `${t.id} is held by ${t.assignee.name} (use force)`)
      if (t.dispatch?.state === 'dispatching' && !force) throw err(409, `${t.id} is being dispatched (use force)`)
      if (t.assignee?.name !== who.name) t.history.push({ at, author: who.name, kind: 'assign', from: t.assignee?.name ?? null, to: who.name })
      t.assignee = who
      return t
    })
  }
  // Shared by leave() (agents.sh rm) and dispatch.mjs's reconcile (slower 'gone' debounce, WP-140): drops
  // `name` as assignee of card `id` if it still holds it. Only unassigns (WP-225): the column is the agent's to
  // move, so a Ready card is simply free again; `text` stays in the history as the routing "returned" strike.
  async dropAssignee(id, name, author, text) {
    return this.mutate(id, (t, at) => {
      if (t.assignee?.name !== name) return t
      delete t.dispatch
      t.history.push({ at, author, kind: 'assign', from: name, to: null }, ...(text ? [{ at, author, kind: 'comment', text }] : []))
      t.assignee = null
      return t
    })
  }
  // WP-140: an agent removed (agents.sh rm) unassigns from every open card it still held, across every
  // project, mirroring rooms.leave.
  async leave(name) {
    for (const { id, json } of this.db.prepare('SELECT id, json FROM tickets').all()) {
      const t = JSON.parse(json)
      if (t.assignee?.name !== name || t.column === 'done') continue
      await this.dropAssignee(id, name, 'wt-dashboard', `returned: ${name} was removed`)
    }
  }
}

// `WP-12 [ready] (bug,M,P2) title @assignee`; priority is Linear's scale, 0 = none (omitted), 1 urgent … 4 low.
export const ticketRow = (t) => `${t.id} [${t.column}] (${[t.type, t.size, t.priority && `P${t.priority}`].filter(Boolean).join(',')}) ${t.title}${t.assignee ? ` @${t.assignee.name}` : ''}`
export const ticketText = (t) => [ticketRow(t), ...(t.links.length ? [t.links.join(' ')] : []), '', t.body, '',
  ...t.history.map((h) => `[${h.at.slice(0, 16).replace('T', ' ')}] ${h.author} ${h.kind}${h.from !== undefined || h.to !== undefined ? ` ${h.from ?? '—'} → ${h.to ?? '—'}` : ''}${h.text ? `: ${h.text}` : ''}`)].join('\n') + '\n'
