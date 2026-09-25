// Quick-switcher results: one flat, grouped list for Astryx's CommandPalette (auxiliaryData.group makes the headings).
// An agent appears once, in its highest section: Needs you › Recent (5) › Working › Agents; then Rooms waiting on you.
import type { SearchableItem } from '@astryxdesign/core/Typeahead'
import { fuzzy } from './commands.ts'

export interface SwAgent {
  key: string; name: string; pool: string; machine: string; local: boolean
  status: 'working' | 'idle' | 'blocked' | 'done' | 'unknown'; asks: boolean
  statusSince: number; lastActivity?: number; recap: string | null; question: string | null; task: string | null
}
export interface SwRoom { slug: string; title: string; needsYou?: { agent: string; text: string }[] }
export type SwItem = SearchableItem<{ group: string; kind: 'agent'; agent: SwAgent; line: string } | { group: string; kind: 'room'; room: SwRoom; line: string }>

export const needsYou = (a: SwAgent) => a.asks && a.status !== 'working'
const activity = (a: SwAgent) => a.lastActivity || a.statusSince
// Never empty, so every row has the same two lines.
export const subtitle = (a: SwAgent) => (needsYou(a) && a.question) || a.recap || `${a.status} · no recent summary`

// Best score across name (strong), ticket id and recap/question; -1 = no match.
function score(q: string, a: SwAgent) {
  const name = fuzzy(q, a.name.toLowerCase())
  const ticket = a.task && a.task.toLowerCase().includes(q) ? 50 : -1
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
  for (const r of rooms) {
    if (!r.needsYou?.length) continue
    if (q && fuzzy(q, r.title.toLowerCase()) < 0 && !r.slug.includes(q)) continue
    out.push({ id: `room:${r.slug}`, label: r.title, auxiliaryData: { group: 'Rooms', kind: 'room', room: r, line: `${r.needsYou[0].agent}: ${r.needsYou[0].text}` } })
  }
  return out
}

// planner-02 → P2, worker-05 → W5, orchestrator → O, code-reviewer/w5:p9 → CR, else the first letters of two words.
export function agentInitials(name: string) {
  const n = name.replace(/^umkmall-/i, '')
  const role = n.match(/^(planner|worker|orchestrator)(?:-0*(\d+))?$/i)
  if (role) return role[1][0].toUpperCase() + (role[2] ?? '')
  return n.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
}
