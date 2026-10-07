// WP-273: pins (shared, one list per chat) and bookmarks (the user's own Saved list across every chat) on messages in room
// chats and agent Conversation tabs. A chat is 'room:<slug>' or 'agent:<session id>'; a message is its id there (agent
// messages come from the transcript: `<entry uuid>:<block>`). Each row keeps a text snapshot, so it outlives a pruned
// transcript or archived room. Pins are data for the UI and `room read`'s [pinned] mark only: nothing here ever builds a
// prompt, a delivery or a wt-message, so a pinned text can never reach an agent as an instruction.
import { open } from './store.mjs'

const err = (status, m) => Object.assign(new Error(m), { status })
const CHAT = /^(room|agent):[\w.:/-]{1,120}$/
export const SNAPSHOT = 600
const str = (v, n, what, req = true) => {
  if (v === undefined || v === null || v === '') { if (req) throw err(400, `${what} is required`); return '' }
  if (typeof v !== 'string' || v.length > n) throw err(400, `${what}: a string up to ${n} chars`)
  return v
}

// The row both tables share, validated at the boundary.
export function clean(b) {
  const chat = str(b?.chat, 130, 'chat')
  if (!CHAT.test(chat)) throw err(400, "chat: 'room:<slug>' or 'agent:<session>'")
  const text = String(b.text ?? '').replace(/\s+$/, '')
  return { chat, msg: str(b.msg, 120, 'msg'), author: str(b.author, 80, 'author', false) || 'unknown', text: text.length > SNAPSHOT ? `${text.slice(0, SNAPSHOT)}…` : text }
}

export class Pins {
  constructor(dir, { now = () => new Date().toISOString() } = {}) {
    this.db = open(`${dir}/wt.db`)
    this.now = now
  }
  // ---- pins (newest first) ----
  pins(chat) { return this.db.prepare('SELECT chat, msg, author, text, pinned_by AS pinnedBy, at FROM pins WHERE chat = ? ORDER BY at DESC, rowid DESC').all(str(chat, 130, 'chat')) }
  pinnedIds(chat) { return new Set(this.db.prepare('SELECT msg FROM pins WHERE chat = ?').all(chat).map((r) => r.msg)) }
  pin(b, by) {
    const r = clean(b)
    this.db.prepare('INSERT INTO pins (chat, msg, author, text, pinned_by, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (chat, msg) DO NOTHING').run(r.chat, r.msg, r.author, r.text, by, this.now())
    return r.chat
  }
  unpin(chat, msg) { return this.db.prepare('DELETE FROM pins WHERE chat = ? AND msg = ?').run(str(chat, 130, 'chat'), str(msg, 120, 'msg')).changes > 0 }
  // ---- bookmarks (grouped by chat in the UI; newest first here) ----
  // `label` is the chat's display name, `open` the hash route that opens it ('rooms/<slug>' | 'agents/<machine>/<pane>').
  saved(q = '') {
    const needle = `%${String(q).toLowerCase().replace(/[\\%_]/g, '\\$&')}%`
    return this.db.prepare(`SELECT chat, msg, author, text, label, open, at FROM bookmarks
      WHERE lower(text) LIKE ? ESCAPE '\\' OR lower(label) LIKE ? ESCAPE '\\' OR lower(author) LIKE ? ESCAPE '\\' ORDER BY at DESC, rowid DESC`).all(needle, needle, needle)
  }
  bookmarkIds() { return this.db.prepare('SELECT chat, msg FROM bookmarks').all() }
  bookmark(b) {
    const r = clean(b), label = str(b.label, 80, 'label', false) || r.chat, hash = str(b.open, 200, 'open', false)
    if (hash && !/^(rooms|agents)\/[^\s#?]+$/.test(hash)) throw err(400, 'open: rooms/<slug> or agents/<machine>/<pane>')
    this.db.prepare('INSERT INTO bookmarks (chat, msg, author, text, label, open, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (chat, msg) DO NOTHING').run(r.chat, r.msg, r.author, r.text, label, hash, this.now())
    return r.chat
  }
  unbookmark(chat, msg) { return this.db.prepare('DELETE FROM bookmarks WHERE chat = ? AND msg = ?').run(str(chat, 130, 'chat'), str(msg, 120, 'msg')).changes > 0 }
}
