// WP-252: restart recovery sweep. A dashboard restart leaves cards in Planning/Building whose agent died with
// the machine or the herdr session; reconcile() would return them eventually, but silently and only after its
// debounce. This runs once at startup: mark each such card interrupted (with the reason), then re-dispatch it
// or flag it on the board and in the Inbox. Pack agents only: it looks at cards a wt-pack dispatch assigned
// (assignee with a pane), never at herdr panes outside the pack.
// deps: { agents(), notify(draft), redispatch(ticket, {key}) → boolean (WP-251 seam: `key` is the idempotency
// key a re-dispatch must carry so a double send is a no-op), event(project, kind, id, text) }
export async function sweep({ tickets, deps, now = Date.now(), log = console.error }) {
  const local = (await deps.agents().catch(() => [])).filter((a) => a.local)
  if (!local.length) return [] // herdr down is not "every agent is gone"
  const out = []
  for (const { id, project } of tickets.db.prepare('SELECT id, project FROM tickets').all()) {
    const t = await tickets.get(id)
    const who = t.assignee
    if (!['planning', 'building'].includes(t.column) || !who?.pane || t.dispatch?.state === 'interrupted') continue
    const a = local.find((x) => x.name === who.name)
    if (a && a.status !== 'exited') continue
    const reason = `dashboard restarted; ${who.name} is gone`
    const key = `${t.id}|${who.name}|${t.updated}`
    let redispatched = false
    if (!t.pair) redispatched = await Promise.resolve(deps.redispatch?.(t, { key })).catch((e) => (log(`recovery ${t.id}: ${e.message}`), false))
    if (!redispatched) {
      await tickets.mutate(t.id, (c, at) => {
        c.dispatch = { state: 'interrupted', at, agent: who.name, reason }
        c.history.push({ at, author: 'dispatch', kind: 'comment', text: `interrupted: ${reason}` })
        return c
      })
    }
    deps.event?.(project, 'interrupted', t.id, `${reason}${redispatched ? '; re-dispatched' : '; flagged'}`, now)
    await deps.notify?.({ kind: 'server', key: `interrupted|${key}`, title: `${t.id} interrupted by a restart`,
      body: `${reason}. ${redispatched ? 'Returned to Ready for re-dispatch.' : 'Left for you: Retry dispatch from the card.'}`, target: { ticket: t.id, project } })
    out.push({ id: t.id, redispatched })
  }
  return out
}
