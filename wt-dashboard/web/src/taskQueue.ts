// The Tasks page as an action queue: which section a task sits in. Pure, so it is unit-tested.
export interface QPR { number: number; url: string; state: string; isDraft: boolean; ci: 'pass' | 'fail' | 'pending' | null; behind?: boolean; unresolved?: number | null }
export interface QTask {
  id: string
  title: string
  url: string | null
  state: string
  agent: { key: string; id: string | null; name: string; machine: string | null } | null
  responder?: { key: string; name: string } | null
  project: string | null
  question: string | null
  plan: string | null
  pr: QPR | null
  updatedAt: string | null
  roomNeed?: string
}

export const SECTIONS = [
  { key: 'needs_you', label: 'Needs you' },
  { key: 'plan_ready', label: 'Plan ready' },
  { key: 'in_review', label: 'In review' },
  { key: 'stalled', label: 'Stalled' },
  { key: 'up_next', label: 'Up next' },
  { key: 'shipped', label: 'Recently shipped' },
] as const
export type SectionKey = (typeof SECTIONS)[number]['key']

const WEEK = 7 * 24 * 3600_000

// Sections in order, empty ones dropped. Shipped = shipped or merged, updated in the last 7 days.
export function sections<T extends QTask>(tasks: T[], now = Date.now()) {
  const of = (key: SectionKey) => tasks
    .filter((t) => key === 'shipped'
      ? (t.state === 'shipped' || t.state === 'merged') && t.updatedAt != null && now - Date.parse(t.updatedAt) < WEEK
      : t.state === key)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  return SECTIONS.map((s) => ({ ...s, tasks: of(s.key) })).filter((s) => s.tasks.length)
}
