// WP-210: a per-pane queue of wt-pack traffic (wt-message / room-message text) that the pane's wt-deliver-mod pulls
// and submits as a plugin-origin prompt, instead of the server pasting keystrokes into the TUI. A pane is "live" while
// its mod's hello is fresh; otherwise callers paste as before. Status: queued → delivered | pasted | failed.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { open } from './store.mjs'

const err = (status, m) => Object.assign(new Error(m), { status })
export const LIVE_MS = 45_000 // the mod says hello every 20 s
const STATUS = ['queued', 'delivered', 'pasted', 'failed']

export class Deliveries {
  constructor({ dir, log = console.error, now = Date.now } = {}) {
    Object.assign(this, { file: join(dir, 'wt.db'), log, now, hellos: new Map() })
  }
  get db() { return open(this.file, { log: this.log }) }
  hello(pane) { this.hellos.set(pane, this.now()) }
  live(pane) { return this.now() - (this.hellos.get(pane) ?? -Infinity) < LIVE_MS }
  enqueue(pane, body) {
    if (typeof body !== 'string' || !body.trim() || body.length > 100_000) throw err(400, 'text: 1-100000 chars')
    const row = { id: randomUUID(), pane, kind: body.match(/<wt-message [^>]*\bkind=(\w+)/)?.[1] ?? (body.includes('<room-message') ? 'room' : 'text'),
      body, status: 'queued', created: new Date(this.now()).toISOString(), delivered_at: null }
    this.db.prepare('INSERT INTO deliveries (id, pane, kind, body, status, created) VALUES (?, ?, ?, ?, ?, ?)').run(row.id, pane, row.kind, body, row.status, row.created)
    return row
  }
  // The oldest queued row for this pane. Not claimed: it stays queued until acked, so a crashed mod re-pulls it.
  next(pane) { return this.db.prepare("SELECT * FROM deliveries WHERE pane = ? AND status = 'queued' ORDER BY seq LIMIT 1").get(pane) ?? null }
  // Only the owning pane acks, and only a queued row (the first ack wins).
  ack(id, pane, status = 'delivered') {
    if (!STATUS.includes(status) || status === 'queued') throw err(400, `status: ${STATUS.slice(1).join('|')}`)
    const r = this.db.prepare('SELECT pane FROM deliveries WHERE id = ?').get(id)
    if (!r) throw err(404, `no delivery ${id}`)
    if (r.pane !== pane) throw err(403, `${id} is not queued for ${pane}`)
    const at = new Date(this.now()).toISOString()
    if (!this.db.prepare("UPDATE deliveries SET status = ?, delivered_at = ? WHERE id = ? AND status = 'queued'").run(status, at, id).changes) throw err(409, `${id} is no longer queued`)
    return { id, status, delivered_at: at }
  }
  // Queued rows whose pane's mod went quiet: the caller pastes them and calls ack(…, 'pasted') / ('failed').
  stranded(graceMs = LIVE_MS) {
    const cut = new Date(this.now() - graceMs).toISOString()
    return this.db.prepare("SELECT * FROM deliveries WHERE status = 'queued' AND created < ? ORDER BY seq").all(cut).filter((r) => !this.live(r.pane))
  }
  // Server-side status flip (the paste path owns the row once the mod is gone).
  settle(id, status) {
    this.db.prepare("UPDATE deliveries SET status = ?, delivered_at = ? WHERE id = ? AND status = 'queued'").run(status, new Date(this.now()).toISOString(), id)
  }
  list(pane, limit = 50) {
    return this.db.prepare(`SELECT id, pane, kind, status, created, delivered_at FROM deliveries ${pane ? 'WHERE pane = ?' : ''} ORDER BY seq DESC LIMIT ${Number(limit) | 0 || 50}`).all(...(pane ? [pane] : []))
  }
}
