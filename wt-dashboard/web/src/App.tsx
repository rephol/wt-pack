import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea'
import { isUserSkip } from './pickerGuard.ts'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppShell } from '@astryxdesign/core/AppShell'
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { Card } from '@astryxdesign/core/Card'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Icon } from '@astryxdesign/core/Icon'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell } from '@astryxdesign/core/Table'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { ServerStatus } from './status'
import { ImageRow, FileCards, useAttachments, IMAGE_TYPES, MAX_IMAGES, type SharedFile } from './attachments'
import { useToast } from '@astryxdesign/core/Toast'
import { useDesktop } from './desktop'
import { SettingsHost, openSettings } from './settings'
import { InboxButton, InboxHost } from './inbox'
import { RoomsPage, useRoomsList } from './rooms'
import { composerEnter } from './keys'
import { commandSource, type Command } from './commands'
import { UsagePanel } from './usage'
import { SpawnHost, RemoveHost, openSpawn, openRemove, takePrefill } from './spawn'
import { Stepper, Step } from '@astryxdesign/core/Stepper'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { TabList, Tab } from '@astryxdesign/core/TabList'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Text } from '@astryxdesign/core/Text'
import { Heading } from '@astryxdesign/core/Heading'
import { Link } from '@astryxdesign/core/Link'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Spinner } from '@astryxdesign/core/Spinner'
import { ChatMarkdown } from './links'
import { useChatDensity } from './density'
import { LinkPreviews } from './previews'
import { useRoles, plural, RoleBadge, TagsDialog, TagList, OTHER } from './roles'
import { Delayed, LoadError, OverviewSkeleton, GroupedRows, Rows, ChatSkeleton } from './skeletons'
import { useStream, mergeAgentMsgs } from './streamStore'
import { deriveMeta, toolGroupMeta, callDurations, fmtTokens, fmtDur, shortModel, fmtWhen, contextUsage, type Meta, type Usage } from './turns'
import { VirtualRows } from './virtual'
import { TerminalsPage, TerminalView, useTermSettings } from './terminals'
import { PwaHost, InstallHint } from './pwa'
import { openInbox } from './inbox'
import { sortAgents, initialSort, activityOf, projectCounts, countTooltip, type AgentSort } from './agentSort'
import { shortAgo } from './notifyGate'
import { QuickSwitcher, rememberRecent } from './switcher'
import { Layout, LayoutContent, LayoutPanel } from '@astryxdesign/core/Layout'
import { useResizable, ResizeHandle } from '@astryxdesign/core/Resizable'
import { Grid } from '@astryxdesign/core/Grid'
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList'
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { Popover } from '@astryxdesign/core/Popover'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { CodeBlock } from '@astryxdesign/core/CodeBlock'
import { Thumbnail } from '@astryxdesign/core/Thumbnail'
import { ChatLayout, ChatMessageList, ChatMessage, ChatMessageBubble, ChatComposer, ChatComposerInput, ChatComposerDrawer, ChatSendButton, ChatToolCalls, type ChatToolCallItem, type ChatComposerTrigger, type ChatComposerInputHandle } from '@astryxdesign/core/Chat'
import { TypeaheadItem } from '@astryxdesign/core/Typeahead'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'

// ---------- types (mirror server.mjs) ----------
type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
interface Agent {
  background: number // shells/tasks still running after the turn (Stop does not end them)
  key: string
  id: string
  machine: string
  project: string | null
  local: boolean
  name: string
  pool: string
  roleBy?: 'token' | 'workspace' | 'name' | 'none'
  tags?: Record<string, string>
  workspace?: string | null
  status: AgentStatus
  statusSince: number
  cwd: string
  recap: string | null
  context: { used: string; total: string; pct: number } | null
  asks: boolean
  question: string | null
  lastPrompt: string | null
  session: string | null
  lastActivity?: number
  picker?: Picker | null
  task: string | null
}
type TaskState =
  | 'needs_you' | 'stalled' | 'shipped' | 'merged' | 'in_review'
  | 'building' | 'plan_ready' | 'planning' | 'done' | 'queued'
interface PR {
  number: number
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  ci: 'pass' | 'fail' | 'pending' | null
  review: string | null
}
interface Task extends Record<string, unknown> {
  id: string
  title: string
  url: string | null
  state: TaskState
  agent: { key: string; id: string; name: string; machine: string } | null
  project: string | null
  question: string | null
  branch: string | null
  plan: string | null
  pr: PR | null
  updatedAt: string | null
  adHoc: boolean
}
interface Overview {
  at: string
  linearEnabled: boolean
  agents: Agent[]
  tasks: Task[]
  machines: Machine[]
  counts: { needsYou: number; stalled: number; building: number; inReview: number; idleAgents: number }
}
interface Machine {
  label: string
  host: string
  local: boolean
  status: 'online' | 'offline' | 'stale' | 'connecting' | 'disabled'
  lastSeen: number | null
  error: string | null
  working: number
  idle: number
  total: number
}
interface AskQ { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string; preview?: string }[] }
interface Msg {
  id: string; role: 'user' | 'assistant' | 'tool' | 'question'; text: string; tool?: { name: string; summary: string }; images?: string[]; files?: SharedFile[]; caption?: string | null; ts: string
  questions?: AskQ[]; answered?: boolean; answers?: Record<string, string>; cancelled?: boolean
  src?: string; meta?: Usage; toolUseId?: string; isError?: boolean
}
interface Picker {
  review: boolean
  tabs: { header: string; done: boolean }[]
  current?: number
  question?: string
  multiSelect?: boolean
  options?: { label: string; description: string; checked: boolean }[]
  other?: string | null
  layout?: 'preview'
  preview?: string
  answers?: { question: string; answer: string }[]
}

// ---------- api ----------
async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}
const agentUrl = (a: Agent) => `/api/agents/${encodeURIComponent(a.machine)}/${encodeURIComponent(a.id)}`
async function postAgent(a: Agent, body: { text?: string; keys?: string[] }) {
  const r = await fetch(agentUrl(a), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
}

// ---------- presentation maps ----------
type Dot = 'success' | 'warning' | 'error' | 'accent' | 'neutral'
const STATE: Record<TaskState, { label: string; dot: Dot; group: 'active' | 'review' | 'done' }> = {
  needs_you: { label: 'Needs you', dot: 'error', group: 'active' },
  stalled: { label: 'Stalled', dot: 'warning', group: 'active' },
  building: { label: 'Building', dot: 'accent', group: 'active' },
  plan_ready: { label: 'Plan ready', dot: 'success', group: 'active' },
  planning: { label: 'Planning', dot: 'accent', group: 'active' },
  queued: { label: 'Queued', dot: 'neutral', group: 'active' },
  in_review: { label: 'In review', dot: 'accent', group: 'review' },
  merged: { label: 'Merged', dot: 'success', group: 'done' },
  shipped: { label: 'Shipped', dot: 'success', group: 'done' },
  done: { label: 'Done', dot: 'neutral', group: 'done' },
}
const STATE_ORDER = Object.keys(STATE) as TaskState[]
const AGENT_DOT: Record<AgentStatus, Dot> = { working: 'accent', idle: 'neutral', blocked: 'error', done: 'success', unknown: 'neutral' }

const lastActive = (a: Agent) => shortAgo(new Date(a.lastActivity || a.statusSince).toISOString())
const BackIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
const ExpandIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
// The right panel (agent or terminal): its handle is on the panel's LEFT edge, so dragging left must widen it
// (isReversed); double-click puts it back to this width.
const PANEL_DEFAULT = 480
// Pinned above the composer while the agent works: Claude Code's own spinner line from the pane ("✻ Synthesizing…
// (10s · ↓ 391 tokens)"), else the newest tool call, else "Working…"; "Waiting for you" while a question is open.
function ActivityRow({ agent, lastTool }: { agent: Agent; lastTool: string | null }) {
  const working = agent.status === 'working'
  const waiting = needsYou(agent)
  const act = useQuery({
    queryKey: ['activity', agent.key],
    queryFn: () => getJSON<{ text: string; detail: string | null } | null>(`${agentUrl(agent)}/activity`),
    enabled: working,
    refetchInterval: working ? 1500 : false,
  })
  const [, tick] = useState(0)
  useEffect(() => { if (!working) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t) }, [working])
  if (!working && !waiting) return null
  const elapsed = Math.max(0, Math.round((Date.now() - agent.statusSince) / 1000))
  const el = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
  const text = waiting ? 'Waiting for you' : act.data?.text ?? lastTool ?? 'Working…'
  const detail = waiting ? null : act.data?.detail ?? el
  return (
    <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 12px', marginTop: 12, minWidth: 0 }}>
      {waiting ? <StatusDot variant="error" label="waiting for you" isPulsing /> : <Spinner size="md" shade="subtle" aria-label="working" />}
      <Text size="sm" type="supporting" maxLines={1} hasTruncateTooltip={false} style={{ minWidth: 0, flex: 1 }}>
        {detail && !waiting && act.data?.detail ? `${text} (${detail})` : text}
      </Text>
      {agent.background > 0 && <Badge label={`${agent.background} bg`} />}
      {!waiting && <Text size="sm" type="supporting" style={{ flexShrink: 0 }}>{el}</Text>}
    </div>
  )
}

const idleFor = (a: Agent) => {
  const m = Math.floor((Date.now() - a.statusSince) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// ---------- app ----------
type Page = 'overview' | 'tasks' | 'agents' | 'rooms' | 'terminals'
// Project scope: ?project= wins, then localStorage, else all.
const initialProject = () => {
  const q = new URLSearchParams(location.search).get('project')
  if (q) return q
  try { return localStorage.getItem('project') ?? 'all' } catch { return 'all' }
}
function scopeToProject(o: Overview, project: string): Overview & { allProjects: boolean } {
  if (project === 'all') return { ...o, allProjects: true }
  const agents = o.agents.filter((a) => a.project === project)
  const tasks = o.tasks.filter((t) => t.project === project)
  const n = (s: TaskState) => tasks.filter((t) => t.state === s).length
  return {
    ...o,
    allProjects: false,
    agents,
    tasks,
    machines: o.machines.map((m) => {
      const mine = agents.filter((a) => a.machine === m.label)
      return { ...m, total: mine.length, working: mine.filter((a) => a.status === 'working').length, idle: mine.filter((a) => a.status === 'idle').length }
    }),
    counts: { needsYou: n('needs_you'), stalled: n('stalled'), building: n('building'), inReview: n('in_review'), idleAgents: agents.filter((a) => a.status === 'idle').length },
  }
}
const activeTasks = (ts: Task[]) => ts.filter((t) => STATE[t.state].group !== 'done')
const initials = (name: string) => name.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(-2).map((w) => w[0].toUpperCase()).join('')
function useNarrow(q = '(max-width: 899px)') {
  const [n, setN] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q)
    const on = () => setN(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return n
}
// Nav icons: tiny inline SVGs (Astryx's semantic set has no grid/list/people). `dot` = collapsed count badge.
type SvgProps = import('react').SVGProps<SVGSVGElement>
const iconCache = new Map<string, (p: SvgProps) => import('react').ReactElement>()
function svgIcon(key: string, body: (dot: boolean) => import('react').ReactNode, dot: boolean, dotColor = 'var(--color-icon-error, #e5484d)') {
  const k = `${key}:${dot}`
  if (!iconCache.has(k))
    iconCache.set(k, (p: SvgProps) => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" {...p}>
        {body(dot)}
        {dot && <circle cx="20" cy="4" r="3.5" fill={dotColor} stroke="none" />}
      </svg>
    ))
  return iconCache.get(k)!
}
const NAV_PATHS: Record<string, import('react').ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  tasks: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth={3} /></>,
  rooms: <><path d="M4 5h16v10H9l-5 4z" /><path d="M8 9h8M8 12h5" /></>,
  terminals: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M12 15h5" /></>,
  agents: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.9 2.6 2.7 3 5.2" /></>,
}
const navIcon = (page: string, dot: boolean) => svgIcon(page, () => NAV_PATHS[page], dot)
const initialsIcon = (text: string, dot: boolean) =>
  svgIcon(`t:${text}`, () => (
    <text x="12" y="16.5" textAnchor="middle" fontSize={text.length > 1 ? 10 : 13} fontWeight={700} fill="currentColor" stroke="none">{text}</text>
  ), dot, 'currentColor')

