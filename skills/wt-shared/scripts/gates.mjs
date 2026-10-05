// Stage gates (WP-239): an exit check per stage. A card cannot leave a stage until its check passes.
//   plan    a plan file docs/plans/<id>-*.md (the card id lowercased) in the repo or one of its worktrees
//   build   green tests AND a branch tip: the newest `tests:` comment is green, and either a branch <id>-* has commits
//           ahead of the integration branch or a comment names a tip (`tip: 1a2b3c4`; it outlives the merged branch)
//   review  the newest `verdict:` comment is Approve or Approve with fixes (Send back does not pass)
//   qa      a `live-check: <note>` comment
// Evidence is the card's own comments (`wt-ticket comment <ID> "tests: green …"`), so any agent can leave it.
// Which gates are on: the owning team's `gates:` list, else the project's `<settings>/gates.md` (`gates: [plan, build]`),
// else none — a repo with neither behaves as before. Pure: git/filesystem facts are passed in.
import { readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { parse, settingsRoot } from './roles.mjs'

export const GATE_STAGES = ['plan', 'build', 'review', 'qa']
export const CHECK_LABEL = { plan: 'plan file', build: 'tests + tip', review: 'verdict', qa: 'live-check' }
// The board column a stage runs in; qa shares review's column and leaves it at the same move.
export const STAGE_COLUMN = { plan: 'planning', build: 'building', review: 'review', qa: 'review' }
const ORDER = ['backlog', 'ready', 'planning', 'building', 'review', 'done']

// Project default: <settings root>/gates.md, `gates: [plan, build]`. Bounded like a role file; [] when absent.
export function projectGates(checkout) {
  try {
    const f = join(settingsRoot(checkout), 'gates.md')
    if (!realpathSync(f).startsWith(realpathSync(settingsRoot(checkout)) + sep)) return []
    const g = parse(readFileSync(f, 'utf8').slice(0, 4096)).meta.gates
    return [].concat(g ?? []).filter((s) => GATE_STAGES.includes(s))
  } catch { return [] }
}
// A team's own list wins (an explicit `gates: []` turns the project default off for it).
export const gatesFor = (team, project) => (team?.gates ? team.gates : project).filter((s) => GATE_STAGES.includes(s))

const comments = (t) => (t.history ?? []).filter((h) => h.kind === 'comment' && typeof h.text === 'string')
const newest = (t, re) => comments(t).reverse().map((h) => re.exec(h.text.trim())).find(Boolean) ?? null

// facts: {plan: path|null, tip: sha|null} → [{stage, ok, why}] for the given stages.
export function evaluate(t, stages, facts = {}) {
  return stages.map((stage) => {
    let why = null
    if (stage === 'plan') { if (!facts.plan) why = `no plan file docs/plans/${t.id.toLowerCase()}-*.md` }
    else if (stage === 'build') {
      const tests = newest(t, /^tests:\s*(?:all\s+)?(\S+)/i)
      const tip = facts.tip || comments(t).some((h) => /(?:^|\n)\s*tip[: ]+[0-9a-f]{7,40}\b/i.test(h.text))
      if (!tests) why = 'no "tests: green" comment'
      else if (!/^(green|pass(ed|ing)?|ok)$/i.test(tests[1])) why = `latest tests comment is "${tests[1]}", not green`
      else if (!tip) why = `no branch ${t.id.toLowerCase()}-* with commits, and no "tip: <sha>" comment`
    } else if (stage === 'review') {
      const v = newest(t, /^verdict:\s*(approved? with fixes|approved?|send back)\b/i)
      if (!v) why = 'no "verdict: Approve|Approve with fixes" comment'
      else if (/^send back/i.test(v[1])) why = 'latest verdict is Send back'
    } else if (stage === 'qa') { if (!newest(t, /^live-check:\s*\S/i)) why = 'no "live-check: <note>" comment' }
    return { stage, ok: !why, why }
  })
}

// Where a card really is: a Blocked card is still in the column it was blocked from, so blocking is not a way round a gate.
export function origin(t) {
  if (t.column !== 'blocked') return t.column
  const m = [...(t.history ?? [])].reverse().find((h) => h.kind === 'move' && h.to === 'blocked')
  return ORDER.includes(m?.from) ? m.from : 'blocked'
}
// The enabled stages a move from `from` to `to` passes. Forward moves only; blocked and backward moves are never gated. A
// card in Backlog/Ready is not in a stage yet and may start at Planning or Building (the plan stage is skipped when it goes
// straight to a worker), so its first gate is build's: Ready → Building is free, Ready → Review needs build.
export function crossed(enabled, from, to) {
  const a = Math.max(ORDER.indexOf(from), from === 'backlog' || from === 'ready' ? ORDER.indexOf('building') : 0), b = ORDER.indexOf(to)
  if (ORDER.indexOf(from) < 0 || b <= a) return []
  return enabled.filter((s) => { const c = ORDER.indexOf(STAGE_COLUMN[s]); return c >= a && c < b })
}
