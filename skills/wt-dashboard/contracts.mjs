// WP-254: the dashboard API's shared vocabulary, in one dependency-free module that both the server modules and the web
// app import (the web gets its types from contracts.d.mts, which sits beside this file). Before this the same lists were
// copied in tickets.mjs / boardData.ts and inbox.mjs / notifyGate.ts, and had drifted ('jev-auth' was emitted by the server
// but missing from its own KINDS). Add an enum value here and in contracts.d.mts; contracts.test.mjs fails if they differ
// or if a copy of a list creeps back into another file. Started with tickets, inbox and rooms; other areas follow.
const freeze = (a) => Object.freeze([...a])

export const COLUMNS = freeze(['backlog', 'ready', 'planning', 'building', 'review', 'done', 'blocked', 'cancelled'])
// WP-276: Done and Cancelled are the terminal columns; nothing schedules, sweeps or counts a closed card.
export const isClosed = (column) => column === 'done' || column === 'cancelled'
export const TYPES = freeze(['bug', 'ux', 'gap', 'debt', 'feature'])
export const SIZES = freeze(['S', 'M', 'L'])

export const KINDS = freeze(['needs-you', 'question', 'mention-user', 'room-suggestion', 'agent-done', 'agent-stalled', 'ci-failed', 'server', 'usage', 'room-created', 'memory', 'memory-proposal', 'watchdog', 'pr-held', 'routing-escalation', 'jev-auth', 'pair-gone', 'dispatch-undelivered', 'ask'])
// The kinds that need the user (badge, Inbox "Needs you", Overview tile).
export const ACTIONABLE_KINDS = freeze(['needs-you', 'question', 'mention-user', 'room-suggestion', 'memory-proposal', 'pr-held', 'routing-escalation', 'ask'])

// WP-271: the Settings > Notifications sections. A kind is "Agents" if listed here, else "Needs you" when actionable,
// else "System", so a new kind needs no change in the push code (only here, if it belongs under Agents).
const AGENT_KINDS = freeze(['agent-done', 'agent-stalled', 'ci-failed', 'room-suggestion', 'memory', 'room-created', 'pair-gone', 'dispatch-undelivered'])
export const categoryOf = (kind) => AGENT_KINDS.includes(kind) ? 'agents' : ACTIONABLE_KINDS.includes(kind) ? 'needs-you' : 'system'

// A value must be one of `list`; the error has the `{ status: 400 }` shape the API's routes already use.
export function oneOf(list, v, field) {
  if (!list.includes(v)) throw Object.assign(new Error(`${field}: ${list.join(' | ')}`), { status: 400 })
  return v
}
