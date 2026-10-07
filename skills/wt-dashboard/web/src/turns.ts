// Per-message metadata for the agent conversation, derived only from what the transcript stream already carries.
// A turn starts at a user message (source + attachments on it); its assistant summary (model, tokens, duration,
// tool calls, notional cost, abnormal stop) goes on the turn's LAST assistant message.
export interface Usage { mid: string; model?: string; in: number; out: number; cw: number; cr: number; cost: number | null; stop: string | null }
export interface TMsg { id: string; role: string; text: string; ts: string; src?: string; images?: string[]; meta?: Usage; toolUseId?: string; tool?: { name: string; summary?: string }; isError?: boolean }
export interface UserMeta { kind: 'user'; ts: string; src?: string; attachments: number }
export interface TurnMeta { kind: 'turn'; ts: string; model?: string; up: number; cr: number; cw: number; fresh: number; down: number; ms: number; tools: number; cost: number | null; stop?: string }
export type Meta = UserMeta | TurnMeta | { kind: 'plain'; ts: string }

const INTERRUPT = /^\[Request interrupted/
const ms = (a: string, b: string) => Math.max(0, Date.parse(b) - Date.parse(a)) || 0

export function deriveMeta(msgs: TMsg[]): Map<string, Meta> {
  const out = new Map<string, Meta>()
  let turn: TMsg[] = []
  const close = () => {
    const first = turn[0]
    const lastA = turn.findLast((m) => m.role === 'assistant')
    if (lastA) {
      const byMid = new Map<string, Usage>()
      for (const m of turn) if (m.meta) byMid.set(m.meta.mid, m.meta) // the last entry per API message has its final usage
      const us = [...byMid.values()]
      const priced = us.filter((u) => u.cost != null)
      const model = us.findLast((u) => u.model && !u.model.startsWith('<'))?.model
      const stop = turn.some((m) => m.role === 'user' && INTERRUPT.test(m.text)) ? 'interrupted'
        : us.find((u) => u.stop === 'error' || u.stop === 'max_tokens')?.stop
      const end = turn.at(-1)!.ts
      out.set(lastA.id, {
        kind: 'turn', ts: lastA.ts, model, stop: stop ?? undefined,
        up: us.reduce((s, u) => s + u.in + u.cw + u.cr, 0), down: us.reduce((s, u) => s + u.out, 0),
        cr: us.reduce((s, u) => s + u.cr, 0), cw: us.reduce((s, u) => s + u.cw, 0), fresh: us.reduce((s, u) => s + u.in, 0),
        ms: first?.role === 'user' ? ms(first.ts, end) : 0,
        tools: turn.filter((m) => m.role === 'tool' && m.tool?.name !== 'result').length,
        cost: priced.length ? priced.reduce((s, u) => s + u.cost!, 0) : null,
      })
    }
    turn = []
  }
  for (const m of msgs) {
    if (m.role === 'user' && !INTERRUPT.test(m.text)) {
      close()
      out.set(m.id, { kind: 'user', ts: m.ts, src: m.src, attachments: m.images?.length ?? 0 }) // + upload paths in the text, counted by the renderer
    } else if (m.role !== 'tool' && !out.has(m.id)) out.set(m.id, { kind: 'plain', ts: m.ts })
    turn.push(m)
  }
  close()
  return out
}

// A tool group: calls, and the span from the first call to the last result.
export function toolGroupMeta(rows: TMsg[]) {
  const calls = rows.filter((m) => m.tool?.name !== 'result').length
  const ts = rows.map((m) => m.ts).filter(Boolean)
  return { calls, ms: ts.length > 1 ? ms(ts[0], ts.at(-1)!) : 0 }
}
// Each call's own duration: tool_use ts → its result's ts.
export function callDurations(rows: TMsg[]) {
  const start = new Map<string, string>(), out = new Map<string, number>()
  for (const m of rows) {
    if (!m.toolUseId) continue
    if (m.tool?.name === 'result') { const s = start.get(m.toolUseId); if (s) out.set(m.toolUseId, ms(s, m.ts)) } else start.set(m.toolUseId, m.ts)
  }
  return out
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))
export const fmtDur = (t: number) => (t < 1000 ? `${t}ms` : t < 60_000 ? `${Math.round(t / 1000)}s` : t < 3_600_000 ? `${Math.floor(t / 60_000)}m ${Math.round((t % 60_000) / 1000)}s` : `${Math.floor(t / 3_600_000)}h ${Math.round((t % 3_600_000) / 60_000)}m`)
// "claude-opus-5-5" → "Opus 5.5"; "claude-sonnet-4-6-20250101" → "Sonnet 4.6"
export const shortModel = (m?: string) => {
  const x = m?.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$|\[)/)
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? `.${x[3]}` : ''}` : m
}
// "now", "2m", "09:14" (same day, over an hour), else "Sep 24".
export function fmtWhen(ts: string, now = Date.now()) {
  const t = Date.parse(ts)
  if (!t) return ''
  const d = now - t
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  const a = new Date(t), b = new Date(now)
  return a.toDateString() === b.toDateString()
    ? a.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : a.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// Context-window use of the session: the latest API call's prompt (fresh + cache read + cache write) over the window.
// ponytail: transcripts drop the "[1m]" suffix, so a session that ever went past 200k counts as 1M; a 1M session
// still under 200k shows against 200k until then.
export function contextUsage(msgs: TMsg[]) {
  const us = msgs.map((m) => m.meta).filter((u): u is Usage => !!u && !!u.model && !u.model.startsWith('<'))
  const last = us.at(-1)
  if (!last) return null
  const used = last.in + last.cr + last.cw
  const window = /\[1m\]/i.test(last.model!) || us.some((u) => u.in + u.cr + u.cw > 200_000) ? 1_000_000 : 200_000
  return { used, window, pct: Math.min(100, Math.round((used / window) * 100)) }
}

// WP-105: a turn that came from a room, as the chat page shows it — the prompt compact ("from #slug · who: …"), each
// successful `room post <slug>` as "answered in #slug", and the agent's chat text after the last post collapsed.
// Only `room #` turns (wt-messages are untouched); a failed or missing post collapses nothing.
export interface RoomItem { from: string; text: string }
export interface RoomTurns { rooms: Map<string, { slug: string; items: RoomItem[] }>; posts: Map<string, string>; postResults: Set<string>; collapse: Set<string> }
// The room CLI itself: at command start, after ; & | or as …/wt-room/scripts/room — not `echo room post x`.
const POST = /(?:^|[;&|]\s*|\/wt-room\/scripts\/)room\s+post\s+["']?([\w-]+)/
// WP-219: a kind=context tag is earlier room chatter, not part of this turn.
const ITEM = /<room-message (?![^>]*kind=context)[^>]*from="([^"]*)"[^>]*>([\s\S]*?)<\/room-message>/g
export function roomTurns(msgs: TMsg[]): RoomTurns {
  const out: RoomTurns = { rooms: new Map(), posts: new Map(), postResults: new Set(), collapse: new Set() }
  let turn: TMsg[] = [], inRoom = false
  const close = () => {
    if (!inRoom) return
    let last = -1
    turn.forEach((m, i) => {
      if (m.role !== 'tool' || m.tool?.name === 'result') return
      const p = m.tool?.summary?.match(POST)
      if (!p) return
      const r = turn.findIndex((x, j) => j > i && x.role === 'tool' && x.tool?.name === 'result' && x.toolUseId === m.toolUseId)
      if (r < 0 || turn[r].isError) return
      out.posts.set(m.id, p[1]); out.postResults.add(turn[r].id); last = Math.max(last, r)
    })
    if (last >= 0) for (const m of turn.slice(last + 1)) if (m.role === 'assistant' && m.text) out.collapse.add(m.id)
  }
  for (const m of msgs) {
    if (m.role === 'user' && !INTERRUPT.test(m.text)) {
      close()
      turn = []
      inRoom = Boolean(m.src?.startsWith('room #'))
      if (inRoom) out.rooms.set(m.id, { slug: m.src!.slice(6), items: [...m.text.matchAll(ITEM)].map((x) => ({ from: x[1], text: x[2].trim() })) })
      continue
    }
    turn.push(m)
  }
  close()
  return out
}

