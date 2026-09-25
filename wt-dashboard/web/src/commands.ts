// Slash-command menu data: fuzzy search over an agent's skills and commands (agent panel and rooms).
import type { SearchSource, SearchableItem } from '@astryxdesign/core/Typeahead'

export interface Command { name: string; description: string; source: string }
const SOURCE_ORDER = ['Project', 'Personal', 'Plugins', 'Built-in']
// Fuzzy: every query char in order; contiguous/early hits in the name score higher; description is a weaker fallback.
export function fuzzy(q: string, s: string): number {
  let i = 0, score = 0, last = -2
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) { score += j === last + 1 ? 3 : 1; last = j; i++ }
  }
  return i === q.length ? score - s.length / 100 : -1
}
export function commandSource(cmds: Command[]): SearchSource<SearchableItem> {
  const items = cmds.map((c) => ({ id: c.name, label: c.name, auxiliaryData: { ...c, group: c.source } })) // auxiliaryData.group drives the menu headings
  const bySource = (a: SearchableItem, b: SearchableItem) =>
    SOURCE_ORDER.indexOf((a.auxiliaryData as Command).source) - SOURCE_ORDER.indexOf((b.auxiliaryData as Command).source)
  return {
    bootstrap: () => [...items].sort(bySource),
    search: (query) => {
      const q = query.toLowerCase().trim()
      if (!q) return [...items].sort(bySource)
      return items
        .map((it) => {
          const c = it.auxiliaryData as Command
          const n = fuzzy(q, c.name.toLowerCase())
          return { it, score: n >= 0 ? 100 + n : c.description.toLowerCase().includes(q) ? 1 : -1 }
        })
        .filter((x) => x.score >= 0)
        .sort((a, b) => bySource(a.it, b.it) || b.score - a.score)
        .slice(0, 50)
        .map((x) => x.it)
    },
  }
}
