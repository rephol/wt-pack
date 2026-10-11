// WP-318: Settings › Keepwarm. The pure part: the window choices and the draft → PATCH body (the server re-checks every bound).
export type KwSettings = { enabled: boolean; roles: string[]; minContext: number; intervalMin: number; windowH: number; dailyCap: number }
export const KW_ROLES = ['orchestrator', 'tech-lead', 'planner', 'worker', 'reviewer', 'auditor']
export const WINDOW_HOURS = Array.from({ length: 12 }, (_, i) => i + 1) // 1..12 h, whole hours only

// Draft strings from the form → numbers; a blank or non-numeric field is NaN and the server answers 400 with its own message.
export const toBody = (d: { enabled: boolean; roles: string[]; minContext: string; intervalMin: string; windowH: string; dailyCap: string }): KwSettings => ({
  enabled: d.enabled, roles: d.roles, minContext: Number(d.minContext), intervalMin: Number(d.intervalMin), windowH: Number(d.windowH), dailyCap: Number(d.dailyCap),
})
