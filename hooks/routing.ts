// WP-211 — per-request model routing: the first model request of each main-loop turn is routed through
// model-route.mjs (Jev + the mode gate + sessionFloor), and the turn's remaining steps reuse that pick. In
// off/shadow `pick` applies nothing (shadow only logs the decision), so the request goes through untouched;
// only `live` rewrites model/effort. No routing logic here: the script owns the gate, floors and the log.
import type { Register } from 'claude-code'

const ROUTE = 'skills/wt-shared/scripts/model-route.mjs'

type Pick = { apply: string | null; applyEffort: string | null; ref: string | null }
type Efforts = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

// `pick --json` stdout → the decision, or null when it is not one (a failed script never blocks a request).
export const parsePick = (stdout: string): Pick | null => {
  try {
    const d = JSON.parse(stdout)
    return { apply: typeof d.apply === 'string' ? d.apply : null, applyEffort: typeof d.applyEffort === 'string' ? d.applyEffort : null, ref: typeof d.ref === 'string' ? d.ref : null }
  } catch { return null }
}

// One hooks module per plugin (hooks.json `modules` takes a single entry), so commands.ts registers this.
export const registerRouting: Register = on => {
  let prompt = '' // the last submitted prompt: the task text for the next turn's first request
  let turn: { id: string; pick: Pick | null; model?: string } | undefined
  const modelIds = new Map<string, string>()

  on('prompt.submit', (_$, e, next) => {
    prompt = e.text
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e) // a subagent's tier is its Agent call's; this routes the main loop
    const script = `${$.plugin.root}/${ROUTE}`
    if (e.index === 0 && prompt) {
      const text = prompt
      prompt = '' // a turn with no prompt of its own (a background wake-up) is not routed on a stale one
      const r = await $.process.run(['node', script, 'pick', '--skill', 'turn-step', '--session', '--json'], { stdin: text, timeoutMs: 8000 }).catch(() => null)
      turn = { id: e.turnId, pick: r?.exitCode === 0 ? parsePick(r.stdout) : null }
    }
    const pick = turn?.id === e.turnId ? turn.pick : null
    if (!turn || !pick?.apply) return yield* next(e) // off/shadow (nothing to apply), a failed pick, or an unrouted turn
    if (!turn.model) {
      let id = modelIds.get(pick.apply)
      if (!id) {
        const m = await $.process.run(['node', script, 'model-id', pick.apply], { timeoutMs: 5000 }).catch(() => null)
        id = m?.exitCode === 0 ? m.stdout.trim() : ''
        if (id) modelIds.set(pick.apply, id)
      }
      turn.model = id || pick.apply // the bare alias is what claude --model accepted before WP-158
    }
    const effort = pick.applyEffort && EFFORTS.includes(pick.applyEffort) ? (pick.applyEffort as Efforts) : e.effort
    return yield* next({ ...e, model: turn.model, effort })
  })

  // WP-159's outcomes, per turn: an applied pick whose turn answered is 'ok'; a refusal or an API error on the
  // routed model is 'returned'. An interruption says nothing about the pick. Shadow/off picks apply nothing,
  // so they have no outcome to record.
  on('turn.complete', async ($, e, next) => {
    const t = turn
    if (!e.agentId && t?.id === e.turnId && t.pick?.apply && t.pick.ref && e.reason !== 'aborted') {
      turn = undefined
      await $.process.run(['node', `${$.plugin.root}/${ROUTE}`, 'outcome', t.pick.ref, e.reason === 'answer' ? 'ok' : 'returned', `turn ${e.reason}`], { timeoutMs: 8000 }).catch(() => null)
    }
    return next(e)
  })
}
