// Room timeline rows: messages plus the one-line status rows derived from their delivery state.
export interface StatusMsg {
  id: string; mentions: string[]; deliveredTo: string[]; author: { kind: 'user' | 'agent' | 'system'; name?: string }
  blocked?: { name: string; reason: string }[]; queuedFor?: string[]; notified?: boolean
  undelivered?: { to: string; n: number }[]; command?: { target: string }
}
export type Row<M> = { kind: 'msg'; id: string; m: M } | { kind: 'status'; id: string; text: string }
const names = (xs: string[]) => xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]
// Delivery/queue/notify state becomes one-line system rows after its message, instead of crowding its metadata.
// ponytail: delivery events carry no time of their own, so a status sits right after the message it is about.
export function roomRows<M extends StatusMsg>(msgs: M[], handle: string, working: Map<string, string[]>): Row<M>[] {
  const out: Row<M>[] = []
  const me = handle.toLowerCase()
  let prev = null as { author: string; st: string[]; at: number } | null
  for (const m of msgs) {
    out.push({ kind: 'msg', id: m.id, m })
    if (m.author.kind === 'system') { prev = null; continue }
    const st: string[] = []
    if (m.command) st.push(`command for ${m.command.target}`)
    if (m.deliveredTo.length) st.push(`${names(m.deliveredTo)} ${m.deliveredTo.length > 1 ? 'were' : 'was'} notified`)
    for (const u of m.undelivered ?? []) st.push(`${u.to}: ${u.n} image${u.n === 1 ? '' : 's'} not delivered — remote agent`)
    for (const b of m.blocked ?? []) st.push(`${b.name}: ${b.reason}`)
    const queued = (m.queuedFor ?? m.mentions.filter((n) => n !== 'all' && n.toLowerCase() !== me))
      .filter((n) => !m.deliveredTo.includes(n) && !(m.blocked ?? []).some((b) => b.name === n))
    if (queued.length) st.push(`${names(queued)} will be notified when idle`)
    if (m.notified ?? (m.author.kind === 'agent' && m.mentions.some((n) => n.toLowerCase() === me))) st.push('you were notified')
    for (const n of working.get(m.id) ?? []) st.push(`${n} is replying…`)
    // Collapse consecutive duplicates: a burst from one author with the same statuses shows them once, after its last message.
    const author = `${m.author.kind}:${m.author.name}`
    if (st.length && prev?.author === author && prev.st.join('\n') === st.join('\n')) out.splice(prev.at, st.length)
    const at = out.length
    st.forEach((text, i) => out.push({ kind: 'status', id: `${m.id}~${i}`, text }))
    prev = { author, st, at }
  }
  return out
}

// @ menu order: the room's members first, then everyone else; each part keeps its incoming order.
export const membersFirst = <A extends { name: string }>(agents: A[], members: string[]) =>
  [...agents.filter((a) => members.includes(a.name)), ...agents.filter((a) => !members.includes(a.name))]
