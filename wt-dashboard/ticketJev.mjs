// Jev triage of a new ticket (WT_JEV_TICKET_TRIAGE): one call suggests type, size, priority and owner role, and
// flags likely duplicates among the board's open tickets. Server-side, after POST /api/tickets has answered.
import { route } from '../wt-handoff/scripts/jev-route.mjs'

const TYPE_CRITERIA = {
  bug: 'Logic is broken: a crash, an error, wrong data or a wrong count, a failed build or request.',
  ux: 'The interface is the problem: layout, clipping, copy, clutter, visual noise, confusing flow or navigation, even when described as broken.',
  gap: 'An existing feature or flow is missing an expected piece (a missing option, state, path or integration).',
  debt: 'Internal cleanup, refactor, tests, docs or tooling with no user-visible change.',
  feature: 'A new capability that does not exist yet.',
}
const SIZE_CRITERIA = {
  S: 'Small: a one-line to one-file change, under an hour.',
  M: 'Medium: a few files, a unit or two of work, a few hours.',
  L: 'Large: several units across modules, needs a plan, a day or more.',
}
const words = (s) => new Set(String(s ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])

// ponytail: word-overlap prefilter, embeddings only if duplicate recall is visibly bad.
export function candidates(t, open, n = 5) {
  const mine = words(`${t.title} ${t.body}`)
  return open.filter((o) => o.id !== t.id && o.column !== 'done')
    .map((o) => { let k = 0; for (const w of words(`${o.title} ${o.body}`)) if (mine.has(w)) k++; return { o, k } })
    .filter((x) => x.k > 0).sort((a, b) => b.k - a.k).slice(0, n).map(({ o }) => ({ id: o.id, title: o.title }))
}

export const ticketTriage = {
  // state = { title, body, candidates: [{id, title}] }
  questions: (state) => ({
    type: { type: 'choice', instructions: 'What kind of ticket is this?', criteria: TYPE_CRITERIA },
    size: { type: 'choice', instructions: 'How much work is this ticket?', criteria: SIZE_CRITERIA },
    priority: { type: 'score', instructions: 'How urgent is this ticket for the team shipping this project?', criteria: ['urgent', 'high', 'medium', 'low'] },
    ...route.questions(),
    ...Object.fromEntries((state.candidates ?? []).map((c) => [`dup_${c.id}`, { type: 'noul',
      instructions: `Is this ticket a duplicate of the existing ticket ${c.id} "${c.title}" (same problem or request)?` }])),
  }),
  // min: choice/score confidence floor; routeMin: the handoff route threshold. null = no suggestion.
  decide: (a, min = 0.6, routeMin = 0.75) => {
    const pick = (q) => (a?.[q]?.choice && (a[q].confidence ?? 0) >= min ? a[q].choice : null)
    const s = a?.priority
    return {
      type: pick('type'), size: pick('size'),
      priority: typeof s?.score === 'number' && (s.confidence ?? 0) >= 0.6 ? Math.max(0, Math.min(3, Math.round(s.score))) + 1 : null,
      owner: a?.plan ? route.decide(a, routeMin) : null,
      dupes: Object.keys(a ?? {}).filter((k) => k.startsWith('dup_') && (a[k]?.noul ?? 0) >= 0.8).map((k) => k.slice(4)),
    }
  },
}
// jev-eval compares with JSON equality: the type alone is the labelled field.
export const ticketType = { questions: ticketTriage.questions, decide: (a) => ticketTriage.decide(a).type }

// Fire-and-forget after create. empty: the fields the creator left unset. Never throws.
export async function triageTicket(project, t, empty, { ask, tickets, min, routeMin, log = console.error }) {
  try {
    const { tickets: all } = await tickets.list(project)
    const state = { title: t.title, body: t.body.slice(0, 4000), candidates: candidates(t, all) }
    const a = await ask(state, ticketTriage.questions(state), (x) => ticketTriage.decide(x, min, routeMin))
    if (!a) return null
    return await tickets.jevApply(t.id, ticketTriage.decide(a, min, routeMin), empty)
  } catch (e) { log('ticket triage:', e.message); return null }
}
