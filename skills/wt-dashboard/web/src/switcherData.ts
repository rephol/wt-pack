// Quick-switcher results: one flat, grouped list for Astryx's CommandPalette (auxiliaryData.group makes the headings).
// An agent appears once, in its highest section: Needs you › Recent (5) › Working › Agents; then Rooms (waiting on you first).
import type { SearchableItem } from '@astryxdesign/core/Typeahead'
import { fuzzy } from './commands.ts'

export interface SwAgent {
  key: string; name: string; pool: string; machine: string; local: boolean
  status: 'working' | 'idle' | 'blocked' | 'done' | 'unknown'; asks: boolean
  statusSince: number; lastActivity?: number; recap: string | null; question: string | null; task: string | null
  project?: string | null
  tags?: Record<string, string> // tags.task: the handoff label, "UMK-1192 Tailwind v4…"
}
// The sidebar project selector: 'all' shows everything; a project shows only its own agents/rooms (one without a
// project appears under All only). Shared by the sidebar list, Rooms page and quick switcher.
export const inProject = (x: { project?: string | null }, project: string) => project === 'all' || x.project === project
export const roomInProject = inProject
// A routine's project (WP-53): its target's, else the named agent's; local housekeeping has none (All only).
export const routineProject = (t: { kind: string; agent?: string; project?: string }, agents: { name: string; project?: string | null }[]) =>
  t.project ?? (t.agent ? agents.find((a) => a.name === t.agent)?.project ?? null : null)
export interface SwRoom { slug: string; title: string; project?: string | null; needsYou?: { agent: string; text: string }[]; archived?: boolean }
export interface SwTicket { id: string; title: string; column: string; project: string }
export type SwItem = SearchableItem<{ group: string; kind: 'agent'; agent: SwAgent; line: string } | { group: string; kind: 'room'; room: SwRoom; line: string }
  | { group: string; kind: 'ticket'; ticket: SwTicket; line: string }
  | { group: string; kind: 'scope'; line: string }>
export const SCOPE_ID = 'scope:toggle'
// Every section (Needs you, Recent, Agents, Rooms) scoped to the project unless showAll; with a project selected the
// first row is the 'Showing <project> · show all' toggle (a row, because the palette has no header slot).
export function scopedItems(agents: SwAgent[], rooms: SwRoom[], recent: string[], project: string, showAll: boolean, query = '', tickets: SwTicket[] = []): SwItem[] {
  const p = showAll ? 'all' : project
  const items = [...switcherItems(agents.filter((a) => inProject(a, p)), rooms.filter((r) => inProject(r, p)), recent, query), ...ticketItems(tickets.filter((t) => inProject(t, p)), query)]
  if (project === 'all') return items
  const label = showAll ? `Showing all projects · only ${project}` : `Showing ${project} · show all`
  return [{ id: SCOPE_ID, label, auxiliaryData: { group: 'Project', kind: 'scope', line: '' } }, ...items]
}

// The task label with its lifecycle state (planner: planning → handed to <worker> → done (PR #N) / blocked: …).
export const taskLabel = (tags?: Record<string, string>) => (tags?.task ? [tags.task, tags.task_state].filter(Boolean).join(' · ') : undefined)
export const needsYou = (a: SwAgent) => a.asks && a.status !== 'working'
const activity = (a: SwAgent) => a.lastActivity || a.statusSince
// Never empty, so every row has the same two lines.
export const subtitle = (a: SwAgent) => (needsYou(a) && a.question) || [taskLabel(a.tags), a.recap].filter(Boolean).join(' · ') || `${a.status} · no recent summary`

// Best score across name (strong), ticket id and recap/question; -1 = no match.
function score(q: string, a: SwAgent) {
  const name = fuzzy(q, a.name.toLowerCase())
  const ticket = `${a.task ?? ''} ${a.tags?.task ?? ''}`.toLowerCase().includes(q) ? 50 : -1
  const text = `${a.recap ?? ''} ${a.question ?? ''}`.toLowerCase().includes(q) ? 1 : -1
  return Math.max(name >= 0 ? 100 + name : -1, ticket, text)
}

export function switcherItems(agents: SwAgent[], rooms: SwRoom[], recent: string[], query = ''): SwItem[] {
  const q = query.trim().toLowerCase()
  const scored = new Map(agents.map((a) => [a.key, q ? score(q, a) : 0]))
  const pool = agents.filter((a) => (scored.get(a.key) ?? -1) >= 0)
  const order = (x: SwAgent, y: SwAgent) => (q ? (scored.get(y.key)! - scored.get(x.key)!) : 0) || activity(y) - activity(x)
  const seen = new Set<string>()
  const take = (group: string, list: SwAgent[]): SwItem[] => list.filter((a) => !seen.has(a.key) && seen.add(a.key))
    .map((a) => ({ id: `agent:${a.key}`, label: a.name, auxiliaryData: { group, kind: 'agent', agent: a, line: subtitle(a) } }))
  const byKey = new Map(pool.map((a) => [a.key, a]))
  const out = [
    ...take('Needs you', pool.filter(needsYou).sort(order)),
    ...take('Recent', recent.map((k) => byKey.get(k)).filter((a): a is SwAgent => !!a).slice(0, 5)),
    ...take('Working', pool.filter((a) => a.status === 'working').sort(order)),
    ...take('Agents', [...pool].sort(order)),
  ]
  const waiting = (r: SwRoom) => (r.needsYou?.length ? 0 : 1)
  for (const r of rooms.filter((r) => !r.archived).sort((x, y) => waiting(x) - waiting(y))) {
    if (q && fuzzy(q, r.title.toLowerCase()) < 0 && !r.slug.includes(q)) continue
    const n = r.needsYou?.[0]
    out.push({ id: `room:${r.slug}`, label: r.title, auxiliaryData: { group: 'Rooms', kind: 'room', room: r, line: n ? `${n.agent}: ${n.text}` : '' } })
  }
  return out
}

// Tickets only while searching (the bootstrap list stays agents/rooms): an id prefix ("wp-22", "22") or the title.
// An exact id comes first; done tickets sort last. Capped at 8 so a vague query does not bury the agents.
export function ticketItems(tickets: SwTicket[], query: string): SwItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const rank = (t: SwTicket) => {
    const id = t.id.toLowerCase()
    if (id === q) return 3
    if (id.startsWith(q) || id.split('-')[1] === q) return 2
    return fuzzy(q, t.title.toLowerCase()) >= 0 ? 1 : 0
  }
  return tickets.map((t) => ({ t, r: rank(t) })).filter((x) => x.r > 0)
    .sort((a, b) => b.r - a.r || Number(a.t.column === 'done') - Number(b.t.column === 'done'))
    .slice(0, 8).map(({ t }) => ({ id: `ticket:${t.project}:${t.id}`, label: `${t.id} ${t.title}`, auxiliaryData: { group: 'Tickets', kind: 'ticket', ticket: t, line: `${t.column} · ${t.project}` } }))
}

// planner-02 → P2, worker-05 → W5, orchestrator → O, code-reviewer/w5:p9 → CR, else the first letters of two words.
// With a role letter: that letter plus the agent's trailing number ("P3"); else from the name.
export function agentInitials(name: string, letter?: string) {
  const num = name.match(/-0*(\d+)$/)?.[1]
  if (letter && letter !== '?') return letter + (num ?? '')
  const n = name.replace(/^umkmall-/i, '')
  const role = n.match(/^(planner|worker|orchestrator)(?:-0*(\d+))?$/i)
  if (role) return role[1][0].toUpperCase() + (role[2] ?? '')
  return n.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
}