const termFromHash = () => decodeURIComponent(location.hash.match(/^#terminals\/(.+)$/)?.[1] ?? '') || null
const roomFromHash = () => decodeURIComponent(location.hash.match(/^#rooms\/(.+)$/)?.[1] ?? '') || null
// Full-page conversation: #agents/<machine>/<pane> (hash route like #rooms/<slug>, so a reload or the tailnet
// URL needs no server fallback). Returns the agent key `${machine}/${pane}`.
const agentFromHash = () => {
  const m = location.hash.match(/^#agents\/([^/]+)\/([^/]+)$/)
  return m ? `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}` : null
}
const agentHash = (key: string) => { const i = key.indexOf('/'); return `agents/${encodeURIComponent(key.slice(0, i))}/${encodeURIComponent(key.slice(i + 1))}` }
// Where the full page's Back goes: set when we navigate in-app, so Back is history.back(); a deep link has none.
let fullBack = false
const pageFromHash = (): Page => {
  const h = location.hash.slice(1)
  return h === 'tasks' ? h : h.startsWith('agents') ? 'agents' : h.startsWith('rooms') ? 'rooms' : h.startsWith('terminals') ? 'terminals' : 'overview'
}

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash)
  const [linearHidden, setLinearHidden] = useState(() => { try { return localStorage.getItem('linear-banner-hidden') === '1' } catch { return false } })
  const hideLinear = () => { setLinearHidden(true); try { localStorage.setItem('linear-banner-hidden', '1') } catch { /* private mode */ } }
  const [roomSlug, setRoomSlug] = useState<string | null>(roomFromHash)
  const [fullKey, setFullKey] = useState<string | null>(agentFromHash)
  const [termPage, setTermPage] = useState<string | null>(termFromHash)
  const termSettings = useTermSettings()
  const termsOn = Boolean(termSettings.data?.enabled)
  const roomsQ = useRoomsList()
  const suggested = new Set((roomsQ.data?.suggestions ?? []).map((x) => x.ticket))
  const [openPane, setOpenPane] = useState<string | null>(null)
  useEffect(() => {
    const on = () => { setPage(pageFromHash()); setRoomSlug(roomFromHash()); setFullKey(agentFromHash()); setTermPage(termFromHash()) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])

  const q = useQuery({
    queryKey: ['overview'],
    queryFn: () => getJSON<Overview>('/api/overview'),
    refetchInterval: 4000,
    placeholderData: keepPreviousData,
  })
  const all = q.data
  const [project, setProjectState] = useState<string>(initialProject)
  const setProject = (p: string) => {
    setProjectState(p)
    const u = new URL(location.href)
    if (p === 'all') u.searchParams.delete('project')
    else u.searchParams.set('project', p)
    history.replaceState(null, '', u)
    try { localStorage.setItem('project', p) } catch { /* private mode */ }
  }
  const data = useMemo(() => (all ? scopeToProject(all, project) : undefined), [all, project])
  // Sidebar badges count AGENTS (same list and project field as the Agents page); tasks are not counted.
  const counts = useMemo(() => projectCounts(all?.agents ?? [], [...new Set(activeTasks(all?.tasks ?? []).map((t) => t.project).filter((p): p is string => Boolean(p)))]), [all])
  const openAgent = all?.agents.find((a) => a.key === openPane) ?? null
  const narrow = useNarrow()
  const phone = useNarrow('(max-width: 639px)')
  const mobileNav = useNarrow('(max-width: 1023px)') // AppShell mobileNav breakpoint 'lg'
  const panel = useResizable({ defaultSize: PANEL_DEFAULT, minSize: 380, maxSize: Math.max(400, Math.round(window.innerWidth / 2)), autoSaveId: 'agent-panel-width' })
  // The agent panel is shown or hidden (no rail); `]` / Esc / X hide it, selecting an agent shows it.
  // ponytail: the old rail state is not carried over — the stored key is dropped and every load starts hidden.
  const [collapsed, setCollapsedState] = useState(() => { try { localStorage.removeItem('agent-panel-collapsed') } catch { /* private mode */ } return false })
  const setCollapsed = (c: boolean) => {
    setCollapsedState(c)
  }
  const [navCollapsed, setNavCollapsedState] = useState(() => { try { return localStorage.getItem('nav-collapsed') === '1' } catch { return false } })
  const setNavCollapsed = (c: boolean) => {
    setNavCollapsedState(c)
    try { localStorage.setItem('nav-collapsed', c ? '1' : '0') } catch { /* private mode */ }
  }
  const open = (key: string) => {
    if (key.startsWith('room:')) { location.hash = `rooms/${encodeURIComponent(key.slice(5).split(':')[0])}`; return }
    if (key.startsWith('term:')) {
      if (narrow) { location.hash = `terminals/${encodeURIComponent(key.slice(5))}`; return }
      setOpenPane(key); setCollapsed(false); return
    }
    if (narrow) { openFull(key); return }
    setOpenPane(key); setCollapsed(false); rememberRecent(key)
  }
  const openFull = (key: string) => {
    rememberRecent(key)
    setCollapsed(true) // the panel is never open alongside the full page
    fullBack = true
    location.hash = agentHash(key)
  }
  const leaveFull = () => { if (fullBack) { fullBack = false; history.back() } else location.hash = 'agents' }
  const fullToPanel = (key: string) => { leaveFull(); setOpenPane(key); setCollapsed(false) }
  const fullAgent = fullKey ? all?.agents.find((a) => a.key === fullKey) ?? null : null
  useEffect(() => {
    if (!fullKey) return
    const prev = document.title
    document.title = fullAgent?.name ?? 'Agent not found'
    return () => { document.title = prev }
  }, [fullKey, fullAgent?.name])
  // The quick-switcher button stays off the agent panel (open, desktop) and a room's composer.
  const openTerm = openPane?.startsWith('term:') ? openPane.slice(5) : null
  const fabHidden = (page === 'rooms' && !!roomSlug) || !!fullKey || !!termPage || (!!openTerm && !narrow && !collapsed) || (!!openAgent && !narrow && !collapsed)
  useDesktop(collapsed ? null : openPane, open)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      const typing = el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
      if (e.key === ']' && !typing && openPane && !fullKey) setCollapsed(!collapsed)
      if (e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey) && openPane && !collapsed && !fullKey) { e.preventDefault(); openFull(openPane) }
      if (e.key === '[' && !typing) setNavCollapsed(!navCollapsed)
      // Esc inside the panel collapses it, unless something (a menu) already handled it.
      if (e.key === 'Escape' && !e.defaultPrevented && !el.closest('dialog') && openPane && !collapsed && el.closest('[data-agent-panel]')) setCollapsed(true)
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  })

  const projectRows = [['all', 'All projects', counts.all] as const, ...counts.by.map(([p, c]) => [p, p, c] as const)]
  const current = projectRows.find(([v]) => v === project) ?? projectRows[0]
  const countsEnd = (c: typeof counts.all) => (
    <HStack gap={1} align="center">
      {c.needs > 0 && <StatusDot variant="error" label={`${c.needs} need you`} />}
      {c.working > 0 && <Text type="supporting" size="sm">{`${c.working}▸`}</Text>}
      <Badge label={String(c.agents)} />
    </HStack>
  )
  const projectIcon = (v: string, label: string, dot: boolean) => initialsIcon(v === 'all' ? '*' : initials(label), dot)
  const projectPicker = (
    <div className="hd-project-picker"><DropdownMenu hasChevron={!navCollapsed} menuWidth={260}
      button={{ label: navCollapsed ? `Project: ${current[1]}` : current[1], icon: current[0] === 'all' && !navCollapsed ? undefined : <Icon icon={projectIcon(current[0], current[1], navCollapsed && current[2].needs > 0)} />, isIconOnly: navCollapsed, size: 'sm', variant: 'ghost', width: navCollapsed ? undefined : '100%' }}
      items={projectRows.map(([v, label, c]) => ({ id: v, label, icon: projectIcon(v, label, false), endContent: <Tooltip content={countTooltip(c)}>{countsEnd(c)}</Tooltip>, onClick: () => setProject(v) }))} /></div>
  )
  const [sideList, setSideListState] = useState<'agents' | 'rooms'>(() => { try { return localStorage.getItem('nav-list') === 'rooms' ? 'rooms' : 'agents' } catch { return 'agents' } })
  const setSideList = (v: string) => {
    const s = v === 'rooms' ? 'rooms' : 'agents'
    setSideListState(s)
    try { localStorage.setItem('nav-list', s) } catch { /* private mode */ }
  }
  const sideRooms = (roomsQ.data?.rooms ?? []).filter((r) => !r.archived && (project === 'all' || r.project === project))
    .sort((x, y) => Number(Boolean(y.needsYou?.length)) - Number(Boolean(x.needsYou?.length)))

  const nav = (
    <SideNav
      // Mobile top bar and drawer (below AppShell's lg breakpoint): the project picker alone, one row; the title is desktop-only.
      header={mobileNav ? projectPicker : <VStack gap={1}><SideNavHeading heading="wt-dashboard" subheading="herdr · umkmall" />{projectPicker}</VStack>}
      collapsible={{ isCollapsed: navCollapsed, onCollapsedChange: setNavCollapsed, hasButton: true, buttonLabel: 'Toggle navigation ([)' }}
      footer={<VStack gap={0.5} className="hd-nav-footer"><InboxButton collapsed={navCollapsed} /><SideNavItem label="Settings" icon={<GearIcon />} onClick={() => openSettings('profile')} /><ServerStatus collapsed={navCollapsed} onOpen={() => openSettings('server')} /></VStack>}>
      {(['overview', 'tasks', 'agents', 'rooms', ...(termsOn ? ['terminals' as const] : [])] as const).map((p) => {
        const alert = p === 'overview' && data?.counts.needsYou ? data.counts.needsYou : 0
        return (
          <SideNavItem
            key={p}
            label={p[0].toUpperCase() + p.slice(1)}
            icon={navIcon(p, navCollapsed && alert > 0)}
            href={`#${p}`}
            isSelected={page === p}
            endContent={alert ? <Badge variant="error" label={String(alert)} /> : undefined}
          />
        )
      })}
      {!navCollapsed && <SideNavSection title="Open">
        <SegmentedControl label="Sidebar list" value={sideList} onChange={setSideList} size="sm">
          <SegmentedControlItem value="agents" label="Agents" />
          <SegmentedControlItem value="rooms" label="Rooms" />
        </SegmentedControl>
        <div className="hd-nav-scroll">{sideList === 'agents'
          ? sortAgents(data?.agents ?? [], 'attention').map((a) => (
            <SideNavItem key={a.key} label={a.name} icon={initialsIcon(initials(a.name), false)} isSelected={openPane === a.key || fullKey === a.key} onClick={() => open(a.key)}
              endContent={needsYou(a) ? <StatusDot variant="error" label="needs you" /> : a.status === 'working' ? <Text type="supporting" size="sm">▸</Text> : undefined} />
          ))
          : sideRooms.map((r) => (
            <SideNavItem key={r.slug} label={r.title} icon={navIcon('rooms', false)} href={`#rooms/${encodeURIComponent(r.slug)}`} isSelected={page === 'rooms' && roomSlug === r.slug}
              endContent={r.needsYou?.length ? <StatusDot variant="error" label="needs you" /> : undefined} />
          ))}</div>
      </SideNavSection>}
    </SideNav>
  )

  return (
    <AppShell sideNav={nav} contentPadding={0} mobileNav={{ breakpoint: 'lg' }}>
      <Layout
        height="fill"
        content={
      <LayoutContent>
      <VStack gap={phone ? 3 : 6} padding={phone ? 3 : 6} style={page === 'rooms' || fullKey || termPage ? { height: '100%', minHeight: 0 } : fabHidden ? undefined : { paddingBottom: 88 }}>
        {fullKey && (fullAgent
          ? <AgentPanelBody key={`full-${fullAgent.key}`} agent={fullAgent} task={all?.tasks.find((t) => t.id === fullAgent.task) ?? null}
              mode="page" onCollapse={leaveFull} onAsPanel={narrow ? undefined : () => fullToPanel(fullAgent.key)} autoFocus={!phone} />
          : all && <EmptyState title="Agent not found" description={`No agent ${fullKey} is running (it may have been removed).`}
              actions={<Button label="Back to Agents" variant="primary" onClick={() => { location.hash = 'agents' }} />} />)}
        {termPage && termsOn && <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
          <TerminalView pane={termPage} phone={phone} onBack={() => { location.hash = 'terminals' }} /></div>}
        {!fullKey && !termPage && !(page === 'rooms' && roomSlug) && <HStack justify="between" align="center" wrap="wrap" gap={3}>
          <Heading level={1}>{page[0].toUpperCase() + page.slice(1)}</Heading>
          <HStack gap={3} align="center">
            {data && (
              <Text type="supporting">
                Updated <Timestamp value={data.at} format="relative" isLive />
              </Text>
            )}
            {(page === 'agents' || page === 'overview') && <IconButton label="New agent" tooltip="New agent" icon={<PlusIcon />} size="sm" variant="primary" onClick={openSpawn} />}
            <IconButton label="Refresh" tooltip="Refresh" icon={<RefreshIcon />} size="sm" variant="ghost" onClick={() => q.refetch()} />
          </HStack>
        </HStack>}

        {q.isError && (data
          ? <Banner status="warning" title="Can't reach the dashboard server — showing the last data" description={String(q.error)} endContent={<Button label="Retry" size="sm" onClick={() => q.refetch()} />} />
          : <LoadError what="the dashboard (is the server running on 127.0.0.1:7777?)" error={q.error} retry={() => q.refetch()} />)}
        {!data && !q.isError && !fullKey && (page === 'overview' || page === 'tasks' || page === 'agents') && (
          <Delayed>{page === 'overview' ? <OverviewSkeleton /> : page === 'agents' ? <GroupedRows phone={phone} /> : <Rows n={8} />}</Delayed>
        )}
        {fullKey && !all && !q.isError && <Delayed><ChatSkeleton /></Delayed>}
        {data && !data.linearEnabled && !linearHidden && (page === 'overview' || page === 'tasks') && (
          <Banner status="info" title="Set LINEAR_API_KEY to show tickets" description="Tasks come from worktrees, PRs and agents only."
            endContent={<Button label="Dismiss" size="sm" variant="ghost" onClick={hideLinear} />} />
        )}

        {!fullKey && page === 'overview' && <InstallHint phone={phone} />}
        {!fullKey && data && page === 'overview' && <OverviewPage data={data} onOpen={open} selected={openPane} />}
        {!fullKey && data && page === 'tasks' && <TaskBoard tasks={data.tasks} onOpen={open} selected={openPane} showProject={data.allProjects} suggested={suggested} />}
        {!fullKey && data && page === 'agents' && <AgentsPage data={data} onOpen={open} onOpenFull={openFull} selected={openPane} />}
        {!fullKey && !termPage && page === 'terminals' && (termsOn
          ? <TerminalsPage phone={phone} onOpen={(pn) => open(`term:${pn}`)} />
          : <Banner status="info" title="Terminals are off" description="Turn them on in Settings › Terminals, from http://127.0.0.1 on this machine." />)}
        {page === 'rooms' && <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><RoomsPage slug={roomSlug} agents={all?.agents ?? []} onSelect={(sl) => { location.hash = sl ? `rooms/${encodeURIComponent(sl)}` : 'rooms' }} onOpenAgent={open} /></div>}
      </VStack>
      </LayoutContent>
        }
        end={openTerm && termsOn && !narrow && !collapsed && !termPage ? (
          <>
            <ResizeHandle direction="horizontal" isReversed hasDivider isAlwaysVisible={false} resizable={panel.props} label="Resize terminal panel" onDoubleClick={() => panel.resize(PANEL_DEFAULT)} />
            <LayoutPanel resizable={panel.props} label={`Terminal ${openTerm}`} isScrollable={false} padding={0}>
              <TerminalView key={openTerm} pane={openTerm} phone={false} onClose={() => setCollapsed(true)} />
            </LayoutPanel>
          </>
        ) : openAgent && !narrow && !collapsed && !fullKey ? (
          <>
            <ResizeHandle direction="horizontal" isReversed hasDivider isAlwaysVisible={false} resizable={panel.props} label="Resize agent panel" onDoubleClick={() => panel.resize(PANEL_DEFAULT)} />
            <LayoutPanel resizable={panel.props} label={`Agent ${openAgent.name}`} isScrollable={false} padding={0}>
              <AgentPanelBody key={openAgent.key} agent={openAgent} task={all?.tasks.find((t) => t.id === openAgent.task) ?? null}
                onCollapse={() => setCollapsed(true)} onExpand={() => openFull(openAgent.key)} autoFocus />
            </LayoutPanel>
          </>
        ) : undefined}
      />
      <SettingsHost />
      <SpawnHost agents={all?.agents ?? []} project={project} onOpenAgent={open} />
      <RemoveHost />
      <InboxHost onOpenAgent={open} />
      <PwaHost openInbox={() => openInbox()} />
      <QuickSwitcher agents={all?.agents ?? []} rooms={roomsQ.data?.rooms ?? []} loading={!all} phone={phone} hidden={fabHidden}
        onOpenAgent={(k, full) => (full ? openFull(k) : open(k))} onOpenRoom={(sl) => { location.hash = `rooms/${encodeURIComponent(sl)}` }} />
    </AppShell>
  )
}

// ---------- overview ----------
function Kpi({ label, value, loud }: { label: string; value: number; loud?: 'red' | 'orange' }) {
  return (
    <Card variant={loud && value > 0 ? loud : 'default'}>
      <VStack gap={1}>
        <Text type="supporting">{label}</Text>
        <Text type="display-2" weight="bold">{String(value)}</Text>
      </VStack>
    </Card>
  )
}

function OverviewPage({ data, onOpen, selected }: { data: Overview & { allProjects: boolean }; onOpen: (p: string) => void; selected: string | null }) {
  const inbox = data.tasks.filter((t) => t.state === 'needs_you')
  const c = data.counts
  return (
    <VStack gap={6}>
      <MachinesStrip machines={data.machines} />
      <UsagePanel />
      <Grid columns={{ minWidth: 160 }} gap={3}>
        <Kpi label="Needs you" value={c.needsYou} loud="red" />
        <Kpi label="Stalled" value={c.stalled} loud="orange" />
        <Kpi label="Building" value={c.building} />
        <Kpi label="In review" value={c.inReview} />
        <Kpi label="Idle agents" value={c.idleAgents} />
      </Grid>

      <VStack gap={3}>
        <Heading level={2}>Needs you</Heading>
        {inbox.length === 0 ? (
          <Card variant="muted">
            <EmptyState isCompact title="Nothing waiting on you" description="No agent is asking a question right now." />
          </Card>
        ) : (
          inbox.map((t) => (
            <Card key={t.id}>
              <HStack justify="between" align="start" gap={4}>
                <VStack gap={1}>
                  <HStack gap={2} align="center">
                    <StatusDot variant="error" label="Needs you" isPulsing />
                    <Text weight="semibold">{t.agent?.name ?? '—'}</Text>
                    {t.agent && <Badge label={t.agent.machine} />}
                    <Text type="supporting">{t.adHoc ? 'ad-hoc' : t.id}</Text>
                  </HStack>
                  <Text maxLines={1}>{t.title}</Text>
                  {t.question && <Text type="supporting" maxLines={3}>{t.question}</Text>}
                </VStack>
                {t.agent && <Button label="Open" variant="primary" onClick={() => onOpen(t.agent!.key)} />}
              </HStack>
            </Card>
          ))
        )}
      </VStack>

      <VStack gap={3}>
        <Heading level={2}>Task board</Heading>
        <TaskBoard tasks={data.tasks} onOpen={onOpen} selected={selected} showProject={data.allProjects} />
      </VStack>
    </VStack>
  )
}

// ---------- task board ----------
function PrCell({ pr }: { pr: PR | null }) {
  if (!pr) return <Text type="supporting">—</Text>
  return (
    <HStack gap={1} align="center" wrap="wrap">
      <Link href={pr.url} target="_blank">{`#${pr.number}`}</Link>
      {pr.state === 'OPEN' && <Badge variant={pr.isDraft ? 'neutral' : 'info'} label={pr.isDraft ? 'draft' : 'ready'} />}
      {pr.ci && <Badge variant={pr.ci === 'pass' ? 'success' : pr.ci === 'fail' ? 'error' : 'warning'} label={`CI ${pr.ci}`} />}
      {pr.review && pr.state === 'OPEN' && (
        <Badge
          variant={pr.review === 'APPROVED' ? 'success' : pr.review === 'CHANGES_REQUESTED' ? 'error' : 'neutral'}
          label={pr.review.toLowerCase().replace('_', ' ')}
        />
      )}
    </HStack>
  )
}

function TaskBoard({ tasks, onOpen, showProject, selected, suggested }: { tasks: Task[]; onOpen: (p: string) => void; showProject: boolean; selected: string | null; suggested?: Set<string> }) {
  const [group, setGroup] = useState('active')
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => {
    const f = filter.toLowerCase()
    return tasks
      .filter((t) => group === 'all' || STATE[t.state].group === group)
      .filter((t) => !f || [t.id, t.title, t.branch, t.agent?.name].some((s) => s?.toLowerCase().includes(f)))
      .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }, [tasks, group, filter])

  return (
    <VStack gap={3}>
      <HStack justify="between" align="end" wrap="wrap" gap={3}>
        <TabList value={group} onChange={setGroup}>
          <Tab value="active" label="Active" />
          <Tab value="review" label="Review" />
          <Tab value="done" label="Done" />
          <Tab value="all" label="All" />
        </TabList>
        <TextInput label="Filter tasks" isLabelHidden placeholder="Filter by id, title, branch, agent" value={filter} onChange={setFilter} hasClear size="sm" />
      </HStack>
      {rows.length === 0 ? (
        <EmptyState isCompact title="No tasks here" />
      ) : (
        <Table<Task>
          data={rows}
          idKey="id"
          density="compact"
          hasHover
          textOverflow="truncate"
          columns={[
            {
              key: 'task',
              header: 'Task',
              renderCell: (t) => (
                <VStack gap={0.5}>
                  {t.url ? <Link href={t.url} target="_blank">{t.id}</Link> : <Text type="supporting">{t.adHoc ? 'ad-hoc' : t.id}</Text>}
                  {suggested?.has(t.id) && <Link href="#rooms"><Text type="supporting" size="sm">room suggested</Text></Link>}
                  <Text maxLines={1}>{t.title}</Text>
                </VStack>
              ),
            },
            {
              key: 'state',
              header: 'State',
              renderCell: (t) => (
                <HStack gap={2} align="center">
                  <StatusDot variant={STATE[t.state].dot} label={STATE[t.state].label} isPulsing={t.state === 'needs_you'} />
                  <Text>{STATE[t.state].label}</Text>
                </HStack>
              ),
            },
            {
              key: 'agent',
              header: 'Agent',
              renderCell: (t) =>
                t.agent ? (
                  <HStack gap={1} align="center">
                    <Button label={t.agent.name} size="sm" variant={selected === t.agent.key ? "secondary" : "ghost"} onClick={() => onOpen(t.agent!.key)} />
                    <Text type="supporting" size="sm" maxLines={1}>{t.agent.machine}</Text>
                  </HStack>
                ) : <Text type="supporting">—</Text>,
            },
            ...(showProject ? [{ key: 'project', header: 'Project', renderCell: (t: Task) => <Text type="supporting" maxLines={1}>{t.project ?? '—'}</Text> }] : []),
            { key: 'branch', header: <Tooltip content="Worktree/PR linking is local-only: remote cwd paths differ"><Text weight="semibold">Branch</Text></Tooltip>, renderCell: (t) => <Text type="code" maxLines={1}>{t.branch ?? '—'}</Text> },
            { key: 'pr', header: 'PR', renderCell: (t) => <PrCell pr={t.pr} /> },
            {
              key: 'updatedAt',
              header: 'Updated',
              renderCell: (t) => (t.updatedAt ? <Timestamp value={t.updatedAt} format="relative" /> : <Text type="supporting">—</Text>),
            },
          ]}
        />
      )}
    </VStack>
  )
}

