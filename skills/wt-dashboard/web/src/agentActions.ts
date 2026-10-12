// WP-351: which lifecycle actions an agent's menu offers, per state. One source for the list row menu and the panel menu.
// Remove needs a live pane (an id); a stored row (paused/missing/exited) has none, so it gets Forget instead.
export type ActionId = 'pause' | 'remove' | 'remove-remote' | 'resume' | 'respawn' | 'forget' | 'forget-confirm' | 'stop'
export interface ActionAgent { local: boolean; status: string; id: string | null; headless?: boolean }
export function agentActions(a: ActionAgent, opts: { canStop?: boolean } = {}): ActionId[] {
  if (!a.local) return ['remove-remote']
  if (a.headless) return opts.canStop ? ['stop'] : []
  if (a.status === 'paused') return ['resume', 'forget-confirm']
  if (a.status === 'missing' || a.status === 'exited') return ['respawn', 'forget']
  return ['pause', ...(a.id ? ['remove' as const] : [])]
}
