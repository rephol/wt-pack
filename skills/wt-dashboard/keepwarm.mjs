// WP-318: budgeted keepwarm. A long-lived agent's 1 h prompt cache is kept warm by the wt-mods keepwarm mod (a tool-less
// fork every ~50 idle minutes, inside a time-boxed window and a daily cap). This module owns the settings, the per-pane
// arm/off overrides and what the mod reports back; the mod does the deciding (skills/wt-mods/hooks/keepwarm.ts).
export const DEFAULTS = { enabled: false, roles: ['orchestrator', 'tech-lead', 'planner'], minContext: 50_000, intervalMin: 50, windowH: 3, dailyCap: 15 }
const ROLES = ['orchestrator', 'tech-lead', 'planner', 'worker', 'reviewer', 'auditor']
const bad = (m) => Object.assign(new Error(m), { status: 400 })
const int = (k, v, lo, hi) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${k}: a whole number ${lo}–${hi}`)
  return v
}

// Every bound is enforced here, so a PATCH with windowH 0, 13 or 2.5 is a 400 whatever the UI sends.
export function clean(b = {}) {
  const v = (k) => b[k] ?? DEFAULTS[k]
  if (typeof v('enabled') !== 'boolean') throw bad('enabled: true or false')
  const roles = v('roles')
  if (!Array.isArray(roles) || roles.some((r) => !ROLES.includes(r))) throw bad(`roles: any of ${ROLES.join(', ')}`)
  return {
    enabled: v('enabled'), roles: [...new Set(roles)],
    minContext: int('minContext', v('minContext'), 0, 10_000_000),
    intervalMin: int('intervalMin', v('intervalMin'), 5, 59), // a cache lives 1 h: never above 59
    windowH: int('windowH', v('windowH'), 1, 12),
    dailyCap: int('dailyCap', v('dailyCap'), 1, 1000),
  }
}

const dayOf = (now) => { const d = new Date(now); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }

export class Keepwarm {
  constructor({ settings = DEFAULTS, overrides = {}, now = Date.now } = {}) {
    this.settings = clean(settings)
    this.overrides = overrides // pane id → { armed: boolean, windowH?: number } (what the user set per agent; persisted)
    this.runs = new Map() // pane id → { state, nextAt, pings, day, spent, reason } (what the mod reported; memory only)
    this.now = now
  }
  snapshot() { return { settings: this.settings, overrides: this.overrides } }
  patch(b) { this.settings = clean({ ...this.settings, ...b }); return this.settings }

  // The user arms or turns off one pane. windowH is capped by the global ceiling (12 h) by clean().
  set(pane, action, windowH) {
    if (action === 'arm') this.overrides[pane] = { armed: true, ...(windowH === undefined ? {} : { windowH: int('windowH', windowH, 1, 12) }) }
    else if (action === 'off') { this.overrides[pane] = { armed: false }; this.runs.set(pane, { ...this.#run(pane), state: 'off', nextAt: null, reason: 'turned off' }) }
    else throw bad('action: arm or off')
  }
  #run(pane) {
    const r = this.runs.get(pane) ?? { state: 'off', nextAt: null, pings: 0, day: dayOf(this.now()), spent: 0, reason: null }
    return r.day === dayOf(this.now()) ? r : { ...r, pings: 0, day: dayOf(this.now()) }
  }

  // The config the pane's own mod follows: armed by the user, or enabled globally for its role.
  // paused (WP-348): the agent's project is paused, so nothing is pinged whatever was armed.
  effective(pane, role, paused = false) {
    const o = this.overrides[pane], s = this.settings
    const enabled = paused || o?.armed === false ? false : o?.armed === true || (s.enabled && s.roles.includes(role))
    return { enabled, intervalMin: s.intervalMin, minContext: s.minContext, windowH: o?.windowH ?? s.windowH, dailyCap: s.dailyCap, pingsToday: this.#run(pane).pings }
  }

  // event 'ping': { usage: { read, write }, nextAt } · 'stop': { reason, off? }. Anything else is a 400.
  report(pane, b) {
    const r = this.#run(pane)
    if (b.event === 'ping') {
      const u = b.usage ?? {}
      this.runs.set(pane, { ...r, state: 'warm', nextAt: Number(b.nextAt) || null, pings: r.pings + 1, spent: r.spent + (Number(u.read) || 0) + (Number(u.write) || 0), reason: null })
    } else if (b.event === 'stop') {
      this.runs.set(pane, { ...r, state: b.off ? 'off' : 'cold', nextAt: null, reason: String(b.reason ?? '').slice(0, 120) || null })
    } else throw bad('event: ping or stop')
  }

  // AgentInfo.keepwarm for a pane, or null when keepwarm does nothing for it.
  info(pane, role, paused = false) {
    const e = this.effective(pane, role, paused), r = this.runs.get(pane)
    if (!e.enabled && !r) return null
    return { state: e.enabled ? (r?.state ?? 'cold') : 'off', nextAt: r?.nextAt ?? null, pingsToday: e.pingsToday, spentTokens: r?.spent ?? 0, reason: r?.reason ?? (e.enabled && !r ? 'no ping yet' : null) }
  }
}
