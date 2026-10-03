// WP-211 — per-request model routing: the first model request of each main-loop turn is routed through
// model-route.mjs (Jev + the mode gate + sessionFloor), and the turn's remaining steps reuse that pick. In
// off/shadow `pick` applies nothing (shadow only logs the decision), so the request goes through untouched;
// only `live` rewrites model/effort. No routing logic here: the script owns the gate, floors and the log.
import type { Register } from 'claude-code'
import type { SkillsDir } from './commands'
import type { Hooks } from './compose'

const ROUTE = 'wt-shared/scripts/model-route.mjs'

type Pick = { apply: string | null; applyEffort: string | null; ref: string | null; source: string }
type Efforts = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

// `pick --json` stdout → the decision, or null when it is not one (a failed script never blocks a request).
export const parsePick = (stdout: string): Pick | null => {
  try {
    const d = JSON.parse(stdout)
    return { apply: typeof d.apply === 'string' ? d.apply : null, applyEffort: typeof d.applyEffort === 'string' ? d.applyEffort : null, ref: typeof d.ref === 'string' ? d.ref : null, source: String(d.source ?? '') }
  } catch { return null }
}

// The routing state, shared by the shared-event hooks (routingHooks) and the turn.step hook (registerRouting).
export const routingState = () => ({
  prompt: '', // the last submitted prompt: the task text for the next turn's first request
  turn: undefined as { id: string; pick: Pick | null; from?: string; model?: string } | undefined,
  modelIds: new Map<string, string>(),
})
type State = ReturnType<typeof routingState>

export const routingHooks = (st: State, skills: SkillsDir): Hooks => ({
  'prompt.submit': (_$, e, next) => {
    // Only a person's own prompt is a task: not a slash command, a background notification or a peer's message.
    const o = e.origin as { kind?: string; asUser?: boolean } | undefined // absent: the user's own
    const person = !o?.kind || o.kind === 'composer' || o.kind === 'bridge' || o.kind === 'sdk' || (o.kind === 'plugin' && o.asUser === true)
    if (person && !e.text.trimStart().startsWith('/')) st.prompt = e.text
    return next(e)
  },

  // WP-159's outcomes, per turn, deliberately thin: a routed turn that answered is 'ok', one the model refused is
  // 'returned' (the tier could not do it). An interruption or an API error says nothing about the pick. A shadow
  // pick applied nothing, so it records 'shadow-ok'/'shadow-returned' with the model that actually ran (WP-215):
  // the eval reads those apart from real outcomes, never as a verdict on the pick. An answer is a weak signal next to WP-159's "ticket
  // reached Done"; the per-turn log is for the tuning's volume, not a verdict.
  'turn.complete': async (ctx, e, next) => {
    const t = st.turn
    if (t && !e.agentId && t.id === e.turnId) {
      st.turn = undefined
      const pick = t.pick
      if (pick?.ref && !pick.source.startsWith('jev-failopen') && (e.reason === 'answer' || e.reason === 'refusal')) {
        const what = (pick.apply ? '' : 'shadow-') + (e.reason === 'answer' ? 'ok' : 'returned')
        await ctx.run(['node', `${skills(ctx.root)}/${ROUTE}`, 'outcome', pick.ref, what, `turn ${e.reason}${pick.apply ? '' : ` on ${t.from ?? '?'}`}`], { timeoutMs: 8000 }).catch(() => null)
      }
    }
    return next(e)
  },
})

export const registerRouting = (on: Parameters<Register>[0], st: State, skills: SkillsDir) => {
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e) // a subagent's tier is its Agent call's; this routes the main loop
    const script = `${skills($.plugin.root)}/${ROUTE}`
    if (e.index === 0 && st.prompt) {
      const text = st.prompt
      st.prompt = '' // a turn with no prompt of its own (a background wake-up) is not routed on a stale one
      const r = await $.process.run(['node', script, 'pick', '--skill', 'turn-step', '--session', '--json'], { stdin: text, timeoutMs: 8000 }).catch(() => null)
      st.turn = { id: e.turnId, pick: r?.exitCode === 0 ? parsePick(r.stdout) : null }
    }
    const turn = st.turn
    const pick = turn?.id === e.turnId ? turn.pick : null
    if (turn && pick) turn.from ??= e.model // the model that ran: a shadow outcome names it
    // Nothing to apply: off/shadow, a failed pick, an unrouted turn — or Jev being down (fail-open lands on
    // sonnet, which would silently downgrade a session that is on opus).
    if (!turn || !pick?.apply || pick.source.startsWith('jev-failopen')) return yield* next(e)
    turn.from ??= e.model
    if (e.model !== turn.from) return yield* next(e) // the engine switched model itself (a fallback): leave it
    if (!turn.model) {
      let id = st.modelIds.get(pick.apply)
      if (!id) {
        const m = await $.process.run(['node', script, 'model-id', pick.apply], { timeoutMs: 5000 }).catch(() => null)
        id = m?.exitCode === 0 ? m.stdout.trim() : ''
        if (id) st.modelIds.set(pick.apply, id)
      }
      if (!id) return yield* next(e) // no pinned id for the tier: an alias is not known to be valid here
      turn.model = id + (e.model.match(/\[[^\]]+\]$/)?.[0] ?? '') // keep a [1m]-style variant suffix
    }
    const effort = pick.applyEffort && EFFORTS.includes(pick.applyEffort) ? (pick.applyEffort as Efforts) : e.effort
    return yield* next({ ...e, model: turn.model, effort })
  })
}