// The detail parts behind a message's info icon (user: source + attachments; turn: model, tokens, time, tools, cost).
export function metaParts(meta: Meta | undefined, extraAttachments = 0): string[] {
  const parts: string[] = []
  if (meta?.kind === 'user') {
    parts.push(meta.src === 'dashboard' ? 'you · dashboard · delivered' : meta.src ?? 'you')
    const n = meta.attachments + extraAttachments
    if (n) parts.push(`${n} attachment${n === 1 ? '' : 's'}`)
  } else if (meta?.kind === 'turn') {
    if (meta.model) parts.push(shortModel(meta.model)!)
    if (meta.up || meta.down) parts.push(`↑${fmtTokens(meta.up)} (cache read ${fmtTokens(meta.cr)} · cache write ${fmtTokens(meta.cw)} · fresh ${fmtTokens(meta.fresh)}) ↓${fmtTokens(meta.down)}`)
    if (meta.ms) parts.push(fmtDur(meta.ms))
    if (meta.tools) parts.push(`${meta.tools} tool${meta.tools === 1 ? '' : 's'}`)
    if (meta.cost != null) parts.push(`~$${meta.cost < 0.01 ? meta.cost.toFixed(3) : meta.cost.toFixed(2)}`)
  }
  return parts
}
export const stopLabel = (meta?: Meta) => (meta?.kind === 'turn' && meta.stop ? (meta.stop === 'max_tokens' ? 'hit max tokens' : meta.stop) : undefined)
