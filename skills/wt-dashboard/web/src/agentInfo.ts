// WP-313: what the Agents list, Summary and Conversation show of an agent comes from its AgentInfo (contracts.d.mts), whatever
// its kind. Pure helpers, so the same text is tested once.
import type { AgentInfo } from '../../contracts.mjs'

export type { AgentInfo, AgentKind } from '../../contracts.mjs'
export const kindOf = (a: { info?: AgentInfo | null; headless?: boolean }) => a.info?.kind ?? (a.headless ? 'headless' : 'pane')

// 'Sonnet 5.5 · medium (default)': the model's name, then the effort when known.
export const modelLabel = (i?: AgentInfo | null) => {
  const m = i?.model, name = m?.name ?? m?.id
  return name ? (i?.effort ? `${name} · ${i.effort}${i.effortSource === 'default' ? ' (default)' : ''}` : name) : i?.effort ?? ''
}
export const fmtTok = (n: number) => (n >= 1_000_000 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
export const contextLabel = (i: AgentInfo) => (i.contextPct == null ? null : i.contextUsed != null && i.contextWindow ? `${i.contextPct}% · ${fmtTok(i.contextUsed)} / ${fmtTok(i.contextWindow)}` : `${i.contextPct}%`)

// The Model section's rows, in order; a row whose value is unknown (null) is left out, never shown as 0 or '—'.
export function modelRows(i: AgentInfo): [string, string][] {
  const rows: [string, string | null][] = [
    ['Running', modelLabel(i) || null],
    ['Driver', i.kind === 'headless' ? i.run.driver : null], // a pane has no driver
    ['Permissions', i.permissionMode],
    ['Session', i.sessionId ? i.sessionId.slice(0, 8) : null],
    ['Turns', i.turns != null ? String(i.turns) : null],
    ['Cost', i.costUsd != null ? `$${i.costUsd.toFixed(2)}` : null],
    ['Plugins', i.plugins ? `${i.plugins.length}: ${i.plugins.join(', ')}` : null],
    ['Commands', i.commands || i.skills ? `${i.commands?.length ?? 0} commands · ${i.skills?.length ?? 0} skills` : null],
  ]
  return rows.filter((r): r is [string, string] => r[1] != null)
}
