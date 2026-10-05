// WP-239: the board's guard on a column move (PATCH /api/tickets/:id), kept apart from the server so it can be tested.
// state(ticket) → {gates:[{stage,ok,why}], crossed(to) → stages the move passes}. A move that passes a failing gate is
// refused (409, one `gates` comment per distinct refusal); `force: true` lets it through and, once the move has landed,
// leaves a comment saying who overrode which gates. A gate that cannot be evaluated fails OPEN: it must not freeze the board.
export async function guardMove({ tickets, state }, cur, to, force, author) {
  if (!to || to === cur.column) return { ok: true }
  const st = await state(cur).catch((e) => { console.error('gates:', e.message); return { gates: [], crossed: () => [] } })
  const fails = st.gates.filter((x) => !x.ok && st.crossed(to).includes(x.stage))
  if (!fails.length) return { ok: true }
  const why = fails.map((x) => `${x.stage}: ${x.why}`).join('; ')
  if (force !== true) {
    const note = `gate blocked ${cur.column} → ${to}. ${why}`
    if (cur.history.at(-1)?.text !== note) await tickets.comment(cur.id, note, { name: 'gates' }).catch(() => {}) // a retry does not pile up copies
    return { ok: false, status: 409, body: { error: `gate blocked ${cur.column} → ${to}: ${why} (--force overrides)`, gates: fails } }
  }
  return { ok: true, afterMove: () => tickets.comment(cur.id, `gate overridden by ${author.name}: ${fails.map((x) => x.stage).join(', ')}`, { name: 'gates' }).catch(() => {}) }
}