// ---------- images ----------
// Upload paths inside a user message → served thumbnails; the paths themselves are hidden.
const UPLOAD_PATH = /\S*\/(?:wt-dashboard|herdr-dash)\/uploads\/(\d{4}-\d{2}-\d{2})\/([0-9a-f-]{36}\.(?:png|jpg|webp|gif))/g
function splitUploads(text: string) {
  const urls = [...text.matchAll(UPLOAD_PATH)].map((m) => `/api/uploads/${m[1]}/${m[2]}`)
  return { text: text.replace(UPLOAD_PATH, '').trim(), urls }
}
// ---------- slash commands ----------

// ---------- AskUserQuestion ----------
const RECOMMENDED = /\s*\(Recommended\)\s*$/
function OptionLabel({ label }: { label: string }) {
  return (
    <HStack gap={2} align="center" wrap="wrap">
      <Text weight="medium">{label.replace(RECOMMENDED, '')}</Text>
      {RECOMMENDED.test(label) && <Badge variant="success" label="Recommended" />}
    </HStack>
  )
}
// Keeps the card mounted across Claude Code's redraws: the screen is polled fast (400ms for 5s after a send),
// and the card goes away only after TWO consecutive reads without a picker — one empty frame mid-transition
// used to swap the composer (with its Esc button) in under the user's pointer.
function useHeldPicker(agent: Agent): [Picker | null, () => void] {
  const [held, setHeld] = useState<Picker | null>(agent.picker ?? null)
  const [fastUntil, setFastUntil] = useState(0)
  const misses = useRef(0)
  const q = useQuery({
    queryKey: ['picker', agent.key],
    queryFn: () => getJSON<{ picker: Picker | null }>(`${agentUrl(agent)}?visible=1`),
    enabled: Boolean(held || agent.picker),
    refetchInterval: () => (Date.now() < fastUntil ? 400 : 2000),
    refetchIntervalInBackground: true, // a hidden tab/window must not freeze a stale card
  })
  useEffect(() => {
    if (agent.picker && !held) { misses.current = 0; setHeld(agent.picker) }
    // overview also sees no picker and the last visible read missed: two independent misses, drop it
    else if (!agent.picker && held && misses.current >= 1) setHeld(null)
  }, [agent.picker]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!q.data) return
    if (q.data.picker) { misses.current = 0; setHeld(q.data.picker) }
    else if (++misses.current >= 2) setHeld(null)
  }, [q.dataUpdatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
  return [held, () => setFastUntil(Date.now() + 5000)]
}
// The pending picker, read off the agent's screen. One question per submit — Claude Code's own flow.
function PickerCard({ agent, picker, onSent }: { agent: Agent; picker: Picker; onSent: () => void }) {
  const qc = useQueryClient()
  const [single, setSingle] = useState('')
  const [multi, setMulti] = useState<string[]>([])
  const [other, setOther] = useState('')
  const [sentFor, setSentFor] = useState<string | null>(null)
  const key = picker.review ? 'review' : picker.question ?? ''
  useEffect(() => {
    setSingle((picker.options ?? []).find((o) => o.checked)?.label ?? '') // revisited: the terminal marks the earlier answer ✔
    setMulti((picker.options ?? []).filter((o) => o.checked).map((o) => o.label))
    setOther('')
    setSentFor(null) // arriving on a screen (incl. returning to one) always re-enables it
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = sentFor === key // sent; wait for the screen to move on
  const answer = useMutation({
    mutationFn: async (body: object) => {
      const r = await fetch(`${agentUrl(agent)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error((await r.json()).error ?? r.status)
    },
    onSuccess: () => {
      setSentFor(key)
      onSent()
      qc.invalidateQueries({ queryKey: ['overview'] })
      qc.invalidateQueries({ queryKey: ['picker', agent.key] })
    },
  })
  const disabled = answer.isPending || waiting
  const OTHER = '__other__'
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { box.current?.focus({ preventScroll: true }) }, [key])
  const skip = () => answer.mutate({ action: 'skip', question: picker.review ? 'review' : picker.question })
  const chat = () => answer.mutate({ action: 'chat', question: picker.question })
  const next = () => answer.mutate({
    question: picker.question,
    selected: picker.multiSelect ? multi : single && single !== OTHER ? [single] : [],
    other: picker.multiSelect || single === OTHER ? other : null,
  })
  // Keys: 1..N pick, Enter = Next/Submit, Esc = Skip (typing in the Other field keeps its keys).
  const onKey = (e: import('react').KeyboardEvent) => {
    if (disabled) return
    const inField = (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text'
    if (e.key === 'Escape') {
      e.preventDefault() // never let Esc reach the panel/terminal on its own
      if (isUserSkip({ key: e.key, cardHasFocus: Boolean(box.current?.contains(document.activeElement)), inFlight: disabled, targetIsTextField: inField })) skip()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (picker.review) answer.mutate({ action: 'submit' })
      else if (canSend) next()
      return
    }
    const k = Number(e.key)
    const opts = picker.options ?? []
    if (!inField && !picker.review && k >= 1 && k <= opts.length) {
      e.preventDefault()
      const label = opts[k - 1].label
      if (picker.multiSelect) setMulti((m) => (m.includes(label) ? m.filter((x) => x !== label) : [...m, label]))
      else setSingle(label)
    }
  }
  const canSend = picker.multiSelect ? multi.length > 0 || other.trim() : single === OTHER ? other.trim() : single
  const steps = [...picker.tabs.map((t) => t.header), 'Submit']
  const active = picker.review ? picker.tabs.length : picker.current ?? 0
  const goto = (i: number) => { if (!disabled && i !== active) answer.mutate({ action: 'goto', tab: i, question: picker.review ? 'review' : picker.question }) }
  return (
    <div ref={box} tabIndex={-1} onKeyDown={onKey} style={{ outline: 'none', flexShrink: 0 }}>
    <Card variant="yellow" padding={3}>
      {/* Header and footer pinned; only the body scrolls. */}
      <VStack gap={3} style={{ maxHeight: '55vh' }}>
        <VStack gap={2}>
          <HStack gap={2} align="center">
            <StatusDot variant="warning" label="Waiting for your answer" isPulsing={!waiting} />
            <Text weight="semibold">{picker.review ? 'Review your answers' : 'Question'}</Text>
          </HStack>
          {picker.tabs.length > 0 && (
            <Stepper activeStep={active} density="compact" label="Questions" onStepClick={goto}
              horizontalOptions={{ minimumStepWidth: 64, collapsedVariant: 'withLabel' }}>
              {steps.map((h, i) => (
                <Step key={h + i} step={i} label={h} isDisabled={disabled && i !== active}
                  indicator={i < picker.tabs.length && picker.tabs[i].done && i > active ? '✓' : 'auto'} />
              ))}
            </Stepper>
          )}
        </VStack>
        <VStack gap={3} isScrollable style={{ flex: 1, minHeight: 0 }}>
          {answer.isError && <Banner status="error" title="Could not send the answer" description={String(answer.error)} />}
          {picker.review ? (
            (picker.answers ?? []).map((a, i) => (
              <Card key={i} padding={2} onClick={() => goto(i)}
                style={{ cursor: disabled ? 'default' : 'pointer' }}>
                <HStack gap={2} justify="between" align="center">
                  <VStack gap={0.5}>
                    <Text type="supporting" size="sm">{a.question}</Text>
                    <Text weight="medium">{a.answer}</Text>
                  </VStack>
                  <Button label="Edit" size="sm" variant="ghost" isDisabled={disabled} onClick={(e) => { e.stopPropagation(); goto(i) }} />
                </HStack>
              </Card>
            ))
          ) : (
            <>
              <ChatMarkdown>{picker.question ?? ''}</ChatMarkdown>
              {picker.multiSelect ? (
                <CheckboxList label="Choose any" isLabelHidden value={multi} onChange={setMulti}>
                  {(picker.options ?? []).map((o) => (
                    <CheckboxListItem key={o.label} value={o.label} label={<OptionLabel label={o.label} />} description={o.description && o.description !== o.label ? <Text type="supporting">{o.description}</Text> : undefined} isDisabled={disabled} />
                  ))}
                </CheckboxList>
              ) : (
                <RadioList label="Choose one" isLabelHidden value={single} onChange={setSingle}>
                  {(picker.options ?? []).map((o) => (
                    <RadioListItem key={o.label} value={o.label} label={<OptionLabel label={o.label} />} description={o.description ? <Text type="supporting">{o.description}</Text> : undefined} isDisabled={disabled} />
                  ))}
                  {picker.layout !== 'preview' && <RadioListItem value={OTHER} label="Other…" isDisabled={disabled} />}
                </RadioList>
              )}
              {picker.preview && (
                <VStack gap={1}>
                  <Text type="supporting" size="sm">{`Preview · option ${(picker as Picker & { cursor?: number }).cursor ?? 1} (focused in the terminal)`}</Text>
                  <CodeBlock code={picker.preview} />
                </VStack>
              )}
              {(picker.multiSelect || single === OTHER) && (
                <TextInput label={picker.multiSelect ? 'Other (optional)' : 'Your answer'} value={other} onChange={setOther} isDisabled={disabled} placeholder="Type something" />
              )}
            </>
          )}
        </VStack>
        <HStack gap={2} justify="between" align="center" wrap="wrap">
          <HStack gap={1}>
            {!picker.review && <Button label="Chat about this" size="sm" variant="ghost" tooltip="Decline the options and talk it through" isDisabled={disabled} onClick={chat} />}
            <Button label={picker.review ? 'Cancel' : 'Skip'} size="sm" variant="ghost" tooltip="Cancels the question in the terminal (Esc)" isDisabled={disabled} onClick={skip} />
          </HStack>
          <HStack gap={2} align="center">
            {waiting && <Text type="supporting" size="sm">Sent — waiting…</Text>}
            {picker.review
              ? <Button label="Submit answers" variant="primary" isLoading={answer.isPending} isDisabled={disabled} onClick={() => answer.mutate({ action: 'submit' })} />
              : <Button label={picker.tabs.length > 1 ? 'Next' : 'Answer'} variant="primary" isLoading={answer.isPending} isDisabled={disabled || !canSend} onClick={next} />}
          </HStack>
        </HStack>
      </VStack>
    </Card>
    </div>
  )
}
// Answered (or cancelled) question from the transcript: compact summary.
function QuestionSummary({ m }: { m: Msg }) {
  const qs = m.questions ?? []
  return (
    <Collapsible defaultIsOpen={false} chevronPosition="start"
      trigger={<Text type="supporting" size="sm">{m.cancelled ? `Question cancelled (${qs.length})` : m.answered ? `Answered ${qs.length} question${qs.length === 1 ? '' : 's'}` : 'Question pending'}</Text>}>
      <VStack gap={2}>
        {qs.map((q, i) => (
          <VStack key={i} gap={0.5}>
            <HStack gap={2} align="center">{q.header && <Badge label={q.header} />}<Text size="sm">{q.question}</Text></HStack>
            <Text weight="medium" size="sm">{m.answers?.[q.question] ?? (m.cancelled ? '—' : '…')}</Text>
            {q.options.filter((o) => o.preview).map((o) => <CodeBlock key={o.label} code={o.preview!} />)}
          </VStack>
        ))}
      </VStack>
    </Collapsible>
  )
}

// ---------- machines ----------
const MACHINE_DOT: Record<Machine['status'], Dot> = { online: 'success', stale: 'warning', offline: 'error', connecting: 'neutral', disabled: 'neutral' }
function MachinesStrip({ machines }: { machines: Machine[] }) {
  return (
    <Grid columns={{ minWidth: 240 }} gap={3}>
      {machines.map((m) => (
        <Card key={m.label} padding={3}>
          <VStack gap={1}>
            <HStack gap={2} align="center">
              <StatusDot variant={MACHINE_DOT[m.status]} label={m.status} tooltip={m.error ?? m.status} />
              <Text weight="semibold" maxLines={1}>{m.label}</Text>
              <Badge label={m.local ? 'local' : m.status} variant={m.status === 'offline' ? 'error' : m.status === 'stale' ? 'warning' : 'neutral'} />
            </HStack>
            <Text type="supporting" size="sm" maxLines={1}>{`${m.host} · ${m.working} working · ${m.idle} idle · ${m.total} total`}</Text>
            {!m.local && (
              <Text type="supporting" size="sm">
                {m.lastSeen ? <>seen <Timestamp value={new Date(m.lastSeen).toISOString()} format="relative" hasTooltip={false} /></> : 'never seen'}
              </Text>
            )}
          </VStack>
        </Card>
      ))}
    </Grid>
  )
}

// ---------- agents ----------
const needsYou = (a: Agent) => a.asks && a.status !== 'working'
const AGENT_FILTERS: Record<string, (a: Agent, t?: Task) => boolean> = {
  all: () => true,
  busy: (a) => a.status === 'working' || a.status === 'blocked',
  free: (a) => (a.status === 'idle' || a.status === 'done') && !needsYou(a),
  needs: needsYou,
}
const shortPath = (p: string | null) => (p ? p.split('/').filter(Boolean).at(-1) ?? p : null)

// Desktop agent table columns. Agent (first) and actions (last, sticky) are fixed; these are configurable.
type AgentCol = { id: string; label: string; width?: number; sort?: AgentSort; hidden?: boolean }
const AGENT_COLS: AgentCol[] = [
  { id: 'task', label: 'Task' },
  { id: 'status', label: 'Status', width: 130, sort: 'attention' },
  { id: 'active', label: 'Active', width: 80, sort: 'activity' },
  { id: 'machine', label: 'Machine', width: 120 },
  { id: 'branch', label: 'Branch', width: 160 },
  { id: 'project', label: 'Project', width: 120, hidden: true },
  { id: 'role', label: 'Role', width: 110, hidden: true },
  { id: 'context', label: 'Context', width: 110, hidden: true },
]
type ColConfig = { order: string[]; hidden: string[] }
const DEFAULT_COLS: ColConfig = { order: AGENT_COLS.map((c) => c.id), hidden: AGENT_COLS.filter((c) => c.hidden).map((c) => c.id) }
const loadCols = (): ColConfig => {
  try {
    const v = JSON.parse(localStorage.getItem('agentCols') ?? 'null') as ColConfig | null
    if (!v || !Array.isArray(v.order) || !Array.isArray(v.hidden)) return DEFAULT_COLS
    const known = DEFAULT_COLS.order
    return { order: [...v.order.filter((id) => known.includes(id)), ...known.filter((id) => !v.order.includes(id))], hidden: v.hidden }
  } catch { return DEFAULT_COLS }
}
const TASK_MIN = 260, AGENT_W = 220, ACT_W = 48
const stickyEnd = { position: 'sticky', right: 0, zIndex: 1, width: ACT_W, minWidth: ACT_W, maxWidth: ACT_W, background: 'var(--color-background-surface, Canvas)' } as const

function ColumnsControl({ cols, setCols }: { cols: ColConfig; setCols: (c: ColConfig) => void }) {
  const move = (i: number, d: number) => { const o = [...cols.order]; [o[i], o[i + d]] = [o[i + d], o[i]]; setCols({ ...cols, order: o }) }
  return (
    <Popover label="Columns" placement="below" alignment="end" content={
      <VStack gap={1} style={{ padding: 8, minWidth: 220 }}>
        {cols.order.map((id, i) => { const c = AGENT_COLS.find((x) => x.id === id)!
          return (
            <HStack key={id} gap={1} align="center">
              <div style={{ flex: 1 }}>
                <CheckboxInput label={c.label} value={!cols.hidden.includes(id)}
                  onChange={(on) => setCols({ ...cols, hidden: on ? cols.hidden.filter((x) => x !== id) : [...cols.hidden, id] })} />
              </div>
              <IconButton label={`Move ${c.label} up`} icon={<span aria-hidden>↑</span>} variant="ghost" size="sm" isDisabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton label={`Move ${c.label} down`} icon={<span aria-hidden>↓</span>} variant="ghost" size="sm" isDisabled={i === cols.order.length - 1} onClick={() => move(i, 1)} />
            </HStack>
          )
        })}
        <Button label="Reset" variant="ghost" size="sm" onClick={() => setCols(DEFAULT_COLS)} />
      </VStack>
    }>
      <Button label="Columns" variant="secondary" size="sm" />
    </Popover>
  )
}

function AgentsPage({ data, onOpen, onOpenFull, selected }: { data: Overview & { allProjects: boolean }; onOpen: (p: string) => void; onOpenFull: (p: string) => void; selected: string | null }) {
  const [filter, setFilter] = useState('all')
  const { roles } = useRoles()
  const [machine, setMachine] = useState('all')
  const [sort, setSortState] = useState<AgentSort>(() => initialSort(location.search, (() => { try { return localStorage.getItem('agentSort') } catch { return null } })()))
  const setSort = (v: AgentSort) => {
    setSortState(v)
    try { localStorage.setItem('agentSort', v) } catch { /* private mode */ }
    const u = new URL(location.href); u.searchParams.set('sort', v); history.replaceState(history.state, '', u)
  }
  const [collapsed, setCollapsed] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('agentGroupsCollapsed') ?? '["other"]') } catch { return ['other'] } })
  const toggleGroup = (k: string, open: boolean) => {
    const next = open ? collapsed.filter((x) => x !== k) : [...new Set([...collapsed, k])]
    setCollapsed(next)
    try { localStorage.setItem('agentGroupsCollapsed', JSON.stringify(next)) } catch { /* private mode */ }
  }
  const phone = useNarrow('(max-width: 639px)')
  const [cols, setColsState] = useState<ColConfig>(loadCols)
  const setCols = (c: ColConfig) => { setColsState(c); try { localStorage.setItem('agentCols', JSON.stringify(c)) } catch { /* private mode */ } }
  const shown = cols.order.filter((id) => !cols.hidden.includes(id)).map((id) => AGENT_COLS.find((c) => c.id === id)!)
  const tableMin = AGENT_W + ACT_W + shown.reduce((n, c) => n + (c.width ?? TASK_MIN), 0)
  const roleTitle = (id: string) => roles.find((r) => r.id === id)?.name ?? id
  const taskOf = (a: Agent) => data.tasks.find((t) => t.id === a.task)
  const sortHead = (label: string, v: AgentSort) => (
    <button type="button" onClick={() => setSort(v)} aria-pressed={sort === v} style={{ all: 'unset', cursor: 'pointer', fontWeight: 600 }}>{`${label}${sort === v ? ' ▾' : ''}`}</button>
  )
  const menu = (a: Agent) => (
    <span onClick={(e) => e.stopPropagation()}>
      <DropdownMenu button={{ label: `${a.name} actions`, icon: <span aria-hidden>⋯</span>, isIconOnly: true, size: 'sm', variant: 'ghost' }} hasChevron={false} alignment="end" items={[
        { label: 'Open', onClick: () => onOpen(a.key) },
        { label: 'Open full page', onClick: () => onOpenFull(a.key) },
        a.local ? { label: 'Remove agent…', onClick: () => openRemove(a) } : { label: 'Remove agent…', description: 'Remote agents: not supported yet', isDisabled: true, onClick: () => {} },
      ]} />
    </span>
  )
  return (
    <VStack gap={6}>
      <MachinesStrip machines={data.machines} />
      <HStack gap={3} wrap="wrap">
      <SegmentedControl label="Filter by machine" value={machine} onChange={setMachine} size="sm">
        <SegmentedControlItem value="all" label="All machines" />
        {data.machines.map((m) => <SegmentedControlItem key={m.label} value={m.label} label={m.label} />)}
      </SegmentedControl>
      <SegmentedControl label="Filter agents" value={filter} onChange={setFilter} size="sm">
        <SegmentedControlItem value="all" label="All" />
        <SegmentedControlItem value="busy" label="Busy" />
        <SegmentedControlItem value="free" label="Free" />
        <SegmentedControlItem value="needs" label="Needs you" />
      </SegmentedControl>
      <SegmentedControl label="Sort agents" value={sort} onChange={(v) => setSort(v as AgentSort)} size="sm">
        <SegmentedControlItem value="attention" label="Attention" />
        <SegmentedControlItem value="activity" label="Last activity" />
        <SegmentedControlItem value="name" label="Name" />
      </SegmentedControl>
      {!phone && <span style={{ marginInlineStart: 'auto' }}><ColumnsControl cols={cols} setCols={setCols} /></span>}
      </HStack>
      {[...roles, OTHER].map((role) => { const key = role.id, title = plural(role)
        const pool = data.agents.filter((a) => a.pool === key)
        const rows = sortAgents(pool.filter((a) => AGENT_FILTERS[filter](a, taskOf(a)) && (machine === 'all' || a.machine === machine)), sort)
        if (!pool.length) return null
        return (
          <Collapsible key={key} isOpen={!collapsed.includes(key)} onOpenChange={(o) => toggleGroup(key, o)} chevronPosition="start"
            trigger={<Heading level={2}>{`${title} (${pool.length})`}</Heading>}>
            {rows.length === 0 ? (
              <Text type="supporting">No agents match this filter.</Text>
            ) : phone ? (
              <VStack gap={0}>
                {rows.map((a) => {
                  const t = taskOf(a)
                  const what = t ? `${t.adHoc ? '' : t.id + ' · '}${t.title}` : a.recap
                  const line2 = [needsYou(a) ? 'needs you' : a.status, a.tags?.task ?? what, a.local ? null : a.machine, a.context ? `${a.context.pct}%` : null].filter(Boolean).join(' · ')
                  return (
                    <div key={a.key} role="button" tabIndex={0} onClick={() => onOpen(a.key)} onKeyDown={(e) => e.key === 'Enter' && onOpen(a.key)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 4px', minWidth: 0, cursor: 'pointer', borderBottom: '1px solid var(--color-border-default, rgba(128,128,128,.2))', background: selected === a.key ? 'var(--color-background-secondary, rgba(128,128,128,.12))' : undefined }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <HStack gap={2} align="center">
                          <StatusDot variant={needsYou(a) ? 'error' : AGENT_DOT[a.status]} label={a.status} isPulsing={a.status === 'working' || needsYou(a)} />
                          <Text weight="medium" maxLines={1}>{a.name}</Text>
                          <Text type="supporting" size="sm" style={{ marginInlineStart: 'auto', flexShrink: 0 }}>{shortAgo(new Date(activityOf(a)).toISOString())}</Text>
                        </HStack>
                        <Text type="supporting" size="sm" maxLines={1} hasTruncateTooltip={false}>{line2}</Text>
                      </div>
                      {menu(a)}
                    </div>
                  )
                })}
              </VStack>
            ) : (
              <div className="agent-table" style={{ ['--agent-min' as string]: `${tableMin}px` }}>
              <Table density="compact" hasHover textOverflow="truncate">
                <TableHeader>
                  <TableRow isHeaderRow>
                    <TableHeaderCell style={{ width: AGENT_W, minWidth: AGENT_W, maxWidth: AGENT_W }}>{sortHead('Agent', 'name')}</TableHeaderCell>
                    {shown.map((c) => (
                      <TableHeaderCell key={c.id} style={c.width ? { width: c.width, minWidth: c.width, maxWidth: c.width } : { minWidth: TASK_MIN }}>
                        {c.sort ? sortHead(c.label, c.sort) : c.id === 'branch'
                          ? <Tooltip content="Worktree/PR linking is local-only: remote cwd paths differ"><Text weight="semibold">Branch</Text></Tooltip>
                          : c.label}
                      </TableHeaderCell>
                    ))}
                    <TableHeaderCell style={stickyEnd}><VisuallyHidden>Actions</VisuallyHidden></TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((a) => {
                    const t = taskOf(a)
                    const quiet = !needsYou(a) && (a.status === 'idle' || a.status === 'done') && !t
                    const color = quiet ? 'secondary' : 'primary'
                    const summary = t ? `${t.adHoc ? '' : t.id + ' · '}${t.title}` : a.recap ?? '—'
                    // A handoff's --task label wins; its ticket stays a link when it is the linked task's.
                    const label = a.tags?.task
                    const linked = t?.url && (!label || label.startsWith(t.id)) ? t : null
                    const text = label ? (linked ? label.slice(linked.id.length).trim() : label) : t?.url ? t.title : summary
                    const cell = (id: string) => {
                      switch (id) {
                        case 'task': return (
                          <Tooltip content={label ?? summary}>
                            <HStack gap={1} align="center">
                              {linked && <Link href={linked.url ?? undefined} target="_blank">{linked.id}</Link>}
                              <Text color={color} weight={label ? 'medium' : undefined} maxLines={1} hasTruncateTooltip={false}>{text}</Text>
                            </HStack>
                          </Tooltip>
                        )
                        case 'status': return <Text color={color} maxLines={1}>{`${needsYou(a) ? 'needs you' : a.status} · ${idleFor(a)}`}</Text>
                        case 'active': return <Text type="supporting" maxLines={1}>{shortAgo(new Date(activityOf(a)).toISOString())}</Text>
                        case 'machine': return <Text color={color} maxLines={1}>{a.machine.replace(/\.local$/, '')}</Text>
                        case 'branch': return <Text type="code" color={color} maxLines={1}>{t?.branch ?? shortPath(a.cwd) ?? '—'}</Text>
                        case 'project': return <Text type="supporting" maxLines={1}>{a.project ?? '—'}</Text>
                        case 'role': return <Text type="supporting" maxLines={1}>{roleTitle(a.pool)}</Text>
                        case 'context': return a.context ? (
                          <ProgressBar label="Context" isLabelHidden hasValueLabel value={a.context.pct}
                            variant={a.context.pct > 80 ? 'error' : a.context.pct > 60 ? 'warning' : 'neutral'} />
                        ) : <Text type="supporting">—</Text>
                      }
                    }
                    return (
                      <TableRow key={a.key} onClick={() => onOpen(a.key)} aria-selected={selected === a.key}>
                        <TableCell>
                          <HStack gap={2} align="center">
                            <StatusDot variant={needsYou(a) ? 'error' : AGENT_DOT[a.status]} label={a.status} isPulsing={a.status === 'working' || needsYou(a)} />
                            <Button label={a.name} variant={selected === a.key ? "secondary" : "ghost"} size="sm" onClick={(e) => { e.stopPropagation(); onOpen(a.key) }} />
                            {needsYou(a) && <Badge variant="error" label="Needs you" />}
                            {a.background > 0 && <Badge label={`${a.background} background`} />}
                          </HStack>
                        </TableCell>
                        {shown.map((c) => <TableCell key={c.id}>{cell(c.id)}</TableCell>)}
                        <TableCell style={stickyEnd}>{menu(a)}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              </div>
            )}
          </Collapsible>
        )
      })}
    </VStack>
  )
}

// ---------- drawer ----------
// Consecutive tool rows → one ChatToolCalls group; a "result" row fills the preceding call's detail.
type Row = { kind: 'msg'; m: Msg; meta?: Meta } | { kind: 'tools'; id: string; calls: ChatToolCallItem[]; raw: Msg[]; label?: string }
// The agent transcript stream, for streamStore: resumes from the byte offset in each event's id.
function agentStreamSpec(base: string, key: string, session: string) {
  return {
    url: (cursor: string | null) => `${base}/stream${cursor ? `?since=${cursor}` : ''}`,
    persistKey: `agent|${key}`, persistTag: session,
    attach: (es: EventSource, apply: (fn: (items: Msg[]) => Msg[], cursor?: string | null) => void) => {
      es.onmessage = (ev) => apply((prev) => mergeAgentMsgs(prev, JSON.parse(ev.data)), ev.lastEventId || undefined)
    },
  }
}
function toRows(msgs: Msg[]): Row[] {
  const rows: Row[] = []
  const meta = deriveMeta(msgs)
  for (const m of msgs) {
    if (m.role !== 'tool') { rows.push({ kind: 'msg', m, meta: meta.get(m.id) }); continue } // user/assistant/question
    let g = rows.at(-1)
    if (g?.kind !== 'tools') rows.push((g = { kind: 'tools', id: m.id, calls: [], raw: [] }))
    g.raw.push(m)
    const last = g.calls.at(-1)
    if (m.tool?.name === 'result' && last && !last.resultDetail) {
      last.resultDetail = <Text type="code" size="sm">{m.text || '(empty result)'}</Text>
      if (m.isError) last.status = 'error'
    } else if (m.tool?.name !== 'result') {
      g.calls.push({ key: m.id, name: m.tool?.name ?? 'tool', target: m.tool?.summary, status: 'complete', data: m.toolUseId })
    }
  }
  for (const g of rows) {
    if (g.kind !== 'tools') continue
    const d = callDurations(g.raw)
    for (const c of g.calls) { const t = d.get(c.data as string); if (t != null) c.duration = fmtDur(t) }
    const { calls, ms } = toolGroupMeta(g.raw)
    g.label = `${calls} tool call${calls === 1 ? '' : 's'}${ms ? ` · ${fmtDur(ms)}` : ''}`
  }
  return rows.filter((r) => r.kind === 'msg' || r.calls.length)
}

// One muted line under a message. The time is relative; hover shows the absolute time, a tap toggles it (phones).
// "Show message details" (conversation ⋯ menu): expands every meta line; remembered per browser.
let showAllDetails = (() => { try { return localStorage.getItem('msg-details') === '1' } catch { return false } })()
const detailSubs = new Set<() => void>()
const subDetails = (f: () => void) => { detailSubs.add(f); return () => { detailSubs.delete(f) } }
function setShowAllDetails(v: boolean) {
  showAllDetails = v
  try { localStorage.setItem('msg-details', v ? '1' : '0') } catch { /* private mode */ }
  detailSubs.forEach((f) => f())
}
function MetaLine({ meta, extraAttachments = 0, copyText }: { meta?: Meta; extraAttachments?: number; copyText?: string }) {
  const [abs, setAbs] = useState(false)
  const all = useSyncExternalStore(subDetails, () => showAllDetails)
  const [own, setOwn] = useState<boolean | null>(null) // per message; null follows the global toggle
  const open = own ?? all
  const toast = useToast()
  if (!meta?.ts && !copyText) return null
  const parts: string[] = []
  if (meta?.kind === 'user') {
    parts.push(meta.src === 'dashboard' ? 'you · dashboard · delivered' : meta.src ?? 'you')
    const n = meta.attachments + extraAttachments
    if (n) parts.push(`${n} attachment${n === 1 ? '' : 's'}`)
  } else if (meta?.kind === 'turn') {
    if (meta.model) parts.push(shortModel(meta.model)!)
    if (meta.up || meta.down) parts.push(`↑${fmtTokens(meta.up)} (cache read ${fmtTokens(meta.cr)} · cache write ${fmtTokens(meta.cw)} · fresh ${fmtTokens(meta.fresh)}) ↓${fmtTokens(meta.down)}`)
    if (meta.ms) parts.push(fmtDur(meta.ms))
    if (meta.tools) parts.push(`${meta.tools} tool${meta.tools === 1 ? '' : 's'}`)
    if (meta.cost != null) parts.push(`~$${meta.cost < 0.01 ? meta.cost.toFixed(3) : meta.cost.toFixed(2)}`)
  }
  const stop = meta?.kind === 'turn' && meta.stop ? (meta.stop === 'max_tokens' ? 'hit max tokens' : meta.stop) : null
  const when = meta?.ts ? new Date(meta.ts) : null
  const copy = () => navigator.clipboard.writeText(copyText!).then(() => toast({ body: 'Copied', type: 'info' }), (e) => toast({ body: `Copy failed: ${e}`, type: 'error' }))
  return (
    <div data-msg-meta style={{ marginTop: 8, maxWidth: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28, minWidth: 0 }}>
        {when && <Text type="supporting" size="sm"><span role="button" tabIndex={0} title={when.toLocaleString()} onClick={() => setAbs((v) => !v)} onKeyDown={(e) => e.key === 'Enter' && setAbs((v) => !v)}>{abs ? when.toLocaleString() : fmtWhen(meta!.ts)}</span></Text>}
        {stop && <Badge label={stop} variant="error" />}
        {parts.length > 0 && <span data-copy style={{ flexShrink: 0 }}><IconButton label="Message details" icon={<Icon icon="info" size="sm" />} variant="ghost" size="sm" aria-expanded={open} onClick={() => setOwn(!open)} /></span>}
        {copyText && <span data-copy style={{ flexShrink: 0 }}><IconButton label="Copy message" icon={<Icon icon="copy" size="sm" />} variant="ghost" size="sm" onClick={copy} /></span>}
      </div>
      {open && parts.length > 0 && <Text type="supporting" size="sm">{parts.join(' · ')}</Text>}
    </div>
  )
}

// One conversation component for the side panel and the full page (#agents/<machine>/<pane>).
// mode="page": Back instead of X, "Open as panel", and on a wide screen the Summary beside a centered column.
function AgentPanelBody({ agent, task, onCollapse, onExpand, onAsPanel, mode = 'panel', autoFocus }: {
  agent: Agent; task: Task | null; onCollapse: () => void; onExpand?: () => void; onAsPanel?: () => void; mode?: 'panel' | 'page'; autoFocus: boolean
}) {
  const [tab, setTab] = useState('conversation')
  const narrow = useNarrow()
  useSyncExternalStore(subDetails, () => showAllDetails) // the ⋯ menu's details label
  const { byId } = useRoles()
  const [tagsMode, setTagsMode] = useState<'role' | 'tags' | null>(null)
  const density = useChatDensity()
  const [draft, setDraft] = useState(() => takePrefill(agent.key))
  const { atts, attErr, addFiles, removeAtt, clear: clearAtts, uploading } = useAttachments(agent.local ? null : 'Images only for local agents')
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<ChatComposerInputHandle>(null)
  const [heldPicker, bumpPicker] = useHeldPicker(agent)
  // Keep the list pinned to its end when the card appears or changes height.
  const chatBox = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = chatBox.current
    if (!box || !heldPicker) return
    const toEnd = () => { const el = box.firstElementChild as HTMLElement | null; if (el) el.scrollTop = el.scrollHeight }
    const ro = new ResizeObserver(toEnd)
    ro.observe(box)
    return () => ro.disconnect()
  }, [Boolean(heldPicker)]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!autoFocus) return
    const t = setTimeout(() => {
      const el = document.activeElement as HTMLElement | null
      const typing = el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      if (!typing) inputRef.current?.focus()
    }, 50)
    return () => clearTimeout(t)
  }, [autoFocus, tab])
  const cmds = useQuery({
    queryKey: ['commands', agent.key],
    queryFn: () => getJSON<Command[]>(`${agentUrl(agent)}/commands`),
    staleTime: 60_000,
  })
  const slash = useMemo<ChatComposerTrigger>(() => ({
    character: '/',
    searchSource: commandSource(cmds.data ?? []),
    renderItem: (item) => {
      const c = item.auxiliaryData as Command
      return <TypeaheadItem item={item} description={c.description} group={c.source} />
    },
    onSelect: (item) => ({ value: `/${item.label}`, label: `/${item.label}`, variant: 'blue' as const }),
  }), [cmds.data])
  const submit = (v: string) => {
    const paths = atts.filter((a) => a.path).map((a) => a.path!)
    if (!v.trim() && !paths.length) return
    const text = [v.trim(), paths.join('\n')].filter(Boolean).join('\n\n')
    // "working" can lag the 4s poll right after a send, so a send within 30s of the last one counts as mid-turn too.
    const busy = agent.status === 'working' || Date.now() - lastSend.current < 30_000
    lastSend.current = Date.now()
    // Optimistic: shown at once, until the transcript has it. Only a failed send leaves it marked.
    const id = crypto.randomUUID()
    setQueued((q) => [...q, { id, text, state: busy ? 'queued' : 'sending', at: Date.now() }])
    send.mutate({ text }, { onError: () => setQueued((q) => q.map((x) => (x.id === id ? { ...x, state: 'failed' } : x))) })
  }
  const qc = useQueryClient()
  // Keyed on the session id: /clear or a restart gives a new transcript, so a new cache entry.
  const live = agent.local && Boolean(agent.session)
  // Remote (or session-less) agents: pane-read timeline instead of the transcript stream.
  const pane = useQuery({
    queryKey: ['pane', agent.key],
    queryFn: () => getJSON<{ turns: { role: 'user' | 'assistant'; text: string }[] }>(`${agentUrl(agent)}?lines=500`),
    enabled: !live,
    refetchInterval: agent.status === 'working' ? 5000 : false,
  })
  const stream = useStream<Msg>(live ? `agent|${agent.key}|${agent.session}` : null, () => agentStreamSpec(agentUrl(agent), agent.key, agent.session!))
  const paneMsgs = useMemo(() => (pane.data?.turns ?? []).map((t, i): Msg => ({ id: `pane:${i}`, role: t.role, text: t.text, ts: '' })), [pane.data])
  const msgs = live ? stream.items : paneMsgs
  // The pane's status line is exact (it knows the window); the transcript estimate fills in when it's hidden.
  const ctx = useMemo(() => {
    if (agent.context) return { pct: agent.context.pct, text: `${agent.context.used} / ${agent.context.total}` }
    const c = contextUsage(msgs)
    return c && { pct: c.pct, text: `${fmtTokens(c.used)} / ${fmtTokens(c.window)}` }
  }, [agent.context, msgs])
  const streamErr = live && stream.error
  // Sent while the agent works: Claude Code takes it at its next step. Shown as "queued" until the
  // transcript has it (matched on its first line), or 15s after the agent is idle again.
  const [queued, setQueued] = useState<{ id: string; text: string; state: 'sending' | 'queued' | 'failed' | 'unconfirmed'; at: number }[]>([])
  const lastSend = useRef(0)
  useEffect(() => {
    if (!queued.length) return
    const users = msgs.filter((m) => m.role === 'user').slice(-20).map((m) => m.text)
    const left = queued.filter((q) => !users.some((t) => t.includes(q.text.split('\n')[0].slice(0, 60))))
    if (left.length !== queued.length) setQueued(left)
  }, [msgs]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (agent.status === 'working' || !queued.length) return
    // Idle and still not in the transcript: flag it rather than silently dropping it.
    const t = setTimeout(() => setQueued((q) => q.map((x) => (x.state === 'failed' ? x : { ...x, state: 'unconfirmed' }))), 15_000)
    return () => clearTimeout(t)
  }, [agent.status, queued.length])
  const rows = useMemo(() => toRows(msgs), [msgs])

  // Stop: Escape via the server's stale-checked /stop. "Stopping…" until the status leaves working (10s → toast).
  const toast = useToast()
  const [stopping, setStopping] = useState(false)
  const stopM = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${agentUrl(agent)}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
    },
    onSuccess: () => { setStopping(true); qc.invalidateQueries({ queryKey: ['overview'] }) },
    onError: (e) => { console.error('stop failed', e); toast({ body: `Stop not sent: ${e instanceof Error ? e.message : e}`, type: 'error' }) },
  })
  const stop = () => { if (!stopping && !stopM.isPending && agent.status === 'working') stopM.mutate() }
  useEffect(() => { if (agent.status !== 'working') setStopping(false) }, [agent.status])
  useEffect(() => {
    if (!stopping) return
    const t = setTimeout(() => { setStopping(false); toast({ body: `${agent.name} is still working 10s after Stop`, type: 'error' }) }, 10_000)
    return () => clearTimeout(t)
  }, [stopping]) // eslint-disable-line react-hooks/exhaustive-deps
  const send = useMutation({
    mutationFn: (body: { text?: string; keys?: string[] }) => postAgent(agent, body),
    onSuccess: (_d, body) => {
      if (body.text && body.text !== 'continue') {
        setDraft('')
        clearAtts()
      }
      qc.invalidateQueries({ queryKey: ['overview'] })
    },
  })
  // The list is built only when the transcript (or working state) changes, never per keystroke:
  // the draft lives in this component, and re-rendering 200+ Markdown messages per key was the lag.
  const working = agent.status === 'working'
  const layoutRef = useRef<HTMLDivElement>(null) // ChatLayout's root is the scroll container (VirtualRows scrolls it)
  // The newest tool call in the transcript: the activity row's fallback when the pane shows no spinner line.
  const lastTool = useMemo(() => {
    const c = rows.findLast((r) => r.kind === 'tools')
    const call = c?.kind === 'tools' ? c.calls.at(-1) : undefined
    return call ? `${call.name}${call.target ? `: ${call.target}` : ''}` : null
  }, [rows])
  const noneYet = live && !stream.synced && !msgs.length // nothing cached and the stream has not answered
  const messageList = useMemo(() => noneYet ? <Delayed><ChatSkeleton /></Delayed> : (
              <ChatMessageList density={density} isStreaming={working} data-agent-chat="">
                <VirtualRows items={rows} scrollRef={layoutRef} keyOf={(r) => (r.kind === 'tools' ? r.id : r.m.id)} render={(r) =>
                  r.kind === 'tools' ? (
                    <ChatMessage key={r.id} sender="assistant" data-tools="" metadata={<Text type="supporting" size="sm">{r.label}</Text>}>
                      <ChatMessageBubble variant="ghost" width="100%">
                        <ChatToolCalls calls={r.calls} />
                      </ChatMessageBubble>
                    </ChatMessage>
                  ) : r.m.role === 'question' ? (!r.m.answered && !r.m.cancelled ? null : // pending: the card below is the question

                    <ChatMessage key={r.m.id} sender="assistant">
                      <ChatMessageBubble variant="ghost" width="100%"><QuestionSummary m={r.m} /></ChatMessageBubble>
                    </ChatMessage>
                  ) : r.m.role === 'user' ? (
                    <ChatMessage key={r.m.id} sender="user" metadata={<MetaLine meta={r.meta} extraAttachments={splitUploads(r.m.text).urls.length} copyText={splitUploads(r.m.text).text || undefined} />}>
                      {(() => {
                        const u = splitUploads(r.m.text)
                        const imgs = [...u.urls, ...(r.m.images ?? [])]
                        return (
                          <>
                            {u.text && <ChatMessageBubble>{u.text}</ChatMessageBubble>}
                            {u.text && <LinkPreviews text={u.text} />}
                            {imgs.length > 0 && <ChatMessageBubble variant="ghost"><ImageRow srcs={imgs} /></ChatMessageBubble>}
                          </>
                        )
                      })()}
                    </ChatMessage>
                  ) : (
                    <ChatMessage key={r.m.id} sender="assistant" metadata={<MetaLine meta={r.meta} copyText={r.m.text || undefined} />}>
                      <ChatMessageBubble variant="ghost" width="100%">
                        {r.m.text && <ChatMarkdown>{r.m.text}</ChatMarkdown>}
                        {r.m.text && <LinkPreviews text={r.m.text} />}
                        {r.m.images?.length ? <ImageRow srcs={r.m.images} /> : null}
                        {r.m.files?.length ? <FileCards files={r.m.files} caption={r.m.caption} /> : null}
                      </ChatMessageBubble>
                    </ChatMessage>
                  )} />
              </ChatMessageList>
  ), [rows, working, density, noneYet])

  const page = mode === 'page'
  const summary = (
          <VStack gap={3} isScrollable>
            <Text type="label">Recap</Text>
            <Text>{agent.recap ?? '—'}</Text>
            <Text type="label">Task</Text>
            <Text>{task ? `${task.adHoc ? 'ad-hoc' : task.id} · ${STATE[task.state].label} · ${task.title}` : 'No task'}</Text>
            {task?.plan && <Text type="code">{task.plan}</Text>}
            <Text type="label">cwd</Text>
            <Text type="code">{agent.cwd}</Text>
            <Text type="label">Tags</Text>
            {agent.tags?.handoff_from && <Text size="sm">{`Handed off from ${agent.tags.handoff_from}${agent.tags.handoff_from_pane ? ` (${agent.tags.handoff_from_pane})` : ''}`}</Text>}
            {agent.tags?.handoff_to && <Text size="sm">{`Handed off to ${agent.tags.handoff_to}${agent.tags.handoff_to_pane ? ` (${agent.tags.handoff_to_pane})` : ''}`}</Text>}
            <TagList tags={agent.tags} />
            {agent.question && (
              <>
                <Text type="label">Waiting on</Text>
                <Card variant="red"><Text>{agent.question}</Text></Card>
              </>
            )}
          </VStack>
  )
  const conversation = (
          <VStack gap={2} style={{ flex: 1, minHeight: 0 }}>
            {!live && <Text type="supporting" size="sm">{agent.local ? 'no transcript · pane view' : 'remote · pane view'}</Text>}
            {pane.isError && <Banner status="error" title="Couldn't read pane" description={String(pane.error)} />}
            {streamErr && <Banner status="warning" title="Transcript stream disconnected — retrying" />}
            {live && !streamErr && !stream.synced && msgs.length > 0 && (
              <div role="status" style={{ height: 0, overflow: 'visible', display: 'flex', justifyContent: 'flex-end', position: 'relative', zIndex: 1, pointerEvents: 'none' }}>
                <HStack gap={1} align="center" style={{ height: 20 }}><StatusDot variant="neutral" label="" /><Text type="supporting" size="sm">syncing…</Text></HStack></div>)}
            {send.isError && <Banner status="error" title="Send failed" description={String(send.error)} />}
            <div ref={chatBox} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <ChatLayout ref={layoutRef}
              emptyState={live && !stream.synced ? <Delayed><ChatSkeleton /></Delayed> : <EmptyState isCompact title="No messages yet" />}
              composer={heldPicker ? null : (<VStack gap={1}>
                <ChatComposer
                  sendButton={working ? <Tooltip content="Queue: Claude picks it up after its current step"><span><ChatSendButton /></span></Tooltip> : undefined}
                  value={draft}
                  onChange={setDraft}
                  onSubmit={submit}
                  isDisabled={send.isPending || uploading}
                  input={<ChatComposerInput onKeyDown={(e: import('react').KeyboardEvent) => {
                    // Esc while the agent works = Stop. (A pending question replaces this composer, so its Esc stays Skip.)
                    if (e.key === 'Escape' && agent.status === 'working' && !heldPicker) { e.preventDefault(); stop() }
                    composerEnter(e)
                  }} handleRef={inputRef} triggers={[slash]} onFiles={addFiles} placeholder={`Message ${agent.name}…`} isDisabled={send.isPending} />}
                  status={attErr ? { type: 'warning', message: attErr } : undefined}
                  headerContext={ctx && (() => { const t = `${ctx.pct}% · ${ctx.text}`; return (
                    <Tooltip content={`Context window: ${t}`}><div style={{ width: 96 }}>
                      <ProgressBar label={`Context window ${t}`} isLabelHidden value={ctx.pct} variant={ctx.pct >= 80 ? 'error' : ctx.pct >= 60 ? 'warning' : 'accent'} />
                    </div></Tooltip>) })()}
                  headerActions={<>
                      <IconButton label="Skills & commands" icon={<span aria-hidden style={{ fontWeight: 600 }}>/</span>} size="sm" variant="ghost" tooltip="Skills & commands (/)"
                        onClick={() => { inputRef.current?.focus(); inputRef.current?.insertText('/') }} />
                      <IconButton label="Attach image" icon={<ClipIcon />} size="sm" variant="ghost" isDisabled={!agent.local || atts.length >= MAX_IMAGES}
                        tooltip={agent.local ? 'Attach png/jpeg/webp/gif (or paste / drop)' : 'Images only for local agents'}
                        onClick={() => fileRef.current?.click()} />
                      <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden
                        onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
                    </>}
                  drawer={atts.length ? (
                    <ChatComposerDrawer>
                      <HStack gap={2} wrap="wrap">
                        {atts.map((a) => (
                          <Thumbnail key={a.id} src={a.preview} label={a.error ? `${a.name}: ${a.error}` : a.name} alt={a.name}
                            isLoading={!a.path && !a.error} onRemove={() => removeAtt(a.id)} showRemoveOn="always" />
                        ))}
                      </HStack>
                    </ChatComposerDrawer>
                  ) : undefined}
                  placeholder={`Prompt ${agent.name}…`}
                  density="compact"
                  sendActions={
                    <HStack gap={1}>
                      {stopping && <Text type="supporting" size="sm">Stopping…</Text>}
                      {working && !stopping && <IconButton label="Stop" icon={<Icon icon="stop" />} size="sm" variant="secondary" tooltip="Stop the current turn (Esc)" onClick={stop} />}
                      <IconButton label="Nudge" icon={<NudgeIcon />} size="sm" variant="ghost" tooltip='Nudge: send "continue"' isDisabled={send.isPending} onClick={() => send.mutate({ text: 'continue' })} />
                    </HStack>
                  }
                />
              </VStack>)}>
              {messageList}
              <ActivityRow agent={agent} lastTool={lastTool} />
              {queued.length > 0 && (
                <VStack gap={1} style={{ padding: '0 8px 8px', alignItems: 'flex-end' }}>
                  {queued.map((q) => (
                    <HStack key={q.id} gap={1} align="center" style={{ opacity: q.state === 'sending' || q.state === 'queued' ? 0.7 : 1, maxWidth: '85%' }}>
                      <Badge label={q.state === 'unconfirmed' ? 'not seen yet' : q.state} variant={q.state === 'failed' ? 'error' : q.state === 'unconfirmed' ? 'warning' : undefined} />
                      <Text size="sm" maxLines={2}>{q.text}</Text>
                      {(q.state === 'failed' || q.state === 'unconfirmed') && (<>
                        <Button label="Retry" size="sm" variant="ghost" onClick={() => { setQueued((l) => l.filter((x) => x.id !== q.id)); submit(q.text) }} />
                        <Button label="Dismiss" size="sm" variant="ghost" onClick={() => setQueued((l) => l.filter((x) => x.id !== q.id))} />
                      </>)}
                    </HStack>
                  ))}
                </VStack>
              )}
            </ChatLayout>
            </div>
            {/* The question card sits BELOW the list (not in the sticky dock), so nothing can draw over it. */}
            {heldPicker && <PickerCard agent={agent} picker={heldPicker} onSent={bumpPicker} />}
          </VStack>
  )
  return (
      <VStack gap={3} height="100%" padding={page ? 0 : 4} data-agent-panel={page ? undefined : ''} data-agent-page={page ? '' : undefined}>
        {tagsMode && <TagsDialog agent={agent} mode={tagsMode} onClose={() => setTagsMode(null)} />}
        <HStack justify="between" align="center" gap={2} style={{ minWidth: 0, flexWrap: 'nowrap' }}>
          <HStack gap={2} align="center" style={{ minWidth: 0, flex: 1 }}>
            {page && <IconButton label="Back" icon={<BackIcon />} size={narrow ? 'md' : 'sm'} variant="ghost" tooltip="Back" onClick={onCollapse} style={{ flexShrink: 0, minWidth: narrow ? 44 : undefined, minHeight: narrow ? 44 : undefined }} />}
            <RoleBadge role={byId(agent.pool)} />
            <StatusDot variant={needsYou(agent) ? 'error' : AGENT_DOT[agent.status]} label={agent.status} isPulsing={agent.status === 'working'} />
            <VStack gap={0.5} style={{ minWidth: 0 }}>
              <HStack gap={1} align="center" style={{ minWidth: 0 }}>
                <Text weight="semibold" maxLines={1}>{agent.name}</Text>
                {agent.background > 0 && <Badge label={`${agent.background} background`} />}
              </HStack>
              {agent.tags?.task && <Text size="sm" weight="medium" maxLines={1}>{agent.tags.task}</Text>}
              <Text type="supporting" size="sm" maxLines={1}>{narrow
                ? `${agent.local ? '' : `${agent.machine} · `}${needsYou(agent) ? 'needs you' : agent.status} · ${lastActive(agent)}`
                : `${agent.local ? '' : `${agent.machine} · `}${agent.pool} · ${needsYou(agent) ? 'needs you' : agent.status} for ${idleFor(agent)} · active ${lastActive(agent)}`}</Text>
            </VStack>
          </HStack>
          <HStack gap={0} style={{ flexShrink: 0 }}>
          {page && onAsPanel && <Button label="Open as panel" size="sm" variant="ghost" onClick={onAsPanel} />}
          <DropdownMenu button={{ label: 'Agent actions', icon: <span aria-hidden>⋯</span>, isIconOnly: true, size: 'sm', variant: 'ghost' }} hasChevron={false} alignment="end" items={[
            ...(page ? [] : [{ label: 'Open full page', onClick: () => onExpand?.() }]),
            { label: showAllDetails ? 'Hide message details' : 'Show message details', onClick: () => setShowAllDetails(!showAllDetails) },
            ...(agent.local ? [
              { label: 'Change role…', description: `Now: ${byId(agent.pool).name}`, onClick: () => setTagsMode('role') },
              { label: 'Edit tags…', description: 'Ticket, branch', onClick: () => setTagsMode('tags') },
            ] : []),
            agent.local
              ? { label: 'Remove agent…', description: 'Close its tab and end its conversation', onClick: () => openRemove(agent) }
              : { label: 'Remove agent…', description: 'Remote agents: not supported yet', isDisabled: true, onClick: () => {} },
          ]} />
          {!page && !narrow && onExpand && <IconButton label="Open full page" icon={<ExpandIcon />} size="sm" variant="ghost" tooltip="Open full page (⌘⇧↩)" onClick={onExpand} style={{ flexShrink: 0 }} />}
          {!page && <IconButton label="Close panel" icon={<Icon icon="close" />} size={narrow ? 'md' : 'sm'} variant="ghost" tooltip="Close (Esc)" onClick={onCollapse} style={{ flexShrink: 0, minWidth: narrow ? 44 : undefined, minHeight: narrow ? 44 : undefined }} />}
          </HStack>
        </HStack>
        {page && !narrow ? (
          <div style={{ display: 'flex', gap: 24, flex: 1, minHeight: 0 }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center', minHeight: 0 }}>
              <div style={{ width: '100%', maxWidth: 860, display: 'flex', flexDirection: 'column', minHeight: 0 }}>{conversation}</div>
            </div>
            <ScrollableArea label="Summary" style={{ flex: '0 0 300px', minWidth: 0, overflowWrap: 'anywhere' }}>
              <Collapsible defaultIsOpen chevronPosition="start" trigger={<Text weight="semibold">Summary</Text>}>{summary}</Collapsible>
            </ScrollableArea>
          </div>
        ) : (
          <>
        <TabList value={tab} onChange={setTab} hasDivider>
          <Tab value="summary" label="Summary" />
          <Tab value="conversation" label="Conversation" />
        </TabList>

            {tab === 'summary' ? summary : conversation}
          </>
        )}
      </VStack>
  )
}

const svg = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const ClipIcon = () => <svg {...svg}><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg>
const PlusIcon = () => <svg {...svg}><path d="M12 5v14M5 12h14" /></svg>
const RefreshIcon = () => <svg {...svg}><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5" /></svg>
const NudgeIcon = () => <svg {...svg}><path d="m6 17 5-5-5-5M13 17l5-5-5-5" /></svg>
const GearIcon = () => <svg {...svg}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
