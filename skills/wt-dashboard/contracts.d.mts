// Types for contracts.mjs, and the API response shapes the server writes and the web reads (WP-254). TypeScript
// resolves this file for `import ... from '.../contracts.mjs'`, so the web needs no allowJs. contracts.test.mjs checks that
// every `declare const` below equals the runtime array, so the two cannot drift.
export declare const COLUMNS: readonly ['backlog', 'ready', 'planning', 'building', 'review', 'done', 'blocked', 'cancelled']
export type Column = (typeof COLUMNS)[number]
export declare function isClosed(column: string | undefined): boolean
export declare const TYPES: readonly ['bug', 'ux', 'gap', 'debt', 'feature']
export declare const SIZES: readonly ['S', 'M', 'L']
export declare const KINDS: readonly ['needs-you', 'question', 'mention-user', 'room-suggestion', 'agent-done', 'agent-stalled', 'ci-failed', 'server', 'usage', 'room-created', 'memory', 'memory-proposal', 'watchdog', 'pr-held', 'routing-escalation', 'jev-auth', 'pair-gone', 'dispatch-undelivered', 'ask', 'headless-ask']
export type Kind = (typeof KINDS)[number]
export declare const ACTIONABLE_KINDS: readonly ['needs-you', 'question', 'mention-user', 'room-suggestion', 'memory-proposal', 'pr-held', 'routing-escalation', 'ask', 'headless-ask']
export type Category = 'needs-you' | 'agents' | 'system'
export declare function categoryOf(kind: string): Category

// ---- tickets (tickets.mjs; GET/PATCH /api/tickets) ----
export interface HistoryEntry { at: string; author: string; kind: 'create' | 'move' | 'comment' | 'edit' | 'assign' | 'pair'; from?: unknown; to?: unknown; text?: string }
// WP-147: worker + buddy pairing. `buddy` is optional (the worker may pair alone); a gone member without a
// replacement leaves that side null but the pairing itself stays until the ticket is Done.
export interface TicketPair { worker: { name: string; pane: string } | null; buddy?: { name: string; pane: string; role: string } | null }
export interface Ticket {
  id: string
  title: string
  body?: string
  type?: string | null
  size?: string | null
  priority?: number | null
  labels?: string[]
  links?: string[]
  column: Column
  assignee?: { name: string; pane?: string } | null
  pair?: TicketPair | null
  created?: string
  updated?: string
  history?: HistoryEntry[]
  jev?: TicketJev | null
  dispatch?: TicketDispatch | null
  messages?: TicketMessages | null
}
// WP-257 (messages.mjs): the newest wt-pack message sent about this card, and how many are still unacknowledged.
export interface TicketMessages { last: { id: string; kind: string; state: 'queued' | 'delivered' | 'acknowledged' | 'answered' | 'expired' | 'failed'; attempts: number; target: string }; open: number }
// Board Dispatch (WP-52, dispatch.mjs): claim state, failures, and reconcile's stall flag. `undelivered`
// (WP-177) is distinct from `stalled`: a handoff that never reached the agent at all (resend already tried),
// not a long-idle one that did.
export interface TicketDispatch { state?: 'dispatching' | 'sent' | 'failed' | 'held' | 'interrupted'; at?: string; agent?: string; fails?: number; reason?: string; stalled?: string; undelivered?: string }
export interface DispatchStatus { last: { at: number; text: string } | null; waiting: string | null; inflight: number }
export interface TicketJev { at: string; applied: Record<string, { from: unknown; to: unknown }>; owner: 'planner' | 'worker' | null; dupes: string[] }
export interface Board { key: string | null; auto?: boolean; minPriority?: number; dispatch?: boolean; stallMin?: number; reportRoom?: string | null; reportOrch?: boolean; dispatchStatus?: DispatchStatus; tickets: Ticket[] }

