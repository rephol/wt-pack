// WP-257: one envelope record for every wt-pack message (handoff, dispatch, routine, reply, system, room, ask),
// in wt.db table wt_messages, behind the existing delivery paths (they keep working; each also writes here).
// State: queued → delivered → acknowledged → answered; expired (no ack in time) → queued again on a resend, or
// failed. `request_id` (WP-251) is unique: recording the same id twice returns the first row and sends nothing.
// Expiry: a kind that expects an ack (handoff/dispatch/routine) not acked within `ackMs` is resent with the same
// envelope id up to `maxAttempts` times, then flagged (state expired, Inbox item). Not exported: no JSON rollback.
import { join } from 'node:path'
import { open } from './store.mjs'

const err = (status, m) => Object.assign(new Error(m), { status })
export const STATES = ['queued', 'delivered', 'acknowledged', 'answered', 'expired', 'failed']
export const NEXT = {
  queued: ['delivered', 'failed', 'expired'], delivered: ['acknowledged', 'answered', 'expired', 'failed'],
  acknowledged: ['answered', 'expired'], answered: [], expired: ['queued', 'delivered', 'failed'], failed: ['queued', 'delivered'],
}
export const ACK_KINDS = new Set(['handoff', 'dispatch', 'routine'])
export const ACK_MS = 5 * 60_000
export const MAX_ATTEMPTS = 3
const OPEN = ['queued', 'delivered']

// Envelope fields of a `<wt-message id=… kind=… from="…" [ticket=…]>` (after a slash command), or null.
export function parseEnvelope(text) {
  const m = String(text).match(/^(?:\/\S+ )*<wt-message id=([\w-]+) kind=(\w+) from="([^"]*)"(?: ticket=([A-Z]+-\d+))?/)
  return m ? { id: m[1], kind: m[2], sender: m[3], ticket: m[4] ?? null } : null
}

// A room delivery `<room-message id=… room=… from="…" kind=…>` (context-only tags are not messages).
const roomTag = (t) => { const m = String(t).match(/^<room-message id=([\w-]+) room=\S+ from="([^"]*)" kind=(\w+)/); return m && m[3] !== 'context' ? { id: m[1], kind: 'room', sender: m[2], ticket: null } : null }
export const envelopeOf = (text) => parseEnvelope(text) ?? roomTag(text)

export class Messages {
  constructor({ dir, log = console.error, now = Date.now } = {}) {
    Object.assign(this, { file: join(dir, 'wt.db'), log, now })
  }
  get db() { return open(this.file, { log: this.log }) }
  #at() { return new Date(this.now()).toISOString() }
  get(id) { return this.db.prepare('SELECT * FROM wt_messages WHERE id = ?').get(id) ?? null }

