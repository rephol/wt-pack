// WP-313: ONE AgentInfo for a pane agent and a headless run (types in contracts.d.mts). The server builds it here and nowhere else,
// from facts the callers gather (the herdr row + parsed pane, or the run row); the web consumes only this. Anything not known is
// null, never invented: a pane has no cost or plugin list, a run has no tags.
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' && v !== undefined ? Number(v) : null)
const arr = (j) => { try { const v = typeof j === 'string' ? JSON.parse(j) : j; return Array.isArray(v) ? v : null } catch { return null } }

// WP-201's rule (web/src/turns.ts contextUsage): used = the last turn's input + cache read + cache write; the window is 1M for a
// [1m] model or once any turn went past 200k, else 200k. `usage` = { in, cr, cw, peak } read from a transcript's tail.
// WP-314: a REPORTED window (a result event's modelUsage contextWindow, the pane's status line "x / 1M") wins; the rule above is the guess
// for when none was reported.
export const tokensOf = (s) => { const m = /^\s*([\d.]+)\s*([kKmM]?)/.exec(String(s ?? '')); return m ? Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] ?? 1)) : null }
export function contextOf(model, usage, reported = null) {
  if (!usage) return null
  const used = (num(usage.in) ?? 0) + (num(usage.cr) ?? 0) + (num(usage.cw) ?? 0)
  const window = num(reported) > 0 ? num(reported) : /\[1m\]/i.test(model ?? '') || used > 200_000 || (num(usage.peak) ?? 0) > 200_000 ? 1_000_000 : 200_000
  return { used, window, pct: Math.min(100, Math.round((used / window) * 100)) }
}
const ctx = (model, usage, fallbackPct, window) => {
  const c = contextOf(model, usage, window)
  return c ? { contextUsed: c.used, contextWindow: c.window, contextPct: c.pct }
    : { contextUsed: null, contextWindow: null, contextPct: num(fallbackPct) }
}

const core = (kind, f) => ({
  kind, key: f.key, name: f.name, role: f.role ?? null, persona: f.persona ?? null, cwd: f.cwd ?? null, project: f.project ?? null,
  state: f.state, model: f.model ?? null, effort: f.effort ?? null, effortSource: f.effortSource ?? null, permissionMode: f.permissionMode ?? null,
  plugins: f.plugins ?? null, sessionId: f.sessionId ?? null, commands: f.commands ?? null, skills: f.skills ?? null,
  ...ctx(f.model?.id ?? f.model?.name, f.usage, f.contextPct, f.contextWindow),
  costUsd: num(f.costUsd), turns: num(f.turns), startedAt: num(f.startedAt), lastActivity: num(f.lastActivity),
})

// a: the /api/agents row for a pane (model = agentModel()), usage: transcript tail usage or null.
export function paneInfo(a, usage = null, pid = null, keepwarm = null) { // pid: the live claude pid from `claude agents --json` (WP-324), null when unknown
  return {
    ...core('pane', {
      key: a.key, name: a.name, role: a.tags?.role ?? (a.pool !== 'other' ? a.pool : null), persona: a.tags?.persona, cwd: a.cwd, project: a.project,
      state: a.status, model: a.model ? { id: a.model.id ?? null, name: a.model.name ?? null } : null, effort: a.model?.effort, effortSource: a.model?.effortSource,
      sessionId: a.session, usage, contextPct: a.context?.pct, contextWindow: tokensOf(a.context?.total), lastActivity: a.lastActivity,
    }),
    pane: { id: a.id, machine: a.machine, local: a.local, tags: a.tags ?? {}, dnd: Boolean(a.tags?.dnd), pair: a.tags?.pair ?? null, workspace: a.workspace ?? null, pid, routed: a.model?.routed ?? null },
    keepwarm, // WP-318: { state: warm|cold|off, nextAt, pingsToday, spentTokens, reason } or null when keepwarm does nothing for this pane
  }
}

// r: a headless_runs row, state: the status the Agents list shows for it, usage: transcript tail usage or null.
export function headlessInfo(r, { key, state, project = null, usage = null } = {}) {
  const init = (() => { try { return JSON.parse(r.init_commands) } catch { return null } })()
  const model = r.init_model || r.model
  if (r.context_used != null) usage = { in: r.context_used, cr: 0, cw: 0, peak: r.context_used } // WP-315: the SDK driver reports the context itself
  return {
    ...core('headless', {
      key: key ?? r.id, name: r.name, role: r.role, persona: r.persona, cwd: r.cwd, project, state: state ?? 'idle',
      model: model ? { id: r.init_model ?? null, name: model } : null, effort: r.effort, permissionMode: r.permission_mode ?? r.req_permission_mode,
      plugins: arr(r.plugins), sessionId: r.session, commands: init ? arr(init.slash_commands) : null, skills: init ? arr(init.skills) : null,
      usage, contextWindow: r.context_window, costUsd: r.cost_usd, turns: r.turns, startedAt: r.started, lastActivity: r.last_event,
    }),
    run: { id: r.id, state: r.state, resumes: r.resumes ?? 0, stuck: r.stuck ?? null, reason: r.reason ?? null, pid: r.pid ?? null, driver: r.driver === 'sdk' ? 'sdk' : 'cli' },
  }
}