// ---- inbox (inbox.mjs; GET /api/notifications) ----
export interface InboxItem {
  id: string; ts: string; kind: Kind; key: string; title: string; body: string; read: boolean; resolvedAt: string | null; quiet?: boolean
  urgency?: number // 0-3 from Jev (WT_JEV_INBOX_RANK); absent sorts as 1
  target: { agent?: string; room?: string; task?: string; pr?: string; url?: string | null; memory?: string; watchdog?: string; check?: string; ask?: string }
}

// ---- rooms (rooms.mjs; GET /api/rooms) ----
export interface Room { slug: string; title: string; project: string | null; createdAt: string; paused: boolean; archived?: boolean; members: string[]; hops: number; responder?: string | null; responderName?: string | null; responderPinned?: boolean; broadcast?: boolean; needsYou?: { agent: string; text: string }[]; lastAt?: string | null; lastFrom?: string | null; lastText?: string | null }
export interface RoomMsg {
  id: string; ts: string; text: string; mentions: string[]; deliveredTo: string[]
  author: { kind: 'user' | 'agent' | 'system'; name: string; machine?: string; avatar?: string | null }
  blocked?: { name: string; reason: string }[]
  queuedFor?: string[]; notified?: boolean
  attachments?: { path: string; type: string; size: number; name?: string }[]; undelivered?: { to: string; n: number }[]
  command?: { text: string; target: string }; agentKey?: string
  replyTo?: { id: string; name: string; text: string }
}

// ---- agents (agentinfo.mjs; `info` on every GET /api/agents row and GET /api/headless[/:id], WP-313) ----
export type AgentKind = 'pane' | 'headless'
export type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown' | 'exited' | 'paused' | 'missing' // paused/missing: WP-348 stored rows
// What an agent is and runs on, the same for a herdr pane and a headless run. Unknown = null (never invented): a pane has no
// cost, plugin list or command list; a run has no tags.
export interface AgentInfoCore {
  key: string; name: string; role: string | null; persona: string | null; cwd: string | null; project: string | null
  state: AgentState
  model: { id: string | null; name: string | null } | null // the resolved model
  effort: string | null
  effortSource: string | null // 'footer' | 'token' | 'default' (a configured default, not what the session reports); null = unknown
  permissionMode: string | null
  plugins: string[] | null
  sessionId: string | null
  commands: string[] | null; skills: string[] | null
  contextUsed: number | null; contextWindow: number | null; contextPct: number | null
  costUsd: number | null; turns: number | null
  startedAt: number | null; lastActivity: number | null
}
export interface PaneAgentInfo extends AgentInfoCore {
  kind: 'pane'
  pane: { id: string; machine: string; local: boolean; tags: Record<string, string>; dnd: boolean; pair: string | null; workspace: string | null; pid: number | null /* live claude pid (claude agents --json), WP-324 */; routed: string | null /* the tier asked for when it differs from what runs */ }
  stableKey: string // WP-348: the agents-table key (the agent's name), stable across a pane-id change
  table: { state: 'running' | 'idle' | 'paused' | 'exited' | 'missing'; pausedAt: number | null; goneAt: number | null } | null // WP-348: its durable row
  keepwarm: { state: 'warm' | 'cold' | 'off'; nextAt: number | null; pingsToday: number; spentTokens: number; reason: string | null } | null // WP-318
  modLive: boolean | null // WP-352: the pane's wt-deliver mod said hello within LIVE_MS (null: unknown / not a local pane)
}
export interface HeadlessAgentInfo extends AgentInfoCore {
  kind: 'headless'
  run: { id: string; state: string; resumes: number; stuck: number | null; reason: string | null; pid: number | null; driver: 'cli' | 'sdk' /* WP-316: what runs it; NULL in the column = cli */ }
}
export type AgentInfo = PaneAgentInfo | HeadlessAgentInfo
export declare const AGENT_INFO_KINDS: readonly ['pane', 'headless']
