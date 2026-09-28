// Room timeline rows: messages plus the one-line status rows derived from their delivery state.
export interface StatusMsg {
  id: string; mentions: string[]; deliveredTo: string[]; author: { kind: 'user' | 'agent' | 'system'; name?: string }
  blocked?: { name: string; reason: string }[]; queuedFor?: string[]; notified?: boolean
  undelivered?: { to: string; n: number }[]; command?: { target: string }
}
export type Row<M> = { kind: 'msg'; id: string; m: M } | { kind: 'status'; id: string; text: string }
// Delivery/queue/notify state becomes one-line system rows after its message, instead of crowding its metadata.
// ponytail: delivery events carry no time of their own, so a status sits right after the message it is about.
export function roomRows<M extends StatusMsg>(msgs: M[], handle: string, working: Map<string, string[]>): Row<M>[] {
  const out: Row<M>[] = []
  const me = handle.toLowerCase()
  let prev = null as { author: string; st: string; at: number; n: number } | null
  // Each agent's last post, so a row can say it replied.
  const lastPost = new Map(msgs.flatMap((m, i) => (m.author.kind === 'agent' && m.author.name ? [[m.author.name, i] as const] : [])))
  for (const [i, m] of msgs.entries()) {
    out.push({ kind: 'msg', id: m.id, m })
    if (m.author.kind === 'system') { prev = null; continue }
    // One row per addressed agent, updated in place as it moves on: will be notified → notified → replying… →
    // replied (it posted after this message), or the reason it was blocked.
    const st: { key: string; text: string }[] = []
    if (m.command) st.push({ key: 'cmd', text: `command for ${m.command.target}` })
    for (const u of m.undelivered ?? []) st.push({ key: `img:${u.to}`, text: `${u.to}: ${u.n} image${u.n === 1 ? '' : 's'} not delivered — remote agent` })
    const blocked = new Map((m.blocked ?? []).map((b) => [b.name, b.reason]))
    const queued = (m.queuedFor ?? m.mentions.filter((n) => n !== 'all' && n.toLowerCase() !== me))
      .filter((n) => !m.deliveredTo.includes(n) && !blocked.has(n))
    const replying = working.get(m.id) ?? []
    for (const n of [...new Set([...m.deliveredTo, ...queued, ...blocked.keys(), ...replying])]) {
      const text = blocked.has(n) ? `${n}: ${blocked.get(n)}`
        // A post after this message wins over 'working': the agent may still be busy (ending its turn, other work).
        : (lastPost.get(n) ?? -1) > i ? `${n} replied`
        : replying.includes(n) ? `${n} is replying…`
        : m.deliveredTo.includes(n) ? `${n} was notified` : `${n} will be notified when idle`
      st.push({ key: n, text })
    }
    if (m.notified ?? (m.author.kind === 'agent' && m.mentions.some((n) => n.toLowerCase() === me))) st.push({ key: 'you', text: 'you were notified' })
    // Collapse consecutive duplicates: a burst from one author with the same statuses shows them once, after its last message.
    const author = `${m.author.kind}:${m.author.name}`
    const sig = st.map((x) => x.text).join('\n')
    if (st.length && prev?.author === author && prev.st === sig) out.splice(prev.at, prev.n)
    const at = out.length
    for (const x of st) out.push({ kind: 'status', id: `${m.id}~${x.key}`, text: x.text })
    prev = { author, st: sig, at, n: st.length }
  }
  return out
}

// @ menu order: the room's members first, then everyone else; each part keeps its incoming order.
export const membersFirst = <A extends { name: string }>(agents: A[], members: string[]) =>
  [...agents.filter((a) => members.includes(a.name)), ...agents.filter((a) => !members.includes(a.name))]

// Composer attachment markers: a chip [attachment:<id8>] sits where the file was added. A marker the user
// deleted drops its attachment; on send each marker becomes [attachment N], N = its place among the sent ones.
export const attMarker = (id: string) => `[attachment:${id.slice(0, 8)}]`
export const orphanedAtts = (text: string, ids: string[]) => ids.filter((id) => !text.includes(attMarker(id)))
export const numberMarkers = (text: string, sentIds: string[]) =>
  sentIds.reduce((t, id, i) => t.split(attMarker(id)).join(`[attachment ${i + 1}]`), text).replace(/\[attachment:[0-9a-f]{8}\]/g, '').trim()
