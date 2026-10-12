// WP-353: a paused/missing/exited local agent has no pane to stream or message; its panel is read-only.
export type StoredState = 'paused' | 'missing' | 'exited'
export interface StoredAgent { local: boolean; status: string; headless?: boolean }
export const storedMode = (a: StoredAgent): { state: StoredState; verb: 'Resume' | 'Respawn' } | null =>
  a.local && !a.headless && (a.status === 'paused' || a.status === 'missing' || a.status === 'exited')
    ? { state: a.status, verb: a.status === 'paused' ? 'Resume' : 'Respawn' } : null
