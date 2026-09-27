// WP-112 chat dock state: the agent and room chats opened on desktop, each a compact window or a minimised tab.
// Pure (the reducer, the unread rule, load/save); ChatDock.tsx renders it. Remembered per device in localStorage.
export type DockItem = { key: string; kind: 'agent' | 'room'; min: boolean; openedAt: number }
export type DockState = { items: DockItem[]; seen: Record<string, number> }
export type DockAction = { type: 'open' | 'minimise' | 'close' | 'seen'; key: string; now: number }
export const MAX_WINDOWS = 3
export const STORE_KEY = 'chat-dock'
export const EMPTY: DockState = { items: [], seen: {} }

export const dockKind = (key: string): DockItem['kind'] | null => (key.startsWith('room:') ? 'room' : key.startsWith('term:') || !key.includes('/') ? null : 'agent')

// Adds the chat, or raises its tab to a window. Past MAX_WINDOWS the oldest window becomes a tab.
export function openChat(s: DockState, key: string, now: number): DockState {
  const kind = dockKind(key)
  if (!kind) return s
  const items = [...s.items.filter((i) => i.key !== key), { key, kind, min: false, openedAt: now }]
  const wins = items.filter((i) => !i.min).sort((a, b) => a.openedAt - b.openedAt)
  const drop = new Set(wins.slice(0, Math.max(0, wins.length - MAX_WINDOWS)).map((i) => i.key))
  return { items: items.map((i) => (drop.has(i.key) ? { ...i, min: true } : i)), seen: { ...s.seen, [key]: now, ...Object.fromEntries([...drop].map((k) => [k, now])) } }
}
export const minimise = (s: DockState, key: string, now: number): DockState =>
  ({ items: s.items.map((i) => (i.key === key ? { ...i, min: true } : i)), seen: { ...s.seen, [key]: now } })
export function close(s: DockState, key: string): DockState {
  const seen = { ...s.seen }
  delete seen[key]
  return { items: s.items.filter((i) => i.key !== key), seen }
}
export const markSeen = (s: DockState, key: string, now: number): DockState => ({ ...s, seen: { ...s.seen, [key]: now } })

export function dockReducer(s: DockState, a: DockAction): DockState {
  return a.type === 'open' ? openChat(s, a.key, a.now) : a.type === 'minimise' ? minimise(s, a.key, a.now) : a.type === 'close' ? close(s, a.key) : markSeen(s, a.key, a.now)
}

// Unread, per device and approximate (no server read cursors): '!' when it needs you, 'dot' when there was
// activity since the tab was last seen. An open window is being read, so it is never unread.
export type Roster = {
  agents: { key: string; asks: boolean; status: string; lastActivity?: number; statusSince: number }[]
  rooms: { slug: string; lastAt?: string | null; needsYou?: unknown[] }[]
}
export function unread(s: DockState, r: Roster): Record<string, 'dot' | '!'> {
  const out: Record<string, 'dot' | '!'> = {}
  for (const i of s.items) {
    if (!i.min) continue
    const seen = s.seen[i.key] ?? 0
    if (i.kind === 'room') {
      const room = r.rooms.find((x) => `room:${x.slug}` === i.key)
      if (room?.needsYou?.length) out[i.key] = '!'
      else if (room?.lastAt && Date.parse(room.lastAt) > seen) out[i.key] = 'dot'
    } else {
      const a = r.agents.find((x) => x.key === i.key)
      if (a && a.asks && a.status !== 'working') out[i.key] = '!'
      else if (a && (a.lastActivity || a.statusSince) > seen) out[i.key] = 'dot'
    }
  }
  return out
}

export function load(): DockState {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')
    if (!v || !Array.isArray(v.items)) return EMPTY
    const items = v.items.filter((i: DockItem) => i && typeof i.key === 'string' && dockKind(i.key) === i.kind && typeof i.openedAt === 'number')
      .map((i: DockItem) => ({ key: i.key, kind: i.kind, min: Boolean(i.min), openedAt: i.openedAt }))
    const seen = v.seen && typeof v.seen === 'object' ? Object.fromEntries(Object.entries(v.seen).filter(([, t]) => typeof t === 'number')) as Record<string, number> : {}
    return { items, seen }
  } catch { return EMPTY }
}
export function save(s: DockState) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)) } catch { /* private mode */ }
}