  // → { row, duplicate }. A known id or request_id returns the existing row untouched.
  record({ id, sender, target, kind, ticket = null, requestId = null, body, state = 'queued' }) {
    if (!id || !target || !kind || typeof body !== 'string') throw err(400, 'id, target, kind, body required')
    if (!STATES.includes(state)) throw err(400, `state: ${STATES.join('|')}`)
    const dup = this.get(id) ?? (requestId ? this.db.prepare('SELECT * FROM wt_messages WHERE request_id = ?').get(requestId) : null)
    if (dup) return { row: dup, duplicate: true }
    const at = this.#at()
    this.db.prepare(`INSERT INTO wt_messages (id, sender, target, kind, ticket, request_id, body, state, created, updated, delivered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, String(sender ?? ''), target, kind, ticket, requestId, body.slice(0, 100_000), state, at, at, state === 'delivered' ? at : null)
    return { row: this.get(id), duplicate: false }
  }

  // The one state writer: illegal moves are a 409, a repeat of the current state is a no-op (acks are idempotent).
  move(id, to, extra = {}) {
    const row = this.get(id)
    if (!row) throw err(404, `no message ${id}`)
    if (row.state === to) return row
    if (!NEXT[row.state].includes(to)) throw err(409, `${id}: ${row.state} → ${to} is not allowed`)
    const at = this.#at()
    const stamp = { delivered: 'delivered_at', acknowledged: 'acked_at', answered: 'answered_at' }[to]
    this.db.prepare(`UPDATE wt_messages SET state = ?, updated = ?, error = ?${stamp ? `, ${stamp} = COALESCE(${stamp}, ?)` : ''} WHERE id = ?`)
      .run(...[to, at, extra.error ?? null, ...(stamp ? [at] : []), id])
    return this.get(id)
  }
  // The target acknowledges (or answers) by id; only the addressed pane/name may (`who` null = the server itself).
  ack(id, who, to = 'acknowledged') {
    if (!['acknowledged', 'answered'].includes(to)) throw err(400, 'state: acknowledged|answered')
    const row = this.get(id)
    if (!row) throw err(404, `no message ${id}`)
    if (who && ![row.target].includes(who)) throw err(403, `${id} is not addressed to ${who}`)
    if (row.state === 'answered') return row
    if (row.state === 'acknowledged' && to === 'acknowledged') return row
    if (['queued', 'expired', 'failed'].includes(row.state)) this.move(id, 'delivered') // an ack proves it arrived
    return this.move(id, to)
  }
  // Per-card state for the board: the newest message of each ticket (and how many are still open).
  byTicket(ids) {
    const out = {}
    for (const id of ids) {
      const rows = this.db.prepare('SELECT id, kind, state, attempts, target, updated FROM wt_messages WHERE ticket = ? ORDER BY created DESC, rowid DESC').all(id)
      if (rows.length) out[id] = { last: rows[0], open: rows.filter((r) => OPEN.includes(r.state) || r.state === 'expired').length }
    }
    return out
  }
  list({ ticket, target, limit = 50 } = {}) {
    const w = [ticket && 'ticket = ?', target && 'target = ?'].filter(Boolean)
    return this.db.prepare(`SELECT id, sender, target, kind, ticket, request_id, state, attempts, created, updated FROM wt_messages${w.length ? ` WHERE ${w.join(' AND ')}` : ''} ORDER BY created DESC, rowid DESC LIMIT ?`)
      .all(...[ticket, target].filter(Boolean), Math.min(500, Math.max(1, Number(limit) || 50)))
  }

  // Expiry pass. deps: { seen(row) → bool (the target is demonstrably working on it: counts as an ack),
  // pending(row) → bool (WP-258: still waiting in the target's delivery queue — nothing is lost, so it is neither
  // resent nor counted against its attempts nor flagged), resend(row) → Promise (re-deliver row.body, same envelope id),
  // flag(row) }. Returns what it did.
  async sweep({ seen, pending, resend, flag }, { ackMs = ACK_MS, maxAttempts = MAX_ATTEMPTS } = {}) {
    const done = []
    const cut = new Date(this.now() - ackMs).toISOString()
    const rows = this.db.prepare(`SELECT * FROM wt_messages WHERE state IN ('queued', 'delivered') AND updated < ? ORDER BY created`).all(cut)
    for (const row of rows) {
      if (!ACK_KINDS.has(row.kind)) continue // replies, system notes and room traffic expect no ack
      if (await Promise.resolve(pending?.(row)).catch(() => false)) continue
      if (await Promise.resolve(seen?.(row)).catch(() => false)) { this.ack(row.id, null); done.push({ id: row.id, did: 'acknowledged' }); continue }
      if (row.attempts >= maxAttempts) {
        this.move(row.id, 'expired', { error: `no acknowledgement after ${row.attempts} sends` })
        await Promise.resolve(flag?.(this.get(row.id))).catch((e) => this.log(`messages flag ${row.id}: ${e.message}`))
        done.push({ id: row.id, did: 'expired' }); continue
      }
      try {
        await resend(row)
        this.db.prepare("UPDATE wt_messages SET attempts = attempts + 1, state = 'delivered', updated = ?, error = NULL WHERE id = ?").run(this.#at(), row.id)
        done.push({ id: row.id, did: 'resent' })
      } catch (e) {
        this.db.prepare('UPDATE wt_messages SET attempts = attempts + 1, updated = ?, error = ? WHERE id = ?').run(this.#at(), e.message.slice(0, 200), row.id)
        done.push({ id: row.id, did: 'resend-failed' })
      }
    }
    return done
  }
}
