// WP-273: pure helpers for pins and bookmarks (no React), tested in pinState.test.ts.
export type Pin = { chat: string; msg: string; author: string; text: string; pinnedBy: string; at: string }
export type Saved = { chat: string; msg: string; author: string; text: string; label: string; open: string; at: string }
export type MsgRef = { msg: string; author: string; text: string }
export type ChatRef = { chat: string; label: string; open: string } // open: the hash route that shows the chat

export const roomChat = (slug: string): ChatRef => ({ chat: `room:${slug}`, label: `#${slug}`, open: `rooms/${encodeURIComponent(slug)}` })
// Agent messages are keyed by the transcript's session id, so a /clear (new session) starts a new pin list. Remote or
// session-less agents have no stable id: null, and the message gets no pin/bookmark buttons.
export const agentChat = (a: { key: string; name: string; session: string | null; local: boolean }): ChatRef | null => {
  if (!a.local || !a.session) return null
  const i = a.key.indexOf('/')
  return { chat: `agent:${a.session}`, label: a.name, open: `agents/${encodeURIComponent(a.key.slice(0, i))}/${encodeURIComponent(a.key.slice(i + 1))}` }
}

export const oneLine = (t: string, n = 140) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s }

// Saved rows grouped by chat, groups ordered by their newest bookmark (rows arrive newest first).
export function groupSaved(rows: Saved[]): { chat: string; label: string; open: string; rows: Saved[] }[] {
  const out = new Map<string, { chat: string; label: string; open: string; rows: Saved[] }>()
  for (const r of rows) {
    const g = out.get(r.chat) ?? { chat: r.chat, label: r.label, open: r.open, rows: [] }
    g.rows.push(r)
    out.set(r.chat, g)
  }
  return [...out.values()]
}

// A jump request from the Saved list or a pinned bar to a chat that may not be mounted yet: the chat takes it when it
// shows. Stale after 8 s (a chat that never mounts, or a /clear'd session, must not jump on a later visit).
const JUMP_TTL = 8000
let pending: { chat: string; msg: string; at: number } | null = null
export const requestJump = (chat: string, msg: string, now = Date.now()) => { pending = { chat, msg, at: now } }
export const takeJump = (chat: string, now = Date.now()): string | null => {
  if (!pending || pending.chat !== chat) return null
  const p = pending
  pending = null
  return now - p.at <= JUMP_TTL ? p.msg : null
}
