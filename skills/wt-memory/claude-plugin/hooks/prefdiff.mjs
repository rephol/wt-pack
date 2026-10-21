// WP-369: line diff of two `wt-memory context` texts, per `## <section>`. Pure; the hook sends this instead of the whole list.
const sections = (text) => {
  const m = new Map()
  let cur = ''
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.trim()
    if (raw.startsWith('## ')) { cur = l; if (!m.has(cur)) m.set(cur, []); continue }
    if (!l) continue
    if (!m.has(cur)) m.set(cur, [])
    m.get(cur).push(l)
  }
  return m
}
const HEADER = 'Preferences changed (lines added +, removed -; everything else you already have is unchanged). A "-" line no longer applies: stop following it. A "+" line now applies. A line shown with its own bullet looks like "- - text" or "+ - text".'
// -> the formatted block, or null when nothing differs after trimming.
export function diffPrefs(prev, cur) {
  const a = sections(prev), b = sections(cur)
  const out = []
  for (const name of [...b.keys(), ...[...a.keys()].filter((k) => !b.has(k))]) {
    const old = new Set(a.get(name) ?? []), now = new Set(b.get(name) ?? [])
    const lines = [...[...old].filter((l) => !now.has(l)).map((l) => `- ${l}`), ...[...now].filter((l) => !old.has(l)).map((l) => `+ ${l}`)]
    if (lines.length) out.push(`${name}\n${lines.join('\n')}`)
  }
  return out.length ? `${HEADER}\n\n${out.join('\n\n')}` : null
}
